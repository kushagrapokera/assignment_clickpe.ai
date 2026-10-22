/**
 * Entry point: combine the verdict payloads of the two branches.
 *
 * The qualitative stage has two branches: the LLM answered the questions,
 * or every decision was already cached.  Both produce the same shape, and
 * this node merges them into a single payload so the rest of the workflow
 * sees one item.
 */

/**
 * Combine the verdict payloads.
 *
 * @param {object[]} items the payloads of the branches
 * @returns {object[]} a single item
 */
function run(items) {
  const payloads = items.map((item) => (item && item.json) || item).filter(Boolean);

  const verdicts = [];
  const statistics = {
    llm_requests: 0,
    verdicts_parsed: 0,
    verdicts_unparsed: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
  };

  payloads.forEach((payload) => {
    (payload.verdicts || []).forEach((verdict) => {
      if (verdict && verdict.cache_key) {
        verdicts.push(verdict);
      }
    });
    const stats = payload.statistics || {};
    Object.keys(statistics).forEach((key) => {
      statistics[key] = (statistics[key] || 0) + (stats[key] || 0);
    });
  });

  const unique = new Map();
  verdicts.forEach((verdict) => unique.set(verdict.cache_key, verdict));
  const rows = Array.from(unique.values());

  return [
    {
      verdicts: rows,
      verdicts_sql: sqlLiteral(rows),
      statistics,
    },
  ];
}

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

module.exports = { run, sqlLiteral };
