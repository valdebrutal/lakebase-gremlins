-- 003_search_indexes.sql — BM25 + ANN hybrid-search indexes on the synced
-- public.gold_products table.
--
-- Requires: lakebase_text (BM25) and lakebase_vector + vector (ANN) extensions
-- to be installed on the project.  The runner in apply_migrations.py degrades
-- to a logged skip for files starting with "002" or "003" when the extensions
-- are absent, so this file is safe to ship even on a bare project.
--
-- BM25 keyword index — EXPRESSION form (no stored tsvector column needed).
-- The to_tsvector expression must match exactly what the BM25 query uses.
CREATE INDEX IF NOT EXISTS gold_products_bm25
  ON public.gold_products
  USING lakebase_bm25 ((to_tsvector('english', product_name || ' ' || coalesce(description, ''))));

-- ANN (approximate nearest-neighbor) vector index for semantic search.
-- embedding is vector(1024); cosine distance matches the embedding model.
CREATE INDEX IF NOT EXISTS gold_products_ann
  ON public.gold_products
  USING lakebase_ann (embedding vector_cosine_ops);
