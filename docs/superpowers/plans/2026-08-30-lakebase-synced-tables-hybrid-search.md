# Lakebase Synced Tables + Hybrid Product Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bespoke `syncFromDelta` boot-sync with managed Lakebase synced tables for the gold tables the agent reads, and make `search_products` real hybrid Lakebase Search (BM25 + vector) over a synced `gold_products`.

**Architecture:** UC gold tables → managed `postgres_synced_tables` (SNAPSHOT) → read-only Postgres tables in `databricks_postgres`. Products gets an embedding in the SDP pipeline, is synced with a `vector(1024)` type-override, and gets `lakebase_bm25` (expression index over name+description) + `lakebase_ann` (embedding) indexes built post-sync. The app reads synced tables via SQL; writable tables stay Drizzle-managed.

**Tech Stack:** Databricks Asset Bundles (`postgres_synced_tables`), Lakeflow SDP (SQL + `ai_query`), Lakebase Search (`lakebase_text`/`lakebase_vector`), Node/TypeScript app (`@databricks/appkit`, Drizzle, `@openai/agents`), `databricks-gte-large-en` embeddings.

**Spec:** `docs/superpowers/specs/2026-08-30-lakebase-synced-tables-hybrid-search-design.md`

## Global Constraints

- CLI ≥ v1.14.1; profile `otto-sandbox`, target `sandbox`; catalog `otto_demo`, schema `northpeak_retail` (referenced, not created).
- Writable tables (`ops_actions`, `conversations`, `messages`, `feedback`, `workflow_events`) stay app-owned — never synced.
- Genie + AI/BI dashboard stay on UC Delta — untouched.
- No new bespoke sync code — managed synced tables are the mechanism.
- A `lakebase_bm25`/`lakebase_ann` index is built only AFTER its synced table is populated.
- App code must type-check (`npx tsc --noEmit`) and the app must not build/deploy as part of authoring — deploy only in the explicit deploy/verify tasks.

---

## File Structure

- `resources/lakebase.yml` — replace the single `open_shortfalls_sync` with 4 `postgres_synced_tables` (position, open_shortfalls, recovery_recommendations, products+type_overrides).
- `resources/jobs.yml` — add a `lakebase_search_index` job that builds the two product indexes post-sync (+ SP grants).
- `transformation/gold/gold_products.sql` — new gold table with `embedding`.
- `gateway/setup_gateway.sh` — extend SP grants to the synced schema (or a dedicated grant SQL run by the index job).
- `app/server/db/sync.ts` — deleted (boot-sync removed); `wipeMirroredTables` moves/rewrites to a writable-only reset.
- `app/server/db/schema.ts` — repoint the 3 read-only tables to the synced schema; drop nothing writable.
- `app/server/db/queries/stores.ts` — remove `ensureProductsIndex`/`ProductMatch`-derived build; rewrite `searchProducts` as hybrid RRF; repoint reads.
- `app/server/agent/storeops.ts` — `search_products` tool unchanged in shape; helper now hybrid.
- `app/server/server.ts` — remove `syncFromDelta` + `ensureProductsIndex` boot calls.
- `app/config/app.json` — drop the boot-sync `data` block (or repurpose to name the synced schema); add embedding endpoint name.

---

### Task 1: Spike — verify synced-table mechanics on the sandbox

