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
