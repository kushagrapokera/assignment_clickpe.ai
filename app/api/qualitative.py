"""Shared model request gate for all n8n batches in the single API process."""
from __future__ import annotations

import asyncio
import hmac
import json
import time
import urllib.error
import urllib.request
from typing import Any

from fastapi import APIRouter, Header, HTTPException
from app.config import get_settings

router = APIRouter()


class ModelGate:
    """Bound upstream calls, including fallback calls, and join identical work."""

    def __init__(self, concurrency: int = 2) -> None:
        self.slots = asyncio.Semaphore(concurrency)
        self.inflight: dict[str, asyncio.Task] = {}
        self.active = 0
        self.peak = 0
        self.calls = {"decider": 0, "llm": 0}
        self.failures = {"decider": 0, "llm": 0}
        self.joined = 0
        self.unavailable_until = {"decider": 0.0, "llm": 0.0}
        self.cooldown_seconds = 120
        self.queue_timeout = 10

    async def call(self, provider: str, body: dict[str, Any]) -> dict[str, Any]:
        key = provider + ':' + json.dumps(body, sort_keys=True, separators=(',', ':'))
        task = self.inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._limited(provider, body))
            self.inflight[key] = task
            def finished(done: asyncio.Task) -> None:
                self.inflight.pop(key, None)
                # Retrieve failures even when a caller disconnected.
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(finished)
        else:
            self.joined += 1
        return await asyncio.shield(task)

    async def _limited(self, provider: str, body: dict[str, Any]) -> dict[str, Any]:
        def check_available():
            if time.monotonic() < self.unavailable_until[provider]:
                raise HTTPException(status_code=503, detail=f'{provider} temporarily unavailable; decision remains under review')
        check_available()
        try:
            await asyncio.wait_for(self.slots.acquire(), timeout=self.queue_timeout)
        except TimeoutError as error:
            raise HTTPException(status_code=503, detail='model capacity busy; decision remains under review') from error
        try:
            check_available()
            self.active += 1
            self.peak = max(self.peak, self.active)
            self.calls[provider] += 1
            try:
                return await asyncio.to_thread(upstream, provider, body)
            except Exception:
                self.failures[provider] += 1
                self.unavailable_until[provider] = time.monotonic() + self.cooldown_seconds
                raise
            finally:
                self.active -= 1
        finally:
            self.slots.release()


