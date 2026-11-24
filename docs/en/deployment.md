# Deployment and configuration

This page documents how to deploy Dowel, build from source, configure all 27 server environment variables, run stateless multi-replica high availability on external PostgreSQL, set up a reverse proxy, and enforce database and SQLite connection boundaries.

## Deployment methods {#deployment-modes}

### Docker Compose {#docker-compose}

```sh
docker compose up -d
```

The root `Dockerfile` packages the HTTP API, WebSocket server, and web UI static assets into a single container on port `4600`.

- By default, the container stores its SQLite platform database in the `dowel-data` volume with `DOWEL_DB=/data/dowel.db`.
- Before deploying, replace `DOWEL_SECRET` in `docker-compose.yml` with a random string of at least 16 characters.
- For multi-replica high availability or an external platform database, set `DOWEL_DB` to a `postgres://` connection string.

### Build and run from source {#build-from-source}

The root `.tool-versions` file pins `node 26.13.0` and `pnpm 12.21.0`, which `mise` installs automatically.

```sh
pnpm install
pnpm build        # builds packages/* and apps/server with tsdown (ESM + .d.ts), builds apps/web/dist with Vite
pnpm start        # starts the compiled server at http://localhost:4600
```

Local development and quality check commands:

```sh
pnpm dev          # starts the server on port 4600 (--conditions=@dowel/source) and Vite dev server on port 5173
pnpm check        # runs pnpm lint (Oxlint --type-aware --deny-warnings && oxfmt --check), tsc --noEmit, and vitest run
```

During `pnpm dev` and `pnpm test`, internal workspace packages resolve TypeScript sources directly through the `@dowel/source` conditional export without running `pnpm build`. Both `pnpm start` and the Docker image execute the compiled `dist` output without source files.

## Server environment variables {#server-env-vars}

