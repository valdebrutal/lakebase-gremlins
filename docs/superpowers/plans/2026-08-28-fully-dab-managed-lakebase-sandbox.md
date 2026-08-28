# Fully DAB-managed NorthPeak on `otto-sandbox` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the NorthPeak Retail bundle self-contained on a fresh workspace — every control-plane resource (incl. Lakebase project→branch→endpoint→database→UC-catalog→synced-table and the app) declared in the DAB, plus a re-runnable in-database SQL migration artifact — deployable via `bundle deploy -t sandbox`.

**Architecture:** A new `sandbox` bundle target (Azure host + `otto_demo` catalog + sandbox warehouse) with no development mode. `resources/lakebase.yml` gains the missing postgres control-plane resources and re-points existing ones at a self-owned project. In-database SQL (which no DAB resource can express) lives in `lakebase/migrations/*.sql`, applied by a psycopg runner wired as a bundle job. The AI Gateway (Build 3) becomes DAB resources: a governed `model_serving_endpoints.northpeak_ai_gateway` serving a Databricks-hosted FM (`system.ai.gpt-oss-120b`, provisioned throughput) with inference table + guardrails, its inference schema, and a guardrail UC function. The app becomes an `apps.northpeak_app` DAB resource whose data/model backends (warehouse, Lakebase, Genie, gateway) resolve purely via platform bindings; catalog/schema/AGENT_MODEL are literals; dashboard/pipeline IDs are stamped post-deploy.

**Tech Stack:** Databricks Asset Bundles (CLI v1.12.1), Lakebase Postgres Autoscaling (`databricks postgres`, Beta), Databricks Apps (AppKit/TypeScript, already built), Python 3 + psycopg + databricks-sdk (migration runner), SQL (Postgres 17 + `vector`/`lakebase_text`/`lakebase_vector`).

**Spec:** `docs/superpowers/specs/2026-08-28-fully-dab-managed-lakebase-sandbox-design.md`

## Global Constraints

- **Profile:** `otto-sandbox` (host `https://adb-7405605253712899.19.azuredatabricks.net`). Always pass `--profile otto-sandbox` and `-t sandbox`. Never auto-select another profile.
- **Catalog:** `otto_demo` — referenced by name via `var.catalog`. Never add a `catalogs.otto_demo` resource, never `bundle deployment bind` it. It must stay outside bundle lifecycle (no destroy risk).
- **Schema:** `northpeak_retail` (`var.schema`, unchanged default).
- **No development mode:** neither `dev` nor `sandbox` uses `mode: development` — no resource may be prefixed `[dev <user>]`.
- **Do not touch:** the perma-vm `dev` deployment (config edit only, no redeploy), the app's Drizzle `app.*` schema, or `submission1/` evidence.
- **Deploy is user-gated:** author + `bundle validate` + review only. The live `bundle deploy`/`run` is triggered by the user (see Task 10 runbook). The offline gate for infra tasks is `bundle validate -t sandbox` + shape review; deploy-time correctness is verified in the runbook.
- **AI Gateway backing model:** `northpeak-ai-gateway` serves the Databricks-hosted `system.ai.gpt-oss-120b` via provisioned throughput (no `external_model`, no cross-workspace, no secret). Confirm PT eligibility + token range at author time (Task 6 Step 1); enable scale-to-zero to keep idle cost low. Do NOT run the committed perma-vm `gateway/setup_gateway_service.sh` against sandbox.
- **Postgres resources are Beta + loosely typed** in the bundle schema (passthrough): `bundle validate` will NOT catch field-shape errors. Author from the live API shapes (`databricks postgres create-* -h`) and treat first `bundle deploy` as the real shape check.
- **Project id:** `northpeak` → project resource name `projects/northpeak`. Branches: `production` (app runtime) and `dev-otto` (dev). Endpoint: `primary`. Database: `databricks_postgres`.
- **Search extensions** (`lakebase_text`/`lakebase_vector`) need per-project enablement done by the user AFTER the project exists and BEFORE migration `002`. Migration `002` must degrade gracefully if they're absent.

---

### Task 1: `sandbox` target + drop development mode

**Files:**
- Modify: `databricks.yml` (the `targets:` block at EOF, and add a `warehouse_id`-style note — vars already exist)

**Interfaces:**
- Produces: bundle target `sandbox` (host + `var.catalog=otto_demo` + `var.warehouse_id=2851116f4d37c9d2`); `dev` target with no `mode`.

