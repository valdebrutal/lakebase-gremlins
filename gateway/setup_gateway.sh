#!/usr/bin/env bash
# Unity AI Gateway MODEL SERVICE for NorthPeak (sandbox). Idempotent-ish.
#
# A model service is a Unity Catalog securable (not a serving endpoint / DAB
# resource), so it's created here via the `databricks ai-gateway` CLI — the same
# "not DAB-manageable" category as the metric view and the guardrail function.
#
# Creates otto_demo.northpeak_gateway.northpeak_ai_gateway routing to the
# pay-per-token foundation model system.ai.gpt-oss-120b. The app calls it at
# ${HOST}/ai-gateway/mlflow/v1 by this fully-qualified name (AGENT_MODEL).
#
# Governance (guardrails/service policies + inference table) attaches to the
# model service and requires the ACCOUNT-level "Unity AI Gateway" beta
# (account console → Previews). Once enabled, attach guard_block_all_data
# (created by the gateway_setup bundle job) + the built-in PII guardrail, and
# enable the inference table — from the model service's Policies tab / API.
set -euo pipefail
PROFILE="${DATABRICKS_CONFIG_PROFILE:-otto-sandbox}"
CATALOG="${CATALOG:-otto_demo}"
SCHEMA="${SCHEMA:-northpeak_gateway}"
# The gold DATA schema the app reads at boot (Delta→Lakebase boot-sync +
# analytics). The app SP needs USE SCHEMA + SELECT here or boot DB init fails
# with "User does not have USE SCHEMA on Schema '<catalog>.<data-schema>'".
DATA_SCHEMA="${DATA_SCHEMA:-northpeak_retail}"
SERVICE_ID="northpeak_ai_gateway"
FM="system.ai.gpt-oss-120b"

PARENT="schemas/${CATALOG}.${SCHEMA}"
FQN="${CATALOG}.${SCHEMA}.${SERVICE_ID}"

echo "[gateway] ensuring model service ${FQN} → ${FM}"
if databricks ai-gateway get-model-service "model-services/${FQN}" --profile "$PROFILE" >/dev/null 2>&1; then
  echo "[gateway] model service already exists — leaving as-is"
else
  databricks ai-gateway create-model-service "$PARENT" "$SERVICE_ID" --profile "$PROFILE" --json '{
    "config": {
      "routing": {
        "destinations": [
          {
            "destination_type": "DESTINATION_TYPE_PAY_PER_TOKEN_FOUNDATION_MODEL",
            "name": "'"$FM"'",
            "pay_per_token_config": { "model": "models/'"$FM"'" },
            "traffic_percentage": 100
          }
        ]
      }
    }
  }'
  echo "[gateway] created ${FQN}"
fi

# Grant the app service principal EXECUTE (+ schema/catalog USE) so it can call
# the model service. Pass SP_CLIENT_ID from the deployed app:
#   SP=$(databricks apps get northpeak-store-ops --profile $PROFILE -o json | ... service_principal_client_id)
if [[ -n "${SP_CLIENT_ID:-}" ]]; then
  echo "[gateway] granting EXECUTE on ${FQN} to ${SP_CLIENT_ID}"
  databricks experimental aitools tools query \
    "GRANT USE CATALOG ON CATALOG \`${CATALOG}\` TO \`${SP_CLIENT_ID}\`;" --profile "$PROFILE" || true
  databricks experimental aitools tools query \
    "GRANT USE SCHEMA ON SCHEMA \`${CATALOG}\`.\`${SCHEMA}\` TO \`${SP_CLIENT_ID}\`;" --profile "$PROFILE" || true
  databricks experimental aitools tools query \
    "GRANT EXECUTE ON MODEL SERVICE \`${CATALOG}\`.\`${SCHEMA}\`.\`${SERVICE_ID}\` TO \`${SP_CLIENT_ID}\`;" --profile "$PROFILE"

  # Gold DATA schema read grants — the app's boot-sync reads gold_* tables (and
  # the metric view) with the SP's OWN credentials (not a user OBO token), so
  # the SP needs USE SCHEMA + SELECT on the data schema or boot DB init fails.
  echo "[gateway] granting USE SCHEMA + SELECT on ${CATALOG}.${DATA_SCHEMA} to ${SP_CLIENT_ID}"
  databricks experimental aitools tools query \
    "GRANT USE SCHEMA ON SCHEMA \`${CATALOG}\`.\`${DATA_SCHEMA}\` TO \`${SP_CLIENT_ID}\`;" --profile "$PROFILE" || true
  databricks experimental aitools tools query \
    "GRANT SELECT ON SCHEMA \`${CATALOG}\`.\`${DATA_SCHEMA}\` TO \`${SP_CLIENT_ID}\`;" --profile "$PROFILE" || true
else
  echo "[gateway] SP_CLIENT_ID not set — skipping EXECUTE + data-read grants (run after app deploy)"
fi

echo "[gateway] done. Model service: ${FQN}"
echo "[gateway] app calls it at \${HOST}/ai-gateway/mlflow/v1 with model=${FQN}"
