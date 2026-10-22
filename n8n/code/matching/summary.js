/**
 * Entry point: summarise the matching run.
 *
 * The statistics of the individual steps are collected into one document, so
 * the run can be reported to the caller and stored in the `matching_runs`
 * table.  This is what turns the optimisation from a claim into a
 * measurement.
 */

const { unwrapAll } = require('../lib/items');
const { itemsOf } = require('../lib/nodes');
const { NODES } = require('./nodes');
const { sqlLiteral } = require('./apply');

/**
 * Collect the statistics of the run.
 *
 * @param {object[]} items the result of the last database write
 * @returns {object[]} a single item holding the summary
 */
function run(items) {
  const written = unwrapAll(items);
  const last = written[written.length - 1] || {};

  const fast = itemsOf(NODES.fast);
  const fastStatistics = fast.length && fast[0].statistics ? fast[0].statistics : {};
  const applied = itemsOf(NODES.applied);
  const appliedStatistics = applied.length && applied[0].statistics ? applied[0].statistics : {};
  const planned = itemsOf(NODES.planned);
  const plan = planned[0] || { statistics: {} };
  const validated = itemsOf(NODES.validated);
  const request = validated[0] || {};
  const fetched = itemsOf(NODES.products);
  const fetch = fetched[0] || {};

  const summary = {
    batch_id: request.batch_id || null,
    started_at: request.requested_at || null,
    applicants: plan.statistics.applicants || 0,
    products: plan.statistics.products || 0,
    candidate_pairs: plan.statistics.candidate_pairs || 0,
    evaluated_pairs: fastStatistics.decisions_total || 0,
    decisions_written:
      (fastStatistics.decisions_total || 0) + (appliedStatistics.external_updates || 0),
    matches_written:
      (fastStatistics.matches_total || 0) + (appliedStatistics.eligible_total || 0),
    external_updates: appliedStatistics.external_updates || 0,
    payload_bytes:
      (fast.length ? fast[0].payload_bytes || 0 : 0) +
      (applied.length ? applied[0].payload_bytes || 0 : 0),
    fetch_ms: Number(fetch.fetch_ms || 0),
    rules_ms: plan.statistics.rules_ms || 0,
    persist_ms: Number(last.persist_ms || 0),
    external_ms: appliedStatistics.external_ms || 0,
    llm_requests: appliedStatistics.llm_requests || 0,
    llm_verdicts: appliedStatistics.llm_verdicts || 0,
    llm_unparsed: appliedStatistics.llm_unparsed || 0,
    prompt_tokens: appliedStatistics.prompt_tokens || 0,
    completion_tokens: appliedStatistics.completion_tokens || 0,
  };

  // The names the earlier reports used, so a comparison stays possible.
  summary.pairs_total = plan.statistics.pairs_total || 0;
  summary.pairs_eligible = plan.statistics.pairs_eligible || 0;
  summary.pairs_likely = plan.statistics.pairs_likely || 0;
  summary.pairs_ineligible = plan.statistics.pairs_ineligible || 0;
  summary.pairs_needing_llm = plan.statistics.pairs_needing_llm || 0;
  summary.distinct_decisions = plan.statistics.distinct_decisions || 0;
  summary.distinct_profiles = plan.statistics.distinct_profiles || 0;
  summary.matches_total = summary.matches_written;
  summary.matches_eligible = summary.matches_written;
  summary.matches_likely = fastStatistics.review_total || 0;
  summary.pairs_rejected = plan.statistics.rejected_pairs || 0;

  return [
    {
      json: {
        statistics: summary,
        run_sql: sqlLiteral([summary]),
      },
    },
  ];
}

module.exports = { run };
