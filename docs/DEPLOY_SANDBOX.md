# NorthPeak Retail — Sandbox Deploy Runbook

> **User-gated deploy sequence.** Execute each step in order; read the notes
> for each step before running it. No step is automatic.

---

## Prerequisites

- Databricks CLI configured with profile `otto-sandbox` pointing at the
  NorthPeak sandbox workspace.
- Node.js and npm available in `$PATH` (required for Step 2 app build).
- The `sandbox-full-dab` branch checked out in this repo.

---

## Validated Bundle State

Full validate: **0 errors, 6 warnings** (all warnings are pre-existing Beta
`postgres_*` field-shape warnings — acceptable at first deploy; correct against
`databricks postgres create-<x> -h` if a resource is rejected).

Resources included in the bundle (17 total):

| Resource | Name |
|---|---|
| `schemas` | `demo_schema` (`otto_demo.northpeak`) |
| `schemas` | `gateway_schema` (`otto_demo.northpeak_gateway`) |
| `volumes` | `raw_data` |
| `pipelines` | `northpeak_operations` |
| `jobs` | `northpeak_setup` |
| `jobs` | `lakebase_migrate` |
| `jobs` | `gateway_setup` |
| `dashboards` | `northpeak_dashboard` |
| `genie_spaces` | `northpeak_genie` |
| `model_serving_endpoints` | `northpeak_ai_gateway` |
| `apps` | `northpeak_app` |
| `postgres_projects` | `northpeak` |
| `postgres_branches` | `dev_otto` |
| `postgres_databases` | `production_db` |
| `postgres_endpoints` | `dev_otto_primary` |
| `postgres_catalogs` | `northpeak_uc` |
| `postgres_roles` | `dev_user` |
| `postgres_synced_tables` | `open_shortfalls_sync` |

---

## Deploy Order

### Step 1 — Validate

```bash
databricks bundle validate -t sandbox --profile otto-sandbox
```

Expected: 0 errors, 6 warnings (Beta postgres field-shape warnings).
If you see new errors, stop and fix before proceeding.

---

### Step 2 — Build the app artifact

```bash
cd app && ./scripts/build-app.sh && cd ..
```

Expected: `app/dist/server.js` and `app/client/dist/` produced.
The DAB syncs `dist/` to the app source directory; the Databricks Apps
container does **not** build — it runs the pre-built artifact.

---

### Step 3 — Deploy the bundle

```bash
databricks bundle deploy -t sandbox --profile otto-sandbox
```

This single command creates:

- The Unity Catalog schemas (`otto_demo.northpeak`, `otto_demo.northpeak_gateway`)
  and the raw-data volume.
- The Lakeflow Declarative Pipeline (`northpeak_operations`).
- The three jobs (`northpeak_setup`, `lakebase_migrate`, `gateway_setup`).
- The AI/BI dashboard and Genie space.
- The AI Gateway provisioned-throughput serving endpoint
  (`northpeak-ai-gateway`) — may take several minutes to become `READY`.
- The Databricks App (`northpeak-store-ops`).
- The Lakebase resources: project `northpeak`, branch `production`/`dev-otto`,
  endpoint `primary`, database `databricks_postgres`, UC catalog
  `northpeak_uc`, dev-user role, and the `open_shortfalls_sync` synced table.

**Beta postgres shapes:** If any `postgres_*` resource is rejected with an
unknown-field error, correct its fields against
`databricks postgres create-<resource-type> -h` and re-deploy. The 6
pre-existing Beta warnings in validate are expected and do not block deploy.

**AI Gateway provisioned-throughput defaults to confirm at first deploy:**

| Field | Value |
|---|---|
| `entity_name` | `system.ai.gpt-oss-120b` |
| `entity_version` | `"1"` |
| `min_provisioned_throughput` | `0` (scale-to-zero) |
| `max_provisioned_throughput` | `9500` |

If the PT range or model version has changed since authoring, adjust
`resources/gateway.yml` and re-deploy.

---

### Step 3b — Grant the app service principal its Postgres role

> **Preflight ruling:** The app service-principal Postgres role is
> **not a bundle resource** and must be granted manually after deploy.

Get the app's service principal client ID:

```bash
SP=$(databricks apps get northpeak-store-ops --profile otto-sandbox -o json \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['service_principal_client_id'])")
```

Create its Postgres role on the `production` branch:

```bash
databricks postgres create-role projects/northpeak/branches/production \
  --role-id "$SP" \
  --json "{\"spec\": {\"identity_type\": \"SERVICE_PRINCIPAL\", \"postgres_role\": \"$SP\", \"auth_method\": \"LAKEBASE_OAUTH_V1\"}}" \
  --profile otto-sandbox
```

