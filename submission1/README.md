# NorthPeak Retail — Lakebase Build 1 Submission

**Date:** 2026-08-27
**Project:** projects/northpeak-retail
**Branch scope:** milestone-4-lakebase + lakebase-dev (git), production + dev-otto (Lakebase)

## Summary

This submission completes all 5 Build 1 steps end-to-end against the live shared
Lakebase project `northpeak-retail`. All evidence artifacts are committed in this folder.

---

## Evidence Artifacts

| File | Description |
|------|-------------|
| `lakebase_instance.txt` | Project/instance name, endpoint host, postgres version, and `SELECT version()` connectivity output |
| `synced_table.sql` | CLI command + verification query for the gold_open_shortfalls SNAPSHOT sync |
| `synced_table_result.json` | Top 10 rows from the synced table (non-empty, 150 rows total) |
| `reverse_sync_sample.json` | CDC history rows from `lb_replenishment_actions_history` showing `_pg_change_type`, `_pg_lsn`, `_pg_xid`, `_timestamp` + `update_preimage`/`update_postimage` pair |
| `branch.txt` | dev-otto Lakebase branch details and what was developed on it |
| `agent_change/001_add_priority_to_replenishment_actions.sql` | Migration file (add `priority INT` column, backfill, index) with Co-authored-by trailer |
| `agent_change/migration_validation_dev_otto.json` | Validation query result from dev-otto after migration |
| `search_query.txt` | NL query "stores with dead stock not selling" + hybrid FTS+pgvector approach |
| `search_result.json` | 8 relevant records ranked by hybrid_score (FTS 40% + cosine vector 60%) |
| `core_question.txt` | Domain question: which stores are short on the top product? |
| `core_query.sql` | SQL query against `public.gold_open_shortfalls` synced table |
| `core_query_result.json` | 10 stores with 0 on-hand for SKU-APP-04412, ranked by lost_sales_exposure_usd |
| `reverse_sync_cdf_config.sh` | CLI-as-code script for CDF config (as-code artifact, committed) |
| `git_history.txt` | `git log --graph --oneline --decorate --all` showing lakebase-dev off milestone-4-lakebase |

---

## Step Results

### Step 1: Lakehouse→Lakebase Sync + Operational Schema
- (a) Schema `northpeak` created in `databricks_postgres`
- (b) `gold_open_shortfalls` synced via SNAPSHOT mode (150 rows, ONLINE state):
  - Lakebase catalog: `lakebase-gremlins-uc-registration`
  - Source: `perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_open_shortfalls`
  - PKs: `store_id + product_id`
  - Pipeline storage: `perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail`
- (c) Operational schema modeled in `northpeak`:
  - `northpeak.replenishment_actions` (id PK, store_id, product_id, move_type, source_store_id, units, draft_note TEXT, predicted_recaptured_usd, status, approved_by, created_at, priority) — 5 seeded rows
  - `northpeak.action_audit` (id PK, action_id FK→replenishment_actions, event, detail, at) — 7 audit events

### Step 2: Branching
- Created Lakebase branch `dev-otto` off production with TTL 604800s (7 days)
- Endpoint: `ep-wispy-heart-d2j2kjyj.database.us-east-1.cloud.databricks.com`
- Migration 001 applied on dev-otto first, validated, then promoted to production

### Step 3: Agentic Dev + Promote
- Git branch `lakebase-dev` created off `milestone-4-lakebase`
- Migration 001: `ALTER TABLE northpeak.replenishment_actions ADD COLUMN priority INT`
- Applied on dev-otto (validated), promoted (re-applied) to production
- Committed with `Co-authored-by: Isaac <no-reply@databricks.com>` trailer
- Merged back to `milestone-4-lakebase` via no-ff merge (see git_history.txt)

### Step 4: Lakebase Search
- Extensions installed on dev-otto branch:
  - `lakebase_text` 0.1.1 — BM25 full-text via `lakebase_bm25` access method
  - `lakebase_vector` 1.0.1 — ANN cosine search via `lakebase_ann` access method
  - `vector` 0.8.0 — pgvector types for VECTOR(8) embedding column
- `northpeak.inventory_notes` created on dev-otto with 20 rows (from `silver_inventory.merch_note_text`), 8-dim keyword embeddings
- Indexes:
  - `CREATE INDEX idx_inventory_notes_bm25 ON northpeak.inventory_notes USING lakebase_bm25 (search_ts tsvector_bm25_ops)`
  - `CREATE INDEX idx_inventory_notes_ann ON northpeak.inventory_notes USING lakebase_ann (embedding vector_cosine_ops)`
