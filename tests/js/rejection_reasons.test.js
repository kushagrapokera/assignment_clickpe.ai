const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function page() {
  const context = vm.createContext({ document: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync('frontend/app.js', 'utf8'), context);
  return (code) => vm.runInContext(code, context);
}

const APPLICANT = {
  decisions: [
    {
      status: 'ineligible',
      provider: 'Bajaj Finance',
      reasons: [{ code: 'AGE_BELOW_MIN', state: 'fail', detail: 'Age 19 is below the required 21' }],
    },
    {
      status: 'ineligible',
      provider: 'HDFC Bank',
      reasons: [
        { code: 'EMPLOYMENT_NOT_ACCEPTED', state: 'fail', detail: 'Employment status Self-Employed; accepted: Salaried' },
        { code: 'CREDIT_SCORE_BELOW_MIN', state: 'fail', detail: 'Credit score 600 is below the required 650' },
      ],
    },
    { status: 'eligible', provider: 'Kotak Mahindra Bank', reasons: [] },
  ],
};

test('the applicant row names why the lender said no', () => {
  const evaluate = page();
  const reasons = evaluate('rejectionReasons')(APPLICANT);
  assert.match(reasons, /Age 19 is below the required 21/);
  assert.match(reasons, /Employment status Self-Employed/);
});

test('the same reason is only named once and the line stays short', () => {
  const evaluate = page();
  const reasons = evaluate('rejectionReasons')({
    decisions: [
      { status: 'ineligible', reasons: [{ detail: 'Age 19 is below the required 21' }] },
      { status: 'ineligible', reasons: [{ detail: 'Age 19 is below the required 21' }] },
      { status: 'ineligible', reasons: [{ detail: 'Second reason' }] },
      { status: 'ineligible', reasons: [{ detail: 'Third reason' }] },
    ],
  });
  assert.equal(reasons, 'Age 19 is below the required 21; Second reason and 1 more');
});

test('an applicant without a rejection has no reason line', () => {
  const evaluate = page();
  assert.equal(evaluate('rejectionReasons')({ decisions: [] }), '');
  assert.equal(
    evaluate('rejectionReasons')({ decisions: [{ status: 'eligible', reasons: [] }] }),
    '',
  );
});