- [ ] **Step 1: Replace the `targets:` block**

Replace the existing:
```yaml
targets:
  dev:
    mode: development
    default: true
  prod:
    mode: production
```
with:
```yaml
targets:
  # No development mode: resources are NOT prefixed with [dev <user>].
  dev:
    default: true
  prod:
    mode: production
  # Fresh Azure workspace — full self-contained deploy target.
  sandbox:
    workspace:
      host: https://adb-7405605253712899.19.azuredatabricks.net
    variables:
      catalog: otto_demo
      warehouse_id: 2851116f4d37c9d2
```

- [ ] **Step 2: Validate the sandbox target**

Run: `databricks bundle validate -t sandbox --profile otto-sandbox`
Expected: PASS. Confirm output shows `Host: https://adb-7405605253712899.19...` and no `[dev ...]` name prefixes.

- [ ] **Step 3: Validate the dev target still parses (no deploy)**

Run: `databricks bundle validate -t dev --profile fevm-perma-vm`
Expected: PASS. Confirm resource names no longer carry `[dev otto_jaaskelainen]`.

- [ ] **Step 4: Commit**

```bash
git add databricks.yml
git commit -m "feat(dab): add sandbox target (Azure), drop development-mode prefix"
```

---

### Task 2: Complete the Lakebase control plane in `resources/lakebase.yml`

**Files:**
- Modify: `resources/lakebase.yml` (rewrite: add project/database/catalog/roles; re-point branch/endpoint/synced-table; parameterize catalog/schema via vars)

**Interfaces:**
- Consumes: `var.catalog`, `var.schema` (from Task 1 / existing vars).
- Produces: `resources.postgres_projects.northpeak`, `resources.postgres_databases.production_db`, `resources.postgres_catalogs.northpeak_uc`, `resources.postgres_roles.app_sp` + `.dev_user`, and the re-pointed `postgres_branches.dev_otto` / `postgres_endpoints.dev_otto_primary` / `postgres_synced_tables.open_shortfalls_sync`. Project path `projects/northpeak`.

- [ ] **Step 1: Confirm the API shapes before writing**

Run: `databricks postgres create-project -h; databricks postgres create-database -h; databricks postgres create-catalog -h; databricks postgres create-role -h`
Expected: note the `--json` body fields. Roles take `{"spec": {"identity_type", "postgres_role", "auth_method"}}` (do NOT wrap in `{"role":...}`).

- [ ] **Step 2: Rewrite `resources/lakebase.yml`**

```yaml
# Lakebase Postgres control plane — declared as DAB resources so a single
# `bundle deploy -t sandbox` stands up the whole database layer on a fresh
# workspace. (Beta, loosely-typed resources: first deploy is the real shape
# check — correct fields against `databricks postgres create-* -h` if rejected.)
resources:

  # Top-level project. Auto-creates a `production` branch + `primary` endpoint.
  postgres_projects:
    northpeak:
      project_id: northpeak
      spec:
        display_name: "NorthPeak Retail"

  # Explicit database on the production branch (default databricks_postgres).
  postgres_databases:
    production_db:
      parent: projects/northpeak/branches/production
      database_id: databricks_postgres

  # UC registration catalog for this Lakebase project (Postgres → UC).
  postgres_catalogs:
    northpeak_uc:
      # NB: confirm exact field names at first deploy (create-catalog -h).
      catalog_id: northpeak_lakebase
      parent: projects/northpeak
      spec:
        database: databricks_postgres
        branch: projects/northpeak/branches/production

  # Roles: the app service principal (least privilege) + the developer.
  postgres_roles:
    app_sp:
      parent: projects/northpeak/branches/production
      role_id: ${resources.apps.northpeak_app.service_principal_client_id}
      spec:
        identity_type: SERVICE_PRINCIPAL
        postgres_role: ${resources.apps.northpeak_app.service_principal_client_id}
        auth_method: LAKEBASE_OAUTH_V1
    dev_user:
      parent: projects/northpeak/branches/production
      role_id: otto.jaaskelainen@databricks.com
      spec:
        identity_type: USER
        postgres_role: otto.jaaskelainen@databricks.com
        auth_method: LAKEBASE_OAUTH_V1
        membership_roles:
          - DATABRICKS_SUPERUSER

  # Dev branch off production (copy-on-write), 7-day TTL.
  postgres_branches:
    dev_otto:
      branch_id: dev-otto
      parent: projects/northpeak
      source_branch: projects/northpeak/branches/production
      ttl: "604800s"

  # Scale-to-zero dev endpoint (0.5–1 CU, suspend 300s).
  postgres_endpoints:
    dev_otto_primary:
      endpoint_id: primary
      parent: projects/northpeak/branches/dev-otto
      endpoint_type: ENDPOINT_TYPE_READ_WRITE
      autoscaling_limit_min_cu: 0.5
      autoscaling_limit_max_cu: 1
      suspend_timeout_duration: "300s"

  # SNAPSHOT sync: UC gold_open_shortfalls → Postgres public.gold_open_shortfalls.
  postgres_synced_tables:
    open_shortfalls_sync:
      synced_table_id: northpeak_lakebase.public.gold_open_shortfalls
      source_table_full_name: ${var.catalog}.${var.schema}.gold_open_shortfalls
      primary_key_columns:
        - store_id
        - product_id
      scheduling_policy: SNAPSHOT
      branch: projects/northpeak/branches/production
      postgres_database: databricks_postgres
      create_database_objects_if_missing: true
      new_pipeline_spec:
        storage_catalog: ${var.catalog}
        storage_schema: ${var.schema}
```

