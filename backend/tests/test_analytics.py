import json
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import select

from backend import main
from backend.connectors import add_event, sync_codex
from backend.db import ChatSession, Connection, Event
from backend.tests.test_monitor import store, record


def client():
    return TestClient(main.app, base_url="http://localhost")


def test_conversation_composition_matches_totals_and_filters(store):
    real, other, review = seed(store)
    c = client()
    for filters in [{}, {'action': 'deletion'}, {'session_ids': real}, {'start': '2026-09-15T10:01:00Z', 'end': '2026-09-15T10:02:00Z'}]:
        data = c.get('/api/metrics', params={**filters, 'conversations': True, 'interval': 60}).json()
        assert review not in [s['id'] for s in data['conversation_series']]
        for row in data['series']:
            assert sum(s['actions'] for s in row['conversations']) == row['actions']
            assert sum(s['messages'] for s in row['conversations']) == row['user'] + row['assistant']
    plain = c.get('/api/metrics').json()
    assert not plain['conversation_series']
    assert all('conversations' not in row for row in plain['series'])


def test_conversation_overflow_and_zoom_keep_identity(store):
    with store() as db:
        conn = Connection(name='Many sessions', provider='codex_cli')
        db.add(conn); db.flush()
        for i in range(12):
            session = ChatSession(connection_id=conn.id, external_id=str(i), title=f'Session {i}', created_at='2026-09-15T10:00:00+00:00', updated_at='2026-09-15T10:00:00+00:00', source='cli')
            db.add(session); db.flush()
            add_event(db,session,'message','message','user','Hello','2026-09-15T10:00:10+00:00',{})
        db.commit()
    c = client()
    data = c.get('/api/metrics', params={'conversations': True}).json()
    assert len(data['conversation_series']) == 9
    assert sum(s['messages'] for row in data['series'] for s in row['conversations'] if s['id']=='other') == 4
    zoom = c.get('/api/metrics', params={'conversations': True, 'view_start': '2026-09-15T10:00:00Z', 'view_end': '2026-09-15T10:01:00Z'}).json()
    assert zoom['conversation_series'] == data['conversation_series']


def test_viewport_end_is_exclusive_in_bars_and_inspector(store):
    real, *_ = seed(store)
    c = client()
    window = {'start': '2026-09-15T10:00:00Z', 'end': '2026-09-15T10:01:02Z'}
    data = c.get('/api/metrics', params={'conversations': True, 'view_start': window['start'], 'view_end': window['end']}).json()
    sessions = c.get('/api/sessions', params=window).json()['items']
    assert sum(r['actions'] for r in data['series']) == sum(s['actions'] for s in sessions) == 0
    assert sum(r['user'] + r['assistant'] for r in data['series']) == sum(s['messages'] for s in sessions) == 2


def seed(store):
    with store() as db:
        c = Connection(name="Test desktop", provider="codex")
        db.add(c); db.flush()
        ids = []
        for external, title, type_ in [("real", "Real conversation", "conversation"), ("guidance", "Design guidance", "conversation"), ("review", "Copied context", "internal_review")]:
            s = ChatSession(connection_id=c.id, external_id=external, title=title, created_at="2026-09-15T10:00:00+00:00", updated_at="2026-09-15T10:00:00+00:00", source="desktop", session_type=type_)
            db.add(s); db.flush(); ids.append(s.id)
            text = "Let's dance now." if external == "real" else "Guidance and affordance only."
            add_event(db,s,"prompt","message","user",text,"2026-09-15T10:00:01+00:00",{})
            add_event(db,s,"answer","message","assistant","Ready.","2026-09-15T10:02:10+00:00",{})
            add_event(db,s,"context","message","user","<environment_context>dance</environment_context>","2026-09-15T10:00:00+00:00",{})
            if external=="real":
                add_event(db,s,"call","tool_call","tool","Remove-Item ./scratch.txt","2026-09-15T10:01:02+00:00",{},"exec_command")
                add_event(db,s,"output","tool_result","tool","dance output","2026-09-15T10:01:03+00:00",{})
        db.commit()
    return ids


def test_search_word_scope_snippets_and_context(store):
    real, other, review = seed(store)
    c = client()
    result = c.get('/api/sessions',params={'q':'dance'}).json()
    assert result['total']==1
    assert result['items'][0]['id']==real
    assert 'dance' in result['items'][0]['match']['text']
    assert result['items'][0]['match']['kind']=='message'
    assert c.get('/api/sessions',params={'q':'dance','search_mode':'contains'}).json()['total']==2
    assert c.get('/api/sessions',params={'q':'output'}).json()['total']==0
    assert c.get('/api/sessions',params={'q':'output','search_scope':'actions'}).json()['items'][0]['match']['kind']=='tool_result'
    assert c.get(f'/api/sessions/{real}/events',params={'q':'dance','search_scope':'all'}).json()['total']==2
    assert c.get('/api/metrics').json()['messages']==4
    assert c.get(f'/api/sessions/{real}/events').json()['total']==4
    assert c.get(f'/api/sessions/{real}/events',params={'include_context':True}).json()['total']==5
    assert c.get('/api/sessions').json()['total']==2 # Real zero-action conversations stay visible.
    assert c.get('/api/sessions',params={'include_internal':True}).json()['total']==3