def upstream(provider: str, body: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    headers = {"Content-Type": "application/json", "User-Agent": "LoanEligibilityEngine/1.0"}
    if provider == 'decider':
        url, timeout = 'https://api.decider.cloud/v1/systemone', 15
    else:
        url, timeout = settings.llm.base_url.rstrip('/') + '/v1/chat/completions', 30
        headers['Authorization'] = 'Bearer ' + settings.llm.api_key
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.load(response)
            break
        except urllib.error.HTTPError as error:
            if provider == 'decider' and error.code in (429, 503) and attempt == 0:
                time.sleep(0.5 * (attempt + 1))
                continue
            raise HTTPException(status_code=502, detail=f'{provider} returned HTTP {error.code}') from error
        except (OSError, ValueError) as error:
            if provider == 'decider' and attempt == 0:
                time.sleep(0.5)
                continue
            raise HTTPException(status_code=502, detail=f'{provider} request failed') from error
    if not isinstance(result, dict):
        raise HTTPException(status_code=502, detail=f'{provider} returned an invalid response')
    return result


gate = ModelGate()


def authenticate(secret: str) -> None:
    expected = get_settings().n8n.relay_shared_secret
    if not expected or not hmac.compare_digest(secret, expected):
        raise HTTPException(status_code=401, detail='invalid relay secret')


async def resolve_request(body: dict[str, Any]) -> dict[str, Any]:
    """Resolve one profile request independently; preserve successful buckets."""
    decider = body.get('decider')
    llm = body.get('llm')
    if not isinstance(decider, dict) or not isinstance(llm, dict):
        raise HTTPException(status_code=422, detail='decider and llm request bodies are required')
    questions = decider.get('questions') or {}
    if not isinstance(questions, dict) or not questions:
        raise HTTPException(status_code=422, detail='at least one question is required')
    errors = []
    valid = {}
    usage = {'prompt_tokens': 0, 'completion_tokens': 0}
    model = 'strands-decider-2b'
    # Each retry asks only unanswered questions, never successful neighbours.
    remaining = dict(questions)
    for attempt in range(2):
        try:
            response = await gate.call('decider', {**decider, 'questions': remaining})
            model = response.get('model') or model
            usage['prompt_tokens'] += int((response.get('usage') or {}).get('input_tokens', 0))
            usage['completion_tokens'] += int((response.get('usage') or {}).get('output_tokens', 0))
            answers = response.get('answers') or {}
            if not isinstance(answers, dict):
                answers = {}
            for label in remaining:
                answer = answers.get(label)
                if isinstance(answer, dict) and answer.get('type') == 'choice' and answer.get('choice') in ('likely_eligible', 'likely_ineligible', 'uncertain'):
                    valid[label] = {'bucket': label, 'verdict': answer['choice'], 'score': None,
                                    'reasons': [f"Decider classified supplied evidence as {answer['choice']}"]}
            remaining = {k: v for k, v in remaining.items() if k not in valid}
            if not remaining:
                break
            errors.append('decider: incomplete or invalid answers')
        except HTTPException as error:
            errors.append(str(error.detail))
            if error.status_code == 503:
                break
    # Fallback receives only failed buckets, retaining their original labels.
    if remaining:
        labels = list(remaining)
        fallback = dict(llm)
        fallback['messages'] = [*llm.get('messages', []), {'role': 'user', 'content':
            'Return verdicts ONLY for these bucket labels: ' + json.dumps(labels) +
            '. Other buckets have already been answered. Preserve the labels exactly.'}]
        try:
            response = await gate.call('llm', fallback)
            model = model + ' + ' + str(response.get('model') or 'llm-fallback')
            content = response['choices'][0]['message']['content']
            parsed = json.loads(content) if isinstance(content, str) else content
            if not isinstance(parsed, dict) or not isinstance(parsed.get('verdicts'), list):
                raise ValueError('invalid verdict response')
            for verdict in parsed.get('verdicts', []):
                if not isinstance(verdict, dict):
                    continue
                if verdict.get('bucket') in remaining and verdict.get('verdict') in ('likely_eligible', 'likely_ineligible', 'uncertain'):
                    valid[verdict['bucket']] = verdict
            for key in usage:
                usage[key] += int((response.get('usage') or {}).get(key, 0))
        except (HTTPException, KeyError, IndexError, TypeError, ValueError) as error:
            errors.append('llm: ' + str(getattr(error, 'detail', 'invalid response')))
    verdicts = [valid[k] for k in questions if k in valid]
    return {'resolved_response': {'model': model,
        'choices': [{'message': {'content': json.dumps({'verdicts': verdicts})}}], 'usage': usage},
        'provider_errors': errors, 'unanswered_labels': [k for k in questions if k not in valid]}


@router.post('/internal/qualitative/resolve')
async def resolve(body: dict[str, Any], x_relay_secret: str = Header(default='')) -> dict[str, Any]:
    authenticate(x_relay_secret)
    return await resolve_request(body)


@router.post('/internal/qualitative/{provider}')
async def qualitative(provider: str, body: dict[str, Any], x_relay_secret: str = Header(default='')) -> dict[str, Any]:
    authenticate(x_relay_secret)
    if provider not in ('decider', 'llm'):
        raise HTTPException(status_code=404, detail='unknown provider')
    return await gate.call(provider, body)


@router.get('/internal/qualitative-metrics')
async def metrics(x_relay_secret: str = Header(default='')) -> dict[str, Any]:
    authenticate(x_relay_secret)
    return {'active': gate.active, 'peak': gate.peak, 'calls': gate.calls,
            'failures': gate.failures, 'joined': gate.joined, 'inflight': len(gate.inflight),
            'provider_cooldown_seconds': {p: max(0, round(until-time.monotonic())) for p, until in gate.unavailable_until.items()}}
