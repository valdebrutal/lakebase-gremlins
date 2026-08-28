# Fully DAB-managed NorthPeak on `otto-sandbox` (Azure) — Design

**Date:** 2026-08-28
**Author:** Otto Jaaskelainen (with Claude)
**Status:** Draft for review
**Target workspace:** `https://adb-7405605253712899.19.azuredatabricks.net` (profile `otto-sandbox`)

## Goal

Make the NorthPeak Retail bundle **self-contained**: every resource that *can* be
expressed in a Databricks Asset Bundle is in the bundle, so a single
`bundle deploy -t sandbox` (plus a couple of `bundle run` steps) stands up the
entire demo — catalog, schema, volume, pipeline, metric view, dashboard, Genie
space, Lakebase (project → branch → endpoint → database → UC catalog → synced
table), **and the app** — on a fresh workspace.

The one thing that provably cannot live in a DAB is **in-database SQL** (CREATE
SCHEMA / tables / indexes / extensions inside Postgres). That becomes a
versioned migration artifact run by a bundle job.

A hard requirement: **the app must read the resources this bundle deploys** — the
`otto_demo` catalog, the Genie space we create, the Lakebase we create — never the
template-default fallbacks baked into `config/app.json`.

## Context / current state

- The bundle (`databricks.yml`) already declares: `schemas.demo_schema`,
  `volumes.raw_data`, `pipelines.northpeak_operations`, `jobs.northpeak_setup`,
  `dashboards.northpeak_dashboard`, `genie_spaces.northpeak_genie`. Default target
  `dev` points at perma-vm (`perma_vm_catalog`, warehouse `eeaad8547b3c3ab3`).
- `resources/lakebase.yml` declares `postgres_branches` / `postgres_synced_tables`
  / `postgres_endpoints` but references a **pre-existing shared** project
  (`projects/northpeak-retail`, on perma-vm) — hence it could only be validated,
  never deployed.
- The app (`app/`) reads all data sources from **env vars** (`config/app.json`
  substitutes `${VAR}` at boot). It is **not** currently a DAB resource — it
  deploys via `app/scripts/deploy.sh` + `finalize_app.sh`. Its `config/app.json`
  defaults point at *other* data (`ai_demo_gen` catalog, dashboard UUID
  `01f196f54e9c1bd1a595eb8b1af7ea25`).
- CLI is v1.12.1; its bundle schema **does** support the full postgres resource
  set (`postgres_projects/databases/catalogs/roles/endpoints/branches/synced_tables`)
  — the `databricks-lakebase` skill's "not yet available" caveat is stale for this
  version.
- On `otto-sandbox`: catalog `otto_demo` **already exists and is owned by the user**
  (MANAGED_CATALOG); warehouse `2851116f4d37c9d2` (Serverless Starter, stopped);
  **zero** Postgres projects.

## Decisions (locked)

1. **Catalog:** reference the existing `otto_demo` by name (`var.catalog`) — do
   **not** create it and do **not** `bundle deployment bind` it. It stays outside
   the bundle lifecycle, so there is no `bundle destroy` risk (user confirmed).
2. **App:** include as a first-class `apps.northpeak_app` DAB resource.
3. **App data wiring:** binding-first. All data/model backends (warehouse,
   Lakebase, Genie, and the gateway serving endpoint) resolve by platform binding;
   catalog/schema are literals; two non-query IDs (dashboard, pipeline) get stamped
   post-deploy.
4. **In-DB artifact:** versioned SQL migrations + a Python/psycopg runner wired as
   a bundle job.
5. **Deploy timing:** author everything → `bundle validate -t sandbox` → dry-run;
   the user triggers the live deploy.
6. **No development mode / no user prefix.** Remove `mode: development` from the
   `dev` target and do not use it on `sandbox`, so no resource is prefixed with
   `[dev <user>]` anywhere (user requirement).
7. **Search enablement is per-project.** Lakebase Search is enabled at the
   workspace level, but the per-project settings (Search Beta / `shared_preload_
   libraries`) must be enabled by the user **after the Postgres project is
   created** and **before** migration `002` runs.
8. **AI Gateway is in the DAB (Build 3), self-contained on sandbox.** The app
   routes its agent LLM through the governed serving endpoint
   `northpeak-ai-gateway`. On sandbox that endpoint **serves a Databricks-hosted
   foundation model directly** (`system.ai.gpt-oss-120b`, via provisioned
   throughput) — **no** `external_model`, **no** cross-workspace hop to perma-vm,
   **no** token/secret. The AI Gateway config (inference table → `otto_demo.
   northpeak_gateway`, PII guardrail, usage tracking, rate limits) attaches to that
   endpoint. The app binds the endpoint with `CAN_QUERY` (its SP calls it, per
   commit 6cf4328).

