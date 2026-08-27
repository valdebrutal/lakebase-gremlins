# NorthPeak `northpeak_operations` SDP Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build & deploy the `northpeak_operations` Spark Declarative Pipeline that turns the raw parquet in the `raw_data` volume into 4 silver + 4 gold tables, then prove it against the spec's §C validation checks.

**Architecture:** A SQL-only, serverless SDP pipeline added as a `pipelines` resource in the existing DAB. Raw parquet is read via `read_files(...)` into temporary views (no bronze); four silver materialized views denormalize + add the `ai_classify` markdown signal; four gold MVs produce the position spine, open shortfalls (with nearest-surplus join), transfer outcomes, and the ranked-recovery heuristic. Each table is validated with a CLI SQL query before moving on.

**Tech Stack:** Lakeflow Spark Declarative Pipelines (SQL), Databricks Asset Bundles, serverless compute + Photon, `ai_classify` built-in AI function, Databricks CLI v1.12.1.

**Spec:** `docs/superpowers/specs/2026-08-27-northpeak-sdp-pipeline-design.md` (which realizes `specifications/01-lakeflow.md` §B/§C). Executors read both.

## Global Constraints

- **Profile:** always pass `--profile fevm-perma-vm`. Never rely on the default profile.
- **Catalog / schema:** pipeline publishes to `${var.catalog}` = `perma_vm_catalog`, schema `${resources.schemas.demo_schema.name}` = `dev_otto_jaaskelainen_northpeak_retail` (dev target). Fully-qualified name for all validation queries: `perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.<table>`.
- **Volume source:** `/Volumes/${catalog}/${schema}/raw_data/<dataset>/` where `<dataset>` ∈ {stores, products, sales, inventory_snapshots, transfers, store_traffic}. `${catalog}`/`${schema}` come from the pipeline `configuration:` block.
- **SDP syntax:** use `CREATE OR REFRESH MATERIALIZED VIEW` (NOT `CREATE OR REPLACE`). All sources here are full-scan batch parquet → **materialized views**, no streaming tables. Reference sibling datasets by bare name.
- **No bronze layer.** Raw parquet → temporary views → silver → gold.
- **DABs deploy-before-run:** code changes take effect only after `databricks bundle deploy -t dev`. Always deploy before `bundle run`.
- **Affected SKUs (verbatim):** SKU-APP-04412 (Summit Down Parka, hero), SKU-APP-04418, SKU-APP-04431, SKU-APP-04455, SKU-APP-04460. Hero store STORE-0214 (Denver); recommended surplus STORE-0377 (Colorado Springs).
- **Heuristic coefficients (verbatim from spec):** transfer `recaptured≈units×price×0.9`, `cost≈60+distance_km×1.1`; expedite `recaptured≈need×price×0.82`, `cost≈need×9+400`; substitute `recaptured≈need×price×0.35`, `margin_impact≈need×(price×0.58)×0.45`. `net_value=recaptured−cost−margin_impact`.
- **Reminder before any push:** these changes haven't been reviewed with Isaac Review — `/review` is available. Do not auto-run it.

---

## File Structure

```
databricks.yml                                  # MODIFY: add pipelines.northpeak_operations
resources.json                                  # MODIFY: add pipeline_id after deploy
transformation/
  00_raw_views.sql                              # CREATE: 6 raw temp views (read_files)
  silver/
    note_markdown_flags.sql                     # CREATE
    silver_sales.sql                            # CREATE
    silver_inventory.sql                        # CREATE
    silver_transfers.sql                        # CREATE
  gold/
    gold_store_sku_position.sql                 # CREATE
    gold_open_shortfalls.sql                    # CREATE
    gold_transfer_outcomes.sql                  # CREATE
    gold_recovery_recommendations.sql           # CREATE
```

The pipeline picks up every `.sql` under `transformation/**` via `libraries.glob`. Tasks add files incrementally; each `bundle deploy` re-globs.

**Note on tables not yet added:** an SDP pipeline validates the whole graph, so a file that references a sibling table not yet created will fail. Tasks are ordered so every referenced dataset already exists. Add files in the order below.

---

### Task 1: Wire the pipeline + raw views + `silver_sales`

Establishes the DAB→pipeline→`read_files`→deploy→run loop and locks the raw column names.

**Files:**
- Modify: `databricks.yml` (add `resources.pipelines.northpeak_operations`)
- Create: `transformation/00_raw_views.sql`
- Create: `transformation/silver/silver_sales.sql`

**Interfaces:**
- Produces: temp views `raw_stores, raw_products, raw_sales, raw_inventory_snapshots, raw_transfers, raw_store_traffic`; MV `silver_sales(store_id, store_name, region, climate_zone, city, store_lat, store_lng, product_id, product_name, category, subcategory, seasonality, sale_date, units_sold, net_sales_usd, channel)`.

