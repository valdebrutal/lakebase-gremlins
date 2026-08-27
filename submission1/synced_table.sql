-- Synced Table: gold_open_shortfalls
-- UC Source: perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_open_shortfalls
-- Target Lakebase Catalog: lakebase-gremlins-uc-registration
-- Target Postgres schema/table: public.gold_open_shortfalls
-- Scheduling: SNAPSHOT
-- Primary Keys: store_id, product_id

-- CLI command used to create the synced table:
-- databricks postgres create-synced-table \
--   "lakebase-gremlins-uc-registration.public.gold_open_shortfalls" \
--   --json '{
--     "spec": {
--       "source_table_full_name": "perma_vm_catalog.dev_otto_jaaskelainen_northpeak_retail.gold_open_shortfalls",
--       "primary_key_columns": ["store_id", "product_id"],
--       "scheduling_policy": "SNAPSHOT",
--       "branch": "projects/northpeak-retail/branches/production",
--       "postgres_database": "databricks_postgres",
--       "create_database_objects_if_missing": true,
--       "new_pipeline_spec": {
--         "storage_catalog": "perma_vm_catalog",
--         "storage_schema": "dev_otto_jaaskelainen_northpeak_retail"
--       }
--     }
--   }' \
--   --profile fevm-perma-vm

-- Verification query - top stores by lost sales exposure:
SELECT store_id,
       product_id,
       region,
       on_hand_units,
       lost_sales_exposure_usd,
       nearest_surplus_store_id,
       nearest_surplus_on_hand
FROM public.gold_open_shortfalls
ORDER BY lost_sales_exposure_usd DESC NULLS LAST
LIMIT 10;

-- Status check:
-- databricks postgres get-synced-table "synced_tables/lakebase-gremlins-uc-registration.public.gold_open_shortfalls" --profile fevm-perma-vm
-- Result state: SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE  (150 rows synced)
