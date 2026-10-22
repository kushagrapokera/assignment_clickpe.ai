/**
 * Smoke test for the bundled Code node scripts.
 *
 * The script takes a built workflow, extracts a Code node's `jsCode` and
 * evaluates it exactly the way n8n does (inside a function that receives
 * `$input`), which proves the bundle is self contained and executable.
 *
 * Usage:
 *   node scripts/run_code_node.js <workflow.json> "<node name>" <html-file>
 */

const fs = require('fs');
const path = require('path');

function loadWorkflow(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function findNode(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  if (!node) {
    throw new Error(`node not found: ${name}`);
  }
  return node;
}

/**
 * Evaluate a Code node script the way n8n would.
 *
 * @param {string} jsCode script body
 * @param {object[]} items input items
 * @returns {Promise<object[]>} output items
 */
async function runCode(jsCode, items) {
  const $input = {
    all: () => items,
    first: () => items[0],
    last: () => items[items.length - 1],
  };
  // eslint-disable-next-line no-new-func
  const runner = new Function('$input', `$json = $input.first();\n${jsCode}`);
  const result = await runner($input);
  return Array.isArray(result) ? result : [result];
}

async function main() {
  const [, , workflowFile, nodeName, htmlFile] = process.argv;
  if (!workflowFile || !nodeName) {
    console.error(
      'usage: node scripts/run_code_node.js <workflow.json> "<node name>" [html-file]',
    );
    process.exit(2);
  }
  const workflow = loadWorkflow(path.resolve(workflowFile));
  const node = findNode(workflow, nodeName);
  const items = htmlFile
    ? [{ html: fs.readFileSync(path.resolve(htmlFile), 'utf8') }]
    : [];
  const output = await runCode(node.parameters.jsCode, items);
  console.log(JSON.stringify(output, null, 2));
  console.error(`${output.length} item(s)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