- [ ] **Step 3: Validate**

Run: `databricks bundle validate -t sandbox --profile otto-sandbox`
Expected: PASS (passthrough resources parse). If it errors on an unknown top-level key, that resource type name is wrong — re-check against `databricks bundle schema | grep postgres`.

- [ ] **Step 4: Commit**

```bash
git add resources/lakebase.yml
git commit -m "feat(lakebase): declare full postgres control plane as DAB resources"
```

---

### Task 3: In-database SQL migrations

**Files:**
- Create: `lakebase/migrations/001_northpeak_schema.sql`
- Create: `lakebase/migrations/002_search.sql`

**Interfaces:**
- Produces: idempotent DDL applied by Task 4's runner. Schema `northpeak`; tables `replenishment_actions`, `action_audit`, `inventory_notes`; extensions + BM25/ANN indexes.

- [ ] **Step 1: Write `lakebase/migrations/001_northpeak_schema.sql`**

```sql
-- 001_northpeak_schema.sql — writable operational tables (idempotent).
CREATE SCHEMA IF NOT EXISTS northpeak;

CREATE TABLE IF NOT EXISTS northpeak.replenishment_actions (
    id                       SERIAL PRIMARY KEY,
    store_id                 TEXT NOT NULL,
    product_id               TEXT NOT NULL,
    move_type                TEXT NOT NULL,
    source_store_id          TEXT,
    units                    INTEGER NOT NULL DEFAULT 0,
    draft_note               TEXT,
    predicted_recaptured_usd NUMERIC(12,2),
    status                   TEXT NOT NULL DEFAULT 'DRAFT',
    approved_by              TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    priority                 INTEGER DEFAULT 3 CHECK (priority BETWEEN 1 AND 5)
);

CREATE TABLE IF NOT EXISTS northpeak.action_audit (
    id         SERIAL PRIMARY KEY,
    action_id  INTEGER NOT NULL
                 REFERENCES northpeak.replenishment_actions(id) ON DELETE CASCADE,
    event      TEXT NOT NULL,
    detail     TEXT,
    at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_replenishment_priority
    ON northpeak.replenishment_actions (priority, status, created_at DESC);
```

- [ ] **Step 2: Write `lakebase/migrations/002_search.sql`**

```sql
-- 002_search.sql — hybrid search (BM25 + ANN). Requires per-project Search
-- Beta enablement; the runner skips this file cleanly if extensions are absent.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS lakebase_text;
CREATE EXTENSION IF NOT EXISTS lakebase_vector;

CREATE TABLE IF NOT EXISTS northpeak.inventory_notes (
    id                 SERIAL PRIMARY KEY,
    store_id           TEXT,
    product_name       TEXT,
    region             TEXT,
    on_hand_units      INTEGER,
    merch_note         TEXT,
    markdown_risk_score DOUBLE PRECISION,
    search_ts          TSVECTOR,
    embedding          VECTOR(8)
);

CREATE INDEX IF NOT EXISTS idx_inventory_notes_bm25
    ON northpeak.inventory_notes USING lakebase_bm25 (search_ts tsvector_bm25_ops);
CREATE INDEX IF NOT EXISTS idx_inventory_notes_ann
    ON northpeak.inventory_notes USING lakebase_ann (embedding vector_cosine_ops);
```

