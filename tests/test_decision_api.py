"""Run against the isolated test schema, never the ingestion worker's queue."""
import json
import uuid
from pathlib import Path
from datetime import datetime, timezone
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.api.decisions import router


@pytest.fixture
def decisions(database):
    batch = str(uuid.uuid4())
    database.execute("INSERT INTO ingestion_batches(batch_id,filename,status,matching_status,matching_started_at,matching_completed_at,notifications_completed_at) VALUES (%s,'decision-test.csv','completed','completed',NOW(),NOW(),NOW())", (batch,))
    product_ids = []
    for i in range(2):
        row = database.fetch_one("INSERT INTO loan_products(product_key,product_name,provider,source_id,source_url,criteria_signature,min_age,min_monthly_income) VALUES (%s,%s,'Test Bank','test','https://example.test','test',21,25000) RETURNING product_id", (str(uuid.uuid4()), f'Test Product {i}'))
        product_ids.append(row['product_id'])
    users = [str(uuid.uuid4()) for _ in range(3)]
    for uid, name, age in zip(users, ['Alice Example', 'Bob Example', 'Carol Example'], [30, 18, 30]):
        database.execute("INSERT INTO users(user_id,name,email,age,monthly_income,batch_id) VALUES (%s,%s,%s,%s,30000,%s)", (uid, name, uid+'@example.test', age, batch))
    app = FastAPI(); app.include_router(router)
    try:
        with TestClient(app) as client:
            yield database, client, batch, users, product_ids
    finally:
        database.execute('DELETE FROM ingestion_batches WHERE batch_id=%s', (batch,))
        database.execute('DELETE FROM users WHERE user_id=ANY(%s)', (users,))
        database.execute('DELETE FROM loan_products WHERE product_id=ANY(%s)', (product_ids,))


def audit(db, batch, user, product, lane, status):
    db.execute('INSERT INTO matching_decisions(batch_id,user_id,product_id,lane,status) VALUES (%s,%s,%s,%s,%s)', (batch,user,product,lane,status))


def test_applicants_are_filtered_by_lane_with_real_rejections_and_shared_email(decisions):
    db, client, batch, users, products = decisions
    audit(db,batch,users[0],products[0],'rules','eligible')
    audit(db,batch,users[0],products[1],'qualitative','pending')
    audit(db,batch,users[1],products[0],'rules','ineligible')
    db.execute("INSERT INTO notifications(user_id,recipient,status,sent_at) VALUES (%s,'test@example.test','sent',NOW())", (users[0],))
    rows = client.get(f'/api/batches/{batch}/applicants?lane=rules').json()['applicants']
    assert [r['status'] for r in rows] == ['ineligible']
    assert rows[0]['user_id'] == users[1]
    assert rows[0]['email_status'] == 'not_sent'
    other = client.get(f'/api/batches/{batch}/applicants?lane=qualitative').json()['applicants']
    assert len(other) == 1 and other[0]['status'] == 'eligible'
    assert other[0]['pending_count'] == 1 and other[0]['eligible_count'] == 1
    assert {r['user_id'] for r in rows}.isdisjoint(r['user_id'] for r in other)
    assert other[0]['email_status'] == 'sent'  # Email is per applicant, not per loan.


def test_search_pagination_and_legacy_matches_do_not_invent_rejections(decisions):
    db, client, batch, users, products = decisions
    for uid in users:
        db.execute("INSERT INTO matches(user_id,product_id,batch_id,status,decided_by) VALUES (%s,%s,%s,'likely','llm')", (uid,products[0],batch))
    result = client.get(f'/api/batches/{batch}/applicants?lane=qualitative&limit=1&offset=1').json()
    assert result['total'] == 3 and result['applicants'][0]['name'] == 'Bob Example'
    assert result['applicants'][0]['status'] == 'review'
    assert result['applicants'][0]['ineligible_count'] == 0
    assert result['applicants'][0]['complete_history'] is False
    found = client.get(f'/api/batches/{batch}/applicants', params={'lane':'qualitative','q':'Alice'}).json()
    assert found['total'] == 1
    assert client.get(f'/api/batches/{batch}/applicants', params={'lane':'qualitative','q':"' OR TRUE --"}).json()['total'] == 0
    assert client.get(f'/api/batches/{batch}/applicants?lane=wrong').status_code == 422
    assert client.get(f'/api/batches/{batch}/applicants?lane=rules&limit=101').status_code == 422
    assert client.get(f'/api/batches/{uuid.uuid4()}/applicants?lane=rules').status_code == 404


