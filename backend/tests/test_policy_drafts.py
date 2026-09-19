from fastapi.testclient import TestClient
from sqlalchemy import select
from backend import main
from backend.db import PolicyVersion
from backend.tests.test_monitor import store
from backend.tests.test_policies import setup, transition

BASE = '/api/safety/policies'

def state(client):
    return client.get(BASE).json()

def draft(client, rules):
    response = client.put(BASE + '/draft', json={'revision': state(client)['revision'], 'name': 'Working draft', 'rules': rules})
    assert response.status_code == 200, response.text
    return response.json()['id']

def test_draft_edits_are_stable_until_tested_and_restore_is_explicit(store, tmp_path):
    client = TestClient(main.app, base_url='http://localhost')
    rule = setup(store, tmp_path)
    first = draft(client, [rule])
    rule['name'] = 'Documentation'
    assert draft(client, [rule]) == first
    assert state(client)['draft_id'] == first
    with store() as db:
        assert len(list(db.scalars(select(PolicyVersion)))) == 1
    preview = client.post(f'{BASE}/versions/{first}/preview').json()
    assert state(client)['versions'][0]['preview_result'] == preview
    assert transition(client, first, 'trial').status_code == 200
    assert draft(client, [rule]) == first
    assert state(client)['trial_id'] == first
    assert state(client)['versions'][0]['preview_result'] == preview
    rule['effect'] = 'review'
    second = draft(client, [rule])
    assert second != first
    assert state(client)['trial_id'] is None
    with store() as db:
        assert db.get(PolicyVersion, first).rules[0]['effect'] == 'allow'
        assert db.get(PolicyVersion, second).previewed_at is None
    client.post(f'{BASE}/versions/{second}/preview')
    assert transition(client, second, 'activate').status_code == 200
    assert state(client)['draft_id'] is None

    rule['name'] = 'New title'
    third = draft(client, [rule])
    item = next(v for v in state(client)['versions'] if v['id'] == third)
    assert item['changes'][0]['kind'] == 'changed'
    assert item['changes'][0]['before']['name'] == 'Documentation'
    payload = {'revision': state(client)['revision'], 'version_id': second}
    assert client.post(BASE + '/draft/restore', json=payload).status_code == 409
    assert client.delete(BASE + '/draft', params={'revision': state(client)['revision']}).status_code == 200
    assert state(client)['draft_id'] is None
    payload['revision'] = state(client)['revision']
    restored = client.post(BASE + '/draft/restore', json=payload)
    assert restored.status_code == 201
    assert restored.json()['id'] != second
    assert state(client)['active_id'] == second
    assert next(v for v in state(client)['versions'] if v['id'] == restored.json()['id'])['changes'] == []

def test_stale_edit_preview_discard_and_empty_draft(store, tmp_path):
    client = TestClient(main.app, base_url='http://localhost')
    rule = setup(store, tmp_path)
    id_ = draft(client, [rule])
    stale = state(client)['revision']
    assert draft(client, []) == id_
    assert client.post(f'{BASE}/versions/{id_}/preview', params={'revision': stale}).status_code == 409
    assert client.delete(BASE + '/draft', params={'revision': stale}).status_code == 409
    assert client.put(BASE + '/draft', json={'revision': stale, 'name': 'Working draft', 'rules': [rule]}).status_code == 409
    client.post(f'{BASE}/versions/{id_}/preview')
    transition(client, id_, 'trial')
    client.delete(BASE + '/draft', params={'revision': state(client)['revision']})
    assert state(client)['trial_id'] is None
    assert state(client)['draft_id'] is None


def test_rule_changes_describe_added_removed_and_edited_rules():
    from backend.policies import PolicyRule, rule_changes
    original = PolicyRule(id='shell', name='Shell review', activity='shell', effect='review').model_dump()
    changed = {**original, 'effect': 'deny'}
    added = {**original, 'id': 'push', 'name': 'Push review', 'activity': 'git_push'}
    diff = rule_changes([original], [changed, added])
    assert [(r['id'], r['kind']) for r in diff] == [('shell', 'changed'), ('push', 'added')]
    assert diff[0]['before']['effect'] == 'review' and diff[0]['after']['effect'] == 'deny'
    assert rule_changes([original], [])[0]['kind'] == 'removed'


def test_simulation_is_optional_for_live_trial_and_application(store, tmp_path):
    client = TestClient(main.app, base_url='http://localhost')
    version = draft(client, [setup(store, tmp_path)])
    assert transition(client, version, 'trial').status_code == 200
    assert transition(client, version, 'activate').status_code == 200
    assert state(client)['active_id'] == version
    assert state(client)['draft_id'] is None
