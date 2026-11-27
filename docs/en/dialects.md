# Dialects and version support

Each Dowel project binds to a single target database dialect at creation time. Modeling validation, migration planning, shadow database verification, measured risk analysis, managed execution, and drift checks all follow that dialect across the platform.

## Dialect capability matrix {#dialect-matrix}

| Feature or mechanism         | PostgreSQL                                             | SQLite                                                       | MySQL                                                  | SQL Server                                             |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------ |
| Supported versions           | 15, 16, 17, 18, 19                                     | Built-in Node 26 `node:sqlite`                               | 8.4 (LTS), 9.7 (Innovation)                            | 2019 (15), 2022 (16), 2025 (17)                        |
| Connection URL scheme        | `postgres://` or `postgresql://`                       | `sqlite:///absolute/path`                                    | `mysql://`                                             | `mssql://` or `sqlserver://`                           |
| Default logical schema       | `public`                                               | `main` (single schema)                                       | `default` (single schema)                              | `dbo`                                                  |
| Multiple schemas             | Yes                                                    | No                                                           | No                                                     | Yes                                                    |
| Standalone enums / sequences | Yes (enums and sequences)                              | No / no                                                      | No (column `enum(...)`) / no                           | No / yes                                               |
| Partitioned table editing    | Yes (`RANGE`, `LIST`, `HASH`)                          | No                                                           | No                                                     | No                                                     |
| Atomic DDL by default        | Yes (except `CONCURRENTLY` and similar statements)     | Yes (except foreign key pragma and `VACUUM`)                 | No (DDL auto-commits implicitly)                       | Yes (`SET XACT_ABORT ON`)                              |
| Shadow database source       | Dedicated URL or `{database}_dowel` on target instance | Built-in in-process `:memory:` (no environment setup needed) | Dedicated URL or `{database}_dowel` on target instance | Dedicated URL or `{database}_dowel` on target instance |
| Target history storage       | `dowel` schema (5 tables)                              | Same-database `dowel_` prefixed tables (5 tables)            | Same-database `dowel_` prefixed tables (5 tables)      | `[dowel]` schema (5 tables)                            |
| Identifier length limit      | 63 bytes                                               | 128 characters                                               | 64 characters                                          | 128 characters                                         |
| Lock / statement timeouts    | `lock_timeout` / `statement_timeout`                   | `PRAGMA busy_timeout` / none                                 | `lock_wait_timeout` / `max_execution_time`             | `SET LOCK_TIMEOUT` / driver request cancellation       |

## PostgreSQL 15 to 19 {#postgresql}

### Target version derivation and multi-version verification {#pg-versions}

When Dowel probes an environment, the server records `server_version_num` and the major version (`15` to `19`). The minimum major version across all known project environments becomes the project's target compatibility version.

