/**
 * Tests for the product collapse (duplicate detection and merging).
 *
 * Run with: node --test tests/js
 */

const assert = require('node:assert');
const { test } = require('node:test');

const {
  collapseProducts,
  conflictingFields,
  groupKey,
  pickCanonical,
  slug,
} = require('../../n8n/code/discovery/collapse.js');

function product(overrides) {
  return Object.assign(
    {
      product_key: 'tmp',
      product_name: 'Bajaj Finance Personal Loan',
      provider: 'Bajaj Finance',
      source_id: 'bajaj-finserv-personal-loan',
      source_url: 'https://example.invalid/personal-loan',
      source_publisher: 'Bajaj Finserv',
      source_publisher_id: 'bajaj-finserv',
      interest_rate_min: 10,
      interest_rate_max: 30.5,
      min_loan_amount: 40000,
      max_loan_amount: 5500000,
      min_tenure_months: 12,
      max_tenure_months: 108,
      min_monthly_income: null,
      max_monthly_income: null,
      min_credit_score: 650,
      max_credit_score: null,
      min_age: null,
      max_age: 80,
      min_employment_years: null,
      required_employment_statuses: ['Salaried', 'Self-Employed'],
      criteria: { eligibility_lines: [] },
      raw: {},
    },
    overrides,
  );
}

test('slug turns a publisher or lender into a key fragment', () => {
  assert.strictEqual(slug('Bajaj Finserv'), 'bajaj-finserv');
  assert.strictEqual(slug('India Infoline Finance Ltd.'), 'india-infoline-finance-ltd');
});

test('products are grouped by publisher and provider', () => {
  assert.strictEqual(
    groupKey(product({})),
    'bajaj-finserv::bajaj finance',
  );
  assert.notStrictEqual(
    groupKey(product({ source_publisher_id: 'other-publisher' })),
    groupKey(product({})),
  );
});

test('a missing field is a gap, not a conflict', () => {
  const complete = product({});
  const incomplete = product({ max_age: null });
  assert.deepStrictEqual(conflictingFields(complete, incomplete), []);
});

test('two different values for the same field are a conflict', () => {
  const first = product({ min_credit_score: 650 });
  const second = product({ min_credit_score: 700 });
  assert.deepStrictEqual(conflictingFields(first, second), ['min_credit_score']);
});

test('different employment statuses are a conflict', () => {
  const first = product({});
  const second = product({ required_employment_statuses: ['Salaried'] });
  assert.deepStrictEqual(conflictingFields(first, second), ['required_employment_statuses']);
});

test('the most complete product represents the group', () => {
  const group = [
    product({ product_name: 'Bajaj Finance Personal Loan for Travel', max_age: null }),
    product({ product_name: 'Bajaj Finance Personal Loan' }),
  ];
  assert.strictEqual(pickCanonical(group).product_name, 'Bajaj Finance Personal Loan');
});

test('identical lender pages collapse into one canonical product', () => {
  const records = [
    product({}),
    product({
      product_name: 'Bajaj Finance Personal Loan for Travel',
      source_id: 'bajaj-finserv-travel-personal-loan',
      max_age: null,
    }),
    product({
      product_name: 'Bajaj Finance Personal Loan for Wedding',
      source_id: 'bajaj-finserv-wedding-personal-loan',
      max_age: null,
    }),
  ];
  const result = collapseProducts(records);

  assert.strictEqual(result.products.length, 1);
  assert.strictEqual(result.collapsed.length, 1);
  assert.strictEqual(result.collapsed[0].count, 3);
  assert.strictEqual(result.products[0].variants.length, 2);
  assert.strictEqual(result.products[0].product_key, 'bajaj-finserv:bajaj-finance');
});

test('the merge fills the gaps of the canonical product', () => {
  const records = [
    product({ max_age: null }),
    product({ source_id: 'bajaj-finserv-other' }),
  ];
  const result = collapseProducts(records);
  assert.strictEqual(result.products.length, 1);
  assert.strictEqual(result.products[0].max_age, 80);
});

test('products with conflicting criteria stay separate', () => {
  const records = [
    product({ product_name: 'Bajaj Salaried Personal Loan' }),
    product({
      product_name: 'Bajaj Self Employed Personal Loan',
      min_credit_score: 700,
      required_employment_statuses: ['Self-Employed'],
    }),
  ];
  const result = collapseProducts(records);
  assert.strictEqual(result.products.length, 2);
  assert.strictEqual(result.collapsed.length, 0);
  assert.notStrictEqual(result.products[0].product_key, result.products[1].product_key);
});

test('different lenders are never merged', () => {
  const records = [
    product({ provider: 'HDFC Bank', source_publisher: 'BankBazaar', source_publisher_id: 'bankbazaar' }),
    product({ provider: 'Yes Bank', source_publisher: 'BankBazaar', source_publisher_id: 'bankbazaar' }),
  ];
  const result = collapseProducts(records);
  assert.strictEqual(result.products.length, 2);
  assert.strictEqual(result.collapsed.length, 0);
});
