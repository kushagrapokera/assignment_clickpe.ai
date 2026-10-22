/** Decider adapter; keep the existing verdict/cache contract and LLM fallback. */
const { describeBucket } = require('./facts');
const VERDICTS = ['likely_eligible', 'likely_ineligible', 'uncertain'];

function buildRequest(request) {
  const questions = {};
  for (const bucket of request.buckets || []) {
    questions[bucket.label] = {
      type: 'choice',
      instructions: `Assess only applicant ${bucket.label}: ${describeBucket(bucket.bucket)}. Use only supplied facts. Missing required facts must result in uncertain; never infer employer, residency, or work history.`,
      criteria: {
        likely_eligible: 'Every applicable requirement is supported by the supplied facts.',
        likely_ineligible: 'A supplied fact explicitly violates an applicable requirement.',
        uncertain: 'Required facts are missing or eligibility cannot be established.',
      },
    };
  }
  return {
    model: 'strands-decider-2b',
    state: JSON.stringify({ eligibility_rules: request.profile_rules || [], accepted_employment_statuses: request.profile_statuses || [] }),
    questions,
  };
}

function normaliseResponse(response, request) {
  if (!response || response.error || !response.answers || !(request.buckets || []).length) return null;
  const verdicts = [];
  for (const bucket of request.buckets) {
    const answer = response.answers[bucket.label];
    if (!answer || answer.type !== 'choice' || !VERDICTS.includes(answer.choice)) return null;
    verdicts.push({
      bucket: bucket.label,
      verdict: answer.choice,
      score: null,
      reasons: [answer.choice === 'uncertain'
        ? 'Required facts are missing or eligibility could not be established; manual review is required'
        : `Decider classified the supplied profile as ${answer.choice}`],
    });
  }
  return {
    model: response.model || 'strands-decider-2b',
    choices: [{ message: { content: JSON.stringify({ verdicts }) } }],
    usage: { prompt_tokens: Number((response.usage || {}).input_tokens || 0), completion_tokens: Number((response.usage || {}).output_tokens || 0) },
  };
}

/** Attach the originating request so subset answers cannot shift applicants. */
function routeResponses(responses, requests) {
  return requests.map((request, index) => {
    const raw = responses[index] || {};
    const response = raw.resolved_response || normaliseResponse(raw, request);
    return response
      ? {...response, request, provider_errors: raw.provider_errors || [], fallback: false}
      : {...request, request, fallback: true};
  });
}

module.exports = { buildRequest, normaliseResponse, routeResponses };
