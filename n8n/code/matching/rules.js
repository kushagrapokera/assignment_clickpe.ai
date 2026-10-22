/**
 * Deterministic eligibility rules.
 *
 * This is stage two of the matching pipeline: a cheap, explainable rule
 * engine that decides the obvious cases without spending a single token on
 * an LLM.
 *
 * A criterion can be in one of four states, and the distinction matters:
 *
 *   `pass`           the lender publishes the requirement and the applicant
 *                    satisfies it
 *   `fail`           the lender publishes the requirement and the applicant
 *                    violates it
 *   `not_published`  the lender publishes no requirement for that attribute
 *                    (it is *not* a threshold of zero, and it is not a pass
 *                    we can pretend to know - it is reported as such)
 *   `unknown`        the lender publishes a requirement but the applicant's
 *                    data for it is missing
 *
 * Every check produces a machine readable reason code so the decisions stay
 * queryable, plus a human readable detail for the notification.
 */

const { normaliseEmploymentStatus, referencedFacts } = require('./facts');
const { evaluatePolicy, compileLine } = require('./policy');

/** Maximum share of the monthly income that may go to existing EMIs. */
const MAX_DEBT_SERVICE_RATIO = 0.5;

/**
 * Build one check result.
 *
 * @param {string} code reason code
 * @param {string} state one of pass, fail, not_published, unknown
 * @param {string} detail human readable explanation
 * @param {object} extra additional fields (requirement, value)
 * @returns {object} check result
 */
function check(code, state, detail, extra) {
  return Object.assign({ code, state, detail }, extra || {});
}

/**
 * Evaluate a numeric range.
 *
 * @param {number|null} value applicant value
 * @param {number|null} min lower bound published by the lender
 * @param {number|null} max upper bound published by the lender
 * @param {object} codes reason codes for this attribute
 * @param {string} label human readable label
 * @returns {object} check result
 */
function checkRange(value, min, max, codes, label) {
  if (min == null && max == null) return check(codes.not_published, 'not_published', `${label} requirement is not published by the lender`);
  if (value == null || value === '' || !Number.isFinite(Number(value))) {
    return check(codes.unknown, 'unknown', `${label} is required but not supplied`, { requirement: { min, max }, value: null });
  }
  if (min != null && Number(value) < Number(min)) {
    return check(codes.below, 'fail', `${label} ${value} is below the required ${min}`, {
      requirement: { min, max: max === undefined ? null : max },
      value: Number(value),
    });
  }
  if (max !== null && max !== undefined && Number(value) > Number(max)) {
    return check(codes.above, 'fail', `${label} ${value} is above the allowed ${max}`, {
      requirement: { min, max },
      value: Number(value),
    });
  }
  return check(codes.pass, 'pass', `${label} ${value} satisfies the requirement`, {
    requirement: { min, max: max === undefined ? null : max },
    value: Number(value),
  });
}

/**
 * Read the numeric checks of a product.
 *
 * @param {object} product loan product
 * @returns {object[]} check results
 */
function numericChecks(product) {
  const checks = [];

  checks.push(
    checkRange(product.age, product.min_age, product.max_age, {
      not_published: 'AGE_NOT_PUBLISHED',
      unknown: 'APPLICANT_AGE_UNKNOWN',
      below: 'AGE_BELOW_MIN',
      above: 'AGE_ABOVE_MAX',
      pass: 'AGE_OK',
    }, 'Age'),
  );

  checks.push(
    checkRange(product.monthly_income, product.min_monthly_income, product.max_monthly_income, {
      not_published: 'INCOME_NOT_PUBLISHED',
      unknown: 'APPLICANT_INCOME_UNKNOWN',
      below: 'INCOME_BELOW_MIN',
      above: 'INCOME_ABOVE_MAX',
      pass: 'INCOME_OK',
    }, 'Monthly income'),
  );

  checks.push(
    checkRange(product.credit_score, product.min_credit_score, product.max_credit_score, {
      not_published: 'CREDIT_SCORE_NOT_PUBLISHED',
      unknown: 'APPLICANT_CREDIT_SCORE_UNKNOWN',
      below: 'CREDIT_SCORE_BELOW_MIN',
      above: 'CREDIT_SCORE_ABOVE_MAX',
      pass: 'CREDIT_SCORE_OK',
    }, 'Credit score'),
  );

  return checks;
}

/**
 * Evaluate one applicant against one product.
 *
 * @param {object} user applicant
 * @param {object} product loan product
 * @returns {object} evaluation
 */
