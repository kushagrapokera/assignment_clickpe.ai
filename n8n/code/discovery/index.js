/**
 * Entry point: turn the crawled pages into canonical loan products.
 *
 * The input items are the merge of the source registry and the HTTP
 * response, so every item carries both the source metadata and the page
 * markup:
 *
 *   { source_id, url, extractor, fingerprint, html }
 *
 * A page is only extracted when its content fingerprint matches the source
 * it was fetched for.  That keeps a renamed or redirected page from
 * silently polluting the product catalogue.
 */

const { unwrapAll } = require('../lib/items');
const { buildProduct } = require('../lib/product');
const { cleanText } = require('../lib/text');
const registry = require('./registry');
const SOURCES = require('virtual:sources.json');

/**
 * Read the page markup out of an item, whatever the HTTP node called it.
 *
 * @param {object} item workflow item
 * @returns {string} page markup
 */
function readHtml(item) {
  const candidates = [item.html, item.data, item.body, item.response];
  for (let index = 0; index < candidates.length; index += 1) {
    const value = candidates[index];
    if (typeof value === 'string' && value.length) {
      return value;
    }
  }
  return '';
}

/**
 * Find the source a page belongs to by matching its content fingerprint.
 *
 * Used as a fallback when the workflow could not associate a response with
 * its source (for example when the merge was misaligned).
 *
 * @param {string} html page markup
 * @returns {object|null} source metadata
 */
function detectSource(html) {
  const configured = SOURCES && Array.isArray(SOURCES.sources) ? SOURCES.sources : [];
  for (let index = 0; index < configured.length; index += 1) {
    const source = configured[index];
    if (source.enabled === false) {
      continue;
    }
    if (source.fingerprint && html.indexOf(source.fingerprint) !== -1) {
      return source;
    }
    if (source.site && html.toLowerCase().indexOf(String(source.site).toLowerCase()) !== -1) {
      return source;
    }
  }
  return null;
}

/**
 * Normalise the source metadata of a workflow item.
 *
 * The merge node hands over the registry fields under their own names
 * (`source_id`, `source_name`, ...), while the extractors expect the shape
 * used by the registry file (`id`, `name`, ...).
 *
 * @param {object} item workflow item payload
 * @returns {object} normalised source metadata
 */
function toSource(item) {
  return {
    id: item.source_id || item.id || null,
    name: item.source_name || item.name || null,
    publisher: item.publisher || item.source_publisher || null,
    publisher_name: item.publisher_name || item.source_publisher_name || null,
    site: item.site || null,
    url: item.url || item.source_url || null,
    extractor: item.extractor || null,
    strategy: item.strategy || item.source_strategy || null,
    fingerprint: item.fingerprint || null,
  };
}

/**
 * Check that the fetched page really belongs to the source it was fetched for.
 *
 * @param {string} html page markup
 * @param {object} source source metadata
 * @returns {boolean} true when the page matches the source
 */
function matchesSource(html, source) {
  if (!source) {
    return false;
  }
  if (source.fingerprint) {
    return html.indexOf(source.fingerprint) !== -1;
  }
  if (source.site) {
    return html.toLowerCase().indexOf(String(source.site).toLowerCase()) !== -1;
  }
  return true;
}

/**
 * Extract the products of every crawled page.
 *
 * @param {object[]} items merged source + page items
 * @returns {object[]} one item per discovered product
 */
function run(items) {
  const products = [];
  const problems = [];
  // Every crawled source is reported, even when it produced no product, so
  // the deactivation sweep knows which sources were visited.
  const visited = new Map();

  unwrapAll(items).forEach((item) => {
    const html = readHtml(item);
    let source = toSource(item);

    if (source.id) {
      visited.set(source.id, {
        source_id: source.id,
        source_name: source.name,
        source_publisher: source.publisher_name || source.publisher,
        source_publisher_id: source.publisher,
        products: visited.get(source.id) ? visited.get(source.id).products : 0,
      });
    }

    if (!html) {
      problems.push({ source_id: source.id, reason: 'empty response body' });
      return;
    }

    // Fall back to the content fingerprint when the source metadata was lost.
    if (!source.id) {
      source = detectSource(html) || source;
    }

    if (!matchesSource(html, source)) {
      problems.push({
        source_id: source.id,
        reason: 'content fingerprint did not match the configured source',
      });
      return;
    }

    const extractor = registry.getExtractor(source.extractor) || registry.detectExtractor(html);
    if (!extractor) {
      problems.push({
        source_id: source.id,
        reason: `no extractor for "${source.extractor}"`,
      });
      return;
    }

    const extracted = extractor.extract(html, source);
    if (source.id && visited.has(source.id)) {
      visited.get(source.id).products += extracted.length;
    }
    extracted.forEach((product) => {
      product.source_name = source.name || null;
      product.source_publisher = source.publisher_name || source.publisher || null;
      product.source_publisher_id = source.publisher || null;
      product.source_strategy = source.strategy || null;
      product.crawled_at = new Date().toISOString();
      products.push(product);
    });
  });

  // Sources that were crawled but produced no product are reported as
  // markers, so the sweep can tell "the site removed the product" apart
  // from "the source was not crawled at all".
  visited.forEach((entry) => {
    if (entry.products === 0) {
      products.push({
        source_marker: true,
        source_id: entry.source_id,
        source_name: entry.source_name,
        source_publisher: entry.source_publisher,
        source_publisher_id: entry.source_publisher_id,
      });
    }
  });

  // Problems are surfaced as items so a failed crawl is visible in the
  // workflow instead of silently producing zero products.  The field is not
  // called `error` because n8n reserves that key on output items.
  problems.forEach((problem) => {
    products.push({
      product_error: true,
      source_id: problem.source_id,
      crawl_error: problem.reason,
      product_name: cleanText(`crawl failed for ${problem.source_id}`),
    });
  });

  return products;
}

module.exports = { run, matchesSource, readHtml, toSource };
