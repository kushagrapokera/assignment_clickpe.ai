"""Optional evidence must survive ingestion, and replay must remove stale matches."""
import json
import subprocess
import uuid
from pathlib import Path
from datetime import datetime,timezone
from app.ingestion.csv_parser import validate_row
from app.ingestion.store import create_batch,store_rows


def applicant(**extra):
    return dict(user_id=str(uuid.uuid4()),name='Policy Test',email='policy@example.test',monthly_income='30000',credit_score='780',employment_status='Salaried',age='30',**extra)


def render(query, **values):
    """Replace the placeholders of an n8n statement with real values."""
    for key, value in values.items():
        literal = str(value)
        query = query.replace('{{ $json.%s }}' % key, literal)
        query = query.replace("{{ $('Validate Request').first().json.%s }}" % key, literal)
        query = query.replace('{{ $("Validate Request").first().json.%s }}' % key, literal)
    return query


def prefilter(user, product):
    """Ask the module of the evaluator what the pre-filter does with a pair."""
    script = (
        "const {preFilter}=require('./n8n/code/matching/candidates.js');"
        "process.stdout.write(JSON.stringify(preFilter("
        "JSON.parse(process.argv[1]),JSON.parse(process.argv[2]))));"
    )
    result = subprocess.run(
        ['node', '-e', script, json.dumps(user), json.dumps(product)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def catalogue_product(database, **fields):
    """Insert a throw away product and remove it again afterwards."""
    row = database.fetch_one(
        "INSERT INTO loan_products(product_key,product_name,provider,source_id,source_url,"
        "criteria_signature,min_age,max_age,criteria) "
        "VALUES (%s,%s,'Test','test','https://example.test','test',%s,%s,%s) RETURNING product_id",
        (
            str(uuid.uuid4()),
            fields.get('product_name', 'Test'),
            fields.get('min_age'),
            fields.get('max_age'),
            json.dumps(fields.get('criteria', {})),
        ),
    )
    return row['product_id']


def test_optional_evidence_is_validated_and_persisted(database):
    row,error=validate_row(applicant(employment_years='4',current_employer_years='1.5',state='MP',profit_after_tax_last_two_years='[100,-10]'))
    assert error is None
    batch=create_batch(database,filename='policy.csv')
    store_rows(batch,[row],database)
    facts=database.fetch_value('SELECT eligibility_facts FROM users WHERE user_id=%s',(row['user_id'],))
    assert facts=={'employment_years':4.0,'current_employer_years':1.5,'state':'MP','profit_after_tax_last_two_years':[100,-10]}
    plain,error=validate_row(applicant());plain['user_id']=row['user_id']
    store_rows(batch,[plain],database)
    assert database.fetch_value('SELECT eligibility_facts FROM users WHERE user_id=%s',(row['user_id'],))=={}
    for extras in [{'business_years':'-1'},{'requested_tenure_months':'0'},{'requested_tenure_months':'1.5'},{'profit_after_tax_last_two_years':'[100]'},{'employment_years':'nan'}]:
        assert validate_row(applicant(**extras))[1]


def test_prefilter_does_not_drop_maturity_age_and_preserves_evidence(database):
    batch=create_batch(database,filename='maturity.csv')
    row,error=validate_row({**applicant(requested_tenure_months='24'), 'age':'20','city':'Pune'})
    assert error is None
    store_rows(batch,[row],database)
    product=catalogue_product(database,product_name='Maturity',min_age=22,max_age=60,
                               criteria={'eligibility_lines':['Age limit for salaried - 22-60 at the time of loan maturity']})
    try:
        stored=database.fetch_one('SELECT * FROM loan_products WHERE product_id=%s',(product,))
        catalogue={key:stored[key] for key in
                   ('product_id','min_age','max_age','min_credit_score','max_credit_score',
                    'min_monthly_income','max_monthly_income','criteria')}
        applicant_row=dict(row)
        applicant_row['age']=20
        applicant_row['city']='Pune'
        applicant_row['requested_tenure_months']=24
        # A lender that publishes an age at maturity is not filtered by the current age.
        outcome=prefilter(applicant_row,catalogue)
        assert outcome['candidate'] is True and outcome['rejected'] is False
        # A lender with a plain age bound still rejects the applicant.
        strict=dict(catalogue);strict['criteria']={'eligibility_lines':['Age 22-60']}
        assert prefilter(applicant_row,strict)['rejected'] is True
        # The evidence of the applicant survives the ingestion.
        facts=database.fetch_value('SELECT eligibility_facts FROM users WHERE user_id=%s',(row['user_id'],))
        assert facts['requested_tenure_months']==24
        assert database.fetch_value('SELECT city FROM users WHERE user_id=%s',(row['user_id'],))=='Pune'
    finally:
        database.execute('DELETE FROM loan_products WHERE product_id=%s',(product,))


def test_persist_sql_records_the_decision_and_the_confirmed_match(database):
    batch=create_batch(database,filename='maturity.csv')
    row,error=validate_row({**applicant(requested_tenure_months='24'), 'age':'20','city':'Pune'})
    store_rows(batch,[row],database)
    product=catalogue_product(database,product_name='Maturity',min_age=22,max_age=60,
                               criteria={'eligibility_lines':['Age limit for salaried - 22-60 at the time of loan maturity']})
    try:
        workflow=json.loads(Path('n8n/workflows/workflow_b_matching.json').read_text())
        query=next(n for n in workflow['nodes'] if n['name']=='Persist Fast Matches')['parameters']['query']
        payload=[dict(batch_id=batch,user_id=row['user_id'],product_id=product,lane='rules',status='eligible',reasons=[])]
        query=render(query,decisions_sql="'"+json.dumps(payload)+"'",pending_pairs=0,is_last='true',
                     batch_id=batch,persist_started_at=datetime.now(timezone.utc).isoformat())
        database.fetch_all(query)
        assert database.fetch_value('SELECT status FROM matching_decisions WHERE batch_id=%s AND product_id=%s',(batch,product))=='eligible'
        assert database.fetch_value('SELECT count(*) FROM matches WHERE batch_id=%s',(batch,))==1
    finally:
        database.execute('DELETE FROM loan_products WHERE product_id=%s',(product,))


def test_final_save_removes_obsolete_positive_matches(database):
    batch=create_batch(database,filename='stale.csv')
    row,error=validate_row(applicant());store_rows(batch,[row],database)
    product=catalogue_product(database,product_name='Stale')
    try:
        database.execute("INSERT INTO matches(user_id,product_id,batch_id,status,decided_by) VALUES (%s,%s,%s,'eligible','rules')",(row['user_id'],product,batch))
        database.execute("INSERT INTO matching_decisions(batch_id,user_id,product_id,lane,status) VALUES (%s,%s,%s,'rules','ineligible')",(batch,row['user_id'],product))
        workflow=json.loads(Path('n8n/workflows/workflow_b_matching.json').read_text())
        query=next(n for n in workflow['nodes'] if n['name']=='Mark Matching Complete')['parameters']['query']
        query=render(query,batch_id=batch)
        database.fetch_all(query)
        assert database.fetch_value('SELECT count(*) FROM matches WHERE batch_id=%s',(batch,))==0
    finally:
        database.execute('DELETE FROM loan_products WHERE product_id=%s',(product,))