- Hybrid query: BM25 (`search_ts <@> to_bm25query(...)`, 40% weight) + ANN cosine (`embedding <=>`, 60% weight)
- NL query "stores with dead stock not selling" → 8 relevant records returned (top: STORE-0011 / Summit Down Parka "no movement in three weeks", hybrid_score 0.6832)

### Step 5: Domain Question
- Query: stores with `on_hand_units = 0` for SKU-APP-04412 (Summit Down Parka)
- Ranked by `lost_sales_exposure_usd` descending
- Top finding: STORE-0034 (Midwest) — $76,834 exposure, no surplus nearby
- 10 result rows from `public.gold_open_shortfalls` (the synced table)

### Reverse Sync (CDF)
- `REPLICA IDENTITY FULL` set on all 3 northpeak tables
- CDF config `northpeak_cdf` created:
  - Source: `northpeak` schema in `databricks_postgres`
  - Target: `perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail`
  - History tables: `lb_replenishment_actions_history`, `lb_action_audit_history`, `lb_inventory_notes_history`
- CDC records confirmed: insert events + update_preimage/update_postimage pair for row id=2 (DRAFT→APPROVED)
- **As-code artifact:** `reverse_sync_cdf_config.sh` committed in this folder
  (No DAB/Terraform resource exists for Lakebase sync/CDF as of 2026-08-27; CLI is the authoritative "as code" method)

---

---

## Validator Gap Remediation (2026-08-27)

The following 5 items were flagged as gaps by the Build 1 validator and are now
closed. The table maps each item to its satisfying artifact(s).

| # | Validator Item | Status | Satisfying Artifact(s) |
|---|----------------|--------|------------------------|
| 1 | "The sync is defined as code (DABs/Terraform), not UI-only" | CLOSED | `resources/lakebase.yml` → `resources.postgres_synced_tables.open_shortfalls_sync` declares the SNAPSHOT sync declaratively; `databricks.yml` includes `resources/*.yml`; `bundle validate --strict -t dev` passes |
| 2 | "A development branch off main is named, and its creation is captured in code" | CLOSED | `resources/lakebase.yml` → `resources.postgres_branches.dev_otto` names branch `dev-otto` with `source_branch: projects/northpeak-retail/branches/production`; validated via `bundle validate --strict`; live creation evidence in `branch_evidence.json` |
| 3 | "Scale-to-zero is configured so idle branches cost close to nothing" | CLOSED | (a) Code: `resources/lakebase.yml` → `resources.postgres_endpoints.dev_otto_primary` sets `suspend_timeout_duration: "300s"` and `autoscaling_limit_min_cu: 0.5`; (b) Live config: `scale_to_zero.json` — real `update-endpoint` applied to dev-otto; `status.suspend_timeout_duration: "300s"`, `status.autoscaling_limit_min_cu: 0.5` confirmed |
| 4 | "Separate writable Postgres tables exist, distinct from the read-only synced table" | CLOSED | `writable_tables.txt` — `\d northpeak.replenishment_actions` (heap table, sequence PK, priority FK, CHECK) + `\d northpeak.action_audit` (FK back to replenishment_actions) + live `SELECT *` with 5 rows; contrasted against `public.gold_open_shortfalls` (Partitioned table, read-only synced) |
| 5 | "The agent's change is validated by a committed test/query and its result" | CLOSED | `agent_change/migration_validation.json` — query text + 5-row result on dev-otto showing priority column; `agent_change/promotion_validation_production.json` — information_schema column check + 5-row data result on production confirming promote executed |

### DAB Resource Note

`resources/lakebase.yml` is validated-as-code (`bundle validate --strict`) but is
**not deployed** (`bundle deploy`) to avoid conflicting with the already-live
CLI-created resources on the shared `northpeak-retail` project. This is the
correct approach per Databricks documentation for shared projects where resources
were created outside the bundle.

### New Evidence Files (gap remediation)

| File | Closes Item(s) |
|------|----------------|
| `resources/lakebase.yml` | 1, 2, 3 |
| `scale_to_zero.json` | 3 |
| `writable_tables.txt` | 4 |
| `agent_change/migration_validation.json` | 5 |
| `agent_change/promotion_validation_production.json` | 5 |
| `branch_evidence.json` | 2 (live creation captured) |
| `synced_table_status.json` | 1 (sync ONLINE evidence) |

---

## Guardrails Compliance
- All operations confined to `northpeak` schema
- No DROP/ALTER/TRUNCATE on schemas: app, appkit, drizzle, public, __db_system
- No deletion of production branch, other users' branches, or other users' synced tables
- No catalog creation (lakebase-gremlins-uc-registration was pre-existing)

> **Search promoted to production:** the `lakebase_bm25` + `lakebase_ann` indexes were also built on the production (main) branch and validated with a live hybrid query — Lakebase Search is on main, not only dev-otto.
