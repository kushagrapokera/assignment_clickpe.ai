/**
 * Extractor for Bajaj Finserv personal loan pages.
 *
 * Bajaj publishes two very different kinds of page:
 *
 *   * the main personal loan page carries schema.org markup
 *     (`LoanOrCredit`, `FinancialProduct`) that describes the product
 *     precisely - interest rate, loan amount, tenure, eligible employment
 *     types;
 *   * the product variants (travel, wedding, medical, home expenses,
 *     higher education, salaried) carry no such markup, so their facts are
 *     read from the rendered page: the heading gives the product name, the
 *     body gives the amount, the tenure and the CIBIL requirement.
 *
 * Both paths produce the same canonical product, so the rest of the pipeline
 * does not care which page a product came from.
 */

const { parseAmount, parseAmountRange, parseTenureMonths, parseTenureRange } = require('../lib/numbers');
const { extractJsonLd, findByType, quantitativeRange } = require('../lib/jsonld');
const { buildProduct } = require('../lib/product');
const { cleanText, htmlToText } = require('../lib/text');

/** Marker words that show a percentage is a fee and not the interest rate. */
const FEE_MARKERS = /(fee|prepay|pre-closure|foreclosure|charges|tax|penalty|processing)/i;

/**
 * Read the product name from the heading of the page.
 *
 * @param {string} html page markup
 * @returns {string} product name
 */
function parseProductName(html) {
  const heading = html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i);
  if (heading) {
    const name = cleanHeading(heading[1]);
    if (name) {
      return name;
    }
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? cleanHeading(title[1]) : '';
}

/**
 * Clean a heading or title into a product name.
 *
 * @param {string} value raw heading
 * @returns {string} product name
 */
function cleanHeading(value) {
  let text = cleanText(value);
  text = text.split('|')[0];
  text = text.split(' - ')[0];
  text = text.split(' – ')[0];
  text = text.split(':')[0];
  text = text.replace(/^apply (for|online)\s+/i, '');
  text = text.replace(/\s+at\s+[\d.]+%.*$/i, '');
  text = text.replace(/\s*[-–]\s*up to.*$/i, '');
  text = text.replace(/^personal loan\s*-\s*overview$/i, 'Personal Loan');
  text = text.replace(/\bpersonal loan\b/i, 'Personal Loan');
  text = text.replace(/\bloan\b/i, 'Loan');
  return text.trim();
}

/**
 * Find the interest rate range in the page text.
 *
 * Percentage pairs that belong to a fee are ignored, and a single percentage
 * in the title ("at 10% per annum") is used as the starting rate.
 *
 * @param {string} text page text
 * @param {string} title page title
 * @returns {{min: number|null, max: number|null}} rate range
 */
function parseRateFromText(text, title) {
  const pattern = /(\d+(?:\.\d+)?)%\s*(?:and|to|-|–)\s*(\d+(?:\.\d+)?)%/g;
  let match = pattern.exec(text);
  while (match) {
    const context = text.slice(Math.max(0, match.index - 120), match.index);
    if (!FEE_MARKERS.test(context)) {
      const lower = Number.parseFloat(match[1]);
      const upper = Number.parseFloat(match[2]);
      return { min: Math.min(lower, upper), max: Math.max(lower, upper) };
    }
    match = pattern.exec(text);
  }

  const single = String(title || '').match(/(\d+(?:\.\d+)?)\s*%/);
  if (single) {
    return { min: Number.parseFloat(single[1]), max: null };
  }
  return { min: null, max: null };
}

/**
 * Detect the employment types a page targets.
 *
 * @param {string} name product name
 * @param {string} text page text
 * @returns {string[]} canonical employment statuses
 */
function detectStatuses(name, text) {
  const haystack = `${name} ${text.slice(0, 20000)}`.toLowerCase();
  const salaried = /salaried/.test(haystack);
  const selfEmployed = /self[\s-]?employ/.test(haystack);
  if (salaried && selfEmployed) {
    return ['Salaried', 'Self-Employed'];
  }
  if (salaried) {
    return ['Salaried'];
  }
  if (selfEmployed) {
    return ['Self-Employed'];
  }
  return [];
}

/**
 * Read the minimum CIBIL score from the page text.
 *
 * @param {string} text page text
 * @returns {number|null} minimum credit score
 */
