/**
 * Entry point: evaluate every candidate pair with the deterministic rules.
 *
 * The applicants and the active products are read from the two nodes that
 * fetched them and the candidate pairs are built here, so the criteria of a
 * lender travel through the workflow once per batch instead of once per
 * pair.
 *
 * Every pair is classified as `eligible`, `ineligible`, `likely` or
 * `needs_llm` and enriched with everything the later stages need:
 *
 *   reasons       - the decisive checks of the pair (the failures, the
 *                   missing facts and the requirements the lender does not
 *                   publish); the checks that pass are not carried around
 *   profile       - the qualitative profile of the product (cache key part 1)
 *   bucket        - the bucket of the applicant facts the profile refers to
 *   cache_key     - profile signature + bucket, the LLM cache key
 *
 * The pairs that do not pass the pre-filter are not evaluated by the rule
 * engine; they are rejected with the reason of the SQL stage, so the
 * decisions stay the same as they were.
 */

const { rowsOf } = require('../lib/nodes');
const { factBucket } = require('./facts');
const { buildProfile } = require('./profiles');
const { evaluatePair } = require('./rules');
const { canonicalise } = require('../lib/signature');
const { preFilter, rejectedPair } = require('./candidates');
const { NODES } = require('./nodes');
const { reviewCandidate } = require('./review');

/**
 * Keep the checks that explain the decision.
 *
 * A check that passes says nothing about the outcome, so it is dropped: the
 * payload that travels through the workflow only carries the failures, the
 * missing facts and the requirements the lender does not publish.
 *
 * @param {object[]} checks the checks of the rule engine
 * @returns {object[]} the decisive checks
 */
function decisiveChecks(checks) {
  return (checks || [])
    .filter((entry) => entry && entry.state && entry.state !== 'pass')
    .map((entry) => ({
      code: entry.code,
      state: entry.state,
      detail: entry.detail,
    }));
}

/**
 * Run the rule engine over every candidate pair.
 *
 * @returns {object[]} a single item holding the evaluated pairs
 */
function run() {
  const started = Date.now();
  const applicants = rowsOf(NODES.applicants, 'applicants');
  const products = rowsOf(NODES.products, 'products');

  const evaluated = [];
  const statistics = {
    applicants: applicants.length,
    products: products.length,
    pairs_total: 0,
    candidate_pairs: 0,
    rejected_pairs: 0,
    pairs_eligible: 0,
    pairs_likely: 0,
    pairs_ineligible: 0,
    pairs_needing_llm: 0,
  };

  applicants.forEach((applicant) => {
    if (!applicant || !applicant.user_id) {
      return;
    }
    // The evidence of the applicant is merged once, not once per lender.
    const user = {
      ...(applicant.eligibility_facts || {}),
      ...applicant,
    };
    products.forEach((product) => {
      if (!product || product.product_id === undefined || product.product_id === null) {
        return;
      }
      statistics.pairs_total += 1;

      const filter = preFilter(user, product);
      if (!filter.candidate) {
        if (!filter.rejected) {
          // The applicant data is missing, so the pair is not a decision.
          return;
        }
        statistics.rejected_pairs += 1;
        statistics.pairs_ineligible += 1;
        evaluated.push(rejectedPair(user, product, filter.reasons));
        return;
      }

      statistics.candidate_pairs += 1;
      const result = evaluatePair(user, product);

      if (result.status === 'eligible') statistics.pairs_eligible += 1;
      else if (result.status === 'ineligible') statistics.pairs_ineligible += 1;
      else if (result.status === 'needs_llm') statistics.pairs_needing_llm += 1;
      else statistics.pairs_likely += 1;

      const pair = {
        user_id: user.user_id,
        batch_id: user.batch_id || null,
        product_id: product.product_id,
        status: result.status,
        needs_llm: result.needs_llm,
        reasons: decisiveChecks(result.checks),
      };

      if (result.needs_llm) {
        // Only the pairs that are asked about need the profile and the
        // bucket, so they are the only ones that carry them.  Building the
        // profile and hashing the bucket is the most expensive part of the
        // evaluation, and it is wasted on every other pair.
        const profile = buildProfile(product, result.narrative);
        const bucket = factBucket(user, profile.facts, true);
        const bucketId = canonicalise(bucket);
        pair.profile_signature = profile.signature;
        pair.profile_rules = profile.rules;
        pair.profile_statuses = profile.statuses;
        pair.profile_facts = profile.facts;
        pair.fact_bucket = bucket;
        pair.bucket_id = bucketId;
        pair.cache_key = `${profile.signature}::${bucketId}`;
      }

      const review = reviewCandidate(user, product, result);
      if (review) {
        Object.assign(pair, review, {status: 'needs_llm', needs_llm: true});
        statistics.pairs_likely -= 1;
        statistics.pairs_needing_llm += 1;
      }
      evaluated.push(pair);
    });
  });

  statistics.evaluated_pairs = evaluated.length;
  statistics.rules_ms = Date.now() - started;

  // How much data had to travel through the workflow to build the pairs.
  statistics.fetch_bytes = JSON.stringify(applicants).length + JSON.stringify(products).length;

  return [
    {
      pairs: evaluated,
      statistics,
    },
  ];
}

module.exports = { run, decisiveChecks };
