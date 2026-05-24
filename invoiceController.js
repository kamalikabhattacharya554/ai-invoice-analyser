const fs = require("fs");
const mongoose = require("mongoose");
const Invoice = require("../models/invoice");
const jsonDb = require("../utils/jsonDb");
const { extractInvoiceData } = require("../services/aiservice");
const {
  buildInvoiceSummary,
  calculateInvoiceBasics,
  normalizeItems: normalizeInvoiceItems,
  parseMoney: parseMoneyValue,
} = require("../utils/financeAnalytics");

const MAX_AI_INVOICE_UPLOADS = Number(process.env.MAX_AI_INVOICE_UPLOADS || 100);

const normalizeUserId = (value) => String(value || "");

const getUserInvoiceCount = async (userId) => {
  const normalizedId = normalizeUserId(userId);
  if (!normalizedId) return 0;

  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    return await Invoice.countDocuments({ user: normalizedId });
  }

  return jsonDb
    .getLocalInvoices()
    .filter((inv) => normalizeUserId(inv.user) === normalizedId).length;
};

const isAiQuotaError = (error) => {
  const message = String(error?.message || "");
  return (
    error?.status === 429 ||
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.toLowerCase().includes("quota")
  );
};

const buildAiUnavailableData = (file) => {
  const originalName = file?.originalname || "Uploaded invoice";
  const fallback = {
    invoice_number: null,
    invoice_date: null,
    customer_name: null,
    seller_name: originalName.replace(/\.[^.]+$/, ""),
    total_amount: 0,
    subtotal: 0,
    tax: 0,
    discount: 0,
    shipping: 0,
    item_count: 0,
    average_item_amount: 0,
    tax_rate_percent: 0,
    highest_item: { name: "None", total: 0 },
    category: "Other",
    items: [],
    finance_analysis: {
      category: "Other",
      decision: "CAUTION",
      reason: "AI quota is currently exhausted, so this invoice could not be read automatically.",
      past_transactions: 0,
      total_spent_in_category: 0,
      total_amount_numeric: 0,
    },
  };

  return fallback;
};

const parseMoney = parseMoneyValue;

const extractJsonObject = (text) => {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI response did not contain valid JSON.");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
};

const normalizeCurrency = (parsedData) => {
  const rawCurrency = String(parsedData.currency || "").trim().toUpperCase();
  const rawSymbol = String(parsedData.currencySymbol || "").trim();

  if (rawCurrency === "USD" || rawSymbol === "$") {
    return { currency: "USD", currencySymbol: "$" };
  }

  if (rawCurrency === "EUR" || rawSymbol === "€") {
    return { currency: "EUR", currencySymbol: "€" };
  }

  if (rawCurrency === "GBP" || rawSymbol === "£") {
    return { currency: "GBP", currencySymbol: "£" };
  }

  if (rawCurrency === "INR" || rawSymbol === "₹" || rawSymbol === "Rs") {
    return { currency: "INR", currencySymbol: "₹" };
  }

  return {
    currency: rawCurrency || "INR",
    currencySymbol: rawSymbol || "₹",
  };
};

const normalizeItems = normalizeInvoiceItems;

