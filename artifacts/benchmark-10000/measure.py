import os,json,time
from pathlib import Path
from datetime import datetime
from app.config import get_settings
from app.db.session import get_database
from app.n8n.admin import N8nAdmin
from app.n8n.execution import decode_execution_data
root=Path('/app/artifacts/benchmark-10000');upload=json.loads((root/'ui-upload.json').read_text());uid=upload['upload_id'];start=upload['started_at']
s=get_settings(); db=get_database();a=N8nAdmin(s.n8n.api_url);a.login(os.environ['N8N_OWNER_EMAIL'],os.environ['N8N_OWNER_PASSWORD'])
cache={}; deadline=time.monotonic()+1200
while True:
 u=db.fetch_one('SELECT * FROM ingestion_uploads WHERE upload_id=%s',(uid,))
 batches=db.fetch_all('SELECT * FROM ingestion_batches WHERE upload_id=%s ORDER BY created_at',(uid,));ids={str(b['batch_id']) for b in batches}
 matches=db.fetch_one('SELECT count(*) AS count FROM matches WHERE batch_id = ANY(%s::uuid[])',(list(ids),))['count'] if ids else 0
 notifications=db.fetch_all('SELECT n.status,count(*) AS count FROM notifications n JOIN users u ON u.user_id=n.user_id WHERE u.batch_id = ANY(%s::uuid[]) GROUP BY n.status',(list(ids),)) if ids else []
 for e in a.list_executions(100):
  if e.get('workflowId') not in ['2mGTgbVsT4YS25rH','bnSJ8tDGCTjNO8H7'] or str(e.get('startedAt','')) < start:continue
  eid=str(e['id'])
  if eid in cache and cache[eid]['status'] in ['success','error','crashed','canceled']:continue
  full=a.execution(eid);data=decode_execution_data(full.get('data'));rd=data.get('resultData') or {};runs=rd.get('runData') or {}
  batch=None
  for name in ['Matching Request','Notification Request']:
   for run in runs.get(name,[]):
    for branch in (run.get('data') or {}).get('main',[]):
     for item in branch or []:
      j=item.get('json') or {};batch=(j.get('body') or {}).get('batch_id') or j.get('batch_id') or batch
  if str(batch) not in ids:continue
  nodes={name:[{'milliseconds':r.get('executionTime'),'status':r.get('executionStatus')} for r in rr] for name,rr in runs.items()}
  smtp=[]
  for run in runs.get('Send Notification',[]):
   for branch in (run.get('data') or {}).get('main',[]):
    for item in branch or []:
     j=item.get('json') or {};smtp.append({k:j.get(k) for k in ['accepted','rejected','response','messageId','error']})
  cache[eid]={'id':eid,'workflow_id':e['workflowId'],'batch_id':batch,'status':full.get('status',e.get('status')),'started_at':full.get('startedAt',e.get('startedAt')),'stopped_at':full.get('stoppedAt',e.get('stoppedAt')),'nodes':nodes,'smtp':smtp,'error':(rd.get('error') or {}).get('message')}
 report={'upload_request':upload,'upload':u,'batches':batches,'matches':matches,'notifications':notifications,'executions':list(cache.values()),'measured_at':datetime.now().astimezone().isoformat()}
 (root/'results.json').write_text(json.dumps(report,default=str,indent=2))
 done=sum(e['status']=='success' and e['workflow_id']=='bnSJ8tDGCTjNO8H7' for e in cache.values())
 print(json.dumps({'batches':len(batches),'matches':matches,'notifications':notifications,'notification_workflows_finished':done}),flush=True)
 if (len(batches)==20 and done==20) or time.monotonic()>deadline:break
 time.sleep(10)
