#!/usr/bin/env python3
"""Apply lakebase/migrations/*.sql idempotently against the Lakebase project.

Tracks applied files in northpeak._migrations. Safe to re-run. Migration 002
(search) degrades to a logged skip if the Search Beta extensions are not yet
enabled on the project.
"""
from __future__ import annotations
import os, sys, pathlib, logging

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("lakebase-migrate")
MIG_DIR = pathlib.Path(__file__).parent / "migrations"


def pending_migrations(applied: set[str], all_files: list[str]) -> list[str]:
    """Pure: unapplied migration filenames, in filename order."""
    return [f for f in sorted(all_files) if f not in applied]


def _connect():
    """Connect via psycopg using a freshly minted Lakebase OAuth token."""
    import psycopg
    from databricks.sdk import WorkspaceClient

    project = os.environ["LAKEBASE_PROJECT_ID"]
    branch = os.environ.get("LAKEBASE_BRANCH_ID", "production")
    endpoint = os.environ.get("LAKEBASE_ENDPOINT_ID", "primary")
    user = os.environ["PGUSER"]
    dbname = os.environ.get("PGDATABASE", "databricks_postgres")

    w = WorkspaceClient()
    ep_path = f"projects/{project}/branches/{branch}/endpoints/{endpoint}"
    ep = w.postgres.get_endpoint(name=ep_path)
    host = ep.status.hosts.host
    cred = w.postgres.generate_database_credential(name=ep_path)
    return psycopg.connect(
        host=host, user=user, dbname=dbname, password=cred.token,
        sslmode="require",
    )


def _ensure_tracking(conn) -> set[str]:
    with conn.cursor() as cur:
        cur.execute("CREATE SCHEMA IF NOT EXISTS northpeak;")
        cur.execute(
            "CREATE TABLE IF NOT EXISTS northpeak._migrations ("
            "  filename TEXT PRIMARY KEY,"
            "  applied_at TIMESTAMPTZ NOT NULL DEFAULT now());"
        )
        cur.execute("SELECT filename FROM northpeak._migrations;")
        applied = {r[0] for r in cur.fetchall()}
    conn.commit()
    return applied


def apply(conn, filename: str) -> None:
    """Apply one migration file in its own transaction. 002 skips gracefully."""
    import psycopg
    sql = (MIG_DIR / filename).read_text()
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            cur.execute(
                "INSERT INTO northpeak._migrations(filename) VALUES (%s) "
                "ON CONFLICT DO NOTHING;", (filename,),
            )
        conn.commit()
        log.info("applied %s", filename)
    except psycopg.errors.Error as e:
        conn.rollback()
        if filename.startswith("002"):
            log.warning("SKIPPED %s (search extensions not available): %s",
                        filename, e)
            return
        raise


def main() -> int:
    all_files = [p.name for p in MIG_DIR.glob("*.sql")]
    conn = _connect()
    try:
        applied = _ensure_tracking(conn)
        todo = pending_migrations(applied, all_files)
        if not todo:
            log.info("nothing to apply (%d migrations already applied)",
                     len(applied))
        for f in todo:
            apply(conn, f)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
