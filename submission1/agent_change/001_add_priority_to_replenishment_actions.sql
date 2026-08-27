-- Migration: 001_add_priority_to_replenishment_actions.sql
-- Branch: dev-otto (Lakebase dev branch off production)
-- Author: otto.jaaskelainen@databricks.com
-- Date: 2026-08-27
-- Purpose: Add priority column to northpeak.replenishment_actions
--          to support urgency-based ordering of replenishment decisions.
--          Priority 1 = most urgent, 5 = lowest priority.

-- ==== UP ====

-- Step 1: Add priority column
ALTER TABLE northpeak.replenishment_actions
    ADD COLUMN IF NOT EXISTS priority INT DEFAULT 3 CHECK (priority BETWEEN 1 AND 5);

-- Step 2: Backfill priorities based on predicted_recaptured_usd
UPDATE northpeak.replenishment_actions
SET priority = CASE
    WHEN predicted_recaptured_usd >= 2000  THEN 1
    WHEN predicted_recaptured_usd >= 1000  THEN 2
    WHEN predicted_recaptured_usd >= 500   THEN 3
    WHEN predicted_recaptured_usd >= 100   THEN 4
    ELSE 5
END;

-- Step 3: Create an index for priority-based queries
CREATE INDEX IF NOT EXISTS idx_replenishment_priority
    ON northpeak.replenishment_actions (priority, status, created_at DESC);

-- ==== DOWN (rollback) ====
-- DROP INDEX IF EXISTS idx_replenishment_priority;
-- ALTER TABLE northpeak.replenishment_actions DROP COLUMN IF EXISTS priority;
