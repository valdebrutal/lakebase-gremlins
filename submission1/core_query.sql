-- Core Domain Query: Which stores are short on a top product?
-- Question: Stores with zero inventory on SKU-APP-04412 (Summit Down Parka),
--           ranked by lost_sales_exposure_usd descending (greatest revenue risk first)
-- Source: public.gold_open_shortfalls (Lakebase synced table, 150 rows)

SELECT
    store_id,
    product_id,
    region,
    on_hand_units,
    ROUND(lost_sales_exposure_usd::numeric, 2)         AS lost_sales_exposure_usd,
    nearest_surplus_store_id,
    nearest_surplus_on_hand,
    ROUND(nearest_surplus_distance_km::numeric, 1)     AS surplus_distance_km
FROM public.gold_open_shortfalls
WHERE product_id = 'SKU-APP-04412'
  AND on_hand_units = 0
ORDER BY lost_sales_exposure_usd DESC NULLS LAST
LIMIT 10;