- [ ] **Step 3: Sanity-check the files exist and are idempotent**

Run: `grep -c "IF NOT EXISTS" lakebase/migrations/001_northpeak_schema.sql; grep -c "IF NOT EXISTS" lakebase/migrations/002_search.sql`
Expected: `001` ≥ 4, `002` ≥ 5 (every CREATE guarded).

- [ ] **Step 4: Commit**

```bash
git add lakebase/migrations/001_northpeak_schema.sql lakebase/migrations/002_search.sql
git commit -m "feat(lakebase): idempotent in-DB migrations (northpeak schema + search)"
```

---

### Task 4: Migration runner + unit test

**Files:**
- Create: `lakebase/apply_migrations.py`
- Create: `lakebase/test_apply_migrations.py`

**Interfaces:**
- Consumes: env `LAKEBASE_PROJECT_ID`, `LAKEBASE_BRANCH_ID` (default `production`), `LAKEBASE_ENDPOINT_ID` (default `primary`), `PGUSER`, `PGDATABASE` (default `databricks_postgres`); `.sql` files from `lakebase/migrations/`.
- Produces: `pending_migrations(applied: set[str], all_files: list[str]) -> list[str]` (pure, sorted); `apply(conn, path)` per-file with graceful skip on `UndefinedFile`/extension errors for `002`; `main()`.

- [ ] **Step 1: Write the failing test `lakebase/test_apply_migrations.py`**

```python
from apply_migrations import pending_migrations

def test_returns_unapplied_in_sorted_order():
    all_files = ["002_search.sql", "001_northpeak_schema.sql"]
    assert pending_migrations(set(), all_files) == [
        "001_northpeak_schema.sql", "002_search.sql",
    ]

def test_skips_already_applied():
    all_files = ["001_northpeak_schema.sql", "002_search.sql"]
    applied = {"001_northpeak_schema.sql"}
    assert pending_migrations(applied, all_files) == ["002_search.sql"]

def test_empty_when_all_applied():
    files = ["001_northpeak_schema.sql"]
    assert pending_migrations(set(files), files) == []
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd lakebase && python3 -m pytest test_apply_migrations.py -v`
Expected: FAIL — `ModuleNotFoundError`/`ImportError: cannot import name 'pending_migrations'`.

- [ ] **Step 3: Write `lakebase/apply_migrations.py`**

```python
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd lakebase && python3 -m pytest test_apply_migrations.py -v`
Expected: 3 passed. (Tests exercise only the pure `pending_migrations`; no DB needed.)

- [ ] **Step 5: Commit**

```bash
git add lakebase/apply_migrations.py lakebase/test_apply_migrations.py
git commit -m "feat(lakebase): psycopg migration runner + unit tests"
```

---

### Task 5: `lakebase_migrate` bundle job

**Files:**
- Create: `resources/jobs.yml`

**Interfaces:**
- Consumes: `resources.postgres_projects.northpeak` (project id). Runs `lakebase/apply_migrations.py`.
- Produces: `resources.jobs.lakebase_migrate`.

- [ ] **Step 1: Confirm serverless python-task shape**

Run: `grep -rn "spark_python_task\|environment_key\|client:" databricks.yml`
Expected: the existing `northpeak_setup` job shows the serverless `environments:` pattern to mirror.

- [ ] **Step 2: Write `resources/jobs.yml`**

```yaml
# In-database migration runner: applies lakebase/migrations/*.sql to the
# deployed Lakebase project. Run AFTER the project exists (and after the user
# enables per-project Search Beta) — see the deploy runbook.
resources:
  jobs:
    lakebase_migrate:
      name: "[NorthPeak] Lakebase in-DB migrations"
      description: "Applies northpeak.* schema + search DDL to the Lakebase project (idempotent)."
      tasks:
        - task_key: apply_migrations
          spark_python_task:
            python_file: ./lakebase/apply_migrations.py
          environment_key: sdk_default
      environments:
        - environment_key: sdk_default
          spec:
            client: "4"
            dependencies:
              - "psycopg[binary]"
              - databricks-sdk
```

- [ ] **Step 3: Validate**

Run: `databricks bundle validate -t sandbox --profile otto-sandbox`
Expected: PASS; `lakebase_migrate` appears in the plan.

- [ ] **Step 4: Commit**

```bash
git add resources/jobs.yml
git commit -m "feat(lakebase): lakebase_migrate bundle job runs the SQL runner"
```

