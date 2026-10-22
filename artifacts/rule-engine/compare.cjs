/** Offline replay of the existing generated CSV: no API calls, writes or emails. */
const fs=require('fs');const {performance}=require('perf_hooks');
const root=process.cwd();
const before=require(root+'/artifacts/rule-engine/baseline-rules.cjs').evaluatePair;
const after=require(root+'/n8n/code/matching/rules').evaluatePair;
const {referencedFacts,factBucket}=require(root+'/n8n/code/matching/facts');
const products=[...require(root+'/data/discovery/bankbazaar.json').products,...require(root+'/data/discovery/bajaj-finserv.json').products];
const lines=fs.readFileSync('samples/ui_benchmark_19000.csv','utf8').trim().split(/\r?\n/);
const headers=lines.shift().split(',');
const users=lines.map(line=>Object.fromEntries(line.split(',').map((value,i)=>[headers[i],['age','monthly_income','credit_score'].includes(headers[i])?Number(value):value])));
const oldFacts=['employment_status','employment_years','credit_score','monthly_income','age'];
function replay(evaluate,modern){
 const start=performance.now();const counts={candidate_pairs:0,eligible:0,likely:0,ineligible:0,needs_llm:0,model_applicants:0};const byProvider={};const unique=new Set();
 const profiles=products.map(p=>({rules:p.criteria?.eligibility_lines||[],facts:referencedFacts(p.criteria?.eligibility_lines||[]).filter(f=>oldFacts.includes(f))}));
 for(const user of users){let model=false;
  products.forEach((p,index)=>{
   const maturity=modern&&/maturity/i.test(JSON.stringify(p.criteria?.eligibility_lines||[]));
   if(!maturity&&((p.min_age!=null&&user.age<p.min_age)||(p.max_age!=null&&user.age>p.max_age)))return;
   if((p.min_monthly_income!=null&&user.monthly_income<p.min_monthly_income)||(p.max_monthly_income!=null&&user.monthly_income>p.max_monthly_income)||(p.min_credit_score!=null&&user.credit_score<p.min_credit_score)||(p.max_credit_score!=null&&user.credit_score>p.max_credit_score))return;
   const result=evaluate(user,p);counts.candidate_pairs++;counts[result.status]++;
   if(result.needs_llm){model=true;const profile=profiles[index];unique.add(JSON.stringify([profile.rules,factBucket(user,profile.facts)]));byProvider[p.provider]=(byProvider[p.provider]||0)+1;}
  });
  if(model)counts.model_applicants++;
 }
 return {...counts,unique_model_decisions:unique.size,model_pairs_by_provider:byProvider,seconds:Number(((performance.now()-start)/1000).toFixed(3))};
}
const report={applicants:users.length,products:products.length,potential_pairs:users.length*products.length,before:replay(before,false),after:replay(after,true),mode:'Offline, cold decision routing replay. No model responses, API calls or email sends were performed.'};
report.reduction_percent=Number((100*(1-report.after.needs_llm/report.before.needs_llm)).toFixed(2));
fs.writeFileSync('artifacts/rule-engine/comparison.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
