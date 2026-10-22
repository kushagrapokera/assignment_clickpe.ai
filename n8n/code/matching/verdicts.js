/**
 * Entry point: read the answers of the LLM and turn them into cache entries.
 *
 * Every request that was sent to the LLM is answered with a JSON document
 * that contains one verdict per applicant bucket.  The verdicts are turned
 * into rows of the `llm_verdict_cache` table, together with the token usage
 * the model reported - that is what makes the cost of the run measurable.
 *
 * The verdicts are returned as a single item with a ready to use SQL
 * payload, so the database write is one statement instead of one statement
 * per verdict.
 */

const { unwrapAll } = require('../lib/items');
const { itemsOf } = require('../lib/nodes');
const { parseVerdicts } = require('./llm');
const { NODES } = require('./nodes');

/**
 * Read the payload of an LLM answer.
 *
 * The HTTP node delivers the response body under `response`, `data` or
 * `body` depending on its configuration, and the body is a string when the
 * response format is text.
 *
 * @param {object} item workflow item
 * @returns {object|string} the payload
 */
function payloadOf(item) {
  if (!item) {
    return null;
  }
  let payload = item;
  if (item.response !== undefined && item.response !== null) {
    payload = item.response;
  } else if (item.data !== undefined && item.data !== null) {
    payload = item.data;
  } else if (item.body !== undefined && item.body !== null) {
    payload = item.body;
  }
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch (error) {
      return payload;
    }
  }
  return payload;
}

/**
 * Read the answer text of an LLM response.
 *
 * @param {object} item workflow item
 * @returns {string} the raw answer
 */
function answerOf(item) {
  const payload = payloadOf(item);
  if (typeof payload === 'string') {
    return payload;
  }
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const choices = payload.choices || [];
  if (choices.length && choices[0] && choices[0].message) {
    return String(choices[0].message.content || '');
  }
  if (typeof payload.content === 'string') {
    return payload.content;
  }
  return '';
}

/**
 * Read the token usage the model reported.
 *
 * @param {object} item workflow item
 * @returns {object} the usage
 */
function usageOf(item) {
  const payload = payloadOf(item);
  if (payload && typeof payload === 'object' && payload.usage) {
    return payload.usage;
  }
  return {};
}

/**
 * Parse the answers and build the cache rows.
 *
 * @param {object[]} items the answers of the LLM
 * @returns {object[]} a single item holding the verdicts and their SQL payload
 */
function run(items) {
  const answers = unwrapAll(items);
  // The answers belong to the requests that were actually sent, which is
  // the subset the "Select Missing Checks" node produced.
  const sent = itemsOf(NODES.selected);
  const startedAt = sent.length && sent[0] && sent[0].asked_at;

  const verdicts = [];
  const statistics = {
    llm_requests: answers.length,
    verdicts_parsed: 0,
    verdicts_unparsed: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    external_ms: 0,
    provider_errors: [],
  };

  if (startedAt) {
    // How long the external stage took, from the moment the question was
    // asked until the answer was read.
    const asked = Date.parse(startedAt);
    if (Number.isFinite(asked)) {
      statistics.external_ms = Math.max(0, Date.now() - asked);
    }
  }

  answers.forEach((answer, index) => {
    const request = answer.request || sent[index] || {};
    const usage = usageOf(answer);
    statistics.provider_errors.push(...(answer.provider_errors || []));
    statistics.prompt_tokens += Number(usage.prompt_tokens || 0);
    statistics.completion_tokens += Number(usage.completion_tokens || 0);

    const parsed = parseVerdicts(answerOf(answer));
    if (!parsed.length) {
      statistics.verdicts_unparsed += 1;
      // A failed or empty answer must never drop the applicant: the pair
      // stays in the "needs verification" state instead.
      return;
    }

    statistics.verdicts_parsed += parsed.length;
    parsed.forEach((verdict, position) => {
      const buckets = request.buckets || [];
      // The model echoes the short label of the applicant; if it does not,
      // the answers are in the order of the request, so the position is used.
      let bucket = buckets.find(
        (entry) => entry.label && entry.label === String(verdict.bucket).trim(),
      );
      // Never assign another applicant by answer position.
      if (!bucket) {
        return;
      }
      verdicts.push({
        cache_key: bucket.cache_key,
        criteria_signature: request.profile_signature,
        user_bucket: bucket.bucket_id,
        verdict: verdict.verdict,
        score: verdict.score,
        reasons: verdict.reasons,
        model: (payloadOf(answer) || {}).model || null,
        provider_errors: answer.provider_errors || [],
        prompt_tokens: Number(usage.prompt_tokens || 0),
        completion_tokens: Number(usage.completion_tokens || 0),
      });
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

module.exports = { run, sqlLiteral, answerOf, payloadOf, usageOf };
