const { GoogleGenAI } = require("@google/genai");
const mongoose = require("mongoose");
const Invoice = require("../models/invoice");
const jsonDb = require("../utils/jsonDb");
const {
  answerBasicFinanceQuestion,
  buildInvoiceSummary,
} = require("../utils/financeAnalytics");

const getGeminiApiKey = () => {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  return key.trim().replace(/^['"]|['"]$/g, "");
};

const generateWithRetry = async (ai, prompt, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent({
        model: "gemini-2.5-mini",
        contents: prompt,
        temperature: 0.2,
        maxOutputTokens: 256,
      });
    } catch (error) {
      const is429 = error.message?.includes("429") || error.status === 429;
      if (is429 && attempt < maxRetries) {
        const retryMatch = error.message?.match(/retry in (\d+)/i);
        const delayMs = retryMatch ? parseInt(retryMatch[1], 10) * 1000 : attempt * 5000;
        console.log(`[Retry ${attempt}/${maxRetries}] Rate limited. Waiting ${delayMs / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        throw error;
      }
    }
  }
};

const getInvoicesForRequest = async (req) => {
  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    const filter = req.user?._id ? { user: req.user._id } : {};
    return await Invoice.find(filter).sort({ createdAt: -1 }).lean();
  }

  let invoices = jsonDb.getLocalInvoices();
  if (req.user?._id) {
    invoices = invoices.filter((invoice) => invoice.user === req.user._id);
  }
  return invoices;
};

const askChatbot = async (req, res) => {
  try {
    const question = req.body.question;

    if (!question) {
      return res.status(400).json({
        success: false,
        error: "Question is required",
      });
    }

    const invoices = await getInvoicesForRequest(req);
    const targetCurrency = req.body.currency || "INR";
    const summary = buildInvoiceSummary(invoices, targetCurrency);
    const localReply = answerBasicFinanceQuestion(question, invoices, targetCurrency);
    const apiKey = getGeminiApiKey();

    if (!apiKey) {
      return res.status(200).json({
        success: true,
        question,
        reply: localReply,
        source: "basic-backend",
        summary,
      });
    }

    const ai = new GoogleGenAI({ apiKey });
    const invoiceSummary = JSON.stringify(
      {
        totalExpense: summary.totalExpense,
        invoiceCount: summary.invoiceCount,
        averageInvoiceAmount: summary.averageInvoiceAmount,
        topCategory: summary.topCategory,
        categories: summary.categories,
        currency: summary.currency,
        recentInvoices: invoices.slice(0, 5).map((invoice) => ({
          merchant: invoice.merchant,
          amount: invoice.amount,
          currency: invoice.currency,
          category: invoice.category,
          date: invoice.date,
        })),
      },
      null,
      2
    );

    const prompt = `
      You are an AI financial assistant.
      Answer using the user's real invoice summary below.
      Keep the answer short, practical, and easy to understand.
      If the question is a basic total/count/category question, answer directly from the numbers.

      Invoice Summary:
      ${invoiceSummary}

      User Question:
      ${question}

      Give short smart answers.
    `;

    const result = await generateWithRetry(ai, prompt);

    res.status(200).json({
      success: true,
      question,
      reply: result.text || localReply,
      source: "ai",
      summary,
    });
  } catch (error) {
    console.log("CHATBOT ERROR =>", error.message);

    const is429 = error.message?.includes("429") || error.message?.includes("quota");
    if (is429 || error.message?.includes("API key")) {
      const invoices = await getInvoicesForRequest(req);
      const targetCurrency = req.body.currency || "INR";
      return res.status(200).json({
        success: true,
        question: req.body.question,
        reply: answerBasicFinanceQuestion(req.body.question, invoices, targetCurrency),
        source: "basic-backend",
        warning: "AI is unavailable right now, so I answered using backend calculations.",
      });
    }

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

module.exports = {
  askChatbot,
};
