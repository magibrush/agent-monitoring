"""Rank incidents and persist automatic evidence analysis."""
from alembic import op
import sqlalchemy as sa

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("incidents", sa.Column("severity", sa.String(12), nullable=False, server_default="medium"))
    op.create_index("ix_incidents_severity", "incidents", ["severity"])
    op.create_table("incident_analyses",
        sa.Column("incident_id", sa.String(36), sa.ForeignKey("incidents.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("requested_revision", sa.Integer(), nullable=False),
        sa.Column("analyzed_revision", sa.Integer()),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("evidence", sa.JSON()), sa.Column("result", sa.JSON()),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("lease_token", sa.String(36)), sa.Column("lease_until", sa.String(40)),
        sa.Column("available_at", sa.String(40), nullable=False),
        sa.Column("analyzed_at", sa.String(40)), sa.Column("error", sa.Text()), sa.Column("usage", sa.JSON()))

    # Preserve the importance of existing saved evidence when upgrading.
    op.execute("""UPDATE incidents SET severity = COALESCE((
        SELECT CASE MAX(CASE
            WHEN json_extract(e.result, '$.severity') = 'critical' THEN 3
            WHEN json_extract(e.result, '$.recommendation') IN ('review','deny')
                OR json_extract(e.result, '$.severity') = 'high' OR json_extract(e.result, '$.risk') = 'high' THEN 2
            WHEN json_extract(e.result, '$.severity') = 'low' OR json_extract(e.result, '$.risk') = 'low' THEN 0
            ELSE 1 END) WHEN 3 THEN 'critical' WHEN 2 THEN 'high' WHEN 1 THEN 'medium' WHEN 0 THEN 'low' END
        FROM incident_links l JOIN safety_evaluations e ON e.id=l.evaluation_id
        WHERE l.incident_id=incidents.id), 'medium')""")


def downgrade():
    op.drop_table("incident_analyses")
    op.drop_index("ix_incidents_severity", table_name="incidents")
    op.drop_column("incidents", "severity")
