/**
 * Canonical product model.
 *
 * Every extractor produces the same shape, which keeps the downstream n8n
 * nodes (Postgres upsert, matcher) independent of the site that was crawled.
 * The module also normalises obviously broken ranges so a single bad page
 * cannot poison the product catalogue.
 */

const { criteriaSignature } = require('./signature');
const { cleanText } = require('./text');

/**
 * Convert a value to a number or return null.
 *
 * @param {*} value raw value
 * @returns {number|null} numeric value
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Convert a value to an integer or return null.
 *
 * @param {*} value raw value
 * @returns {number|null} integer value
 */
function toInteger(value) {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

/**
 * Order a range so the smaller value comes first.
 *
 * @param {number|null} min lower bound
 * @param {number|null} max upper bound
 * @returns {{min: number|null, max: number|null}} ordered range
 */
function orderRange(min, max) {
  const lower = toNumber(min);
  const upper = toNumber(max);
  if (lower === null && upper === null) {
    return { min: null, max: null };
  }
  if (lower === null) {
    return { min: null, max: upper };
  }
  if (upper === null) {
    return { min: lower, max: null };
  }
  return lower <= upper ? { min: lower, max: upper } : { min: upper, max: lower };
}

/**
 * Build a stable product key from the source and the provider.
 *
 * @param {string} sourceId source registry id
 * @param {string} provider lender name
 * @param {string} productName product name
 * @returns {string} product key
 */
function buildProductKey(sourceId, provider, productName) {
  const slug = cleanText(`${provider} ${productName}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${sourceId}:${slug}`;
}

/**
 * Normalise and validate a raw product description.
 *
 * @param {object} raw product as produced by an extractor
 * @returns {object|null} canonical product or null when unusable
 */
function buildProduct(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const productName = cleanText(raw.product_name);
  const provider = cleanText(raw.provider) || 'Unknown provider';
  if (!productName) {
    return null;
  }

  const rate = orderRange(raw.interest_rate_min, raw.interest_rate_max);
  const amount = orderRange(raw.min_loan_amount, raw.max_loan_amount);
  const tenure = orderRange(raw.min_tenure_months, raw.max_tenure_months);
  const age = orderRange(raw.min_age, raw.max_age);
  const credit = orderRange(raw.min_credit_score, raw.max_credit_score);
  const income = orderRange(raw.min_monthly_income, raw.max_monthly_income);

  // Percentages outside 0-100 are always a parsing artefact.
  const rateMin = rate.min !== null && rate.min >= 0 && rate.min <= 100 ? rate.min : null;
  const rateMax = rate.max !== null && rate.max >= 0 && rate.max <= 100 ? rate.max : null;

  const sourceId = cleanText(raw.source_id) || 'unknown';
  const criteria = raw.criteria && typeof raw.criteria === 'object' ? raw.criteria : {};

  const statuses = Array.isArray(raw.required_employment_statuses)
    ? raw.required_employment_statuses.map((value) => cleanText(value)).filter(Boolean).sort()
    : [];

  const product = {
    product_key: cleanText(raw.product_key) || buildProductKey(sourceId, provider, productName),
    product_name: productName,
    provider,
    source_id: sourceId,
    source_url: cleanText(raw.source_url),
    interest_rate_min: rateMin,
    interest_rate_max: rateMax,
    min_loan_amount: amount.min,
    max_loan_amount: amount.max,
    min_tenure_months: tenure.min,
    max_tenure_months: tenure.max,
    min_monthly_income: income.min,
    max_monthly_income: income.max,
    min_credit_score: credit.min,
    max_credit_score: credit.max,
    min_age: age.min,
    max_age: age.max,
    min_employment_years: toNumber(raw.min_employment_years),
    required_employment_statuses: statuses,
    criteria,
    raw: raw.raw && typeof raw.raw === 'object' ? raw.raw : {},
  };

  product.criteria_signature = criteriaSignature({
    min_age: product.min_age,
    max_age: product.max_age,
    min_credit_score: product.min_credit_score,
    max_credit_score: product.max_credit_score,
    min_monthly_income: product.min_monthly_income,
    max_monthly_income: product.max_monthly_income,
    min_employment_years: product.min_employment_years,
    required_employment_statuses: product.required_employment_statuses,
    min_loan_amount: product.min_loan_amount,
    max_loan_amount: product.max_loan_amount,
    min_tenure_months: product.min_tenure_months,
    max_tenure_months: product.max_tenure_months,
  });

  return product;
}

module.exports = {
  buildProduct,
  buildProductKey,
  orderRange,
  toInteger,
  toNumber,
};
