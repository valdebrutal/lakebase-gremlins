# Design — NorthPeak `northpeak_operations` SDP Pipeline (Milestone 1)

**Date:** 2026-08-27
**Scope:** Milestone 1 — the Spark Declarative Pipeline (SDP) that turns the raw
parquet in the `raw_data` volume into the silver + gold analytics tables.
**Authoritative spec:** `specifications/01-lakeflow.md` (§B build, §C validation).
This design records *how* we realize that spec; it invents nothing beyond the two
decisions called out under "Open decisions".

---

## 1. Goal & boundary

Build and deploy the SDP pipeline `northpeak_operations`, run it to produce the
silver + gold tables, then run the spec §C validation pass to prove correctness.

**In scope**
- 4 silver MVs, 4 gold tables (see §4), including the `ai_classify` markdown
  signal and the recovery-recommendation heuristic.
- DAB wiring: a `pipelines` resource in `databricks.yml`; `pipeline_id` recorded
  in `resources.json` after deploy.
- §C validation pass with a reported pass/fail table.

**Out of scope (later milestones — do not build here)**
- `mv_store_position` metric view → `02-uc-governance.md`.
- ML recovery model → `03-ml-recovery.md` (the pipeline heuristic is the answer
  key; ML is an optional later swap).
- Dashboard / Genie / Lakebase / app / gateway.

## 2. Target environment

- **Workspace / profile:** `fevm-perma-vm`.
- **Catalog / schema:** `${var.catalog}` = `perma_vm_catalog`, schema
  `${resources.schemas.demo_schema.name}` (dev target →
  `dev_otto_jaaskelainen_northpeak_retail`).
- **Raw source:** `/Volumes/{catalog}/{schema}/raw_data/{stores,products,sales,
  inventory_snapshots,transfers,store_traffic}/` — already populated by the
  `northpeak_setup` job.

## 3. Open decisions (spec leaves these to us)

1. **Language: SQL.** The spec is SQL-first — its only code block is SQL
   (`ai_classify` in a `CASE`), it reads the volume via `read_files(...)` (a SQL
   TVF), and every table is described in SQL terms. Python adds no leverage here
   and diverges from the workshop's citizen-dev framing.
2. **Compute: serverless.** `ai_classify` requires serverless/Photon; serverless
   SDP also matches the serverless posture of the existing `northpeak_setup` job.

Everything else below is transcribed from `01-lakeflow.md`.

## 4. Pipeline structure

No bronze layer — silver reads the raw parquet directly via
`read_files('/Volumes/${catalog}/${schema}/raw_data/<dataset>/')`.

### Silver (4 materialized views)

- **`note_markdown_flags`** — the `ai_classify` showcase, deduped. Over
  `SELECT DISTINCT merch_note_text FROM read_files(.../inventory_snapshots/)
  WHERE merch_note_text IS NOT NULL`, classify each distinct string once:
  `ai_classify(text, ARRAY('dead_stock','aging','healthy'))` →
  `dead_stock`=1.0, `aging`=0.6, else 0.1. Row count == distinct-note count.
- **`silver_sales`** — `raw_sales` ⨝ `raw_stores` (region, climate_zone, city,
  geo) ⨝ `raw_products` (name, category, subcategory, price, cost, seasonality).
  Columns per spec; cluster by `sale_date`.
- **`silver_inventory`** — `raw_inventory_snapshots` ⨝ stores ⨝ products ⨝
  `note_markdown_flags` on `merch_note_text`. `markdown_risk_score` COALESCE→0.1.
  Cluster by `snapshot_date`.
