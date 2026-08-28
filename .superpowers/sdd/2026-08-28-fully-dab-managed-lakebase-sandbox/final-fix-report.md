# Final Fix Report — sandbox-full-dab branch
Date: 2026-08-28

---

## C1 (Critical): lakebase_migrate job missing env

### What changed
**`lakebase/apply_migrations.py`**
- Added `import argparse` at top-level (stdlib only).
- `_connect()` signature changed from `_connect()` (reads os.environ) to
  `_connect(project, user, branch="production", endpoint="primary", dbname="databricks_postgres")`.
  The `psycopg` and `databricks.sdk` imports remain inside the function body so
  `import lakebase.apply_migrations` succeeds without those packages on `sys.path`.
- `main()` now builds an `argparse.ArgumentParser` with five flags
  (`--project`, `--user`, `--branch`, `--endpoint`, `--database`), each with
  an env-var fallback (`LAKEBASE_PROJECT_ID`, `PGUSER`, `LAKEBASE_BRANCH_ID`,
  `LAKEBASE_ENDPOINT_ID`, `PGDATABASE`) and sensible defaults for the optional
  three.
- After parsing, `main()` raises `SystemExit` with a clear message if
  `args.project` or `args.user` is falsy.
- Calls `_connect(project=…, user=…, branch=…, endpoint=…, dbname=…)` with the
  resolved values.
- `pending_migrations()` is entirely unchanged.

**`resources/jobs.yml`**
Added `parameters` block to `spark_python_task`:
```yaml
parameters:
  - "--project"
  - "northpeak"
  - "--user"
  - "${workspace.current_user.userName}"
```
`branch`/`endpoint`/`database` remain at their argparse defaults.

### Evidence
```
pytest lakebase/test_apply_migrations.py -v
→ 3/3 passed in 0.01 s

python -c "import lakebase.apply_migrations; print('import OK')"
→ import OK

python lakebase/apply_migrations.py --help
→ usage: apply_migrations.py [-h] [--project PROJECT] [--user USER]
                             [--branch BRANCH] [--endpoint ENDPOINT]
                             [--database DATABASE]
  (no KeyError, no psycopg import error)
```

---

## I2 (Important): app postgres binding missing permission

### What changed
**`resources/app.yml`** — added `permission: CAN_CONNECT_AND_CREATE` to the
`postgres` binding (line after the `database:` field). The other three bindings
(`sql-warehouse`, `genie-space`, `agent-gateway`) are untouched.

### Evidence
`databricks bundle validate` after the change: 0 errors, same 6 pre-existing
Beta postgres warnings. No new errors introduced.

---

## I3 (Important): runbook over-promises custom guardrail block

### What changed
**`docs/DEPLOY_SANDBOX.md`** — Step 10 smoke check comment 3 was reworded:
- PII guardrail: described as active via the bundle (`ai_gateway.guardrails`
  input PII detection) — WILL block PII prompts.
- "read all data" prompt: added explicit NOTE that `guard_block_all_data` is
  created by `gateway_setup` (Step 8) as a governance artefact but is NOT wired
  into the endpoint by the bundle (no DAB field expresses a custom UC guardrail
  function attachment). The block is NOT active until manual out-of-band
  attachment. Smoke test must not expect it to be blocked.
- The rest of the runbook (all other steps, checklist, warnings) is unchanged.

---

## m4 (Minor): regex escape regression in sandbox_guardrail.sql

### What changed
**`gateway/sandbox_guardrail.sql`** — `select \*` restored to `select \\*`
to match `gateway/guard_block_all_data.sql` (the tested original).

In a SQL RLIKE pattern string, `\\*` is the two-character escape sequence that
the regex engine interprets as a literal `*`. A single `\*` would be treated
as an unescaped `*` (zero-or-more of the preceding `\`), which would not
reliably match the literal word `select *`.

---

## pytest output (verbatim)
```
============================= test session starts ==============================
platform darwin -- Python 3.14.7, pytest-9.1.1, pluggy-1.6.0
rootdir: /Users/otto.jaaskelainen/Downloads/northpeak-retail
collected 3 items

lakebase/test_apply_migrations.py::test_returns_unapplied_in_sorted_order PASSED [ 33%]
lakebase/test_apply_migrations.py::test_skips_already_applied PASSED     [ 66%]
lakebase/test_apply_migrations.py::test_empty_when_all_applied PASSED    [100%]

============================== 3 passed in 0.01s ===============================
```

---

## bundle validate output (verbatim)
```
Warning: unknown field: spec
  at resources.postgres_projects.northpeak
  in resources/lakebase.yml:11:7

Warning: unknown field: parent
  at resources.postgres_catalogs.northpeak_uc
  in resources/lakebase.yml:25:7

Warning: unknown field: spec
  at resources.postgres_catalogs.northpeak_uc
  in resources/lakebase.yml:26:7

Warning: unknown field: spec
  at resources.postgres_roles.dev_user
  in resources/lakebase.yml:41:7

Warning: required field "postgres_database" is not set
  at resources.postgres_catalogs.northpeak_uc
  in resources/lakebase.yml:24:7

Warning: required field "role" is not set
  at resources.postgres_databases.production_db
  in resources/lakebase.yml:17:7

Name: workshop-northpeak-retail
Target: sandbox
Found 6 warnings
```
0 errors. All 6 warnings are pre-existing Beta postgres field-shape warnings in
`resources/lakebase.yml` — none of the four changes introduced a new warning or error.

---

## Self-review

- C1: `pending_migrations()` body is byte-for-byte identical to original. ✓
  `_connect()` is now a pure function of its arguments; no hidden env reads. ✓
  `psycopg`/`databricks.sdk` still import inside function bodies only. ✓
  Missing project/user raises SystemExit with named field, not bare KeyError. ✓
  Job parameters inject `northpeak` and the workspace current user. ✓
- I2: Only the `postgres` resource block was touched; others unchanged. ✓
- I3: Step text is accurate: PII described as active, all-data block described
  as NOT active until out-of-band attachment. No other step touched. ✓
- m4: `\\*` restored, matching the reference file. ✓

## Concerns
None. All four findings fully resolved with 0 new bundle errors.
