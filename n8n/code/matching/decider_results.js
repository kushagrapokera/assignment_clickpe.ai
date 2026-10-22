const { unwrapAll } = require('../lib/items');
const { itemsOf } = require('../lib/nodes');
const { NODES } = require('./nodes');
const { routeResponses } = require('./decider');
function run(items) {
  return routeResponses(unwrapAll(items), itemsOf(NODES.selected)).map(item => item.fallback
    ? {...item, fallback: false, choices: [{message: {content: '{"verdicts":[]}'}}],
        provider_errors: ['Model gateway request failed; manual review is required']}
    : item);
}
module.exports = { run };
