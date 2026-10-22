/**
 * References to other nodes of the workflow.
 *
 * A few steps of Workflow B need the output of an earlier node that is not
 * directly connected to them - the applicants, the products, the evaluated
 * pairs and the cached verdicts.  n8n exposes them through the
 * `$('Node Name')` accessor; the names are injected by the build script from
 * the workflow template, so the code and the workflow can never drift apart.
 *
 * The placeholders below are replaced with the real node names when the
 * workflow is built (`scripts/build_workflows.py`).
 */

const NODES = {
  /** Node that validated the request and read the batch id. */
  validated: '__NODE__:validated',
  /** Node that read the applicants of the batch. */
  applicants: '__NODE__:applicants',
  /** Node that read the active loan products. */
  products: '__NODE__:products',
  /** Node that evaluated the candidate pairs with the rule engine. */
  pairs: '__NODE__:pairs',
  /** Node that read the previously cached LLM verdicts from the database. */
  cached: '__NODE__:cached',
  /** Node that produced the qualitative checks that still have to be asked. */
  planned: '__NODE__:planned',
  /** Node that selected the checks that are not cached yet. */
  selected: '__NODE__:selected',
  /** Node that parsed the answers of the LLM. */
  answered: '__NODE__:answered',
  /** Node that built the first persistence payload. */
  fast: '__NODE__:fast',
  /** Node that turned the answers into the updates of the affected pairs. */
  applied: '__NODE__:applied',
};

module.exports = { NODES };