| Variable                          | Default                             | Description                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                            | `4600`                              | Listening port shared by the HTTP API, WebSocket server, and web UI                                                                                                                                                                                                                                 |
| `DOWEL_DB`                        | `./data/dowel.db`                   | Platform database path or URL. A file path enables SQLite (parent directories are created automatically; Docker defaults to `/data/dowel.db`). `postgres://` or `postgresql://` connects to PostgreSQL. `:memory:` uses memory only                                                                 |
| `DOWEL_WEB`                       | `apps/web/dist`                     | Directory containing compiled frontend static assets                                                                                                                                                                                                                                                |
| `DOWEL_SECRET`                    | None                                | Encryption key for target database URLs, OIDC `client_secret`, SMTP passwords, and webhook URLs or secrets (minimum 16 characters). Saving environments, secrets, or SMTP settings with a password fails when unset                                                                                 |
| `DOWEL_TRUST_PROXY`               | None                                | Set to `1` or `true` behind a trusted reverse proxy to read the last entry of `X-Forwarded-For`, plus `X-Forwarded-Proto` and `X-Forwarded-Host`. Ignored otherwise to prevent client IP or scheme spoofing                                                                                         |
| `DOWEL_PUBLIC_URL`                | None                                | External base URL such as `https://dowel.example.com`. Used for CSRF Origin validation, OIDC callback URLs, invite and reset email links, and webhook detail links                                                                                                                                  |
| `DOWEL_SQLITE_ROOTS`              | None                                | Colon-separated list of allowed absolute directories for local SQLite target databases, such as `/var/lib/app-dbs:/srv/sqlite`. Direct local SQLite target connections are disabled when unset                                                                                                      |
| `DOWEL_ADMIN_USERNAME`            | `admin`                             | Bootstrap username for the first instance admin when no users exist yet (display name matches username; must follow username rules)                                                                                                                                                                 |
| `DOWEL_ADMIN_PASSWORD_FILE`       | None                                | Path to a file holding the preset initial admin password (surrounding whitespace trimmed; file is never deleted or modified; disables forced password change on first sign-in; mutually exclusive with `DOWEL_ADMIN_PASSWORD`)                                                                      |
| `DOWEL_ADMIN_PASSWORD`            | None                                | Preset initial admin password supplied by environment variable (disables forced password change on first sign-in; setting both this and `DOWEL_ADMIN_PASSWORD_FILE` causes startup to fail)                                                                                                         |
| `DOWEL_INITIAL_PASSWORD_FILE`     | `<data dir>/initial-admin-password` | Path where Dowel writes the generated random temporary password with mode `0600` on first startup when neither `DOWEL_ADMIN_PASSWORD_FILE` nor `DOWEL_ADMIN_PASSWORD` is set; removed automatically after `admin` changes or resets their password (`./data/initial-admin-password` for `:memory:`) |
| `DOWEL_ALLOW_PASSWORD_LOGIN`      | None                                | Set to `1` or `true` to force password login on. Acts as an emergency recovery backstop when password login is disabled in instance settings                                                                                                                                                        |
| `DOWEL_DRIFT_INTERVAL_MINUTES`    | `60`                                | Periodic drift check interval in minutes. Set to `0` to disable scheduled checks                                                                                                                                                                                                                    |
| `DOWEL_LOGIN_LIMIT`               | `10`                                | Failed login limit per IP and username within the window                                                                                                                                                                                                                                            |
| `DOWEL_LOGIN_IP_LIMIT`            | `30`                                | Total failed login limit per IP within the window (increase behind shared corporate NATs)                                                                                                                                                                                                           |
| `DOWEL_LOGIN_WINDOW_MS`           | `600000`                            | Failed login rate-limit window in milliseconds (default 10 minutes)                                                                                                                                                                                                                                 |
| `DOWEL_CONNECTION_LIMIT`          | `10`                                | Database probe limit per user for connection tests, takeover scans, drift checks, and schema pulls                                                                                                                                                                                                  |
| `DOWEL_CONNECTION_WINDOW_MS`      | `60000`                             | Database probe rate-limit window in milliseconds (default 1 minute)                                                                                                                                                                                                                                 |
| `DOWEL_TOKEN_FAIL_LIMIT`          | `20`                                | Failed CI token authentication attempts per IP within the window (missing or malformed headers do not consume quota, and hitting the limit still permits valid active tokens from the same IP)                                                                                                      |
| `DOWEL_TOKEN_FAIL_WINDOW_MS`      | `600000`                            | CI token authentication failure window in milliseconds (default 10 minutes)                                                                                                                                                                                                                         |
| `DOWEL_TOKEN_RATE_LIMIT`          | `120`                               | Request limit per authenticated CI token within the window                                                                                                                                                                                                                                          |
| `DOWEL_TOKEN_RATE_WINDOW_MS`      | `60000`                             | CI token request rate-limit window in milliseconds (default 1 minute)                                                                                                                                                                                                                               |
| `DOWEL_MCP_FAIL_LIMIT`            | `20`                                | Failed MCP token authentication attempts per IP within the window (missing or malformed headers do not consume quota, and hitting the limit still permits valid active tokens from the same IP)                                                                                                     |
| `DOWEL_MCP_FAIL_WINDOW_MS`        | `600000`                            | MCP token authentication failure window in milliseconds (default 10 minutes)                                                                                                                                                                                                                        |
| `DOWEL_MCP_RATE_LIMIT`            | `120`                               | Request limit per MCP token within the window                                                                                                                                                                                                                                                       |
| `DOWEL_MCP_RATE_WINDOW_MS`        | `60000`                             | MCP token request rate-limit window in milliseconds (default 1 minute)                                                                                                                                                                                                                              |
| `DOWEL_FORGOT_PASSWORD_LIMIT`     | `3`                                 | Forgot-password requests allowed per IP + email within the window                                                                                                                                                                                                                                   |
| `DOWEL_FORGOT_PASSWORD_IP_LIMIT`  | `10`                                | Total forgot-password requests allowed per IP within the window                                                                                                                                                                                                                                     |
| `DOWEL_FORGOT_PASSWORD_WINDOW_MS` | `900000`                            | Forgot-password rate-limit window in milliseconds (default 15 minutes)                                                                                                                                                                                                                              |
| `DOWEL_EMAIL_TEST_LIMIT`          | `5`                                 | Test-email requests allowed per instance admin within the window                                                                                                                                                                                                                                    |
| `DOWEL_EMAIL_TEST_WINDOW_MS`      | `60000`                             | Admin test-email rate-limit window in milliseconds (default 1 minute)                                                                                                                                                                                                                               |

> The 14 rate-limit variables (`DOWEL_*_LIMIT` and `DOWEL_*_WINDOW_MS`) accept positive integers up to `2147483647`. Invalid values fall back to defaults. Rate limiters store counters in process memory per replica, so cluster-wide capacity in multi-replica HA deployments is approximately the configured limit multiplied by the number of replicas.

## Multi-replica high availability {#ha}

Set `DOWEL_DB` to an external `postgres://` connection string and configure the same `DOWEL_SECRET` on every replica to run multiple stateless Dowel instances in active-active mode without Redis.

