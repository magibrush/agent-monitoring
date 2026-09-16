import pytest
from pathlib import Path
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend import main
from backend.db import ChatSession, Checkpoint, Connection, Event
from backend.providers import codex_source
from backend.tests.test_monitor import store, record, transcript


@pytest.mark.parametrize('metadata,expected', [
    ({'originator': 'Codex Desktop', 'source': 'vscode'}, 'desktop'),
    ({'originator': 'codex_cli_rs', 'source': 'cli'}, 'cli'),
    ({'originator': 'codex-tui', 'source': 'cli'}, 'cli'),
    ({'originator': 'future-cli-label', 'source': 'cli'}, 'cli'),
    ({'originator': 'codex-tui', 'source': 'vscode'}, None),
    ({'originator': 'codex_cli_rs', 'source': 'exec'}, 'cli'),
    ({'originator': 'codex_cli_rs', 'source': {'subagent': {'other': 'guardian'}}}, 'cli'),
    ({'source': 'cli'}, 'cli'),
    ({'source': 'vscode'}, None),
    ({'originator': 'codex_cli_rs', 'source': 'vscode'}, None),
    ({'originator': 'some desktop wrapper'}, None),
    ({}, None),
])
def test_source_provenance(metadata, expected):
    assert codex_source(metadata) == expected


def test_shared_directory_profiles_and_resumed_identity(store, tmp_path):
    transcript(tmp_path / 'desktop.jsonl')
    transcript(tmp_path / 'cli.jsonl', 'codex_cli_rs')
    transcript(tmp_path / 'unknown.jsonl', 'unknown-client')
    client = TestClient(main.app, base_url='http://localhost')
    checked = client.post('/api/connections/check', json={'provider': 'codex_cli', 'path': str(tmp_path)}).json()
    assert checked == {'matching_sessions': 1, 'counts': {'desktop': 1, 'cli': 1, 'unknown': 1, 'pending': 0}}
    with store() as db:
        assert list(db.scalars(select(Checkpoint))) == []  # Check is read-only.
    ids = {}
    for provider in ('codex', 'codex_cli'):
        body = {'name': provider, 'provider': provider, 'path': str(tmp_path)}
        response = client.post('/api/connections', json=body)
        assert response.status_code == 201
        ids[provider] = response.json()['id']
        assert client.post('/api/connections', json=body).status_code == 409
        assert client.post(f"/api/connections/{ids[provider]}/sync").json()['status'] == 'watching'
    assert client.get('/api/metrics').json()['actions'] == 2
    cli = client.get('/api/sessions', params={'provider': 'codex_cli'}).json()['items']
    assert len(cli) == 1 and cli[0]['source'] == 'cli'
    assert client.get(f"/api/sessions/{cli[0]['id']}/events").json()['total'] == 3
    assert client.get('/api/metrics', params={'connection': ids['codex_cli'], 'q': 'repository'}).json()['messages'] == 1
    with (tmp_path / 'cli.jsonl').open('a', encoding='utf-8') as f:
        # Later client metadata must not change the transcript's creation provenance.
        f.write(record('session_meta', {'id': 'session-1', 'originator': 'Codex Desktop'}))
        f.write(record('response_item', {'type': 'message', 'role': 'assistant', 'content': 'Resumed response'}))
    main.synchronize()
    main.synchronize()
    assert client.get('/api/sessions', params={'provider': 'codex_cli'}).json()['items'][0]['id'] == cli[0]['id']
    assert client.get('/api/metrics', params={'provider': 'codex_cli'}).json()['messages'] == 2
    assert client.get('/api/metrics', params={'provider': 'codex'}).json()['messages'] == 1
    # Same external ID in another profile remains an independent Relay session.
    other = tmp_path / 'other-profile'
    other.mkdir()
    transcript(other / 'cli.jsonl', 'codex_cli_rs')
    c = client.post('/api/connections', json={'name': 'Other profile', 'provider': 'codex_cli', 'path': str(other)}).json()
    client.post(f"/api/connections/{c['id']}/sync")
    assert client.get('/api/metrics', params={'connection': c['id']}).json()['sessions'] == 1
    with store() as db:
        assert len(list(db.scalars(select(ChatSession)))) == 3


def test_cli_subagents_and_internal_reviews(store, tmp_path):
    for name, source in [('child', {'subagent': {'name': 'explorer'}}), ('review', {'subagent': {'other': 'guardian'}})]:
        (tmp_path / f'{name}.jsonl').write_text(
            record('session_meta', {'id': name, 'originator': 'codex_cli_rs', 'source': source, 'parent_thread_id': 'parent'})
            + record('response_item', {'type': 'message', 'role': 'user', 'content': 'Inspect repository'}), encoding='utf-8')
    client = TestClient(main.app, base_url='http://localhost')
    c = client.post('/api/connections', json={'name': 'CLI', 'provider': 'codex_cli', 'path': str(tmp_path)}).json()
    client.post(f"/api/connections/{c['id']}/sync")
    assert client.get('/api/sessions').json()['total'] == 1
    child = client.get('/api/sessions', params={'session_type': 'subagent'}).json()['items'][0]
    assert child['parent_thread_id'] == 'parent'
    assert client.get('/api/sessions', params={'include_internal': True}).json()['total'] == 2


