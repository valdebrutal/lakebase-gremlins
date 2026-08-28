-- Custom AI Gateway guardrail (Build 3, step 4): block prompts that try to
-- read ALL / unfiltered data. Sourced from the Slack MCP search (step 8).
-- On Enhanced Unity AI Gateway this UC function attaches as a custom
-- service policy on the model service (/ai-gateway/v1); it returns TRUE to block.
CREATE OR REPLACE FUNCTION `perma_vm_catalog`.`northpeak_gateway`.guard_block_all_data(prompt STRING)
RETURNS BOOLEAN
COMMENT 'AI Gateway custom guardrail: TRUE = block a runaway all-data read'
RETURN lower(prompt) RLIKE
  '(all customers|every account|entire dataset|read everything|unfiltered|no filter|select \\*|list all customers|all rows|entire table|all data|every record|dump the table)';
