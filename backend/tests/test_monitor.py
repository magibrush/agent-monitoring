import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from backend import main
from backend.connectors import sync_codex
from backend.db import Base, ChatSession, Checkpoint, Connection, Event, make_engine


@pytest.fixture
def store(tmp_path, monkeypatch):
    engine = make_engine('sqlite:///' + (tmp_path / 'test.db').as_posix())
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(main, 'SessionLocal', factory)
    yield factory
    engine.dispose()


def record(type_, payload):
    return json.dumps({'type': type_, 'timestamp': datetime.now(timezone.utc).isoformat(), 'payload': payload}) + '\n'


def transcript(path, origin='Codex Desktop'):
    path.write_text(record('session_meta', {'id': 'session-1', 'originator': origin}) + record('response_item', {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'Inspect the repository'}]}) + record('event_msg', {'type': 'user_message', 'message': 'Inspect the repository'}) + record('response_item', {'type': 'function_call', 'name': 'exec_command', 'arguments': '{"cmd":"pwd"}', 'call_id': 'call-1'}) + record('response_item', {'type': 'function_call_output', 'output': 'workspace', 'call_id': 'call-1'}), encoding='utf-8')


def test_codex_restart_partial_writes_and_correlation(store, tmp_path):
    path = tmp_path / 'rollout.jsonl'
    transcript(path)
    with store() as db:
        c = Connection(name='Desktop', provider='codex', path=str(tmp_path))
        db.add(c); db.flush()
        assert sync_codex(db, c) == 3
        db.commit(); id_ = c.id
    # Restart with a fresh DB session and ensure no duplicate mirrored messages.
    with store() as db:
        c = db.get(Connection, id_)
        assert sync_codex(db, c) == 0
        tail = record('response_item', {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'All done'}]})
        with path.open('ab') as stream:
            stream.write(tail[:-1].encode())
        assert sync_codex(db, c) == 0
        with path.open('ab') as stream:
            stream.write(b'\n')
        assert sync_codex(db, c) == 1
        db.commit()
        assert db.scalar(select(func.count()).select_from(Event)) == 4
        tools = list(db.scalars(select(Event).where(Event.role == 'tool')))
        assert [t.tool_call_id for t in tools] == ['call-1', 'call-1']
        assert db.scalar(select(ChatSession.title)) == 'Inspect the repository'


def test_cli_is_excluded_and_truncation_is_detected(store, tmp_path):
    path = tmp_path / 'cli.jsonl'
    transcript(path, 'codex_cli_rs')
    with store() as db:
        c = Connection(name='Desktop', provider='codex', path=str(tmp_path)); db.add(c); db.flush()
        assert sync_codex(db, c) == 0
        transcript(path)
        assert sync_codex(db, c) == 3
        db.commit()
        path.write_text(record('session_meta', {'id': 'changed', 'originator': 'Codex Desktop'}), encoding='utf-8')
        with pytest.raises(ValueError, match='replaced or truncated'):
            sync_codex(db, c)


def test_session_title_index_and_literal_search(store, tmp_path):
    folder = tmp_path / 'sessions'
    folder.mkdir()
    transcript(folder / 'rollout.jsonl')
    (tmp_path / 'session_index.jsonl').write_text(json.dumps({'id': 'session-1', 'thread_name': 'Check 100% of C:\\work'}) + '\n', encoding='utf-8')
    with store() as db:
        c = Connection(name='Indexed', provider='codex', path=str(folder)); db.add(c); db.flush()
        sync_codex(db, c); db.commit()
    client = TestClient(main.app, base_url='http://localhost')
    assert client.get('/api/sessions', params={'q': 'C:\\work'}).json()['total'] == 1
    assert client.get('/api/sessions', params={'q': '100%'}).json()['items'][0]['title'] == 'Check 100% of C:\\work'
    assert client.get('/api/sessions', params={'q': '_'}).json()['total'] == 0


