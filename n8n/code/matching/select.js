/**
 * Entry point: select the qualitative checks that still have to be asked.
 *
 * The verdicts of previous runs are cached in the database, keyed by the
 * criteria profile and the applicant bucket.  Only the decisions that are
 * *not* cached yet are sent to the LLM, which is what keeps a repeated run
 * free of LLM calls.
 */

const { itemsOf } = require('../lib/nodes');
const { NODES } = require('./nodes');
const { buildRequest } = require('./decider');
const { buildBody } = require('./plan');

/**
 * Select the checks that are not cached yet.
 *
 * @returns {object[]} one item per LLM request
 */
function run() {
  const cached = itemsOf(NODES.cached);
  const cachedKeys = new Set(
    cached
      .filter((entry) => entry && entry.cache_key)
      .map((entry) => String(entry.cache_key)),
  );

  const planned = itemsOf(NODES.planned);
  const plan = planned[0] || { requests: [] };
  const requests = plan.requests || [];

  const missing = requests
    .map((request) => ({
      ...request,
      buckets: request.buckets.filter((bucket) => !cachedKeys.has(bucket.cache_key)),
    }))
    .filter((request) => request.buckets.length);

  if (!missing.length) {
    // Everything is cached.  A node that returns no item ends the branch, so
    // a marker is returned and the workflow skips the LLM.
    return [{ ask: false, buckets: [], profile_rules: [], profile_signature: '', asked_at: new Date().toISOString() }];
  }

  return missing.map((request) => ({
    ...request,
    ask: true,
    asked_at: new Date().toISOString(),
    body_json: buildBody(request),
    decider_body_json: JSON.stringify(buildRequest(request)),
  }));
}

module.exports = { run, itemsOf };
