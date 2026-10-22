const { test } = require('node:test');
const assert = require('node:assert/strict');
const workflow=require('../../n8n/workflows/workflow_b_matching.json');
function execute(name, sources, input=[]) {
 const code=workflow.nodes.find(n=>n.name===name).parameters.jsCode;
 return new Function('$input','$',code)({all:()=>input.map(json=>({json}))},name=>{
  if (!(name in sources)) throw new Error('node not executed');
  return {all:()=>sources[name].map(json=>({json}))};
 });
}
const pairs=[
 {user_id:'u1',product_id:1,batch_id:'batch',status:'eligible',needs_llm:false,reasons:[]},
 {user_id:'u1',product_id:2,batch_id:'batch',status:'needs_llm',needs_llm:true,cache_key:'pending',reasons:[]},
 {user_id:'u2',product_id:3,batch_id:'batch',status:'needs_llm',needs_llm:true,cache_key:'cached',reasons:[]},
 {user_id:'u3',product_id:4,batch_id:'batch',status:'ineligible',needs_llm:false,reasons:[]},
];
const evaluated={pairs,statistics:{pairs_total:4}};
function parse(payload){return JSON.parse(payload.slice(1,-1).replace(/''/g,"'"));}
test('fast lane saves rule and cached decisions while unresolved pairs remain pending',()=>{
 const out=execute('Build Fast Matches',{'Evaluate Eligibility Rules':[evaluated],'Fetch Cached Verdicts':[{cache_key:'cached',verdict:'likely_eligible'}]});
 const matches=parse(out[0].matches_sql);
 assert.deepEqual(matches.map(m=>m.product_id),[1,3]);
 assert.equal(out[0].pending_pairs,1);
 assert.equal(out.length,1);
});
test('a request for missing information is audited but never stored as a match',()=>{
 const out=execute('Build Fast Matches',{'Evaluate Eligibility Rules':[evaluated],'Fetch Cached Verdicts':[]});
 const decisions=parse(out[0].decisions_sql);
 assert.equal(decisions.length,4);
 assert.deepEqual(decisions.map(d=>d.status).sort(),['eligible','ineligible','pending','pending']);
 assert.equal(parse(out[0].matches_sql).length,1);
});
test('qualitative lane removes cached buckets and rebuilds both request bodies',()=>{
 const request={profile_rules:['Must work at an MNC'],profile_signature:'p',buckets:[{label:'b1',cache_key:'cached',bucket:{}},{label:'b2',cache_key:'pending',bucket:{employment_status:'Salaried'}}]};
 const out=execute('Select Missing Checks',{'Plan Qualitative Checks':[{requests:[request]}],'Fetch Cached Verdicts':[{cache_key:'cached'}]},[{matches_written:1}]);
 assert.deepEqual(out[0].buckets.map(b=>b.label),['b2']);
 assert.deepEqual(Object.keys(JSON.parse(out[0].decider_body_json).questions),['b2']);
 assert.ok(!JSON.parse(out[0].body_json).messages[1].content.includes('id=b1'));
});
test('fully cached and zero-match inputs skip model calls without stalling',()=>{
 assert.equal(execute('Select Missing Checks',{'Plan Qualitative Checks':[{requests:[]}],'Fetch Cached Verdicts':[]})[0].ask,false);
 assert.equal(execute('Build Fast Matches',{'Evaluate Eligibility Rules':[{pairs:[pairs[3]]}],'Fetch Cached Verdicts':[]})[0].matches_sql,"'[]'");
 assert.equal(execute('Build Fast Matches',{'Evaluate Eligibility Rules':[{pairs:[{}]}],'Fetch Cached Verdicts':[]})[0].matches_sql,"'[]'");
 const evaluatedOut=execute('Evaluate Eligibility Rules',{'Fetch Batch Applicants':[{applicants:[]}],'Fetch Active Products':[{products:[]}]},[]);
 assert.equal(evaluatedOut.length,1);
 assert.deepEqual(evaluatedOut[0].pairs,[]);
});
test('the external stage only touches the pairs whose answer arrived',()=>{
 const out=execute('Apply External Verdicts',{
  'Evaluate Eligibility Rules':[evaluated],
  'Fetch Cached Verdicts':[{cache_key:'cached',verdict:'likely_eligible'}],
  'Collect Verdicts':[{verdicts:[{cache_key:'pending',verdict:'uncertain',reasons:['facts are missing']}],statistics:{llm_requests:1}}],
 });
 const decisions=parse(out[0].decisions_sql);
 assert.equal(decisions.length,1);
 assert.equal(decisions[0].product_id,2);
 assert.equal(decisions[0].status,'review');
 assert.equal(parse(out[0].matches_sql).length,0);
});
