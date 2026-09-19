"""Persistent replay identities for automatic transcript rewrite handling."""
from alembic import op
import sqlalchemy as sa

revision = "0006"
down_revision = "0005"


def upgrade():
    op.add_column("checkpoints", sa.Column("record_counts", sa.JSON()))
    op.add_column("checkpoints", sa.Column("tail_hash", sa.String(64)))


def downgrade():
    op.drop_column("checkpoints", "tail_hash")
    op.drop_column("checkpoints", "record_counts")