def test_api_workflow_filters_pagination_and_origin(store, tmp_path):
    transcript(tmp_path / 'rollout.jsonl')
    client = TestClient(main.app, base_url='http://localhost')
    body = {'name': 'Desktop', 'provider': 'codex', 'path': str(tmp_path)}
    response = client.post('/api/connections', json=body)
    assert response.status_code == 201
    c = response.json()
    assert client.post('/api/connections', json=body).status_code == 409
    assert client.post(f"/api/connections/{c['id']}/sync").json()['status'] == 'watching'
    assert client.post(f"/api/connections/{c['id']}/sync").status_code == 200
    metrics = client.get('/api/metrics').json()
    assert (metrics['sessions'], metrics['questions'], metrics['actions'], metrics['messages']) == (1, 1, 1, 1)
    sessions = client.get('/api/sessions', params={'q': 'repository', 'limit': 1}).json()
    assert sessions['total'] == 1
    id_ = sessions['items'][0]['id']
    assert client.get('/api/metrics', params={'session_ids': id_}).json()['messages'] == 1
    assert client.get('/api/metrics', params={'connection': 'missing'}).json()['messages'] == 0
    assert client.get('/api/metrics', params={'q': 'absent'}).json()['sessions'] == 0
    assert client.get('/api/sessions', params={'offset': 1}).json()['items'] == []
    assert client.get(f'/api/sessions/{id_}/events', params={'q': 'workspace', 'search_scope': 'all'}).json()['total'] == 1
    assert client.get(f'/api/sessions/{id_}/events', params={'offset': 1, 'limit': 1}).json()['items'][0]['role'] == 'tool'
    assert client.post('/api/connections', headers={'Origin': 'https://untrusted.example'}, json=body).status_code == 403
    assert client.get('/api/sessions/missing/events').status_code == 404
    assert client.post('/api/connections', json={**body, 'name': ' '}).status_code == 422
    assert client.get('/api/sessions', params={'offset': -1}).status_code == 422


def test_retired_provider_is_unavailable_and_history_stays_local(store):
    client = TestClient(main.app, base_url='http://localhost')
    assert client.post('/api/connections', json={'name': 'Retired', 'provider': 'claude'}).status_code == 422
    assert '/api/connections/{id_}/import' not in client.get('/openapi.json').json()['paths']
    with store() as db:
        c = Connection(name='Retired export', provider='claude'); db.add(c); db.flush()
        time = datetime.now(timezone.utc).isoformat()
        session = ChatSession(connection_id=c.id, external_id='old', title='Historical chat', created_at=time, updated_at=time, source='export')
        db.add(session); db.flush()
        db.add(Event(session_id=session.id, external_id='old-msg', kind='message', role='user', text='Old message', occurred_at=time, payload={}))
        db.commit(); id_ = session.id; connection_id = c.id
    assert client.get('/api/connections').json() == []
    assert client.get('/api/sessions').json()['total'] == 0
    assert client.get('/api/metrics').json()['messages'] == 0
    assert client.get(f'/api/sessions/{id_}/events').status_code == 404
    assert client.patch(f'/api/connections/{connection_id}', json={'enabled': True}).status_code == 404


def test_failed_sync_rolls_back_and_pause_stops_collection(store, tmp_path):
    path = tmp_path / 'test.jsonl'
    transcript(path)
    with store() as db:
        c = Connection(name='Codex', provider='codex', path=str(tmp_path)); db.add(c); db.commit(); id_ = c.id
    main.synchronize(id_)
    with store() as db:
        c = db.get(Connection, id_); assert c.status == 'watching'; c.enabled = False; db.commit()
    with path.open('a', encoding='utf-8') as stream:
        stream.write('invalid\n')
    main.synchronize(id_)
    with store() as db:
        c = db.get(Connection, id_); assert c.status == 'watching'; c.enabled = True; db.commit()
        offset = db.scalar(select(Checkpoint.offset))
    main.synchronize(id_)
    with store() as db:
        assert db.get(Connection, id_).status == 'error'
        assert db.scalar(select(Checkpoint.offset)) == offset
        assert db.scalar(select(func.count()).select_from(Event)) == 3
