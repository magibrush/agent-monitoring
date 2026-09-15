"""Isolated browser-test server. Never opens the user's monitoring database."""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
os.environ['DATABASE_URL'] = 'sqlite:///' + (ROOT / 'data/e2e.db').as_posix()

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from backend.db import Base, engine

assert str(engine.url).endswith('/data/e2e.db')
Base.metadata.drop_all(engine)
with engine.begin() as db:
    db.execute(text('DROP TABLE IF EXISTS alembic_version'))
command.upgrade(Config(str(ROOT / 'alembic.ini')), 'head')
source = ROOT / 'data/e2e-source'
source.mkdir(parents=True, exist_ok=True)
names = ['Repository access review', 'Refactor the event collector', 'Database migration planning', 'Review API pagination', 'Add connection health checks', 'Design the session explorer', 'Investigate ingestion delays']
for i, title in enumerate(names):
    time = (datetime.now(timezone.utc) - timedelta(days=6-i)).isoformat()
    records = [{'type': 'session_meta', 'payload': {'id': f'synthetic-{i}', 'source': ({'subagent':{'name':'test'}} if i==0 else 'vscode'), 'originator': 'Codex Desktop', 'timestamp': time}}]
    for j in range(5):
        for role, body in [('user', title if j == 0 else f'Please explain step {j}.'), ('assistant', ('We can dance after the review.' if i == 0 and j == 0 else 'Guidance for the sample workspace. The changes are ready for review.'))]:
            records.append({'type': 'response_item', 'payload': {'type': 'message', 'role': role, 'content': [{'type': 'input_text' if role == 'user' else 'output_text', 'text': body}]}})
    for tool in ['read_file', 'exec_command']:
        records.append({'type': 'response_item', 'payload': {'type': 'function_call', 'name': tool, 'call_id': f'call-{i}-{tool}', 'arguments': ('{"cmd":"Remove-Item ./scratch.txt"}' if i == 0 and tool == 'exec_command' else '{"path":"README.md"}')}})
        records.append({'type': 'response_item', 'payload': {'type': 'function_call_output', 'call_id': f'call-{i}-{tool}', 'output': 'Synthetic tool output; no command was executed.'}})
    (source / f'rollout-{i}.jsonl').write_text(''.join(json.dumps({**r, 'timestamp': (datetime.fromisoformat(time) - timedelta(minutes=len(records)-n)).isoformat()}) + '\n' for n, r in enumerate(records)), encoding='utf-8')

(source / 'guardian.jsonl').write_text(json.dumps({'type': 'session_meta', 'timestamp': time, 'payload': {'id': 'guardian-test', 'originator': 'Codex Desktop', 'thread_source': 'guardian_review', 'timestamp': time}}) + '\n' + json.dumps({'type': 'response_item', 'timestamp': time, 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': '<environment_context>Copied context</environment_context>'}]}}) + '\n', encoding='utf-8')

secondary = ROOT / 'data/e2e-secondary'
secondary.mkdir(parents=True, exist_ok=True)
time = datetime.now(timezone.utc).isoformat()
records = [
    {'type': 'session_meta', 'payload': {'id': 'synthetic-0', 'originator': 'Codex Desktop', 'timestamp': time}},
    {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'Compare worker architectures'}]}},
    {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Start with a durable outbox and measure queue age.'}]}}
]
(secondary / 'rollout.jsonl').write_text(''.join(json.dumps({**r, 'timestamp': time}) + '\n' for r in records), encoding='utf-8')

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('backend.main:app', host='127.0.0.1', port=8000)
