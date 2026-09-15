"""Classify internal sessions and distinguish context from conversation messages."""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"


def upgrade():
    op.add_column("sessions", sa.Column("session_type", sa.String(30), nullable=False, server_default="conversation"))
    op.add_column("sessions", sa.Column("parent_thread_id", sa.String(200)))
    op.create_index("ix_sessions_session_type", "sessions", ["session_type"])
    op.add_column("events", sa.Column("action_category", sa.String(30), nullable=False, server_default="other"))
    op.create_index("ix_events_action_category", "events", ["action_category"])
    # Re-normalize existing records without changing raw payloads or replay offsets.
    from backend.normalization import message_content, action_category
    db = op.get_bind()
    for row in db.execute(sa.text("SELECT id, kind, role, text, tool_name FROM events")).mappings().all():
        if row["kind"] == "message":
            kind, text = message_content(row["text"], row["role"])
            db.execute(sa.text("UPDATE events SET kind=:kind, text=:text WHERE id=:id"), {"kind": kind, "text": text, "id": row["id"]})
        elif row["kind"] == "tool_call":
            db.execute(sa.text("UPDATE events SET action_category=:category WHERE id=:id"), {"category": action_category(row["tool_name"], row["text"]), "id": row["id"]})
    # Read provenance for already-imported sessions, including paused connections.
    import json
    from pathlib import Path
    from backend.normalization import session_type
    for row in db.execute(sa.text("SELECT path, session_id FROM checkpoints WHERE session_id IS NOT NULL")).mappings().all():
        try:
            with Path(row["path"]).open(encoding="utf-8") as stream:
                metadata = json.loads(stream.readline(50 * 1024 * 1024))["payload"]
            db.execute(sa.text("UPDATE sessions SET session_type=:type, parent_thread_id=:parent WHERE id=:id"), {"type": session_type(metadata), "parent": metadata.get("parent_thread_id"), "id": row["session_id"]})
        except (OSError, ValueError, KeyError, TypeError):
            pass  # A temporarily unavailable source can be classified on its next sync.


def downgrade():
    op.drop_index("ix_events_action_category", table_name="events")
    op.drop_column("events", "action_category")
    op.drop_index("ix_sessions_session_type", table_name="sessions")
    op.drop_column("sessions", "parent_thread_id")
    op.drop_column("sessions", "session_type")
