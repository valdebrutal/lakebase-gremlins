-- 002_search.sql — hybrid search (BM25 + ANN). Requires per-project Search
-- Beta enablement; the runner skips this file cleanly if extensions are absent.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS lakebase_text;
CREATE EXTENSION IF NOT EXISTS lakebase_vector;

CREATE TABLE IF NOT EXISTS northpeak.inventory_notes (
    id                 SERIAL PRIMARY KEY,
    store_id           TEXT,
    product_name       TEXT,
    region             TEXT,
    on_hand_units      INTEGER,
    merch_note         TEXT,
    markdown_risk_score DOUBLE PRECISION,
    search_ts          TSVECTOR,
    embedding          VECTOR(8)
);

CREATE INDEX IF NOT EXISTS idx_inventory_notes_bm25
    ON northpeak.inventory_notes USING lakebase_bm25 (search_ts tsvector_bm25_ops);
CREATE INDEX IF NOT EXISTS idx_inventory_notes_ann
    ON northpeak.inventory_notes USING lakebase_ann (embedding vector_cosine_ops);