def test_email_pending_is_shared_even_when_rules_reject_every_product(decisions):
    db, client, batch, users, products = decisions
    db.execute('UPDATE ingestion_batches SET matching_status=%s,notifications_completed_at=NULL WHERE batch_id=%s', ('qualitative',batch))
    audit(db,batch,users[0],products[0],'rules','ineligible')
    audit(db,batch,users[0],products[1],'qualitative','pending')
    assert client.get(f'/api/batches/{batch}/applicants?lane=rules').json()['total'] == 0
    row=client.get(f'/api/batches/{batch}/applicants?lane=qualitative').json()['applicants'][0]
    assert row['email_status']=='pending' and row['ineligible_count']==1


def render(query, **values):
    """Replace the placeholders of an n8n statement with real values."""
    for key, value in values.items():
        literal = str(value)
        query = query.replace('{{ $json.%s }}' % key, literal)
        query = query.replace("{{ $('Validate Request').first().json.%s }}" % key, literal)
        query = query.replace('{{ $("Validate Request").first().json.%s }}' % key, literal)
    return query


def test_fast_sql_records_the_decisions_and_stores_only_confirmed_matches(decisions):
    db, client, batch, users, products = decisions
    workflow = json.loads(Path('n8n/workflows/workflow_b_matching.json').read_text())
    query = next(n for n in workflow['nodes'] if n['name']=='Persist Fast Matches')['parameters']['query']
    payload = [dict(batch_id=batch,user_id=users[0],product_id=products[0],lane='rules',status='eligible',reasons=[]),
               dict(batch_id=batch,user_id=users[0],product_id=products[1],lane='qualitative',status='pending',reasons=[])]
    literal = "'"+json.dumps(payload).replace("'","''")+"'"
    query = render(query, decisions_sql=literal, pending_pairs=1, is_last='true',
                   batch_id=batch, persist_started_at=datetime.now(timezone.utc).isoformat())
    db.fetch_all(query)
    alice = client.get(f'/api/batches/{batch}/applicants?lane=qualitative&q=Alice').json()['applicants'][0]
    assert alice['status'] == 'eligible' and alice['pending_count'] == 1
    assert db.fetch_value('SELECT fast_completed_at IS NOT NULL FROM ingestion_batches WHERE batch_id=%s',(batch,))
    # Only the confirmed eligibility is stored as a match.
    assert db.fetch_value('SELECT count(*) FROM matches WHERE batch_id=%s',(batch,)) == 1
    # The request for missing information stays in the audit.
    assert db.fetch_value('SELECT status FROM matching_decisions WHERE batch_id=%s AND product_id=%s',(batch,products[1]))=='pending'


def test_upload_totals_count_each_applicant_once_and_exclude_unrouted_people(decisions):
    from app.api.app import get_upload
    db, client, batch, users, products = decisions
    upload=str(uuid.uuid4())
    db.execute("INSERT INTO ingestion_uploads(upload_id,filename,status,accepted_rows) VALUES (%s,'test.csv','completed',3)",(upload,))
    db.execute('UPDATE ingestion_batches SET upload_id=%s WHERE batch_id=%s',(upload,batch))
    audit(db,batch,users[0],products[0],'rules','eligible')
    audit(db,batch,users[0],products[1],'qualitative','pending')
    audit(db,batch,users[1],products[0],'rules','ineligible')
    lanes=get_upload(upload)['batches'][0]['lanes']
    assert lanes['rules']['applicants']==1 and lanes['qualitative']['applicants']==1
    assert lanes['qualitative']['total']==2  # Both loan decisions belong to Alice's group.
    assert sum(lane['applicants'] for lane in lanes.values())==2
    for lane in ['rules','qualitative']:
        assert client.get(f'/api/batches/{batch}/applicants?lane={lane}').json()['total']==lanes[lane]['applicants']


def test_summary_only_hides_groups_and_counts_actual_decision_lanes_at_completion(decisions):
    from app.api.app import get_upload
    db, client, batch, users, products = decisions
    upload = str(uuid.uuid4())
    db.execute("INSERT INTO ingestion_uploads(upload_id,filename,status,accepted_rows) VALUES (%s,'summary.csv','completed',3)", (upload,))
    db.execute('UPDATE ingestion_batches SET upload_id=%s WHERE batch_id=%s', (upload,batch))
    audit(db,batch,users[0],products[0],'rules','eligible')
    audit(db,batch,users[0],products[1],'qualitative','review')
    audit(db,batch,users[1],products[0],'rules','ineligible')
    answer = get_upload(upload, summary_only=True)
    assert answer['decision_counts'] == {'rules':2,'qualitative':1}
    assert 'lanes' not in answer['batches'][0]
    db.execute("UPDATE ingestion_batches SET matching_status='running' WHERE batch_id=%s", (batch,))
    assert get_upload(upload, summary_only=True)['decision_counts'] is None
