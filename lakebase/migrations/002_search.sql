-- 002_search.sql — enable Lakebase Search for HYBRID product search
-- (BM25 keyword + ANN vector). Requires per-project Search Beta enablement;
-- the runner (apply_migrations.py) skips this file cleanly if the extensions
-- are not yet available.
--
-- These installs MUST run BEFORE the products synced table is created: that
-- table (resources/lakebase.yml, products_sync) carries a `vector(1024)`
-- embedding column via a type_override, which needs the pgvector `vector` type
-- that lakebase_vector pulls in. Migration 003 then builds a `lakebase_bm25`
-- keyword index AND a `lakebase_ann` vector index on public.gold_products —
-- both extensions are required for that hybrid design.
--
-- Both statements are idempotent (IF NOT EXISTS) and ordered — text first,
-- then vector.
CREATE EXTENSION IF NOT EXISTS lakebase_text;            -- BM25 (lakebase_bm25)
CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE;  -- ANN (lakebase_ann) + pulls in pgvector `vector` type for the products embedding column
