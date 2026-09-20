"""Persist incident investigations and restart-safe correlation progress."""
from alembic import op
import sqlalchemy as sa
from datetime import datetime, timezone

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("incidents",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("connection_id", sa.String(36), sa.ForeignKey("connections.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False), sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False), sa.Column("resolution", sa.String(40)),
        sa.Column("signature", sa.String(64)), sa.Column("grouping_reason", sa.Text(), nullable=False),
        sa.Column("previous_id", sa.String(36), sa.ForeignKey("incidents.id", ondelete="SET NULL")),
        sa.Column("revision", sa.Integer(), nullable=False), sa.Column("created_at", sa.String(40), nullable=False),
        sa.Column("last_activity_at", sa.String(40), nullable=False), sa.Column("resolved_at", sa.String(40)))
    for field in ("connection_id", "status", "signature", "last_activity_at"):
        op.create_index("ix_incidents_" + field, "incidents", [field])
    op.create_table("incident_links",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("incident_id", sa.String(36), sa.ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_id", sa.Integer(), sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("evaluation_id", sa.String(36), sa.ForeignKey("safety_evaluations.id", ondelete="CASCADE")),
        sa.Column("source", sa.String(20), nullable=False), sa.Column("created_at", sa.String(40), nullable=False))
    for field in ("incident_id", "event_id", "evaluation_id"):
        op.create_index("ix_incident_links_" + field, "incident_links", [field])
    op.create_table("incident_activity",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("incident_id", sa.String(36), sa.ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False), sa.Column("text", sa.Text(), nullable=False),
        sa.Column("actor", sa.String(40), nullable=False), sa.Column("created_at", sa.String(40), nullable=False))
    op.create_index("ix_incident_activity_incident_id", "incident_activity", ["incident_id"])
    op.create_table("incident_candidates",
        sa.Column("evaluation_id", sa.String(36), sa.ForeignKey("safety_evaluations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("signature", sa.String(64)), sa.Column("occurred_at", sa.String(40), nullable=False),
        sa.Column("handled", sa.Boolean(), nullable=False))
    for field in ("signature", "occurred_at"):
        op.create_index("ix_incident_candidates_" + field, "incident_candidates", [field])
    op.create_table("incident_monitor", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("enabled_at", sa.String(40), nullable=False))
    op.execute(sa.text("INSERT INTO incident_monitor (id, enabled_at) VALUES (1, :at)").bindparams(at=datetime.now(timezone.utc).isoformat()))


def downgrade():
    for table in ("incident_monitor", "incident_candidates", "incident_activity", "incident_links", "incidents"):
        op.drop_table(table)
