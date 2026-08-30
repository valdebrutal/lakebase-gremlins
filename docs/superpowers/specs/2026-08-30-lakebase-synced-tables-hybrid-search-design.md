# Lakebase Synced Tables + Hybrid Product Search — Design

**Date:** 2026-08-30
**Status:** Approved for planning

## Goal

Replace the app's bespoke boot-time Delta→Lakebase copy (`syncFromDelta`) with
**managed Lakebase synced tables** for every gold table the agent reads via SQL,
and give the `search_products` tool **real hybrid Lakebase Search** (BM25 +
vector) over a synced product catalog — the capability the Build-2c workshop
milestone already describes but the current code only stubs with plain Postgres FTS.

## Background — current state (verified)

- The app reads gold data from **Lakebase `app.*` tables** that are populated at
  boot by a hand-rolled `syncFromDelta` (`app/server/db/sync.ts`): it runs
  warehouse `SELECT`s against the UC gold tables and `INSERT`s the rows into
  Lakebase. Its own header says the production-grade path is "Lakebase Synced
  Tables" — this is a demo shortcut.
- Agent data tools read Lakebase: `find_shortfall`/`getPosition` →
  `app.store_sku_position` + `app.open_shortfalls`; `rank_recovery_moves` →
  `app.recovery_recommendations`; `search_products` → `app.products` (a table
  **derived** at boot by `ensureProductsIndex` from the position mirror, with a
  plain GIN `tsvector` FTS index).
- `ask_data` (Genie) and the AI/BI dashboard read **UC directly** via the
  warehouse — **out of scope, unchanged.**
- Writable app tables — `ops_actions`, `conversations`, `messages`, `feedback`,
  `workflow_events` — are Drizzle-managed and **stay app-owned** (synced tables
  are read-only; these cannot be synced).
- Verified: DAB `postgres_synced_tables` works here (an existing synced table
  materialized — user-confirmed); the `lakebase_text`, `lakebase_vector`,
  `vector` extensions are installed; `gold_recovery_recommendations` is a
  **pipeline SQL gold table** (`transformation/gold/`), not an ML output;
  `raw_products` carries real `description` text (e.g. "Heavyweight insulated
  winter parka…"); embedding endpoint `databricks-gte-large-en` (1024-dim) is
  available.

## Design

### 1. Managed synced tables replace `syncFromDelta`

Declare four `postgres_synced_tables` (SNAPSHOT scheduling — matches the
one-shot boot-sync semantics, cheapest for a demo) in `resources/lakebase.yml`,
into the `databricks_postgres` database:

| Source (UC gold) | Purpose | Index |
|---|---|---|
| `gold_store_sku_position` | `find_shortfall`, `getPosition` | none |
| `gold_open_shortfalls` | `find_shortfall` | none |
| `gold_recovery_recommendations` | `rank_recovery_moves` | none |
| `gold_products` (**new**) | `search_products` | **hybrid: `lakebase_bm25` + `lakebase_ann`** |

The custom `syncFromDelta` boot-sync, `ensureProductsIndex`, and the derived
`app.products` table are **removed**.

### 2. New `gold_products` with embeddings

Add `transformation/gold/gold_products.sql` producing one row per product from
`raw_products`: `product_id`, `product_name`, `category`, `subcategory`,
`price_usd`, `description`, and an `embedding ARRAY<FLOAT>` computed with
`ai_query('databricks-gte-large-en', product_name || ' ' || description)`.
Synced with `type_overrides` mapping `embedding → vector(1024)`.

### 3. Hybrid search index (products only)

A post-sync step builds, on the synced `gold_products`:
- `lakebase_bm25` for keyword search over `to_tsvector('english', product_name
  || ' ' || description)` (an **expression index**, since a read-only synced
  table can't carry a generated `tsvector` column and `type_overrides` has no
  tsvector option),
- `lakebase_ann` over the `vector(1024)` embedding column.

`searchProducts` becomes **hybrid** (Reciprocal Rank Fusion of the BM25 and
vector top-K lists). No index on the other three synced tables.

### 4. App rewiring

- Delete `syncFromDelta` + its boot call; delete `ensureProductsIndex`.
- Point the read-only tables in the Drizzle schema (`storeSkuPosition`,
  `openShortfalls`, `recoveryRecommendations`) and `searchProducts` at the
  **synced-table schema** (confirmed during the spike).
- Rewrite `searchProducts` for hybrid RRF; embed the query via
  `databricks-gte-large-en` at call time for the vector arm.
- Reset-demo (`wipeMirroredTables`): stop truncating the (now read-only) synced
  mirrors; reset only the writable tables. A demo re-sync is a `Sync now` on the
  pipelines, not an app `TRUNCATE`.

### 5. Permissions

The synced tables are owned by the pipeline role; the app SP needs `USAGE` on
the synced schema + `SELECT` on the tables (granted by `databricks_superuser`
post-sync — folded into the existing `gateway/setup_gateway.sh` SP-grant step or
a dedicated grant step).

## Open items resolved by the spike (Task 1)

1. **Physical location** of synced tables — which Postgres database + schema they
   land in (`databricks_postgres.public` vs. a catalog-mapped DB) — so the app
   reads them on its existing connection.
2. **`lakebase_bm25` expression-index** syntax/feasibility on a read-only synced
   table (vs. needing a materialized copy).
3. **SP grant mechanism** on a pipeline-owned synced table.

## Global constraints

- Databricks CLI ≥ v1.14.1; profile `otto-sandbox`, target `sandbox`.
- Catalog `otto_demo`, schema `northpeak_retail` (referenced, not created).
- No new bespoke sync code — synced tables are the mechanism.
- Writable app tables (`ops_actions`, chat, `workflow_events`) stay app-owned.
- Genie + dashboard stay on UC Delta — untouched.
- BM25 index is built only after its synced table is populated.

## Testing

- Spike (Task 1) verifies the mechanics live on the sandbox.
- Per-component: pipeline produces `gold_products` with a 1024-dim embedding;
  each synced table materializes + is SP-readable; the two product indexes build;
  `searchProducts` hybrid returns Ridgeline + Timberline for "warm insulated
  jacket similar to Summit Down Parka".
- End-to-end: boot with `syncFromDelta` removed → agent `find_shortfall` /
  `rank_recovery_moves` / `search_products` all work off synced tables.
