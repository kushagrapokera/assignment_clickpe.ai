/**
 * Numeric parsers for Indian financial pages.
 *
 * The crawled pages express amounts in several notations: `₹40L`,
 * `Rs.35 lakhs`, `₹ 1,20,000`, `1.5 lakh`, `10.85% - 21.00%`, `1 - 5 Years`.
 * Every parser returns `null` when the value cannot be understood so the
 * caller can keep the field empty instead of storing a wrong number.
 */

const RUPEE = '₹';

/**
 * Parse a number that may contain Indian digit grouping.
 *
 * @param {string|number} value raw number
 * @returns {number|null} parsed number
 */
function parseNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') {
    return null;
  }
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Multiply a magnitude by the unit suffix used on the page.
 *
 * @param {number} value magnitude
 * @param {string} unit lower case unit token
 * @returns {number} amount in rupees
 */
function applyMagnitude(value, unit) {
  switch (unit) {
    case 'crore':
    case 'cr':
      return value * 10000000;
    case 'lakh':
    case 'lakhs':
    case 'lac':
    case 'lacs':
    case 'l':
      return value * 100000;
    case 'thousand':
    case 'k':
      return value * 1000;
    default:
      return value;
  }
}

/**
 * Parse a rupee amount such as `Up to ₹40L`, `Rs.35 lakhs` or `₹ 1,20,000`.
 *
 * When the text contains several amounts the largest one is returned, because
 * pages phrase limits as `₹ 1 lakh to ₹ 10 lakh`.
 *
 * @param {string} text raw text
 * @param {{strategy?: 'first'|'max'}} [options] parsing options
 * @returns {number|null} amount in rupees
 */
function parseAmount(text, options) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  const strategy = (options && options.strategy) || 'max';
  const pattern = new RegExp(
    `(${RUPEE}|rs\\.?|inr)?\\s*([0-9][0-9,\\.]*)\\s*(crores?|cr|lakhs?|lacs?|lac|l|thousand|k)?`,
    'gi',
  );
  let best = null;
  let first = null;
  let match = pattern.exec(text);
  while (match) {
    const magnitude = parseNumber(match[2]);
    if (magnitude !== null) {
      const unit = (match[3] || '').toLowerCase();
      const amount = applyMagnitude(magnitude, unit);
      // A bare number without a currency marker is only trusted when it is
      // reasonably large, otherwise "5 Years" would become 5 rupees.
      const hasCurrency = Boolean(match[1]) || Boolean(unit);
      if (hasCurrency || amount >= 1000) {
        if (first === null) {
          first = amount;
        }
        if (best === null || amount > best) {
          best = amount;
        }
      }
    }
    match = pattern.exec(text);
  }
  if (strategy === 'first') {
    return first;
  }
  return best;
}

/**
 * Parse a percentage range such as `10.85% - 21.00%`, `8.75% onwards` or
 * `10.00% p.a. to 15.00% p.a.`.
 *
 * @param {string} text raw text
 * @returns {{min: number|null, max: number|null}} rate range in percent
 */
function parseRate(text) {
  if (typeof text !== 'string' || !text.includes('%')) {
    return { min: null, max: null };
  }
  const values = [];
  const pattern = /([0-9]+(?:\.[0-9]+)?)\s*%/g;
  let match = pattern.exec(text);
  while (match) {
    values.push(Number.parseFloat(match[1]));
    match = pattern.exec(text);
  }
  if (!values.length) {
    return { min: null, max: null };
  }
  const lower = text.toLowerCase();
  if (values.length === 1) {
    const only = values[0];
    if (lower.includes('onward') || lower.includes('from ')) {
      return { min: only, max: null };
    }
    return { min: only, max: only };
  }
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Parse a tenure expressed in years or months into months.
 *
 * Handles ranges such as `1 - 5 Years`, `12 months to 108 months` and single
 * values such as `5 Years`.
 *
 * @param {string} text raw text
 * @returns {{min: number|null, max: number|null}} tenure in months
 */
function parseTenureMonths(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { min: null, max: null };
  }
  const unit = text.match(/(year|years|yr|yrs|month|months|mn)/i);
  if (!unit) {
    return { min: null, max: null };
  }
  const isYear = /^(year|yr)/i.test(unit[1]);
  const toMonths = (value) => (isYear ? value * 12 : value);

  // A range: `1 - 5 Years`, `12 to 108 months`, `1-5 Years`.
  const range = text.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)/i);
  if (range) {
    const lower = toMonths(Number.parseFloat(range[1]));
    const upper = toMonths(Number.parseFloat(range[2]));
    return {
      min: Math.round(Math.min(lower, upper)),
      max: Math.round(Math.max(lower, upper)),
    };
  }

  const single = text.match(/(\d+(?:\.\d+)?)/);
  if (!single) {
    return { min: null, max: null };
  }
  const value = Math.round(toMonths(Number.parseFloat(single[1])));
  const lower = text.toLowerCase();
  if (lower.includes('up to') || lower.includes('max')) {
    return { min: null, max: value };
  }
  return { min: value, max: value };
}

