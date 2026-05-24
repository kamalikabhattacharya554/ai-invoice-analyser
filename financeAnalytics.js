const parseMoney = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return 0;
  }

  const match = value.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : 0;
};

const CURRENCY_RATES = {
  USD: 1,
  INR: 83,
  EUR: 0.92,
  GBP: 0.79,
};

const toNumber = (value) => Number(value) || 0;

const normalizeCurrency = (currency = "INR") => {
  const normalized = String(currency || "INR").toUpperCase();
  return CURRENCY_RATES[normalized] ? normalized : "INR";
};

const convertCurrency = (value, fromCurrency = "INR", toCurrency = "INR") => {
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);
  const valueInUsd = (Number(value) || 0) / CURRENCY_RATES[from];
  return Number((valueInUsd * CURRENCY_RATES[to]).toFixed(2));
};

const normalizeItem = (item = {}) => {
  const quantity = parseMoney(item.quantity) || 1;
  const unitPrice =
    parseMoney(item.unitPrice) ||
    parseMoney(item.rate) ||
    parseMoney(item.price) ||
    parseMoney(item.total);
  const total = parseMoney(item.total) || Number((quantity * unitPrice).toFixed(2));

  return {
    name: item.name || item.description || "Invoice item",
    quantity,
    unitPrice,
    price: unitPrice,
    taxPercent: parseMoney(item.taxPercent),
    total,
  };
};

const normalizeItems = (items = []) => {
  if (!Array.isArray(items)) return [];
  return items.map(normalizeItem);
};

const calculateInvoiceBasics = (invoice = {}) => {
  const items = normalizeItems(invoice.items);
  const subtotal = Number(items.reduce((sum, item) => sum + toNumber(item.total), 0).toFixed(2));
  const tax = parseMoney(invoice.tax);
  const discount = parseMoney(invoice.discount);
  const shipping = parseMoney(invoice.shipping);
  const amount =
    parseMoney(invoice.amount) ||
    parseMoney(invoice.total_amount) ||
    Number((subtotal + tax + shipping - discount).toFixed(2));
  const itemCount = items.reduce((sum, item) => sum + toNumber(item.quantity), 0);
  const averageItemAmount = itemCount ? Number((subtotal / itemCount).toFixed(2)) : 0;
  const taxRatePercent = subtotal ? Number(((tax / subtotal) * 100).toFixed(2)) : 0;
  const highestItem = items.reduce(
    (top, item) => (toNumber(item.total) > toNumber(top.total) ? item : top),
    { name: "None", total: 0 }
  );

  return {
    amount,
    subtotal,
    tax,
    discount,
    shipping,
    itemCount,
    averageItemAmount,
    taxRatePercent,
    highestItem,
    items,
  };
};

const buildInvoiceSummary = (invoices = [], targetCurrency = "INR") => {
  const currency = normalizeCurrency(targetCurrency);
  const byCategory = {};
  let totalExpense = 0;
  let highestInvoice = null;

  invoices.forEach((invoice) => {
    const basics = calculateInvoiceBasics(invoice);
    const convertedAmount = convertCurrency(basics.amount, invoice.currency || "INR", currency);
    const category = invoice.category || "Other";
    totalExpense += convertedAmount;

    if (!byCategory[category]) {
      byCategory[category] = { category, total: 0, count: 0 };
    }

    byCategory[category].total += convertedAmount;
    byCategory[category].count += 1;

    if (
      !highestInvoice ||
      convertedAmount >
        convertCurrency(calculateInvoiceBasics(highestInvoice).amount, highestInvoice.currency || "INR", currency)
    ) {
      highestInvoice = invoice;
    }
  });

  const categories = Object.values(byCategory)
    .map((item) => ({
      ...item,
      total: Number(item.total.toFixed(2)),
      average: item.count ? Number((item.total / item.count).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    totalExpense: Number(totalExpense.toFixed(2)),
    currency,
    invoiceCount: invoices.length,
    averageInvoiceAmount: invoices.length ? Number((totalExpense / invoices.length).toFixed(2)) : 0,
    topCategory: categories[0] || null,
    categories,
    highestInvoice,
  };
};

const answerBasicFinanceQuestion = (question = "", invoices = [], targetCurrency = "INR") => {
  const q = question.toLowerCase();
  const summary = buildInvoiceSummary(invoices, targetCurrency);

  if (!invoices.length) {
    return "I do not see any saved invoices yet. Upload an invoice first, then I can answer totals, categories, averages, and spending questions.";
  }

  if (q.includes("total") || q.includes("spent") || q.includes("expense")) {
    return `Your total saved invoice expense is ${summary.currency} ${summary.totalExpense}. You have ${summary.invoiceCount} saved invoice(s).`;
  }

  if (q.includes("average") || q.includes("avg")) {
    return `Your average invoice amount is ${summary.currency} ${summary.averageInvoiceAmount}.`;
  }

  if (q.includes("category") || q.includes("highest") || q.includes("most")) {
    if (!summary.topCategory) return "There is not enough category data yet.";
    return `Your top spending category is ${summary.topCategory.category} with ${summary.currency} ${summary.topCategory.total} across ${summary.topCategory.count} invoice(s).`;
  }

  if (q.includes("count") || q.includes("many")) {
    return `You have ${summary.invoiceCount} saved invoice(s).`;
  }

  if (q.includes("advice") || q.includes("suggest") || q.includes("save") || q.includes("budget")) {
    const top = summary.topCategory;
    if (!top) return "Keep uploading invoices so I can spot budget patterns.";
    return `Basic advice: watch your ${top.category} spending first, because it is currently your highest category at ${summary.currency} ${top.total}. Compare future invoices against your average of ${summary.currency} ${summary.averageInvoiceAmount}.`;
  }

  return `I can help with basics like total spending, average invoice amount, highest category, invoice count, and simple budget advice. Your current total is ${summary.currency} ${summary.totalExpense}.`;
};

module.exports = {
  parseMoney,
  convertCurrency,
  normalizeItems,
  calculateInvoiceBasics,
  buildInvoiceSummary,
  answerBasicFinanceQuestion,
};
