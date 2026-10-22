/**
 * Entry point: build the work plan for the qualitative stage.
 *
 * This is where the optimisation happens.  The pairs that the rule engine
 * could not settle are reduced to the *distinct decisions*:
 *
 *   pair            -> (profile signature, applicant bucket)
 *   distinct keys   -> one LLM request
 *
 * With 10 000 applicants and 17 lenders the pipeline starts with 170 000
 * possible pairs; after the SQL pre-filter and the rule engine only a handful
 * of distinct decisions remain, and every applicant that lands in the same
 * bucket reuses the verdict cached for that key.
 *
 * The plan is emitted as a single item that also carries the statistics of
 * the run, so the workflow can report what happened.
 */

const { itemsOf } = require('../lib/nodes');
const { buildPrompt, chunkBuckets, SYSTEM_PROMPT } = require('./llm');
const { NODES } = require('./nodes');
const CONFIG = require('virtual:config.json');

/** The model used for the qualitative stage. */
const DEFAULT_MODEL = 'gemma4:31b';

/**
 * Escape a value so it can be embedded as a SQL string literal.
 *
 * @param {*} value value to serialise
 * @returns {string} SQL string literal
 */
function sqlLiteral(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `'${String(text).replace(/'/g, "''")}'`;
}

/**
 * Read the model name from the environment of the n8n instance.
 *
 * @returns {string} model name
 */
function modelName() {
  const configured = CONFIG && CONFIG.llm && CONFIG.llm.model;
  return configured ? String(configured) : DEFAULT_MODEL;
}

/**
 * Build the request body for the qualitative stage.
 *
 * @param {object} request planned request
 * @returns {string} the body as a JSON string
 */
function buildBody(request) {
  const body = {
    model: modelName(),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(request, request.buckets) },
    ],
    temperature: 0,
    stream: false,
    format: 'json',
    options: { temperature: 0, num_predict: 1024 },
  };
  return JSON.stringify(body);
}

/**
 * Build the LLM work plan.
 *
 * @returns {object[]} a single item holding the requests and the statistics
 */
function run() {
  const pairPayload = itemsOf(NODES.pairs)[0] || {};
  const pairs = Array.isArray(pairPayload.pairs) ? pairPayload.pairs : [];
  const evaluated = pairPayload.statistics || {};
  const pending = pairs.filter((pair) => pair && pair.needs_llm);

  // Group the pending pairs by cache key, then by profile.
  const byKey = new Map();
  pending.forEach((pair) => {
    if (!byKey.has(pair.cache_key)) {
      byKey.set(pair.cache_key, {
        cache_key: pair.cache_key,
        profile_signature: pair.profile_signature,
        profile_rules: pair.profile_rules,
        profile_statuses: pair.profile_statuses,
        profile_facts: pair.profile_facts,
        bucket: pair.fact_bucket,
        bucket_id: pair.bucket_id,
        pairs: 0,
      });
    }
    byKey.get(pair.cache_key).pairs += 1;
  });

  const byProfile = new Map();
  byKey.forEach((entry) => {
    if (!byProfile.has(entry.profile_signature)) {
      byProfile.set(entry.profile_signature, {
        profile_signature: entry.profile_signature,
        profile_rules: entry.profile_rules,
        profile_statuses: entry.profile_statuses,
        profile_facts: entry.profile_facts,
        buckets: [],
      });
    }
    byProfile.get(entry.profile_signature).buckets.push({
      bucket_id: entry.bucket_id,
      bucket: entry.bucket,
      cache_key: entry.cache_key,
      pairs: entry.pairs,
    });
  });

  const requests = [];
  byProfile.forEach((profile) => {
    const chunks = chunkBuckets(profile.buckets);
    chunks.forEach((chunk, index) => {
      chunk.forEach((bucket, position) => {
        bucket.label = `b${position + 1}`;
      });
      const request = {
        profile_signature: profile.profile_signature,
        profile_rules: profile.profile_rules,
        profile_statuses: profile.profile_statuses,
        profile_facts: profile.profile_facts,
        buckets: chunk,
        chunk_index: index,
        chunk_count: chunks.length,
        pairs_covered: chunk.reduce((total, bucket) => total + bucket.pairs, 0),
      };
      request.body_json = buildBody(request);
      requests.push(request);
    });
  });

  const statistics = {
    applicants: evaluated.applicants || 0,
    products: evaluated.products || 0,
    pairs_total: evaluated.pairs_total || pairs.length,
    candidate_pairs: evaluated.candidate_pairs || 0,
    rejected_pairs: evaluated.rejected_pairs || 0,
    pairs_eligible: evaluated.pairs_eligible || 0,
    pairs_likely: evaluated.pairs_likely || 0,
    pairs_ineligible: evaluated.pairs_ineligible || 0,
    pairs_needing_llm: evaluated.pairs_needing_llm || pending.length,
    rules_ms: evaluated.rules_ms || 0,
    fetch_bytes: evaluated.fetch_bytes || 0,
    distinct_decisions: byKey.size,
    distinct_profiles: byProfile.size,
    llm_requests: requests.length,
  };

  const cacheKeys = Array.from(byKey.keys());

  return [
    {
      requests,
      statistics,
      cache_keys: cacheKeys,
      cache_keys_sql: sqlLiteral(cacheKeys),
    },
  ];
}

module.exports = { run, buildBody, sqlLiteral, modelName };
