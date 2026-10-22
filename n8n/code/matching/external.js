/**
 * Entry point: apply the answers of the qualitative stage.
 *
 * Only the pairs that were actually asked about are touched again.  The
 * other pairs keep the decision of the first persistence pass, so a run with
 * a handful of external answers does not rewrite the whole batch.
 *
 * A pair whose answer could not be obtained stays a request for missing
 * information: a provider that fails never turns into an approval.
 */

const { itemsOf } = require('../lib/nodes');
const { decisionOf } = require('./decisions');
const { buildPayload, chunkValues, verdictMap, CHUNK_SIZE } = require('./apply');
const { NODES } = require('./nodes');

/**
 * Build the updates of the affected pairs.
 *
 * @returns {object[]} one item per chunk
 */
function run() {
  const pairPayload = itemsOf(NODES.pairs)[0] || {};
  const pairs = Array.isArray(pairPayload.pairs) ? pairPayload.pairs : [];
  const answered = itemsOf(NODES.answered)[0] || {};
  const fresh = Array.isArray(answered.verdicts) ? answered.verdicts : [];
  const verdicts = verdictMap(itemsOf(NODES.cached), fresh);

  const freshKeys = new Set(
    fresh.filter((entry) => entry && entry.cache_key).map((entry) => String(entry.cache_key)),
  );

  const affected = pairs.filter(
    (pair) =>
      pair &&
      pair.user_id &&
      pair.product_id &&
      pair.needs_llm &&
      pair.cache_key &&
      freshKeys.has(String(pair.cache_key)),
  );

  const decisions = affected.map((pair) =>
    decisionOf(pair, verdicts.get(String(pair.cache_key))),
  );

  // A pair that was asked about but never answered is a request for missing
  // information, never a pending state that never ends.
  const answeredKeys = new Set(affected.map((pair) => String(pair.cache_key)));
  pairs
    .filter(
      (pair) =>
        pair &&
        pair.user_id &&
        pair.product_id &&
        pair.needs_llm &&
        pair.cache_key &&
        !answeredKeys.has(String(pair.cache_key)),
    )
    .forEach((pair) => {
      if (verdicts.has(String(pair.cache_key))) {
        return;
      }
      decisions.push({
        batch_id: pair.batch_id,
        user_id: pair.user_id,
        product_id: pair.product_id,
        lane: 'qualitative',
        status: 'review',
        reasons: [
          {
            code: 'QUALITATIVE_UNANSWERED',
            state: 'review',
            detail:
              'The qualitative check could not be completed, a manual review is required',
          },
        ],
        decided_by: 'llm',
        score: null,
        llm_assessment: null,
      });
    });
  for (const decision of decisions) {
    if (decision.reasons.some(reason => reason.code === 'QUALITATIVE_UNANSWERED')) {
      decision.reasons.push(...((answered.statistics || {}).provider_errors || []).map(detail => ({code:'PROVIDER_ERROR',state:'error',detail})));
    }
  }

  const statistics = {
    external_updates: decisions.length,
    eligible_total: decisions.filter((decision) => decision.status === 'eligible').length,
    ineligible_total: decisions.filter((decision) => decision.status === 'ineligible').length,
    review_total: decisions.filter((decision) => decision.status === 'review').length,
    llm_requests: (answered.statistics || {}).llm_requests || 0,
    llm_verdicts: (answered.statistics || {}).verdicts_parsed || 0,
    llm_unparsed: (answered.statistics || {}).verdicts_unparsed || 0,
    prompt_tokens: (answered.statistics || {}).prompt_tokens || 0,
    completion_tokens: (answered.statistics || {}).completion_tokens || 0,
    external_ms: (answered.statistics || {}).external_ms || 0,
  };

  const chunks = chunkValues(decisions, CHUNK_SIZE);
  if (!chunks.length) {
    const payload = buildPayload([]);
    return [
      {
        decisions_sql: payload.decisions_sql,
        matches_sql: payload.matches_sql,
        decision_count: 0,
        match_count: 0,
        payload_bytes: payload.payload_bytes,
        is_last: true,
        persist_started_at: new Date().toISOString(),
        statistics,
      },
    ];
  }

  return chunks.map((chunk, index) => {
    const payload = buildPayload(chunk);
    return {
      decisions_sql: payload.decisions_sql,
      matches_sql: payload.matches_sql,
      decision_count: payload.decision_count,
      match_count: payload.match_count,
      payload_bytes: payload.payload_bytes,
      is_last: index === chunks.length - 1,
      persist_started_at: new Date().toISOString(),
      statistics,
    };
  });
}

module.exports = { run };
