/**
 * The notification email.
 *
 * The email is addressed to an address of the allow list, never to the
 * address of the applicant: the applicant file of the assignment contains
 * addresses that must not be mailed.  The applicant is identified in the
 * body of the email, and the address that received it is recorded in the
 * `notifications` table.
 *
 * Two kinds of result are reported separately:
 *
 *   * a confirmed eligibility - the published criteria of the lender are met,
 *   * a request for missing information - the lender publishes a criterion
 *     the applicant file does not answer, so a person has to look at it.
 *
 * Mixing the two would read as an approval that the engine cannot give.
 */

/**
 * Escape a value so it can be used in HTML.
 *
 * @param {*} value value to escape
 * @returns {string} escaped value
 */
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format an amount in Indian currency.
 *
 * @param {number|null} value amount in rupees
 * @returns {string} formatted amount
 */
function formatAmount(value) {
  if (value === null || value === undefined) {
    return 'not published';
  }
  const amount = Math.round(Number(value));
  if (!Number.isFinite(amount)) {
    return 'not published';
  }
  const formatted = amount.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return `₹${formatted}`;
}

/**
 * Format an interest rate range.
 *
 * @param {number|null} min lower bound in percent
 * @param {number|null} max upper bound in percent
 * @returns {string} formatted range
 */
function formatRate(min, max) {
  if (min === null || min === undefined) {
    return max === null || max === undefined ? 'not published' : `up to ${trim(max)}% p.a.`;
  }
  if (max === null || max === undefined) {
    return `${trim(min)}% p.a. onwards`;
  }
  if (Number(min) === Number(max)) {
    return `${trim(min)}% p.a.`;
  }
  return `${trim(min)}% – ${trim(max)}% p.a.`;
}

/**
 * Render a number without trailing zeros.
 *
 * @param {number} value the number
 * @returns {string} the number as text
 */
function trim(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value);
  }
  return String(Math.round(number * 100) / 100);
}

/**
 * Format a tenure range in months.
 *
 * @param {number|null} min lower bound in months
 * @param {number|null} max upper bound in months
 * @returns {string} formatted range
 */
function formatTenure(min, max) {
  const toYears = (months) => {
    const years = Math.round((months / 12) * 10) / 10;
    return `${years} year${years === 1 ? '' : 's'}`;
  };
  if (min === null || min === undefined) {
    // Only an upper bound was published.
    return max === null || max === undefined ? 'not published' : `up to ${toYears(max)}`;
  }
  if (max === null || max === undefined || Number(min) === Number(max)) {
    return toYears(min);
  }
  return `${toYears(min)} – ${toYears(max)}`;
}

/** Readable names for the reason codes of the rule engine. */
const CHECK_LABELS = {
  AGE: 'the age limit',
  INCOME: 'the income requirement',
  CREDIT_SCORE: 'the credit score requirement',
  EMPLOYMENT_STATUS: 'the employment status requirement',
  EMPLOYMENT_YEARS: 'the work experience requirement',
  APPLICANT_AGE: 'the age of the applicant',
  APPLICANT_INCOME: 'the income of the applicant',
  APPLICANT_CREDIT_SCORE: 'the credit score of the applicant',
  APPLICANT_EMPLOYMENT_YEARS: 'the work experience of the applicant',
  DEBT_SERVICE_RATIO: 'the existing EMIs',
};

/**
 * Turn a reason code into a readable label.
 *
 * @param {string} code reason code
 * @returns {string} the label
 */
function checkLabel(code) {
  const key = String(code || '')
    .replace(/_NOT_PUBLISHED$/, '')
    .replace(/_UNKNOWN$/, '');
  return CHECK_LABELS[key] || key.replace(/_/g, ' ').toLowerCase();
}

/**
 * Join a list of labels into a readable sentence.
 *
 * @param {string[]} labels the labels
 * @returns {string} the sentence
 */
