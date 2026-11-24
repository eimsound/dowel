# CI HTTP API

Use **CI tokens** with the `/api/ci/...` HTTP endpoints to inspect project state and execute forward migrations from pipelines. All endpoints return structured JSON and machine-readable error codes.

> Pipelines on GitHub Actions, Gitea Actions, Forgejo Actions, GitHub Enterprise Server, GitLab CI, Jenkins, or shell scripts can run the built-in `actions/execute` integration documented in [CI pipeline integration](ci-action.md).

---

## 1. Authentication and security boundaries {#auth-and-security}

### Request header {#request-header}

Authenticate every `/api/ci/...` request with a project CI token:

```http
Authorization: Bearer dwl_<43 random characters>
```

- **No cookie sessions or `Origin` checks.** Suitable for `curl` and headless CI runners. (The OpenAPI specification `/api/ci/openapi.json` and interactive docs `/api/ci/docs` additionally accept a logged-in browser session cookie; see [OpenAPI specification and interactive reference](#openapi-docs).)
- **Read-only plus forward apply scope.** A CI token only works under `/api/ci/...` for its single owning project. Passing `Bearer dwl_...` to any other endpoint (including model editing, version publishing, policy edits, connection edits, mark as applied, write baseline, claiming, takeover, or token management) returns `403 forbidden` without falling back to cookie authentication.
- **Project ownership.** Tokens belong to the project rather than a user account, so disabling or removing the creator never breaks pipelines.
- **Mandatory expiration.** Every token expires after a configured lifetime (default 90 days, maximum 365 days). Expiration and revocation take effect immediately.
- **Rate limits** (tracked per replica in memory; multi-replica HA deployments scale total cluster capacity roughly by replica count).
  - Authentication failures are rate-limited per client IP (default 20 well-formed invalid attempts per 10 minutes; tuned with `DOWEL_TOKEN_FAIL_LIMIT` and `DOWEL_TOKEN_FAIL_WINDOW_MS`). Missing or malformed headers reject in memory without consuming quota, successful requests consume no quota, and hitting the IP failure cap blocks only invalid, expired, or revoked tokens while allowing active valid tokens from the same IP.
  - Authenticated requests are rate-limited per token ID (default 120 requests per minute; tuned with `DOWEL_TOKEN_RATE_LIMIT` and `DOWEL_TOKEN_RATE_WINDOW_MS`). Target-connected read and check endpoints (live environment status, execution history, and drift checks) also apply the connection rate limit (default 10 requests per minute; tuned with `DOWEL_CONNECTION_LIMIT` and `DOWEL_CONNECTION_WINDOW_MS`).

### Verify a token {#verify-token}

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/token"
```

Example response (`200 OK`):

```json
{
  "id": "01J...",
  "name": "CI Deploy",
  "prefix": "dwl_AbCdEfGh",
  "expiresAt": "2027-02-18T12:00:00.000Z",
  "project": {
    "id": "01J...",
    "name": "Shop",
    "slug": "shop",
    "owner": "acme"
  },
  "createdBy": "Alice"
}
```

---

## 2. Token management and creator rules {#token-management}

Creating, listing, revoking tokens, and editing the three-layer token creation policy are user-authenticated endpoints using session cookies. Calling them with a CI token returns `403 forbidden`.

### Who can create CI tokens {#who-can-create-tokens}

Configure token creation rules independently at the instance (Execution policy under Admin), group (group home), and project (project settings) layers. Each layer selects eligible project roles (Project admin or Project editor and above) or group roles (admins or members of specified groups such as DBA or release engineering).

- **AND merging across layers.** Every configured layer must match simultaneously. Lower layers can only narrow upper layers. When all three layers are unset, the default allows Project admins only. Instance admins are always permitted.
- **Automatic read-only visibility.** Users permitted via a group condition automatically receive read-only `viewer` visibility on covered projects so they can open project settings and manage tokens.

> **Security boundary warning.** Granting a member or group permission to create CI tokens grants more than read-only project visibility (`viewer`). Because CI tokens bypass "Who can execute" (including "Executors only") and approval flows, token creators can issue a token to run forward migrations on any covered environment where "Allow CI token execution" is enabled (enabled by default on non-production environments and disabled on production environments). Disable "Allow CI token execution" or tighten token creation rules for non-production environments that require strict execution or approval controls.

### Management endpoint examples with session cookies {#token-admin-examples}

```bash
# List project tokens (project admins or users allowed to create tokens)
curl -fsS -b cookies.txt \
  "${DOWEL_URL}/api/projects/${PROJECT_ID}/tokens"

# Create a token (plaintext token appears only in this 201 response)
curl -fsS -b cookies.txt \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: ${DOWEL_URL}" \
  -d '{"name":"CI Deploy","description":"staging automated deploy","expiresInDays":90}' \
  "${DOWEL_URL}/api/projects/${PROJECT_ID}/tokens"

# Revoke a token (project admin, group admin, instance admin, or creator)
curl -fsS -b cookies.txt \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: ${DOWEL_URL}" \
  -d '{}' \
  "${DOWEL_URL}/api/projects/${PROJECT_ID}/tokens/${TOKEN_ID}/revoke"

# Read or update project-level token creation rules
# (instance layer: /api/admin/token-policy; group layer: /api/groups/:slug/token-policy)
curl -fsS -b cookies.txt \
  "${DOWEL_URL}/api/projects/${PROJECT_ID}/token-policy"

curl -fsS -b cookies.txt \
  -X PUT \
  -H "Content-Type: application/json" \
  -H "Origin: ${DOWEL_URL}" \
  -d '{"rule":{"roles":["admin"],"groups":[{"groupId":"GROUP_ID","role":"member"}]}}' \
  "${DOWEL_URL}/api/projects/${PROJECT_ID}/token-policy"
```

---

## 3. Read-only and inspection CI endpoints {#ci-readonly-endpoints}

The `:owner/:project` path parameters must match the token's owning project (old paths after group transfer or slug rename continue to work). Requests targeting any other or missing project return `404 project_not_found`.

Environment endpoints separate platform metadata from live database queries so they never return stale cached target state:

### 3.1 Project and environment list (platform config only) {#get-project}

`GET /api/ci/projects/:owner/:project`

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop"
```

Returns project metadata (`id`, `name`, `slug`, `owner`), `latest` version, and platform settings per environment (`name`, `production`, `tokenExecution`) without connecting to any target database:

```json
{
  "id": "01J...",
  "name": "Shop",
  "slug": "shop",
  "owner": "acme",
  "latest": { "id": "01J...", "number": 5, "name": "Add comment to orders" },
  "environments": [
    { "name": "staging", "production": false, "tokenExecution": true },
    { "name": "prod", "production": true, "tokenExecution": false }
  ]
}
```

### 3.2 Version chain {#get-versions}

`GET /api/ci/projects/:owner/:project/versions`

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop/versions"
```

Returns all published versions in ascending order (`id`, `number`, `name`, `publishedAt`, `verified`, `checksum`).

### 3.3 Live environment status (reads target history) {#get-environment}

`GET /api/ci/projects/:owner/:project/environments/:env`

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging"
```

Subject to the connection rate limit per token. Connects to the target database to read `dowel.history` or `dowel_history` (syncing platform cache in parallel) and returns configuration fields (`name`, `production`, `tokenExecution`), live `currentVersion`, `unfinished`, per-version chain states (`applied`, `current`, `pending`), and the `pending` version list:

```json
{
  "name": "staging",
  "production": false,
  "tokenExecution": true,
  "currentVersion": { "id": "01J...", "number": 4, "name": "Add index" },
  "unfinished": false,
  "versions": [
    { "id": "01J...", "number": 4, "name": "Add index", "state": "current", "verified": true },
    { "id": "01J...", "number": 5, "name": "Add comment to orders", "state": "pending", "verified": true }
  ],
  "pending": [5]
}
```

Returns `502 target_unreachable` when the target database is unreachable, and `409 version_mismatch` when the history format is too new, corrupted, or diverges from the platform chain.

### 3.4 Live drift check (compares full target schema) {#post-drift}

`POST /api/ci/projects/:owner/:project/environments/:env/drift`

```bash
curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging/drift"
```

Subject to the connection rate limit per token. Runs read-only without changing the target database (allowed on production even when `tokenExecution` is disabled), compares the live schema against the environment's current version model, and updates cached drift state:

```json
{
  "environment": "staging",
  "currentVersion": { "id": "01J...", "number": 4, "name": "Add index" },
  "status": "drifted",
  "checkedAt": "2026-11-21T02:00:00.000Z",
  "summary": "Detected 1 structural difference",
  "total": 1,
  "items": [
    {
      "kind": "dropColumn",
      "target": "public.orders.hotfix_col",
      "sql": "ALTER TABLE public.orders DROP COLUMN hotfix_col"
    }
  ],
  "unresolvable": [],
  "firstRun": false,
  "needsManual": null
}
```

- `status` is `clean` (no drift), `drifted` (drift detected), or `unknown` (project has no published versions).
- `items` holds up to 100 diff entries while `total` reports the full count. `unresolvable` lists items the model cannot express for manual inspection.
- `needsManual` returns `{ direction, versionId, versionNumber }` if a previous read-back check failed, or `null` otherwise.
- Returns `423 lock_timeout` when an execution holds the lock, `409 unfinished_run` when an earlier non-atomic run stopped midway, `502 target_unreachable` on connection or permission errors, and `409 version_mismatch` when history does not match the chain.

### 3.5 Target execution history {#get-history}

`GET /api/ci/projects/:owner/:project/environments/:env/history`

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging/history"
```

Subject to the connection rate limit per token. Reads the latest 100 entries from `dowel.history` or `dowel_history` in newest-first order and updates the platform cache.

---

## 4. CI execute endpoint {#ci-execute}

`POST /api/ci/projects/:owner/:project/environments/:env/execute`

Waits synchronously until checks and migration execution complete, then returns structured JSON.

### Request body {#execute-request-body}

| Field                | Type               | Required | Default | Description                                                                                      |
| -------------------- | ------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------ |
| `to`                 | `string \| number` | Yes      | None    | Explicit target version: `latest`, `v5`, or `5`                                                  |
| `dryRun`             | `boolean`          | No       | `false` | When `true`, runs all pre-execution checks and returns the plan without changing the database    |
| `lockTimeoutSeconds` | `integer`          | No       | `30`    | Maximum seconds to wait for the execution lock (`0` to `30`); returns `423 lock_timeout` on wait |

### Execution rules and safety checks {#execution-rules}

- **Policy gate.** Checks only the effective "Allow CI token execution" flag (tightened across layers; enabled by default for non-production, disabled for production). It bypasses "Who can execute" (`whoCanExecute`, including "Executors only") and approval flows. Any user allowed to create CI tokens can issue a token that applies forward migrations on environments where this toggle is enabled.
- **No rollbacks.** Targeting a version earlier than the environment's current version returns `409 rollback_not_allowed`. Rollbacks run through the web UI under approval policy rules.
- **Full safety pipeline.** Drift checks, version chain and checksum validation, target instance claim checks, shadow verification requirements, and policy lock and statement timeouts all apply. The server re-checks token status and policy flags after acquiring the environment lock.
- **Locking and request invalidation.** Shares environment and target project locks with UI executions and execution requests. Completing a token run invalidates any affected open execution requests on that environment.
- **Auditing and notifications.** Non-dry-run requests passing the policy check write audit logs naming the token name, prefix, and creator. Completed runs (success or failure) emit the `token.executed` group webhook event, and runs on production notify project admins and environment approvers (or authorized executors when no stages exist) in the in-app inbox. Two boundaries apply:
  - **Pre-check rejections emit no notifications.** When "Allow CI token execution" is disabled, or re-checking under the lock finds a revoked, expired, or invalid token, a disabled toggle, or a deleted project or environment before any target writes occur, Dowel logs only an audit entry and sends neither `token.executed` webhooks nor inbox notices.
  - **Production `noop: true` runs emit no inbox notices.** When the environment is already at the target version, Dowel still emits the `token.executed` webhook (`data.noop: true`) without flooding the in-app inbox.

### Dry run example {#execute-dry-run-example}

```bash
curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"to":"latest","dryRun":true}' \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging/execute"
```

### Execute example {#execute-example}

```bash
curl -fsS \
  --connect-timeout 15 \
  --max-time 1800 \
  -X POST \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"to":"v5","lockTimeoutSeconds":30}' \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging/execute"
