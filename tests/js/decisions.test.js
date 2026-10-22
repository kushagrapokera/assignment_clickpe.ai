const {test}=require('node:test');
const assert=require('node:assert/strict');
const {decisionOf}=require('../../n8n/code/matching/decisions');
const pair={batch_id:'b',user_id:'u',product_id:1,status:'needs_llm',needs_llm:true};
test('audit distinguishes pending, rejected and uncertain model decisions',()=>{
 assert.equal(decisionOf(pair,null).status,'pending');
 assert.equal(decisionOf(pair,{verdict:'likely_ineligible'}).status,'ineligible');
 assert.equal(decisionOf(pair,{verdict:'uncertain'}).status,'review');
 assert.equal(decisionOf(pair,{verdict:'likely_eligible'}).lane,'qualitative');
 assert.equal(decisionOf(pair,{verdict:'likely_eligible'}).status,'eligible');
});
test('rule rejection is recorded rather than inferred from an absent match',()=>{
 const decision=decisionOf({...pair,status:'ineligible',needs_llm:false,reasons:[{code:'INCOME_BELOW_MIN',state:'fail',detail:'Income below minimum'}]},null);
 assert.equal(decision.status,'ineligible');assert.equal(decision.lane,'rules');
 assert.deepEqual(decision.reasons,[{code:'INCOME_BELOW_MIN',state:'fail',detail:'Income below minimum'}]);
});
test('a request for missing information keeps its reason codes',()=>{
 const decision=decisionOf({...pair,status:'likely',needs_llm:false,reasons:[{code:'APPLICANT_EMPLOYMENT_YEARS_UNKNOWN',state:'unknown',detail:'Work experience is required but not supplied'}]},null);
 assert.equal(decision.status,'review');
 assert.deepEqual(decision.reasons,[{code:'APPLICANT_EMPLOYMENT_YEARS_UNKNOWN',state:'unknown',detail:'Work experience is required but not supplied'}]);
});
test('the explanation of a model answer is kept as a readable reason',()=>{
 const decision=decisionOf(pair,{verdict:'uncertain',reasons:['Required facts are missing']});
 assert.equal(decision.status,'review');
 assert.deepEqual(decision.reasons,[{code:'QUALITATIVE_REASON',state:'review',detail:'Required facts are missing'}]);
});
