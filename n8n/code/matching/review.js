/** Second opinion for every review case on review cases; never invent missing evidence. */
const { buildProfile } = require('./profiles');
const { factBucket } = require('./facts');
const { canonicalise } = require('../lib/signature');
function reviewCandidate(user, product, result) {
  if (result.status !== 'likely') return null;
  const profile = buildProfile(product);
  // Numeric constraints are checked locally; include policy evidence and employment
  // in the second opinion, including explicit nulls for missing requirements.
  const facts = [...new Set([...profile.facts, 'employment_status',
    ...result.checks.filter(c => c.state === 'unknown').flatMap(c => c.fields || [])])].sort();
  const bucket = factBucket(user, facts, true);
  const bucketId = canonicalise(bucket);
  const signature = `${profile.signature}:review-v2`;
  return { profile_signature: signature, profile_rules: profile.rules,
    profile_statuses: profile.statuses, profile_facts: facts, fact_bucket: bucket,
    bucket_id: bucketId, cache_key: `${signature}::${bucketId}`,
    evidence_incomplete: result.checks.some(c => c.state === 'unknown') };
}
module.exports = { reviewCandidate };
