/**
 * Turns the free text eligibility bullets of a lender into structured
 * criteria the matcher can filter on.
 *
 * The crawl targets phrase their requirements in many different ways, for
 * example:
 *
 *   "Salaried - Age at least 21 and less than 60"
 *   "Self-employed - Age at least 21 and less than 65"
 *   "Applicant should be earning at least ₹ 20,000 per month as net income"
 *   "Minimum 3 years of total work experience or minimum 1 year with current company"
 *
 * Every parser is intentionally conservative: when a value cannot be read the
 * field stays empty instead of being guessed.
 */

const {
  parseAge,
  parseAmount,
  parseCreditScore,
  parseEmploymentYears,
  parseMonthlyIncome,
} = require('./numbers');
const { cleanText } = require('./text');

/** Canonical spelling of every employment status the engine understands. */
const EMPLOYMENT_STATUSES = ['Salaried', 'Self-Employed', 'Business', 'Retired', 'Student'];

/**
 * Detect which employment status a bullet refers to.
 *
 * @param {string} text bullet text
 * @returns {string|null} canonical employment status or null
 */
function detectEmploymentStatus(text) {
  const lower = String(text || '').toLowerCase();
  if (/self[\s-]?employed|self[\s-]?employ|business owner|self employed professional/.test(lower)) {
    return 'Self-Employed';
  }
  if (/salaried|employee of|working professional|employer/.test(lower)) {
    return 'Salaried';
  }
  if (/business owner|proprietor|partnership|firm|trader/.test(lower)) {
    return 'Business';
  }
  if (/retired|pension/.test(lower)) {
    return 'Retired';
  }
  if (/student/.test(lower)) {
    return 'Student';
  }
  return null;
}

/**
 * Create an empty criteria container.
 *
 * @returns {object} blank criteria
 */
function emptyCriteria() {
  return {
    min_monthly_income: null,
    max_monthly_income: null,
    min_credit_score: null,
    max_credit_score: null,
    min_age: null,
    max_age: null,
    min_employment_years: null,
    required_employment_statuses: [],
    per_employment: {},
  };
}

/**
 * Parse a single eligibility bullet.
 *
 * @param {string} rawLine bullet text
 * @returns {object} criteria fragment extracted from the bullet
 */
function parseEligibilityLine(rawLine) {
  const line = cleanText(rawLine);
  const fragment = {
    min_monthly_income: null,
    min_credit_score: null,
    min_age: null,
    max_age: null,
    min_employment_years: null,
    employment_status: detectEmploymentStatus(line),
  };

  const age = parseAge(line);
  if (age.min !== null || age.max !== null) {
    fragment.min_age = age.min;
    fragment.max_age = age.max;
  }

  const income = parseMonthlyIncome(line);
  if (income !== null) {
    fragment.min_monthly_income = income;
  }

  const credit = parseCreditScore(line);
  if (credit.min !== null) {
    fragment.min_credit_score = credit.min;
  }

  const years = parseEmploymentYears(line);
  if (years !== null) {
    fragment.min_employment_years = years;
  }

  return fragment;
}

/**
 * Parse every eligibility bullet of a product.
 *
 * Bullets that mention a specific employment status contribute to the
 * per-employment criteria; bullets without a status contribute to the
 * product wide criteria.
 *
 * @param {string[]} lines eligibility bullets
 * @returns {object} structured criteria
 */