```

> **Timeout and retry guidance.** Always set connect (`--connect-timeout`) and total request (`--max-time`) timeouts to avoid hung pipelines. Never pass automatic retry flags such as `curl --retry` on this write endpoint, because `to: "latest"` resolution, non-transactional or auto-commit DDL steps, audit entries, and webhooks make it non-idempotent. Check live environment status before re-running after a timeout.

### Built-in CI script and Action inputs (`actions/execute`) {#builtin-action-params}

When using [CI pipeline integration](ci-action.md) (either the composite Action for GitHub, Gitea, Forgejo, and GHES, or `bash actions/execute/run.sh`), configure these inputs and environment variables:

| Action input      | Environment variable    | Required | Default | Description                                                                                       |
| ----------------- | ----------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------- |
| `url`             | `DOWEL_URL`             | Yes      | None    | Dowel base URL (`http://` or `https://` only)                                                     |
| `token`           | `DOWEL_TOKEN`           | Yes      | None    | Project CI token (`dwl_...`), passed via `curl --config -` stdin instead of command arguments     |
| `project`         | `DOWEL_PROJECT`         | Yes      | None    | Project path `owner/slug`                                                                         |
| `environment`     | `DOWEL_ENVIRONMENT`     | Yes      | None    | Target environment name, such as `staging`                                                        |
| `to`              | `DOWEL_TO`              | Yes      | None    | Target version: `latest`, `v5`, or `5`                                                            |
| `dry-run`         | `DOWEL_DRY_RUN`         | No       | `false` | When `true`, runs dry-run checks only without altering the database                               |
| `lock-timeout`    | `DOWEL_LOCK_TIMEOUT`    | No       | `30`    | Maximum seconds to wait for the execution lock (`0` to `30`)                                      |
| `connect-timeout` | `DOWEL_CONNECT_TIMEOUT` | No       | `15`    | Connection timeout in seconds (`1` to `3600`, passed to `curl --connect-timeout`)                 |
| `timeout`         | `DOWEL_TIMEOUT`         | No       | `1800`  | Total HTTP request timeout in seconds (`0` to `86400`, passed to `curl --max-time`; `0` disables) |