function joinLabels(labels) {
  if (!labels.length) {
    return '';
  }
  if (labels.length === 1) {
    return labels[0];
  }
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Collect the items the applicant has to confirm before applying.
 *
 * A lender that publishes no credit requirement is not evidence that the
 * applicant has one, so the check is reported as something to confirm.  The
 * items are grouped per lender, which keeps the list readable when a lender
 * publishes no criterion at all.
 *
 * @param {object[]} matches the decisions of the applicant
 * @returns {string[]} human readable confirmation items
 */
function collectConfirmations(matches) {
  const byProvider = new Map();
  (matches || []).forEach((match) => {
    const provider = match.provider || 'the lender';
    if (!byProvider.has(provider)) {
      byProvider.set(provider, { notPublished: new Set(), unknown: new Set(), notes: [] });
    }
    const bucket = byProvider.get(provider);
    const checks = Array.isArray(match.reasons) ? match.reasons : [];
    checks.forEach((check) => {
      if (!check) {
        return;
      }
      if (typeof check === 'string') {
        bucket.notes.push(check);
        return;
      }
      if (check.state === 'not_published') {
        bucket.notPublished.add(checkLabel(check.code));
      } else if (check.state === 'unknown') {
        bucket.unknown.add(checkLabel(check.code));
      } else if (check.state === 'review') {
        bucket.notes.push(check.detail || checkLabel(check.code));
      }
    });
  });

  const items = [];
  byProvider.forEach((bucket, provider) => {
    if (bucket.notPublished.size) {
      items.push(
        `${provider} does not publish ${joinLabels(Array.from(bucket.notPublished))} - confirm it with the lender`,
      );
    }
    if (bucket.unknown.size) {
      items.push(
        `${joinLabels(Array.from(bucket.unknown))} is missing from the applicant data - it has to be confirmed`,
      );
    }
    bucket.notes.forEach((note) => {
      items.push(`${provider}: ${note}`);
    });
  });
  return items;
}

/**
 * Split the decisions of an applicant into the confirmed and the open ones.
 *
 * @param {object[]} decisions the decisions of the applicant
 * @returns {{eligible: object[], review: object[]}} the two groups
 */
function splitDecisions(decisions) {
  const eligible = [];
  const review = [];
  (decisions || []).forEach((decision) => {
    if (decision && decision.status === 'eligible') {
      eligible.push(decision);
    } else if (decision) {
      review.push(decision);
    }
  });
  return { eligible, review };
}

/**
 * Build the email of one applicant.
 *
 * @param {object} applicant the applicant and its decisions
 * @param {string} recipient the address the email is sent to
 * @param {object} config notification configuration
 * @returns {object} the email
 */
function buildEmail(applicant, recipient, config) {
  const decisions = applicant.matches || [];
  const { eligible, review } = splitDecisions(decisions);
  const user = applicant.user || {};
  const name = user.name || 'there';
  const from = (config && config.from_email) || 'alerts@loan-engine.test';

  const eligibleRows = eligible
    .map((match) => {
      const rate = formatRate(match.interest_rate_min, match.interest_rate_max);
      const amount = formatAmount(match.max_loan_amount);
      const tenure = formatTenure(match.min_tenure_months, match.max_tenure_months);
      return `<tr>
        <td><strong>${escapeHtml(match.provider)}</strong><br /><span class="muted">${escapeHtml(
          match.product_name,
        )}</span></td>
        <td>${escapeHtml(rate)}</td>
        <td>${escapeHtml(amount)}</td>
        <td>${escapeHtml(tenure)}</td>
        <td><span class="badge ok">eligible</span></td>
      </tr>`;
    })
    .join('\n');

  const reviewRows = review
    .map((match) => {
      const needs = (Array.isArray(match.reasons) ? match.reasons : [])
        .map((reason) =>
          typeof reason === 'object' && reason !== null
            ? reason.detail || checkLabel(reason.code)
            : String(reason),
        )
        .filter(Boolean)
        .join('; ');
      return `<tr>
        <td><strong>${escapeHtml(match.provider)}</strong><br /><span class="muted">${escapeHtml(
          match.product_name,
        )}</span></td>
        <td>${escapeHtml(needs || 'A lender criterion has to be confirmed')}</td>
        <td><span class="badge maybe">needs information</span></td>
      </tr>`;
    })
    .join('\n');

  const profile = [
    user.age ? `age ${user.age}` : null,
    user.monthly_income ? `monthly income ${formatAmount(user.monthly_income)}` : null,
    user.credit_score ? `credit score ${user.credit_score}` : null,
    user.employment_status ? `employed as ${user.employment_status}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const confirmations = collectConfirmations(eligible);
  const confirmationBlock = confirmations.length
    ? `<p class="lead">Before you apply, please confirm:</p><ul>${confirmations
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('')}</ul>`
    : eligible.length
      ? '<p class="lead">Every published eligibility criterion of these lenders is met.</p>'
      : '';

  const eligibleBlock = eligible.length
    ? `<h2>${eligible.length} personal loan${eligible.length === 1 ? '' : 's'} you may qualify for</h2>
      <table>
        <thead>
          <tr><th>Lender</th><th>Interest rate</th><th>Max loan</th><th>Tenure</th><th>Result</th></tr>
        </thead>
        <tbody>${eligibleRows}</tbody>
      </table>`
    : '';

  const reviewBlock = review.length
    ? `<h2>${review.length} lender${review.length === 1 ? '' : 's'} need${review.length === 1 ? 's' : ''} more information</h2>
      <p class="lead">These lenders publish a criterion the applicant file does not answer. A person has to confirm it - it is not a rejection.</p>
      <table>
        <thead>
          <tr><th>Lender</th><th>What has to be confirmed</th><th>Result</th></tr>
        </thead>
        <tbody>${reviewRows}</tbody>
      </table>`
    : '';

  const heading = eligible.length
    ? `${eligible.length} personal loan${eligible.length === 1 ? '' : 's'} you may qualify for`
    : `${review.length} lender${review.length === 1 ? '' : 's'} need more information`;

  const intro = eligible.length
    ? `Your profile (${escapeHtml(profile)}) matches the published eligibility criteria of ${eligible.length} lender${eligible.length === 1 ? '' : 's'}.`
    : `Your profile (${escapeHtml(profile)}) was checked against ${review.length} lender${review.length === 1 ? '' : 's'}.`;

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
             margin: 0; padding: 24px; background: #f5f7fb; color: #14213d; }
      .card { max-width: 720px; margin: 0 auto; background: #ffffff; border-radius: 12px;
              padding: 28px 32px; box-shadow: 0 1px 3px rgba(16, 24, 40, 0.08); }
      h1 { font-size: 20px; margin: 0 0 4px; }
      h2 { font-size: 15px; margin: 24px 0 8px; }
      .muted { color: #667085; font-size: 13px; }
      .lead { font-size: 14px; color: #344054; }
      table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
      th { text-align: left; color: #667085; font-weight: 600; font-size: 12px;
           text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid #eaecf0;
           padding: 8px 6px; }
      td { padding: 10px 6px; border-bottom: 1px solid #f2f4f7; vertical-align: top; }
      .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
      .badge.ok { background: #ecfdf3; color: #027a48; }
      .badge.maybe { background: #fffaeb; color: #b54708; }
      .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #eaecf0;
                color: #667085; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${escapeHtml(heading)}</h1>
      <p class="lead">Hi ${escapeHtml(name)},</p>
      <p class="lead">${intro}</p>
      ${eligibleBlock}
      ${reviewBlock}
      ${confirmationBlock}
      <p class="footer">
        Prepared by the Loan Eligibility Engine from the eligibility criteria published by the
        lenders on ${escapeHtml(new Date().toISOString().slice(0, 10))}.
        This is guidance, not an approval - the lender decides.
        <br />Applicant reference: ${escapeHtml(user.user_id)} - batch ${escapeHtml(applicant.batch_id)}
      </p>
    </div>
  </body>
</html>`;

  const textLines = [`Hi ${name},`, '', intro, ''];
  if (eligible.length) {
    textLines.push(`${eligible.length} confirmed personal loan(s):`);
    eligible.forEach((match) => {
      textLines.push(
        `- ${match.provider} - ${match.product_name}: ${formatRate(
          match.interest_rate_min,
          match.interest_rate_max,
        )}, up to ${formatAmount(match.max_loan_amount)}, ${formatTenure(
          match.min_tenure_months,
          match.max_tenure_months,
        )} [eligible]`,
      );
    });
    textLines.push('');
  }
  if (review.length) {
    textLines.push(`${review.length} lender(s) need more information:`);
    review.forEach((match) => {
      const needs = (Array.isArray(match.reasons) ? match.reasons : [])
        .map((reason) =>
          typeof reason === 'object' && reason !== null
            ? reason.detail || checkLabel(reason.code)
            : String(reason),
        )
        .filter(Boolean)
        .join('; ');
      textLines.push(`- ${match.provider} - ${match.product_name}: ${needs || 'to be confirmed'}`);
    });
    textLines.push('');
  }
  if (confirmations.length) {
    textLines.push('Before you apply, please confirm:');
    confirmations.forEach((item) => textLines.push(`- ${item}`));
  } else if (eligible.length) {
    textLines.push('Every published eligibility criterion of these lenders is met.');
  }
  textLines.push('');
  textLines.push(
    `Applicant reference: ${user.user_id} - batch ${applicant.batch_id}`,
    'This is guidance, not an approval - the lender decides.',
  );

  const subject = review.length
    ? `${heading} - ${review.length} lender${review.length === 1 ? '' : 's'} need more information`
    : heading;

  return {
    to: recipient,
    from: from,
    subject: subject,
    html: html,
    text: textLines.join('\n'),
  };
}

module.exports = {
  buildEmail,
  checkLabel,
  collectConfirmations,
  escapeHtml,
  formatAmount,
  formatRate,
  formatTenure,
  joinLabels,
  splitDecisions,
  trim,
};