function parseEligibilityLines(lines) {
  const criteria = emptyCriteria();
  const statusBuckets = {};

  (lines || []).forEach((rawLine) => {
    const line = cleanText(rawLine);
    if (!line) {
      return;
    }
    const fragment = parseEligibilityLine(line);
    const bucket = fragment.employment_status;

    if (bucket) {
      if (!statusBuckets[bucket]) {
        statusBuckets[bucket] = emptyCriteria();
      }
      const target = statusBuckets[bucket];
      if (fragment.min_age !== null) {
        target.min_age = fragment.min_age;
      }
      if (fragment.max_age !== null) {
        target.max_age = fragment.max_age;
      }
      if (fragment.min_monthly_income !== null) {
        target.min_monthly_income = fragment.min_monthly_income;
      }
      if (fragment.min_credit_score !== null) {
        target.min_credit_score = fragment.min_credit_score;
      }
      if (fragment.min_employment_years !== null) {
        target.min_employment_years = fragment.min_employment_years;
      }
      return;
    }

    if (fragment.min_age !== null) {
      criteria.min_age = fragment.min_age;
    }
    if (fragment.max_age !== null) {
      criteria.max_age = fragment.max_age;
    }
    if (fragment.min_monthly_income !== null) {
      criteria.min_monthly_income = fragment.min_monthly_income;
    }
    if (fragment.min_credit_score !== null) {
      criteria.min_credit_score = fragment.min_credit_score;
    }
    if (fragment.min_employment_years !== null) {
      criteria.min_employment_years = fragment.min_employment_years;
    }
  });

  criteria.per_employment = statusBuckets;

  // A product that lists explicit status buckets only accepts those statuses.
  const statuses = Object.keys(statusBuckets).filter((status) =>
    EMPLOYMENT_STATUSES.includes(status),
  );
  criteria.required_employment_statuses = statuses.length ? statuses.sort() : [];

  // Derive the product wide bounds from the status buckets so the SQL
  // pre-filter can use a single range per product.
  const bucketAges = statuses.map((status) => statusBuckets[status]);
  const ages = bucketAges.filter((bucket) => bucket.min_age !== null || bucket.max_age !== null);
  if (ages.length) {
    const mins = ages.map((bucket) => bucket.min_age).filter((value) => value !== null);
    const maxes = ages.map((bucket) => bucket.max_age).filter((value) => value !== null);
    criteria.min_age = mins.length ? Math.min(...mins) : criteria.min_age;
    criteria.max_age = maxes.length ? Math.max(...maxes) : criteria.max_age;
  }

  const incomes = bucketAges
    .map((bucket) => bucket.min_monthly_income)
    .filter((value) => value !== null);
  if (incomes.length) {
    criteria.min_monthly_income =
      criteria.min_monthly_income === null
        ? Math.min(...incomes)
        : Math.min(criteria.min_monthly_income, Math.min(...incomes));
  }

  return criteria;
}

/**
 * Extract a plain summary of the eligibility rules for the LLM prompt.
 *
 * @param {object} criteria structured criteria
 * @param {string[]} lines original bullets
 * @returns {string[]} human readable rule list
 */
function describeCriteria(criteria, lines) {
  const described = [];
  const income = criteria.min_monthly_income;
  if (income !== null) {
    described.push(`Minimum monthly income of INR ${income}`);
  }
  if (criteria.min_credit_score !== null) {
    described.push(`Minimum credit score of ${criteria.min_credit_score}`);
  }
  if (criteria.min_age !== null || criteria.max_age !== null) {
    const min = criteria.min_age === null ? 'any' : criteria.min_age;
    const max = criteria.max_age === null ? 'no upper limit' : criteria.max_age;
    described.push(`Applicant age between ${min} and ${max} years`);
  }
  if (criteria.min_employment_years !== null) {
    described.push(`At least ${criteria.min_employment_years} years of work experience`);
  }
  if (criteria.required_employment_statuses.length) {
    described.push(
      `Employment status must be one of: ${criteria.required_employment_statuses.join(', ')}`,
    );
  }
  (lines || []).forEach((line) => {
    const cleaned = cleanText(line);
    if (cleaned && described.length < 12) {
      described.push(cleaned);
    }
  });
  return described;
}

module.exports = {
  EMPLOYMENT_STATUSES,
  describeCriteria,
  detectEmploymentStatus,
  emptyCriteria,
  parseEligibilityLine,
  parseEligibilityLines,
};
