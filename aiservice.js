const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const {
  calculateInvoiceBasics,
  normalizeItems,
  parseMoney,
} = require("../utils/financeAnalytics");

// RAG memory for comparing recent extracted invoices during this server run.
const memory = [];

const normalizeCurrency = (parsedData = {}) => {
  const rawCurrency = String(parsedData.currency || "").trim().toUpperCase();
  const rawSymbol = String(parsedData.currencySymbol || "").trim();

  if (rawCurrency === "USD" || rawSymbol === "$" || rawSymbol === "USD") {
    return { currency: "USD", currencySymbol: "$" };
  }

  if (rawCurrency === "EUR" || rawSymbol === "€" || rawSymbol === "EUR") {
    return { currency: "EUR", currencySymbol: "€" };
  }

  if (rawCurrency === "GBP" || rawSymbol === "£" || rawSymbol === "GBP") {
    return { currency: "GBP", currencySymbol: "£" };
  }

  if (rawCurrency === "INR" || rawSymbol === "₹" || rawSymbol === "Rs" || rawSymbol === "INR") {
    return { currency: "INR", currencySymbol: "₹" };
  }

  return {
    currency: rawCurrency || "INR",
    currencySymbol: rawSymbol || "₹",
  };
};

const normalizeCategory = (category = "") => {
  const normalized = String(category || "").trim();
  if (!normalized) return "Other";
  if (/food/i.test(normalized)) return "Food";
  if (/transport|taxi|uber|lyft|travel/i.test(normalized)) return "Travel";
  if (/shopping|amazon|retail|electronics|apparel/i.test(normalized)) return "Shopping";
  if (/bill|water|electric|rent|internet|insurance|utilities/i.test(normalized)) return "Bills";
  if (/entertainment|subscription|movie|netflix|spotify/i.test(normalized)) return "Entertainment";
  if (/office|stationery|software|saas|supplies/i.test(normalized)) return "Office Supplies";
  return normalized === "Others" ? "Other" : normalized;
};

const getGeminiApiKey = () => {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  return key.trim().replace(/^['"]|['"]$/g, "");
};

const cleanText = (text = "") => {
  return text
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
};

const extractJsonObject = (text) => {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI response did not contain valid JSON.");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
};

const getMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
};

const embed = (text) => {
  const map = {};
  cleanText(text)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .forEach((word) => {
      map[word] = (map[word] || 0) + 1;
    });
  return map;
};

const similarity = (a, b) => {
  let dot = 0;
  let ma = 0;
  let mb = 0;

  for (const key in a) {
    ma += a[key] * a[key];
    if (b[key]) dot += a[key] * b[key];
  }

  for (const key in b) {
    mb += b[key] * b[key];
  }

  return dot / (Math.sqrt(ma) * Math.sqrt(mb) + 1e-9);
};

const storeMemory = (data, text) => {
  memory.push({
    vector: embed(text),
    data,
  });
};

const getSimilar = (text) => {
  const vector = embed(text);

  return memory
    .map((entry) => ({
      score: similarity(vector, entry.vector),
      data: entry.data,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.data);
};

const analyzeFinance = (text, amount, similar, categoryHint) => {
  const t = `${categoryHint || ""} ${text}`.toLowerCase();
  let category = normalizeCategory(categoryHint);

  if (!categoryHint || category === "Others") {
    if (t.includes("food") || t.includes("restaurant")) category = "Food";
    else if (t.includes("uber") || t.includes("taxi")) category = "Transport";
    else if (t.includes("amazon")) category = "Shopping";
    else if (t.includes("electricity")) category = "Utilities";
    else if (t.includes("hotel")) category = "Travel";
  }

  const pastSpent = similar.reduce(
    (sum, invoice) => sum + (invoice.finance_analysis?.total_amount_numeric || invoice.total_amount || 0),
    0
  );
  const count = similar.length;

  let decision = "BUY";
  let reason = "Normal spending";

  if (amount > 10000) {
    decision = "CAUTION";
    reason = "High value transaction";
  }

  if (count >= 3 && pastSpent > 20000) {
    decision = "AVOID";
    reason = "Repeated high spending detected";
  }

  return {
    category,
    decision,
    reason,
    past_transactions: count,
    total_spent_in_category: pastSpent,
    total_amount_numeric: amount || 0,
  };
};

const extractInvoiceData = async (filePath) => {
  const apiKey = getGeminiApiKey();

  if (!apiKey) {
    throw new Error("Missing Gemini API key. Add GEMINI_API_KEY or GOOGLE_API_KEY to backend/.env.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const fileBuffer = fs.readFileSync(filePath);
  const filePart = {
    inlineData: {
      data: fileBuffer.toString("base64"),
      mimeType: getMimeType(filePath),
    },
  };

  const prompt = `
    Extract invoice details from this document and return only a valid JSON object.
    Do not include markdown fences, commentary, or any additional text.
    If a field is missing, return null or 0 as appropriate.
    {
      "invoice_number": "string or null",
      "invoice_date": "string or null",
      "customer_name": "string or null",
      "seller_name": "string or null",
      "total_amount": 0,
      "currency": "USD, INR, EUR, GBP, or detected currency code",
      "currencySymbol": "$, ₹, €, £, or detected symbol",
      "tax": 0,
      "discount": 0,
      "shipping": 0,
      "category": "Food, Travel, Shopping, Bills, Entertainment, Office Supplies, or Other",
      "items": [
        { "name": "Item name", "quantity": 1, "unitPrice": 0, "total": 0 }
      ]
    }
  `;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [filePart, prompt],
    temperature: 0.0,
    maxOutputTokens: 512,
  });

  const aiData = extractJsonObject(response.text);
  const items = normalizeItems(aiData.items);
  const basics = calculateInvoiceBasics({
    amount: aiData.total_amount,
    tax: aiData.tax,
    discount: aiData.discount,
    shipping: aiData.shipping,
    items,
  });

  const currencyInfo = normalizeCurrency(aiData);
  const data = {
    invoice_number: aiData.invoice_number || null,
    invoice_date: aiData.invoice_date || null,
    customer_name: aiData.customer_name || null,
    seller_name: aiData.seller_name || null,
    total_amount: basics.amount,
    subtotal: basics.subtotal,
    tax: basics.tax,
    discount: basics.discount,
    shipping: basics.shipping,
    item_count: basics.itemCount,
    average_item_amount: basics.averageItemAmount,
    tax_rate_percent: basics.taxRatePercent,
    highest_item: basics.highestItem,
    items: basics.items,
    category: normalizeCategory(aiData.category),
    currency: currencyInfo.currency,
    currencySymbol: currencyInfo.currencySymbol,
    aiInsight: aiData.finance_analysis?.reason || "No analysis provided.",
  };

  const searchableText = cleanText(
    [
      data.invoice_number,
      data.invoice_date,
      data.customer_name,
      data.seller_name,
      data.total_amount,
      data.category,
    ]
      .filter((value) => value || value === 0)
      .join(" ")
  );
  const similar = getSimilar(searchableText);

  const finalData = {
    ...data,
    finance_analysis: analyzeFinance(searchableText, data.total_amount, similar, data.category),
  };

  storeMemory(finalData, searchableText);

  return {
    success: true,
    data: finalData,
    rawText: searchableText,
  };
};

module.exports = { extractInvoiceData };
