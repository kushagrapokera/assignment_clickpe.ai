/**
 * Registry of discovery extractors.
 *
 * Each extractor knows how to turn one crawled page into canonical loan
 * products.  Adding a new site means writing a new extractor and listing it
 * in `n8n/sources/sources.json`; no workflow has to be edited.
 */

const bajaj = require('./bajaj');
const bankbazaar = require('./bankbazaar');

const EXTRACTORS = {
  bajaj,
  bankbazaar,
};

/**
 * Look up an extractor by name.
 *
 * @param {string} name extractor name
 * @returns {object|null} extractor module
 */
function getExtractor(name) {
  return EXTRACTORS[name] || null;
}

/**
 * Detect which extractor can handle a page when the caller does not know.
 *
 * @param {string} html page markup
 * @returns {string|null} extractor name
 */
function detectExtractor(html) {
  if (typeof html !== 'string') {
    return null;
  }
  if (/bankbazaar\.com/i.test(html) && /Apply Online for/i.test(html)) {
    return 'bankbazaar';
  }
  if (/bajajfinserv\.in/i.test(html) && /application\/ld\+json/i.test(html)) {
    return 'bajaj';
  }
  return null;
}

module.exports = {
  EXTRACTORS,
  detectExtractor,
  getExtractor,
};