---

### Task 6: AI Gateway (Build 3) as DAB resources

**Files:**
- Create: `resources/gateway.yml` (gateway schema + serving endpoint + guardrail-setup job)
- Create: `gateway/sandbox_guardrail.sql` (catalog-adjusted UC guardrail function)

**Interfaces:**
- Consumes: `var.catalog` (=`otto_demo`), `var.warehouse_id`.
- Produces: `resources.schemas.gateway_schema` (`otto_demo.northpeak_gateway`), `resources.model_serving_endpoints.northpeak_ai_gateway` (serves `system.ai.gpt-oss-120b` via provisioned throughput + AI Gateway config), `resources.jobs.gateway_setup` (creates the guardrail UC function). Endpoint name `northpeak-ai-gateway` — referenced by Task 7's app binding and Task 8's `AGENT_MODEL`.

- [ ] **Step 1: Confirm the provisioned-throughput range + model version**

Run: `databricks serving-endpoints get databricks-gpt-oss-120b --profile otto-sandbox -o json | python3 -c "import json,sys;d=json.load(sys.stdin);e=d['config']['served_entities'][0];print('foundation:',e.get('foundation_model',{}).get('name'));print('version:',e.get('entity_version'))"`
Expected: `foundation: system.ai.gpt-oss-120b`. Note the version. For the PT token range, also check the model's supported range (`databricks serving-endpoints get-open-api databricks-gpt-oss-120b` or the PT docs); record the `max_provisioned_throughput` to use. If PT is not permitted for this model on the workspace, STOP and fall back to a lighter FM (`system.ai.llama-3-3-70b`) or the external-model+secret wrapper — record which.

- [ ] **Step 2: Write `resources/gateway.yml`**

```yaml
# AI Gateway (Build 3) — governed serving endpoint over a Databricks-hosted FM,
# self-contained on sandbox (no external_model, no cross-workspace, no secret).
resources:
  schemas:
    gateway_schema:
      catalog_name: ${var.catalog}
      name: northpeak_gateway
      comment: "Holds the AI Gateway inference table (auto-captured LLM calls)."

  model_serving_endpoints:
    northpeak_ai_gateway:
      name: northpeak-ai-gateway
      config:
        served_entities:
          - name: gpt-governed
            entity_name: system.ai.gpt-oss-120b
            entity_version: "1"            # from Step 1
            min_provisioned_throughput: 0  # 0 → scale-to-zero
            max_provisioned_throughput: 9500  # from Step 1 supported range
      ai_gateway:
        inference_table_config:
          enabled: true
          catalog_name: ${var.catalog}
          schema_name: northpeak_gateway
          table_name_prefix: app_gw
        usage_tracking_config:
          enabled: true
        guardrails:
          input:
            pii:
              behavior: BLOCK
        rate_limits:
          - calls: 100
            renewal_period: minute
            key: endpoint

  jobs:
    gateway_setup:
      name: "[NorthPeak] AI Gateway — guardrail function"
      description: "Creates the guard_block_all_data UC function in otto_demo.northpeak_gateway."
      tasks:
        - task_key: create_guardrail
          sql_task:
            warehouse_id: ${var.warehouse_id}
            file:
              path: ./gateway/sandbox_guardrail.sql
```

- [ ] **Step 3: Write `gateway/sandbox_guardrail.sql`**

```sql
-- Sandbox AI Gateway custom guardrail: TRUE = block a runaway all-data read.
-- (catalog-adjusted copy of gateway/guard_block_all_data.sql for otto_demo)
CREATE OR REPLACE FUNCTION `otto_demo`.`northpeak_gateway`.guard_block_all_data(prompt STRING)
RETURNS BOOLEAN
COMMENT 'AI Gateway custom guardrail: TRUE = block a runaway all-data read'
RETURN lower(prompt) RLIKE
  '(all customers|every account|entire dataset|read everything|unfiltered|no filter|select \\*|list all customers|all rows|entire table|all data|every record|dump the table)';
```

- [ ] **Step 4: Validate**

Run: `databricks bundle validate -t sandbox --profile otto-sandbox`
Expected: PASS; `northpeak-ai-gateway`, `gateway_schema`, and `gateway_setup` appear in the plan.

- [ ] **Step 5: Commit**

```bash
git add resources/gateway.yml gateway/sandbox_guardrail.sql
git commit -m "feat(gateway): AI Gateway as DAB resources (PT endpoint + inference schema + guardrail)"
```

