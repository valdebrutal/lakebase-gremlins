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