Input validation failures return `invalid_input` and exit `1` before calling the API. Timeouts and network errors return `network_error` without automatic retries.

### Success response (`200 OK`) {#execute-success-response}

```json
{
  "ok": true,
  "dryRun": false,
  "project": "acme/shop",
  "environment": "staging",
  "from": { "id": "01J...", "number": 4, "name": "Add index" },
  "to": { "id": "01J...", "number": 5, "name": "Add comment to orders" },
  "reached": { "id": "01J...", "number": 5, "name": "Add comment to orders" },
  "migrations": [{ "number": 5, "name": "Add comment to orders", "direction": "up" }],
  "noop": false,
  "durationMs": 412
}
```

When the environment is already at the target version, the server returns `200 OK` with `noop: true` and `migrations: []`.

---

## 5. Error responses and error codes {#error-codes}

All errors use a unified JSON envelope:

```json
{
  "ok": false,
  "code": "drift",
  "error": "Target database structure differs from the current environment version…",
  "details": { "reason": "drift", "diff": [...], "diffTotal": 2 },
  "reached": { "id": "01J...", "number": 4, "name": "Add index" }
}
```

> On partial failures, `reached` identifies the last completed version. `details` appears only when extra context such as `diff`, `timeout`, `current`, or `partial` exists.

| Error code (`code`)        | HTTP status | Meaning and common causes                                                                                   |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `invalid_request`          | `400`       | Invalid JSON body or out-of-range `to`, `dryRun`, or `lockTimeoutSeconds`                                   |
| `token_missing`            | `401`       | Missing `Authorization` header                                                                              |
| `token_invalid`            | `401`       | Malformed token, missing `dwl_` prefix, or unknown token                                                    |
| `token_expired`            | `401`       | Token passed its expiration timestamp                                                                       |
| `token_revoked`            | `401`       | Token was revoked                                                                                           |
| `forbidden`                | `403`       | CI token called an endpoint outside `/api/ci/...`                                                           |
| `token_execution_disabled` | `403`       | Effective execution policy disables CI token execution (default on production)                              |
| `project_not_found`        | `404`       | Project does not exist or belongs to another project                                                        |
| `environment_not_found`    | `404`       | Environment does not exist                                                                                  |
| `rollback_not_allowed`     | `409`       | Target version is older than current version (tokens cannot roll back; see `details.current`)               |
| `version_mismatch`         | `409`       | Target history conflicts with platform chain, checksum mismatch, or newer format (see `details.reason`)     |
| `unverified`               | `409`       | Pending migration has not passed shadow database verification                                               |
| `drift`                    | `409`       | Target schema drifted from current version, or first run is neither baseline nor empty (`details.firstRun`) |
| `unfinished_run`           | `409`       | Previous non-transactional or auto-commit migration stopped partway; resolve in the UI first                |
| `foreign_instance`         | `409`       | Project in target database is claimed by another Dowel instance                                             |
| `rejected`                 | `409`       | Pre-execution check rejected the run, such as instance-level SQL or invalid scope (`details.reason`)        |
| `version_not_found`        | `422`       | Target version is missing from the chain, or the project has no published versions                          |
| `execution_failed`         | `422`       | SQL step error, policy timeout, or read-back mismatch; environment stops at `reached`                       |
| `lock_timeout`             | `423`       | Timed out waiting for environment lock or target project lock (another run is active)                       |
| `rate_limited`             | `429`       | Exceeded auth-failure limit or token request limit (check `Retry-After` header)                             |
| `target_unreachable`       | `502`       | Failed to connect to target database, or missing privileges such as creating the `dowel` schema             |
| `internal`                 | `500`       | Unexpected server error                                                                                     |

