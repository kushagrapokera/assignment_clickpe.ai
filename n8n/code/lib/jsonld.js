/**
 * JSON-LD extraction.
 *
 * Modern lender pages embed schema.org markup (`FinancialProduct`,
 * `LoanOrCredit`) that describes the product far more reliably than the
 * rendered text.  Using it keeps the extractor stable when the page layout
 * changes.
 */

/**
 * Extract and parse every JSON-LD block of a document.
 *
 * @param {string} html raw markup
 * @returns {object[]} parsed JSON-LD objects (blocks may contain arrays)
 */
function extractJsonLd(html) {
  if (typeof html !== 'string') {
    return [];
  }
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let match = pattern.exec(html);
  while (match) {
    const raw = match[1].trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((entry) => {
          if (entry && typeof entry === 'object') {
            blocks.push(entry);
          }
        });
      } else if (parsed && typeof parsed === 'object') {
        blocks.push(parsed);
      }
    } catch (error) {
      // A malformed block is skipped, the rest of the page is still usable.
    }
    match = pattern.exec(html);
  }
  return blocks;
}

/**
 * Find the first JSON-LD block whose `@type` matches.
 *
 * @param {object[]} blocks parsed blocks
 * @param {string|string[]} types type or types to look for
 * @returns {object|null} matching block
 */
function findByType(blocks, types) {
  const wanted = Array.isArray(types) ? types : [types];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const type = block['@type'];
    const list = Array.isArray(type) ? type : [type];
    if (list.some((entry) => wanted.includes(entry))) {
      return block;
    }
  }
  return null;
}

/**
 * Read a `QuantitativeValue` style object into a number.
 *
 * @param {*} value raw value
 * @returns {number|null} numeric value
 */
function quantitative(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    const candidate = value.value !== undefined ? value.value : value;
    if (candidate && typeof candidate === 'object') {
      if (candidate.minValue !== undefined) {
        return quantitative(candidate.minValue);
      }
      if (candidate.maxValue !== undefined) {
        return quantitative(candidate.maxValue);
      }
      return null;
    }
    return quantitative(candidate);
  }
  return null;
}

/**
 * Read the numeric bounds of a schema.org value object.
 *
 * @param {*} value raw value
 * @returns {{min: number|null, max: number|null}} bounds
 */
function quantitativeRange(value) {
  if (!value || typeof value !== 'object') {
    return { min: null, max: null };
  }
  let min = null;
  let max = null;
  if (value.minValue !== undefined) {
    min = quantitative(value.minValue);
  }
  if (value.maxValue !== undefined) {
    max = quantitative(value.maxValue);
  }
  if (min === null && max === null && value.value !== undefined) {
    const nested = quantitativeRange(value.value);
    min = nested.min;
    max = nested.max;
  }
  return { min, max };
}

module.exports = {
  extractJsonLd,
  findByType,
  quantitative,
  quantitativeRange,
};
