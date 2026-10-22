"""Summarize persisted stage boundaries; overlapping batch times are not additive."""
import json,statistics
from datetime import datetime
from pathlib import Path
root=Path(__file__).resolve().parent
r=json.loads((root/'results.json').read_text())
a=json.loads((root/'discovery.json').read_text())
def date(value):return datetime.fromisoformat(value.replace('Z','+00:00'))
def seconds(start,end):return (date(end)-date(start)).total_seconds()
def distribution(values):return {key:round(value,3) for key,value in {'min':min(values),'mean':statistics.mean(values),'max':max(values)}.items()} if values else {}
batches=r['batches'];request=r['request'];upload=r['upload']
fast=[seconds(b['matching_started_at'],b['fast_completed_at']) for b in batches if b['fast_completed_at']]
qual=[seconds(b['fast_completed_at'],b['matching_completed_at']) for b in batches if b['matching_completed_at']]
notify=[seconds(b['matching_completed_at'],b['notifications_completed_at']) for b in batches if b['notifications_completed_at']]
summary={
 'upload_id':request['upload_id'],'rows':upload['total_rows'],'accepted':upload['accepted_rows'],'rejected':upload['rejected_rows'],'batches':len(batches),
 'discovery_seconds':seconds(a['execution']['started_at'],a['execution']['stopped_at']),
 'browser_upload_seconds':request['upload_response_seconds'],
 'queue_and_ingestion_seconds':seconds(upload['created_at'],upload['completed_at']),
 'first_fast_results_seconds':seconds(request['started_at'],min(b['fast_completed_at'] for b in batches if b['fast_completed_at'])),
 'all_fast_results_seconds':seconds(request['started_at'],max(b['fast_completed_at'] for b in batches if b['fast_completed_at'])),
 'matching_wall_seconds':seconds(request['started_at'],max(b['matching_completed_at'] for b in batches if b['matching_completed_at'])),
 'full_pipeline_seconds':seconds(request['started_at'],max(b['notifications_completed_at'] for b in batches if b['notifications_completed_at'])),
 'fast_lane_per_batch_seconds':distribution(fast),'qualitative_and_final_save_per_batch_seconds':distribution(qual),'notification_phase_per_batch_seconds':distribution(notify),
 'matches':sum(c['count'] for c in r['match_counts']),'match_counts':r['match_counts'],'notifications':r['notifications'],'gateway':r['gateway'],
 'cache_mode':'Existing persisted verdict cache reused; new uncached buckets exercised Decider and LLM fallback.',
 'complete':len(batches)==38 and all(b['notifications_completed_at'] for b in batches),
 'notes':['Fast and qualitative groups share an ingestion batch, but fast matches are persisted before provider calls.','Notification phase includes n8n scheduling and SMTP; inbox placement is not checked.','Worker retains a 10-second interval between matching batch triggers (37 pauses).','Per-batch durations overlap; do not sum them to infer elapsed time.']
}
(root/'summary.json').write_text(json.dumps(summary,indent=2))
lines=['# 19,000 applicant UI benchmark','',f"Upload: `{summary['upload_id']}`",'',f"Accepted: {summary['accepted']:,}; rejected: {summary['rejected']}; batches: {len(batches)}.",'','| Stage | Elapsed seconds |','|---|---:|']
for name,key in [('Discovery (separate run)','discovery_seconds'),('Browser upload','browser_upload_seconds'),('Queue and ingestion','queue_and_ingestion_seconds'),('First fast results after upload','first_fast_results_seconds'),('All fast results after upload','all_fast_results_seconds'),('All matching after upload','matching_wall_seconds'),('All notifications after upload','full_pipeline_seconds')]:lines.append(f'| {name} | {summary[key]:.2f} |')
lines.extend(['','| Per-batch phase | Min | Mean | Max |','|---|---:|---:|---:|'])
for name,key in [('Fast lane','fast_lane_per_batch_seconds'),('Qualitative checks and final save','qualitative_and_final_save_per_batch_seconds'),('Notifications','notification_phase_per_batch_seconds')]:
 d=summary[key];lines.append(f"| {name} | {d['min']:.2f}s | {d['mean']:.2f}s | {d['max']:.2f}s |")
lines.extend(['',f"Matches: {summary['matches']:,}. Notifications: {json.dumps(summary['notifications'])}.",'',f"Provider calls: {json.dumps(summary['gateway'])}.",'',summary['cache_mode'],'']+summary['notes'])
(root/'report.md').write_text('\n'.join(lines)+'\n')
print(json.dumps(summary,indent=2))
