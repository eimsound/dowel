# AI assistants (MCP) {#mcp}

Dowel includes a built-in [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server, so AI coding assistants such as Claude Code, Cursor, or VS Code can read your models, preview migrations, verify them in the shadow database, and edit the working copy **as you**, with the same conflict rules and audit trail as editing on the canvas.

The server lives on the same port as the web app, at `POST /api/mcp` (stateless Streamable HTTP). It works behind a load balancer with several replicas without sticky sessions.

---

## 1. What AI can and can't do {#boundaries}

| AI can                                                                                                                     | AI can't                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| List projects, read the model, tables, objects such as views and functions, DDL, the version chain, and migration previews | Publish versions                                                                            |
| Read environment status and drift **from the platform cache** (with the time it was cached)                                | Connect to an environment's target database (no live status, history, or drift checks)      |
| Verify a migration in the shadow database (`verify` permission)                                                            | Execute, roll back, mark as applied, write a baseline, submit or approve execution requests |
| Edit the working copy with an atomic batch of operations (`write` permission)                                              | Change connection strings, execution policies, tokens, or import a whole schema             |
| Adjust canvas sections incrementally (`write` permission)                                                                  | Write table positions on the canvas (auto-layout and dragging decide them)                  |
| Read canvas history and the diff of each change                                                                            | Restore canvas history (only people can restore, in the UI)                                 |

Publishing and executing always stay with people in the Dowel UI, through your execution policies and approvals. Restoring canvas history is also done only by people in the UI.

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

| Tool                | Permission | What it does                                                                                                                                                                                                                                               |
| ------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects`     | read       | Projects you can access (within the token's project list)                                                                                                                                                                                                  |
| `get_model`         | read       | The working copy: summary or full objects with their versions, and the current `seq`; plus canvas sections, dialect capabilities, and the derived lowest target version; can filter by schema, section, or keyword and include diagnostics (see below)     |
| `get_table`         | read       | One table with columns, keys, constraints, indexes and partitions, plus its section (`sectionId`), the triggers, policies, and exclusion constraints on it (`opaques`), and the views, functions, and other objects that depend on it (`dependentOpaques`) |
| `get_objects`       | read       | Full definitions (with DDL and dependencies) of enums, sequences, extensions, and opaque objects such as views, functions, and triggers; look up by ID, kind, schema, or keyword; see [Object context](#objects) below                                     |
| `get_ddl`           | read       | `CREATE` DDL for the working copy or a version                                                                                                                                                                                                             |
| `list_versions`     | read       | The version chain                                                                                                                                                                                                                                          |
| `get_version`       | read       | One version with its frozen up/down migration                                                                                                                                                                                                              |
| `preview_migration` | read       | Up/down SQL between two versions (default: latest version → working copy)                                                                                                                                                                                  |
| `list_environments` | read       | Environments with cached current version and drift status, and when they were cached                                                                                                                                                                       |
| `list_history`      | read       | Canvas history (grouped into editing sessions by default); see [Canvas history](#history) below                                                                                                                                                            |
| `get_history_diff`  | read       | The net change and migration diff of one history entry or a whole editing session; see [Canvas history](#history) below                                                                                                                                    |
| `list_mutators`     | read       | The edit operations (the `defineTable` / `alterColumn` macros first) with a description and the JSON Schema of their arguments                                                                                                                             |
| `verify_migration`  | verify     | Runs the migration in the shadow database and compares the result (same as **Verify in shadow database** in the UI)                                                                                                                                        |
| `apply_changes`     | write      | Applies a batch of edit operations atomically; arguments: `baseSeq` (from `get_model`), `ops` (up to 100), optional `summary` (intent, up to 500 characters), `dryRun`; use `"$ref:<alias>"` for IDs of new objects                                        |
| `manage_sections`   | write      | Adjusts canvas sections incrementally; arguments: `actions` (up to 50), `dryRun`; see [Canvas sections](#sections) below                                                                                                                                   |

A typical session: `get_model` (note `seq`) → `apply_changes` with that `baseSeq` → `preview_migration` → `verify_migration` → a person reviews and publishes in Dowel.

How `apply_changes` behaves:

- **One call = one commit.** The whole batch is written to the working copy as a single commit (one new `seq`) and shows up as one **Batch edit** entry in **Canvas history**, with your `summary`. To undo the whole batch, restore the entry just before it. `opCount` in the response is the number of underlying operations after expansion (up to 500).
- **Conflicts and errors.** If any operation is invalid, or an object it relies on was changed by someone else since `baseSeq`, nothing is committed, and `index` in the error points at the earliest failing operation. Errors in a macro also carry `path` (where inside the macro) and `mutator` (the underlying operation it expanded to); see below.
- **No net change** (for example, creating and then dropping a table, or an `alterColumn` whose values already match) returns `noop: true` without a commit or an audit entry.
- **Existing objects by ID only.** Changing or dropping an existing object only accepts its object ID (the `id` from `get_model` / `get_table`) or the `"$ref:<alias>"` of an object created earlier in the same call — never a name. Renames therefore never break references, and concurrent edits are detected precisely.
- **Post-write checks.** Every response, including `dryRun: true`, carries `diagnostics`: all model validation errors, plus static compatibility `errors` / `warnings` for the lowest environment version in the project (read from the platform cache; the target databases are never contacted). They never block the edit, but publishing a version is refused while there are validation errors (`blocksPublish: true`).

Extra context in `get_model` (in `summary`, `full`, and the truncated result above 200 tables):

- `capabilities`: what the project's dialect supports (multiple schemas, enums, sequences, partitioning, transactional DDL, identifier length limit, and so on).
- `target`: the lowest target version derived from the **cached** version numbers of the project's environments, for example `{ "label": "PG 15", "features": { "virtualGenerated": false, … }, "source": "platform_cache", "environments": { "total": 3, "withCachedVersion": 2 } }`. It matches `diagnostics.target` from `apply_changes`. `label` and `features` are `null` when there are no environments, no version has been cached yet, or the project uses SQLite. Only the platform database is read; target databases are never contacted.
- `sections`: canvas sections. Summaries list `{ id, name, color, tableCount }` and every table also has a `sectionId` (`null` when it isn't in a section; partitions follow their parent, even when the parent is in another schema). With `detail: "full"` you get `{ id, name, color, tables }`, and `objects` still contains only model objects. Deleted tables never appear in a section.

`get_model` arguments (all optional; when several are given they are combined, and `counts` reflects the filtered result):

| Argument      | Description                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`      | Only one schema (ID or name). Triggers, policies, and exclusion constraints follow the schema of their table                                                                                                                                                                                                             |
| `detail`      | `summary` (default) or `full`. Without `schema`, `full` returns only summaries with `truncated: true` when more than 200 tables remain after filtering                                                                                                                                                                   |
| `q`           | Keyword (case-insensitive): matches table names, schema names, table comments, and column names (matching columns are listed in `matchedColumns`, up to 10), plus names and comments of enums, sequences, extensions, views, and other objects. When a partitioned parent table matches, all its partitions are included |
| `section`     | A section ID, `$none` (tables in no section), or a section name (case-insensitive and must be unique; duplicates return `invalid_arguments` listing the candidate IDs). Returns only those tables and the objects attached to them; with `full`, also the enums and sequences their columns reference                    |
| `diagnostics` | `true` adds the same `diagnostics` as `apply_changes` (platform cache only; target databases are never contacted)                                                                                                                                                                                                        |

When `q` or `section` is given, the response includes `filter` (the effective `schema`, `section`, and `q`). In summaries, enums include `values`, sequences include `options` and `ownedBy`, extensions include their `schema`, and views, triggers, and other objects include `parentKind` (`schema` or `table`) and, for table-level objects, `tableId` / `table`.

### Object context {#objects}

`get_objects` reads objects other than tables: enums, sequences, extensions, and opaque objects (views, materialized views, functions, procedures, domains, types, aggregates, triggers, policies, and exclusion constraints).

- Look up by `ids` (up to 50; unknown IDs and IDs of tables, columns, or other objects are listed in `missing` — use `get_table` for tables), or filter with `kind` (`enum`, `sequence`, `extension`, `opaque`), `objType` (such as `view`, `function`, `trigger`), `schema`, and `q`. Give at least one of `ids`, `kind`, `objType`, or `q`.
- Results come in a fixed order; page with `limit` (up to 100, default 50) and `offset`. The response has `total` and `nextOffset`.
- Each object is its full definition plus `ver` and `schema`; opaque objects also have `parentKind`, `tableId`, `table`, and resolved dependencies `deps: [{ id, kind, name }]`.
- DDL on one page is capped at 200,000 characters in total. Objects after the cap omit `ddl` and are marked `ddlOmitted: true`, and the response has `truncated: true`; read them by `ids` when you need them.

### Canvas sections {#sections}

Sections belong to the canvas layout only: they never enter the model, SQL, migrations, or versions, and don't use a canvas history `seq`. `manage_sections` applies incremental actions on the server against the **latest** sections, so it never overwrites sections someone else just created. Results are pushed live to everyone with the model open.

| Action          | Arguments                                                     | Notes                                                                                                                 |
| --------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `create`        | `name`, optional `ref`, `color` (`peer-1`…`peer-8`), `tables` | Creates a section; the server generates its ID and `refs` returns `{ alias: section ID }`; colors rotate when omitted |
| `rename`        | `section`, `name`                                             | Renames it (1–64 characters)                                                                                          |
| `recolor`       | `section`, `color`                                            | Changes its color                                                                                                     |
| `delete`        | `section`                                                     | Deletes the section; its tables become ungrouped                                                                      |
| `add_tables`    | `section`, `tables`                                           | Adds tables; a table that's in another section moves here (listed in `moved`)                                         |
| `remove_tables` | `section`, `tables`                                           | Removes tables; does nothing for tables that aren't in the section                                                    |

- `section` is a section ID, or `"$ref:<alias>"` for the `ref` of an earlier `create` in the same call. Sections are never guessed by name. Table IDs come from `get_model`; partitions can't be added on their own (they follow their parent).
- The actions in one call apply all together or not at all. Error codes are `section_not_found`, `table_not_found` (with `tableIds`), and `invalid`, and `index` points at the failing action. Coordinates (such as `x`, `y`, or `positions`) or any other unknown field return `invalid_arguments`.
- Up to 200 sections, and up to 500 tables per action. `noop: true` means nothing changed; `dryRun: true` only previews. Neither writes anything or creates an audit entry.
- The response is `{ dryRun, sectionsVer, sections, refs, moved }`. If someone edits sections on the canvas at the same moment, Dowel replays your actions on top of their latest result; if that's impossible (for example, the target section was just deleted), the person's edit wins and the response includes `superseded: true`.

```json
{
  "project": "acme/orders",
  "actions": [
    { "action": "create", "ref": "billing", "name": "Billing", "tables": ["<table ID>"] },
    { "action": "add_tables", "section": "$ref:billing", "tables": ["<table ID>"] },
    { "action": "recolor", "section": "$ref:billing", "color": "peer-3" }
  ]
}
```

### Macros: `defineTable` and `alterColumn` {#macros}

Besides the underlying operations, `ops` accepts two macros. The server expands them into underlying operations while simulating the call; they can be mixed with underlying operations in the same call and share the same `$ref` aliases. The call still produces a single commit, and canvas history and the stored commit only contain the expanded underlying operations. At most 500 underlying operations are allowed after expansion (`opCount` in the response).

**`defineTable`** declares a whole table at once: columns (same fields as `addColumn`, plus `comment`; the array order is the column order), `primaryKey`, `uniques`, `checks`, `indexes`, `foreignKeys`, the table `comment` and `ext`, and optionally `partitionBy` / `partitions`. Constraints and indexes accept an explicit `name` and a `comment`. Every `id` is optional (generated automatically); use `"$ref:<alias>"` when you need to refer to the object later.

```json
{
  "name": "defineTable",
  "args": {
    "id": "$ref:orders",
    "schema": "public",
    "name": "orders",
    "comment": "Orders",
    "columns": [
      { "id": "$ref:orders.id", "name": "id", "type": "bigint", "identity": { "always": true } },
      { "name": "user_id", "type": "bigint", "notNull": true },
      { "name": "status", "typeRef": "public.order_status" },
      { "name": "parent_id", "type": "bigint" }
    ],
    "primaryKey": { "columns": ["id"] },
    "checks": [{ "name": "ck_orders_user", "expr": "user_id > 0" }],
    "indexes": [{ "elements": [{ "column": "user_id" }] }],
    "foreignKeys": [
      { "columns": ["user_id"], "refTable": "public.users", "refColumns": ["id"] },
      { "columns": ["parent_id"], "refTable": "orders", "refColumns": ["id"], "onDelete": "cascade" }
    ]
  }
}
```

How names are resolved:

- **Columns of the new table**: constraints, indexes and partition keys can refer to the new columns by name, column ID or `$ref` (case follows the dialect: SQLite, MySQL and SQL Server are case-insensitive).
- **References made while creating**: `schema` (defaults to the dialect's default schema such as `public` / `dbo`, or the only schema in the model), a column's `typeRef` (PostgreSQL enum) and `default.nextval` (sequence), a foreign key's `refTable` / `refColumns`, and `partitions[].schema` accept an object ID, a `$ref`, a qualified name (`schema.name`) or a globally unique name. A foreign key can reference the table itself or a table created earlier in the same call.
- **References in `alterColumn`**: `typeRef` and `default.nextval` only reference an enum / sequence and follow the same rules (object ID, `$ref`, qualified name or globally unique name); the column being changed (`id`) still only accepts a column ID or `$ref`, never a name.
- A name that does not exist, or matches several objects (for example `users` in two schemas), is an error that lists the candidates; use a qualified name or the object ID instead.
- **Circular foreign keys** (A references B and B references A): create all the tables with `defineTable` first, then add the remaining foreign keys with `addForeignKey` at the end of the same call.

Auto-increment per dialect: PostgreSQL uses the column's `identity`; SQL Server uses `ext.mssql.identity` (`{ "seed": "1", "increment": "1" }`); MySQL uses `ext.mysql.autoIncrement`; SQLite uses an `INTEGER` single-column primary key with `ext.sqlite.autoincrement`. Using `identity`, `typeRef` or `partitionBy` on a dialect that does not support it is an error.

**`alterColumn`** patches an existing column declaratively. `id` must be the ID of an existing column, or the `$ref` of a column created earlier in the same call — **never a column name**. Fields: `name`, `type` / `typeRef`, `notNull`, `default`, `identity`, `ext` (replaced as a whole; `null` clears it) and `comment`. Leave a field out to keep it; set it to `null` to clear it.

`ext` is replaced as a whole: what you pass becomes the complete column ext, and `null` clears it. One exception on SQL Server: when the column still has a default after this `alterColumn` (judged after any `default` change in the same op; `default: null` drops the name) and its constraint uses an explicit name (`ext.mssql.defaultNameMode: "explicit"`), that name is kept automatically as long as `ext.mssql` does not set `defaultName` / `defaultNameMode`, so changing another option (such as `sparse`) does not rename it back to `DF_<table>_<column>`. Passing `ext: null`, or setting those fields, does what you ask.

```json
{ "name": "alterColumn", "args": { "id": "0192…", "type": "bigint", "identity": { "always": false } } }
```

The server expands it in a fixed, safe order: drop identity → clear the default → rename → change the type → change NOT NULL → set the default → set identity → change `ext` → change the comment, skipping any step whose value already matches. Turning a column with a default into an identity column, or the other way round, therefore takes a single op. Setting both `identity` and `default`, or `identity` with `notNull: false`, is an error.

**Error locations.** When a macro fails, the error carries `path` (where inside the macro) and `mutator` (the underlying operation that failed; absent when the arguments themselves are invalid) in addition to `index`, and the message starts with `ops[<index>] <path>`:

```json
{
  "code": "invalid",
  "index": 0,
  "path": "defineTable(orders).foreignKeys[0]",
  "mutator": "addForeignKey",
  "message": "ops[0] defineTable(orders).foreignKeys[0] addForeignKey：两边列数必须相同",
  "currentSeq": 12
}
```

Read-only resources are also available: `dowel://projects`, `dowel://projects/{owner}/{project}/model`, `…/ddl`, `…/versions`, `…/environments`, and `dowel://mutators`.

### Canvas history (read-only) {#history}

AI can read the [canvas history](modeling.md#canvas-history) but can't restore it: restoring is confirmed only by people in the canvas **History** panel. These two tools only read the history stored in the platform database. They don't normalize the model, never connect to shadow or target databases, and aren't audited.

- `list_history` lists history from newest to oldest. By default (`grouped: true`) it groups consecutive regular edits by the same person into editing sessions, just like the UI (`seqFrom`…`seq`, `stepCount`, `ops`); `grouped: false` lists single steps. Page with `beforeSeq` (the previous page's `nextBeforeSeq`); `limit` is up to 50 (default 20). Each entry has the user, time, an object summary, and the published `version`; MCP edits have `via: "mcp"` and their intent `opSummary` (in the list, longer than 200 characters is truncated and marked `opSummaryTruncated`).
- `get_history_diff` shows one entry (`seq`) or a whole editing session (`from` = the session's `seqFrom`, `seq` = its last step, up to 50 steps). It returns `entry` (with the full `opSummary`), `objects` (added, removed, and modified objects, up to 200), and `diff` (migration-style steps, the first `maxItems`, default 30 and up to 100; SQL longer than 2,000 characters is truncated and marked `sqlTruncated`, and `includeSql: false` leaves SQL out). `includeSteps: true` also returns every step in the session. It never returns the full model or a diff against the current canvas (use `get_model` / `preview_migration` for that). A `seq` beyond the current one returns `history_not_found` (with `currentSeq`); an invalid range returns `invalid_arguments`.

### Prompts {#prompts}

Dowel also offers MCP prompts (clients usually show them as slash commands or templates) that guide the AI through the recommended tool sequence:

| Prompt                       | Permission | Arguments                                     | What it does                                                                                                                                          |
| ---------------------------- | ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review_unpublished_changes` | read       | `project`                                     | Reviews changes that aren't published yet: migration SQL risks, potentially lossy operations, and the history behind them                             |
| `review_canvas_history`      | read       | `project`, optional `beforeSeq`, `limit`      | Browses the grouped canvas history and summarizes the net change of each editing session                                                              |
| `design_tables`              | write      | `project`, `requirements`, optional `section` | Designs new tables from requirements and creates them in one atomic `apply_changes` call (`defineTable` / `addForeignKey`), then checks `diagnostics` |
| `refactor_column`            | write      | `project`, `table`, `column`, `change`        | Checks dependencies first, then renames or retypes the column safely with `alterColumn` by column ID                                                  |

- Your client only sees the prompts allowed by the token's permissions. Prompts suggest `verify_migration` only when the token has the `verify` permission.
- Prompts are guidance text only: generating one never looks up the project (an unknown project doesn't cause an error), and project permissions are checked when the AI then calls tools. Every prompt reminds the AI that publishing versions, connecting to or running migrations on target databases, and restoring canvas history are done only by people in Dowel.

## 5. Security and administration {#security}

- **Isolation.** MCP tokens (`dwm_…`) only work on `/api/mcp`, and `/api/mcp` only accepts MCP tokens: session cookies and CI tokens are rejected there, and an MCP token on any other endpoint (including `/api/ci/...`) returns `403 forbidden`.
- **Audit.** Edits (`model.mutate`), canvas section changes (`sections.update`), and shadow verifications (`model.verify`) are recorded under your user with an `MCP` mark and the token prefix. Creating and revoking tokens is audited too.
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

Tool failures are returned inside MCP as `isError: true` with a `code` such as `project_not_found`, `forbidden`, `scope_required`, `invalid_arguments`, `conflict`, `invalid`, `base_seq_ahead`, `table_not_found`, `section_not_found`, `history_not_found`, `shadow_unavailable`, or `shadow_config_changed` (the shadow database configuration changed mid-verification; safe to retry).
