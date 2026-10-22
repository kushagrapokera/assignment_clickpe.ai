"""Paginated applicant decisions for the two processing lanes."""
from uuid import UUID
from fastapi import APIRouter, HTTPException, Query
from app.db.session import Database

router = APIRouter()


def applicant_status(row: dict) -> str:
    if row['eligible_count']:
        return 'eligible'
    if row['review_count']:
        return 'review'
    if row['pending_count']:
        return 'pending'
    return 'ineligible'


def email_status(row: dict, batch: dict) -> str:
    if row.get('recorded_email_status'):
        return row['recorded_email_status']
    if batch.get('notifications_completed_at'):
        return 'not_sent'
    if not batch.get('matching_started_at') and batch.get('status') == 'completed':
        return 'not_recorded'
    if not row.get('can_receive_email', row['eligible_count'] or row['review_count'] or row['pending_count']):
        return 'not_sent'
    return 'pending'


@router.get('/api/batches/{batch_id}/applicants')
def applicants(batch_id: UUID, lane: str = Query(pattern='^(rules|qualitative)$'),
               offset: int = Query(default=0, ge=0), limit: int = Query(default=25, ge=1, le=100),
               q: str = Query(default='', max_length=100)) -> dict:
    database = Database()
    try:
        batch = database.fetch_one('SELECT * FROM ingestion_batches WHERE batch_id=%s', (str(batch_id),))
        if not batch:
            raise HTTPException(status_code=404, detail='unknown batch')
        params = (str(batch_id), lane, '%' + q.strip() + '%', '%' + q.strip() + '%')
        scoped = '''WITH batch_decisions AS MATERIALIZED (
          SELECT * FROM ui_decisions WHERE batch_id=%s
        ), batch_lanes AS (
          SELECT batch_id,user_id,
            CASE WHEN bool_or(lane='qualitative') THEN 'qualitative' ELSE 'rules' END AS lane
          FROM batch_decisions GROUP BY batch_id,user_id
        ) '''
        where = "d.batch_id=%s AND a.lane=%s AND (u.name ILIKE %s OR u.email ILIKE %s)"
        source = ' FROM batch_decisions d JOIN batch_lanes a ON a.batch_id=d.batch_id AND a.user_id=d.user_id JOIN users u ON u.user_id=d.user_id '
        total = database.fetch_value(scoped + 'SELECT count(DISTINCT u.user_id)' + source + 'WHERE ' + where, (str(batch_id), *params))
        rows = database.fetch_all(scoped + '''
            , people AS (
              SELECT u.user_id,u.name,u.email,u.monthly_income,u.credit_score,u.age,u.employment_status,
                count(*) FILTER (WHERE d.status='eligible') AS eligible_count,
                count(*) FILTER (WHERE d.status='ineligible') AS ineligible_count,
                count(*) FILTER (WHERE d.status='review') AS review_count,
                count(*) FILTER (WHERE d.status='pending') AS pending_count,
                bool_and(d.recorded) AS complete_history,
                jsonb_agg(jsonb_build_object('provider',p.provider,'product',p.product_name,
                  'status',d.status,'lane',d.lane,'reasons',d.reasons) ORDER BY p.provider,p.product_id) AS decisions
              FROM batch_decisions d JOIN users u ON u.user_id=d.user_id
              JOIN batch_lanes a ON a.batch_id=d.batch_id AND a.user_id=d.user_id
              JOIN loan_products p ON p.product_id=d.product_id
              WHERE ''' + where + '''
              GROUP BY u.user_id ORDER BY u.name,u.user_id LIMIT %s OFFSET %s
            )
            SELECT people.*,n.status AS recorded_email_status,n.recipient,n.sent_at,n.error AS email_error,
              EXISTS (SELECT 1 FROM batch_decisions all_decisions
                WHERE all_decisions.batch_id=%s AND all_decisions.user_id=people.user_id
                  AND all_decisions.status IN ('eligible','review','pending')) AS can_receive_email
            FROM people LEFT JOIN LATERAL (
              SELECT status,recipient,sent_at,error FROM notifications
              WHERE user_id=people.user_id AND created_at >= %s
              ORDER BY notification_id DESC LIMIT 1
            ) n ON TRUE ORDER BY people.name,people.user_id
        ''', (str(batch_id), *params, limit, offset, str(batch_id), batch['created_at']))
        for row in rows:
            row['status'] = applicant_status(row)
            row['email_status'] = email_status(row, batch)
        return {'batch_id': str(batch_id), 'lane': lane, 'total': total, 'offset': offset,
                'limit': limit, 'applicants': rows}
    finally:
        database.close()