def test_config_and_source_validation(store, tmp_path, monkeypatch):
    monkeypatch.setenv('CODEX_HOME', str(tmp_path))
    monkeypatch.setattr(Path, 'home', classmethod(lambda cls: tmp_path))
    client = TestClient(main.app, base_url='http://localhost')
    providers = client.get('/api/config').json()['providers']
    assert [p['id'] for p in providers] == ['codex', 'codex_cli', 'claude_code']
    assert all(p['default_path'] == str(tmp_path / 'sessions') for p in providers[:2])
    for provider, path in [('claude', tmp_path), ('codex_cli', tmp_path / 'missing')]:
        assert client.post('/api/connections/check', json={'provider': provider, 'path': str(path)}).status_code == 422
    (tmp_path / 'bad.jsonl').write_text('[]\n', encoding='utf-8')
    assert client.post('/api/connections/check', json={'provider': 'codex_cli', 'path': str(tmp_path)}).status_code == 422


def test_alternate_loopback_port_only_accepts_local_origins(store):
    client = TestClient(main.app, base_url='http://127.0.0.1:18000')
    assert client.get('/api/config', headers={'Origin': 'http://127.0.0.1:18000'}).status_code == 200
    assert client.get('/api/config', headers={'Origin': 'https://untrusted.example'}).status_code == 403


def test_current_cli_discovery_home_folder_and_existing_connection(store, tmp_path, monkeypatch):
    monkeypatch.setattr(Path, 'home', classmethod(lambda cls: tmp_path))
    monkeypatch.setenv('CODEX_HOME', str(tmp_path / '.codex'))
    root = tmp_path / '.codex'
    sessions = root / 'sessions'
    sessions.mkdir(parents=True)
    archive = root / 'archived_sessions'
    archive.mkdir()
    # Match metadata observed in installed Codex CLI 0.154.0.
    for folder in [sessions, archive]:
        (folder / 'cli.jsonl').write_text(record('session_meta', {
            'id': 'current-cli', 'originator': 'codex-tui', 'source': 'cli', 'cli_version': '0.154.0',
        }) + record('response_item', {'type': 'message', 'role': 'user', 'content': 'Real format fixture'}), encoding='utf-8')
    client = TestClient(main.app, base_url='http://localhost')
    config = client.get('/api/config').json()
    assert len(config['sources']) == 2
    assert all(s['counts']['cli'] == 1 for s in config['sources'])
    assert config['providers'][1]['default_path'] == str(sessions)
    c = client.post('/api/connections', json={'name': 'CLI', 'provider': 'codex_cli', 'path': str(root)}).json()
    assert c['path'] == str(sessions)
    assert client.get('/api/connections').json()[0]['session_count'] == 0
    assert client.post('/api/connections', json={'name': 'Duplicate', 'provider': 'codex_cli', 'path': str(sessions)}).status_code == 409
    main.synchronize()
    assert client.get('/api/connections').json()[0]['session_count'] == 1
    assert client.get('/api/sessions').json()['items'][0]['source'] == 'cli'
    main.synchronize()
    assert client.get('/api/metrics').json()['messages'] == 1


def test_delete_connection_preserves_files_and_other_connections(store, tmp_path):
    transcript(tmp_path / 'cli.jsonl', 'codex_cli_rs')
    transcript(tmp_path / 'desktop.jsonl')
    originals = {p: p.read_bytes() for p in tmp_path.glob('*.jsonl')}
    client = TestClient(main.app, base_url='http://localhost')
    ids = {}
    for provider in ('codex', 'codex_cli'):
        c = client.post('/api/connections', json={'name': provider, 'provider': provider, 'path': str(tmp_path)}).json()
        ids[provider] = c['id']
    main.synchronize()
    cli_session = client.get('/api/sessions', params={'provider': 'codex_cli'}).json()['items'][0]['id']
    assert client.delete('/api/connections/' + ids['codex_cli'], headers={'Origin': 'https://untrusted.example'}).status_code == 403
    assert client.delete('/api/connections/' + ids['codex_cli']).status_code == 200
    assert client.delete('/api/connections/' + ids['codex_cli']).status_code == 404
    with store() as db:
        assert db.get(Connection, ids['codex_cli']) is None
        assert not list(db.scalars(select(ChatSession).where(ChatSession.connection_id == ids['codex_cli'])))
        assert not list(db.scalars(select(Checkpoint).where(Checkpoint.connection_id == ids['codex_cli'])))
        assert not list(db.scalars(select(Event).where(Event.session_id == cli_session)))
    main.synchronize()
    assert client.get('/api/metrics').json()['sessions'] == 1
    assert client.get('/api/metrics').json()['actions'] == 1
    assert client.get(f'/api/sessions/{cli_session}/events').status_code == 404
    assert all(p.read_bytes() == content for p, content in originals.items())
    c = client.post('/api/connections', json={'name': 'Reconnected CLI', 'provider': 'codex_cli', 'path': str(tmp_path)}).json()
    assert c['id'] != ids['codex_cli']
    main.synchronize()
    assert client.get('/api/metrics').json()['sessions'] == 2
    assert client.get('/api/metrics').json()['actions'] == 2
