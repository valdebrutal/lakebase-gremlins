# Workshop - NorthPeak Retail (Stockout & Markdown Rescue)

**The use case, in plain words:** NorthPeak is a US retailer. A cold snap made winter coats **sell out in cold-weather stores** while the **same coats pile up unsold in warm-weather stores**. You build an app that spots each short store, recommends the best fix — **move stock from a nearby store, rush it from the warehouse, or offer a similar item** — and lets a manager approve it in one click. The data, the recommendation, and the AI that assists are all governed on Databricks.

## 🎓 Start here — you build this, it isn't pre-built

Starting point for the Tech Summit FY27 Live Days **AI Customer Challenge**. It ships the **data
generator + specs + a bootstrap app** — **you build the solution** (that's the exercise). Build like
a citizen developer: **describe your intent to Genie Code and iterate**. Work carries forward
step by step.

### ▶️ How to start

**1. Get the template into your workspace.** Download it from **go/solution-builder** and import the folder into your Databricks workspace (Workspace → *Import*). Everything you need travels with it — work directly from there.

**2. Open a Genie Code session** in that folder and kick it off with this prompt:

> *"Read `README.md`, then all the files under `specifications/`, to build up the full context of
> this workshop — the story, the data model, and each component I need to create. Then read
> `data_generation/generate_data.py` to understand how the raw data is structured. Before doing
> anything, ask me which **catalog and schema** to use. Then run `data_generation/generate_data.py`
> as a **job run** into that catalog/schema to load the raw data. Put all the files you create in
> this project folder — transformation code under `./transformation`, and the dashboard, Genie
> space, and everything else at the root (`./`)."*

From there, build the solution one component at a time — SDP pipeline, dashboard, Genie, Lakebase, app, gateway.

**3. Build the solution**, iterating with Genie Code, using the per-component detail in `specifications/`. For the app, point your agent at `app/APP_WORKSHOP.md`.

Everything below is the **story + reference spec** the build should realize. The `specifications/`
folder has the full detail per component; `resources.json` lists the capabilities.

---

## The Story

| | |
|---|---|
| **Company** | NorthPeak Retail — omnichannel retailer (~$2B revenue, 400 US stores, ~40K SKUs) |
| **Hero** | Dana Ruiz, SVP Retail Operations (non-technical) |
| **Problem** | An early cold snap ~3 weeks ago flipped demand for cold-weather apparel: sold out in the North, dead-stock piling toward markdown in the South |
| **Investigation** | Dana asks *"Store 214 is short on the Summit Down Parka — what's the best recovery move?"* — the platform ranks transfer vs. expedite vs. substitute |
| **Root cause** | Inventory was allocated to a normal-weather plan; the cold snap pulled demand North faster than the batch replenishment cycle could react |
| **Impact** | ~$4.8M in lost sales exposed across ~30 stocked-out northern stores, ~$5.6M markdown clock ticking on ~40 southern stores — the same 5 apparel SKUs, opposite problems |

---

## Overview

Dana Ruiz (SVP Retail Ops) opens her console and sees the cold-weather styles two colors on one map: **red in the North** (sold out, demand still climbing → lost sales) and **amber in the South** (dead stock, markdown clock running) — the same 5 SKUs, opposite problems, from one cold snap 3 weeks ago. She asks about the worst store — *"Store 214 is short on the Summit Down Parka, what's the best recovery move?"* — and the app ranks **transfer / expedite / substitute** by recaptured revenue, recommends the transfer, and writes it back after she approves. Governed data, a governed recommendation, and a governed AI assistant, end to end.

---

## Key Numbers

| Metric | Value |
|--------|-------|
| Stores | 400 (US, climate-tagged North / South / Mixed) |
| Active SKUs | ~40,000 (demo spotlights ~5 cold-weather apparel SKUs) |
| Hero SKU | Summit Down Parka (`SKU-APP-04412`) |
| Hero store | Store 214 — Denver, CO (North) |
| Cold snap onset | ~3 weeks ago (dynamic — `SNAP_ONSET = NOW − 3 weeks`) |
| Stocked-out northern stores (affected SKUs) | ~30, at 0 on-hand with rising velocity |
| Over-stocked southern stores (same SKUs) | ~40, high on-hand near-zero velocity |
| Lost-sales exposure (stockouts) | ~$4.8M annualized on the affected SKUs |
| Markdown exposure (dead-stock) | ~$5.6M on the affected SKUs |
| Recovery move ranked by model | transfer / expedite / substitute + predicted recaptured revenue |
| Assistant AI spend | Capped, per-store attributable, ~$200K/yr bounded |

---

## The demo arc (what the finished solution shows)

1. **See it** — open the Store Ops app: a US map, red stockouts in the North next to amber overstock in the South on the same SKUs, with lost-sales + markdown KPIs.
2. **Ask why** — in the chat dock, ask why Store 214 is short; the assistant investigates via Genie over the governed lakehouse.
3. **Get the move** — the assistant ranks transfer / expedite / substitute by recaptured revenue and recommends the transfer, with a what-if.
4. **Act** — approve → the move + a markdown-hold write back to Lakebase → the queue and KPIs update live.
5. **Governed AI** — every assistant call runs through Unity AI Gateway (spend cap, guardrails, per-store logging).

Full per-component detail is in `specifications/`.

---

## Deploying the full solution (Databricks Asset Bundle)

This repo is packaged as a **DAB** (`databricks.yml` + `resources/*.yml`) so the whole
solution stands up on a fresh workspace. **It cannot all deploy in one shot**, though —
part of it is staged on purpose (data dependencies), and a few pieces are created by
scripts/jobs because the platform doesn't model them as bundle resources yet. This
section documents what actually works, in order.

### What's managed how

| Layer | How it's created | Why |
|-------|------------------|-----|
| Catalog **schema + volume**, **pipeline**, **jobs**, **dashboard**, **Genie space**, **Lakebase** project/branches/endpoint/UC-catalog/synced-table, **gateway schema**, the **app** | `bundle deploy` (DAB resources) | Native bundle resources |
| Synthetic data → **gold tables** | `bundle run northpeak_setup` + `bundle run northpeak_operations` (pipeline) | Data steps |
| **`northpeak.*` schema + search indexes** (in-DB SQL) | `bundle run lakebase_migrate` (job → `lakebase/apply_migrations.py`) | DABs don't run in-database SQL |
| **`guard_block_all_data`** guardrail function | `bundle run gateway_setup` (job → `gateway/sandbox_guardrail.sql`) | UC function, not a DAB resource |
| **Metric view** `mv_store_position` | script — `governance/mv_store_position.sql` via the SQL Statement API | Metric views aren't a DAB resource type |
| **Unity AI Gateway model service** `…northpeak_ai_gateway` + app-SP `EXECUTE` grant | script — `gateway/setup_gateway.sh` (`databricks ai-gateway create-model-service`) | Model services are UC securables created via CLI — **confirmed not a DAB resource type** (bundle schema + DevHub docs) |
| **Catalog** (`otto_demo`) | referenced by name (`var.catalog`) — **not** created/bound | Kept outside bundle lifecycle (no destroy risk) |

### Prerequisites (once)

1. **Databricks CLI** ≥ v1.12.1 with an authenticated profile for the target workspace
   (`databricks auth login --host <workspace-url> --profile <profile>`).
2. **Target catalog exists** and you can create schemas in it (this bundle references it
   by name via `var.catalog`; it does not create it).
3. **Account-level "Unity AI Gateway" beta** enabled (account console → **Previews**) —
   required to attach guardrails / inference table to the model service.
4. **Per-project Lakebase Search** enabled on the Postgres project — required for the
   `002_search` migration (BM25 / ANN indexes); without it, `002` skips gracefully.

The bundle ships a `sandbox` target (Azure workspace) that overrides `workspace.host`,
`var.catalog`, and `var.warehouse_id`. Point `-t <target>` at yours.

### Why it's done in pieces

- **Data dependencies.** The **synced table** and the **Genie space** validate that their
  source tables *exist* at create time, and the **app** depends on the Genie space. Those
  tables (`gold_*`, `mv_store_position`) only exist after the pipeline + metric-view run.
  So they must be deployed **after** the data steps, not in the first `bundle deploy`.
- **Beta resource shapes.** The `postgres_*` bundle resources are Beta and loosely typed;
  `bundle validate` won't catch field-shape errors, so the **first `bundle deploy` is the
  real shape check** and may need a correction pass (the shapes in `resources/lakebase.yml`
  are already corrected).
- **Non-DAB pieces.** The metric view and the AI Gateway model service are created by the
  two scripts above — they have no bundle resource type.

### Deploy sequence (fresh workspace)

```bash
PROFILE=<profile>; T=<target>          # e.g. otto-sandbox / sandbox

# 0. Build the app locally (dist/ ships via sync.include; the container does not build)
cd app && ./scripts/build-app.sh && cd ..

# 1. Validate
databricks bundle validate -t $T --profile $PROFILE

# 2. PASS 1 — foundation. Deploy with the data-dependent resources still commented out:
#    postgres_synced_tables (resources/lakebase.yml), genie_spaces (databricks.yml),
#    apps (resources/app.yml). (They need gold tables / Genie to exist first.)
databricks bundle deploy -t $T --profile $PROFILE
#    NB (Beta): if a postgres_* resource is rejected, correct its fields against
#    `databricks postgres create-<x> -h` and redeploy. The project auto-creates its
#    production branch + primary endpoint + databricks-postgres database.

# 3. Data: generate raw data, then build silver/gold
databricks bundle run northpeak_setup       -t $T --profile $PROFILE
databricks bundle run northpeak_operations  -t $T --profile $PROFILE

# 4. Metric view (script — catalog/schema-adjusted CREATE ... WITH METRICS)
#    Run governance/mv_store_position.sql against your catalog.schema via the SQL
#    Statement Execution API (aitools strips the YAML whitespace — use the API).

# 5. In-DB migrations + guardrail function (jobs)
#    001 creates the app.* schema (writable tables); 002 adds BM25/ANN full-text
#    search indexes (needs the per-project Search beta); 003 builds BM25+ANN
#    indexes on public.gold_products (synced table) — run AFTER step 3b below.
databricks bundle run lakebase_migrate -t $T --profile $PROFILE   # 001 schema; 002 search; 003 gold_products indexes
databricks bundle run gateway_setup    -t $T --profile $PROFILE   # guard_block_all_data UC function

# 6. AI Gateway model service + app-SP EXECUTE grant (script)
DATABRICKS_CONFIG_PROFILE=$PROFILE ./gateway/setup_gateway.sh     # pass SP_CLIENT_ID after the app exists (step 8)

# 7. PASS 2 — re-enable + deploy the data-dependent resources (uncomment the three
#    from step 2), now that gold + Genie sources + the model service exist.
#    This deploys the 4 managed synced tables (gold_store_sku_position,
#    gold_open_shortfalls, gold_recovery_recommendations, gold_products) into
#    databricks_postgres.public.gold_* — owned by the platform, not the app.
databricks bundle deploy -t $T --profile $PROFILE

# 8. Grant the app SP SELECT on the 4 synced gold tables (run once after deploy)
#    The synced tables land in the public schema of the Lakebase project; the app
#    SP needs SELECT on each. gateway/grant_synced_tables.sh applies the grants.
SP=$(databricks apps get northpeak-store-ops --profile $PROFILE -o json | python3 -c "import json,sys;print(json.load(sys.stdin)['service_principal_client_id'])")
SP_CLIENT_ID=$SP DATABRICKS_CONFIG_PROFILE=$PROFILE ./gateway/grant_synced_tables.sh

# 9. Start the app + wire the two non-bindable IDs
databricks bundle run northpeak_app -t $T --profile $PROFILE      # deploy+start the app
SP_CLIENT_ID=$SP DATABRICKS_CONFIG_PROFILE=$PROFILE ./gateway/setup_gateway.sh   # grant app SP model-service EXECUTE
DATABRICKS_CONFIG_PROFILE=$PROFILE ./app/scripts/finalize_sandbox.sh            # stamp DASHBOARD_ID/PIPELINE_ID + redeploy
databricks bundle run northpeak_app -t $T --profile $PROFILE                    # restart to pick up stamped env
```

### Data architecture: managed synced tables (replaces boot-sync)

The app reads **four managed synced tables** that the platform keeps in sync from the
gold Delta tables in Unity Catalog. There is no boot-time Delta sync; the app reads
`public.gold_*` on every request.

| Synced table (Lakebase `public.*`) | Source (UC Delta) | Used by |
|-----------------------------------|-------------------|---------|
| `gold_store_sku_position` | `otto_demo.northpeak_retail.gold_store_sku_position` | positions, shortfalls, map |
| `gold_open_shortfalls` | `otto_demo.northpeak_retail.gold_open_shortfalls` | shortfall list, `find_shortfall` tool |
| `gold_recovery_recommendations` | `otto_demo.northpeak_retail.gold_recovery_recommendations` | recovery moves, `rank_recovery_moves` tool |
| `gold_products` | `otto_demo.northpeak_retail.gold_products` | hybrid product search |

These tables are owned by the platform (`databricks_writer`) — Drizzle migrations
**never** create, alter, or drop them. The `id` column is synthesized in every query
as `store_id \|\| ':' \|\| product_id` because the synced tables have no `id` column.

**Product search** runs a hybrid BM25 + ANN (cosine) over `public.gold_products`,
fused via Reciprocal Rank Fusion (RRF). BM25 and ANN indexes are built by Lakebase
migration `003_gold_products_search.sql` (run via `bundle run lakebase_migrate` after
the synced tables exist). The app degrades gracefully to BM25-only when the embedding
call fails.

**Genie and the dashboard** still read Unity Catalog directly (Delta tables in
`otto_demo.northpeak_retail.*`) — they are unaffected by the Lakebase changes.

**SP grants.** The app service principal needs `SELECT` on the four synced tables in
the Lakebase `public` schema. Run `gateway/grant_synced_tables.sh` once after the SP
is created (step 8 of the deploy sequence).

**Drizzle migration 0001** (`0001_omniscient_fallen_one.sql`) drops the three now-unused
app-schema mirrors (`app.store_sku_position`, `app.open_shortfalls`,
`app.recovery_recommendations`) that the old boot-sync populated. It runs automatically
at app boot via `runMigrations()` and is a no-op once applied.

### Gotchas learned the hard way

- **App must ship `dist/` AND `drizzle/`.** `dist/`, `client/dist/`, and the generated
  `drizzle/` migrations folder are all gitignored; the bundle force-includes them via
  `sync.include` in `databricks.yml`. Without `dist/` the app crashes with `Cannot find
  module dist/server.js`; without `drizzle/` the DB init fails with `No Drizzle migrations
  folder found`. Run `npm run db:generate` (part of `build-app.sh`) so `app/drizzle/` exists
  locally before deploy.
- **The app SP needs SELECT on the synced gold tables.** Analytics queries (list positions,
  shortfalls, recovery moves, product search) run with the app service principal's OWN
  credentials — not a user OBO token. `gateway/grant_synced_tables.sh` grants `SELECT` on
  all four `public.gold_*` tables; without this the app returns empty results or 403s.
- **Synced-table `id` synthesis.** The `public.gold_*` tables have no `id` column — the app
  synthesizes composite IDs (`store_id || ':' || product_id`) in every SELECT to match the
  `StorePosition.id` shape expected by the client and the agent tools.
- **Lakebase resource-name vs connection-name.** The database resource path is
  `…/databases/databricks-postgres` (hyphen); the Postgres connection name is
  `databricks_postgres` (underscore).
- **Don't re-declare auto-created Lakebase objects.** Creating a project auto-creates its
  `production` branch, `primary` endpoint, and `databricks-postgres` database — declaring
  them again conflicts. Adopt existing ones with `replace_existing: true` where needed.
- **The migration runner** must not rely on `__file__` (a `spark_python_task` `exec()`s it),
  pin `databricks-sdk>=0.133.0` (needs `w.postgres`), and must not `sys.exit()` on success
  (SystemExit is reported as a task failure). See `lakebase/apply_migrations.py`.
- **The app agent calls the model service directly** at `${host}/ai-gateway/mlflow/v1`
  with `model=<fully-qualified model-service name>` (`AGENT_MODEL`) — the AppKit Model
  Serving plugin does not call model services, hence the direct OpenAI client in
  `app/server/agent/storeops.ts`.

### Governance (UI, after the account beta is on)

The model service *routes* immediately. To attach the **inference table + guardrails**:
**AI Gateway → `otto_demo.northpeak_gateway.northpeak_ai_gateway`** → *Set Up* inference
tables (needs an **external-storage** catalog) and the **Policies** tab (attach the
built-in PII guardrail + the `guard_block_all_data` function as a service policy).
