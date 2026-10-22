/**
 * Collapses duplicate products.
 *
 * The same lender is often described on several pages: Bajaj publishes a
 * personal loan page plus a page per purpose (travel, wedding, medical,
 * ...).  Every one of those pages describes the *same* underwriting rules,
 * so keeping them as separate products would fill the catalogue - and every
 * email - with rows that are indistinguishable to an applicant.
 *
 * This module therefore groups the extracted products by lender and merges
 * the groups whose criteria do not *conflict*.  A conflict means that two
 * products of the same lender publish different values for the same
 * criterion; those are genuinely different products and stay separate.
 *
 * Merging also fills gaps: a field that only the main page publishes (for
 * example the maximum age) is inherited by the canonical product, so the
 * merged entry is more complete than any single page.
 */

const { criteriaSignature } = require('../lib/signature');
const { cleanText } = require('../lib/text');

/** The criteria fields that are compared when two products are merged. */
const CRITERIA_FIELDS = [
  'min_age',
  'max_age',
  'min_credit_score',
  'max_credit_score',
  'min_monthly_income',
  'max_monthly_income',
  'min_employment_years',
  'min_loan_amount',
  'max_loan_amount',
  'min_tenure_months',
  'max_tenure_months',
];

/**
 * Turn a value into a file and key friendly slug.
 *
 * @param {string} value raw value
 * @returns {string} slug
 */