---

### Task 7: `apps.northpeak_app` DAB resource

**Files:**
- Create: `resources/app.yml`

**Interfaces:**
- Consumes: `var.warehouse_id`; `resources.genie_spaces.northpeak_genie.id`; `resources.postgres_databases.production_db` (branch/database paths); `resources.model_serving_endpoints.northpeak_ai_gateway` (Task 6).
- Produces: `resources.apps.northpeak_app` with bindings named `sql-warehouse`, `postgres`, `genie-space`, `agent-gateway` (names MUST match `app.yaml` `valueFrom` / usage); exposes `service_principal_client_id` (used by Task 2's `app_sp` role).

- [ ] **Step 1: Write `resources/app.yml`**

```yaml
# NorthPeak Store Ops app as a first-class bundle resource. Data/model backends
# resolve purely via bindings (names match app/app.yaml valueFrom / usage):
#   sql-warehouse → DATABRICKS_WAREHOUSE_ID / WAREHOUSE_ID
#   postgres      → PG* + LAKEBASE_ENDPOINT
#   genie-space   → GENIE_SPACE_ID
#   agent-gateway → the AI Gateway serving endpoint (SP gets CAN_QUERY)
# Catalog/schema/AGENT_MODEL are literals in app.yaml; dashboard/pipeline IDs are
# stamped post-deploy (finalize_sandbox.sh). dist/ is built locally before deploy.
resources:
  apps:
    northpeak_app:
      name: northpeak-store-ops
      description: "NorthPeak Store Ops — stockout & markdown rescue."
      source_code_path: ./app
      resources:
        - name: sql-warehouse
          sql_warehouse:
            id: ${var.warehouse_id}
            permission: CAN_USE
        - name: postgres
          postgres:
            branch: projects/northpeak/branches/production
            database: projects/northpeak/branches/production/databases/databricks_postgres
        - name: genie-space
          genie_space:
            name: northpeak-genie
            space_id: ${resources.genie_spaces.northpeak_genie.id}
            permission: CAN_RUN
        - name: agent-gateway
          serving_endpoint:
            name: northpeak-ai-gateway
            permission: CAN_QUERY
```

- [ ] **Step 2: Validate**

Run: `databricks bundle validate -t sandbox --profile otto-sandbox`
Expected: PASS; `northpeak-store-ops` app appears with 4 resource bindings (incl. `agent-gateway`).

- [ ] **Step 3: Verify no circular-reference error**

Note: Task 2's `app_sp` role references `${resources.apps.northpeak_app.service_principal_client_id}`, and this app does not reference the role — so there is no cycle. If validate reports an unresolved reference for `service_principal_client_id` (SP not known until app is created), fall back to granting the `app_sp` role via SQL in the runbook instead of as a `postgres_roles` resource. Record which path was taken.
Run: `databricks bundle validate -t sandbox --profile otto-sandbox 2>&1 | grep -i "cycle\|circular\|service_principal" || echo "no ref errors"`
Expected: `no ref errors` (or a clear message → apply the fallback).

- [ ] **Step 4: Commit**

```bash
git add resources/app.yml
git commit -m "feat(app): declare northpeak_app as DAB resource with data bindings"
```

---

### Task 8: Wire `app.yaml` env to the deployed resources

**Files:**
- Modify: `app/app.yaml` (env block)

**Interfaces:**
- Consumes: the `genie-space` binding name from Task 7.
- Produces: app env `GENIE_SPACE_ID` (valueFrom), `AGENT_MODEL` + `DEMO_CATALOG`/`DEMO_SCHEMA` literals. Existing `DATABRICKS_WAREHOUSE_ID`/`WAREHOUSE_ID`/`LAKEBASE_ENDPOINT` unchanged.

- [ ] **Step 1: Extend the `env:` block in `app/app.yaml`**

Append to the existing `env:` list (keep `command:` and `user_authorization:` intact):
```yaml
  # ── Genie (binding-derived) ─────────────────────────────────────────
  # config/app.json reads GENIE_SPACE_ID; the genie-space binding supplies it.
  - name: GENIE_SPACE_ID
    valueFrom: genie-space

  # ── Agent LLM → the governed AI Gateway endpoint (Build 3) ──────────
  # config/app.json agentModel = ${AGENT_MODEL:northpeak-ai-gateway}; set it
  # explicitly. The agent-gateway binding grants the SP CAN_QUERY on it.
  - name: AGENT_MODEL
    value: northpeak-ai-gateway

  # ── Data (literals for this deploy — otto_demo / northpeak_retail) ───
  # Drive the boot-sync source + analytics session context so the app reads
  # THIS bundle's gold tables, never config/app.json's ai_demo_gen default.
  - name: DEMO_CATALOG
    value: otto_demo
  - name: DEMO_SCHEMA
    value: northpeak_retail

  # DASHBOARD_ID and PIPELINE_ID are stamped post-deploy by
  # app/scripts/finalize_sandbox.sh (not bindable).
```

- [ ] **Step 2: Validate the app.yaml is still well-formed**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('app/app.yaml')); print('app.yaml OK')"`
Expected: `app.yaml OK`.