- **`silver_transfers`** — `raw_transfers` ⨝ products ⨝ stores twice (from/to) +
  derived `distance_km` (haversine from the two stores' lat/lng).

### Gold (4 tables)

- **`gold_store_sku_position`** — the spine. One row per (store, SKU) at
  `snapshot_date = MAX(snapshot_date)` (the current snapshot), LEFT JOIN a 7-day
  `silver_sales` rollup (`recent_units_7d`, `recent_net_sales_7d`). Derived:
  `avg_daily_velocity = recent_units_7d/7`,
  `weeks_of_supply = on_hand / NULLIF(avg_daily_velocity*7, 0)`,
  `lost_sales_exposure_usd = GREATEST(0, avg_daily_velocity * price_usd * 30)`
  (30-day horizon) for short positions,
  `markdown_exposure_usd = GREATEST(0, (on_hand - expected_sellthrough) *
  price_usd * 0.3)` for over-stocked, and **`position_status`**:
  - `stockout` — on_hand=0 AND avg_daily_velocity>0
  - `at_risk` — weeks_of_supply<1 AND velocity>0
  - `overstock` — weeks_of_supply>8 AND markdown_risk_score>=0.6
  - `healthy` — else

  Carries `climate_zone`, `region`, `category` (dashboard-filter contract).

- **`gold_open_shortfalls`** — `gold_store_sku_position WHERE position_status IN
  ('stockout','at_risk')`, enriched with the nearest **same-region** `overstock`
  position on the **same SKU**:
  `ROW_NUMBER() OVER (PARTITION BY shortfall store,SKU ORDER BY distance_km)`=1
  → `nearest_surplus_store_id`, `nearest_surplus_on_hand`,
  `nearest_surplus_distance_km`. Spec guarantees STORE-0214×SKU-APP-04412 →
  STORE-0377.

- **`gold_transfer_outcomes`** — pass-through of `silver_transfers` + situational
  features (`move_type`, `units_moved`, `distance_km`, reconstructed
  `from_on_hand_at_move`/`to_velocity_at_move`, `days_to_fulfill`, `price_usd`,
  `margin_pct`) + outcomes (`recaptured_sales_usd`, `margin_impact_usd`).

- **`gold_recovery_recommendations`** — the heuristic (no ML). Per open shortfall,
  build three candidates and rank by `net_value = recaptured − cost −
  margin_impact`:
  - **transfer** from `nearest_surplus_store_id`:
    `recommended_units = LEAST(units_needed, nearest_surplus_on_hand)`;
    `recaptured ≈ units × price_usd × 0.9` (degrade slightly with distance);
    `cost ≈ 60 + distance_km × 1.1`; `margin_impact ≈ 0`.
  - **expedite** from DC: `recaptured ≈ units_needed × price_usd × 0.82`;
    `cost ≈ units_needed × 9 + 400`; `margin_impact ≈ 0`.
  - **substitute**: another `cold_weather` product in the same `subcategory`
    with on-hand available and closest `price_usd`
    (`recommended_substitute_product_id`);
    `recaptured ≈ units_needed × price_usd × 0.35`;
    `margin_impact ≈ units_needed × (price_usd × 0.58) × 0.45`.
  - `recommended_move = argmax(net_value)`; `move_ranking` = JSON array of all
    three with `recaptured`/`net`/`cost`. Columns per `03-ml-recovery.md`
    Inference shape (`store_id`, `product_id`, `recommended_move`,
    `recommended_source_store_id`, `recommended_substitute_product_id`,
    `recommended_units`, `predicted_recaptured_usd`, `predicted_net_value_usd`,
    `move_ranking`, `scored_at`). Coefficients make transfer win for the hero.

`units_needed` = shortfall demand over the horizon (e.g.
`CEIL(avg_daily_velocity * unfilled_days_horizon)`), consistent with the
`lost_sales_exposure` horizon.

## 5. DAB wiring

- Add to `databricks.yml`:
  ```yaml
  resources:
    pipelines:
      northpeak_operations:
        name: "[Workshop] NorthPeak Retail — operations pipeline"
        catalog: ${var.catalog}
        schema: ${resources.schemas.demo_schema.name}
        serverless: true
        configuration:
          catalog: ${var.catalog}
          schema: ${resources.schemas.demo_schema.name}
        libraries:
          - glob:
              include: ./transformation/**   # or explicit .sql file entries
  ```
  (Exact library-declaration form confirmed against the `databricks-pipelines`
  skill during implementation.)
- Transformation SQL under `transformation/` (per its README), one file per layer
  or per table — decided in the implementation plan.
- After a successful deploy+run, record the created `pipeline_id` in
  `resources.json`.

## 6. Validation (§C) — the "definition of done"

After the pipeline populates gold, run these via
`databricks experimental aitools tools query` and report pass/fail:

**Load-bearing (must pass):**
- Hero shortfall: `gold_store_sku_position` STORE-0214×SKU-APP-04412 →
  on_hand=0, velocity>0, status=`stockout`, lost_sales_exposure>0.
- Recommended surplus: `gold_open_shortfalls` same key →
  nearest_surplus_store_id=STORE-0377, on_hand ≥ need.
- N/S split: affected SKUs GROUP BY climate_zone,position_status → North mostly
  stockout/at_risk (~30), South mostly overstock (~40).
- Anomaly confined: non-affected SKUs overwhelmingly healthy.
- Exposure KPIs: SUM(lost_sales_exposure)≈$4.8M, SUM(markdown_exposure)≈$5.6M
  (±20%).
- `markdown_risk_score` separates: southern affected overstock ≥0.6, healthy ≤0.2.
- Dedup works: DISTINCT notes ≪ rows; MV rowcount == distinct count.
- Transfer outcomes learnable: `gold_transfer_outcomes` GROUP BY move_type →
  transfer best recaptured/$ for close same-region surplus; expedite wins when
  distant; substitute lowest.
- Velocity ramp in the past (build ~2.5w ago, not a current-week cliff).

**Smoke checks:** climate_zone ∈ {North,South,Mixed}; GPS non-null & in bounds;
position_status ∈ the 4 values; open_shortfalls in the dozens; weeks_of_supply
never negative.

If a load-bearing check fails, fix the pipeline SQL (not the data) and re-run;
escalate only if the raw data itself is off.

## 7. Risks / watch-items

- **Permissions:** catalog/schema creation already needed grants on this
  workspace; `ai_classify` also needs foundation-model access on serverless. If
  it's blocked we surface it rather than working around it.
- **`ai_classify` availability** on the serverless SDP compute — confirm early
  (it's the one external dependency in silver).
- **Dev-mode name prefixing** already applies to the schema
  (`dev_otto_jaaskelainen_…`); the pipeline's `configuration` uses the resolved
  schema name so table references stay correct.
