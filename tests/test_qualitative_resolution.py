"""Partial provider failure must never replace a successful neighbouring answer."""
import asyncio
import json
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from app.api.qualitative import resolve_request


def body():
    return {'decider': {'model': 'strands-decider-2b', 'state': 'rules',
                        'questions': {k: {'type': 'choice'} for k in ['b1', 'b2']}},
            'llm': {'model': 'fallback', 'messages': []}}


def verdicts(result):
    return json.loads(result['resolved_response']['choices'][0]['message']['content'])['verdicts']


def test_partial_decider_answers_retry_only_missing_questions():
    call = AsyncMock(side_effect=[
        {'answers': {'b1': {'type': 'choice', 'choice': 'likely_eligible'}}},
        {'answers': {'b2': {'type': 'choice', 'choice': 'uncertain'}}}])
    with patch('app.api.qualitative.gate.call', call):
        result = asyncio.run(resolve_request(body()))
    assert [v['verdict'] for v in verdicts(result)] == ['likely_eligible', 'uncertain']
    assert list(call.call_args_list[1].args[1]['questions']) == ['b2']
    assert all(c.args[0] == 'decider' for c in call.call_args_list)


def test_fallback_only_answers_missing_labels_and_cannot_overwrite_success():
    call = AsyncMock(side_effect=[
        {'answers': {'b1': {'type': 'choice', 'choice': 'likely_eligible'}}},
        {'answers': {}},
        {'model': 'llm', 'choices': [{'message': {'content': json.dumps({'verdicts': [
            {'bucket': 'b1', 'verdict': 'likely_ineligible'},
            {'bucket': 'b2', 'verdict': 'likely_ineligible'}]})}}]}])
    with patch('app.api.qualitative.gate.call', call):
        result = asyncio.run(resolve_request(body()))
    assert [v['verdict'] for v in verdicts(result)] == ['likely_eligible', 'likely_ineligible']
    assert '["b2"]' in call.call_args_list[2].args[1]['messages'][-1]['content']
    assert result['provider_errors']


def test_total_outage_returns_unanswered_without_fabricating_cached_verdicts():
    call = AsyncMock(side_effect=[HTTPException(503, 'decider offline'), HTTPException(503, 'llm offline')])
    with patch('app.api.qualitative.gate.call', call):
        result = asyncio.run(resolve_request(body()))
    assert verdicts(result) == []
    assert result['unanswered_labels'] == ['b1', 'b2']
    assert len(result['provider_errors']) == 2


def test_valid_uncertainty_does_not_trigger_retry_or_fallback():
    call = AsyncMock(return_value={'answers': {k: {'type': 'choice', 'choice': 'uncertain'} for k in ['b1','b2']}})
    with patch('app.api.qualitative.gate.call', call):
        result = asyncio.run(resolve_request(body()))
    assert len(verdicts(result)) == 2
    assert call.call_count == 1
    assert result['provider_errors'] == []