- [ ] **Step 3: Re-validate the bundle**

Run: `databricks bundle validate -t sandbox --profile otto-sandbox`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/app.yaml
git commit -m "feat(app): wire GENIE_SPACE_ID binding + catalog/schema literals"
```

---

### Task 9: Post-deploy ID stamp (`finalize_sandbox.sh`)

**Files:**
- Create: `app/scripts/finalize_sandbox.sh`

**Interfaces:**
- Consumes: `databricks bundle summary -t sandbox -o json` (resolved dashboard + pipeline IDs).
- Produces: `DASHBOARD_ID` / `PIPELINE_ID` env lines injected into `app/app.yaml`, then `bundle deploy -t sandbox` (re-sync) so the app picks them up.

- [ ] **Step 1: Write `app/scripts/finalize_sandbox.sh`**

```bash
#!/usr/bin/env bash
# Stamp the two non-bindable IDs (dashboard, pipeline) into app/app.yaml from
# the deployed bundle, then redeploy so the app reads THIS bundle's resources.
# Idempotent: removes any previously-stamped block first.
set -euo pipefail
PROFILE="${DATABRICKS_CONFIG_PROFILE:-otto-sandbox}"
BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_YAML="$BUNDLE_DIR/app/app.yaml"
MARK="# >>> finalize_sandbox stamped IDs"

cd "$BUNDLE_DIR"
SUMMARY="$(databricks bundle summary -t sandbox -o json --profile "$PROFILE")"
DASH=$(printf '%s' "$SUMMARY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['resources']['dashboards']['northpeak_dashboard']['id'])")
PIPE=$(printf '%s' "$SUMMARY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['resources']['pipelines']['northpeak_operations']['id'])")

# Remove a previously-stamped block (idempotent), then append the fresh one.
python3 - "$APP_YAML" "$MARK" <<'PY'
import sys,re
path,mark=sys.argv[1],sys.argv[2]
txt=open(path).read()
txt=re.sub(re.escape(mark)+r".*?# <<< finalize_sandbox\n","",txt,flags=re.S)
open(path,"w").write(txt.rstrip()+"\n")
PY

cat >> "$APP_YAML" <<EOF
$MARK
  - name: DASHBOARD_ID
    value: "$DASH"
  - name: PIPELINE_ID
    value: "$PIPE"
# <<< finalize_sandbox
EOF

echo "Stamped DASHBOARD_ID=$DASH PIPELINE_ID=$PIPE into app.yaml"
databricks bundle deploy -t sandbox --profile "$PROFILE"
```

- [ ] **Step 2: Make executable + shellcheck**

Run: `chmod +x app/scripts/finalize_sandbox.sh && shellcheck app/scripts/finalize_sandbox.sh || true`
Expected: executable; shellcheck reports no errors (warnings acceptable). Note: the stamped lines are appended under the existing `env:` list — verify indentation matches the two-space list level after first real run.

- [ ] **Step 3: Commit**

```bash
git add app/scripts/finalize_sandbox.sh
git commit -m "feat(app): finalize_sandbox stamps dashboard/pipeline IDs post-deploy"
```

---

### Task 10: Deploy runbook + full validate gate

**Files:**
- Create: `docs/DEPLOY_SANDBOX.md`

**Interfaces:**
- Consumes: everything above. This task does NOT run the live deploy — it documents the user-gated sequence and confirms the bundle validates end-to-end.

- [ ] **Step 1: Full bundle validate**

Run: `databricks bundle validate -t sandbox --profile otto-sandbox`
Expected: PASS; the plan lists schema (incl. `gateway_schema`), volume, pipeline, jobs (`northpeak_setup`, `lakebase_migrate`, `gateway_setup`), dashboard, genie space, the AI Gateway serving endpoint, the app, and all `postgres_*` resources.

- [ ] **Step 2: Build the app artifact locally**

Run: `cd app && ./scripts/build-app.sh && ls dist/server.js`
Expected: `dist/server.js` exists (the container does not build; DAB syncs `dist/`).

- [ ] **Step 3: Write `docs/DEPLOY_SANDBOX.md`**

Document the exact user-gated order (verbatim commands):
```
1. databricks bundle validate -t sandbox --profile otto-sandbox
2. (build app)  cd app && ./scripts/build-app.sh && cd ..
3. databricks bundle deploy -t sandbox --profile otto-sandbox
     → creates catalog-nested schema/volume (incl. northpeak_gateway),
       pipeline, jobs, dashboard, genie space, the AI Gateway serving
       endpoint, the app, and the Lakebase project/branch/endpoint/
       database/UC-catalog/synced-table.
     → If a postgres_* resource is rejected: correct its fields against
       `databricks postgres create-<x> -h` and redeploy (Beta shapes).
     → The gateway endpoint (provisioned throughput) can take several minutes.
