"""The durable dispatch of the matching: attempts, recovery and the limit."""
import uuid

from app.matching.dispatch import MatchingDispatcher


def make_batch(database, matching_status='pending'):
    """Create a batch that the dispatcher can work on."""
    batch_id = str(uuid.uuid4())
    database.execute(
        "INSERT INTO ingestion_batches(batch_id,filename,status,matching_status) "
        "VALUES (%s,'dispatch-test.csv','completed',%s)",
        (batch_id, matching_status),
    )
    return batch_id


def test_a_batch_is_queued_once_and_only_once_claimed(database):
    batch_id = make_batch(database)
    dispatcher = MatchingDispatcher(database=database)
    try:
        first = dispatcher.enqueue(batch_id)
        second = dispatcher.enqueue(batch_id)
        assert first == second
        rows = database.fetch_all(
            'SELECT * FROM matching_dispatches WHERE batch_id=%s', (batch_id,)
        )
        assert len(rows) == 1 and rows[0]['status'] == 'pending'
        claimed = dispatcher.claim(10)
        assert [item.batch_id for item in claimed] == [batch_id]
        assert dispatcher.claim(10) == [], 'the batch was claimed twice'
    finally:
        database.execute('DELETE FROM matching_dispatches WHERE batch_id=%s', (batch_id,))
        database.execute('DELETE FROM ingestion_batches WHERE batch_id=%s', (batch_id,))


def test_a_failed_handover_is_remembered_and_tried_again(database):
    batch_id = make_batch(database)
    dispatcher = MatchingDispatcher(database=database)
    try:
        dispatcher.enqueue(batch_id)
        dispatch = dispatcher.claim(10)[0]
        dispatcher.mark_failed(dispatch, 'the workflow did not answer', retry_in=0)
        row = database.fetch_one(
            'SELECT * FROM matching_dispatches WHERE batch_id=%s', (batch_id,)
        )
        assert row['status'] == 'pending'
        assert row['last_error'] == 'the workflow did not answer'
        assert row['attempts'] == 1, 'the attempt is counted'
        again = dispatcher.claim(10)
        assert [item.batch_id for item in again] == [batch_id]
    finally:
        database.execute('DELETE FROM matching_dispatches WHERE batch_id=%s', (batch_id,))
        database.execute('DELETE FROM ingestion_batches WHERE batch_id=%s', (batch_id,))


def test_only_a_few_batches_run_at_the_same_time(database):
    batches = [make_batch(database) for _ in range(4)]
    dispatcher = MatchingDispatcher(database=database)
    try:
        for batch_id in batches:
            dispatcher.enqueue(batch_id)
        claimed = dispatcher.claim(2)
        assert len(claimed) == 2
        for dispatch in claimed:
            dispatcher.mark_dispatched(dispatch)
        assert dispatcher.running_count() == 2
        assert dispatcher.claim(2) == [], 'the limit was not enforced'
        # A finished batch frees its place.
        database.execute(
            "UPDATE ingestion_batches SET matching_status='completed' WHERE batch_id=%s",
            (claimed[0].batch_id,),
        )
        dispatcher.reconcile()
        assert dispatcher.running_count() == 1
        assert len(dispatcher.claim(2)) == 1
    finally:
        for batch_id in batches:
            database.execute('DELETE FROM matching_dispatches WHERE batch_id=%s', (batch_id,))
            database.execute('DELETE FROM ingestion_batches WHERE batch_id=%s', (batch_id,))


def test_an_unfinished_dispatch_is_found_again_after_a_restart(database):
    batch_id = make_batch(database, matching_status='running')
    dispatcher = MatchingDispatcher(database=database)
    try:
        dispatcher.enqueue(batch_id)
        dispatch = dispatcher.claim(10)[0]
        dispatcher.mark_dispatched(dispatch)
        assert dispatcher.recover() == 0, 'a running batch must not be sent again'
        row = database.fetch_one(
            'SELECT * FROM matching_dispatches WHERE batch_id=%s', (batch_id,)
        )
        assert row['status'] == 'dispatched' and row['attempts'] == 1
        # A batch that never started is handed over again.
        database.execute(
            "UPDATE ingestion_batches SET matching_status='pending' WHERE batch_id=%s",
            (batch_id,),
        )
        database.execute(
            "UPDATE matching_dispatches SET dispatched_at = NOW() - interval '10 minutes' "
            'WHERE batch_id=%s',
            (batch_id,),
        )
        assert dispatcher.recover() == 1
        row = database.fetch_one(
            'SELECT * FROM matching_dispatches WHERE batch_id=%s', (batch_id,)
        )
        assert row['status'] == 'pending'
    finally:
        database.execute('DELETE FROM matching_dispatches WHERE batch_id=%s', (batch_id,))
        database.execute('DELETE FROM ingestion_batches WHERE batch_id=%s', (batch_id,))


def test_a_batch_that_finished_closes_its_dispatch(database):
    batch_id = make_batch(database)
    dispatcher = MatchingDispatcher(database=database)
    try:
        dispatcher.enqueue(batch_id)
        dispatch = dispatcher.claim(10)[0]
        dispatcher.mark_dispatched(dispatch)
        database.execute(
            "UPDATE ingestion_batches SET matching_status='completed' WHERE batch_id=%s",
            (batch_id,),
        )
        assert dispatcher.reconcile() == 1
        row = database.fetch_one(
            'SELECT * FROM matching_dispatches WHERE batch_id=%s', (batch_id,)
        )
        assert row['status'] == 'completed' and row['completed_at'] is not None
    finally:
        database.execute('DELETE FROM matching_dispatches WHERE batch_id=%s', (batch_id,))
        database.execute('DELETE FROM ingestion_batches WHERE batch_id=%s', (batch_id,))


def test_a_failed_batch_is_not_retried_for_ever(database):
    batch_id = make_batch(database)
    dispatcher = MatchingDispatcher(database=database)
    try:
        dispatcher.enqueue(batch_id)
        dispatch = dispatcher.claim(10)[0]
        for _ in range(5):
            dispatcher.mark_failed(dispatch, 'the workflow is down')
        row = database.fetch_one(
            'SELECT * FROM matching_dispatches WHERE batch_id=%s', (batch_id,)
        )
        assert row['status'] == 'failed'
        assert dispatcher.claim(10) == [], 'a broken batch blocked the queue'
    finally:
        database.execute('DELETE FROM matching_dispatches WHERE batch_id=%s', (batch_id,))
        database.execute('DELETE FROM ingestion_batches WHERE batch_id=%s', (batch_id,))