- **Multi-version verification.** When a project has environments on different major versions, such as `dev` on PG 18 and `prod` on PG 15, Verify in shadow database groups environments by major version and runs verification against a representative shadow database in each group.
- **Lowest target version gate.** If no usable shadow database exists for the lowest target major version, such as PG 15 production without a dedicated shadow URL or same-instance permission, Dowel keeps per-group results visible, refuses to mark the version verified, and blocks execution.
- **Connection modes and managed databases.** PostgreSQL connections require direct endpoints or Session Mode (such as port `5432`) instead of transaction poolers like Supabase `6543` or Neon `-pooler`. See [Managed databases and restricted privileges](modeling.md#managed-shadow-db).

### PostgreSQL 15 to 19 capability and static checks {#pg-capabilities}

| Feature                                                 | Minimum version | Behavior below minimum target version                                   |
| ------------------------------------------------------- | --------------- | ----------------------------------------------------------------------- |
| Unique constraints or indexes with `NULLS NOT DISTINCT` | PostgreSQL 15+  | Rejected during static planning                                         |
| `IDENTITY` columns on partitioned tables                | PostgreSQL 17+  | Rejected during static planning; prompts to use an independent sequence |
| Exclusion constraints (`EXCLUDE`) on partitioned tables | PostgreSQL 17+  | Rejected during static planning                                         |
| Virtual generated columns (`VIRTUAL`)                   | PostgreSQL 18+  | Rejected during static planning; prompts to use `STORED`                |
| Explicitly named column `NOT NULL` constraints          | PostgreSQL 18+  | Rejected during static planning                                         |
| `NOT NULL NOT VALID` and partitioned `NOT VALID`        | PostgreSQL 18+  | Aligns constraint naming differences by version during verification     |
| Built-in `uuidv7()` function calls                      | PostgreSQL 18+  | Emits a compatibility warning without blocking user-defined `uuidv7()`  |
| `REPACK`                                                | PostgreSQL 19+  | Tagged under PG 19 capability rules                                     |

### serial shorthand {#pg-serial}

When a column type is entered as `serial`, `bigserial`, or `smallserial` (or `serial4`, `serial8`, `serial2`, case-insensitive; a double-quoted `"serial"` is treated as a custom type name and is not expanded), Dowel expands it on write into the structure PostgreSQL actually creates. The model never stores `serial`:

- An `integer`, `bigint`, or `smallint` column marked `NOT NULL`.
- A sequence owned by the column, named `{table}_{column}_seq` by default (truncated and suffixed on collisions the same way PostgreSQL does), renamed along with the table or column.
- A `nextval(...)` default that references that sequence.

Every write path, including the properties panel, MCP, and paste, follows this rule. Whenever a column is an integer type with a default that points to a sequence owned by that column, the properties panel shows its type as `serial (integer)`, `bigserial (bigint)`, or `smallserial (smallint)` (shortened to `serial`, `bigserial`, or `smallserial` in collapsed column rows), including columns imported from a database. The type suggestions include these three entries.

- **Switching between serial shorthands**, such as from `serial (integer)` to `bigserial (bigint)`, changes the column type and the owned sequence's type together without creating a new sequence.
- **Changing to any other type**, including re-entering the underlying `integer`, `bigint`, or `smallint`, changes only the column type. The default and sequence stay as they are, so auto-increment keeps working. Clear the default to disable auto-increment. Switching back to a serial shorthand after clearing the default reuses the sequence the column still owns.
- **Columns that cannot become serial directly.** Columns with another default, `IDENTITY`, or a generated expression must have the default cleared or `IDENTITY` removed first. serial cannot be used as an array element type.

### Non-transactional statements and resume {#pg-nontx}

Statements such as `CREATE/DROP INDEX CONCURRENTLY`, `VACUUM`, `REINDEX DATABASE/SYSTEM`, table-less `CLUSTER`, and `ALTER TYPE ... ADD VALUE` run outside transactions with per-step checkpoints. If `CREATE INDEX CONCURRENTLY` fails and leaves an `INVALID` index, Dowel drops that index cleanly before retrying. If `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY` times out on a lock in the `detach pending` state, retrying switches automatically to `FINALIZE`.

## SQLite {#sqlite}

### Connections and path allowlist {#sqlite-connection}

- Connection strings must use `sqlite:///absolute/path`. `:memory:`, query parameters, `..`, and null bytes are forbidden.
- **Disabled by default.** For filesystem isolation, adding or connecting to local SQLite target databases is blocked unless `DOWEL_SQLITE_ROOTS` is configured. When set to colon-separated directory paths, the server resolves symlinks along every segment before connecting and blocks paths pointing to the platform database `DOWEL_DB` or its sidecar files.
- **Zero-setup shadow database.** SQLite SQL import, expression normalization, and round-trip migration verification all run inside an isolated in-process `:memory:` shadow database in milliseconds.

### Dialect capabilities and 12-step table rebuilds {#sqlite-features}

- **Table and column options.** Supports `STRICT` tables (limiting column types to `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB`, and `ANY`, case-insensitive; aliases such as `BIGINT` or `BOOLEAN` and untyped columns are rejected, and so is turning on `STRICT` for a table that has them), `WITHOUT ROWID` tables (requiring a primary key without `AUTOINCREMENT`), and `AUTOINCREMENT` on a single-column `INTEGER` primary key.
- **Column types are kept as declared.** Types are only uppercased and have whitespace collapsed (a type name that is entirely quoted loses its quotes, matching what SQLite reports). Aliases are no longer rewritten: `bigint` is stored as `BIGINT`, `boolean` as `BOOLEAN`, and `varchar(255)` as `VARCHAR(255)`. Imports, table creation, and 12-step rebuilds all keep the declared type.
- **Rowid aliases.** Only a single-column primary key declared as `INTEGER` is a rowid alias, and only it can use `AUTOINCREMENT`. `INT PRIMARY KEY` and `BIGINT PRIMARY KEY` are not rowid aliases, and Dowel never turns them into `INTEGER` during a rebuild.
- **Untyped columns.** Non-`STRICT` tables allow a column without a declared type (an empty `type` in the model). Such a column has BLOB affinity and stores values as given. It is not the same as `ANY` (NUMERIC affinity in non-`STRICT` tables) or `TEXT`, and Dowel does not substitute either. Clear the type box in the Inspector to make a column untyped; over MCP, pass `type: ""` explicitly.
- **12-step table rebuilds.** When schema edits cannot run with native `ALTER TABLE`, such as reordering columns, changing column types or nullability, or modifying primary keys and constraints, the planner generates the official 12-step rebuild. It disables foreign keys outside the transaction (`PRAGMA foreign_keys = OFF`), opens a `BEGIN IMMEDIATE` transaction, creates `_dowel_tmp_*`, copies rows, drops the old table, renames and recreates indexes and triggers, runs `PRAGMA foreign_key_check`, commits, and always re-enables `PRAGMA foreign_keys = ON` in `finally`.
- **History storage and sandbox.** Migration history lives in `dowel_` prefixed tables in the target database (`sqlite_` and `dowel_` prefixes are reserved). Defensive mode and a database authorizer block `ATTACH`, `DETACH`, `VACUUM INTO`, and dangerous `PRAGMA` calls.

## MySQL 8.4 LTS and 9.7 Innovation {#mysql}

### Connections and same-instance shadow databases {#mysql-connection}

- Connection strings follow `mysql://user:password@host:3306/dbname`, require a database name, and reject `?socketPath=` or unix sockets.
- **TLS parameters.** Supports `ssl`, `ssl-mode`, and `sslmode` (`DISABLED`, `PREFERRED`, `REQUIRED`/`REQUIRE`, `VERIFY_CA`/`VERIFY-CA`, `VERIFY_IDENTITY`/`VERIFY-FULL`). Enabling TLS enforces strict certificate verification by default, or you can pass a JSON object to `ssl` for custom options.
- **Same-instance shadow databases.** By default, Dowel creates `{database}_dowel` on the target instance (truncated with an 8-character hash within 64 characters), writes the `__dowel_shadow_mark` sentinel table, and serializes access with `GET_LOCK` and `RELEASE_LOCK`. See [Managed databases and restricted privileges](modeling.md#managed-shadow-db) for pre-created shadow database SQL.

### Dialect capabilities and version checks {#mysql-features}

- **Table, column, and index options.** Supports table `engine`, `charset`, and `collation`; column `UNSIGNED`, `ZEROFILL`, `AUTO_INCREMENT` (at most one per table, non-null numeric, no default, non-generated, and first in a primary key, unique constraint, or index), `ON UPDATE CURRENT_TIMESTAMP`, inline `enum(...)`, and `set(...)`; index types `BTREE`, `HASH`, `FULLTEXT`, and `SPATIAL` with prefix lengths; and column reordering via `FIRST` and `AFTER`.
- **8.4 and 9.7 version differences.** When a project contains environments across multiple versions, the server groups environments by minor version (`8.4` and `9.7`), derives the lowest target version, and verifies in each group's shadow database. `VECTOR(n)` columns added in MySQL 9.0+ are blocked during static checks when any environment is older than 9.0.
- **Implicit DDL commit and crash recovery.** Every MySQL DDL statement commits implicitly outside transactions. The executor runs statements one by one and persists `step_index`. If the process crashes after a DDL statement commits but before the checkpoint persists, retrying runs deterministic idempotent probes using `information_schema` and MySQL error codes to skip confirmed single-table or single-constraint steps safely while staying conservative on multi-clause or ambiguous statements.
- **Measured lock and rewrite risks.** Progressive probing through `ALGORITHM=INSTANT`, `ALGORITHM=INPLACE, LOCK=NONE`, `ALGORITHM=INPLACE, LOCK=SHARED`, and `COPY` reports the actual engine algorithm and lock impact.

## SQL Server 2019, 2022, and 2025 {#mssql}

### Connection strings and TLS notes {#mssql-connection}

- Accepts `mssql://` or `sqlserver://` URLs with default port `1433`, `host\instance` named instances, and case-insensitive query parameters (`encrypt`, `trustServerCertificate`, `connectTimeout`, `requestTimeout`, `appName`).
- **Self-signed certificates.** Dowel enables strict TLS verification by default (`encrypt=true` and `trustServerCertificate=false`). For local containers or test servers with self-signed certificates, append `?encrypt=true&trustServerCertificate=true` to the URL.
- **Same-instance shadow databases.** Defaults to `{database}_dowel` up to 128 characters, rejects system databases (`master`, `tempdb`, `model`, `msdb`), marks the database with extended property `dowel_shadow`, and coordinates access with session-scoped `sys.sp_getapplock`. See [Managed databases and restricted privileges](modeling.md#managed-shadow-db).

### Dialect capabilities and version checks {#mssql-features}

- **Columns and named defaults.** Supports `IDENTITY(seed, increment)` (at most one per table, non-null, incompatible with default values and computed columns). Column defaults map to named default constraints (derived as `DF_<table>_<col>`), dropped automatically before altering defaults or dropping columns. Renaming tables, columns, and indexes emits `EXEC sp_rename`.
- **Clustered keys and computed columns.** Primary keys, unique constraints, and indexes support `CLUSTERED` and `NONCLUSTERED` (at most one clustered constraint or index per table; primary keys default to clustered) plus `FILLFACTOR` (`1` to `100`). Supports `PERSISTED` computed columns (non-persisted computed columns cannot be `NOT NULL`), `SPARSE`, and `ROWGUIDCOL`.
- **`GO` batch separator.** Import parsing, execution, and exported scripts support lexical `GO [count]` batch splitting (repeat limit `100`) without splitting inside string literals or comments.
- **2019, 2022, and 2025 version differences.**
  - SQL Server 2025 (major version 17) supports native `json` and `vector(n)` types. When the project target version is below 2025 (2019 or 2022), static checks reject both. Native `json` prompts to use `nvarchar(max)` instead, and `vector(n)` reports that SQL Server 2025 (major version 17+) is required.
  - SQL Server 2022 (major version 16) and newer support `IS DISTINCT FROM`.
- **History, transactions, and risk measurement.** History tables reside in `[dowel]` with `AFTER UPDATE, DELETE` triggers enforcing append-only records. Standard DDL runs atomically inside `SET XACT_ABORT ON` transactions, while shadow risk probing monitors `sys.dm_tran_locks` (`Sch-M` and `X`) and `sys.partitions.hobt_id` changes for page rewrites.