4. databricks bundle run northpeak_setup -t sandbox --profile otto-sandbox
5. databricks bundle run northpeak_operations -t sandbox --profile otto-sandbox
6. Enable per-project Search Beta on project `northpeak` (UI: project →
     settings → enable search / shared_preload_libraries). REQUIRED before step 7
     for migration 002; 001 works regardless.
7. databricks bundle run lakebase_migrate -t sandbox --profile otto-sandbox
8. databricks bundle run gateway_setup -t sandbox --profile otto-sandbox
     → creates otto_demo.northpeak_gateway.guard_block_all_data
9. DATABRICKS_CONFIG_PROFILE=otto-sandbox ./app/scripts/finalize_sandbox.sh
10. Smoke:
     - databricks apps get northpeak-store-ops --profile otto-sandbox -o json  (state RUNNING, note url)
     - open the app; confirm map/queue show otto_demo data, Genie answers,
       dashboard tab renders the deployed dashboard.
     - agent chat: send a normal prompt (routes through northpeak-ai-gateway;
       a row should land in otto_demo.northpeak_gateway.app_gw_*), then a
       PII / "read all data" prompt (gateway blocks it).
```
Also record: the `service_principal_client_id` role path taken in Task 7 Step 3, the backing-model / PT decision from Task 6 Step 1, and the `bundle destroy` warning (never destroy — `otto_demo` is external, but the Lakebase project, gateway endpoint + app would be removed).

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOY_SANDBOX.md
git commit -m "docs: sandbox deploy runbook + full-validate gate"
```

---

## Self-Review

**Spec coverage:**
- New `sandbox` target + drop dev mode → Task 1 ✓
- Control-plane completion (project/db/catalog/roles + re-point) → Task 2 ✓
- Catalog by-name (no create/bind) → Global Constraints + Task 1 vars ✓ (no catalog resource authored anywhere)
- In-DB migration artifact → Tasks 3 + 4 + 5 ✓
- AI Gateway in DAB (schema + PT endpoint + guardrail function) → Task 6 ✓
- App as DAB resource, binding-first (incl. `agent-gateway`) → Task 7 ✓; env wiring (Genie + AGENT_MODEL + catalog/schema) → Task 8 ✓
- Non-bindable dashboard/pipeline stamp → Task 9 ✓
- Per-project search ordering → Task 10 runbook step 6 ✓
- Deploy user-gated → Task 10 ✓

**Placeholder scan:** All SQL/YAML/Python/bash is literal. The only deliberate "confirm at deploy" notes are (a) Beta passthrough `postgres_*` field shapes and (b) the gateway provisioned-throughput token range / model version (Task 6 Step 1) — both flagged per Global Constraints with the CLI `-h` / API fallback, not hand-waving.

**Type consistency:** `pending_migrations(applied, all_files)` signature identical in test (Task 4 Step 1) and impl (Step 3). App binding names `sql-warehouse`/`postgres`/`genie-space`/`agent-gateway` (Task 7) match `app.yaml` `valueFrom`/usage keys (existing + Task 8) and the endpoint name `northpeak-ai-gateway` (Task 6). Project path `projects/northpeak`, branch `production`/`dev-otto`, endpoint `primary`, database `databricks_postgres` used identically across Tasks 2, 4, 7, 10.