function parseCibil(text) {
  const match = text.match(/CIBIL\s+Score[^0-9]{0,40}(\d{3})/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Read the maximum applicant age from the page text.
 *
 * @param {string} text page text
 * @returns {number|null} maximum age
 */
function parseMaxAge(text) {
  const match = text.match(/(\d{2})\s*years?\s*\*?\s*or younger/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Read the minimum monthly income from the page text.
 *
 * @param {string} text page text
 * @returns {number|null} minimum monthly income
 */
function parseMinimumIncome(text) {
  const patterns = [
    /minimum\s+(?:net\s+)?monthly\s+income[^0-9₹]{0,20}([₹\d,\.]+\s*(?:lakh|lakhs|l|crore|crores)?)/i,
    /monthly\s+income[^0-9₹]{0,20}([₹\d,\.]+\s*(?:lakh|lakhs|l|crore|crores)?)/i,
  ];
  for (let index = 0; index < patterns.length; index += 1) {
    const match = text.match(patterns[index]);
    if (match) {
      const value = parseAmount(match[1]);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Extract every loan product from a Bajaj Finserv page.
 *
 * @param {string} html page markup
 * @param {object} source source registry entry
 * @returns {object[]} canonical products
 */
function extract(html, source) {
  const sourceId = (source && source.id) || 'bajaj-finserv';
  const sourceUrl = (source && source.url) || '';
  const blocks = extractJsonLd(html);

  const loan = findByType(blocks, 'LoanOrCredit');
  const financial = findByType(blocks, 'FinancialProduct');
  const text = htmlToText(html);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? cleanText(titleMatch[1]) : '';

  let rate = quantitativeRange(loan && loan.interestRate);
  let amount = quantitativeRange(loan && loan.amount);
  let term = quantitativeRange(loan && loan.loanTerm);
  let provider = cleanText(
    (loan && loan.provider && loan.provider.name) ||
      (financial && financial.brand && financial.brand.name) ||
      (financial && financial.provider && financial.provider.name),
  );
  let productName = '';
  let statuses = [];

  if (loan || financial) {
    // Schema.org path: the markup describes the product exactly.
    provider = provider || 'Bajaj Finance';
    const category = cleanText((financial && financial.category) || (loan && loan.loanType));
    productName =
      category && category.toLowerCase() !== 'personal loan'
        ? `${provider} ${category}`
        : `${provider} Personal Loan`;
    const audience =
      financial && financial.audience && financial.audience.audienceType
        ? [].concat(financial.audience.audienceType)
        : [];
    statuses = audience
      .map((value) => cleanText(value))
      .filter((value) => /salaried|self|business|employ/i.test(value))
      .map((value) => {
        if (/self/i.test(value)) {
          return 'Self-Employed';
        }
        if (/salaried/i.test(value)) {
          return 'Salaried';
        }
        return value;
      });
  } else {
    // Text path: the product variants publish their facts in the page body.
    provider = 'Bajaj Finance';
    const heading = parseProductName(html);
    if (!heading) {
      return [];
    }
    // Some pages use a generic heading ("Personal loan - overview").  In that
    // case the name of the crawled page is more precise, so it is used.
    let label = heading;
    if (/^(personal )?loan$/i.test(label)) {
      const sourceName = cleanText((source && source.name) || '');
      label = sourceName
        .replace(/^(Bajaj Finance|Bajaj Finserv)\s*/i, '')
        .trim() || label;
    }
    productName = `${provider} ${label}`;
    const textRate = parseRateFromText(text, title);
    const textAmount = parseAmountRange(text);
    const textTerm = parseTenureRange(text);
    rate = { min: textRate.min, max: textRate.max };
    amount = { min: textAmount.min, max: textAmount.max };
    term = { min: textTerm.min, max: textTerm.max };
    statuses = detectStatuses(heading, text);
  }

  const tenureFromText = parseTenureMonths(text);
  const amountFromText = parseAmount(text);

  const criteria = {
    min_monthly_income: parseMinimumIncome(text),
    max_monthly_income: null,
    min_credit_score: parseCibil(text),
    max_credit_score: null,
    min_age: null,
    max_age: parseMaxAge(text),
    min_employment_years: null,
    required_employment_statuses: statuses.slice().sort(),
    per_employment: {},
    eligibility_lines: [],
  };

  const product = buildProduct({
    product_name: productName,
    provider,
    source_id: sourceId,
    source_url: sourceUrl,
    interest_rate_min: rate.min,
    interest_rate_max: rate.max,
    min_loan_amount: amount.min !== null ? amount.min : amountFromText,
    max_loan_amount: amount.max,
    min_tenure_months: term.min !== null ? term.min : tenureFromText.min,
    max_tenure_months: term.max !== null ? term.max : tenureFromText.max,
    min_monthly_income: criteria.min_monthly_income,
    min_credit_score: criteria.min_credit_score,
    max_credit_score: criteria.max_credit_score,
    min_age: criteria.min_age,
    max_age: criteria.max_age,
    min_employment_years: criteria.min_employment_years,
    required_employment_statuses: criteria.required_employment_statuses,
    criteria,
    raw: {
      extraction: loan || financial ? 'json-ld' : 'text',
      json_ld_types: [loan && loan['@type'], financial && financial['@type']].filter(Boolean),
      page_title: title,
      description: cleanText((loan && loan.description) || '').slice(0, 400),
      alternate_names: [].concat((financial && financial.alternateName) || []),
    },
  });

  return product ? [product] : [];
}

module.exports = { extract, parseProductName, parseRateFromText, detectStatuses };
