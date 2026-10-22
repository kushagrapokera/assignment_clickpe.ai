const {test}=require('node:test');
const assert=require('node:assert/strict');
const {reviewCandidate}=require('../../n8n/code/matching/review');
const {decisionOf}=require('../../n8n/code/matching/decisions');
const {toMatch}=require('../../n8n/code/matching/apply');
test('review second opinions carry exact evidence and a separate cache namespace',()=>{
 const product={criteria:{eligibility_lines:['Indian resident working at an accepted employer']}};
 const result={status:'likely',checks:[{state:'unknown',fields:['residency'],detail:'Residency required'}]};
 const a=reviewCandidate({employment_status:'Salaried'},product,result);
 assert.ok(a.cache_key.includes('review-v2'));assert.equal(a.fact_bucket.residency,null);
 assert.equal(a.evidence_incomplete,true);
 assert.equal(reviewCandidate({},product,{status:'ineligible'}),null);
});
test('supported favorable model answer becomes an eligible UI decision and stored match',()=>{
 const pair={status:'needs_llm',needs_llm:true,reasons:[],user_id:'u',product_id:1};
 const decision=decisionOf(pair,{verdict:'likely_eligible',reasons:['Supplied evidence satisfies policy']});
 assert.equal(decision.status,'eligible');assert.equal(toMatch(decision).status,'eligible');
});
test('model verdict changes a reviewed decision while retaining the original evidence gaps',()=>{
 const pair={status:'needs_llm',needs_llm:true,evidence_incomplete:true,reasons:[{detail:'Residency required'}]};
 const decision=decisionOf(pair,{verdict:'likely_eligible',reasons:['Model opinion']});
 assert.equal(decision.status,'eligible');assert.equal(toMatch(decision).status,'eligible');
 assert.equal(decision.reasons[0].detail,'Residency required');
 assert.equal(decisionOf(pair,{verdict:'uncertain'}).status,'review');
});
test('all review keys beyond eight reach the packaged model planner',()=>{
 const w=require('../../n8n/workflows/workflow_b_matching.json');
 const people=Array.from({length:25},(_,i)=>({user_id:`u${i}`,batch_id:'b',age:30,credit_score:750,monthly_income:30000+i,employment_status:'Salaried'}));
 const products=[{product_id:1,criteria:{eligibility_lines:['Indian resident working at an accepted employer']},required_employment_statuses:['Salaried']}];
 const sources={'Fetch Batch Applicants':[{applicants:people}],'Fetch Active Products':[{products}]};
 const execute=name=>new Function('$input','$',w.nodes.find(n=>n.name===name).parameters.jsCode)({all:()=>[]},key=>{if(!(key in sources))throw Error('not run');return {all:()=>sources[key].map(json=>({json}))};});
 // Distinct employment-year evidence creates more than eight review cache keys.
 people.forEach((p,i)=>{p.eligibility_facts={employment_years:i};});
 products[0].criteria.eligibility_lines.push('Monthly income should comfortably support repayment capacity');
 const evaluated=execute('Evaluate Eligibility Rules');
 assert.equal(evaluated[0].pairs.length,25);
 assert.ok(evaluated[0].pairs.every(p=>p.needs_llm));
 assert.equal(new Set(evaluated[0].pairs.map(p=>p.cache_key)).size,25);
 sources['Evaluate Eligibility Rules']=evaluated;
 const planned=execute('Plan Qualitative Checks')[0];
 assert.equal(planned.requests.reduce((n,r)=>n+r.buckets.length,0),25);
 assert.ok(planned.requests.every(r=>r.buckets.length<=16));
});
