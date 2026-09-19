from fastapi.testclient import TestClient
from backend import main, policies
from backend.db import PolicyVersion, SafetyEvaluation
from backend.tests.test_monitor import store
from backend.tests.test_policies import setup, save, activate, transition, read_job
from types import SimpleNamespace
import pytest

BASE = '/api/safety/policies'


@pytest.mark.parametrize(('effect', 'label'), [('review', 'Ask me'), ('judge', 'Send to judge')])
def test_explanation_uses_actual_winner_and_readable_connections(effect, label):
    def rule(id_, decision):
        return {'schema_version': 2, 'id': id_, 'name': id_, 'enabled': True,
                'connection_ids': ['opaque-connection-id'], 'activity': 'read',
                'roots': [], 'extensions': [], 'filenames': [], 'tool_name': '',
                'command_contains': '', 'effect': decision}
    version = SimpleNamespace(rules=[rule('first', effect), rule('allow', 'allow')])
    job = SimpleNamespace(id='job', created_at='now', snapshot={'action': '{"tool_name":"Read"}'}, result=None, rules={})
    item = policies.result_item(job, SimpleNamespace(title='Session'), SimpleNamespace(id='opaque-connection-id', name='My agent'), version,
                                {'decision': effect, 'rule_ids': ['first', 'allow'], 'reason': 'first'})
    assert label + ' takes priority over Automatic approval.' in item['explanation']
    assert 'Block takes' not in item['explanation']
    assert 'Matched selected connection: My agent' in item['matched_rules'][0]['conditions']
    assert 'Tool: Read' in item['matched_rules'][0]['conditions']
    assert 'opaque-connection-id' not in str(item['matched_rules'][0]['conditions'])


def test_pause_preserves_rules_and_draft_baseline(store, tmp_path):
    client = TestClient(main.app, base_url='http://localhost')
    rule = setup(store, tmp_path)
    id_ = save(client, rule); activate(client, id_)
    assert transition(client, None, 'disable').status_code == 200
    state = client.get(BASE).json()
    assert state['paused_id'] == id_ and state['active_id'] is None
    assert read_job(store, tmp_path, 'paused').status == 'queued'
    response = client.put(BASE + '/draft', json={'revision': state['revision'], 'name': 'Working draft', 'rules': [rule]})
    assert response.status_code == 200
    draft = response.json()['id']
    state = client.get(BASE).json()
    assert next(v for v in state['versions'] if v['id'] == draft)['changes'] == []
    assert transition(client, None, 'resume').status_code == 200
    state = client.get(BASE).json()
    assert state['active_id'] == id_ and state['paused_id'] is None
    assert read_job(store, tmp_path, 'resumed').decision == 'pass'


def test_past_results_paginate_search_filter_and_stay_frozen(store, tmp_path, monkeypatch):
    client = TestClient(main.app, base_url='http://localhost')
    rule = setup(store, tmp_path); id_ = save(client, rule)
    jobs = [read_job(store, tmp_path, f'read-{i}') for i in range(13)]
    with store() as db:
        db.get(SafetyEvaluation, jobs[0].id).snapshot = {'action': '[REDACTED]'}
        db.commit()
    client.post(f'{BASE}/versions/{id_}/preview')
    url = f'{BASE}/versions/{id_}/results'
    first = client.get(url, params={'limit': 10}).json()
    second = client.get(url, params={'offset': 10, 'limit': 10}).json()
    assert first['sampled'] == first['total'] == 13
    assert len(first['items']) == 10 and len(second['items']) == 3
    assert len({i['evaluation_id'] for i in first['items'] + second['items']}) == 13
    allowed = client.get(url, params={'decision': 'allow', 'q': 'README.md'}).json()
    assert allowed['total'] == 12 and allowed['counts']['unavailable'] == 1
    assert allowed['items'][0]['winner_id'] == rule['id']
    assert allowed['items'][0]['matched_rules'][0]['conditions']
    unavailable = client.get(url, params={'decision': 'unavailable'}).json()
    assert unavailable['total'] == 1 and unavailable['items'][0]['unavailable_reason']
    monkeypatch.setattr(policies, 'match', lambda *a, **kw: (_ for _ in ()).throw(AssertionError('Must not recompute')))
    (tmp_path / 'README.md').unlink()
    assert client.get(url, params={'decision': 'allow'}).json()['total'] == 12


def test_live_results_use_saved_evidence_and_legacy_preview_requires_retest(store, tmp_path, monkeypatch):
    client = TestClient(main.app, base_url='http://localhost')
    rule = setup(store, tmp_path); id_ = save(client, rule)
    client.post(f'{BASE}/versions/{id_}/preview')
    transition(client, id_, 'trial')
    job = read_job(store, tmp_path)
    monkeypatch.setattr(policies, 'match', lambda *a, **kw: (_ for _ in ()).throw(AssertionError('Must not recompute')))
    response = client.get(f'{BASE}/versions/{id_}/results', params={'mode': 'live'}).json()
    assert response['total'] == 1 and response['items'][0]['evaluation_id'] == job.id
    assert response['items'][0]['tool'] == 'Read' and response['items'][0]['decision'] == 'allow'
    with store() as db:
        db.get(PolicyVersion, id_).preview_result = {'sampled': 50, 'examples': []}
        db.commit()
    assert client.get(f'{BASE}/versions/{id_}/results').json()['rerun_required'] is True