Schema grants for `northpeak.*` / `public` are handled by the app's own boot
migration together with the `CAN_CONNECT_AND_CREATE` binding. If the app needs
to read synced public tables directly, additionally run:

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "$SP";
```

via a Postgres session connected to the `production` branch.

---

### Step 4 — Run the setup job

```bash
databricks bundle run northpeak_setup -t sandbox --profile otto-sandbox
```

Generates synthetic raw data, uploads to the volume, and patches the app
environment with bundle-resolved IDs (Genie space ID, dashboard ID, etc.).

---

### Step 5 — Run the pipeline

```bash
databricks bundle run northpeak_operations -t sandbox --profile otto-sandbox
```

Runs the Lakeflow Declarative Pipeline to process raw data through
bronze → silver → gold layers into `otto_demo.northpeak`.

---

### Step 6 — Enable per-project Search Beta on project `northpeak`

**Required before Step 7** for migration `002_enable_search.sql` to succeed.
Migration `001` runs regardless, but `002` needs Search enabled first.

Enable via the Databricks UI: navigate to the Lakebase project `northpeak` →
**Settings** → enable **Search** (shared preload libraries). Alternatively,
use the Lakebase project settings API if available in your workspace version.

---

### Step 7 — Run the Lakebase migration job

```bash
databricks bundle run lakebase_migrate -t sandbox --profile otto-sandbox
```

Applies pending in-DB migrations (idempotent; re-run is safe). Migration `001`
creates the application schema; `002` requires Search to be enabled (Step 6).

---

### Step 8 — Run the gateway setup job

```bash
databricks bundle run gateway_setup -t sandbox --profile otto-sandbox
```

Creates the UC SQL function
`otto_demo.northpeak_gateway.guard_block_all_data` that the AI Gateway
guardrail uses to block PII and bulk-data prompts.

---

### Step 9 — Run the finalize script

```bash
DATABRICKS_CONFIG_PROFILE=otto-sandbox ./app/scripts/finalize_sandbox.sh
```

Performs any remaining post-deploy wiring (catalog/schema references, app
environment final patch, etc.) that requires live resource IDs from the
workspace.

---

### Step 10 — Smoke checks

```bash
# 1. Confirm the app is running and note its URL:
databricks apps get northpeak-store-ops --profile otto-sandbox -o json
# → expect: "state": "RUNNING"

# 2. Open the app URL in a browser:
#    - Map and queue views show otto_demo data
#    - Genie tab answers a natural-language question
#    - Dashboard tab renders the deployed dashboard

# 3. Test the AI Gateway guardrail:
#    - Send a normal prompt via the agent chat UI
#      → should succeed; a row appears in otto_demo.northpeak_gateway.app_gw_*
#    - Send a prompt containing PII (e.g. a Social Security Number or email address)
#      → the PII guardrail on the endpoint (ai_gateway.guardrails.input.pii_detection)
#         is active via the bundle and WILL block it
#    - Send a "read all data" prompt (e.g. "list all customers")
#      → NOTE: the custom UC function guard_block_all_data is created by the
#         gateway_setup job (Step 8) as evidence/governance artefact, but it is
#         NOT automatically wired into the serving endpoint by the bundle — the
#         DAB has no field to attach a custom UC guardrail function to an endpoint.
#         This means the "read all data" block is NOT active until the function is
#         manually attached to the endpoint out-of-band. Do not expect this prompt
#         to be blocked in a default post-deploy smoke test.
```

---

## Important Warnings

### `bundle destroy` — DO NOT run without reading this

`bundle destroy -t sandbox` will **permanently remove**:

- The Lakebase project `northpeak` (and all its branches, endpoints,
  databases, and synced tables).
- The AI Gateway serving endpoint `northpeak-ai-gateway`.
- The Databricks App `northpeak-store-ops`.
- The schemas, volume, pipeline, jobs, dashboard, and Genie space.

The catalog `otto_demo` is **referenced-but-not-managed** by this bundle
(no `catalogs` resource; it was pre-existing). Destroying the bundle will
**not** delete `otto_demo`, but all data in the bundle-managed schemas
(`otto_demo.northpeak`, `otto_demo.northpeak_gateway`) will be lost along
with the schemas themselves.

**Recommendation:** Never run `bundle destroy` on the sandbox without an
explicit intent to tear down the entire demo environment. The Lakebase
project deletion is irreversible.

---

## Runbook Checklist

- [ ] Step 1: `bundle validate` — 0 errors
- [ ] Step 2: App artifact built — `app/dist/server.js` exists
- [ ] Step 3: `bundle deploy` — all 17 resources created
- [ ] Step 3b: App SP Postgres role granted on `production` branch
- [ ] Step 4: `northpeak_setup` job completed
- [ ] Step 5: `northpeak_operations` pipeline completed
- [ ] Step 6: Search Beta enabled on Lakebase project `northpeak` (UI)
- [ ] Step 7: `lakebase_migrate` job completed
- [ ] Step 8: `gateway_setup` job completed — guardrail function created
- [ ] Step 9: `finalize_sandbox.sh` completed
- [ ] Step 10: App smoke checks passed
