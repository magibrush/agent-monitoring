"""Immutable policy versions, rollout pointers and change history."""
from alembic import op
import sqlalchemy as sa

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("policy_versions", sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False), sa.Column("rules", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False), sa.Column("previewed_at", sa.String(40)),
        sa.Column("trial_started_at", sa.String(40)))
    op.create_table("policy_state", sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("active_id", sa.Integer(), sa.ForeignKey("policy_versions.id")),
        sa.Column("trial_id", sa.Integer(), sa.ForeignKey("policy_versions.id")))
    op.create_table("policy_changes", sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("version_id", sa.Integer(), sa.ForeignKey("policy_versions.id")),
        sa.Column("action", sa.String(30), nullable=False), sa.Column("actor", sa.String(40), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False))
    op.execute("INSERT INTO policy_state (id, revision) VALUES (1, 0)")


def downgrade():
    for table in ("policy_changes", "policy_state", "policy_versions"):
        op.drop_table(table)
