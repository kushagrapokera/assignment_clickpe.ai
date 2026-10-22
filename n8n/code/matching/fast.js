/**
 * Entry point: persist the decisions that do not need an external answer.
 *
 * This is the first and - when nothing is left to ask about - the only
 * persistence pass of a run:
 *
 *   * every pair is written to the audit,
 *   * the confirmed eligibilities are written to the matches,
 *   * the pairs that wait for a qualitative answer are written as `pending`.
 *
 * The pairs are split into chunks, so one statement stays small enough for
 * the database and the workflow never builds a single huge payload.
 */

const { itemsOf } = require('../lib/nodes');
const { decisionOf } = require('./decisions');
const { buildPayload, chunkValues, verdictMap, CHUNK_SIZE } = require('./apply');
const { NODES } = require('./nodes');

/**
 * Build the chunks of the first persistence pass.
 *
 * @returns {object[]} one item per chunk
 */
function run() {
  const pairPayload = itemsOf(NODES.pairs)[0] || {};
  const pairs = Array.isArray(pairPayload.pairs) ? pairPayload.pairs : [];
  const verdicts = verdictMap(itemsOf(NODES.cached), []);

  const decisions = pairs
    .filter((pair) => pair && pair.user_id && pair.product_id)
    .map((pair) =>
      decisionOf(pair, pair.cache_key ? verdicts.get(String(pair.cache_key)) : null),
    );

  const pending = pairs.filter(
    (pair) =>
      pair &&
      pair.needs_llm &&
      !(pair.cache_key && verdicts.has(String(pair.cache_key))),
  ).length;

  const chunks = chunkValues(decisions, CHUNK_SIZE);
  const statistics = {
    pairs_total: pairs.length,
    decisions_total: decisions.length,
    matches_total: decisions.filter((decision) => decision.status === 'eligible').length,
    review_total: decisions.filter((decision) => decision.status === 'review').length,
    ineligible_total: decisions.filter((decision) => decision.status === 'ineligible').length,
    pending_total: decisions.filter((decision) => decision.status === 'pending').length,
    pending_pairs: pending,
    verdicts_used: verdicts.size,
  };

  if (!chunks.length) {
    const payload = buildPayload([]);
    return [
      {
        decisions_sql: payload.decisions_sql,
        matches_sql: payload.matches_sql,
        decision_count: 0,
        match_count: 0,
        payload_bytes: payload.payload_bytes,
        pending_pairs: pending,
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
      pending_pairs: pending,
      is_last: index === chunks.length - 1,
      persist_started_at: new Date().toISOString(),
      statistics,
    };
  });
}

module.exports = { run };
