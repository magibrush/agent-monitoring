"""Deadline-bound blocking requests and per-attempt diagnostics."""
from alembic import op
import sqlalchemy as sa

revision = "0007"
down_revision = "0006"


def upgrade():
    with op.batch_alter_table("safety_evaluations", naming_convention={"uq": "uq_%(table_name)s_%(column_0_name)s"}) as batch:
        batch.drop_constraint("uq_safety_evaluations_event_id", type_="unique")
        batch.add_column(sa.Column("request_key", sa.String(36), nullable=False, server_default=""))
        batch.add_column(sa.Column("mode", sa.String(20), nullable=False, server_default="shadow"))
        for name in ("deadline", "started_at", "decision_at", "returned_at"):
            batch.add_column(sa.Column(name, sa.String(40)))
        batch.add_column(sa.Column("decision", sa.String(20)))
        batch.add_column(sa.Column("diagnostics", sa.JSON()))
        batch.create_unique_constraint("uq_safety_request", ["event_id", "input_hash", "request_key"])
    op.create_table("safety_attempts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("evaluation_id", sa.String(36), sa.ForeignKey("safety_evaluations.id"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.String(40), nullable=False),
        sa.Column("completed_at", sa.String(40)), sa.Column("error", sa.Text()), sa.Column("diagnostics", sa.JSON()))
    op.create_index("ix_safety_attempts_evaluation_id", "safety_attempts", ["evaluation_id"])


def downgrade():
    # Multiple requests per action cannot be represented by the old unique key.
    raise RuntimeError("Restore the pre-migration backup to downgrade blocking safety without discarding audit history.")
