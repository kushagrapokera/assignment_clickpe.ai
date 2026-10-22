/**
 * Extractor for the BankBazaar personal loan comparison page.
 *
 * The page lists one card per lender.  Every card contains
 *
 *   - the lender logo whose `alt` text is `Apply Online for <Lender> Personal Loan`
 *   - the product title in an `h4` element
 *   - labelled values (`Loan Amount`, `Fixed`/`Interest Rate`, `Tenure`)
 *   - an accordion with an `Eligibility Criteria` list
 *
 * The extractor therefore splits the document on the logo marker and reads
 * every card independently, which means one broken card cannot break the
 * whole crawl.
 */

const { parseEligibilityLines } = require('../lib/criteria');
const { parseAmount, parseRate, parseTenureMonths } = require('../lib/numbers');
const { buildProduct } = require('../lib/product');
const { cleanText, listItemTexts } = require('../lib/text');

const CARD_MARKER = /alt="Apply Online for ([^"]+)"/g;

/**
 * Read the value that follows a labelled field.
 *
 * The pages render labels and values as two sibling `p` elements:
 * `<p ...>Tenure</p>: <p ...>1 - 5 Years</p>`.
 *
 * @param {string} region markup of one card
 * @param {string[]} labels accepted label spellings
 * @returns {string|null} cleaned value
 */
function labelledValue(region, labels) {
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `>\\s*${label}\\s*<\\/p>[\\s\\S]{0,80}?<p[^>]*>([\\s\\S]{0,200}?)</p>`,
      'i',
    );
    const match = region.match(pattern);
    if (match) {
      const value = cleanText(match[1]);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Read the bullet list that follows an `Eligibility Criteria` heading.
 *
 * @param {string} region markup of one card
 * @returns {string[]} eligibility bullets
 */
function eligibilityBullets(region) {
  const marker = region.search(/Eligibility\s+Criteria/i);
  if (marker === -1) {
    return [];
  }
  const tail = region.slice(marker);
  const listMatch = tail.match(/<ul\b[^>]*>([\s\S]*?)<\/ul>/i);
  if (!listMatch) {
    return [];
  }
  return listItemTexts(listMatch[1]);
}

/**
 * Read the product title of a card.
 *
 * @param {string} region markup of one card
 * @param {string} fallback title derived from the logo alt text
 * @returns {string} product title
 */
function cardTitle(region, fallback) {
  const heading = region.match(/<h[2-5]\b[^>]*>([\s\S]{0,200}?)<\/h[2-5]>/i);
  if (heading) {
    const text = cleanText(heading[1]);
    if (text) {
      return text;
    }
  }
  return fallback;
}

/**
 * Extract every loan product from the BankBazaar page.
 *
 * @param {string} html page markup
 * @param {object} source source registry entry
 * @returns {object[]} canonical products
 */
function extract(html, source) {
  const sourceId = (source && source.id) || 'bankbazaar';
  const sourceUrl = (source && source.url) || '';
  const products = [];

  CARD_MARKER.lastIndex = 0;
  const markers = [];
  let match = CARD_MARKER.exec(html);
  while (match) {
    markers.push({ index: match.index, alt: cleanText(match[1]) });
    match = CARD_MARKER.exec(html);
  }

  markers.forEach((marker, position) => {
    const end = position + 1 < markers.length ? markers[position + 1].index : html.length;
    const region = html.slice(marker.index, end);

    const productName = cardTitle(region, marker.alt);
    const provider = productName.replace(/\s*personal\s+loan\s*$/i, '').trim() || marker.alt;

    const amountText = labelledValue(region, ['Loan Amount', 'Maximum Loan Amount']);
    const rateText = labelledValue(region, ['Interest Rate', 'Interest Rate (p.a.)', 'Fixed']);
    const tenureText = labelledValue(region, ['Tenure', 'Loan Tenure']);
    const feeText = labelledValue(region, ['Processing Fee']);

    const rate = parseRate(rateText || '');
    const tenure = parseTenureMonths(tenureText || '');
    const amount = parseAmount(amountText || '');

    const bullets = eligibilityBullets(region);
    const criteria = parseEligibilityLines(bullets);
    criteria.eligibility_lines = bullets;

    const product = buildProduct({
      product_name: productName,
      provider,
      source_id: sourceId,
      source_url: sourceUrl,
      interest_rate_min: rate.min,
      interest_rate_max: rate.max,
      min_loan_amount: amount,
      max_loan_amount: amount,
      min_tenure_months: tenure.min,
      max_tenure_months: tenure.max,
      min_monthly_income: criteria.min_monthly_income,
      max_monthly_income: criteria.max_monthly_income,
      min_credit_score: criteria.min_credit_score,
      max_credit_score: criteria.max_credit_score,
      min_age: criteria.min_age,
      max_age: criteria.max_age,
      min_employment_years: criteria.min_employment_years,
      required_employment_statuses: criteria.required_employment_statuses,
      criteria,
      raw: {
        amount_text: amountText,
        rate_text: rateText,
        tenure_text: tenureText,
        processing_fee: feeText,
        eligibility_lines: bullets,
      },
    });

    if (product) {
      products.push(product);
    }
  });

  return products;
}

module.exports = { extract };
