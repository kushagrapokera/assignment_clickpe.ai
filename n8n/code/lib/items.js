/**
 * Helpers for the item shape n8n uses.
 *
 * A Code node receives items shaped like `{ json: {...}, pairedItem: ... }`,
 * while the business logic works with plain objects.  These helpers unwrap
 * the payload once, at the boundary, so the rest of the code never has to
 * care about the n8n item envelope.
 */

/**
 * Return the plain payload of an item.
 *
 * @param {object} item n8n item or plain object
 * @returns {object} payload
 */
function unwrap(item) {
  if (!item || typeof item !== 'object') {
    return {};
  }
  if (item.json && typeof item.json === 'object') {
    return item.json;
  }
  return item;
}

/**
 * Unwrap every item of a list.
 *
 * @param {object[]} items n8n items
 * @returns {object[]} plain payloads
 */
function unwrapAll(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map(unwrap);
}

module.exports = { unwrap, unwrapAll };
