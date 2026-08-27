CREATE OR REFRESH MATERIALIZED VIEW gold_transfer_outcomes AS
SELECT
  transfer_id, product_id, move_type, units_moved, distance_km,
  days_to_fulfill, price_usd,
  (price_usd - product_cost_usd) / NULLIF(price_usd, 0) AS margin_pct,
  recaptured_sales_usd, margin_impact_usd, cost_usd
FROM silver_transfers;