/**
 * Parse an age range such as `21 and less than 60` or `19 years to 58 years`.
 *
 * Only text that talks about the age of the applicant is considered, so a
 * sentence such as "at least 5 years of experience" is never mistaken for
 * an age requirement.
 *
 * @param {string} text raw text
 * @returns {{min: number|null, max: number|null}} age range in years
 */
function parseAge(text) {
  if (typeof text !== 'string') {
    return { min: null, max: null };
  }
  if (!/\bage\b|\byears?\s+old\b|\bat\s+the\s+time\s+of\s+loan\s+maturity/i.test(text)) {
    return { min: null, max: null };
  }

  // `22 - 60`, `22 to 60`, `19 years to 58`
  const simpleRange = text.match(/(\d{1,2})\s*(?:years?|yrs?)?\s*(?:-|to|–|—)\s*(\d{1,2})/i);
  if (simpleRange) {
    const lower = Number.parseInt(simpleRange[1], 10);
    const upper = Number.parseInt(simpleRange[2], 10);
    return { min: Math.min(lower, upper), max: Math.max(lower, upper) };
  }

  // `21 and less than 60`, `23 years and less than 58 years`
  const boundedRange = text.match(
    /(\d{1,2})\D{0,30}?(?:less than|up to|or more than|or older|above|below|not more than|max(?:imum)?)\D{0,10}?(\d{1,2})/i,
  );
  if (boundedRange) {
    const lower = Number.parseInt(boundedRange[1], 10);
    const upper = Number.parseInt(boundedRange[2], 10);
    return { min: Math.min(lower, upper), max: Math.max(lower, upper) };
  }

  const atLeast = text.match(/at least\s*(\d{1,2})/i) || text.match(/minimum age[^0-9]{0,12}(\d{1,2})/i);
  if (atLeast) {
    return { min: Number.parseInt(atLeast[1], 10), max: null };
  }

  const atMost = text.match(/(?:less than|up to|not more than|below|or younger than)\s*(\d{1,2})/i);
  if (atMost) {
    return { min: null, max: Number.parseInt(atMost[1], 10) };
  }

  const single = text.match(/\bage\D{0,12}(\d{1,2})\b/i);
  if (single) {
    const value = Number.parseInt(single[1], 10);
    return { min: value, max: value };
  }
  return { min: null, max: null };
}

/**
 * Parse a rupee range such as `Rs. 40,000 to Rs. 55 lakh`.
 *
 * @param {string} text raw text
 * @returns {{min: number|null, max: number|null}} amount range in rupees
 */
