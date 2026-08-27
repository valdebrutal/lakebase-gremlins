-- UC Governance -- Metric View mv_store_position (specifications/02-uc-governance.md).
-- The one governed definition of NorthPeak's exposure metrics: the dashboard KPI
-- tiles, Genie answers, and the app KPI cards all read these same measures, so the
-- numbers match everywhere. Measure/dimension names are load-bearing -- downstream
-- binds to them verbatim; a rename here is a breaking change. Source is the gold
-- spine gold_store_sku_position (northpeak_operations pipeline, Milestone 1).
--
-- Created via SQL DDL (metric views are not a DAB resource type). Execute with:
--   databricks experimental aitools tools statement submit \
--     --file governance/mv_store_position.sql --warehouse <WAREHOUSE_ID> --profile fevm-perma-vm
CREATE OR REPLACE VIEW perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.mv_store_position
WITH METRICS
LANGUAGE YAML
AS $$
version: 1.1
source: perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_store_sku_position
comment: "NorthPeak governed exposure metrics: single source of truth for lost-sales and markdown exposure and stockout/overstock counts."
dimensions:
  - name: climate_zone
    expr: climate_zone
  - name: region
    expr: region
  - name: category
    expr: category
  - name: position_status
    expr: position_status
  - name: product_id
    expr: product_id
  - name: product_name
    expr: product_name
measures:
  - name: lost_sales_exposure
    expr: SUM(lost_sales_exposure_usd)
  - name: markdown_exposure
    expr: SUM(markdown_exposure_usd)
  - name: on_hand_units
    expr: SUM(on_hand_units)
  - name: recent_units_7d
    expr: SUM(recent_units_7d)
  - name: recent_net_sales_7d
    expr: SUM(recent_net_sales_7d)
  - name: position_count
    expr: COUNT(1)
  - name: stockout_count
    expr: SUM(CASE WHEN position_status = 'stockout' THEN 1 ELSE 0 END)
  - name: overstock_count
    expr: SUM(CASE WHEN position_status = 'overstock' THEN 1 ELSE 0 END)
  - name: avg_weeks_of_supply
    expr: AVG(weeks_of_supply)
  - name: avg_markdown_risk
    expr: AVG(markdown_risk_score)
# NOTE: spec 02-uc-governance.md calls for an aggregated materialization refreshed
# every 6h. The materialization block is experimental and requires additional
# properties (mode + materialized_views) not yet documented in the skill; deferred.
# This logical (query-time) metric view is functionally identical for all consumers
# (dashboard / Genie / app all query via MEASURE()); the source is a daily snapshot,
# so on-demand evaluation is adequate. Revisit materialization if refresh cost matters.
$$
