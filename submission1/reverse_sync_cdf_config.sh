#!/usr/bin/env bash
# Reverse Sync: northpeak schema → UC Delta (SCD Type 2 / CDC history)
# This script configures Lakebase CDF (Change Data Feed) to stream
# all tables in the northpeak Postgres schema into Unity Catalog Delta tables.
# The CDC history tables use the naming convention lb_<table>_history and
# include _pg_change_type, _pg_lsn, _pg_xid, _timestamp metadata columns.
#
# Prerequisites (already done before running this script):
#   1. REPLICA IDENTITY FULL set on all northpeak tables:
#      ALTER TABLE northpeak.replenishment_actions REPLICA IDENTITY FULL;
#      ALTER TABLE northpeak.action_audit REPLICA IDENTITY FULL;
#      ALTER TABLE northpeak.inventory_notes REPLICA IDENTITY FULL;
#
# Usage: bash reverse_sync_cdf_config.sh

set -euo pipefail

PROFILE="fevm-perma-vm"
PARENT="projects/northpeak-retail/branches/production/databases/databricks-postgres"
TARGET_CATALOG="perma_vm_catalog"
TARGET_SCHEMA="dev_otto_jaaskelainen_northpeak_retail"
PG_SCHEMA="northpeak"
CDF_CONFIG_ID="northpeak_cdf"   # must match [a-z][a-z0-9_]{0,62} — hyphens not allowed

echo "Creating CDF config: ${PG_SCHEMA} -> ${TARGET_CATALOG}.${TARGET_SCHEMA}"
echo "Parent database: ${PARENT}"

databricks postgres create-cdf-config \
  "${PARENT}" \
  "${TARGET_CATALOG}" \
  "${TARGET_SCHEMA}" \
  "${PG_SCHEMA}" \
  --cdf-config-id "${CDF_CONFIG_ID}" \   # Note: uses underscore (not hyphen) per CLI validation
  --profile "${PROFILE}" \
  --no-wait

echo ""
echo "Checking CDF status..."
databricks postgres get-cdf-status \
  "${PARENT}/cdfConfigs/${CDF_CONFIG_ID}" \
  --profile "${PROFILE}" \
  -o json

echo ""
echo "Done. History tables will appear in ${TARGET_CATALOG}.${TARGET_SCHEMA} as:"
echo "  lb_replenishment_actions_history"
echo "  lb_action_audit_history"
echo "  lb_inventory_notes_history"
