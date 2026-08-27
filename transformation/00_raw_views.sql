-- Raw landing zone → pipeline-private temp views. No bronze pass-through.
CREATE TEMPORARY VIEW raw_stores AS
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/stores/', format => 'parquet');
CREATE TEMPORARY VIEW raw_products AS
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/products/', format => 'parquet');
CREATE TEMPORARY VIEW raw_sales AS
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/sales/', format => 'parquet');
CREATE TEMPORARY VIEW raw_inventory_snapshots AS
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/inventory_snapshots/', format => 'parquet');
CREATE TEMPORARY VIEW raw_transfers AS
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/transfers/', format => 'parquet');
CREATE TEMPORARY VIEW raw_store_traffic AS
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/store_traffic/', format => 'parquet');
