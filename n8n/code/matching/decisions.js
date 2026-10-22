/**
 * The audit of every evaluated pair.
 *
 * A decision is the record of what the engine did with one pair: it is
 * stored for every pair, including the rejections and the pairs that wait
 * for a qualitative check, so the interface can show the applicant what was
 * decided and why.
 *
 * The decisions are compact on purpose.  They carry the identifiers, the
 * status and the reason codes with their explanation, and nothing else: the
 * full list of checks would multiply the size of the payload that travels
 * through the workflow by the number of checks per pair.
 */

/**
 * Build the decision of one evaluated pair.
 *
 * @param {object} pair evaluated pair
 * @param {object|null} verdict verdict of the qualitative stage
 * @returns {object} the decision
 */
function decisionOf(pair, verdict) {
  const qualitative = pair.status === 'needs_llm' || Boolean(pair.needs_llm);
  let status =
    pair.status === 'ineligible'
      ? 'ineligible'
      : pair.status === 'likely'
        ? 'review'
        : 'eligible';

  if (qualitative) {
    status = !verdict
      ? 'pending'
      : verdict.verdict === 'likely_eligible'
        ? 'eligible'
        : verdict.verdict === 'likely_ineligible'
          ? 'ineligible'
          : 'review';
  }

  const reasons =
    qualitative && verdict
      ? (verdict.reasons || []).map((reason) =>
          typeof reason === 'string'
            ? { code: 'QUALITATIVE_REASON', state: 'review', detail: reason }
            : reason,
        )
      : pair.reasons || [];

  return {
    batch_id: pair.batch_id,
    user_id: pair.user_id,
    product_id: pair.product_id,
    lane: qualitative ? 'qualitative' : 'rules',
    status,
    reasons: [ ...(pair.evidence_incomplete && verdict ? [...(pair.reasons || []), ...reasons] : reasons),
      ...((verdict && verdict.provider_errors) || []).map(detail => ({code:'PROVIDER_ERROR',state:'error',detail})) ],
    decided_by: qualitative ? 'llm' : 'rules',
    score: qualitative && verdict && verdict.score !== undefined ? verdict.score : null,
    llm_assessment:
      qualitative && verdict
        ? {
            verdict: verdict.verdict,
            score: verdict.score === undefined ? null : verdict.score,
            reasons: verdict.reasons || [],
            model: verdict.model || null,
            cache_key: pair.cache_key || null,
          }
        : null,
  };
}

module.exports = { decisionOf };
