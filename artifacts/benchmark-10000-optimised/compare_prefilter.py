"""Compare the SQL pre-filter of the old pipeline with the one of the evaluator.

The old pipeline let the database build the candidate pairs; the new one
builds them in the evaluator.  Both have to consider exactly the same pairs,
otherwise the eligibility outcomes would change.

Usage::

    python3 artifacts/benchmark-10000-optimised/compare_prefilter.py
"""
import json
import os
import subprocess
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.db.session import get_database

ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault('LOAN_ENGINE_ROOT', str(ROOT))
db = get_database()
batch = db.fetch_value("SELECT batch_id FROM ingestion_batches WHERE upload_id='e4f86b40-1183-4703-a885-2f9203e20971' ORDER BY created_at DESC LIMIT 1")
sql = """
SELECT u.user_id, p.product_id
FROM users u
JOIN loan_products p ON p.active
WHERE u.batch_id = '%s'::uuid
  AND (p.min_age IS NULL OR u.age >= p.min_age OR COALESCE(p.criteria->'eligibility_lines','[]'::jsonb)::text ILIKE '%%maturity%%')
  AND (p.max_age IS NULL OR u.age <= p.max_age OR COALESCE(p.criteria->'eligibility_lines','[]'::jsonb)::text ILIKE '%%maturity%%')
  AND (p.min_credit_score IS NULL OR u.credit_score >= p.min_credit_score)
  AND (p.max_credit_score IS NULL OR u.credit_score <= p.max_credit_score)
  AND (p.min_monthly_income IS NULL OR u.monthly_income >= p.min_monthly_income)
  AND (p.max_monthly_income IS NULL OR u.monthly_income <= p.max_monthly_income)
""" % batch
sql_pairs = {(r['user_id'], int(r['product_id'])) for r in db.fetch_all(sql)}

applicants = db.fetch_all("SELECT user_id,email,monthly_income,credit_score,employment_status,age,city,existing_emi,eligibility_facts,batch_id FROM users WHERE batch_id=%s", (batch,))
products = db.fetch_all("SELECT product_id,product_key,product_name,provider,min_age,max_age,min_monthly_income,max_monthly_income,min_credit_score,max_credit_score,min_employment_years,required_employment_statuses,criteria_signature,criteria FROM loan_products WHERE active")
def plain(row):
    out = {}
    for key, value in row.items():
        if hasattr(value, 'isoformat'):
            out[key] = value.isoformat()
        elif isinstance(value, (int, float, str, bool)) or value is None:
            out[key] = value
        elif isinstance(value, (list, tuple)):
            out[key] = [str(item) for item in value]
        else:
            out[key] = str(value)
    return out
users = [plain(row) for row in applicants]
prods = [plain(row) for row in products]

script = """
const {preFilter}=require(process.env.LOAN_ENGINE_ROOT + '/n8n/code/matching/candidates.js');
const users=JSON.parse(process.argv[1]); const products=JSON.parse(process.argv[2]);
const out=[];
for(const u of users) for(const p of products){ if(preFilter(u,p).candidate) out.push([u.user_id, Number(p.product_id)]); }
process.stdout.write(JSON.stringify(out));
"""
Path('/tmp/cmp_users.json').write_text(json.dumps(users))
Path('/tmp/cmp_products.json').write_text(json.dumps(prods))
script = """
const {preFilter}=require(process.env.LOAN_ENGINE_ROOT + '/n8n/code/matching/candidates.js');
const fs=require('fs');
const users=JSON.parse(fs.readFileSync('/tmp/cmp_users.json','utf8'));
const products=JSON.parse(fs.readFileSync('/tmp/cmp_products.json','utf8'));
const out=[];
for(const u of users) for(const p of products){ if(preFilter(u,p).candidate) out.push([u.user_id, Number(p.product_id)]); }
process.stdout.write(JSON.stringify(out));
"""
result = subprocess.run(['node','-e',script],capture_output=True,text=True,check=True)
js_pairs = {(u, p) for u, p in json.loads(result.stdout)}
print('sql candidates', len(sql_pairs), 'js candidates', len(js_pairs))
print('only in sql:', len(sql_pairs - js_pairs), list(sql_pairs - js_pairs)[:5])
print('only in js :', len(js_pairs - sql_pairs), list(js_pairs - sql_pairs)[:5])

# The old pipeline recorded the pairs that the pre-filter dropped as rejections.
old_filtered_sql = """
SELECT count(*) FROM users u CROSS JOIN loan_products p
WHERE u.batch_id = '%s'::uuid AND p.active
  AND ((p.min_age IS NOT NULL AND u.age < p.min_age)
    OR (p.max_age IS NOT NULL AND u.age > p.max_age)
    OR (p.min_credit_score IS NOT NULL AND u.credit_score < p.min_credit_score)
    OR (p.max_credit_score IS NOT NULL AND u.credit_score > p.max_credit_score)
    OR (p.min_monthly_income IS NOT NULL AND u.monthly_income < p.min_monthly_income)
    OR (p.max_monthly_income IS NOT NULL AND u.monthly_income > p.max_monthly_income))
""" % batch
old_filtered = db.fetch_value(old_filtered_sql)
script2 = """
const {preFilter}=require(process.env.LOAN_ENGINE_ROOT + '/n8n/code/matching/candidates.js');
const fs=require('fs');
const users=JSON.parse(fs.readFileSync('/tmp/cmp_users.json','utf8'));
const products=JSON.parse(fs.readFileSync('/tmp/cmp_products.json','utf8'));
let rejected=0, skipped=0;
for(const u of users) for(const p of products){ const f=preFilter(u,p); if(f.candidate) continue; if(f.rejected) rejected+=1; else skipped+=1; }
process.stdout.write(JSON.stringify({rejected,skipped}));
"""
result2 = subprocess.run(['node','-e',script2],capture_output=True,text=True,check=True)
js_filtered = json.loads(result2.stdout)
print('old filtered rejections', old_filtered, '| js rejections', js_filtered['rejected'], '| js pairs without a decision', js_filtered['skipped'])
