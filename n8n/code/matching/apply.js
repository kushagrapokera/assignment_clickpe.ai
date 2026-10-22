/**
 * Building the decisions and the matches of a run.
 *
 * The two kinds of results are kept apart on purpose:
 *
 *   `matching_decisions` holds the audit of *every* pair, with the reason
 *   codes and their explanation.
 *   `matches` holds the confirmed eligibility only.
 *
 * A pair that needs more information is a decision, not a match: storing it
 * twice would duplicate the largest population of a run for no benefit.
 */

/** Number of decisions per database statement. */
const CHUNK_SIZE = 1000;

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
 * Turn one decision into a match.
 *
 * Only a confirmed eligibility becomes a match.  A rejection and a request
 * for missing information stay in the audit.
 *
 * @param {object} decision decision of a pair
 * @returns {object|null} the match or null
 */
function toMatch(decision) {
  if (!decision || decision.status !== 'eligible') {
    return null;
  }
  return {
    user_id: decision.user_id,
    product_id: decision.product_id,
    batch_id: decision.batch_id,
    status: 'eligible',
    decided_by: decision.decided_by,
    score: decision.score,
    reasons: decision.reasons,
    llm_assessment: decision.llm_assessment,
  };
}

/**
 * Collect the verdicts of a run into a lookup table.
 *
 * @param {object[]} cached the verdicts of previous runs
 * @param {object[]} fresh the verdicts that were just received
 * @returns {Map<string, object>} the verdicts, keyed by cache key
 */
function verdictMap(cached, fresh) {
  const verdicts = new Map();
  (cached || []).forEach((entry) => {
    if (entry && entry.cache_key) {
      verdicts.set(String(entry.cache_key), entry);
    }
  });
  (fresh || []).forEach((entry) => {
    if (entry && entry.cache_key) {
      verdicts.set(String(entry.cache_key), entry);
    }
  });
  return verdicts;
}

/**
 * Split a list into chunks that fit into one database statement.
 *
 * @param {object[]} values the values
 * @param {number} size the size of one chunk
 * @returns {object[][]} the chunks
 */
function chunkValues(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/**
 * Build the payload of the persistence statements.
 *
 * @param {object[]} decisions the decisions of the run
 * @returns {{decisions_sql: string, matches_sql: string, decision_count: number, match_count: number, payload_bytes: number}} the payload
 */
function buildPayload(decisions) {
  const matches = decisions.map(toMatch).filter(Boolean);
  const decisionsSql = sqlLiteral(decisions);
  const matchesSql = sqlLiteral(matches);
  return {
    decisions_sql: decisionsSql,
    matches_sql: matchesSql,
    decision_count: decisions.length,
    match_count: matches.length,
    payload_bytes: decisionsSql.length + matchesSql.length,
  };
}

module.exports = {
  CHUNK_SIZE,
  buildPayload,
  chunkValues,
  sqlLiteral,
  toMatch,
  verdictMap,
};
