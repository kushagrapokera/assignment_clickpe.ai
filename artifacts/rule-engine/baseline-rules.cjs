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

const { normaliseEmploymentStatus } = require('../../n8n/code/matching/facts');

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
  if (min === null || min === undefined) {
    if (max === null || max === undefined) {
      return check(codes.not_published, 'not_published', `${label} requirement is not published by the lender`);
    }
    return check(codes.not_published, 'not_published', `${label} requirement is not published by the lender`);
  }
  if (value === null || value === undefined) {
    return check(codes.unknown, 'unknown', `${label} is unknown but at least ${min} is required`, {
      requirement: { min, max: max === undefined ? null : max },
      value: null,
    });
  }
  if (Number(value) < Number(min)) {
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
  const applicant = {
    user_id: user.user_id,
    monthly_income: user.monthly_income === undefined ? null : user.monthly_income,
    credit_score: user.credit_score === undefined ? null : user.credit_score,
    age: user.age === undefined ? null : user.age,
    employment_status: normaliseEmploymentStatus(user.employment_status),
    employment_years: user.employment_years === undefined ? null : user.employment_years,
    existing_emi: user.existing_emi === undefined ? null : user.existing_emi,
  };

  const checks = numericChecks({
    age: applicant.age,
    monthly_income: applicant.monthly_income,
    credit_score: applicant.credit_score,
    min_age: product.min_age,
    max_age: product.max_age,
    min_monthly_income: product.min_monthly_income,
    max_monthly_income: product.max_monthly_income,
    min_credit_score: product.min_credit_score,
    max_credit_score: product.max_credit_score,
  });

  // Employment status allow list.
  const allowed = Array.isArray(product.required_employment_statuses)
    ? product.required_employment_statuses
    : [];
  if (!allowed.length) {
    checks.push(
      check('EMPLOYMENT_STATUS_NOT_PUBLISHED', 'not_published', 'Employment status requirement is not published by the lender'),
    );
  } else if (!allowed.includes(applicant.employment_status)) {
    checks.push(
      check(
        'EMPLOYMENT_NOT_ACCEPTED',
        'fail',
        `Employment status "${applicant.employment_status}" is not accepted by this lender (${allowed.join(', ')})`,
        { requirement: { allowed }, value: applicant.employment_status },
      ),
    );
  } else {
    checks.push(
      check('EMPLOYMENT_OK', 'pass', `Employment status "${applicant.employment_status}" is accepted`, {
        requirement: { allowed },
        value: applicant.employment_status,
      }),
    );
  }

  // Minimum work experience.
  if (product.min_employment_years === null || product.min_employment_years === undefined) {
    checks.push(
      check('EMPLOYMENT_YEARS_NOT_PUBLISHED', 'not_published', 'Work experience requirement is not published by the lender'),
    );
  } else if (applicant.employment_years === null || applicant.employment_years === undefined) {
    checks.push(
      check(
        'APPLICANT_EMPLOYMENT_YEARS_UNKNOWN',
        'unknown',
        `Work experience is unknown but at least ${product.min_employment_years} year(s) is required`,
        { requirement: { min: product.min_employment_years }, value: null },
      ),
    );
  } else if (Number(applicant.employment_years) < Number(product.min_employment_years)) {
    checks.push(
      check(
        'EMPLOYMENT_YEARS_BELOW_MIN',
        'fail',
        `Work experience ${applicant.employment_years} year(s) is below the required ${product.min_employment_years}`,
        { requirement: { min: product.min_employment_years }, value: Number(applicant.employment_years) },
      ),
    );
  } else {
    checks.push(
      check('EMPLOYMENT_YEARS_OK', 'pass', `Work experience ${applicant.employment_years} year(s) satisfies the requirement`, {
        requirement: { min: product.min_employment_years },
        value: Number(applicant.employment_years),
      }),
    );
  }

  // Debt service ratio, only when the applicant has existing EMIs.
  if (
    applicant.existing_emi !== null &&
    applicant.existing_emi !== undefined &&
    applicant.monthly_income
  ) {
    const ratio = Number(applicant.existing_emi) / Number(applicant.monthly_income);
    if (ratio > MAX_DEBT_SERVICE_RATIO) {
      checks.push(
        check(
          'DEBT_SERVICE_RATIO_EXCEEDED',
          'fail',
          `Existing EMIs use ${Math.round(ratio * 100)}% of the monthly income, above the ${Math.round(
            MAX_DEBT_SERVICE_RATIO * 100,
          )}% limit`,
          { requirement: { max: MAX_DEBT_SERVICE_RATIO }, value: Number(ratio.toFixed(4)) },
        ),
      );
    } else {
      checks.push(
        check('DEBT_SERVICE_RATIO_OK', 'pass', `Debt service ratio ${Math.round(ratio * 100)}% is within the limit`, {
          requirement: { max: MAX_DEBT_SERVICE_RATIO },
          value: Number(ratio.toFixed(4)),
        }),
      );
    }
  }

  const failures = checks.filter((entry) => entry.state === 'fail');
  const unknowns = checks.filter((entry) => entry.state === 'unknown');
  const notPublished = checks.filter((entry) => entry.state === 'not_published');

  // The narrative rules of the lender are the part the rule engine cannot
  // decide: they talk about employer categories, cities or business history
  // that a CSV row does not contain.
  const narrative = narrativeRules(product);
  const unresolved = narrative.filter((rule) => !coveredByRules(rule, product));

  if (failures.length) {
    return {
      status: 'ineligible',
      checks,
      reasons: failures.map((entry) => entry.detail),
      failures: failures.map((entry) => entry.code),
      needs_llm: false,
      narrative: unresolved,
      undecided: unknowns,
      not_published: notPublished,
    };
  }

  if (unresolved.length) {
    return {
      status: 'needs_llm',
      checks,
      reasons: [],
      failures: [],
      needs_llm: true,
      narrative: unresolved,
      undecided: unknowns,
      not_published: notPublished,
    };
  }

  return {
    status: unknowns.length ? 'likely' : 'eligible',
    checks,
    reasons: unknowns.map((entry) => entry.detail),
    failures: [],
    needs_llm: false,
    narrative: [],
    undecided: unknowns,
    not_published: notPublished,
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
  const text = String(rule).toLowerCase();
  const hasNumber = /\d/.test(text);
  const ageRule = /\bage\b/.test(text);
  const incomeRule = /income|earning|salary/.test(text);
  const creditRule = /credit score|cibil/.test(text);
  const tenureRule = /experience|years with|current company/.test(text);

  if (ageRule && hasNumber && product.min_age !== null && product.max_age !== null) {
    return true;
  }
  if (incomeRule && hasNumber && product.min_monthly_income !== null) {
    return true;
  }
  if (creditRule && hasNumber && product.min_credit_score !== null) {
    return true;
  }
  if (tenureRule && hasNumber && product.min_employment_years !== null) {
    return true;
  }
  return false;
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