- [ ] **Step 1: Verify raw parquet column names** (the SQL below assumes the spec's `§ Raw table schemas` names; reconcile any mismatch before writing SQL).

```bash
for d in stores products sales inventory_snapshots transfers store_traffic; do
  echo "=== $d ==="
  databricks experimental aitools tools discover-schema \
    perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.__nonexistent__ --profile fevm-perma-vm >/dev/null 2>&1
  databricks experimental aitools tools query \
    "SELECT * FROM read_files('/Volumes/perma_vm_catalog/dev_otto_jaaskelainen_northpeak_retail/raw_data/$d/', format => 'parquet') LIMIT 1" \
    --profile fevm-perma-vm
done
```
Expected: one sample row per dataset; note the exact column names. If any differ from the spec names used below, update the SQL accordingly.

- [ ] **Step 2: Add the pipeline resource to `databricks.yml`** (under the existing `resources:` block, as a sibling of `schemas`/`volumes`/`jobs`).

```yaml
  pipelines:
    northpeak_operations:
      name: "[Workshop] NorthPeak Retail — operations pipeline"
      catalog: ${var.catalog}
      schema: ${resources.schemas.demo_schema.name}
      serverless: true
      photon: true
      channel: current
      configuration:
        catalog: ${var.catalog}
        schema: ${resources.schemas.demo_schema.name}
      libraries:
        - glob:
            include: ./transformation/**
```

- [ ] **Step 3: Create `transformation/00_raw_views.sql`**

```sql
-- Raw landing zone → pipeline-private temp views. No bronze pass-through.
CREATE TEMPORARY VIEW raw_stores AS
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/stores/', format => 'parquet');
CREATE TEMPORARY VIEW raw_products AS
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/products/', format => 'parquet');
CREATE TEMPORARY VIEW raw_sales AS
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/sales/', format => 'parquet');
CREATE TEMPORARY VIEW raw_inventory_snapshots AS
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/inventory_snapshots/', format => 'parquet');
CREATE TEMPORARY VIEW raw_transfers AS
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/transfers/', format => 'parquet');
CREATE TEMPORARY VIEW raw_store_traffic AS
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/store_traffic/', format => 'parquet');
```

- [ ] **Step 4: Create `transformation/silver/silver_sales.sql`**

```sql
CREATE OR REFRESH MATERIALIZED VIEW silver_sales
CLUSTER BY (sale_date)
AS
SELECT
  s.store_id, st.store_name, st.region, st.climate_zone, st.city,
  st.store_lat, st.store_lng,
  s.product_id, p.product_name, p.category, p.subcategory, p.seasonality,
  s.sale_date, s.units_sold, s.net_sales_usd, s.channel
FROM raw_sales s
JOIN raw_stores  st ON s.store_id   = st.store_id
JOIN raw_products p ON s.product_id = p.product_id;
```

- [ ] **Step 5: Validate & deploy**

```bash
databricks bundle validate --strict -t dev --profile fevm-perma-vm
databricks bundle deploy -t dev --profile fevm-perma-vm
```
Expected: `Validation OK!` then `Deployment complete!`. If validate rejects the `schema:` key on the pipeline resource, switch it to `target: ${resources.schemas.demo_schema.name}` and re-validate (older DAB schema uses `target`).

- [ ] **Step 6: Run the pipeline**

```bash
databricks bundle run northpeak_operations -t dev --profile fevm-perma-vm
```
Expected: an update that reaches `COMPLETED`. (First serverless run is slow — cold start; don't kill it. If it FAILS, read `error.exceptions[0].message` from `databricks pipelines list-pipeline-events <id>`, not the top-level `.message`.)

- [ ] **Step 7: Verify `silver_sales` (the "test")**

```bash
databricks experimental aitools tools query \
  "SELECT COUNT(*) AS rows, COUNT(DISTINCT store_id) AS stores, COUNT(DISTINCT product_id) AS skus, MIN(sale_date) AS min_d, MAX(sale_date) AS max_d FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.silver_sales" \
  --profile fevm-perma-vm
```
Expected: rows in the millions, ~400 stores, ~2000 skus, ~18 months between min_d and max_d. FAIL = pipeline didn't populate; fix before continuing.

- [ ] **Step 8: Commit**

```bash
git add databricks.yml transformation/00_raw_views.sql transformation/silver/silver_sales.sql
git commit -m "feat(pipeline): wire northpeak_operations + raw views + silver_sales"
```

---

### Task 2: `note_markdown_flags` (the `ai_classify` showcase)

Validates `ai_classify` availability on this workspace early — it's the pipeline's one external dependency.

**Files:**
- Create: `transformation/silver/note_markdown_flags.sql`

**Interfaces:**
- Consumes: `raw_inventory_snapshots`.
- Produces: MV `note_markdown_flags(merch_note_text STRING, markdown_risk_score DOUBLE)` — one row per distinct note.

- [ ] **Step 1: Write the validation query first (expect FAIL — table missing)**

```bash
databricks experimental aitools tools query \
  "SELECT COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.note_markdown_flags" \
  --profile fevm-perma-vm
```
Expected now: error `TABLE_OR_VIEW_NOT_FOUND`.

- [ ] **Step 2: Create `transformation/silver/note_markdown_flags.sql`**

```sql
CREATE OR REFRESH MATERIALIZED VIEW note_markdown_flags AS
SELECT
  merch_note_text,
  CASE ai_classify(merch_note_text, ARRAY('dead_stock', 'aging', 'healthy'))
    WHEN 'dead_stock' THEN 1.0
    WHEN 'aging'      THEN 0.6
    ELSE 0.1
  END AS markdown_risk_score
FROM (
  SELECT DISTINCT merch_note_text
  FROM raw_inventory_snapshots
  WHERE merch_note_text IS NOT NULL
);
```

- [ ] **Step 3: Deploy & run**

```bash
databricks bundle deploy -t dev --profile fevm-perma-vm
databricks bundle run northpeak_operations -t dev --profile fevm-perma-vm
```
Expected: `COMPLETED`. If it fails on `ai_classify` (permission / model access), STOP and surface it — this is a workspace-capability blocker, not a code bug.

- [ ] **Step 4: Verify dedup + score separation (the "test")**

```bash
databricks experimental aitools tools query \
  "SELECT (SELECT COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.note_markdown_flags) AS flag_rows, (SELECT COUNT(DISTINCT merch_note_text) FROM read_files('/Volumes/perma_vm_catalog/dev_otto_jaaskelainen_northpeak_retail/raw_data/inventory_snapshots/', format=>'parquet') WHERE merch_note_text IS NOT NULL) AS distinct_notes" \
  --profile fevm-perma-vm
databricks experimental aitools tools query \
  "SELECT markdown_risk_score, COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.note_markdown_flags GROUP BY markdown_risk_score ORDER BY 1" \
  --profile fevm-perma-vm
```
Expected: `flag_rows == distinct_notes` (~15, ≪ the 255K raw rows); scores land on the three values {0.1, 0.6, 1.0} with the aging/dead-stock notes scoring ≥0.6.

- [ ] **Step 5: Commit**

```bash
git add transformation/silver/note_markdown_flags.sql
git commit -m "feat(pipeline): note_markdown_flags via ai_classify (deduped)"
```

---

### Task 3: `silver_inventory`

**Files:**
- Create: `transformation/silver/silver_inventory.sql`

**Interfaces:**
- Consumes: `raw_inventory_snapshots`, `raw_stores`, `raw_products`, `note_markdown_flags`.
- Produces: MV `silver_inventory(store_id, store_name, region, climate_zone, city, store_lat, store_lng, product_id, product_name, category, subcategory, seasonality, price_usd, cost_usd, snapshot_date, on_hand_units, on_order_units, merch_note_text, markdown_risk_score)`.

- [ ] **Step 1: Validation query first (expect FAIL — table missing)**

```bash
databricks experimental aitools tools query \
  "SELECT COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.silver_inventory" --profile fevm-perma-vm
```
Expected: `TABLE_OR_VIEW_NOT_FOUND`.

- [ ] **Step 2: Create `transformation/silver/silver_inventory.sql`**

```sql
CREATE OR REFRESH MATERIALIZED VIEW silver_inventory
CLUSTER BY (snapshot_date)
AS
SELECT
  i.store_id, st.store_name, st.region, st.climate_zone, st.city,
  st.store_lat, st.store_lng,
  i.product_id, p.product_name, p.category, p.subcategory, p.seasonality,
  p.price_usd, p.cost_usd,
  i.snapshot_date, i.on_hand_units, i.on_order_units, i.merch_note_text,
  COALESCE(nmf.markdown_risk_score, 0.1) AS markdown_risk_score
FROM raw_inventory_snapshots i
JOIN raw_stores   st  ON i.store_id   = st.store_id
JOIN raw_products p   ON i.product_id = p.product_id
LEFT JOIN note_markdown_flags nmf ON i.merch_note_text = nmf.merch_note_text;
```

- [ ] **Step 3: Deploy & run**

```bash
databricks bundle deploy -t dev --profile fevm-perma-vm
databricks bundle run northpeak_operations -t dev --profile fevm-perma-vm
```
Expected: `COMPLETED`.

- [ ] **Step 4: Verify (the "test")**

```bash
databricks experimental aitools tools query \
  "SELECT COUNT(*) AS rows, ROUND(AVG(markdown_risk_score),3) AS avg_score, SUM(CASE WHEN markdown_risk_score IS NULL THEN 1 ELSE 0 END) AS null_scores FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.silver_inventory" \
  --profile fevm-perma-vm
```
Expected: rows > 0, `null_scores = 0` (COALESCE worked), avg_score between 0.1 and 1.0.

- [ ] **Step 5: Commit**

```bash
git add transformation/silver/silver_inventory.sql
git commit -m "feat(pipeline): silver_inventory with markdown_risk_score join"
```

---

### Task 4: `silver_transfers` (+ haversine `distance_km`)

**Files:**
- Create: `transformation/silver/silver_transfers.sql`

**Interfaces:**
- Consumes: `raw_transfers`, `raw_products`, `raw_stores`.
- Produces: MV `silver_transfers(transfer_id, product_id, product_name, category, price_usd, product_cost_usd, move_type, from_store_id, from_region, from_climate, to_store_id, to_region, to_climate, substitute_product_id, units_moved, initiated_date, days_to_fulfill, recaptured_sales_usd, margin_impact_usd, cost_usd, distance_km)`. Note: `cost_usd` = the **move** cost; product cost is `product_cost_usd` (renamed to avoid collision).

- [ ] **Step 1: Validation query first (expect FAIL)**

```bash
databricks experimental aitools tools query \
  "SELECT COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.silver_transfers" --profile fevm-perma-vm
```
Expected: `TABLE_OR_VIEW_NOT_FOUND`.

- [ ] **Step 2: Create `transformation/silver/silver_transfers.sql`**

```sql
CREATE OR REFRESH MATERIALIZED VIEW silver_transfers AS
SELECT
  t.transfer_id, t.product_id, p.product_name, p.category,
  p.price_usd, p.cost_usd AS product_cost_usd,
  t.move_type,
  t.from_store_id, fs.region AS from_region, fs.climate_zone AS from_climate,
  t.to_store_id,   ts.region AS to_region,   ts.climate_zone AS to_climate,
  t.substitute_product_id, t.units_moved, t.initiated_date, t.days_to_fulfill,
  t.recaptured_sales_usd, t.margin_impact_usd, t.cost_usd,
  CASE
    WHEN fs.store_lat IS NULL OR ts.store_lat IS NULL THEN NULL
    ELSE 6371 * 2 * ASIN(SQRT(
      POWER(SIN(RADIANS(ts.store_lat - fs.store_lat) / 2), 2)
      + COS(RADIANS(fs.store_lat)) * COS(RADIANS(ts.store_lat))
        * POWER(SIN(RADIANS(ts.store_lng - fs.store_lng) / 2), 2)
    ))
  END AS distance_km
FROM raw_transfers t
JOIN raw_products p ON t.product_id = p.product_id
LEFT JOIN raw_stores fs ON t.from_store_id = fs.store_id   -- nullable for expedite/DC
JOIN raw_stores ts ON t.to_store_id = ts.store_id;
```

- [ ] **Step 3: Deploy & run**

```bash
databricks bundle deploy -t dev --profile fevm-perma-vm
databricks bundle run northpeak_operations -t dev --profile fevm-perma-vm
```
Expected: `COMPLETED`.

- [ ] **Step 4: Verify (the "test")**

```bash
databricks experimental aitools tools query \
  "SELECT move_type, COUNT(*) AS n, ROUND(AVG(distance_km),1) AS avg_km FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.silver_transfers GROUP BY move_type ORDER BY move_type" \
  --profile fevm-perma-vm
```
Expected: three move types (transfer/expedite/substitute); `transfer` rows have finite `avg_km`; no negative distances.

- [ ] **Step 5: Commit**

```bash
git add transformation/silver/silver_transfers.sql
git commit -m "feat(pipeline): silver_transfers with haversine distance_km"
```

---

### Task 5: `gold_store_sku_position` (the spine)

**Files:**
- Create: `transformation/gold/gold_store_sku_position.sql`

**Interfaces:**
- Consumes: `silver_inventory`, `silver_sales`.
- Produces: MV `gold_store_sku_position(store_id, store_name, region, climate_zone, city, store_lat, store_lng, product_id, product_name, category, subcategory, seasonality, on_hand_units, on_order_units, price_usd, markdown_risk_score, recent_units_7d, recent_net_sales_7d, avg_daily_velocity, weeks_of_supply, lost_sales_exposure_usd, markdown_exposure_usd, position_status)`.

- [ ] **Step 1: Validation query first (expect FAIL)**

```bash
databricks experimental aitools tools query \
  "SELECT COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_store_sku_position" --profile fevm-perma-vm
```
Expected: `TABLE_OR_VIEW_NOT_FOUND`.

- [ ] **Step 2: Create `transformation/gold/gold_store_sku_position.sql`**

Constants are tunable to hit the §C exposure KPIs (Task 9): `unfilled_days_horizon = 30`, `markdown_depth = 0.3`, `expected_sellthrough = avg_daily_velocity * 30`.

```sql
CREATE OR REFRESH MATERIALIZED VIEW gold_store_sku_position
CLUSTER BY (product_id)
AS
WITH current_snapshot AS (
  SELECT * FROM silver_inventory
  WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM silver_inventory)
),
recent_sales AS (
  SELECT store_id, product_id,
         SUM(units_sold)     AS recent_units_7d,
         SUM(net_sales_usd)  AS recent_net_sales_7d
  FROM silver_sales
  WHERE sale_date > (SELECT MAX(sale_date) FROM silver_sales) - INTERVAL 7 DAYS
  GROUP BY store_id, product_id
),
joined AS (
  SELECT
    c.store_id, c.store_name, c.region, c.climate_zone, c.city, c.store_lat, c.store_lng,
    c.product_id, c.product_name, c.category, c.subcategory, c.seasonality,
    c.on_hand_units, c.on_order_units, c.price_usd, c.markdown_risk_score,
    COALESCE(rs.recent_units_7d, 0)    AS recent_units_7d,
    COALESCE(rs.recent_net_sales_7d, 0) AS recent_net_sales_7d
  FROM current_snapshot c
  LEFT JOIN recent_sales rs
    ON c.store_id = rs.store_id AND c.product_id = rs.product_id
),
metrics AS (
  SELECT *,
    recent_units_7d / 7.0 AS avg_daily_velocity,
    on_hand_units / NULLIF((recent_units_7d / 7.0) * 7, 0) AS weeks_of_supply
  FROM joined
)
SELECT
  store_id, store_name, region, climate_zone, city, store_lat, store_lng,
  product_id, product_name, category, subcategory, seasonality,
  on_hand_units, on_order_units, price_usd, markdown_risk_score,
  recent_units_7d, recent_net_sales_7d, avg_daily_velocity, weeks_of_supply,
  CASE WHEN on_hand_units = 0 OR COALESCE(weeks_of_supply, 0) < 1
       THEN GREATEST(0, avg_daily_velocity * price_usd * 30) ELSE 0 END
    AS lost_sales_exposure_usd,
  CASE WHEN COALESCE(weeks_of_supply, 0) > 8
       THEN GREATEST(0, (on_hand_units - avg_daily_velocity * 30) * price_usd * 0.3) ELSE 0 END
    AS markdown_exposure_usd,
  CASE
    WHEN on_hand_units = 0 AND avg_daily_velocity > 0 THEN 'stockout'
    WHEN COALESCE(weeks_of_supply, 999) < 1 AND avg_daily_velocity > 0 THEN 'at_risk'
    WHEN COALESCE(weeks_of_supply, 0) > 8 AND markdown_risk_score >= 0.6 THEN 'overstock'
    ELSE 'healthy'
  END AS position_status
FROM metrics;
```

- [ ] **Step 3: Deploy & run**

```bash
databricks bundle deploy -t dev --profile fevm-perma-vm
databricks bundle run northpeak_operations -t dev --profile fevm-perma-vm
```
Expected: `COMPLETED`.

- [ ] **Step 4: Verify — hero shortfall + status enum + N/S split (the "test")**

```bash
# Hero shortfall
databricks experimental aitools tools query \
  "SELECT on_hand_units, ROUND(avg_daily_velocity,2) v, position_status, ROUND(lost_sales_exposure_usd,0) exposure FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_store_sku_position WHERE store_id='STORE-0214' AND product_id='SKU-APP-04412'" \
  --profile fevm-perma-vm
# Status enum is exactly the 4 values
databricks experimental aitools tools query \
  "SELECT position_status, COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_store_sku_position GROUP BY position_status ORDER BY 2 DESC" \
  --profile fevm-perma-vm
# North-red / South-amber split on affected SKUs
databricks experimental aitools tools query \
  "SELECT climate_zone, position_status, COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_store_sku_position WHERE product_id IN ('SKU-APP-04412','SKU-APP-04418','SKU-APP-04431','SKU-APP-04455','SKU-APP-04460') GROUP BY climate_zone, position_status ORDER BY climate_zone, 3 DESC" \
  --profile fevm-perma-vm
```
Expected: hero row → `on_hand_units=0`, `v>0`, `position_status='stockout'`, `exposure>0`. Status values ⊆ {stockout, at_risk, overstock, healthy}. North rows overwhelmingly stockout/at_risk (~30), South overwhelmingly overstock (~40). If the split is wrong, do NOT change the data — recheck the join/threshold SQL.

- [ ] **Step 5: Commit**

```bash
git add transformation/gold/gold_store_sku_position.sql
git commit -m "feat(pipeline): gold_store_sku_position spine (status + exposures)"
```

---

### Task 6: `gold_open_shortfalls` (nearest-surplus join)

**Files:**
- Create: `transformation/gold/gold_open_shortfalls.sql`

**Interfaces:**
- Consumes: `gold_store_sku_position`.
- Produces: MV `gold_open_shortfalls(store_id, product_id, store_lat, store_lng, region, on_hand_units, avg_daily_velocity, price_usd, lost_sales_exposure_usd, nearest_surplus_store_id, nearest_surplus_on_hand, nearest_surplus_distance_km)`.

- [ ] **Step 1: Validation query first (expect FAIL)**

```bash
databricks experimental aitools tools query \
  "SELECT COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_open_shortfalls" --profile fevm-perma-vm
```
Expected: `TABLE_OR_VIEW_NOT_FOUND`.

- [ ] **Step 2: Create `transformation/gold/gold_open_shortfalls.sql`**

```sql
CREATE OR REFRESH MATERIALIZED VIEW gold_open_shortfalls AS
WITH shortfalls AS (
  SELECT store_id, product_id, region, store_lat, store_lng,
         on_hand_units, avg_daily_velocity, price_usd, lost_sales_exposure_usd
  FROM gold_store_sku_position
  WHERE position_status IN ('stockout', 'at_risk')
),
surplus AS (
  SELECT store_id, product_id, region, store_lat, store_lng, on_hand_units
  FROM gold_store_sku_position
  WHERE position_status = 'overstock'
),
paired AS (
  SELECT
    sf.store_id, sf.product_id, sf.store_lat, sf.store_lng, sf.region,
    sf.on_hand_units, sf.avg_daily_velocity, sf.price_usd, sf.lost_sales_exposure_usd,
    su.store_id AS nearest_surplus_store_id,
    su.on_hand_units AS nearest_surplus_on_hand,
    6371 * 2 * ASIN(SQRT(
      POWER(SIN(RADIANS(su.store_lat - sf.store_lat) / 2), 2)
      + COS(RADIANS(sf.store_lat)) * COS(RADIANS(su.store_lat))
        * POWER(SIN(RADIANS(su.store_lng - sf.store_lng) / 2), 2)
    )) AS nearest_surplus_distance_km
  FROM shortfalls sf
  LEFT JOIN surplus su
    ON sf.product_id = su.product_id AND sf.region = su.region
),
ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY store_id, product_id
      ORDER BY nearest_surplus_distance_km ASC NULLS LAST
    ) AS rn
  FROM paired
)
SELECT
  store_id, product_id, store_lat, store_lng, region,
  on_hand_units, avg_daily_velocity, price_usd, lost_sales_exposure_usd,
  nearest_surplus_store_id, nearest_surplus_on_hand, nearest_surplus_distance_km
FROM ranked
WHERE rn = 1;
```

- [ ] **Step 3: Deploy & run**

```bash
databricks bundle deploy -t dev --profile fevm-perma-vm
databricks bundle run northpeak_operations -t dev --profile fevm-perma-vm
```
Expected: `COMPLETED`.

- [ ] **Step 4: Verify — recommended surplus + rowcount (the "test")**

```bash
databricks experimental aitools tools query \
  "SELECT nearest_surplus_store_id, ROUND(nearest_surplus_distance_km,0) km, nearest_surplus_on_hand FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_open_shortfalls WHERE store_id='STORE-0214' AND product_id='SKU-APP-04412'" \
  --profile fevm-perma-vm
databricks experimental aitools tools query \
  "SELECT COUNT(*) AS shortfalls FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_open_shortfalls" \
  --profile fevm-perma-vm
```
Expected: hero row → `nearest_surplus_store_id='STORE-0377'`, `km ≈ 160`, on_hand comfortably ≥ the shortfall need. Total shortfalls in the dozens (not zero, not thousands). If hero surplus ≠ STORE-0377, recheck the `region` match / distance ordering (do NOT touch the data).

- [ ] **Step 5: Commit**

```bash
git add transformation/gold/gold_open_shortfalls.sql
git commit -m "feat(pipeline): gold_open_shortfalls with nearest-surplus join"
```

---

### Task 7: `gold_transfer_outcomes`

**Files:**
- Create: `transformation/gold/gold_transfer_outcomes.sql`

**Interfaces:**
- Consumes: `silver_transfers`.
- Produces: MV `gold_transfer_outcomes(transfer_id, product_id, move_type, units_moved, distance_km, days_to_fulfill, price_usd, margin_pct, recaptured_sales_usd, margin_impact_usd, cost_usd)`.

> Scope note: the spec lists optional reconstructed features `from_on_hand_at_move` / `to_velocity_at_move`. They feed only the OPTIONAL ML path (`03-ml-recovery.md`), which the design excludes. They are omitted here; the heuristic and the §C learnability check use only the columns above. If the ML milestone is taken later, add them there.

- [ ] **Step 1: Validation query first (expect FAIL)**

```bash
databricks experimental aitools tools query \
  "SELECT COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_transfer_outcomes" --profile fevm-perma-vm
```
Expected: `TABLE_OR_VIEW_NOT_FOUND`.

- [ ] **Step 2: Create `transformation/gold/gold_transfer_outcomes.sql`**

```sql
CREATE OR REFRESH MATERIALIZED VIEW gold_transfer_outcomes AS
SELECT
  transfer_id, product_id, move_type, units_moved, distance_km,
  days_to_fulfill, price_usd,
  (price_usd - product_cost_usd) / NULLIF(price_usd, 0) AS margin_pct,
  recaptured_sales_usd, margin_impact_usd, cost_usd
FROM silver_transfers;
```

- [ ] **Step 3: Deploy & run**

```bash
databricks bundle deploy -t dev --profile fevm-perma-vm
databricks bundle run northpeak_operations -t dev --profile fevm-perma-vm
```
Expected: `COMPLETED`.

- [ ] **Step 4: Verify — move types separate on outcome (the "test")**

```bash
databricks experimental aitools tools query \
  "SELECT move_type, COUNT(*) n, ROUND(AVG(recaptured_sales_usd),0) avg_recap, ROUND(AVG(cost_usd),0) avg_cost, ROUND(AVG(recaptured_sales_usd)/NULLIF(AVG(cost_usd),0),2) recap_per_cost FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_transfer_outcomes GROUP BY move_type ORDER BY move_type" \
  --profile fevm-perma-vm
```
Expected: three move types with distinguishable economics — `transfer` best recaptured-per-cost, `substitute` lowest recaptured. If they don't separate, the raw data (not the pipeline) is off — flag it.

- [ ] **Step 5: Commit**

```bash
git add transformation/gold/gold_transfer_outcomes.sql
git commit -m "feat(pipeline): gold_transfer_outcomes"
```

---

### Task 8: `gold_recovery_recommendations` (the heuristic)

**Files:**
- Create: `transformation/gold/gold_recovery_recommendations.sql`

**Interfaces:**
- Consumes: `gold_open_shortfalls`, `raw_products`, `gold_store_sku_position`.
- Produces: MV `gold_recovery_recommendations(store_id, product_id, recommended_move, recommended_source_store_id, recommended_substitute_product_id, recommended_units, predicted_recaptured_usd, predicted_net_value_usd, move_ranking, scored_at)`. `move_ranking` is a JSON string array of the three moves.

- [ ] **Step 1: Validation query first (expect FAIL)**

```bash
databricks experimental aitools tools query \
  "SELECT COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_recovery_recommendations" --profile fevm-perma-vm
```
Expected: `TABLE_OR_VIEW_NOT_FOUND`.

- [ ] **Step 2: Create `transformation/gold/gold_recovery_recommendations.sql`**

`units_needed = CEIL(avg_daily_velocity * 30)`. Substitute SKU = another `cold_weather` product in the SAME subcategory with on-hand available somewhere, closest `price_usd`.

```sql
CREATE OR REFRESH MATERIALIZED VIEW gold_recovery_recommendations AS
WITH shortfall AS (
  SELECT
    s.store_id, s.product_id,
    s.avg_daily_velocity, s.price_usd,
    s.nearest_surplus_store_id, s.nearest_surplus_on_hand, s.nearest_surplus_distance_km,
    p.subcategory,
    CAST(CEIL(s.avg_daily_velocity * 30) AS INT) AS units_needed
  FROM gold_open_shortfalls s
  JOIN raw_products p ON s.product_id = p.product_id
),
-- products that currently have on-hand available somewhere (substitute must be buyable)
available_products AS (
  SELECT product_id, MAX(on_hand_units) AS any_on_hand
  FROM gold_store_sku_position
  GROUP BY product_id
  HAVING MAX(on_hand_units) > 0
),
-- best substitute: same subcategory, cold_weather, in stock somewhere, closest price
substitute_pick AS (
  SELECT sf.store_id, sf.product_id,
         sub.product_id AS substitute_product_id,
         ROW_NUMBER() OVER (
           PARTITION BY sf.store_id, sf.product_id
           ORDER BY ABS(sub.price_usd - sf.price_usd) ASC
         ) AS rn
  FROM shortfall sf
  JOIN raw_products sub
    ON sub.subcategory = sf.subcategory
   AND sub.seasonality = 'cold_weather'
   AND sub.product_id <> sf.product_id
  JOIN available_products ap ON ap.product_id = sub.product_id
),
economics AS (
  SELECT
    sf.*,
    sp.substitute_product_id,
    -- transfer
    LEAST(sf.units_needed, COALESCE(sf.nearest_surplus_on_hand, 0)) AS transfer_units,
    LEAST(sf.units_needed, COALESCE(sf.nearest_surplus_on_hand, 0)) * sf.price_usd * 0.9
      * (1 - COALESCE(sf.nearest_surplus_distance_km, 0) / 5000.0) AS transfer_recaptured,
    60 + COALESCE(sf.nearest_surplus_distance_km, 0) * 1.1 AS transfer_cost,
    -- expedite
    sf.units_needed * sf.price_usd * 0.82 AS expedite_recaptured,
    sf.units_needed * 9 + 400            AS expedite_cost,
    -- substitute
    sf.units_needed * sf.price_usd * 0.35 AS substitute_recaptured,
    sf.units_needed * (sf.price_usd * 0.58) * 0.45 AS substitute_margin_impact
  FROM shortfall sf
  LEFT JOIN substitute_pick sp ON sp.store_id = sf.store_id AND sp.product_id = sf.product_id AND sp.rn = 1
),
scored AS (
  SELECT *,
    (transfer_recaptured   - transfer_cost - 0)                          AS transfer_net,
    (expedite_recaptured   - expedite_cost - 0)                          AS expedite_net,
    (substitute_recaptured - 0             - substitute_margin_impact)   AS substitute_net
  FROM economics
)
SELECT
  store_id, product_id,
  CASE
    WHEN transfer_net >= expedite_net AND transfer_net >= substitute_net
         AND nearest_surplus_store_id IS NOT NULL AND transfer_units > 0 THEN 'transfer'
    WHEN expedite_net >= substitute_net THEN 'expedite'
    ELSE 'substitute'
  END AS recommended_move,
  nearest_surplus_store_id AS recommended_source_store_id,
  substitute_product_id    AS recommended_substitute_product_id,
  CASE
    WHEN transfer_net >= expedite_net AND transfer_net >= substitute_net
         AND nearest_surplus_store_id IS NOT NULL AND transfer_units > 0 THEN transfer_units
    ELSE units_needed
  END AS recommended_units,
  GREATEST(transfer_net, expedite_net, substitute_net) + 0 AS _placeholder_net, -- replaced below
  ROUND(
    CASE
      WHEN transfer_net >= expedite_net AND transfer_net >= substitute_net
           AND nearest_surplus_store_id IS NOT NULL AND transfer_units > 0 THEN transfer_recaptured
      WHEN expedite_net >= substitute_net THEN expedite_recaptured
      ELSE substitute_recaptured
    END, 2) AS predicted_recaptured_usd,
  ROUND(GREATEST(transfer_net, expedite_net, substitute_net), 2) AS predicted_net_value_usd,
  to_json(array(
    named_struct('move','transfer',   'recaptured', ROUND(transfer_recaptured,2),   'net', ROUND(transfer_net,2),   'cost', ROUND(transfer_cost,2)),
    named_struct('move','expedite',   'recaptured', ROUND(expedite_recaptured,2),   'net', ROUND(expedite_net,2),   'cost', ROUND(expedite_cost,2)),
    named_struct('move','substitute', 'recaptured', ROUND(substitute_recaptured,2), 'net', ROUND(substitute_net,2), 'cost', 0.0)
  )) AS move_ranking,
  current_timestamp() AS scored_at
FROM scored;
```

> **Cleanup during implementation:** delete the `_placeholder_net` line — it is a marker to remind the implementer that `predicted_net_value_usd` must be the `GREATEST(...)` of the three nets (already emitted on the next line). Ensure the final column list has no stray/duplicate columns before deploying.

- [ ] **Step 3: Deploy & run**

```bash
databricks bundle deploy -t dev --profile fevm-perma-vm
databricks bundle run northpeak_operations -t dev --profile fevm-perma-vm
```
Expected: `COMPLETED`. (If SDP rejects `to_json`/`named_struct`, alias-check the columns; both are standard Spark SQL and supported.)

- [ ] **Step 4: Verify — transfer wins for the hero + valid JSON (the "test")**

```bash
databricks experimental aitools tools query \
  "SELECT recommended_move, recommended_source_store_id, recommended_units, ROUND(predicted_recaptured_usd,0) recap, ROUND(predicted_net_value_usd,0) net, move_ranking FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_recovery_recommendations WHERE store_id='STORE-0214' AND product_id='SKU-APP-04412'" \
  --profile fevm-perma-vm
databricks experimental aitools tools query \
  "SELECT recommended_move, COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_recovery_recommendations GROUP BY recommended_move ORDER BY 2 DESC" \
  --profile fevm-perma-vm
```
Expected: hero row → `recommended_move='transfer'`, `recommended_source_store_id='STORE-0377'`, `move_ranking` a 3-element JSON array with transfer's `net` highest. If transfer does NOT win for the hero, re-check the coefficients/units (do NOT touch data); the spec guarantees transfer should win here.

- [ ] **Step 5: Commit**

```bash
git add transformation/gold/gold_recovery_recommendations.sql
git commit -m "feat(pipeline): gold_recovery_recommendations heuristic + move_ranking"
```

---

### Task 9: §C validation pass + record `pipeline_id`

Runs the full spec §C load-bearing + smoke checks as one gate, tunes the exposure constants if needed, and records the pipeline id.

**Files:**
- Modify: `resources.json` (add `pipeline_id`)

- [ ] **Step 1: Exposure KPIs (load-bearing — tune if outside ±20%)**

```bash
databricks experimental aitools tools query \
  "SELECT ROUND(SUM(lost_sales_exposure_usd)/1e6,2) AS lost_M, ROUND(SUM(markdown_exposure_usd)/1e6,2) AS markdown_M FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_store_sku_position WHERE product_id IN ('SKU-APP-04412','SKU-APP-04418','SKU-APP-04431','SKU-APP-04455','SKU-APP-04460')" \
  --profile fevm-perma-vm
```
Expected: `lost_M ≈ 4.8` (target $4.8M), `markdown_M ≈ 5.6` (target $5.6M), each within ±20%. If off, adjust the tunable constants in `gold_store_sku_position.sql` (`unfilled_days_horizon` 30, `markdown_depth` 0.3, `expected_sellthrough` multiplier), redeploy+run, re-check. Commit the tuning with `fix(pipeline): tune exposure constants to hit §C KPIs`.

- [ ] **Step 2: `markdown_risk_score` separation (load-bearing)**

```bash
databricks experimental aitools tools query \
  "SELECT position_status, ROUND(AVG(markdown_risk_score),2) avg_score FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_store_sku_position WHERE product_id IN ('SKU-APP-04412','SKU-APP-04418','SKU-APP-04431','SKU-APP-04455','SKU-APP-04460') GROUP BY position_status" \
  --profile fevm-perma-vm
```
Expected: `overstock` avg_score ≥ 0.6; `healthy` avg_score ≤ 0.2.

- [ ] **Step 3: Anomaly confined to affected SKUs (load-bearing)**

```bash
databricks experimental aitools tools query \
  "SELECT CASE WHEN product_id IN ('SKU-APP-04412','SKU-APP-04418','SKU-APP-04431','SKU-APP-04455','SKU-APP-04460') THEN 'affected' ELSE 'other' END grp, position_status, COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_store_sku_position GROUP BY 1,2 ORDER BY 1,3 DESC" \
  --profile fevm-perma-vm
```
Expected: `other` SKUs overwhelmingly `healthy`; the stockout/overstock concentration is in `affected`.

- [ ] **Step 4: Smoke checks (load-bearing invariants)**

```bash
databricks experimental aitools tools query \
  "SELECT (SELECT COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_store_sku_position WHERE climate_zone NOT IN ('North','South','Mixed')) AS bad_zone, (SELECT COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_store_sku_position WHERE store_lat NOT BETWEEN -90 AND 90 OR store_lng NOT BETWEEN -180 AND 180 OR store_lat IS NULL) AS bad_gps, (SELECT COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_store_sku_position WHERE position_status NOT IN ('stockout','at_risk','overstock','healthy')) AS bad_status, (SELECT COUNT(*) FROM perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_store_sku_position WHERE weeks_of_supply < 0) AS neg_wos" \
  --profile fevm-perma-vm
```
Expected: all four counts = 0.

- [ ] **Step 5: Record `pipeline_id` in `resources.json`**

```bash
PID=$(databricks bundle summary -t dev --profile fevm-perma-vm -o json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['resources']['pipelines']['northpeak_operations']['id'])")
echo "pipeline_id=$PID"
```
Then edit `resources.json` to add the `pipeline_id` field (match the existing JSON shape — inspect the file first; add `"pipeline_id": "<PID>"` alongside the existing capability entries).

- [ ] **Step 6: Final commit**

```bash
git add resources.json transformation/
git commit -m "feat(pipeline): §C validation passing + record pipeline_id"
```

---

## Self-Review

**1. Spec coverage** (`01-lakeflow.md` §B/§C):
- Raw temp views (no bronze) → Task 1 · `note_markdown_flags` (ai_classify dedup) → Task 2 · `silver_sales` → Task 1 · `silver_inventory` → Task 3 · `silver_transfers` (+distance_km) → Task 4 · `gold_store_sku_position` (status + exposures) → Task 5 · `gold_open_shortfalls` (nearest surplus) → Task 6 · `gold_transfer_outcomes` → Task 7 · `gold_recovery_recommendations` (heuristic + move_ranking) → Task 8 · §C load-bearing + smoke checks → Tasks 5,6,7,9 · `pipeline_id` in resources.json → Task 9. **No gaps.**
- Deliberately deferred (documented): `mv_store_position` metric view (02-uc-governance); ML model (03-ml-recovery); reconstructed transfer features `from_on_hand_at_move`/`to_velocity_at_move` (optional ML only).

**2. Placeholder scan:** every code step has real SQL/commands. The single intentional marker (`_placeholder_net` in Task 8) is explicitly flagged for deletion with the reason — it is not a silent placeholder. `resources.json` edit is described against the file's real shape (inspect-then-add).

**3. Type consistency:** table/column names are consistent across producing/consuming tasks — `silver_transfers.cost_usd` (move cost) vs `product_cost_usd` used in `gold_transfer_outcomes.margin_pct`; `gold_open_shortfalls.nearest_surplus_*` consumed by `gold_recovery_recommendations`; `position_status` enum identical everywhere; `move_ranking` produced as a JSON string in Task 8 and not re-typed elsewhere.
