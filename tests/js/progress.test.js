const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function page(batch){
 const elements=new Map();let cleared=false;
 const document={addEventListener(){},querySelector(selector){
  if(!elements.has(selector))elements.set(selector,{textContent:'',innerHTML:'',hidden:true,style:{},setAttribute(){}});
  return elements.get(selector);
 }};
 const context=vm.createContext({document,clearInterval(){cleared=true;},fetch:async(url)=>({ok:true,json:async()=>url==='/api/products'?{products:[]}:{upload:{status:'completed',accepted_rows:500},batches:[batch]}})});
 vm.runInContext(fs.readFileSync('frontend/app.js','utf8'),context);
 return {context,elements,isCleared:()=>cleared};
}
test('early matches do not stop polling or claim that qualitative checks are done',async()=>{
 const p=page({matches:100,notifications:0,matching_status:'qualitative',fast_completed_at:'now',batch_id:'batch'});
 await vm.runInContext('poll()',p.context);
 assert.equal(p.isCleared(),false);
 assert.match(p.elements.get('#message').textContent,/Processing: 0\/1 batches completed/);
 assert.equal(p.elements.get('#matches-card').hidden,true);
 assert.match(p.elements.get('#status').innerHTML,/processing matches/);
});
test('matching completion still waits for the notification pass',async()=>{
 const p=page({matches:100,notifications:0,matching_status:'completed',fast_completed_at:'now',batch_id:'batch'});
 await vm.runInContext('poll()',p.context);
 assert.equal(p.isCleared(),false);
 assert.match(p.elements.get('#status').innerHTML,/sending notifications/);
});
test('zero-match batches can complete and stop polling',async()=>{
 const p=page({matches:0,notifications:0,matching_status:'completed',notifications_completed_at:'now',batch_id:'batch'});
 await vm.runInContext('poll()',p.context);
 assert.equal(p.isCleared(),true);
 assert.equal(p.elements.get('#matches-card').hidden,false);
 assert.match(p.elements.get('#message').textContent,/done: 500 applicants/);
});
