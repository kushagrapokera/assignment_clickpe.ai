/**
 * Entry point: list the crawl targets.
 *
 * The registry is injected into the bundle at build time from
 * `n8n/sources/sources.json`, so the workflow always crawls exactly the
 * sources that are configured in the repository.
 */

const SOURCES = require('virtual:sources.json');

/**
 * Return every enabled crawl target.
 *
 * @returns {object[]} one item per source
 */
function run() {
  const registry = SOURCES && Array.isArray(SOURCES.sources) ? SOURCES.sources : [];
  const publishers = (SOURCES && SOURCES.publishers) || {};
  return registry
    .filter((source) => source.enabled !== false)
    .map((source) => {
      const publisher = publishers[source.publisher] || {};
      return {
      source_id: source.id,
      source_name: source.name,
      publisher: source.publisher,
      publisher_name: publisher.name || source.publisher,
      site: publisher.site || source.site || null,
      url: source.url,
      extractor: source.extractor,
      strategy: source.strategy,
      fingerprint: source.fingerprint,
      notes: source.notes,
      };
    });
}

module.exports = { run };
