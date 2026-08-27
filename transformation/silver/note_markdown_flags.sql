CREATE OR REFRESH MATERIALIZED VIEW note_markdown_flags AS
SELECT
  merch_note_text,
  CASE ai_classify(merch_note_text, ARRAY('dead_stock', 'aging', 'healthy'))
    WHEN 'dead_stock' THEN 1.0
    WHEN 'aging'      THEN 0.6
    ELSE 0.1
  END AS markdown_risk_score
FROM (
  SELECT DISTINCT merch_note_text
  FROM raw_inventory_snapshots
  WHERE merch_note_text IS NOT NULL
);
