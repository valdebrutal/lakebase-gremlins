#!/usr/bin/env bash
# Build 3 · Unity AI Gateway — create the governed model service + inference
# table + guardrails for the NorthPeak Store Ops app. Idempotent.
set -euo pipefail
PROFILE="${DATABRICKS_CONFIG_PROFILE:-fevm-perma-vm}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1) Catalog/schema that HOLDS the inference table (created by committed code).
databricks experimental aitools tools query \
  "CREATE SCHEMA IF NOT EXISTS \`perma_vm_catalog\`.\`northpeak_gateway\`" --profile "$PROFILE"

# 2) Governed serving endpoint whose spec ENABLES the inference table (auto-capture).
#    Spec: gateway/northpeak_ai_gateway.endpoint.json (ai_gateway.inference_table_config.enabled=true).
databricks serving-endpoints create --profile "$PROFILE" \
  --json @"$HERE/northpeak_ai_gateway.endpoint.json" \
  || databricks serving-endpoints put-ai-gateway northpeak-ai-gateway --profile "$PROFILE" --json '{
       "inference_table_config": {"enabled": true, "catalog_name": "perma_vm_catalog", "schema_name": "northpeak_gateway", "table_name_prefix": "app_gw"},
       "usage_tracking_config": {"enabled": true},
       "guardrails": {"input": {"pii": {"behavior": "BLOCK"}}},
       "rate_limits": [{"calls": 100, "renewal_period": "minute", "key": "endpoint"}]
     }'

# 3) Custom all-data guardrail function.
databricks experimental aitools tools query "$(cat "$HERE/guard_block_all_data.sql")" --profile "$PROFILE"
echo "[gateway] setup complete: endpoint=northpeak-ai-gateway inference_table=perma_vm_catalog.northpeak_gateway.app_gw_payload"
