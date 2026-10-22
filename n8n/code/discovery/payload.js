/**
 * Entry point: build the payload that is written to PostgreSQL.
 *
 * The extracted products are validated, de-duplicated and collapsed: pages
 * of the same lender that describe the same underwriting rules become one
 * canonical product (the group members are kept as `variants`).  The
 * result is grouped per source so that the discovery run log can report
 * how many products were found, new, updated or merged away.
 */

const { unwrapAll } = require('../lib/items');
const { buildProduct } = require('../lib/product');
const { collapseProducts } = require('./collapse');

/**
 * Escape a value so it can be embedded as a SQL string literal.
 *
 * The Postgres node substitutes the expression result into the query
 * verbatim, so the payload is quoted and escaped here instead of relying on
 * query parameters.
 *
 * @param {*} value value to serialise
 * @returns {string} SQL string literal
 */
function sqlLiteral(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `'${String(text).replace(/'/g, "''")}'`;
}

/**
 * Build a PostgreSQL array literal for a list of strings.
 *
 * Postgres array literals look like `{"a","b"}` - a JSON array is not
 * accepted - so the values are quoted and escaped here.
 *
 * @param {string[]} values list of strings
 * @returns {string} SQL array literal
 */
function sqlTextArray(values) {
  const items = (values || []).map((value) => {
    const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '""');
    return `"${escaped}"`;
  });
  return `'{${items.join(',')}}'`;
}

/**
 * Validate and normalise one extracted product.
 *
 * @param {object} raw extracted product
 * @returns {object|null} canonical product or null when unusable
 */
function normalise(raw) {
  if (!raw || raw.product_error) {
    return null;
  }
  const product = buildProduct(raw);
  if (!product) {
    return null;
  }
  product.source_name = raw.source_name || null;
  product.source_publisher = raw.source_publisher || null;
  product.source_publisher_id = raw.source_publisher_id || null;
  product.source_strategy = raw.source_strategy || null;
  product.crawled_at = raw.crawled_at || new Date().toISOString();
  return product;
}

/**
 * Build the database payload.
 *
 * @param {object[]} items product items
 * @returns {object[]} a single item holding the products and the run log
 */
function run(items) {
  const products = [];
  const errors = [];
  const seen = new Set();
  const visited = new Set();

  unwrapAll(items).forEach((item) => {
    if (item && item.source_id) {
      visited.add(item.source_id);
    }
    if (item && item.source_marker) {
      // The source was crawled but produced no product.
      return;
    }
    if (item && item.product_error) {
      errors.push({ source_id: item.source_id, error: item.crawl_error });
      return;
    }
    const product = normalise(item);
    if (!product) {
      errors.push({ source_id: item && item.source_id, error: 'product failed validation' });
      return;
    }
    if (seen.has(product.product_key)) {
      // The same page can advertise a product twice; keep the first one.
      return;
    }
    seen.add(product.product_key);
    products.push(product);
  });

  // Collapse the products of one lender that describe the same rules.
  const collapsed = collapseProducts(products);
  const canonical = collapsed.products;

  const bySource = {};
  canonical.forEach((product) => {
    const sourceId = product.source_id || 'unknown';
    if (!bySource[sourceId]) {
      bySource[sourceId] = [];
    }
    bySource[sourceId].push(product.product_key);
  });

  const crawledSources = Array.from(visited).sort();

  // How many records were merged away for every crawled source.  The count
  // is attributed to the source that supplied the canonical product.
  const collapsedBySource = {};
  collapsed.collapsed.forEach((entry) => {
    const sourceId = entry.canonical_source_id || 'unknown';
    collapsedBySource[sourceId] = (collapsedBySource[sourceId] || 0) + entry.count - 1;
  });

  const runs = crawledSources.map((sourceId) => ({
    source_id: sourceId,
    status: 'success',
    products_found: bySource[sourceId] ? bySource[sourceId].length : 0,
    products_collapsed: collapsedBySource[sourceId] || 0,
  }));

  errors.forEach((failure) => {
    if (!runs.some((entry) => entry.source_id === failure.source_id)) {
      runs.push({
        source_id: failure.source_id,
        status: 'failed',
        products_found: 0,
        products_collapsed: 0,
        error: failure.error,
      });
    }
  });

  return [
    {
      products: canonical,
      runs,
      errors,
      collapsed: collapsed.collapsed,
      // The sources that were crawled in this run.  Products of these
      // sources that were not seen are deactivated by the sweep.
      crawled_sources: crawledSources,
      // The JSON payloads are pre-serialised and escaped here so the Postgres
      // node can inline them into the statement without having to call
      // `JSON.stringify` inside an n8n expression.
      products_json: JSON.stringify(canonical),
      runs_json: JSON.stringify(runs),
      products_sql: sqlLiteral(canonical),
      runs_sql: sqlLiteral(runs),
      crawled_sources_sql: sqlTextArray(crawledSources),
      stats: {
        records_extracted: products.length,
        products: canonical.length,
        products_collapsed: products.length - canonical.length,
        sources: runs.length,
        distinct_signatures: new Set(canonical.map((product) => product.criteria_signature)).size,
      },
    },
  ];
}

module.exports = { run, normalise, sqlLiteral, sqlTextArray };