def test_actions_and_time_filters_are_consistent(store):
    real, *_ = seed(store)
    c=client()
    params={'action':'deletion','start':'2026-09-15T10:01:00Z','end':'2026-09-15T10:02:00Z'}
    result=c.get('/api/sessions',params=params).json()
    assert result['total']==1 and result['items'][0]['actions']==1
    metrics=c.get('/api/metrics',params=params).json()
    assert metrics['actions']==1 and metrics['messages']==0
    assert sum(row['actions'] for row in metrics['series'])==1
    detail=c.get(f'/api/sessions/{real}/events',params=params).json()
    assert detail['total']==1 and detail['items'][0]['action_category']=='deletion'
    assert c.get('/api/sessions',params={'action':'network'}).json()['total']==0
    assert c.get('/api/sessions',params={'tool':'exec_command'}).json()['total']==1
    assert c.get('/api/sessions',params={'q':'Ready','end':'2026-09-15T10:02:00Z'}).json()['total']==0


def test_dynamic_buckets_zero_fill_and_zoom(store):
    seed(store);c=client()
    data=c.get('/api/metrics').json()
    assert data['interval_seconds']==60
    assert sum(t['count'] for row in data['series'] for t in row['tools'])==data['actions']
    assert any(t['name']=='exec_command' for row in data['series'] for t in row['tools'])
    assert len(data['series'])>=4
    assert sum(row['user'] for row in data['series'])==2
    assert sum(row['assistant'] for row in data['series'])==2
    assert len({row['time'] for row in data['series']})==len(data['series'])
    assert any(row['actions']==0 and row['user']==0 and row['assistant']==0 for row in data['series'])
    wide=c.get('/api/metrics',params={'start':'2025-01-01T00:00:00Z','end':'2027-01-01T00:00:00Z','interval':60}).json()
    assert wide['interval_seconds']==60 and not wide['interval_adjusted']
    assert wide['window_limited'] and len(wide['series'])<=601
    assert wide['viewport']['start'] != wide['domain']['start']
    automatic=c.get('/api/metrics',params={'start':'2025-01-01','end':'2027-01-01'}).json()
    assert automatic['interval_seconds']>=86400 and len(automatic['series'])<=101
    zoom=c.get('/api/metrics',params={'view_start':'2026-09-15T10:01:00Z','view_end':'2026-09-15T10:02:00Z'}).json()
    assert sum(row['actions'] for row in zoom['series'])==1
    assert zoom['messages']==4 # Zoom is a viewport, not a change to the selected totals.
    assert c.get('/api/metrics',params={'start':'invalid'}).status_code==422
    assert c.get('/api/metrics',params={'start':'2026-01-02','end':'2026-01-01'}).status_code==422
    assert c.get('/api/metrics',params={'interval':7}).status_code==422


def test_guardian_provenance_and_mixed_context_payload(store,tmp_path):
    path=tmp_path/'review.jsonl'
    path.write_text(record('session_meta',{'id':'guardian-1','originator':'Codex Desktop','thread_source':'guardian_review','parent_thread_id':'parent-1','source':{'subagent':{'other':'guardian'}}})+record('response_item',{'type':'message','role':'user','content':[{'type':'input_text','text':'<environment_context>setup</environment_context>'}]}),encoding='utf-8')
    with store() as db:
        c=Connection(name='Desktop',provider='codex',path=str(tmp_path));db.add(c);db.flush()
        sync_codex(db,c);db.commit()
        s=db.scalar(select(ChatSession))
        assert s.session_type=='internal_review' and s.parent_thread_id=='parent-1'
        assert db.scalar(select(Event.kind))=='context'
        add_event(db,s,'mixed','message','user','<environment_context>setup</environment_context>\nPlease inspect this file.','2026-09-15T10:00:00+00:00',{})
        db.commit()
        assert db.scalar(select(Event.text).where(Event.external_id=='mixed'))=='Please inspect this file.'


def test_matching_records_past_first_page_and_context_anchor(store):
    real,*_=seed(store)
    with store() as db:
        s=db.get(ChatSession,real)
        for i in range(110):
            stamp=(datetime(2026,9,15,11,tzinfo=timezone.utc)+timedelta(seconds=i)).isoformat()
            add_event(db,s,f'late-{i}','message','assistant','needle' if i==109 else f'ordinary {i}',stamp,{})
        db.commit()
    c=client()
    match=c.get('/api/sessions',params={'q':'needle'}).json()['items'][0]['match']
    found=c.get(f'/api/sessions/{real}/events',params={'q':'needle'}).json()
    assert found['total']==1 and found['items'][0]['id']==match['event_id']
    around=c.get(f'/api/sessions/{real}/events',params={'anchor':match['event_id']}).json()
    assert around['offset']==100 and any(e['id']==match['event_id'] for e in around['items'])


def test_subagent_session_filter(store):
    real, other, review = seed(store)
    with store() as db:
        db.get(ChatSession, real).session_type = "subagent"
        db.commit()
    c=client()
    assert c.get('/api/sessions',params={'session_type':'subagent'}).json()['items'][0]['id']==real
    assert c.get('/api/sessions',params={'session_type':'conversation'}).json()['total']==1
    assert c.get('/api/metrics',params={'session_type':'subagent'}).json()['actions']==1
    assert c.get('/api/sessions',params={'session_type':'bad'}).status_code==422