**Files:** none (findings recorded in the ledger + appended to the spec's "Open items").

**Deliverable:** answers to the three open items, which Tasks 3–6 consume.

- [ ] **Step 1: Locate the existing synced table.** With Lakebase awake, connect as the user and find where `open_shortfalls_sync` physically landed:
  - `SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname LIKE '%shortfall%';` across `databricks_postgres` (and list databases with `\l`).
  - Record: **which database + schema** synced tables use. If not `databricks_postgres.public`, record the schema the app must read.
- [ ] **Step 2: Verify BM25 expression index on a read-only synced table.** On the existing synced table, attempt:
  `CREATE INDEX tmp_bm25 ON <synced> USING lakebase_bm25 ((to_tsvector('english', <text_col>)));`
  Record whether an **expression** index is accepted, or whether BM25 requires a real `tsvector` column (→ fallback: a small app-owned materialized copy for products only). Drop `tmp_bm25` after.
- [ ] **Step 3: Verify SP grant.** As `databricks_superuser` (or creator), run `GRANT USAGE ON SCHEMA <schema> TO "<app-sp-client-id>"; GRANT SELECT ON <synced> TO "<sp>";` and confirm it succeeds. Record the exact grant statements.
- [ ] **Step 4: Record findings** in the ledger and append resolved answers to the spec. If BM25 expression indexes are NOT supported, flag Task 4/6 to use the materialized-copy fallback before proceeding.

---

### Task 2: `gold_products` with embeddings (SDP pipeline)

**Files:**
- Create: `transformation/gold/gold_products.sql`

**Interfaces:**
- Produces UC table `${catalog}.${schema}.gold_products(product_id STRING, product_name STRING, category STRING, subcategory STRING, price_usd DOUBLE, description STRING, embedding ARRAY<FLOAT>)` — consumed by Task 3's synced table.

- [ ] **Step 1: Write the gold SQL.** One row per product from `raw_products`, with the embedding:
```sql
CREATE OR REFRESH MATERIALIZED VIEW gold_products AS
SELECT
  product_id, product_name, category, subcategory, price_usd, description,
  ai_query(
    'databricks-gte-large-en',
    concat_ws(' ', product_name, coalesce(description, ''))
  ) AS embedding
FROM raw_products;
```
- [ ] **Step 2: Run the pipeline** (`bundle run northpeak_operations -t sandbox`) and verify:
  `SELECT count(*), array_size(embedding) FROM otto_demo.northpeak_retail.gold_products LIMIT 1;` → expect the product count and `1024`.
- [ ] **Step 3: Commit** (`feat(pipeline): gold_products with gte-large-en embeddings`).

---

### Task 3: Declare the 4 synced tables (bundle)

**Files:**
- Modify: `resources/lakebase.yml` (replace `open_shortfalls_sync` block)

**Interfaces:**
- Consumes: `gold_products` (Task 2), existing `gold_store_sku_position`/`gold_open_shortfalls`/`gold_recovery_recommendations`.
- Produces: Postgres synced tables in the schema recorded in Task 1.

- [ ] **Step 1: Replace the synced-table block** with four resources; products carries the vector override:
```yaml
  postgres_synced_tables:
    store_position_sync:
      synced_table_id: northpeak_lakebase.public.gold_store_sku_position
      source_table_full_name: ${var.catalog}.${var.schema}.gold_store_sku_position
      primary_key_columns: [store_id, product_id]
      scheduling_policy: SNAPSHOT
      branch: projects/northpeak/branches/production
      postgres_database: databricks_postgres
      create_database_objects_if_missing: true
      new_pipeline_spec: { storage_catalog: ${var.catalog}, storage_schema: ${var.schema} }
    open_shortfalls_sync:
      synced_table_id: northpeak_lakebase.public.gold_open_shortfalls
      source_table_full_name: ${var.catalog}.${var.schema}.gold_open_shortfalls
      primary_key_columns: [store_id, product_id]
      scheduling_policy: SNAPSHOT
      branch: projects/northpeak/branches/production
      postgres_database: databricks_postgres
      create_database_objects_if_missing: true
      new_pipeline_spec: { storage_catalog: ${var.catalog}, storage_schema: ${var.schema} }
    recovery_recommendations_sync:
      synced_table_id: northpeak_lakebase.public.gold_recovery_recommendations
      source_table_full_name: ${var.catalog}.${var.schema}.gold_recovery_recommendations
      primary_key_columns: [store_id, product_id]
      scheduling_policy: SNAPSHOT
      branch: projects/northpeak/branches/production
      postgres_database: databricks_postgres
      create_database_objects_if_missing: true
      new_pipeline_spec: { storage_catalog: ${var.catalog}, storage_schema: ${var.schema} }
    products_sync:
      synced_table_id: northpeak_lakebase.public.gold_products
      source_table_full_name: ${var.catalog}.${var.schema}.gold_products
      primary_key_columns: [product_id]
      scheduling_policy: SNAPSHOT
      branch: projects/northpeak/branches/production
      postgres_database: databricks_postgres
      create_database_objects_if_missing: true
      new_pipeline_spec: { storage_catalog: ${var.catalog}, storage_schema: ${var.schema} }
      type_overrides:
        - { column_name: embedding, pg_type: PG_SPECIFIC_TYPE_VECTOR, size: 1024 }
```
  (Use the schema/database recorded in Task 1 if it differs.)
- [ ] **Step 2: Validate + deploy** (`bundle validate` then `bundle deploy -t sandbox`); trigger each pipeline (`Sync now` / the sync job) and confirm all four Postgres tables populate (row counts match the gold tables).
- [ ] **Step 3: Commit** (`feat(lakebase): managed synced tables for the 4 gold tables`).

---

### Task 4: Post-sync hybrid index job (products only)

**Files:**
- Create/modify: `resources/jobs.yml` — add `lakebase_search_index` job (a `spark_python_task` or SQL task that connects to Lakebase and runs the DDL), OR a `lakebase/build_search_indexes.py`.

- [ ] **Step 1: Write the index DDL** (form confirmed in Task 1):
```sql
CREATE INDEX IF NOT EXISTS gold_products_bm25
  ON <schema>.gold_products USING lakebase_bm25 ((to_tsvector('english', product_name || ' ' || coalesce(description,''))));
CREATE INDEX IF NOT EXISTS gold_products_ann
  ON <schema>.gold_products USING lakebase_ann (embedding vector_cosine_ops);
```
- [ ] **Step 2: Run the job** after `products_sync` has populated; verify both indexes exist (`\di <schema>.gold_products*`).
- [ ] **Step 3: Commit** (`feat(lakebase): post-sync BM25+ANN index build for gold_products`).

---

### Task 5: Grant the app SP read access on the synced schema

**Files:**
- Modify: `gateway/setup_gateway.sh` (or the index job) — add the grants recorded in Task 1.

- [ ] **Step 1: Add grants** — `GRANT USAGE ON SCHEMA <schema> TO "<sp>"; GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO "<sp>"; ALTER DEFAULT PRIVILEGES IN SCHEMA <schema> GRANT SELECT ON TABLES TO "<sp>";` run as the authorized role.
- [ ] **Step 2: Verify** the SP can `SELECT` from each synced table.
- [ ] **Step 3: Commit** (`feat(lakebase): grant app SP SELECT on synced schema`).

---

### Task 6: Hybrid `searchProducts` (RRF over BM25 + vector)

**Files:**
- Modify: `app/server/db/queries/stores.ts` (`searchProducts`)
- Test: `app/server/db/queries/stores.search.test.ts` (RRF fusion unit test with stubbed rows)

**Interfaces:**
- Consumes: synced `gold_products` (BM25 + ANN indexes from Task 4).
- `searchProducts(db, query)` keeps its `ProductMatch[]` return shape (so `storeops.ts` is unchanged).

- [ ] **Step 1: Write the failing RRF unit test** — given two ranked lists, `rrfFuse(bm25, vec, k=60)` returns items ordered by summed reciprocal rank.
- [ ] **Step 2: Implement `rrfFuse` + hybrid `searchProducts`** — embed the query via `databricks-gte-large-en`, run the BM25 `<@> to_bm25query(...)` top-40 and the ANN `embedding <=> $vec` top-40, fuse with RRF, return top 10 joined to latest on-hand from the synced position table.
- [ ] **Step 3: Run the unit test** (`npm test`) → PASS; `npx tsc --noEmit` clean.
- [ ] **Step 4: Commit** (`feat(app): hybrid RRF product search over Lakebase Search`).

---

### Task 7: Remove boot-sync; repoint reads to synced tables

**Files:**
- Delete: `app/server/db/sync.ts` (boot-sync) — move `wipeMirroredTables` to a writable-only reset in a new small module or `stores.ts`.
- Modify: `app/server/server.ts` (drop `syncFromDelta` + `ensureProductsIndex` calls), `app/server/db/schema.ts` (repoint the 3 read-only tables to the synced schema), `app/server/db/queries/stores.ts` (drop `ensureProductsIndex`; reads use synced schema).

- [ ] **Step 1: Repoint the read-only tables** in the Drizzle schema to the synced schema (Task 1); keep writable tables in `app`.
- [ ] **Step 2: Remove** `syncFromDelta`, its `server.ts` call, `ensureProductsIndex` + its call, and the derived `app.products` build.
- [ ] **Step 3: Rework reset-demo** — `wipeMirroredTables` truncates only `ops_actions` + chat tables; the synced mirrors are refreshed via `Sync now`, not app SQL.
- [ ] **Step 4: `npx tsc --noEmit`** clean; update/repair unit tests.
- [ ] **Step 5: Commit** (`refactor(app): read synced tables, retire syncFromDelta`).

---

### Task 8: End-to-end deploy + verify

- [ ] **Step 1: Build the app** (`app/scripts/build-app.sh`), deploy (`bundle deploy -t sandbox`), start the app.
- [ ] **Step 2: Verify boot** — no `syncFromDelta`; the app reads synced tables; logs clean.
- [ ] **Step 3: Verify the agent** — `find_shortfall`/`rank_recovery_moves` return data off synced tables; `search_products` returns Ridgeline Insulated Jacket + Timberline Fleece Hoodie for "warm insulated jacket similar to Summit Down Parka", with the Thinking panel showing the tool call.
- [ ] **Step 4: Update README** — document the synced-table architecture (replaces the boot-sync section) + the post-sync index/grant steps.
- [ ] **Step 5: Commit** (`docs: synced-table architecture + verify`).

---

## Self-Review

- **Spec coverage:** synced tables (T3), gold_products+embeddings (T2), hybrid search (T4/T6), boot-sync removal + repoint (T7), grants (T5), reset rework (T7), e2e (T8) — all covered.
- **Spike-gated:** T1 resolves physical schema, BM25 expression-index feasibility, and grant syntax before T3–T6 hard-code them; if BM25 expression indexes are unsupported, T4/T6 switch to an app-owned materialized products copy (recorded in T1).
- **Type consistency:** `searchProducts` keeps `ProductMatch[]`, so `storeops.ts` is untouched; the `search_products` tool shape is preserved.
