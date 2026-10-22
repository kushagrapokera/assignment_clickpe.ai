/**
 * Prompt construction and response parsing for the qualitative stage.
 *
 * The LLM is only asked about the parts of a lender's policy that cannot be
 * evaluated with a rule, and several applicants are asked about in a single
 * request.  That keeps the number of expensive calls proportional to the
 * number of *distinct decisions* instead of the number of pairs.
 */

const { describeBucket } = require('./facts');

/**
 * Maximum number of applicant buckets that are asked about in one request.
 *
 * The larger the batch, the fewer requests the LLM has to answer, which is
 * both cheaper and friendlier to the rate limit of the API.
 */
const MAX_BUCKETS_PER_REQUEST = 16;

const SYSTEM_PROMPT = [
  'You are a lending eligibility assistant for an Indian personal loan engine.',
  'You are given the qualitative eligibility rules of one lender and a list of applicant profiles.',
  'For every applicant profile decide whether the applicant is likely eligible under those rules.',
  'Use only supplied facts. Missing required evidence must remain uncertain; never infer residency, employer, experience, tenure or profits.',
  'Answer with STRICT JSON only, no prose and no markdown fences.',
  'Use this exact shape:',
  '{"verdicts":[{"bucket":"<id>","verdict":"likely_eligible"|"likely_ineligible"|"uncertain",',
  '"score":<number between 0 and 1>,"reasons":["<short reason>"]}]}',
].join(' ');

/**
 * Build the user prompt for one profile and a set of applicant buckets.
 *
 * @param {object} profile qualitative profile
 * @param {object[]} buckets applicant buckets with their `bucket_id`
 * @returns {string} prompt
 */
function buildPrompt(profile, buckets) {
  const lines = [];
  const rules = profile.profile_rules || profile.rules || [];
  const statuses = profile.profile_statuses || profile.statuses || [];
  lines.push('Lender eligibility rules:');
  if (rules.length) {
    rules.forEach((rule) => lines.push(`- ${rule}`));
  } else {
    lines.push('- The lender publishes no qualitative rule; answer from the general criteria.');
  }
  if (statuses.length) {
    lines.push(`Accepted employment statuses: ${statuses.join(', ')}.`);
  }
  lines.push('');
  lines.push('Applicant profiles to judge:');
  (buckets || []).forEach((bucket, index) => {
    // The applicants are identified by a short label.  Long identifiers are
    // rewritten by the model, which would break the mapping back to the
    // applicant, so the label is what the model has to echo.
    const label = bucket.label || `b${index + 1}`;
    lines.push(`- id=${label} | ${describeBucket(bucket.bucket)}`);
  });
  lines.push('');
  lines.push('Return one verdict per applicant id.');
  return lines.join('\n');
}

/**
 * Split the buckets of a profile into request sized chunks.
 *
 * @param {object[]} buckets applicant buckets
 * @returns {object[][]} chunks
 */
function chunkBuckets(buckets) {
  const chunks = [];
  for (let index = 0; index < (buckets || []).length; index += MAX_BUCKETS_PER_REQUEST) {
    chunks.push(buckets.slice(index, index + MAX_BUCKETS_PER_REQUEST));
  }
  return chunks;
}

/**
 * Parse the LLM answer into verdicts.
 *
 * The model sometimes wraps the JSON in markdown fences or adds a sentence,
 * so the payload is located first and parsed afterwards.
 *
 * @param {string} content raw model answer
 * @returns {object[]} verdicts
 */
function parseVerdicts(content) {
  if (typeof content !== 'string' || !content.trim()) {
    return [];
  }
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    text = fence[1].trim();
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return [];
  }
  const verdicts = Array.isArray(parsed) ? parsed : parsed.verdicts;
  if (!Array.isArray(verdicts)) {
    return [];
  }
  return verdicts
    .filter((verdict) => verdict && typeof verdict === 'object' && verdict.bucket)
    .map((verdict) => ({
      bucket: String(verdict.bucket),
      verdict: normaliseVerdict(verdict.verdict),
      score: typeof verdict.score === 'number' ? verdict.score : null,
      reasons: Array.isArray(verdict.reasons)
        ? verdict.reasons.map((reason) => String(reason).slice(0, 300))
        : [],
    }));
}

/**
 * Map the free text verdict of the model onto the internal vocabulary.
 *
 * @param {*} verdict raw verdict
 * @returns {string} `likely_eligible`, `likely_ineligible` or `uncertain`
 */
function normaliseVerdict(verdict) {
  const text = String(verdict || '').toLowerCase();
  if (text.includes('ineligib') || text.includes('not eligible') || text.includes('reject')) {
    return 'likely_ineligible';
  }
  if (text.includes('eligib') && !text.includes('ineligib')) {
    return 'likely_eligible';
  }
  return 'uncertain';
}

module.exports = {
  MAX_BUCKETS_PER_REQUEST,
  SYSTEM_PROMPT,
  buildPrompt,
  chunkBuckets,
  normaliseVerdict,
  parseVerdicts,
};
