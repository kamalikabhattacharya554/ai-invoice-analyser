const express = require("express");
const mongoose = require("mongoose");
const Invoice = require("../models/invoice");
const jsonDb = require("../utils/jsonDb");
const { protect } = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/", protect, async (req, res) => {
  try {
    let summary;
    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      summary = await Invoice.aggregate([
        { $match: { user: req.user._id } },
        {
          $group: {
            _id: "$category",
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { total: -1 } },
      ]);
    } else {
      const invoices = jsonDb.getLocalInvoices().filter(inv => inv.user === req.user._id);
      const categoryTotals = {};
      invoices.forEach(inv => {
        const cat = inv.category || "Other";
        if (!categoryTotals[cat]) categoryTotals[cat] = { _id: cat, total: 0, count: 0 };
        categoryTotals[cat].total += (inv.amount || 0);
        categoryTotals[cat].count += 1;
      });
      summary = Object.values(categoryTotals).sort((a, b) => b.total - a.total);
    }

    res.json({ success: true, summary });
  } catch (error) {
    res.status(500).json({ message: "Unable to build summary", error: error.message });
  }
});

module.exports = router;
