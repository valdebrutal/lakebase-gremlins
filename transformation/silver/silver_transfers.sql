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
