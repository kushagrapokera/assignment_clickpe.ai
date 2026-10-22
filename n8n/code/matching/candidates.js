/**
 * The candidate pairs of a batch.
 *
 * The pairs used to be produced by a SQL statement that joined the
 * applicants with the products.  That statement was the largest object that
 * travelled through the workflow: every one of the ~155 000 pairs carried a
 * complete copy of the criteria of its lender, including the raw evidence.
 *
 * The applicants and the products are now fetched separately - one row per
 * applicant and one row per product - and the pairs are built here.  The
 * rules of the pre-filter are kept exactly as they were, so the same pairs
 * are considered as before:
 *
 *   * the age, credit score and income ranges of the lender,
 *   * the exception for a lender that publishes an age at maturity, which
 *     cannot be checked before the requested tenure is known.
 *
 * A pair that does not pass the pre-filter is not a candidate.  It is still
 * recorded as a rejection when the applicant is known to be outside a
 * published range; a missing applicant value is not a rejection, it is simply
 * not a decision.
 *
 * A rejection names the criterion the applicant missed, with the value of
 * the applicant and the requirement of the lender, so the interface can
 * answer "why not?" without a second run.
 */

/**
 * Build the explanation of a range that is not met.
 *
 * The wording is the one of the rule engine, so a rejection reads the same
 * whether it was decided by the pre-filter or by the rules.
 *
 * @param {string} code reason code
 * @param {string} label readable name of the attribute
 * @param {number} value value of the applicant
 * @param {number|null} min lower bound of the lender
 * @param {number|null} max upper bound of the lender
 * @param {string} direction `below` or `above`
 * @returns {object} the reason
 */
function rangeReason(code, label, value, min, max, direction) {
  const bound = direction === 'below' ? min : max;
  const word = direction === 'below' ? 'is below the required' : 'is above the allowed';
  return {
    code,
    state: 'fail',
    detail: `${label} ${value} ${word} ${bound}`,
  };
}

/**
 * Read a number, treating a missing value as unknown.
 *
 * @param {*} value raw value
 * @returns {number|null} the number or null
 */
function numberOf(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** The maturity flag of a product, so it is computed once per lender. */
const MATURITY = new WeakMap();

/**
 * Decide whether a lender publishes an age at maturity.
 *
 * The pre-filter of the SQL stage ignored the age bounds of such a lender,
 * because the age that counts is the age at the end of the loan, which needs
 * the requested tenure.  The rule engine evaluates the requirement instead.
 *
 * @param {object} product loan product
 * @returns {boolean} true when the lender publishes a maturity age
 */
function publishesMaturityAge(product) {
  if (!product || typeof product !== 'object') {
    return false;
  }
  const known = MATURITY.get(product);
  if (known !== undefined) {
    return known;
  }
  const criteria = product.criteria || {};
  const lines = criteria.eligibility_lines;
  const text = JSON.stringify(lines === undefined || lines === null ? [] : lines);
  const result = /maturity/i.test(text);
  MATURITY.set(product, result);
  return result;
}

/**
 * Apply the pre-filter of the SQL stage to one pair.
 *
 * @param {object} user applicant
 * @param {object} product loan product
 * @returns {{candidate: boolean, rejected: boolean, reasons: object[]}} the outcome
 */
function preFilter(user, product) {
  const maturity = publishesMaturityAge(product);

  const age = numberOf(user.age);
  const credit = numberOf(user.credit_score);
  const income = numberOf(user.monthly_income);

  const minAge = numberOf(product.min_age);
  const maxAge = numberOf(product.max_age);
  const minCredit = numberOf(product.min_credit_score);
  const maxCredit = numberOf(product.max_credit_score);
  const minIncome = numberOf(product.min_monthly_income);
  const maxIncome = numberOf(product.max_monthly_income);

  const candidate =
    (minAge === null || maturity || (age !== null && age >= minAge)) &&
    (maxAge === null || maturity || (age !== null && age <= maxAge)) &&
    (minCredit === null || (credit !== null && credit >= minCredit)) &&
    (maxCredit === null || (credit !== null && credit <= maxCredit)) &&
    (minIncome === null || (income !== null && income >= minIncome)) &&
    (maxIncome === null || (income !== null && income <= maxIncome));

  if (candidate) {
    return { candidate: true, rejected: false, reasons: [] };
  }

  // The pair is not a candidate.  It is only a rejection when a published
  // range is known and the applicant is known to be outside of it; a missing
  // applicant value is not a rejection.
  const reasons = [];
  if (!maturity) {
    if (minAge !== null && age !== null && age < minAge) {
      reasons.push(rangeReason('AGE_BELOW_MIN', 'Age', age, minAge, maxAge, 'below'));
    }
    if (maxAge !== null && age !== null && age > maxAge) {
      reasons.push(rangeReason('AGE_ABOVE_MAX', 'Age', age, minAge, maxAge, 'above'));
    }
  }
  if (minCredit !== null && credit !== null && credit < minCredit) {
    reasons.push(
      rangeReason('CREDIT_SCORE_BELOW_MIN', 'Credit score', credit, minCredit, maxCredit, 'below'),
    );
  }
  if (maxCredit !== null && credit !== null && credit > maxCredit) {
    reasons.push(
      rangeReason('CREDIT_SCORE_ABOVE_MAX', 'Credit score', credit, minCredit, maxCredit, 'above'),
    );
  }
  if (minIncome !== null && income !== null && income < minIncome) {
    reasons.push(
      rangeReason('INCOME_BELOW_MIN', 'Monthly income', income, minIncome, maxIncome, 'below'),
    );
  }
  if (maxIncome !== null && income !== null && income > maxIncome) {
    reasons.push(
      rangeReason('INCOME_ABOVE_MAX', 'Monthly income', income, minIncome, maxIncome, 'above'),
    );
  }

  return { candidate: false, rejected: reasons.length > 0, reasons };
}

/**
 * Build the rejection of a pair that is outside a published range.
 *
 * @param {object} user applicant
 * @param {object} product loan product
 * @param {object[]} reasons the criteria the applicant missed
 * @returns {object} an evaluated pair that is rejected
 */
function rejectedPair(user, product, reasons) {
  return {
    user_id: user.user_id,
    batch_id: user.batch_id || null,
    product_id: product.product_id,
    status: 'ineligible',
    needs_llm: false,
    reasons: reasons || [],
  };
}

module.exports = {
  numberOf,
  preFilter,
  publishesMaturityAge,
  rangeReason,
  rejectedPair,
};