function evaluatePair(user, product) {
  const applicant = { ...(user.eligibility_facts || {}), ...user,
    employment_status: normaliseEmploymentStatus(user.employment_status) };
  const policy = evaluatePolicy(applicant, product);
  const specific = ((product.criteria || {}).per_employment || {})[applicant.employment_status] || {};
  const effective = key => specific[key] == null ? product[key] : specific[key];
  const numeric = numericChecks({ ...applicant,
    min_age: effective('min_age'), max_age: effective('max_age'),
    min_monthly_income: effective('min_monthly_income'), max_monthly_income: effective('max_monthly_income'),
    min_credit_score: effective('min_credit_score'), max_credit_score: effective('max_credit_score') });
  const checks = numeric.filter((_, index) => !policy.handled.has(['age','monthly_income','credit_score'][index]));
  const allowed = (product.required_employment_statuses || []).map(normaliseEmploymentStatus);
  if (!allowed.length) checks.push(check('EMPLOYMENT_STATUS_NOT_PUBLISHED','not_published','Employment status requirement is not published by the lender'));
  else if (applicant.employment_status === 'Unknown') checks.push(check('APPLICANT_EMPLOYMENT_STATUS_UNKNOWN','unknown','Employment status is required'));
  else checks.push(check(allowed.includes(applicant.employment_status) ? 'EMPLOYMENT_OK' : 'EMPLOYMENT_NOT_ACCEPTED',
    allowed.includes(applicant.employment_status) ? 'pass' : 'fail', `Employment status ${applicant.employment_status}; accepted: ${allowed.join(', ')}`));
  const experienceHandled = ['employment_years','current_employer_years','post_qualification_years','business_years'].some(field => policy.handled.has(field));
  if (!experienceHandled) checks.push(checkRange(applicant.employment_years,effective('min_employment_years'),null,{
    not_published:'EMPLOYMENT_YEARS_NOT_PUBLISHED',unknown:'APPLICANT_EMPLOYMENT_YEARS_UNKNOWN',
    below:'EMPLOYMENT_YEARS_BELOW_MIN',above:'EMPLOYMENT_YEARS_ABOVE_MAX',pass:'EMPLOYMENT_YEARS_OK'},'Work experience'));
  checks.push(...policy.checks);
  if (applicant.existing_emi != null && applicant.monthly_income) {
    const ratio=Number(applicant.existing_emi)/Number(applicant.monthly_income);
    checks.push(check(ratio>MAX_DEBT_SERVICE_RATIO?'DEBT_SERVICE_RATIO_EXCEEDED':'DEBT_SERVICE_RATIO_OK',
      ratio>MAX_DEBT_SERVICE_RATIO?'fail':'pass',`Existing EMIs use ${Math.round(ratio*100)}% of monthly income; maximum is 50%`));
  }
  const unresolved=policy.unresolved;
  const referenced=referencedFacts(unresolved);
  const missing=referenced.filter(field => applicant[field] == null || applicant[field] === '' || String(applicant[field]).toLowerCase() === 'unknown');
  if (missing.length) checks.push(check('POLICY_FACTS_MISSING','unknown',`Manual review: policy requires missing facts (${missing.join(', ')})`,{fields:missing}));
  if (unresolved.length && !referenced.length) checks.push(check('POLICY_EVIDENCE_UNAVAILABLE','unknown','Manual review: unrecognised policy wording has no supported applicant facts to evaluate'));
  const failures=checks.filter(entry=>entry.state==='fail');
  const unknowns=checks.filter(entry=>entry.state==='unknown');
  const needsModel=!failures.length&&!unknowns.length&&unresolved.length>0;
  return {
    status:failures.length?'ineligible':unknowns.length?'likely':needsModel?'needs_llm':'eligible',
    checks, reasons:(failures.length?failures:unknowns).map(entry=>entry.detail),
    failures:failures.map(entry=>entry.code), needs_llm:needsModel, narrative:unresolved,
    undecided:unknowns,not_published:checks.filter(entry=>entry.state==='not_published'),
  };
}

/**
 * Read the narrative eligibility rules of a product.
 *
 * @param {object} product loan product
 * @returns {string[]} rule texts
 */
function narrativeRules(product) {
  const criteria = product.criteria || {};
  const lines = Array.isArray(criteria.eligibility_lines) ? criteria.eligibility_lines : [];
  return lines.filter((line) => typeof line === 'string' && line.trim().length > 0);
}

/**
 * Decide whether a narrative rule is already enforced by a numeric rule.
 *
 * A rule such as "Salaried - Age at least 21 and less than 60" is fully
 * covered by the age check, so it never needs the qualitative stage.  A rule
 * such as "the business must have been in existence for 3 years" is not.
 *
 * @param {string} rule narrative rule
 * @param {object} product loan product
 * @returns {boolean} true when the rule is already enforced
 */
function coveredByRules(rule, product) {
  return compileLine(rule) !== null;
}

module.exports = {
  MAX_DEBT_SERVICE_RATIO,
  check,
  checkRange,
  coveredByRules,
  evaluatePair,
  narrativeRules,
  numericChecks,
};
