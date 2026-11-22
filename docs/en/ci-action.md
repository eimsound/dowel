# CI pipeline integration

The repository includes [actions/execute](https://github.com/eimsound/dowel/tree/main/actions/execute) to run dry runs or forward migrations against a target environment using a project CI token. It is built with pure `bash` and `curl`, preferring `jq` for JSON parsing with automatic fallback to `node`, and has zero third-party Action dependencies. Tokens pass through `curl --config -` on stdin so credentials never appear in process arguments or logs.

## Compatible platforms {#compatible-platforms}

- **GitHub Actions and compatible runners.** GitHub Actions, self-hosted Gitea Actions, Forgejo Actions, and GitHub Enterprise Server can reference the composite Action directly. Air-gapped runners can mirror the repository internally and reference the internal path.
- **Any shell pipeline.** GitLab CI, Jenkins, Drone, Woodpecker, Buildkite, and other runners can invoke `bash actions/execute/run.sh` with environment variables.

## Run `run.sh` in any CI system {#run-sh}

```bash
DOWEL_URL="https://dowel.internal.example.com" \
DOWEL_TOKEN="$DOWEL_TOKEN" \
DOWEL_PROJECT="acme/shop" \
DOWEL_ENVIRONMENT="staging" \
DOWEL_TO="latest" \
DOWEL_DRY_RUN="false" \
DOWEL_LOCK_TIMEOUT="30" \
DOWEL_CONNECT_TIMEOUT="15" \
DOWEL_TIMEOUT="1800" \
bash actions/execute/run.sh
```

Environment variable names match the Action inputs below: `DOWEL_URL`, `DOWEL_TOKEN`, `DOWEL_PROJECT`, `DOWEL_ENVIRONMENT`, `DOWEL_TO`, `DOWEL_DRY_RUN`, `DOWEL_LOCK_TIMEOUT`, `DOWEL_CONNECT_TIMEOUT`, and `DOWEL_TIMEOUT`.

## Use in Actions workflows {#github-actions}

> Always pin external or internal Action references to a full 40-character commit SHA with a version comment rather than a mutable branch name.

```yaml
name: Migrate Staging

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - name: Dry run migrations
        uses: eimsound/dowel/actions/execute@<40-char-commit-sha> # v1.0.0
        with:
          url: ${{ vars.DOWEL_URL }}
          token: ${{ secrets.DOWEL_TOKEN }}
          project: acme/shop
          environment: staging
          to: latest
          dry-run: 'true'

      - name: Execute migrations
        id: migrate
        uses: eimsound/dowel/actions/execute@<40-char-commit-sha> # v1.0.0
        with:
          url: ${{ vars.DOWEL_URL }}
          token: ${{ secrets.DOWEL_TOKEN }}
          project: acme/shop
          environment: staging
          to: latest
          lock-timeout: '30'

      - name: Print outputs
        run: |
          echo "reached=${{ steps.migrate.outputs.reached }}"
          echo "noop=${{ steps.migrate.outputs.noop }}"
```

## Inputs and environment variables {#inputs}

| Action input      | Environment variable    | Required | Default | Description                                                                                        |
| ----------------- | ----------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------- |
| `url`             | `DOWEL_URL`             | Yes      | None    | Dowel service URL (`http://` or `https://` only)                                                   |
| `token`           | `DOWEL_TOKEN`           | Yes      | None    | Project CI token (`dwl_...`), stored in CI secrets                                                 |
| `project`         | `DOWEL_PROJECT`         | Yes      | None    | Project path in `owner/slug` format                                                                |
| `environment`     | `DOWEL_ENVIRONMENT`     | Yes      | None    | Target environment name, such as `staging`                                                         |
| `to`              | `DOWEL_TO`              | Yes      | None    | Target version: `latest`, `v5`, or `5`                                                             |
| `dry-run`         | `DOWEL_DRY_RUN`         | No       | `false` | When `true`, runs pre-execution checks and returns the plan without writing to the target database |
| `lock-timeout`    | `DOWEL_LOCK_TIMEOUT`    | No       | `30`    | Maximum seconds to wait for the execution lock (`0` to `30`)                                       |
| `connect-timeout` | `DOWEL_CONNECT_TIMEOUT` | No       | `15`    | Seconds allowed to establish the HTTP connection (`1` to `3600`)                                   |
| `timeout`         | `DOWEL_TIMEOUT`         | No       | `1800`  | Maximum total request duration in seconds (`0` to `86400`; `0` means unlimited)                    |

## Outputs {#outputs}

| Output     | Description                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `ok`       | Whether execution or dry run succeeded (`true` or `false`)                                              |
| `code`     | Machine-readable failure code such as `drift`, `rollback_not_allowed`, or `lock_timeout`; empty on pass |
| `reached`  | Version reached on the environment (`v5`, or empty if none)                                             |
| `noop`     | Whether the environment was already at the target version (`true` or `false`)                           |
| `response` | Raw JSON response body returned by the server                                                           |

## Failure behavior and timeout policy {#failure-behavior}

- Invalid local inputs fail with `invalid_input` and exit code `1` before sending any HTTP request.
- Any server check rejection or migration failure prints the error code and reason (formatted as `::error::[code] ...` on GitHub Actions) and exits `1`.
- Connect timeouts, total request timeouts, and unreachable hosts exit `1` with `code=network_error`. Because `POST /api/ci/.../execute` resolves `to: "latest"`, can run non-transactional or auto-commit DDL steps, writes audit logs, and triggers webhooks, the script never retries automatically. Check live environment state via read-only endpoints before re-running after a timeout.
- For the complete HTTP contract and error code reference, see [CI HTTP API](api.md#error-codes).
