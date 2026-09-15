"""Connections, sessions, normalized events, and durable ingestion offsets."""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None


def upgrade():
    op.create_table("connections", sa.Column("id", sa.String(36), primary_key=True), sa.Column("name", sa.String(100), nullable=False), sa.Column("provider", sa.String(20), nullable=False), sa.Column("path", sa.Text), sa.Column("enabled", sa.Boolean, nullable=False), sa.Column("status", sa.String(30), nullable=False), sa.Column("error", sa.Text), sa.Column("last_sync", sa.String(40)), sa.Column("created_at", sa.String(40), nullable=False))
    op.create_table("sessions", sa.Column("id", sa.String(36), primary_key=True), sa.Column("connection_id", sa.String(36), sa.ForeignKey("connections.id"), nullable=False), sa.Column("external_id", sa.String(200), nullable=False), sa.Column("title", sa.Text, nullable=False), sa.Column("created_at", sa.String(40), nullable=False), sa.Column("updated_at", sa.String(40), nullable=False), sa.Column("source", sa.String(50), nullable=False), sa.UniqueConstraint("connection_id", "external_id"))
    op.create_index("ix_sessions_connection_id", "sessions", ["connection_id"])
    op.create_index("ix_sessions_updated_at", "sessions", ["updated_at"])
    op.create_table("events", sa.Column("id", sa.Integer, primary_key=True, autoincrement=True), sa.Column("session_id", sa.String(36), sa.ForeignKey("sessions.id"), nullable=False), sa.Column("external_id", sa.String(250), nullable=False), sa.Column("kind", sa.String(30), nullable=False), sa.Column("role", sa.String(30), nullable=False), sa.Column("text", sa.Text, nullable=False), sa.Column("tool_name", sa.String(200)), sa.Column("occurred_at", sa.String(40), nullable=False), sa.Column("ingested_at", sa.String(40), nullable=False), sa.Column("payload", sa.JSON, nullable=False), sa.Column("schema_version", sa.Integer, nullable=False), sa.UniqueConstraint("session_id", "external_id"))
    op.create_index("ix_events_session_time", "events", ["session_id", "occurred_at"])
    op.create_index("ix_events_kind", "events", ["kind"])
    op.create_index("ix_events_occurred_at", "events", ["occurred_at"])
    op.create_table("checkpoints", sa.Column("id", sa.Integer, primary_key=True), sa.Column("connection_id", sa.String(36), sa.ForeignKey("connections.id"), nullable=False), sa.Column("path", sa.Text, nullable=False), sa.Column("offset", sa.Integer, nullable=False), sa.Column("session_id", sa.String(36), sa.ForeignKey("sessions.id")), sa.Column("prefix_hash", sa.String(64)), sa.UniqueConstraint("connection_id", "path"))


def downgrade():
    for name in ("checkpoints", "events", "sessions", "connections"):
        op.drop_table(name)
