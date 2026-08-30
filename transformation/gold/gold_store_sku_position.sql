CREATE OR REFRESH MATERIALIZED VIEW gold_store_sku_position
CLUSTER BY (product_id)
AS
WITH current_snapshot AS (
  SELECT * FROM silver_inventory
  WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM silver_inventory)
  -- Deduplicate to exactly one row per (store_id, product_id): silver_inventory
  -- can have multiple rows per position at the latest snapshot; take the row with
  -- the highest on_hand_units (deterministic pick matching app's onConflictDoNothing
  -- behavior which always kept the first-inserted row for a given store×product).
  QUALIFY ROW_NUMBER() OVER (PARTITION BY store_id, product_id ORDER BY on_hand_units DESC) = 1
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
    -- Zero-velocity items with on-hand inventory are treated as infinite supply (9999 sentinel);
    -- this is the expected_sellthrough-multiplier tuning: with no sales, all inventory is excess.
    CASE WHEN on_hand_units > 0 AND recent_units_7d = 0 THEN 9999.0
         ELSE on_hand_units / NULLIF((recent_units_7d / 7.0) * 7, 0)
    END AS weeks_of_supply
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
  -- Markdown exposure applies ONLY to over-stocked (dead-stock) positions, matching the
  -- position_status='overstock' gate below and the spec's "for over-stocked positions".
  -- The markdown_risk_score >= 0.6 gate excludes the many zero-velocity 'healthy' positions
  -- (weeks_of_supply=9999 sentinel) that would otherwise inflate the measure massively.
  CASE WHEN COALESCE(weeks_of_supply, 0) > 8 AND markdown_risk_score >= 0.6
       THEN GREATEST(0, (on_hand_units - avg_daily_velocity * 30) * price_usd * 0.3) ELSE 0 END
    AS markdown_exposure_usd,
  CASE
    WHEN on_hand_units = 0 AND avg_daily_velocity > 0 THEN 'stockout'
    WHEN COALESCE(weeks_of_supply, 999) < 1 AND avg_daily_velocity > 0 THEN 'at_risk'
    WHEN COALESCE(weeks_of_supply, 0) > 8 AND markdown_risk_score >= 0.6 THEN 'overstock'
    ELSE 'healthy'
  END AS position_status
FROM metrics;