## Design

### 1. New bundle target `sandbox` + drop development mode

Add `sandbox` alongside `dev`/`prod`, and **remove `mode: development` from `dev`**
so nothing is prefixed with `[dev <user>]`. `sandbox` also uses no mode (no
prefix). Only the `host` + workspace-specific vars differ for `sandbox`:

```yaml
targets:
  dev:
    default: true
    # mode: development  ← REMOVED (was prefixing resources with [dev <user>])
  prod:
    mode: production
  sandbox:
    # no mode → no [dev <user>] prefix
    workspace:
      host: https://adb-7405605253712899.19.azuredatabricks.net
    variables:
      catalog: otto_demo
      warehouse_id: 2851116f4d37c9d2
```

(`var.schema` keeps its existing default `northpeak_retail` — no need to diverge
from `dev`.)

**Implication of dropping dev mode:** a future `bundle deploy -t dev` will use
unprefixed resource names, which differ from the currently-deployed
`[dev otto_jaaskelainen]`-prefixed perma-vm resources. That can create parallel
unprefixed copies / orphan the old ones — a cleanup to be aware of, but it does
not affect this sandbox work (we deploy `-t sandbox`). The username still appears
in `workspace.root_path` (`/Workspace/Users/${…userName}/…`) — that is a path, not
a resource-name prefix; leave as-is unless the user wants a shared path.

Everything downstream already flows from `var.catalog` / `var.schema` /
`var.warehouse_id`, so the pipeline, dashboard datasets, Genie tables, and app env
all target `otto_demo` automatically.

### 2. Control-plane completion (`resources/lakebase.yml`)

Add the missing resources and re-point the existing ones at a **self-owned**
project (creatable because the user owns it on Azure):

- `postgres_projects.northpeak` — top-level project (auto-creates `production`
  branch + `primary` endpoint).
- `postgres_databases` — the `databricks_postgres` database in the branch.
- `postgres_catalogs` — the UC registration catalog for Lakebase (replaces the
  hand-created `…-uc-registration`).
- `postgres_roles` — the app service-principal role + the developer role.
- Existing `postgres_branches.dev_otto`, `postgres_endpoints.dev_otto_primary`
  (scale-to-zero), `postgres_synced_tables.open_shortfalls_sync` → re-pointed at
  `projects/northpeak` on this workspace, source table
  `otto_demo.northpeak_retail.gold_open_shortfalls`.

Because the postgres resource structs are loosely typed (passthrough) in the
schema, author the inner spec from the live API shapes (`databricks postgres
create-* -h`), not the bundle schema.

### 3. Catalog — reference by name only

`otto_demo` already exists and the user owns it → the bundle **references** it by
name via `var.catalog`; it adds **no** `catalogs.otto_demo` resource and does
**not** `bundle deployment bind` it. The catalog therefore stays entirely outside
the bundle's lifecycle (no create, no destroy). The schema/volume/tables nest
inside it via `catalog_name: ${var.catalog}` exactly as today.

### 4. App as a DAB resource (`apps.northpeak_app`) — binding-first wiring

Bindable app resource types confirmed via `databricks apps manifest`:
`sql_warehouse`, `postgres`, `genie_space`, `serving_endpoint`, `job`,
`vector_search_index`, `volume`. **Not** `dashboard`, **not** `pipeline`.

| App env var | Source | Mechanism |
|---|---|---|
| `DATABRICKS_WAREHOUSE_ID`, `WAREHOUSE_ID` | SQL warehouse | binding + `valueFrom: sql-warehouse` |
| `PGHOST`/`PGDATABASE`/`LAKEBASE_ENDPOINT` | Lakebase branch/db | `postgres` binding |
| `GENIE_SPACE_ID` | deployed Genie space | `genie_space` binding + `valueFrom: genie-space` |
| `DEMO_CATALOG`, `DEMO_SCHEMA` | `otto_demo` / `northpeak_retail` | literals in `app.yaml` (known for this target) |
| `DASHBOARD_ID`, `PIPELINE_ID` | deployed dashboard/pipeline | post-deploy stamp (not bindable) |

