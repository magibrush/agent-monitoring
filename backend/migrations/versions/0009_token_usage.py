"""Import provider token usage separately from visible conversation events."""
from alembic import op
import sqlalchemy as sa

revision = "0009"
down_revision = "0008"


def upgrade():
    op.create_table("token_usage", sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("external_id", sa.String(250), nullable=False),
        sa.Column("occurred_at", sa.String(40), nullable=False),
        sa.Column("input_tokens", sa.Integer()), sa.Column("output_tokens", sa.Integer()),
        sa.UniqueConstraint("session_id", "external_id"))
    op.create_index("ix_token_usage_session_time", "token_usage", ["session_id", "occurred_at"])
    # Existing transcript events are idempotent; reread once to backfill usage.
    op.execute("UPDATE checkpoints SET offset = 0, record_counts = NULL, tail_hash = NULL")


def downgrade():
    op.drop_table("token_usage")
