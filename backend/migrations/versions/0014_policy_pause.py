"""Retain paused policy sets without enabling them."""
from alembic import op
import sqlalchemy as sa

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("policy_state") as batch:
        batch.add_column(sa.Column("paused_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_policy_state_paused", "policy_versions", ["paused_id"], ["id"])
    op.execute("""UPDATE policy_state SET paused_id = (
        SELECT version_id FROM policy_changes WHERE action IN ('activate', 'rollback')
        AND version_id IS NOT NULL ORDER BY id DESC LIMIT 1
    ) WHERE active_id IS NULL""")


def downgrade():
    with op.batch_alter_table("policy_state") as batch:
        batch.drop_constraint("fk_policy_state_paused", type_="foreignkey")
        batch.drop_column("paused_id")
