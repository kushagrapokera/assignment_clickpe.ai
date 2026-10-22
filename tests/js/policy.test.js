const {test}=require('node:test');const assert=require('node:assert/strict');
const {evaluatePair,checkRange}=require('../../n8n/code/matching/rules');
const {compileLine}=require('../../n8n/code/matching/policy');
const {buildProfile}=require('../../n8n/code/matching/profiles');
const {factBucket}=require('../../n8n/code/matching/facts');
const products=[...require('../../data/discovery/bankbazaar.json').products,...require('../../data/discovery/bajaj-finserv.json').products];
const product=name=>products.find(p=>p.provider===name);
const user={age:30,monthly_income:50000,credit_score:780,employment_status:'Salaried'};
const run=(name,extra={})=>evaluatePair({...user,...extra},product(name));

test('all current extracted bullets are interpreted, without removing the unknown-policy fallback',()=>{
 for(const p of products){for(const line of p.criteria.eligibility_lines||[])assert.ok(compileLine(line),`${p.provider}: ${line}`);
  for(const employment_status of ['Salaried','Self-Employed'])assert.equal(evaluatePair({...user,employment_status},p).needs_llm,false,p.provider);
 }
 const p={criteria:{eligibility_lines:['Monthly income should comfortably support repayment capacity']}};
 assert.equal(evaluatePair(user,p).needs_llm,true);
 assert.equal(evaluatePair({...user,monthly_income:null},p).needs_llm,false);
 assert.equal(evaluatePair({...user,monthly_income:null},p).status,'likely');
 assert.equal(compileLine('Age 21-60 and the employer must be reputable'),null,'Do not swallow additional conditions');
});
test('age bounds, strict income boundaries and employment-specific requirements are enforced',()=>{
 assert.equal(run('Aditya Birla Capital',{age:61}).status,'ineligible');
 assert.equal(run('HDFC Bank',{age:60,employment_status:'Salaried'}).status,'ineligible');
 assert.equal(run('HDFC Bank',{age:60,employment_status:'Self-Employed'}).status,'eligible');
 assert.equal(run('Kotak Mahindra Bank',{monthly_income:25000}).status,'ineligible');
 assert.equal(run('HDBFS',{monthly_income:19999}).status,'ineligible');
 const p={max_age:50,criteria:{}};assert.equal(evaluatePair({...user,age:51},p).status,'ineligible','Upper-only bounds must not be ignored');
});
test('experience OR does not become AND; employment-specific and post-qualification evidence remain distinct',()=>{
 assert.equal(run('Edelweiss Salaried',{employment_years:1,current_employer_years:1}).status,'eligible');
 assert.equal(run('Edelweiss Salaried',{employment_years:3}).status,'eligible');
 assert.equal(run('Edelweiss Salaried',{employment_years:1}).status,'likely');
 assert.equal(run('Edelweiss Salaried',{employment_years:1,current_employer_years:0.5}).status,'ineligible');
 assert.equal(run('IndusInd Bank',{employment_years:3,current_employer_years:0.5}).status,'ineligible');
 assert.equal(run('IndusInd Bank',{employment_years:3,current_employer_years:1}).status,'eligible');
 assert.equal(run('IndusInd Bank',{employment_status:'Self-Employed',employment_years:8}).status,'likely');
 assert.equal(run('IndusInd Bank',{employment_status:'Self-Employed',post_qualification_years:5}).status,'eligible');
});
test('missing city, residency and employer evidence requires review, never a model guess or automatic pass',()=>{
 for(const lender of ['Kotak Mahindra Bank','Aditya Birla Capital','India Infoline Finance Ltd.']){
  assert.equal(run(lender).status,'likely');assert.equal(run(lender).needs_llm,false);
 }
 assert.equal(run('Kotak Mahindra Bank',{residency_country:'India',employer_category:'MNC'}).status,'eligible');
 assert.equal(run('Kotak Mahindra Bank',{residency_country:'UK',employer_category:'MNC'}).status,'ineligible');
 assert.equal(run('Aditya Birla Capital',{employment_type:'permanent',employer_group:'Aditya Birla Financial Services Group'}).status,'eligible');
 assert.equal(run('India Infoline Finance Ltd.',{city:'Bengaluru'}).status,'eligible');
 assert.equal(run('India Infoline Finance Ltd.',{city:'Unknown'}).status,'likely');
 assert.equal(run('India Infoline Finance Ltd.',{city:'Kolkata'}).status,'ineligible');
});
test('regional income, loan maturity, and business profit clauses retain all conditions',()=>{
 assert.equal(run('HDFC Bank',{monthly_income:22000}).status,'likely');
 assert.equal(run('HDFC Bank',{monthly_income:22000,state:'MP'}).status,'ineligible');
 assert.equal(run('HDFC Bank',{monthly_income:22000,state:'Maharashtra'}).status,'eligible');
 assert.equal(run('HDFC Bank',{monthly_income:25000}).status,'eligible');
 assert.equal(run('HDBFS',{age:20,requested_tenure_months:24,city:'Pune'}).status,'eligible');
 assert.equal(run('HDBFS',{age:59,requested_tenure_months:24,city:'Pune'}).status,'ineligible');
 assert.equal(run('HDBFS',{age:59,city:'Pune'}).status,'likely');
 assert.equal(run('IDFC First Bank').status,'eligible','Self-employed clause does not apply to salaried applicants');
 assert.equal(run('IDFC First Bank',{employment_status:'Self-Employed',business_years:4}).status,'likely');
 assert.equal(run('IDFC First Bank',{employment_status:'Self-Employed',business_years:4,profit_after_tax_last_two_years:[100,200]}).status,'eligible');
 assert.equal(run('IDFC First Bank',{employment_status:'Self-Employed',business_years:4,profit_after_tax_last_two_years:[100,-1]}).status,'ineligible');
});
test('residual profiles use only relevant facts, exact values and a versioned policy fingerprint',()=>{
 const p={criteria:{eligibility_lines:['Age 21-60','Income should comfortably support repayment capacity']}};
 const profile=buildProfile(p,['Income should comfortably support repayment capacity']);
 assert.deepEqual(profile.facts,['monthly_income']);
 assert.deepEqual(factBucket({...user,age:55},profile.facts,true),factBucket(user,profile.facts,true));
 assert.notDeepEqual(factBucket({...user,monthly_income:50001},profile.facts,true),factBucket(user,profile.facts,true));
 assert.notEqual(profile.signature,buildProfile({criteria:{...p.criteria,min_age:25}},profile.rules).signature);
});
test('the packaged n8n node applies the same rules and retains the model route for unfamiliar wording',()=>{
 const workflow=require('../../n8n/workflows/workflow_b_matching.json');
 const code=workflow.nodes.find(n=>n.name==='Evaluate Eligibility Rules').parameters.jsCode;
 const evaluate=new Function('$input','$',code);
 const run=(applicant,catalogue)=>evaluate({all:()=>[]},name=>{
  if(name==='Fetch Batch Applicants')return {all:()=>[{json:{applicants:[applicant]}}]};
  if(name==='Fetch Active Products')return {all:()=>[{json:{products:[catalogue]}}]};
  throw new Error('node not executed');
 })[0].pairs[0];
 const known=run({...user,user_id:'test',batch_id:'batch'},{...product('Kotak Mahindra Bank'),product_id:1});
 assert.equal(known.status,'needs_llm');assert.equal(known.needs_llm,true);assert.equal(known.evidence_incomplete,true);
 assert.ok(known.reasons.some(reason=>reason.state==='unknown'));
 const unfamiliar=run({...user,user_id:'test',batch_id:'batch'},{...product('Kotak Mahindra Bank'),product_id:1,criteria:{eligibility_lines:['Age - At least 21 and less than 55','Monthly income should comfortably support repayment capacity']}});
 assert.equal(unfamiliar.needs_llm,true);assert.deepEqual(unfamiliar.profile_rules,['Monthly income should comfortably support repayment capacity']);
 assert.deepEqual(unfamiliar.profile_facts,['monthly_income']);assert.equal(unfamiliar.fact_bucket.monthly_income,50000);
});
