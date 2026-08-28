#!/usr/bin/env python3
"""Apply lakebase/migrations/*.sql idempotently against the Lakebase project.

Tracks applied files in northpeak._migrations. Safe to re-run. Migration 002
(search) degrades to a logged skip if the Search Beta extensions are not yet
enabled on the project.
"""
from __future__ import annotations
import os, sys, pathlib, logging, argparse

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("lakebase-migrate")


def _default_migrations_dir() -> pathlib.Path:
    """Best-effort migrations dir when --migrations-dir isn't passed.

    NB: a Databricks spark_python_task exec()s this file, so `__file__` is NOT
    defined at runtime — hence --migrations-dir is the reliable path (the job
    passes ${workspace.file_path}/lakebase/migrations). This fallback is only for
    local runs where __file__ exists.
    """
    try:
        return pathlib.Path(__file__).parent / "migrations"  # noqa: F821
    except NameError:
        return pathlib.Path("migrations")


def pending_migrations(applied: set[str], all_files: list[str]) -> list[str]:
    """Pure: unapplied migration filenames, in filename order."""
    return [f for f in sorted(all_files) if f not in applied]


def _connect(project: str, user: str, branch: str = "production",
             endpoint: str = "primary", dbname: str = "databricks_postgres"):
    """Connect via psycopg using a freshly minted Lakebase OAuth token."""
    import psycopg
    from databricks.sdk import WorkspaceClient

    w = WorkspaceClient()
    ep_path = f"projects/{project}/branches/{branch}/endpoints/{endpoint}"
    ep = w.postgres.get_endpoint(name=ep_path)
    host = ep.status.hosts.host
    # NB: endpoint path is POSITIONAL here (not name=), unlike get_endpoint.
    cred = w.postgres.generate_database_credential(ep_path)
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


def apply(conn, mig_dir: pathlib.Path, filename: str) -> None:
    """Apply one migration file in its own transaction. 002 skips gracefully."""
    import psycopg
    sql = (mig_dir / filename).read_text()
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
    parser = argparse.ArgumentParser(
        description="Apply Lakebase migrations idempotently."
    )
    parser.add_argument(
        "--project",
        default=os.environ.get("LAKEBASE_PROJECT_ID"),
        help="Lakebase project ID (env: LAKEBASE_PROJECT_ID)",
    )
    parser.add_argument(
        "--user",
        default=os.environ.get("PGUSER"),
        help="Postgres user (env: PGUSER)",
    )
    parser.add_argument(
        "--branch",
        default=os.environ.get("LAKEBASE_BRANCH_ID", "production"),
        help="Lakebase branch ID (env: LAKEBASE_BRANCH_ID, default: production)",
    )
    parser.add_argument(
        "--endpoint",
        default=os.environ.get("LAKEBASE_ENDPOINT_ID", "primary"),
        help="Lakebase endpoint ID (env: LAKEBASE_ENDPOINT_ID, default: primary)",
    )
    parser.add_argument(
        "--database",
        default=os.environ.get("PGDATABASE", "databricks_postgres"),
        help="Postgres database name (env: PGDATABASE, default: databricks_postgres)",
    )
    parser.add_argument(
        "--migrations-dir",
        default=os.environ.get("MIGRATIONS_DIR"),
        help="Directory holding the *.sql migrations (job passes "
             "${workspace.file_path}/lakebase/migrations; __file__ is undefined "
             "in a spark_python_task).",
    )
    args = parser.parse_args()

    mig_dir = (pathlib.Path(args.migrations_dir) if args.migrations_dir
               else _default_migrations_dir())

    if not args.project:
        raise SystemExit(
            "ERROR: --project / LAKEBASE_PROJECT_ID is required but was not provided."
        )
    if not args.user:
        raise SystemExit(
            "ERROR: --user / PGUSER is required but was not provided."
        )

    all_files = [p.name for p in mig_dir.glob("*.sql")]
    if not all_files:
        raise SystemExit(f"ERROR: no *.sql migrations found in {mig_dir}")
    conn = _connect(
        project=args.project,
        user=args.user,
        branch=args.branch,
        endpoint=args.endpoint,
        dbname=args.database,
    )
    try:
        applied = _ensure_tracking(conn)
        todo = pending_migrations(applied, all_files)
        if not todo:
            log.info("nothing to apply (%d migrations already applied)",
                     len(applied))
        for f in todo:
            apply(conn, mig_dir, f)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    # NB: call main() directly — do NOT sys.exit(). A spark_python_task exec()s
    # this file in a notebook kernel where even SystemExit(0) is reported as a
    # task failure. main() raises on real errors; a clean return ends the task OK.
    main()
