"""Read-only hook observations and transcript reconciliation."""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"


def upgrade():
    op.add_column("connections", sa.Column("hooks_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("connections", sa.Column("hook_last_seen", sa.String(40)))
    op.add_column("connections", sa.Column("hook_error", sa.Text()))
    op.add_column("events", sa.Column("transcript_seen", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("events", sa.Column("hook_state", sa.String(30)))
    op.add_column("events", sa.Column("hook_seen_at", sa.String(40)))
    op.create_table("hook_observations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("connection_id", sa.String(36), sa.ForeignKey("connections.id"), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("event_id", sa.Integer(), sa.ForeignKey("events.id"), nullable=False),
        sa.Column("phase", sa.String(40), nullable=False),
        sa.Column("received_at", sa.String(40), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.UniqueConstraint("connection_id", "fingerprint"))
    op.create_index("ix_hook_observations_connection_id", "hook_observations", ["connection_id"])
    op.create_index("ix_hook_observations_event_id", "hook_observations", ["event_id"])


def downgrade():
    op.drop_table("hook_observations")
    for column in ("transcript_seen", "hook_state", "hook_seen_at"):
        op.drop_column("events", column)
    for column in ("hooks_enabled", "hook_last_seen", "hook_error"):
        op.drop_column("connections", column)
