"""One editable draft, with immutable tested and applied snapshots."""
from alembic import op
import sqlalchemy as sa

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("policy_versions", sa.Column("preview_result", sa.JSON(), nullable=True))
    with op.batch_alter_table("policy_state") as batch:
        batch.add_column(sa.Column("draft_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_policy_state_draft", "policy_versions", ["draft_id"], ["id"])
    # Adopt the latest unfinished work once. Discarded drafts are never inferred again.
    op.execute("""UPDATE policy_state SET draft_id = (
        SELECT MAX(id) FROM policy_versions WHERE id > COALESCE((
            SELECT MAX(version_id) FROM policy_changes WHERE action IN ('activate', 'rollback')
        ), 0) AND id NOT IN (
            SELECT version_id FROM policy_changes WHERE action IN ('activate', 'rollback') AND version_id IS NOT NULL
        )
    )""")


def downgrade():
    with op.batch_alter_table("policy_state") as batch:
        batch.drop_constraint("fk_policy_state_draft", type_="foreignkey")
        batch.drop_column("draft_id")
    # Native DROP COLUMN keeps inbound state/change foreign keys intact.
    op.drop_column("policy_versions", "preview_result")
