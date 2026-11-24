# AI assistants (MCP) {#mcp}

Dowel includes a built-in [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server, so AI coding assistants such as Claude Code, Cursor, or VS Code can read your models, preview migrations, verify them in the shadow database, and edit the working copy **as you**, with the same conflict rules and audit trail as editing on the canvas.

The server lives on the same port as the web app, at `POST /api/mcp` (stateless Streamable HTTP). It works behind a load balancer with several replicas without sticky sessions.

---

## 1. What AI can and can't do {#boundaries}

| AI can                                                                                      | AI can't                                                                                    |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| List projects, read the model, tables, DDL, the version chain, and migration previews       | Publish versions                                                                            |
| Read environment status and drift **from the platform cache** (with the time it was cached) | Connect to an environment's target database (no live status, history, or drift checks)      |
| Verify a migration in the shadow database (`verify` permission)                             | Execute, roll back, mark as applied, write a baseline, submit or approve execution requests |
| Edit the working copy with an atomic batch of operations (`write` permission)               | Change connection strings, execution policies, tokens, or import a whole schema             |

Publishing and executing always stay with people in the Dowel UI, through your execution policies and approvals.

Edits made by AI go through the same sync layer as the canvas: if an object the AI read was changed or deleted by someone else afterwards, the whole batch is rejected with `conflict` and nothing is applied. Accepted edits appear live for everyone who has the model open, show up in **canvas history** under your name with an `MCP` mark, and can be restored like any other change.

## 2. Create an MCP token {#create-token}

MCP tokens belong to **you**, not to a project:

1. Open **Account settings → MCP access** and select **New MCP token**.
2. Choose the permissions:
   - **Read** — always included.
   - **Verify in shadow database** — run migrations in the shadow database and compare the result.
   - **Edit working copy** — requires the project editor role or above on that project.
3. Choose the projects: all projects you can access, or only selected projects (up to 50).
4. Choose when it expires (7 days to 1 year; default 30 days). Tokens always expire.
5. Copy the token or a ready-made client configuration. **The token is shown only once.**

The effective permission of every request is the intersection of your **current** project role, the token's permissions, and its project list. If you lose access to a project or your role is lowered, the token loses it immediately too.

You can have up to 20 active MCP tokens. Revoke a token in the same page; it stops working immediately.

## 3. Configure your client {#clients}

Replace `https://dowel.example.com` with your Dowel address and `dwm_…` with your token.

**Claude Code**

```bash
claude mcp add --transport http --scope user dowel https://dowel.example.com/api/mcp \
  --header "Authorization: Bearer dwm_…"
```

**Cursor** (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "dowel": {
      "url": "https://dowel.example.com/api/mcp",
      "headers": { "Authorization": "Bearer dwm_…" }
    }
  }
}
```

**VS Code** (run **MCP: Open User Configuration**)

```json
{
  "servers": {
    "dowel": {
      "type": "http",
      "url": "https://dowel.example.com/api/mcp",
      "headers": { "Authorization": "Bearer dwm_…" }
    }
  }
}
```

!!! warning "Keep tokens out of repositories"
Put the configuration in your **user-level** settings. Don't commit a file containing an MCP token to a project's `.cursor/mcp.json` or `.vscode/mcp.json`.

Any other MCP client that supports the **Streamable HTTP** transport works with the URL `/api/mcp` and the header `Authorization: Bearer dwm_…`.

## 4. Tools {#tools}

Tools take a `project` argument: a project ID or its `owner/project` path. Your client only sees the tools allowed by the token's permissions.

| Tool                | Permission | What it does                                                                                                                                                     |
| ------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects`     | read       | Projects you can access (within the token's project list)                                                                                                        |
| `get_model`         | read       | The working copy: summary or full objects with their versions, and the current `seq`                                                                             |
| `get_table`         | read       | One table with columns, keys, constraints, indexes and partitions                                                                                                |
| `get_ddl`           | read       | `CREATE` DDL for the working copy or a version                                                                                                                   |
| `list_versions`     | read       | The version chain                                                                                                                                                |
| `get_version`       | read       | One version with its frozen up/down migration                                                                                                                    |
| `preview_migration` | read       | Up/down SQL between two versions (default: latest version → working copy)                                                                                        |
| `list_environments` | read       | Environments with cached current version and drift status, and when they were cached                                                                             |
| `list_mutators`     | read       | The edit operations and the JSON Schema of their arguments                                                                                                       |
| `verify_migration`  | verify     | Runs the migration in the shadow database and compares the result (same as **Verify in shadow database** in the UI)                                              |
| `apply_changes`     | write      | Applies a batch of edit operations atomically; arguments: `baseSeq` (from `get_model`), `ops` (up to 100), `dryRun`; use `"$ref:<alias>"` for IDs of new objects |

A typical session: `get_model` (note `seq`) → `apply_changes` with that `baseSeq` → `preview_migration` → `verify_migration` → a person reviews and publishes in Dowel.

Read-only resources are also available: `dowel://projects`, `dowel://projects/{owner}/{project}/model`, `…/ddl`, `…/versions`, `…/environments`, and `dowel://mutators`.

## 5. Security and administration {#security}

- **Isolation.** MCP tokens (`dwm_…`) only work on `/api/mcp`, and `/api/mcp` only accepts MCP tokens: session cookies and CI tokens are rejected there, and an MCP token on any other endpoint (including `/api/ci/...`) returns `403 forbidden`.
- **Audit.** Edits (`model.mutate`) and shadow verifications (`model.verify`) are recorded under your user with an `MCP` mark and the token prefix. Creating and revoking tokens is audited too.
- **Automatic revocation.** All of a user's MCP tokens are revoked permanently when the user is disabled, when an admin resets their password, or when a password reset link is used (re-enabling the user doesn't restore them). Changing your own password doesn't revoke them. While a user must change a temporary password, their tokens get `403 password_change_required`.
- **Instance admins** can view and revoke any user's MCP tokens on **Admin → Users**, and turn off **Allow MCP access** in **Admin → Settings**: no one can create tokens and requests with existing tokens get `403 mcp_disabled` until it's turned back on.
- **Rate limits** (per replica; multi-replica deployments get roughly the configured value × replicas):
  - Failed authentication per client IP: `DOWEL_MCP_FAIL_LIMIT` (default 20) per `DOWEL_MCP_FAIL_WINDOW_MS` (default 10 minutes). Missing or malformed headers don't count, and an active valid token keeps working from a blocked IP.
  - Requests per token: `DOWEL_MCP_RATE_LIMIT` (default 120) per `DOWEL_MCP_RATE_WINDOW_MS` (default 1 minute).
  - `verify_migration` also counts against the per-user connection limit (`DOWEL_CONNECTION_LIMIT`).

### HTTP errors {#errors}

Authentication errors are returned as JSON `{ "error": "…", "code": "…" }` before any MCP message is processed:

| Status | `code`                                                                              |
| ------ | ----------------------------------------------------------------------------------- |
| 401    | `token_missing`, `token_invalid`, `token_expired`, `token_revoked`, `user_disabled` |
| 403    | `password_change_required`, `mcp_disabled`, `forbidden`                             |
| 429    | `rate_limited` (with `Retry-After`)                                                 |

Browser-based clients sending a cross-origin `Origin` header are rejected before authentication by the origin guard with HTTP `403` and a generic `{ "error": "…" }` JSON body (without a `code` field, rather than `McpHttpErrorBody`).

Tool failures are returned inside MCP as `isError: true` with a `code` such as `project_not_found`, `forbidden`, `scope_required`, `conflict`, `invalid`, `base_seq_ahead`, or `shadow_unavailable`.
