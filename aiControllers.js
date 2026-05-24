const fs = require("fs");
const { extractInvoiceData } = require("../services/aiservice");

const isAiQuotaError = (error) => {
  const message = String(error?.message || "");
  return (
    error?.status === 429 ||
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.toLowerCase().includes("quota")
  );
};

const buildAiUnavailableData = (file) => ({
  invoice_number: null,
  invoice_date: null,
  customer_name: null,
  seller_name: (file?.originalname || "Uploaded invoice").replace(/\.[^.]+$/, ""),
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
});

const extractInvoiceWithFinancialAnalysis = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No invoice file uploaded.",
      });
    }

    const result = await extractInvoiceData(req.file.path);

    res.json({
      success: true,
      data: result.data,
      rawText: result.rawText,
    });
  } catch (error) {
    if (isAiQuotaError(error)) {
      return res.status(200).json({
        success: true,
        aiAvailable: false,
        message: "AI quota limit reached. Automatic extraction is unavailable right now.",
        data: buildAiUnavailableData(req.file),
      });
    }

    res.status(500).json({
      success: false,
      message: "AI financial analysis failed",
      error: error.message,
    });
  } finally {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlink(req.file.path, () => {});
    }
  }
};

module.exports = {
  extractInvoiceWithFinancialAnalysis,
};