function parseAmountRange(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { min: null, max: null };
  }
  const pattern = new RegExp(
    `(${RUPEE}|rs\\.?|inr)\\s*([0-9][0-9,\\.]*)\\s*(crores?|cr|lakhs?|lacs?|lac|l|thousand|k)?\\s*` +
      `(?:to|and|-|–)\\s*(${RUPEE}|rs\\.?|inr)?\\s*([0-9][0-9,\\.]*)\\s*(crores?|cr|lakhs?|lacs?|lac|l|thousand|k)?`,
    'gi',
  );

  // A page usually mentions several amounts (navigation teasers, fee tables,
  // the amount the applicant may borrow).  The range that belongs to the
  // product is the one that is introduced as a loan or amount; when several
  // candidates qualify the largest one wins.
  let best = null;
  let match = pattern.exec(text);
  while (match) {
    const context = text.slice(Math.max(0, match.index - 90), match.index).toLowerCase();
    const relevant = /loan|amount|borrow|range|eligib/.test(context);
    const lowerMagnitude = parseNumber(match[2]);
    const upperMagnitude = parseNumber(match[5]);
    if (lowerMagnitude !== null && upperMagnitude !== null) {
      const lowerUnit = (match[3] || '').toLowerCase();
      const upperUnit = (match[6] || '').toLowerCase();
      const candidate = {
        min: applyMagnitude(lowerMagnitude, lowerUnit),
        max: applyMagnitude(upperMagnitude, upperUnit),
        relevant,
      };
      if (
        !best ||
        (candidate.relevant && !best.relevant) ||
        (candidate.relevant === best.relevant && candidate.max > best.max)
      ) {
        best = candidate;
      }
    }
    match = pattern.exec(text);
  }

  if (!best) {
    return { min: null, max: null };
  }
  return { min: best.min, max: best.max };
}

/**
 * Parse a tenure range such as `12 months to 108 months`.
 *
 * @param {string} text raw text
 * @returns {{min: number|null, max: number|null}} tenure in months
 */
function parseTenureRange(text) {
  if (typeof text !== 'string') {
    return { min: null, max: null };
  }
  const match = text.match(/(\d{1,3})\s*months?\s*(?:to|-|and)\s*(\d{1,3})\s*months?/i);
  if (!match) {
    return { min: null, max: null };
  }
  const lower = Number.parseInt(match[1], 10);
  const upper = Number.parseInt(match[2], 10);
  return { min: Math.min(lower, upper), max: Math.max(lower, upper) };
}

/**
 * Parse a credit score requirement.
 *
 * @param {string} text raw text
 * @returns {{min: number|null, max: number|null}} credit score range
 */
function parseCreditScore(text) {
  if (typeof text !== 'string' || !/credit score/i.test(text)) {
    return { min: null, max: null };
  }
  const range = text.match(/(\d{3})\s*(?:-|to|–)\s*(\d{3})/);
  if (range) {
    return { min: Number.parseInt(range[1], 10), max: Number.parseInt(range[2], 10) };
  }
  const above = text.match(/(?:above|at least|minimum of|minimum|more than|greater than|of)\s*(\d{3})/i);
  if (above) {
    return { min: Number.parseInt(above[1], 10), max: null };
  }
  const single = text.match(/\b(\d{3})\b/);
  if (single) {
    return { min: Number.parseInt(single[1], 10), max: null };
  }
  return { min: null, max: null };
}

/**
 * Parse a minimum monthly income requirement.
 *
 * @param {string} text raw text
 * @returns {number|null} minimum monthly income in rupees
 */
function parseMonthlyIncome(text) {
  if (typeof text !== 'string') {
    return null;
  }
  if (!/income|earning|salary|earnings/i.test(text)) {
    return null;
  }
  const perMonth = /per\s*month|monthly|a month|net monthly income|per month/i.test(text);
  if (!perMonth) {
    // An annual figure cannot be compared to a monthly income field without
    // a monthly marker, so it is ignored on purpose.
    return null;
  }
  // "at least ₹ 20,000 per month (₹ 25,000 for applicants from MP)" states the
  // floor first and the higher regional figure second, so the first amount is
  // the requirement.
  const strategy = /at least|minimum|not less than|more than/i.test(text) ? 'first' : 'max';
  return parseAmount(text, { strategy });
}

/**
 * Parse a minimum employment duration in years.
 *
 * @param {string} text raw text
 * @returns {number|null} minimum years of employment
 */
function parseEmploymentYears(text) {
  if (typeof text !== 'string') {
    return null;
  }
  if (!/experience|employment|work\s*experience/i.test(text)) {
    return null;
  }
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:\+\s*)?(?:years?|yrs?)\b/i);
  if (!match) {
    return null;
  }
  return Number.parseFloat(match[1]);
}

module.exports = {
  parseAge,
  parseAmount,
  parseAmountRange,
  parseCreditScore,
  parseEmploymentYears,
  parseMonthlyIncome,
  parseNumber,
  parseRate,
  parseTenureMonths,
  parseTenureRange,
};
