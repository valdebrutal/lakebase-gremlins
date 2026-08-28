-- 001_northpeak_schema.sql — writable operational tables (idempotent).
CREATE SCHEMA IF NOT EXISTS northpeak;

CREATE TABLE IF NOT EXISTS northpeak.replenishment_actions (
    id                       SERIAL PRIMARY KEY,
    store_id                 TEXT NOT NULL,
    product_id               TEXT NOT NULL,
    move_type                TEXT NOT NULL,
    source_store_id          TEXT,
    units                    INTEGER NOT NULL DEFAULT 0,
    draft_note               TEXT,
    predicted_recaptured_usd NUMERIC(12,2),
    status                   TEXT NOT NULL DEFAULT 'DRAFT',
    approved_by              TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    priority                 INTEGER DEFAULT 3 CHECK (priority BETWEEN 1 AND 5)
);

CREATE TABLE IF NOT EXISTS northpeak.action_audit (
    id         SERIAL PRIMARY KEY,
    action_id  INTEGER NOT NULL
                 REFERENCES northpeak.replenishment_actions(id) ON DELETE CASCADE,
    event      TEXT NOT NULL,
    detail     TEXT,
    at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_replenishment_priority
    ON northpeak.replenishment_actions (priority, status, created_at DESC);
