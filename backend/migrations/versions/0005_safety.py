"""Durable shadow evaluation and opt-in deterministic gate."""
from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"


def upgrade():
    op.add_column("connections", sa.Column("gate_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_table("safety_evaluations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("event_id", sa.Integer(), sa.ForeignKey("events.id"), nullable=False),
        sa.Column("input_hash", sa.String(64), nullable=False),
        sa.Column("policy_version", sa.String(40), nullable=False),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("rules", sa.JSON(), nullable=False),
        sa.Column("gate", sa.JSON()), sa.Column("result", sa.JSON()),
        sa.Column("error", sa.Text()), sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("lease_token", sa.String(36)), sa.Column("lease_until", sa.String(40)),
        sa.Column("available_at", sa.String(40), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.Column("completed_at", sa.String(40)), sa.Column("latency_ms", sa.Integer()),
        sa.Column("usage", sa.JSON()), sa.UniqueConstraint("event_id", "input_hash"))
    op.create_index("ix_safety_evaluations_event_id", "safety_evaluations", ["event_id"])
    op.create_index("ix_safety_jobs", "safety_evaluations", ["status", "available_at"])
    op.create_table("safety_workers", sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("heartbeat_at", sa.String(40), nullable=False), sa.Column("status", sa.String(40), nullable=False))


def downgrade():
    op.drop_table("safety_workers")
    op.drop_table("safety_evaluations")
    op.drop_column("connections", "gate_enabled")
