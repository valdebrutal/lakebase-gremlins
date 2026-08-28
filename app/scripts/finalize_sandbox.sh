#!/usr/bin/env bash
# Stamp the two non-bindable IDs (dashboard, pipeline) into app/app.yaml from
# the deployed bundle, then redeploy so the app reads THIS bundle's resources.
# Idempotent: removes any previously-stamped block first.
set -euo pipefail
PROFILE="${DATABRICKS_CONFIG_PROFILE:-otto-sandbox}"
BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_YAML="$BUNDLE_DIR/app/app.yaml"
MARK="# >>> finalize_sandbox stamped IDs"

cd "$BUNDLE_DIR"
SUMMARY="$(databricks bundle summary -t sandbox -o json --profile "$PROFILE")"
DASH=$(printf '%s' "$SUMMARY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['resources']['dashboards']['northpeak_dashboard']['id'])")
PIPE=$(printf '%s' "$SUMMARY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['resources']['pipelines']['northpeak_operations']['id'])")

# Remove a previously-stamped block (idempotent), then append the fresh one.
python3 - "$APP_YAML" "$MARK" <<'PY'
import sys,re
path,mark=sys.argv[1],sys.argv[2]
txt=open(path).read()
txt=re.sub(re.escape(mark)+r".*?# <<< finalize_sandbox\n","",txt,flags=re.S)
open(path,"w").write(txt.rstrip()+"\n")
PY

cat >> "$APP_YAML" <<EOF
$MARK
  - name: DASHBOARD_ID
    value: "$DASH"
  - name: PIPELINE_ID
    value: "$PIPE"
# <<< finalize_sandbox
EOF

echo "Stamped DASHBOARD_ID=$DASH PIPELINE_ID=$PIPE into app.yaml"
databricks bundle deploy -t sandbox --profile "$PROFILE"
