/**
 * Entry point: build one notification per applicant.
 *
 * The applicants arrive as one row per decision.  They are grouped per
 * applicant, addressed to the allow list (never to the address of the
 * applicant) and capped, so a large batch does not flood the inbox of the
 * team.
 *
 * The allow list travels with the rows, so the workflow needs a single input
 * and the addresses never end up in the workflow file.
 */

const { unwrapAll } = require('../lib/items');
const { buildEmail } = require('./email');
const CONFIG = require('virtual:config.json');

/**
 * Group the decision rows per applicant.
 *
 * @param {object[]} rows one row per decision
 * @returns {object[]} one entry per applicant
 */
function groupByApplicant(rows) {
  const applicants = new Map();
  (rows || []).forEach((row) => {
    const userId = row.user_id;
    if (!userId) {
      return;
    }
    if (!applicants.has(userId)) {
      applicants.set(userId, {
        user: {
          user_id: userId,
          name: row.name,
          email: row.email,
          age: row.age,
          monthly_income: row.monthly_income,
          credit_score: row.credit_score,
          employment_status: row.employment_status,
        },
        batch_id: row.batch_id,
        matches: [],
      });
    }
    applicants.get(userId).matches.push({
      match_id: row.match_id,
      product_id: row.product_id,
      status: row.status,
      lane: row.lane,
      decided_by: row.decided_by,
      score: row.score,
      reasons: row.reasons || [],
      llm_assessment: row.llm_assessment,
      product_name: row.product_name,
      provider: row.provider,
      interest_rate_min: row.interest_rate_min,
      interest_rate_max: row.interest_rate_max,
      min_loan_amount: row.min_loan_amount,
      max_loan_amount: row.max_loan_amount,
      min_tenure_months: row.min_tenure_months,
      max_tenure_months: row.max_tenure_months,
    });
  });
  return Array.from(applicants.values());
}

/**
 * Build the notifications.
 *
 * @param {object[]} items the decision rows
 * @returns {object[]} one item per email
 */
function run(items) {
  const rows = unwrapAll(items);
  const applicants = groupByApplicant(rows);

  const allowed = rows.length ? rows[0].allowed_recipients : null;
  const recipients = Array.isArray(allowed) ? allowed.filter(Boolean) : [];

  const notification = (CONFIG && CONFIG.notification) || {};
  const fromEmail = notification.from_email || 'alerts@loan-engine.test';
  const maxEmails = Number(notification.max_emails || 5);

  if (!recipients.length) {
    // Without an allow list nothing is sent: the addresses of the applicant
    // file must never be used as a recipient.
    return [];
  }

  const emails = [];
  applicants.forEach((applicant, index) => {
    if (emails.length >= maxEmails) {
      return;
    }
    // The recipients of the allow list are used in turn, so every applicant
    // ends up in a different alias of the inbox.
    const recipient = recipients[index % recipients.length];
    const email = buildEmail(applicant, recipient, { from_email: fromEmail });
    const eligible = applicant.matches.filter((match) => match.status === 'eligible').length;
    const review = applicant.matches.length - eligible;
    emails.push({
      to: email.to,
      from: email.from,
      subject: email.subject,
      html: email.html,
      text: email.text,
      user_id: applicant.user.user_id,
      applicant_email: applicant.user.email,
      batch_id: applicant.batch_id,
      match_count: eligible,
      review_count: review,
      recipient: recipient,
    });
  });

  return emails;
}

module.exports = { run, groupByApplicant };