The app resource declares the warehouse, postgres, and genie bindings, points
`source_code_path` at `./app`, and syncs `dist/` (built locally via
`scripts/build-app.sh`). The three data backends (warehouse analytics, Lakebase,
Genie NL) therefore resolve **purely by binding** — no possibility of the
template-default catalog/dashboard firing for query paths. Catalog/schema literals
drive the boot-sync source + analytics session context.

**The two non-bindable IDs** (`DASHBOARD_ID` for the embedded dashboard view,
`PIPELINE_ID` for a deep-link tile) are filled by a simplified `finalize` step:
`databricks bundle summary -t sandbox -o json` lists deployed resources with
resolved IDs; the step writes those two into `app.yaml`'s env, then the app
starts. This replaces the existing `finalize_app.sh`'s setup-job-export harvest
(unnecessary now that dashboard/Genie are first-class bundle resources).

### 5. In-database migration artifact

New folder `lakebase/`:

- `lakebase/migrations/001_northpeak_schema.sql` — `CREATE SCHEMA IF NOT EXISTS
  northpeak`; `replenishment_actions` (heap, serial PK, `status`, `priority INT
  DEFAULT 3 CHECK (priority BETWEEN 1 AND 5)`); `action_audit` (heap, serial PK,
  FK → replenishment_actions ON DELETE CASCADE); priority index. (Consolidates the
  Build-1 tables + migration `001`, all idempotent.)
- `lakebase/migrations/002_search.sql` — `CREATE EXTENSION IF NOT EXISTS
  vector/lakebase_text/lakebase_vector`; `inventory_notes` (tsvector `search_ts`,
  `vector(8)` embedding); BM25 (`lakebase_bm25`) + ANN (`lakebase_ann`) indexes;
  seed rows. Search is enabled at the workspace level; the per-project settings
  must be enabled by the user after the project is created (see risks). Migration
  `002` is still guarded so it degrades cleanly (clear skip) if the extensions
  aren't available yet, rather than failing the whole run.
- `lakebase/apply_migrations.py` — mints an OAuth credential
  (`databricks postgres generate-database-credential`), connects via `psycopg`,
  applies files in filename order, tracks applied files in a `northpeak._migrations`
  table (idempotent, re-runnable).
- Bundle job `jobs.lakebase_migrate` — serverless Python task running
  `apply_migrations.py`, parameterized with the deployed branch/endpoint.

The app's Drizzle layer (`app/server/db`, `app.*` schema) is **untouched** — it
keeps self-migrating at boot. `northpeak.*` (Build-1 evidence schema) and `app.*`
(app runtime schema) remain distinct owners.

### 6. AI Gateway (Build 3) as DAB resources

The app (post-Build-3) routes its agent LLM through the governed serving endpoint
`northpeak-ai-gateway` and calls it as the app service principal. Bring the whole
gateway into the bundle, self-contained on sandbox:

- `schemas.gateway_schema` → `otto_demo.northpeak_gateway` — holds the inference
  table (auto-captured by the endpoint).
- `model_serving_endpoints.northpeak_ai_gateway` — **serves the Databricks-hosted
  foundation model directly** via provisioned throughput (served entity
  `system.ai.gpt-oss-120b`), with `ai_gateway`: `inference_table_config`
  (catalog `otto_demo`, schema `northpeak_gateway`, prefix `app_gw`, enabled),
  `usage_tracking_config` (enabled), `guardrails.input.pii.behavior=BLOCK`,
  `rate_limits` (100/min/endpoint). No `external_model`, no secret. (Provisioned
  throughput min/max token rates are model-specific — confirm the supported range
  at author time via `databricks serving-endpoints get databricks-gpt-oss-120b`
  and the PT supported-ranges API; scale-to-zero on if supported to minimize idle
  cost.)
- **Guardrail UC function** `otto_demo.northpeak_gateway.guard_block_all_data` —
  a SQL function (from `gateway/guard_block_all_data.sql`, catalog-adjusted). No
  DAB resource type exists for UC functions, so it is applied via SQL, folded into
  the same setup path as the in-DB migrations (a small `bundle run` step / the
  `lakebase_migrate` job pattern, adapted to run this against the warehouse).
- **App binding:** add a `serving_endpoint` binding named `agent-gateway` on
  `apps.northpeak_app` with `permission: CAN_QUERY` (SP calls it), and set app env
  `AGENT_MODEL=northpeak-ai-gateway` (literal for this target). Genie already runs
  as the SP (covered by the `genie-space` binding).

