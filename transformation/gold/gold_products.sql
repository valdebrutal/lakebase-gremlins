CREATE OR REFRESH MATERIALIZED VIEW gold_products AS
SELECT
  product_id, product_name, category, subcategory, price_usd, description,
  ai_query(
    'databricks-gte-large-en',
    concat_ws(' ', product_name, coalesce(description, ''))
  ) AS embedding
FROM raw_products;