- **Cold-start migrations and initial admin bootstrap.** When replicas start simultaneously, platform schema migrations and first-boot admin creation (using `DOWEL_ADMIN_PASSWORD_FILE` or `DOWEL_ADMIN_PASSWORD`, or generating the `0600` `initial-admin-password` file) synchronize through platform PostgreSQL advisory locks so the admin account is created once across the cluster.
- **Stateless load balancing.** A round-robin load balancer can distribute HTTP, SSE, and collaboration WebSocket connections across replicas without sticky sessions as long as it forwards WebSocket upgrades.
- **Cross-replica synchronization.**
  - Canvas edits persist serially through platform PostgreSQL branch row locks, and `LISTEN/NOTIFY` broadcasts lightweight notifications for sequence updates, large layout refreshes, disabled user disconnects, role changes, inbox unread updates, and shadow cache invalidation.
  - When a replica reconnects after losing the notification channel, rooms and clients catch up by sequence number.
- **Distributed jobs and leases.**
  - Group webhook delivery jobs persist in `webhook_jobs` and are claimed with `FOR UPDATE SKIP LOCKED` and leases, so restarts or replica failures drop no messages.
  - Running execution requests record a replica lease and are marked interrupted by a surviving replica only after that replica's heartbeat lease expires.
  - Periodic drift checks, request expiration sweeps, and derived refreshes take distributed task locks. Environment execution locks combine in-process mutexes with platform PostgreSQL advisory locks.
- **Graceful shutdown draining.** Upon receiving `SIGINT` or `SIGTERM`, the server stops accepting new requests, closes active SSE and WebSocket streams, waits for in-flight executions, derived refreshes, and locks to drain, and then closes queues, rooms, shadow pools, the event bus, lease heartbeats, and the platform database pool in order.

> Single-node SQLite platform mode (`DOWEL_DB=./data/dowel.db`) supports only one process and one replica.

## Reverse proxy configuration {#reverse-proxy}

When running Dowel behind Nginx, Caddy, Traefik, or a cloud load balancer, configure both of the following items:

1. **Environment variables.** Set `DOWEL_TRUST_PROXY=1` and `DOWEL_PUBLIC_URL=https://your-domain.example`. The server reads the client IP from the last address in `X-Forwarded-For` and uses `DOWEL_PUBLIC_URL` for CSRF Origin checks and OIDC callback URLs.
2. **WebSocket and SSE forwarding.** Configure your proxy to pass `Upgrade` and `Connection` headers with long connection timeouts, and disable response buffering for SSE alongside the server `X-Accel-Buffering: no` header. This keeps the collaboration WebSocket at `/api/projects/:pid/sync` and the inbox SSE stream at `/api/me/inbox/stream` responsive. Forward `X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Forwarded-For` when the server must inspect the public request origin.

## Database connection security boundaries {#connection-security}

### Target TCP allowlist {#connection-allowlist}

The server connects to databases on behalf of signed-in users during connection checks, environment creation, imports, verification, and execution. Instance admins can restrict reachable TCP hosts with `connection_allowlist` on the Instance settings page under Admin.

- Enter one rule per line or comma-separated list. Supported forms are CIDR ranges (such as `10.0.0.0/8` or `2001:db8::/32`), single IP addresses, or hostnames (such as `db.internal`).
- Dowel resolves hostnames to IP addresses before comparing against the list. Include `localhost`, `127.0.0.1`, or `::1` explicitly if local connections are needed, or allow `127.0.0.0/8` and `::1/128`. Hostnames that fail DNS resolution are rejected.
- Leaving `connection_allowlist` blank disables filtering (the self-hosted default). When populated, rejected hosts return HTTP `422` during connection tests and environment updates.
- To prevent allowlist bypasses, Dowel enforces standard TCP authority URLs:
  - PostgreSQL rejects `?host=`, `?hostaddr=`, and unix domain socket paths such as `/var/run/postgresql`. Multi-host connection strings check every listed host. For managed databases and minimal shadow privileges, see [Managed databases and restricted privileges](modeling.md#managed-shadow-db).
  - MySQL rejects `?socketPath=` and unix domain sockets.
  - SQL Server accepts standard `host[:port]` and `host\instance` named instance targets and checks the host portion.

### Local SQLite target path allowlist {#sqlite-roots}

Local SQLite target databases read from the server filesystem instead of TCP sockets, so Dowel isolates them with `DOWEL_SQLITE_ROOTS`.

- Connection strings must use `sqlite:///absolute/path`. Memory URLs (`:memory:`), query parameters, URL fragments, `..` segments, and null bytes are rejected.
- When `DOWEL_SQLITE_ROOTS` is unset, direct connections to local SQLite target files are disabled. Built-in `:memory:` shadow databases remain available for modeling, SQL import, and verification.
- Set `DOWEL_SQLITE_ROOTS` to colon-separated absolute directory paths such as `/srv/app-dbs:/data/targets`. Before opening a file, the server resolves symlinks along every path segment, including parent directories for files not yet created, and verifies that the resolved path falls inside an allowed root.
- Dowel always rejects connections pointing to the platform database `DOWEL_DB` or its `-wal`, `-shm`, and `-journal` sidecar files.
