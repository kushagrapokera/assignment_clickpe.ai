const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest, normaliseResponse, routeResponses } = require('../../n8n/code/matching/decider');
const { parseVerdicts } = require('../../n8n/code/matching/llm');
const request = {
  body_json: '{"original":"llm request"}',
  profile_rules: ['Must work at an MNC'],
  buckets: [{ label: 'b1', cache_key: 'key1', bucket: { employment_status: 'Salaried' } }, { label: 'b2', cache_key: 'key2', bucket: { employment_status: 'Self-Employed' } }],
};
const response = { answers: { b2: { type: 'choice', choice: 'likely_ineligible' }, b1: { type: 'choice', choice: 'uncertain' } }, usage: { input_tokens: 10, output_tokens: 5 } };

test('requests identify each bucket and forbid inventing missing facts', () => {
  const body = buildRequest(request);
  assert.equal(body.model, 'strands-decider-2b');
  assert.deepEqual(Object.keys(body.questions), ['b1', 'b2']);
  assert.match(body.questions.b1.instructions, /Missing required facts must result in uncertain/);
  assert.deepEqual(Object.keys(body.questions.b1.criteria), ['likely_eligible', 'likely_ineligible', 'uncertain']);
});
test('typed responses preserve bucket mapping and work with the existing parser', () => {
  const result = normaliseResponse(response, request);
  const verdicts = parseVerdicts(result.choices[0].message.content);
  assert.deepEqual(verdicts.map(v => [v.bucket, v.verdict]), [['b1', 'uncertain'], ['b2', 'likely_ineligible']]);
  assert.equal(result.usage.prompt_tokens, 10);
  assert.equal(verdicts[0].score, null);
  assert.equal(routeResponses([response], [request])[0].fallback, false);
});
test('HTTP errors, missing buckets, invalid choices and wrong types fall back to intact LLM requests', () => {
  for (const invalid of [{error:'timeout'}, {}, {answers:{b1:response.answers.b1}}, {answers:{...response.answers,b1:{type:'choice',choice:'approved'}}}, {answers:{...response.answers,b1:{type:'text',choice:'uncertain'}}}]) {
    const routed = routeResponses([invalid], [request]);
    assert.equal(routed[0].fallback, true);
    assert.equal(routed[0].body_json, request.body_json);
    assert.deepEqual(routed[0].buckets, request.buckets);
  }
});
test('partial failures preserve successful responses and only mark failed requests for fallback', () => {
  const other = {...request,body_json:'second request'};
  const routed=routeResponses([response,{error:'503'}],[request,other]);
  assert.equal(routed[0].fallback,false);
  assert.equal(routed[0].request,request);
  assert.equal(routed[1].fallback,true);
  assert.equal(routed[1].body_json,other.body_json);
  assert.ok(routeResponses([], [request])[0].fallback);
});
test('bundled routing retains alignment on both branches', () => {
  const workflow=require('../../n8n/workflows/workflow_b_matching.json');
  const code=workflow.nodes.find(n=>n.name==='Read Decider Results').parameters.jsCode;
  const run=new Function('$input','$',code);
  const source=()=>({all:()=>[{json:request}]});
  assert.equal(run({all:()=>[{json:response}]},source)[0].fallback,false);
  assert.equal(run({all:()=>[{json:{error:'timeout'}}]},source)[0].body_json,request.body_json);
});
test('gateway responses retain request identity and only valid answers enter the cache payload',()=>{
 const workflow=require('../../n8n/workflows/workflow_b_matching.json');
 const execute=(name,input,sources)=>new Function('$input','$',workflow.nodes.find(n=>n.name===name).parameters.jsCode)(
  {all:()=>input.map(json=>({json}))},key=>{if(!(key in sources))throw Error('not run');return {all:()=>sources[key].map(json=>({json}))};});
 const other={...request,profile_signature:'other',buckets:[{label:'b1',cache_key:'other-key',bucket_id:'other'}]};
 const resolved={resolved_response:normaliseResponse(response,request),provider_errors:[]};
 const failed={resolved_response:{model:'failed',choices:[{message:{content:'{"verdicts":[]}'}}]},provider_errors:['decider unavailable']};
 const routed=execute('Read Decider Results',[resolved,failed],{'Select Missing Checks':[request,other]});
 assert.ok(routed.every(r=>r.fallback===false));
 const collected=execute('Collect Verdicts',routed,{'Select Missing Checks':[request,other]})[0];
 assert.deepEqual(collected.verdicts.map(v=>v.cache_key),['key1','key2']);
 assert.equal(collected.verdicts.some(v=>v.cache_key==='other-key'),false);
 assert.ok(collected.statistics.provider_errors.includes('decider unavailable'));
 assert.equal(collected.verdicts[0].model,'strands-decider-2b');
});
