#!/usr/bin/env bash
# Grant the NorthPeak app service-principal SELECT on the four Lakebase-synced tables.
#
# WHEN TO RUN:
#   1. First time, after all four synced tables (gold_store_sku_position,
#      gold_open_shortfalls, gold_recovery_recommendations, gold_products) are ONLINE
#      in the Lakebase `databricks_postgres.public` schema.
#   2. Any time the Lakebase project (or branch) has been recreated and the old
#      Postgres grants were dropped with it.
#
# WHO RUNS IT:
#   Must be run as the project CREATOR (otto.jaaskelainen@databricks.com).
#   The app SP is the grantee; it cannot grant to itself, and `public` plus the
#   synced tables are owned by `databricks_writer`.  The creator's Lakebase
#   credential is sufficient — no databricks_superuser session needed.
#
# Usage:
#   ./gateway/grant_synced_tables.sh
#   PROFILE=my-profile ./gateway/grant_synced_tables.sh
#   DATABRICKS_CONFIG_PROFILE=otto-sandbox ./gateway/grant_synced_tables.sh

set -euo pipefail

PROFILE="${DATABRICKS_CONFIG_PROFILE:-${PROFILE:-otto-sandbox}}"
EP="projects/northpeak/branches/production/endpoints/primary"

echo "[synced-tables] profile=${PROFILE}"

# ── 1. Resolve the app SP client id ──────────────────────────────────────────
echo "[synced-tables] fetching app SP client id …"
SP_CLIENT_ID=$(databricks apps get northpeak-store-ops --profile "$PROFILE" -o json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['service_principal_client_id'])")
echo "[synced-tables] SP client id = ${SP_CLIENT_ID}"

# ── 2. Resolve the Lakebase endpoint host ────────────────────────────────────
echo "[synced-tables] resolving Lakebase endpoint host …"
HOST=$(databricks postgres get-endpoint "$EP" --profile "$PROFILE" -o json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['status']['hosts']['host'])")
echo "[synced-tables] host = ${HOST}"

# ── 3. Resolve the current workspace username (creator) ──────────────────────
echo "[synced-tables] resolving creator username …"
DB_USER=$(databricks current-user me --profile "$PROFILE" -o json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['userName'])")
echo "[synced-tables] connecting as ${DB_USER}"

# ── 4. Generate a fresh DB credential ────────────────────────────────────────
echo "[synced-tables] generating database credential …"
TOK=$(databricks postgres generate-database-credential "$EP" --profile "$PROFILE" -o json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

# ── 5. Run grants (idempotent — safe to re-run) ──────────────────────────────
# Lakebase may be scale-to-zero; first connection can fail on cold start.
# Retry up to 3 times with a short backoff.
echo "[synced-tables] running GRANT statements (retry-aware for cold-start) …"

PSQL_CMD="GRANT USAGE ON SCHEMA public TO \"${SP_CLIENT_ID}\";
GRANT SELECT ON public.gold_store_sku_position       TO \"${SP_CLIENT_ID}\";
GRANT SELECT ON public.gold_open_shortfalls          TO \"${SP_CLIENT_ID}\";
GRANT SELECT ON public.gold_recovery_recommendations TO \"${SP_CLIENT_ID}\";
GRANT SELECT ON public.gold_products                 TO \"${SP_CLIENT_ID}\";"

MAX_RETRIES=3
RETRY_DELAY=15
for attempt in $(seq 1 $MAX_RETRIES); do
  echo "[synced-tables] grant attempt ${attempt}/${MAX_RETRIES} …"
  if PGPASSWORD="$TOK" psql \
      "host=${HOST} user=${DB_USER} dbname=databricks_postgres sslmode=require" \
      -v ON_ERROR_STOP=1 \
      -c "$PSQL_CMD" 2>&1; then
    echo "[synced-tables] grants applied successfully"
    break
  else
    if [[ $attempt -lt $MAX_RETRIES ]]; then
      echo "[synced-tables] connection failed (likely cold-start), retrying in ${RETRY_DELAY}s …"
      sleep $RETRY_DELAY
      # Refresh token for next attempt (tokens are short-lived)
      TOK=$(databricks postgres generate-database-credential "$EP" --profile "$PROFILE" -o json \
        | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
    else
      echo "[synced-tables] ERROR: all ${MAX_RETRIES} attempts failed" >&2
      exit 1
    fi
  fi
done

# ── 6. Verify: each table should return 't' ───────────────────────────────────
echo ""
echo "[synced-tables] verifying SELECT privilege for SP ${SP_CLIENT_ID} …"

# Fresh credential for verification query
TOK=$(databricks postgres generate-database-credential "$EP" --profile "$PROFILE" -o json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

TABLES=(
  "gold_store_sku_position"
  "gold_open_shortfalls"
  "gold_recovery_recommendations"
  "gold_products"
)

ALL_OK=true
for TABLE in "${TABLES[@]}"; do
  RESULT=$(PGPASSWORD="$TOK" psql \
    "host=${HOST} user=${DB_USER} dbname=databricks_postgres sslmode=require" \
    -t -A \
    -c "SELECT has_table_privilege('${SP_CLIENT_ID}', 'public.${TABLE}', 'SELECT');")
  if [[ "$RESULT" == "t" ]]; then
    echo "[synced-tables] ✓  public.${TABLE} → has_table_privilege = t"
  else
    echo "[synced-tables] ✗  public.${TABLE} → has_table_privilege = ${RESULT}  (UNEXPECTED)"
    ALL_OK=false
  fi
done

echo ""
if $ALL_OK; then
  echo "[synced-tables] all four tables verified — SP ${SP_CLIENT_ID} can SELECT from synced tables."
else
  echo "[synced-tables] WARNING: one or more tables did not return 't' — check grants above." >&2
  exit 1
fi
