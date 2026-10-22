/**
 * Applicant facts and how they are bucketed.
 *
 * The qualitative (LLM) stage must not look at every applicant one by one:
 * two applicants that look the same to the lender deserve the same verdict.
 *
 * This module answers two questions:
 *
 *   1. Which applicant attributes does a lender's narrative rule talk about?
 *   2. How can those attributes be bucketed so that similar applicants share
 *      one verdict?
 *
 * Bucketing is what turns "10 000 applicants x 17 products" LLM calls into
 * "a few hundred" LLM calls: the cache key is the profile signature plus the
 * bucket of the attributes the rule actually references.
 */

/** The applicant attributes the matcher knows about. */
const FACT_KEYS = [
  'employment_status',
  'credit_score',
  'monthly_income',
  'age',
  'employment_years',
  'current_employer_years', 'post_qualification_years', 'business_years',
  'profit_after_tax_last_two_years', 'residency_country', 'employer_group',
  'employment_type', 'employer_category', 'state', 'city', 'requested_tenure_months',
];

/** Canonical spelling of the employment statuses. */
const EMPLOYMENT_STATUSES = ['Salaried', 'Self-Employed', 'Business', 'Retired', 'Student'];

/**
 * Normalise a free text employment status.
 *
 * @param {string} value raw status
 * @returns {string} canonical status
 */
function normaliseEmploymentStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    return 'Unknown';
  }
  if (/self[\s-]?employ|self[\s-]?employ|proprietor|business/.test(text)) {
    return 'Self-Employed';
  }
  if (/salaried|employee|working/.test(text)) {
    return 'Salaried';
  }
  if (/retired|pension/.test(text)) {
    return 'Retired';
  }
  if (/student/.test(text)) {
    return 'Student';
  }
  if (/business|firm|partnership/.test(text)) {
    return 'Business';
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Detect which applicant attributes a rule refers to.
 *
 * @param {string[]} lines narrative eligibility rules
 * @returns {string[]} subset of {@link FACT_KEYS}
 */
function referencedFacts(lines) {
  const text = (lines || []).join(' ').toLowerCase();
  const facts = [];

  if (/employer|employment|salaried|self[- ]?employ|business|company|mnc|profession|job/.test(text)) {
    facts.push('employment_status');
  }
  if (/experience|years with|current company|work experience/.test(text)) {
    facts.push('employment_years');
  }
  if (/credit score|cibil/.test(text)) {
    facts.push('credit_score');
  }
  if (/income|salary|earnings|afford|repayment capacity/.test(text)) {
    facts.push('monthly_income');
  }
  if (/\bage\b|maturity/.test(text)) {
    facts.push('age');
  }
  if (/current company|current employer|years with/.test(text)) facts.push('current_employer_years');
  if (/qualification/.test(text)) facts.push('post_qualification_years');
  if (/business.*(?:years|history|existence)/.test(text)) facts.push('business_years');
  if (/profit|\bpat\b/.test(text)) facts.push('profit_after_tax_last_two_years');
  if (/residen/.test(text)) facts.push('residency_country');
  if (/employer group|employees? of/.test(text)) facts.push('employer_group');
  if (/permanent/.test(text)) facts.push('employment_type');
  if (/mnc|employer category|public compan|private organi/.test(text)) facts.push('employer_category');
  if (/\bstate\b|madhya pradesh/.test(text)) facts.push('state');
  if (/\bcity\b|cities|location/.test(text)) facts.push('city');
  if (/maturity/.test(text)) facts.push('requested_tenure_months');
  return facts.filter((fact) => FACT_KEYS.includes(fact));
}

/**
 * Bucket one applicant attribute.
 *
 * Buckets are deliberately coarse: lenders work with bands, not with exact
 * rupee amounts, and coarse buckets are what makes the cache effective.
 *
 * @param {string} key attribute name
 * @param {*} value raw value
 * @returns {*} bucketed value
 */
function bucketValue(key, value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  switch (key) {
    case 'employment_status':
      return normaliseEmploymentStatus(value);
    case 'credit_score': {
      const score = Number(value);
      return Number.isFinite(score) ? Math.floor(score / 50) * 50 : null;
    }
    case 'monthly_income': {
      const income = Number(value);
      return Number.isFinite(income) ? Math.floor(income / 5000) * 5000 : null;
    }
    case 'age': {
      const age = Number(value);
      return Number.isFinite(age) ? Math.floor(age / 5) * 5 : null;
    }
    case 'employment_years': {
      const years = Number(value);
      return Number.isFinite(years) ? Math.floor(years) : null;
    }
    default:
      return value;
  }
}

/**
 * Build the bucket of an applicant for a set of referenced facts.
 *
 * @param {object} user applicant
 * @param {string[]} facts referenced attributes
 * @returns {object} bucket
 */
function factBucket(user, facts, exact = false) {
  const bucket = {};
  (facts || []).forEach((fact) => {
    const value = user ? user[fact] : null;
    const numericFacts = ['credit_score','monthly_income','age','employment_years','current_employer_years','post_qualification_years','business_years','requested_tenure_months'];
    bucket[fact] = exact ? (value == null || value === '' ? null : numericFacts.includes(fact) && Number.isFinite(Number(value)) ? Number(value) : value) : bucketValue(fact, value);
  });
  return bucket;
}

/**
 * Render a bucket in a human readable way for the LLM prompt.
 *
 * @param {object} bucket bucketed applicant facts
 * @returns {string} readable summary
 */
function describeBucket(bucket) {
  const parts = [];
  Object.keys(bucket || {})
    .sort()
    .forEach((key) => {
      const value = bucket[key];
      if (value === null || value === undefined) {
        parts.push(`${key}: unknown`);
        return;
      }
      if (key === 'credit_score') {
        parts.push(`credit score: ${value}`);
        return;
      }
      if (key === 'monthly_income') {
        parts.push(`monthly income: INR ${value}`);
        return;
      }
      if (key === 'age') {
        parts.push(`age: ${value}`);
        return;
      }
      if (key === 'employment_years') {
        parts.push(`work experience: ${value} year(s)`);
        return;
      }
      parts.push(`${key}: ${value}`);
    });
  return parts.join(', ');
}

module.exports = {
  EMPLOYMENT_STATUSES,
  FACT_KEYS,
  bucketValue,
  describeBucket,
  factBucket,
  normaliseEmploymentStatus,
  referencedFacts,
};