---

## 6. OpenAPI specification and interactive reference {#openapi-docs}

Dowel exposes an OpenAPI 3.1 schema and a self-hosted Scalar API reference page covering the 7 CI endpoints:

- **`GET /api/ci/openapi.json`** — OpenAPI `3.1.0` JSON document describing all 7 `/api/ci/...` endpoints, request parameters/bodies, 200 responses, and CI error responses (`CiErrorBody`).
- **`GET /api/ci/docs`** — Self-hosted Scalar interactive API reference UI (all assets served from the same origin with strict CSP compatibility; no external CDN, fonts, or telemetry requests).

### Access and authentication rules {#openapi-docs-auth}

Unlike the 7 operational CI endpoints (which strictly require `Authorization: Bearer dwl_...` and never accept cookies), the documentation endpoints (`/api/ci/openapi.json`, `/api/ci/docs`, and `/api/ci/docs/init.js`) accept **either**:

1. **A logged-in user session cookie** — Open `${DOWEL_URL}/api/ci/docs` directly in your browser after signing in. Users required to change a temporary password receive `403 password_change_required`; unauthenticated or disabled sessions receive `401 unauthorized`.
2. **A valid project CI token (`Authorization: Bearer dwl_...`)** — Subject to the same token validation, per-IP failure rate limit, and per-token rate limit as operational CI endpoints. Invalid, expired, or revoked `dwl_...` tokens return `401` (`token_invalid`, `token_expired`, `token_revoked`) without falling back to cookies.

Passing an MCP token (`Bearer dwm_...`) returns `403 forbidden`.

### Fetch the OpenAPI 3.1 specification with a CI token {#openapi-curl}

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/openapi.json"
```

### Open interactive documentation in a browser {#openapi-browser}

Sign in to Dowel in your browser and navigate to:

```text
${DOWEL_URL}/api/ci/docs
```
