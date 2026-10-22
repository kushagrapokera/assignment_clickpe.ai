"""The shared provider gate must bound requests and release slots on failure."""
import asyncio
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from fastapi import FastAPI
from app.api.qualitative import ModelGate, router


def test_gate_limits_both_providers_and_joins_identical_requests():
    lock = threading.Lock()
    active = 0
    peak = 0
    def fake(provider, body):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(active, peak)
        time.sleep(0.02)
        with lock:
            active -= 1
        return {'provider': provider}
    async def run():
        gate = ModelGate(2)
        with patch('app.api.qualitative.upstream', fake):
            results = await asyncio.gather(*(gate.call('decider' if i % 2 else 'llm', {'id': i}) for i in range(8)), gate.call('decider', {'id': 1}))
        assert len(results) == 9
        assert sum(gate.calls.values()) == 8
        assert gate.joined == 1
        assert gate.active == 0
        assert not gate.inflight
    asyncio.run(run())
    assert peak == 2


def test_gate_releases_slot_after_error():
    async def run():
        gate = ModelGate(1)
        with patch('app.api.qualitative.upstream', side_effect=[ValueError('bad response'), {'ok': True}]):
            try:
                await gate.call('decider', {'id': 1})
            except ValueError:
                pass
            else:
                assert False, 'failure must reach the caller for LLM fallback'
            assert await gate.call('llm', {'id': 2}) == {'ok': True}
        assert gate.failures['decider'] == 1
        assert gate.active == 0
    asyncio.run(run())


def test_gateway_requires_relay_secret_and_rejects_unknown_providers():
    app = FastAPI()
    app.include_router(router)
    settings = SimpleNamespace(n8n=SimpleNamespace(relay_shared_secret='test-secret'))
    with patch('app.api.qualitative.get_settings', return_value=settings), TestClient(app) as client:
        assert client.post('/internal/qualitative/decider', json={}).status_code == 401
        assert client.post('/internal/qualitative/unknown', json={}, headers={'x-relay-secret': 'test-secret'}).status_code == 404


def test_provider_outage_fails_fast_and_keeps_other_provider_available():
    async def run():
        gate = ModelGate(1)
        with patch('app.api.qualitative.upstream', side_effect=[ValueError('offline'), {'ok': True}]) as upstream:
            try:
                await gate.call('decider', {'id': 1})
            except ValueError:
                pass
            for i in range(2, 12):
                try:
                    await gate.call('decider', {'id': i})
                except Exception as error:
                    assert error.status_code == 503
                else:
                    assert False, 'unavailable provider must fail fast'
            assert upstream.call_count == 1
            assert await gate.call('llm', {}) == {'ok': True}
            gate.unavailable_until['decider'] = 0
            upstream.side_effect = None
            upstream.return_value = {'recovered': True}
            assert await gate.call('decider', {'id': 12}) == {'recovered': True}
        assert gate.active == 0
    asyncio.run(run())


def test_capacity_timeout_does_not_call_provider_or_leak_slot():
    async def run():
        gate = ModelGate(1)
        gate.queue_timeout = 0.01
        await gate.slots.acquire()
        with patch('app.api.qualitative.upstream') as upstream:
            try:
                await gate.call('decider', {})
            except Exception as error:
                assert error.status_code == 503
            else:
                assert False, 'queue wait must be bounded'
            upstream.assert_not_called()
        gate.slots.release()
        assert gate.active == 0
    asyncio.run(run())
