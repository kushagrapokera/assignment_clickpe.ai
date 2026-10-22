"""Record progress without confusing early matches with pipeline completion."""
import json,time,urllib.request
from pathlib import Path
from datetime import datetime,timezone
from app.config import get_settings
from app.db.session import get_database
root=Path('/app/artifacts/benchmark-19000');s=get_settings();db=get_database()
while not (root/'ui-upload.json').exists():time.sleep(1)
request=json.loads((root/'ui-upload.json').read_text());uid=request['upload_id'];history=[]
def metrics():
 r=urllib.request.Request('http://127.0.0.1:8000/internal/qualitative-metrics',headers={'x-relay-secret':s.n8n.relay_shared_secret})
 with urllib.request.urlopen(r,timeout=10) as response:return json.load(response)
deadline=time.monotonic()+1500
while True:
 u=db.fetch_one('SELECT * FROM ingestion_uploads WHERE upload_id=%s',(uid,))
 batches=db.fetch_all('SELECT batch_id,total_rows,accepted_rows,rejected_rows,created_at,matching_status,matching_started_at,fast_completed_at,matching_completed_at,matching_pending_pairs,notifications_completed_at FROM ingestion_batches WHERE upload_id=%s ORDER BY created_at',(uid,))
 counts=db.fetch_all('SELECT m.status,m.decided_by,count(*) AS count FROM matches m JOIN ingestion_batches b ON b.batch_id=m.batch_id WHERE b.upload_id=%s GROUP BY m.status,m.decided_by',(uid,))
 notifications=db.fetch_all('SELECT n.status,count(*) AS count FROM notifications n JOIN users u ON u.user_id=n.user_id JOIN ingestion_batches b ON b.batch_id=u.batch_id WHERE b.upload_id=%s GROUP BY n.status',(uid,))
 done=sum(bool(b['notifications_completed_at']) for b in batches)
 point={'at':datetime.now(timezone.utc).isoformat(),'fast_batches':sum(bool(b['fast_completed_at']) for b in batches),'matching_completed':sum(b['matching_status']=='completed' for b in batches),'notification_batches_completed':done,'matches':sum(c['count'] for c in counts),'notifications':notifications}
 history.append(point)
 report={'request':request,'upload':u,'batches':batches,'match_counts':counts,'notifications':notifications,'gateway':metrics(),'history':history}
 (root/'results.json').write_text(json.dumps(report,default=str,indent=2))
 print(json.dumps(point),flush=True)
 if len(batches)==38 and done==38:break
 if time.monotonic()>deadline:
  print('Benchmark monitoring timeout; unfinished runs are recorded.',flush=True);break
 time.sleep(10)
