"""Persist correlation separately from provider-specific raw records."""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"


def upgrade():
    op.add_column("events", sa.Column("tool_call_id", sa.String(250)))
    op.add_column("events", sa.Column("turn_id", sa.String(250)))
    op.create_index("ix_events_tool_call_id", "events", ["tool_call_id"])


def downgrade():
    op.drop_index("ix_events_tool_call_id", table_name="events")
    with op.batch_alter_table("events") as batch:
        batch.drop_column("turn_id")
        batch.drop_column("tool_call_id")
