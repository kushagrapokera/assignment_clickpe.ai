/**
 * Entry point: collect what the mail server answered.
 *
 * The Send Email node replaces the item with the response of the mail
 * server, so the applicant the mail belonged to is read back from the node
 * that built the emails.
 */

const { unwrapAll } = require('../lib/items');
const { NODES } = require('./nodes');

/**
 * Read the items of another node of the workflow.
 *
 * @param {string} nodeName name of the node
 * @returns {object[]} the JSON payloads of that node
 */
function itemsOf(nodeName) {
  try {
    return $(nodeName).all().map((item) => item.json);
  } catch (error) {
    return [];
  }
}

/**
 * Escape a value so it can be embedded as a SQL string literal.
 *
 * @param {*} value value to serialise
 * @returns {string} SQL string literal
 */
function sqlLiteral(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `'${String(text).replace(/'/g, "''")}'`;
}

/**
 * Collect the delivery results.
 *
 * @param {object[]} items the responses of the mail server
 * @returns {object[]} one item per notification
 */
function run(items) {
  const responses = unwrapAll(items);
  const sent = itemsOf(NODES.sent);

  const notifications = responses.map((response, index) => {
    const original = sent[index] || {};
    if (!original.user_id) {
      // The placeholder of a run without a single notification.
      return null;
    }
    const failed = Boolean(response && (response.error || response.statusCode >= 400));
    const messageId =
      (response && (response.messageId || response.message_id || response.id)) || null;
    return {
      user_id: original.user_id || null,
      batch_id: original.batch_id || null,
      match_count: original.match_count || 0,
      review_count: original.review_count || 0,
      recipient: original.recipient || original.to || null,
      provider: 'smtp',
      status: failed ? 'failed' : 'sent',
      provider_message_id: messageId,
      error: failed
        ? String((response && (response.error || response.message)) || 'unknown error')
        : null,
    };
  });

  const delivered = notifications.filter((entry) => entry !== null);

  return [
    {
      notifications: delivered,
      notifications_sql: sqlLiteral(delivered),
      statistics: {
        notifications: delivered.length,
        sent: delivered.filter((entry) => entry.status === 'sent').length,
        failed: delivered.filter((entry) => entry.status === 'failed').length,
      },
    },
  ];
}

module.exports = { run, sqlLiteral, itemsOf };
