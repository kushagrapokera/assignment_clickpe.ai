/**
 * Entry point: the branch that is taken when every decision is cached.
 *
 * It produces the same payload as the node that reads the answers of the
 * LLM, so the two branches can be merged.
 */

/**
 * Build the empty verdict payload.
 *
 * @returns {object[]} a single item
 */
function run() {
  return [
    {
      verdicts: [],
      verdicts_sql: "'[]'",
      statistics: {
        llm_requests: 0,
        verdicts_parsed: 0,
        verdicts_unparsed: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
      },
    },
  ];
}

module.exports = { run };
