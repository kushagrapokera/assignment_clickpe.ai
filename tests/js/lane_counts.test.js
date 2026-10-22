const {test}=require('node:test');const assert=require('node:assert/strict');
const vm=require('node:vm');const fs=require('node:fs');
function run(){const context=vm.createContext({document:{addEventListener(){}}});vm.runInContext(fs.readFileSync('frontend/app.js','utf8'),context);return code=>vm.runInContext(code,context);}
test('unrouted batches are not duplicated into either group',()=>{
 const evaluate=run();evaluate("state.batches=[{batch_id:'queued',matching_status:'pending',lanes:{}}]");
 assert.equal(evaluate("visibleBatches('rules').length"),0);assert.equal(evaluate("visibleBatches('qualitative').length"),0);
});
test('applicant counts use group totals rather than 500-row batch size',()=>{
 const evaluate=run();evaluate("state.batches=[{total_rows:500,lanes:{rules:{applicants:70},qualitative:{applicants:430}}},{total_rows:120,lanes:{rules:{applicants:120}}}]");
 assert.equal(evaluate("laneApplicants('rules')"),190);assert.equal(evaluate("laneApplicants('qualitative')"),430);
 assert.equal(evaluate("visibleBatches('rules').length"),2);assert.equal(evaluate("visibleBatches('qualitative').length"),1);
});