The committed `gateway/*.json|sql|sh` artifacts are perma-vm-specific
(`databricks-gpt-5-4` via `external_model` to fevm-perma-vm, catalog
`perma_vm_catalog`, secret `northpeak_gateway/token`). The DAB version supersedes
them for sandbox: local FM, `otto_demo` catalog, no secret. The committed files
stay as Build-3 evidence; they are not used by the sandbox deploy.

### Data flow (deployed)

```
generate_data (job)  → raw_* parquet in otto_demo volume
northpeak_operations → silver/gold materialized views in otto_demo.northpeak_retail
dashboard + genie    → read otto_demo.northpeak_retail (via var.catalog/schema)
postgres project     → branch + endpoint + databricks_postgres db
  ├─ synced_table    → gold_open_shortfalls (SNAPSHOT) → public.gold_open_shortfalls
  └─ lakebase_migrate→ northpeak.* schema + search indexes (in-DB SQL)
ai gateway           → northpeak-ai-gateway serves system.ai.gpt-oss-120b (PT)
                       + inference table → otto_demo.northpeak_gateway.app_gw_*
                       + PII guardrail + guard_block_all_data UC function
app (bound)          → warehouse (analytics) + Lakebase (app.* + synced) + Genie (NL)
                       + gateway (agent LLM, CAN_QUERY as SP)
                       + literal catalog/schema/AGENT_MODEL + stamped dashboard/pipeline IDs
```

### Error handling / risks

- **Per-project search enablement (ordering):** Lakebase Search is enabled at the
  workspace level, but the Search Beta / `shared_preload_libraries` settings are
  **per-project** and must be enabled by the user **after** the Postgres project is
  created (step 6) and **before** migration `002` runs (step 8). Migration `002` is
  still guarded so it degrades cleanly if run early; the core `northpeak.*` schema
  from `001` always lands regardless.
- **Catalog:** `otto_demo` is referenced by name only (not created, not bound), so
  it is unaffected by `bundle destroy` — no destroy risk.
- **App build:** `dist/` must be built locally (`scripts/build-app.sh`) before
  deploy; the container does not build.
- **Warehouse stopped:** `2851116f4d37c9d2` is stopped; it auto-starts on first
  query, or start it before the pipeline/dashboard smoke.
- **Synced table storage_catalog:** `new_pipeline_spec.storage_catalog` must be a
  regular UC catalog (`otto_demo`), never the Lakebase catalog (known DLT limit).
- **Provisioned-throughput cost/availability:** `northpeak-ai-gateway` runs PT
  compute for `gpt-oss-120b`. Enable scale-to-zero if the tier supports it to keep
  idle cost near zero; confirm the model is PT-eligible on this workspace at deploy
  (fallback: a lighter FM such as `llama-3-3-70b`, or the external-model+secret
  wrapper). Endpoint creation can take several minutes.
- **Gateway supersedes committed artifacts:** the DAB endpoint replaces the
  perma-vm `gateway/*.json|sh` for sandbox; do not run `setup_gateway_service.sh`
  against sandbox (it targets perma-vm + a secret).

### Deploy sequence (after approval)

1. `databricks bundle validate -t sandbox --profile otto-sandbox`
2. `databricks bundle deploy -t sandbox` (dry-run / review plan first) — includes
   the gateway serving endpoint + gateway schema
3. `bundle run northpeak_setup` (generate raw data)
4. `bundle run northpeak_operations` (build silver/gold)
5. Lakebase project/branch/endpoint/database + synced-table come online
6. **User enables per-project Search settings** on the new project (UI/CLI)
7. `bundle run lakebase_migrate` (apply in-DB SQL — `001` schema, `002` search)
8. `bundle run gateway_setup` (create the `guard_block_all_data` UC function in
   `otto_demo.northpeak_gateway`)
9. `finalize` step stamps `DASHBOARD_ID`/`PIPELINE_ID` into `app.yaml`; app starts
10. Smoke: app reads `otto_demo` data + Genie + Lakebase, and the agent chat routes
    through `northpeak-ai-gateway` (verify a row lands in the inference table and a
    PII/all-data prompt is blocked)

## Out of scope

- ML model (`recovery_recommender`) — separate Build 2.
- MAS (multi-agent supervisor) endpoint wiring — the app supports it via
  `MAS_ENDPOINT_NAME`, but sandbox uses the Genie path; not wired here.
- Redeploying the perma-vm `dev` target, or any change to existing `submission1/`
  / `submission2/` / `submission3/` evidence. (The only `dev` edit is removing
  `mode: development` per decision 6 — a config change; we do not redeploy `dev`.)
```
