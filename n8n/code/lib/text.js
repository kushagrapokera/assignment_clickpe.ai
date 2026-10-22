/**
 * Text helpers shared by the discovery extractors.
 *
 * The crawl targets are server rendered HTML pages, so the extraction code
 * has to survive a fair amount of markup noise: HTML entities, non breaking
 * spaces, React comment markers and inline `<!-- -->` separators.
 */

/** Named HTML entities that regularly show up in the crawled pages. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rupee: '₹',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
};

/**
 * Decode the HTML entities that appear in the crawled markup.
 *
 * @param {string} value raw text
 * @returns {string} decoded text
 */
function decodeEntities(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (Number.isNaN(code) || code < 0 || code > 0x10ffff) {
        return match;
      }
      try {
        return String.fromCodePoint(code);
      } catch (error) {
        return match;
      }
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Remove script and style blocks, convert block level tags to line breaks and
 * strip every remaining tag.  The result is plain, human readable text.
 *
 * @param {string} html raw markup
 * @returns {string} text with one logical entry per line
 */
function htmlToText(html) {
  if (typeof html !== 'string') {
    return '';
  }
  let working = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  working = working.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  working = working.replace(/<!--[\s\S]*?-->/g, ' ');
  working = working.replace(/<br\s*\/?>/gi, '\n');
  working = working.replace(/<\/(p|div|li|tr|h[1-6]|section|ul|ol|td|th|table|summary)>/gi, '\n');
  working = working.replace(/<(p|div|li|tr|h[1-6]|section|ul|ol|td|th|table|summary)\b[^>]*>/gi, '\n');
  working = working.replace(/<[^>]+>/g, ' ');
  working = decodeEntities(working);
  working = working.replace(/[\u00a0\u2007\u202f]/g, ' ');
  return working;
}

/**
 * Collapse all whitespace runs into single spaces and trim the result.
 *
 * @param {string} value text to normalise
 * @returns {string} normalised text
 */
function normaliseWhitespace(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Normalise text and drop any residual React comment markers.
 *
 * @param {string} value text to clean
 * @returns {string} cleaned text
 */
function cleanText(value) {
  return normaliseWhitespace(decodeEntities(String(value || '')).replace(/<!--[\s\S]*?-->/g, ' '));
}

/**
 * Split a block of markup into the text of every list item.
 *
 * @param {string} html markup containing `li` elements
 * @returns {string[]} one cleaned string per list item
 */
function listItemTexts(html) {
  if (typeof html !== 'string') {
    return [];
  }
  const items = [];
  const pattern = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let match = pattern.exec(html);
  while (match) {
    const text = cleanText(htmlToText(match[1]));
    if (text) {
      items.push(text);
    }
    match = pattern.exec(html);
  }
  return items;
}

module.exports = {
  cleanText,
  decodeEntities,
  htmlToText,
  listItemTexts,
  normaliseWhitespace,
};
