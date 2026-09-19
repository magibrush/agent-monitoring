"""Persist opt-in judge simulation and freeze its output per evaluation."""
from alembic import op
import sqlalchemy as sa

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("safety_debug_settings", sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False), sa.Column("result", sa.String(10), nullable=False),
        sa.Column("updated_at", sa.String(40), nullable=False))
    op.add_column("safety_evaluations", sa.Column("debug_result", sa.String(10), nullable=True))


def downgrade():
    op.drop_column("safety_evaluations", "debug_result")
    op.drop_table("safety_debug_settings")