const uploadInvoice = async (req, res) => {
  try {
        // 1. Safety Guard: Verify file upload actually exists
    if (!req.file) {
      return res.status(400).json({ message: "No invoice or receipt file uploaded." });
    }

    const currentInvoiceCount = await getUserInvoiceCount(req.user?._id);
    if (currentInvoiceCount >= MAX_AI_INVOICE_UPLOADS) {
      const fallbackData = buildAiUnavailableData(req.file);
      let invoice;

      if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
        invoice = await Invoice.create({
          user: req.user._id,
          merchant: fallbackData.seller_name || "Unknown Merchant",
          amount: 0,
          currency: "INR",
          currencySymbol: "₹",
          tax: 0,
          date: "Unknown Date",
          category: "Other",
          items: [],
          aiInsight: fallbackData.finance_analysis.reason,
          fileUrl: req.file.path,
        });
      } else {
        const invoices = jsonDb.getLocalInvoices();
        invoice = {
          _id: `offline_invoice_${Date.now()}`,
          user: req.user._id,
          merchant: fallbackData.seller_name || "Unknown Merchant",
          amount: 0,
          currency: "INR",
          currencySymbol: "₹",
          tax: 0,
          date: "Unknown Date",
          category: "Other",
          items: [],
          aiInsight: fallbackData.finance_analysis.reason,
          fileUrl: req.file.path,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        invoices.unshift(invoice);
        jsonDb.saveLocalInvoices(invoices);
      }

      return res.status(201).json({
        success: true,
        aiAvailable: false,
        message: `AI extraction usage has reached its supported cap of ${MAX_AI_INVOICE_UPLOADS} uploaded invoices. The invoice was saved without automatic AI processing.`,
        invoice,
        calculations: calculateInvoiceBasics(fallbackData),
        data: fallbackData,
      });
    }

    const aiResult = await extractInvoiceData(req.file.path);
    const parsedData = aiResult.data;

    // 2. Persist the record in MongoDB Atlas or fallback to local JSON database
    let invoice;
    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      invoice = await Invoice.create({
        user: req.user._id,
        merchant: parsedData.seller_name || parsedData.customer_name || "Unknown Merchant",
        amount: parsedData.total_amount,
        currency: parsedData.currency || "INR",
        currencySymbol: parsedData.currencySymbol || "₹",
        tax: parsedData.tax,
        date: parsedData.invoice_date || "Unknown Date",
        category: parsedData.category || "Other",
        items: parsedData.items,
        aiInsight: parsedData.aiInsight || parsedData.finance_analysis?.reason || "AI analysis not available.",
        fileUrl: req.file.path,
      });
    } else {
      const invoices = jsonDb.getLocalInvoices();
      invoice = {
        _id: `offline_invoice_${Date.now()}`,
        user: req.user._id,
        merchant: parsedData.seller_name || parsedData.customer_name || "Unknown Merchant",
        amount: parsedData.total_amount,
        currency: parsedData.currency || "INR",
        currencySymbol: parsedData.currencySymbol || "₹",
        tax: parsedData.tax,
        date: parsedData.invoice_date || "Unknown Date",
        category: parsedData.category || "Other",
        items: parsedData.items,
        aiInsight: parsedData.aiInsight || parsedData.finance_analysis?.reason || "AI analysis not available.",
        fileUrl: req.file.path,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      invoices.unshift(invoice);
      jsonDb.saveLocalInvoices(invoices);
    }

    // 7. Return the document straight back to your React/Flutter UI dashboard
    return res.status(201).json({
      success: true,
      message: "Invoice successfully analyzed by AI",
      invoice,
      calculations: {
        subtotal: parsedData.subtotal,
        tax: parsedData.tax,
        discount: parsedData.discount,
        shipping: parsedData.shipping,
        itemCount: parsedData.item_count,
        averageItemAmount: parsedData.average_item_amount,
        taxRatePercent: parsedData.tax_rate_percent,
        highestItem: parsedData.highest_item,
      },
    });



  } catch (error) {
    console.error("Generalized Processor Error Log:", error);

    if (isAiQuotaError(error)) {
      const fallbackData = buildAiUnavailableData(req.file);
      let invoice;

      if (req.user?._id) {
        if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
          invoice = await Invoice.create({
            user: req.user._id,
            merchant: fallbackData.seller_name || "Unknown Merchant",
            amount: 0,
            currency: "INR",
            currencySymbol: "₹",
            tax: 0,
            date: "Unknown Date",
            category: "Other",
            items: [],
            aiInsight: fallbackData.finance_analysis.reason,
            fileUrl: req.file?.path,
          });
        } else {
          const invoices = jsonDb.getLocalInvoices();
          invoice = {
            _id: `offline_invoice_${Date.now()}`,
            user: req.user._id,
            merchant: fallbackData.seller_name || "Unknown Merchant",
            amount: 0,
            currency: "INR",
            currencySymbol: "₹",
            tax: 0,
            date: "Unknown Date",
            category: "Other",
            items: [],
            aiInsight: fallbackData.finance_analysis.reason,
            fileUrl: req.file?.path,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          invoices.unshift(invoice);
          jsonDb.saveLocalInvoices(invoices);
        }
      }

      return res.status(201).json({
        success: true,
        aiAvailable: false,
        message: "AI quota limit reached. The invoice file was saved, but automatic extraction is unavailable right now.",
        invoice,
        calculations: calculateInvoiceBasics(fallbackData),
        data: fallbackData,
      });
    }

    res.status(500).json({
      message: "Invoice processing failed",
      error: error.message,
    });
  }
};

