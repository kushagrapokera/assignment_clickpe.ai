/**
 * Read the output of another node of the workflow.
 *
 * A few steps of the workflow need data that an earlier node produced but
 * that is not directly connected to them - the applicants, the products, the
 * evaluated pairs or the cached verdicts.  n8n exposes them through the
 * `$('Node Name')` accessor.
 *
 * The accessor throws when the node did not run in this execution, which is
 * normal: the qualitative stage is skipped when every decision is cached.
 * The helper therefore answers with an empty list instead of failing the run.
 *
 * @param {string} nodeName name of the node
 * @returns {object[]} the JSON payloads of that node
 */
function itemsOf(nodeName) {
  try {
    const source = $(nodeName);
    return source.all().map((item) => item.json);
  } catch (error) {
    // The node did not run in this execution.
    return [];
  }
}

/**
 * Read the rows of another node, whether they arrive one per item or as one
 * aggregated list.
 *
 * @param {string} nodeName name of the node
 * @param {string} key name of the field that holds the aggregated rows
 * @returns {object[]} the rows
 */
function rowsOf(nodeName, key) {
  const items = itemsOf(nodeName);
  if (!items.length) {
    return [];
  }
  const first = items[0];
  if (first && Object.prototype.hasOwnProperty.call(first, key)) {
    return Array.isArray(first[key]) ? first[key] : [];
  }
  return items;
}

module.exports = { itemsOf, rowsOf };
