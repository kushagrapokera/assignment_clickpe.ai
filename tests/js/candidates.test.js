/**
 * Tests for the candidate pairs.
 *
 * The pre-filter of the SQL stage used to live in a database statement.  It
 * now lives in the evaluator, and it has to keep the same pairs: a lender
 * that publishes an age at maturity is not filtered by the current age, and
 * an applicant outside a published range is a rejection while a missing
 * applicant value is not a decision at all.
 *
 * Run with: node --test tests/js
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { preFilter, publishesMaturityAge, rejectedPair } = require('../../n8n/code/matching/candidates.js');

const applicant = (extra) =>
  Object.assign(
    { age: 30, monthly_income: 50000, credit_score: 780, employment_status: 'Salaried' },
    extra || {},
  );

const product = (extra) =>
  Object.assign(
    {
      product_id: 1,
      min_age: null,
      max_age: null,
      min_credit_score: null,
      max_credit_score: null,
      min_monthly_income: null,
      max_monthly_income: null,
      criteria: {},
    },
    extra || {},
  );

test('a lender that publishes an age at maturity is not filtered by the current age', () => {
  const lender = product({
    min_age: 22,
    max_age: 60,
    criteria: { eligibility_lines: ['Age limit for salaried - 22-60 at the time of loan maturity'] },
  });
  assert.equal(publishesMaturityAge(lender), true);
  const outcome = preFilter(applicant({ age: 20 }), lender);
  assert.equal(outcome.candidate, true);
  assert.equal(outcome.rejected, false);
});

test('a plain age bound still rejects the applicant', () => {
  const outcome = preFilter(applicant({ age: 20 }), product({ min_age: 22 }));
  assert.equal(outcome.candidate, false);
  assert.equal(outcome.rejected, true);
});

test('a missing applicant value is not a rejection', () => {
  const outcome = preFilter(applicant({ age: null }), product({ min_age: 22 }));
  assert.equal(outcome.candidate, false);
  assert.equal(outcome.rejected, false);
});

test('the income and the credit score are filtered like the age', () => {
  assert.equal(preFilter(applicant({ monthly_income: 1000 }), product({ min_monthly_income: 25000 })).rejected, true);
  assert.equal(preFilter(applicant({ credit_score: 500 }), product({ min_credit_score: 650 })).rejected, true);
  assert.equal(preFilter(applicant({ monthly_income: null }), product({ min_monthly_income: 25000 })).rejected, false);
});

test('a rejected pair names the criterion the applicant missed', () => {
  const outcome = preFilter(applicant({ age: 19 }), product({ min_age: 21 }));
  assert.deepEqual(outcome.reasons, [
    { code: 'AGE_BELOW_MIN', state: 'fail', detail: 'Age 19 is below the required 21' },
  ]);
  const pair = rejectedPair({ user_id: 'u1', batch_id: 'b1' }, { product_id: 7 }, outcome.reasons);
  assert.equal(pair.status, 'ineligible');
  assert.equal(pair.reasons[0].code, 'AGE_BELOW_MIN');
  assert.match(pair.reasons[0].detail, /Age 19 is below the required 21/);
});

test('every missed criterion is reported, in the wording of the rule engine', () => {
  const outcome = preFilter(
    applicant({ age: 65, credit_score: 600, monthly_income: 10000 }),
    product({ max_age: 60, min_credit_score: 650, min_monthly_income: 25000 }),
  );
  assert.deepEqual(outcome.reasons.map((reason) => reason.code), [
    'AGE_ABOVE_MAX',
    'CREDIT_SCORE_BELOW_MIN',
    'INCOME_BELOW_MIN',
  ]);
  assert.equal(outcome.reasons[0].detail, 'Age 65 is above the allowed 60');
  assert.equal(outcome.reasons[1].detail, 'Credit score 600 is below the required 650');
  assert.equal(outcome.reasons[2].detail, 'Monthly income 10000 is below the required 25000');
});
