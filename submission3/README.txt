Build 3 · Unity AI Gateway — submission3
========================================
Governed the NorthPeak Store Ops app's AI through the Unity AI Gateway, routed the
ucode coding agent + Slack MCP through it, and captured proof the gateway handled calls.

FILES
- gateway_service.txt ......... Script: governed model service `northpeak-ai-gateway`
      (external-model -> databricks-gpt-5-4) + inference table + usage tracking + PII
      guardrail + rate limit, PLUS the custom UC SQL guardrail guard_block_all_data.
- app_inference_table.json .... Rows from the gateway inference table
      (perma_vm_catalog.northpeak_gateway.app_gw_payload): app calls routed through the
      gateway, the threshold/budget BLOCK (REQUEST_LIMIT_EXCEEDED), and the guardrail
      BLOCK (PII input_guardrail_triggered on a bulk all-data/PII read).
- gateway_usage.lvdash.json ... Lakeview usage dashboard over the gateway inference
      table (usage by principal, outcomes over time, totals). Live query at export:
      50 calls, 16 threshold blocks, 1 guardrail block.
- agent_thread.txt ............ ucode onboarding of Codex through /ai-gateway/codex/v1,
      Slack MCP onboarded through /ai-gateway/mcp-services/system.ai.slack + added to
      Codex, real codex exec calls through the gateway, and the Slack MCP search that
      found the guardrail solution (guard_block_all_data).
- agent_inference_table.json .. [optional] Coding-agent gateway usage, distinct from the
      app's (its own /ai-gateway/codex/v1 endpoint).

HONEST NOTES (this workspace's gateway capabilities)
- The app + coding agent genuinely route through the gateway (calls logged; assistant works).
- Guardrail ENFORCED = the built-in PII guardrail (behavior=BLOCK) — it fires and is logged.
  The custom all-data guardrail is the UC SQL function guard_block_all_data (tested: blocks
  'read all data / select *', allows 'why is Store 214 short?'); on Enhanced Unity AI Gateway
  it attaches as a service policy on the model service via /ai-gateway/v1.
- Budget BLOCK = the enforced AI-Gateway rate-limit rejection (REQUEST_LIMIT_EXCEEDED),
  captured in the inference table. Dollar-denominated hard spend caps are the Enhanced UAIGW
  "spend cap" feature configured in the account console (per go/aigateway).
