/**
 * Development harness: run a discovery extractor against a local HTML file.
 *
 * Usage:
 *   node scripts/extract_local.js <extractor> <html-file> [source-id]
 *
 * It exists so the parsing logic can be iterated on without going through
 * n8n, which keeps the edit/run loop fast.
 */

const fs = require('fs');
const path = require('path');

const CODE_ROOT = path.join(__dirname, '..', 'n8n', 'code');
const registry = require(path.join(CODE_ROOT, 'discovery', 'registry'));

function main() {
  const [, , extractorName, file, sourceId] = process.argv;
  if (!extractorName || !file) {
    console.error('usage: node scripts/extract_local.js <extractor> <html-file> [source-id]');
    process.exit(2);
  }
  const extractor = registry.getExtractor(extractorName);
  if (!extractor) {
    console.error(`unknown extractor: ${extractorName}`);
    process.exit(2);
  }
  const html = fs.readFileSync(file, 'utf8');
  const source = { id: sourceId || extractorName, url: `file://${file}` };
  const products = extractor.extract(html, source);
  console.log(JSON.stringify(products, null, 2));
  console.error(`\n${products.length} product(s) extracted`);
}

main();