function slug(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the group key of a product.
 *
 * Products are grouped by publisher *and* lender: two different publishers
 * may offer loans under the same brand name, and those are not duplicates.
 *
 * @param {object} product extracted product
 * @returns {string} group key
 */
function groupKey(product) {
  const publisher = product.source_publisher_id || product.source_publisher || 'unknown';
  const provider = cleanText(product.provider).toLowerCase() || 'unknown';
  return `${publisher}::${provider}`;
}

/**
 * List the criteria fields on which two products disagree.
 *
 * A field that is missing on one side is not a conflict - it is a gap that
 * the merge can fill.
 *
 * @param {object} first product
 * @param {object} second product
 * @returns {string[]} conflicting field names
 */
function conflictingFields(first, second) {
  const conflicts = [];
  CRITERIA_FIELDS.forEach((field) => {
    const left = first[field];
    const right = second[field];
    if (left === null || left === undefined || right === null || right === undefined) {
      return;
    }
    if (left !== right) {
      conflicts.push(field);
    }
  });
  const leftStatus = (first.required_employment_statuses || []).slice().sort().join('|');
  const rightStatus = (second.required_employment_statuses || []).slice().sort().join('|');
  if (leftStatus !== rightStatus) {
    conflicts.push('required_employment_statuses');
  }
  return conflicts;
}

/**
 * Count how many criteria a product actually publishes.
 *
 * @param {object} product product
 * @returns {number} number of known criteria
 */
function completeness(product) {
  let known = 0;
  CRITERIA_FIELDS.forEach((field) => {
    if (product[field] !== null && product[field] !== undefined) {
      known += 1;
    }
  });
  if ((product.required_employment_statuses || []).length) {
    known += 1;
  }
  return known;
}

/**
 * Pick the product that represents the group.
 *
 * The most complete product wins; when two are equally complete the most
 * general name wins, which is the shortest one ("Bajaj Finance Personal
 * Loan" over "Bajaj Finance Personal Loan for Travel").
 *
 * @param {object[]} group products of one group
 * @returns {object} canonical product
 */
function pickCanonical(group) {
  return group.slice().sort((first, second) => {
    const byCompleteness = completeness(second) - completeness(first);
    if (byCompleteness !== 0) {
      return byCompleteness;
    }
    const byName = cleanText(first.product_name).length - cleanText(second.product_name).length;
    if (byName !== 0) {
      return byName;
    }
    return cleanText(first.source_id).localeCompare(cleanText(second.source_id));
  })[0];
}

/**
 * Merge the criteria of a group into the canonical product.
 *
 * @param {object} canonical canonical product
 * @param {object[]} group products of the group
 * @returns {object} merged criteria
 */
function mergeCriteria(canonical, group) {
  const criteria = Object.assign({}, canonical.criteria || {});

  CRITERIA_FIELDS.forEach((field) => {
    if (criteria[field] !== null && criteria[field] !== undefined) {
      return;
    }
    const value = group
      .map((product) => product[field])
      .find((candidate) => candidate !== null && candidate !== undefined);
    if (value !== undefined) {
      criteria[field] = value;
    }
  });

  const statuses = [];
  group.forEach((product) => {
    (product.required_employment_statuses || []).forEach((status) => {
      if (!statuses.includes(status)) {
        statuses.push(status);
      }
    });
  });
  if (statuses.length) {
    criteria.required_employment_statuses = statuses.sort();
  }

  // The narrative rules of every page are kept, they are the evidence the
  // qualitative stage reasons about.
  const lines = [];
  group.forEach((product) => {
    const productLines = (product.criteria && product.criteria.eligibility_lines) || [];
    productLines.forEach((line) => {
      if (line && !lines.includes(line)) {
        lines.push(line);
      }
    });
  });
  if (lines.length) {
    criteria.eligibility_lines = lines;
  }

  const perEmployment = Object.assign({}, criteria.per_employment || {});
  group.forEach((product) => {
    const buckets = (product.criteria && product.criteria.per_employment) || {};
    Object.keys(buckets).forEach((status) => {
      const target = perEmployment[status] || {};
      const source = buckets[status] || {};
      Object.keys(source).forEach((field) => {
        if (
          (target[field] === null || target[field] === undefined) &&
          source[field] !== null &&
          source[field] !== undefined
        ) {
          target[field] = source[field];
        }
      });
      perEmployment[status] = target;
    });
  });
  if (Object.keys(perEmployment).length) {
    criteria.per_employment = perEmployment;
  }

  return criteria;
}

/**
 * Merge one group of products into a single canonical product.
 *
 * @param {object[]} group products of the group
 * @returns {object} canonical product with the merged data
 */
function mergeGroup(group) {
  const canonical = pickCanonical(group);
  const merged = Object.assign({}, canonical);
  const criteria = mergeCriteria(canonical, group);

  CRITERIA_FIELDS.forEach((field) => {
    const value = criteria[field];
    if (value !== null && value !== undefined) {
      merged[field] = value;
    }
  });
  if (criteria.required_employment_statuses) {
    merged.required_employment_statuses = criteria.required_employment_statuses;
  }

  const publisher = canonical.source_publisher_id || canonical.source_publisher || 'unknown';
  const provider = cleanText(canonical.provider) || 'unknown';
  merged.product_key = `${slug(publisher)}:${slug(provider)}`;
  merged.criteria = criteria;

  merged.variants = group
    .filter((product) => product !== canonical)
    .map((product) => ({
      product_name: product.product_name,
      source_id: product.source_id,
      source_url: product.source_url,
    }));
  if (!merged.variants.length) {
    merged.variants = [];
  }

  merged.raw = Object.assign({}, canonical.raw || {}, {
    variants: merged.variants,
    variant_count: merged.variants.length,
  });

  merged.criteria_signature = criteriaSignature({
    min_age: merged.min_age === undefined ? null : merged.min_age,
    max_age: merged.max_age === undefined ? null : merged.max_age,
    min_credit_score: merged.min_credit_score === undefined ? null : merged.min_credit_score,
    max_credit_score: merged.max_credit_score === undefined ? null : merged.max_credit_score,
    min_monthly_income:
      merged.min_monthly_income === undefined ? null : merged.min_monthly_income,
    max_monthly_income:
      merged.max_monthly_income === undefined ? null : merged.max_monthly_income,
    min_employment_years:
      merged.min_employment_years === undefined ? null : merged.min_employment_years,
    required_employment_statuses: merged.required_employment_statuses || [],
    min_loan_amount: merged.min_loan_amount === undefined ? null : merged.min_loan_amount,
    max_loan_amount: merged.max_loan_amount === undefined ? null : merged.max_loan_amount,
    min_tenure_months: merged.min_tenure_months === undefined ? null : merged.min_tenure_months,
    max_tenure_months: merged.max_tenure_months === undefined ? null : merged.max_tenure_months,
  });

  return merged;
}

/**
 * Collapse the extracted products into the canonical product catalogue.
 *
 * @param {object[]} products extracted products
 * @returns {{products: object[], collapsed: object[], groups: number}} result
 */
function collapseProducts(products) {
  const groups = new Map();
  (products || []).forEach((product) => {
    const key = groupKey(product);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(product);
  });

  const canonical = [];
  const collapsed = [];
  const usedKeys = new Set();

  /**
   * Reserve a product key, making it unique when it is already taken.
   *
   * Two products of the same lender on the same page would otherwise share
   * the key, because the key is built from the lender and the page.
   *
   * @param {string} key preferred key
   * @returns {string} a key that is not in use yet
   */
  const reserveKey = (key) => {
    if (!usedKeys.has(key)) {
      usedKeys.add(key);
      return key;
    }
    let suffix = 2;
    while (usedKeys.has(`${key}--${suffix}`)) {
      suffix += 1;
    }
    const unique = `${key}--${suffix}`;
    usedKeys.add(unique);
    return unique;
  };

  groups.forEach((group, key) => {
    const conflicts = [];
    for (let first = 0; first < group.length; first += 1) {
      for (let second = first + 1; second < group.length; second += 1) {
        conflictingFields(group[first], group[second]).forEach((field) => {
          if (!conflicts.includes(field)) {
            conflicts.push(field);
          }
        });
      }
    }

    if (group.length === 1 || conflicts.length) {
      // Nothing to merge, or the products genuinely differ: keep them, but
      // still give them a stable, name free key.
      group.forEach((product) => {
        const copy = Object.assign({}, product);
        const publisher = product.source_publisher_id || product.source_publisher || 'unknown';
        const provider = cleanText(product.provider) || 'unknown';
        copy.product_key = reserveKey(
          group.length === 1
            ? `${slug(publisher)}:${slug(provider)}`
            : `${slug(publisher)}:${slug(provider)}--${slug(product.source_id)}`,
        );
        copy.variants = [];
        copy.raw = Object.assign({}, product.raw || {}, { variants: [], variant_count: 0 });
        canonical.push(copy);
      });
      return;
    }

    const merged = mergeGroup(group);
    merged.product_key = reserveKey(merged.product_key);
    canonical.push(merged);
    collapsed.push({
      group: key,
      provider: merged.provider,
      merged_into: merged.product_key,
      canonical: merged.product_name,
      canonical_source_id: merged.source_id,
      variants: merged.variants.map((variant) => variant.product_name),
      variant_source_ids: merged.variants.map((variant) => variant.source_id),
      count: group.length,
    });
  });

  canonical.sort((first, second) =>
    cleanText(first.provider).localeCompare(cleanText(second.provider)),
  );

  return { products: canonical, collapsed, groups: groups.size };
}

module.exports = {
  CRITERIA_FIELDS,
  collapseProducts,
  conflictingFields,
  groupKey,
  mergeCriteria,
  mergeGroup,
  pickCanonical,
  slug,
};
