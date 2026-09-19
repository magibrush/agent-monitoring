"""Keep human decisions separate from judge recommendations and gate delivery."""
from alembic import op
import sqlalchemy as sa

revision = "0008"
down_revision = "0007"


def upgrade():
    op.add_column("safety_evaluations", sa.Column("human_decision", sa.String(20)))
    op.add_column("safety_evaluations", sa.Column("reviewed_at", sa.String(40)))


def downgrade():
    raise RuntimeError("Restore a backup to preserve human decision audit history.")
