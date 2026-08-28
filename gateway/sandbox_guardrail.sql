-- Sandbox AI Gateway custom guardrail: TRUE = block a runaway all-data read.
-- (catalog-adjusted copy of gateway/guard_block_all_data.sql for otto_demo)
CREATE OR REPLACE FUNCTION `otto_demo`.`northpeak_gateway`.guard_block_all_data(prompt STRING)
RETURNS BOOLEAN
COMMENT 'AI Gateway custom guardrail: TRUE = block a runaway all-data read'
RETURN lower(prompt) RLIKE
  '(all customers|every account|entire dataset|read everything|unfiltered|no filter|select \*|list all customers|all rows|entire table|all data|every record|dump the table)';
