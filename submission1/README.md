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
- `vector` (pgvector 0.8.0) installed via `CREATE EXTENSION IF NOT EXISTS vector`
- `pg_trgm` installed for fuzzy text matching
- Note: `lakebase_vector` and `lakebase_text` require `shared_preload_libraries` (server-side config, not user-installable); pgvector + tsvector used as hybrid stack
- `northpeak.inventory_notes` table created with:
  - GIN index on `search_ts` (tsvector generated column)
  - GIN trigram index on `merch_note`
  - HNSW vector index on `embedding` (8-dim keyword vectors, cosine)
- 20 rows from `silver_inventory.merch_note_text` loaded with 8-dim embeddings
- Hybrid query (FTS 40% + cosine similarity 60%) for "stores with dead stock not selling" returned 8 relevant records

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

## Guardrails Compliance
- All operations confined to `northpeak` schema
- No DROP/ALTER/TRUNCATE on schemas: app, appkit, drizzle, public, __db_system
- No deletion of production branch, other users' branches, or other users' synced tables
- No catalog creation (lakebase-gremlins-uc-registration was pre-existing)
