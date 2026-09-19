"""Complete safety timing and attempt accounting.

Revision ID: 0010
Revises: 0009
"""
from alembic import op
import sqlalchemy as sa

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("ix_safety_mode_created", "safety_evaluations", ["mode", "created_at"])
    for name in ("admitted_at", "first_started_at", "review_ready_at", "published_at"):
        op.add_column("safety_evaluations", sa.Column(name, sa.String(40), nullable=True))
    op.add_column("safety_evaluations", sa.Column("rules_ms", sa.Integer(), nullable=True))
    op.add_column("safety_attempts", sa.Column("latency_ms", sa.Integer(), nullable=True))
    op.add_column("safety_attempts", sa.Column("usage", sa.JSON(), nullable=True))


def downgrade():
    op.drop_index("ix_safety_mode_created", table_name="safety_evaluations")
    for name in ("usage", "latency_ms"):
        op.drop_column("safety_attempts", name)
    for name in ("rules_ms", "published_at", "review_ready_at", "first_started_at", "admitted_at"):
        op.drop_column("safety_evaluations", name)
