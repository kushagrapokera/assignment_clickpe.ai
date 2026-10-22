/**
 * Tests for the notification email.
 *
 * Run with: node --test tests/js
 */

const assert = require('node:assert');
const { test } = require('node:test');

const {
  buildEmail,
  checkLabel,
  collectConfirmations,
  escapeHtml,
  formatAmount,
  formatRate,
  formatTenure,
} = require('../../n8n/code/notification/email.js');

const MATCHES = [
  {
    provider: 'HDFC Bank',
    product_name: 'HDFC Bank Personal Loan',
    status: 'eligible',
    interest_rate_min: 10.85,
    interest_rate_max: 21,
    max_loan_amount: 4000000,
    min_tenure_months: 12,
    max_tenure_months: 60,
    reasons: [
      { code: 'AGE_OK', state: 'pass', detail: 'Age 30 satisfies the requirement' },
      { code: 'CREDIT_SCORE_NOT_PUBLISHED', state: 'not_published', detail: 'not published' },
    ],
  },
  {
    provider: 'TurboLoan powered by Chola',
    product_name: 'TurboLoan powered by Chola',
    status: 'likely',
    interest_rate_min: 10.25,
    interest_rate_max: 34.05,
    max_loan_amount: 300000,
    min_tenure_months: null,
    max_tenure_months: 36,
    reasons: [
      { code: 'AGE_NOT_PUBLISHED', state: 'not_published', detail: 'not published' },
      { code: 'INCOME_NOT_PUBLISHED', state: 'not_published', detail: 'not published' },
    ],
  },
];

const APPLICANT = {
  user: {
    user_id: 'u-1',
    name: 'Meera Sharma',
    email: 'meera@example.com',
    age: 30,
    monthly_income: 300000,
    credit_score: 720,
    employment_status: 'Salaried',
  },
  batch_id: 'b-1',
  matches: MATCHES,
};

test('amounts are formatted in Indian currency', () => {
  assert.strictEqual(formatAmount(4000000), '₹40,00,000');
  assert.strictEqual(formatAmount(150000), '₹1,50,000');
  assert.strictEqual(formatAmount(null), 'not published');
});

test('rates keep a single value or a range', () => {
  assert.strictEqual(formatRate(10.25, 34.05), '10.25% – 34.05% p.a.');
  assert.strictEqual(formatRate(10.99, 10.99), '10.99% p.a.');
  assert.strictEqual(formatRate(10.99, null), '10.99% p.a. onwards');
  assert.strictEqual(formatRate(null, null), 'not published');
});

test('a tenure with only an upper bound is not "not published"', () => {
  assert.strictEqual(formatTenure(null, 36), 'up to 3 years');
  assert.strictEqual(formatTenure(12, 60), '1 year – 5 years');
  assert.strictEqual(formatTenure(null, null), 'not published');
});

test('html is escaped', () => {
  assert.strictEqual(escapeHtml('<script>"x"'), '&lt;script&gt;&quot;x&quot;');
});

test('reason codes become readable labels', () => {
  assert.strictEqual(checkLabel('CREDIT_SCORE_NOT_PUBLISHED'), 'the credit score requirement');
  assert.strictEqual(checkLabel('EMPLOYMENT_YEARS_UNKNOWN'), 'the work experience requirement');
});

test('the confirmations are grouped per lender', () => {
  const items = collectConfirmations(MATCHES);
  assert.strictEqual(items.length, 2);
  assert.ok(items[0].includes('HDFC Bank'));
  assert.ok(items[0].includes('the credit score requirement'));
  assert.ok(items[1].includes('TurboLoan powered by Chola'));
  assert.ok(items[1].includes('the age limit'));
});

test('the email is addressed to the allow list, not to the applicant', () => {
  const email = buildEmail(APPLICANT, 'alerts+one@loan-engine.test', {
    from_email: 'alerts@loan-engine.test',
  });
  assert.strictEqual(email.to, 'alerts+one@loan-engine.test');
  assert.ok(!email.to.includes('example.com'));
  assert.strictEqual(email.from, 'alerts@loan-engine.test');
  assert.ok(email.subject.includes('1 personal loan'));
  assert.ok(email.subject.includes('need more information'));
});

test('the email separates the confirmed eligibility from the open questions', () => {
  const email = buildEmail(APPLICANT, 'alerts+one@loan-engine.test', {
    from_email: 'alerts@loan-engine.test',
  });
  assert.ok(email.html.includes('eligible'));
  assert.ok(email.html.includes('needs information'));
  assert.ok(email.html.includes('HDFC Bank'));
  assert.ok(email.html.includes('TurboLoan powered by Chola'));
});

test('the email names the applicant and lists the products', () => {
  const email = buildEmail(APPLICANT, 'alerts+one@loan-engine.test', {
    from_email: 'alerts@loan-engine.test',
  });
  assert.ok(email.html.includes('Meera Sharma'));
  assert.ok(email.html.includes('HDFC Bank'));
  assert.ok(email.html.includes('TurboLoan powered by Chola'));
  assert.ok(email.html.includes('₹40,00,000'));
  assert.ok(email.text.includes('HDFC Bank'));
});

test('a name from the file cannot inject markup', () => {
  const applicant = JSON.parse(JSON.stringify(APPLICANT));
  applicant.user.name = '<img src=x onerror=alert(1)>';
  const email = buildEmail(applicant, 'alerts+one@loan-engine.test', {
    from_email: 'alerts@loan-engine.test',
  });
  assert.ok(!email.html.includes('<img src=x'));
  assert.ok(email.html.includes('&lt;img src=x'));
});
