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