const getInvoices = async (req, res) => {
  try {
    const filter = req.user?._id ? { user: req.user._id } : {};
    let invoices;

    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      invoices = await Invoice.find(filter).sort({ createdAt: -1 });
    } else {
      invoices = jsonDb.getLocalInvoices();
      if (req.user?._id) {
        invoices = invoices.filter(inv => inv.user === req.user._id);
      }
      invoices.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    res.json({
      success: true,
      authRequired: false,
      scope: req.user?._id ? "current-user" : "all-invoices",
      invoices,
      calculations: buildInvoiceSummary(invoices, req.query.currency || "INR"),
    });
  } catch (error) {
    res.status(500).json({ message: "Unable to fetch invoices", error: error.message });
  }
};

const getInvoiceById = async (req, res) => {
  try {
    let invoice;
    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      invoice = await Invoice.findOne({ _id: req.params.id, user: req.user._id });
    } else {
      const invoices = jsonDb.getLocalInvoices();
      invoice = invoices.find(inv => inv._id === req.params.id && inv.user === req.user._id);
    }

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    res.json({ success: true, invoice, calculations: calculateInvoiceBasics(invoice) });
  } catch (error) {
    res.status(500).json({ message: "Unable to fetch invoice", error: error.message });
  }
};

const deleteInvoice = async (req, res) => {
  try {
    let invoice;
    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      invoice = await Invoice.findOne({ _id: req.params.id, user: req.user._id });
      if (!invoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }

      if (invoice.fileUrl && fs.existsSync(invoice.fileUrl)) {
        fs.unlinkSync(invoice.fileUrl);
      }

      await invoice.deleteOne();
    } else {
      const invoices = jsonDb.getLocalInvoices();
      const index = invoices.findIndex(inv => inv._id === req.params.id && inv.user === req.user._id);
      if (index === -1) {
        return res.status(404).json({ message: "Invoice not found" });
      }

      invoice = invoices[index];
      if (invoice.fileUrl && fs.existsSync(invoice.fileUrl)) {
        fs.unlinkSync(invoice.fileUrl);
      }

      invoices.splice(index, 1);
      jsonDb.saveLocalInvoices(invoices);
    }

    res.json({ success: true, message: "Invoice deleted" });
  } catch (error) {
    res.status(500).json({ message: "Unable to delete invoice", error: error.message });
  }
};

const clearInvoiceHistory = async (req, res) => {
  try {
    let deletedCount = 0;

    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      const invoices = await Invoice.find({ user: req.user._id });
      deletedCount = invoices.length;

      invoices.forEach((invoice) => {
        if (invoice.fileUrl && fs.existsSync(invoice.fileUrl)) {
          fs.unlinkSync(invoice.fileUrl);
        }
      });

      await Invoice.deleteMany({ user: req.user._id });
    } else {
      const invoices = jsonDb.getLocalInvoices();
      const remainingInvoices = [];

      invoices.forEach((invoice) => {
        if (invoice.user === req.user._id) {
          deletedCount += 1;
          if (invoice.fileUrl && fs.existsSync(invoice.fileUrl)) {
            fs.unlinkSync(invoice.fileUrl);
          }
        } else {
          remainingInvoices.push(invoice);
        }
      });

      jsonDb.saveLocalInvoices(remainingInvoices);
    }

    res.json({
      success: true,
      message: "Invoice history cleared",
      deletedCount,
    });
  } catch (error) {
    res.status(500).json({ message: "Unable to clear invoice history", error: error.message });
  }
};

const extractInvoiceDataOnly = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No invoice file uploaded." });
    }

    if (req.user?._id) {
      const currentInvoiceCount = await getUserInvoiceCount(req.user._id);
      if (currentInvoiceCount >= MAX_AI_INVOICE_UPLOADS) {
        const fallbackData = buildAiUnavailableData(req.file);
        return res.status(200).json({
          success: true,
          aiAvailable: false,
          message: `AI extraction usage has reached its supported cap of ${MAX_AI_INVOICE_UPLOADS} uploaded invoices. Automatic extraction is unavailable right now.`,
          data: fallbackData,
        });
      }
    }

    const aiResult = await extractInvoiceData(req.file.path);
    return res.status(200).json({
      success: true,
      data: aiResult.data,
      rawText: aiResult.rawText,
    });
  } catch (error) {
    if (isAiQuotaError(error)) {
      const fallbackData = buildAiUnavailableData(req.file);

      return res.status(200).json({
        success: true,
        aiAvailable: false,
        message: "AI quota limit reached. Automatic extraction is unavailable right now.",
        data: fallbackData,
      });
    }

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

module.exports = {
  uploadInvoice,
  getInvoices,
  getInvoiceById,
  deleteInvoice,
  clearInvoiceHistory,
  extractInvoiceDataOnly,
};
