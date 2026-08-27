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
