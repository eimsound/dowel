# Modeling, versions, and canvas history

Dowel stores each project model in a canonical intermediate representation (IR) with stable object IDs. Canvas edits, SQL previews, diffs, and migrations all derive from that single IR. This page covers stable object IDs, schema importing, shadow database isolation, real-time collaboration and canvas history, sections and focus views, version publishing and risk analysis, and PostgreSQL partitioned tables.

## Stable object IDs and rename tracking {#stable-object-ids}

- Every schema, table, column, constraint, index, enum, and sequence carries a globally unique UUIDv7 object ID.
- Renaming a table or column updates the object's name property while keeping its ID. At publish time, Dowel generates `ALTER TABLE ... RENAME` or `ALTER ... RENAME COLUMN` (`sp_rename` on SQL Server) instead of dropping and recreating objects, and preserves existing data.
- **Derived and explicit names.** Engine-derived constraint, index, and sequence names are marked `derived` by default. Renaming a table or column recalculates derived names and emits rename DDL automatically. Lock any name as `explicit` if application code depends on a fixed identifier.
- **Expression rewriting.** When you rename a column, Dowel updates references to that column inside table CHECK constraints, column defaults, and generated column expressions in the same atomic edit.

## Importing schemas {#importing}

Dowel supports importing from a live environment or from a `.sql` file. Both paths inspect schema metadata only and never read or modify business rows.

1. **Import from a target database.** Triggered in the New project wizard or via Import structure from this database on an environment. The server queries system catalogs read-only and aligns object IDs against the current working copy by qualified name to preserve canvas layout and rename continuity.
   - PostgreSQL requires `CONNECT` on the database, `USAGE` on target schemas, and `SELECT` on system catalogs; the `dowel` schema is always skipped.
   - SQLite respects `DOWEL_SQLITE_ROOTS`, inspects the main file, and skips `sqlite_*` and `dowel_*` tables.
   - MySQL inspects the default schema and skips `dowel_*` and `__dowel_shadow_mark` tables.
   - SQL Server inspects user schemas and skips system schemas plus the `dowel` schema.
2. **Import from SQL.** Paste or upload DDL such as `pg_dump --schema-only`, `mysqldump --no-data`, SQLite `.schema`, or T-SQL scripts. The server strips common export statements (`OWNER TO`, `GRANT`, and `REVOKE` in PostgreSQL; `LOCK TABLES` and `UNLOCK TABLES` in MySQL; `BEGIN TRANSACTION` and `COMMIT` in SQLite; top-level `USE` in SQL Server), executes the DDL in the shadow database, and reads back the normalized model.

## Shadow database isolation and safety {#shadow-database}

SQLite uses an in-process `:memory:` shadow database. PostgreSQL, MySQL, and SQL Server use a real shadow database of the same dialect to normalize expressions, import SQL, run round-trip verification, and measure statement risks. Dowel does **not** connect to the shadow database in the background while you edit the canvas (see [Expression normalization](#normalization)); it is used only when you import, verify, publish, generate a migration or export DDL, or click Normalize.

- **Shadow database resolution order.**
  1. An explicit separate shadow database URL configured on the environment.
  2. Automatic `{database}_dowel` database creation on the target database instance when no separate shadow URL is configured, truncated with a short hash if the name exceeds engine identifier length limits.
- **Production isolation.** Environments marked as production refuse same-instance shadow database creation by default because verification and cleanup consume connections and disk I/O. Configure a separate shadow instance or explicitly check Allow a shadow database on the same instance in environment settings.
- **Sentinel marker protection.** Dowel never wipes a non-empty database that lacks its own shadow marker:
  - PostgreSQL uses a database-level `COMMENT`.
  - MySQL uses a `__dowel_shadow_mark` sentinel table inside the shadow database.
  - SQL Server uses the `dowel_shadow` extended property and rejects system databases (`master`, `tempdb`, `model`, and `msdb`).
- **Low-privilege accounts and lexical SQL checks.**
  - Configure a dedicated low-privilege account for shadow databases that owns only the shadow database without superuser rights.
  - Before planning or importing, Dowel scans SQL lexically for cross-database or instance-level statements (such as PostgreSQL `CREATE DATABASE`, `ALTER SYSTEM`, `TABLESPACE`, and `ROLE`; SQLite `ATTACH`, `DETACH`, `VACUUM INTO`, and dangerous `PRAGMA`; MySQL `CREATE DATABASE`, `GRANT`, `SET GLOBAL`, cross-database `db.obj`, and unsafe `sql_mode`; SQL Server `USE`, `KILL`, `xp_cmdshell`, `OPENROWSET`, `BULK INSERT`, and three-part cross-database names) plus any statements modifying `dowel` or `dowel_*` history objects. Lexical checks prevent accidental mistakes; real isolation comes from account permissions and separate database instances.

### Managed databases and restricted privileges {#managed-shadow-db}

#### Recommended topology. Dedicated nearby shadow instance {#managed-shadow-topology}

When using managed databases such as AWS RDS, Aurora, Google Cloud SQL, Neon, Supabase, or Azure, configure an explicit `shadowUrl` pointing to a dedicated nearby or same-VPC instance matching the target major version.

- **Lower network latency.** Round-trip verification and risk measurement perform multiple sequential database round trips. High public-internet latency slows publishing, SQL import, and normalization.
- **Protect production capacity.** Production environments disallow same-instance shadow databases by default. A separate shadow instance runs full verification without touching production connections or I/O.

#### PostgreSQL connection mode requirements {#pg-connection-mode}

Both PostgreSQL target and shadow databases require a direct endpoint or Session Mode (typically port `5432`). Never use a transaction pooler, such as:

- Supabase Supavisor Transaction Mode (`*.pooler.supabase.com:6543`);
- Neon pooled endpoints (`-pooler.` hostnames);
- PgBouncer with `pool_mode = transaction` (commonly port `6543` or `?pgbouncer=true`).

Dowel relies on session-scoped state, including `pg_try_advisory_lock` and `pg_advisory_unlock` session locks, persistent `SET lock_timeout` and `SET statement_timeout` settings, and non-transactional `CREATE DATABASE` statements. Transaction poolers return connections to the pool at transaction boundaries and break lock state and session timeouts.

#### Minimal-privilege SQL setup {#shadow-minimal-privileges}

##### PostgreSQL 15 to 19 {#pg-shadow-privileges}

- **Option 1. Automatic `{database}_dowel` shadow database creation.** Grant `CREATEDB` without `SUPERUSER`:

  ```sql
  CREATE ROLE dowel_user NOSUPERUSER CREATEDB LOGIN PASSWORD '<strong-password>';
  ```

- **Option 2. Pre-created shadow database without `CREATEDB`.** Have an administrator create an empty database and transfer database `OWNER` directly to the Dowel role:

  ```sql
  CREATE ROLE dowel_user NOSUPERUSER NOCREATEDB LOGIN PASSWORD '<strong-password>';
  CREATE DATABASE app_dowel OWNER dowel_user;
  ```

- **Notes for managed PostgreSQL services.**
  - On managed instances without a true superuser such as RDS, Aurora, or Cloud SQL, the admin role must join the target role before assigning ownership (`GRANT dowel_user TO admin_user;`).
  - `GRANT ALL PRIVILEGES ON DATABASE app_dowel TO dowel_user` alone is not enough. Claiming a shadow database executes `COMMENT ON DATABASE`, which requires database ownership. On PostgreSQL 15 and newer, wiping a shadow database also runs `DROP SCHEMA public CASCADE`, which requires schema ownership granted automatically to the database owner through `pg_database_owner`.
  - If leftover schemas were created by another role, transfer their ownership too (`ALTER SCHEMA <schema> OWNER TO dowel_user;`).

##### MySQL 8.4 and 9.7 {#mysql-shadow-privileges}

When the Dowel database user lacks global database creation privileges, have an administrator pre-create an empty database (recommended charset `utf8mb4`) and grant full DDL and DML privileges on that shadow database alone so Dowel can manage `__dowel_shadow_mark` and replay schemas:

```sql
CREATE DATABASE app_dowel CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON `app_dowel`.* TO 'dowel_user'@'%';
```

##### SQL Server 2019 to 2025 {#mssql-shadow-privileges}

Have an administrator pre-create an empty user database (never `master`, `tempdb`, `model`, or `msdb`) and add the Dowel database user to `db_owner` inside that shadow database so it can write the `dowel_shadow` extended property, acquire `sys.sp_getapplock`, and wipe objects cleanly:

```sql
CREATE DATABASE [app_dowel];
GO
USE [app_dowel];
GO
CREATE USER [dowel_user] FOR LOGIN [dowel_user];
ALTER ROLE [db_owner] ADD MEMBER [dowel_user];
GO
```

!!! danger "Safety rule. Never configure a database with business data as a shadow database"

    Before every SQL import, round-trip verification, or normalization run, Dowel verifies its shadow marker and drops all user objects inside the shadow database. Never enter a database containing business data as a shadow URL, and never add shadow markers manually to a non-empty database.

## Real-time collaboration and canvas history {#collab-and-history}

### First-writer-wins concurrency control {#optimistic-concurrency}

- Editors send model changes over WebSocket to the server, which validates, orders, persists, and broadcasts accepted commits to all clients in the room.
- While you edit an object in the properties panel (such as a `CHECK` expression or column rename), if another editor commits a conflicting change to that object or a column it references, the server rejects your save, identifies who made the earlier change, and refreshes your client to avoid silent overwrites.
- Dragging table positions on the canvas uses a separate layout channel that never triggers schema conflicts or enters database version snapshots.

### Expression normalization {#normalization}

CHECK constraints, defaults, generated columns, expression indexes, and partition expressions have a canonical form in the database (for example, PostgreSQL stores `total >= 0` as `(total >= (0)::numeric)`). After you rename tables or columns that views, triggers, and other opaque objects reference, the database must regenerate their definitions too. Dowel calls this **normalization**: it replays the model in the shadow database, reads back the engine's canonical form, and writes it to the working copy so it compares cleanly with structures read from live databases.

- **No automatic normalization while editing.** After you save, the canvas keeps the text you wrote, and the model page status bar shows "N pending normalization" (or "Expressions normalized" when nothing is pending).
- **Manual normalization.** Project editors can click **Normalize** in the status bar at any time to check in the shadow database and write back the canonical form. The button is unavailable, with the reason explained, when no shadow database is usable (for example, when the only environment is production without same-instance shadow databases allowed). If an expression fails in the shadow database, Dowel reports the error and leaves the working copy unchanged.
- **Automatic normalization before key operations.** Before publishing a version, generating a migration, exporting DDL, verifying in the shadow database, viewing version or history diffs, previewing an import from an environment, previewing an environment attach, or reading the model through MCP, the server normalizes pending objects first, so results always use the canonical form. Without a shadow database, migrations and DDL remain available (using the unnormalized spelling), but publishing is refused; see [Publishing and frozen scripts](#publish-and-freeze).
- Write-backs from normalization appear in canvas history as system normalization commits.

### Canvas history and restore {#canvas-history}

Every structural commit to the working copy is stored with an increasing sequence number (`seq`).

- Click History in the canvas toolbar to inspect the revision timeline, including edits, SQL imports, ahead environment attaches, and system normalizations.
- **Consecutive edits are grouped.** Consecutive regular manual edits by the same account (several tabs or a reconnect of the same person count as one person; different accounts that share a display name are never merged) with at most 5 minutes between steps appear as one **Editing session** in the timeline, showing the sequence range (for example `#12–#18`), the main operation counts, the affected objects, and the start and end time. A session holds at most 50 steps and spans at most 30 minutes; after that a new session starts. These operations always stay on their own and never merge with neighboring edits: published versions (the step a version points at can end a session, but later edits start a new one), MCP batch edits, paste, SQL import, importing a schema from an environment, attaching an ahead environment, restoring history, applying a version to the canvas, syncing the working copy after retiring or unretiring versions, and system normalization. Grouping only affects display; every underlying commit and sequence number is kept.
- When an editing session is selected, This change shows the session's **net change** (from the step before the session to its last step, so a column that was added and then dropped does not appear). Click **N steps** below the session to expand every step in it; select any step to see its single-step diff or restore to it.
- Selecting any revision shows both the diff of that step (or session) and the full diff against the current working copy.
- Clicking Restore to this state (for a session, this restores to its last step; for an expanded step, to that step) appends a new commit to the working copy without erasing earlier history. The client sends the viewed `workingSeq`; if another editor modified the canvas in the meantime, the server returns HTTP `409 working_changed` and displays the updated diff for reconfirmation.
- AI coding assistants can read the same grouped history and diffs through the read-only MCP tools `list_history` / `get_history_diff` (see [MCP: canvas history](mcp.md#history)), but restoring is still done only by people here.

### Copy and paste tables, columns, constraints, and indexes {#copy-paste}

You can copy objects from the current canvas, from any snapshot in the canvas history, or from another project that uses the same database type, and paste them into the current canvas.

- **What you can copy.**
  - **Tables**: one table, several tables (⌘ / Ctrl- or Shift-click tables on the canvas, or Shift-drag to select an area; ⌘ / Ctrl+A selects every table shown on the canvas), or all tables in a collapsed section card. A copied table brings its columns (order, types, defaults, generated and identity settings, dialect-specific options), primary key, unique and `CHECK` constraints, indexes, and foreign keys. Partitions of a PostgreSQL partitioned table are copied with it.
  - **Items inside a table**: a column, a constraint, or an index (the copy button on each row in the properties panel), or all columns, all constraints, or all indexes of a table (the Copy menu in the properties panel title bar, which also copies the whole table).
  - **From canvas history**: open History, choose a revision, open _State at point_, then select tables in _Canvas_ and copy them, or use _Tables_ to copy a table, checked tables, a column, or a constraint or index. Close the history and paste on the canvas.
- **How to paste.** Press ⌘V / Ctrl+V on the canvas (not inside a text field), or click Paste in the top bar. Columns, constraints, and indexes are pasted into the selected table (or use _Paste columns, constraints or indexes into table …_ in the properties panel). Viewers can copy tables and the Copy menu items but cannot paste.
- **Same database type only.** Pasting content copied from a project with a different database type (for example SQLite into PostgreSQL) is rejected with an error, and the model is not changed.
- **Never overwrites.** Every pasted object gets a new ID. When a name is already taken, Dowel adds a suffix (`orders` → `orders_copy`, then `orders_copy2`, shortened when needed to stay within the identifier length limit). Automatically named constraints and indexes are named again for the new table. Existing objects are never changed.
- **Foreign keys.** Foreign keys between tables copied together are connected to the new tables. A foreign key that points to a table you did not copy is connected to the table with the same schema, table, and column names in the target project when those columns exist, have the same types, and are covered by a primary key or unique constraint. Otherwise the foreign key is skipped.
- **Inside a table**, constraints and indexes are matched to the target table's columns by name (columns pasted in the same step first). Items whose columns are missing, a primary key when the target already has one, and items identical to an existing definition are skipped.
- **Schemas, enums, and sequences.** Tables go into the schema with the same name, or into the default schema when it does not exist. A PostgreSQL enum referenced by a copied column is reused only when the target has a same-named enum whose values are a superset of the source enum's values; otherwise Dowel creates a new enum with a `_copy` suffix. Sequences owned by copied columns (such as `serial` or owned sequences) are always created anew and owned by the new column, while unowned sequences are reused by name when present and created otherwise. Views, triggers, and other objects that Dowel stores as SQL text are not copied.
- **Paste result.** When something was renamed or skipped, a panel at the bottom left of the canvas lists the renamed objects, skipped foreign keys and items with the reason, and other notes. It stays until you close it.
- **One step in canvas history.** A paste is applied as a single change through the normal real-time sync: it follows the same conflict rules as other edits, appears to collaborators immediately, and shows up as one _Paste_ entry in the canvas history, where you can restore the state before it.
- **How the clipboard works.** The copied content is a versioned JSON document. Dowel writes it to the system clipboard and keeps a copy in the browser's local storage, so pasting into another tab of the same Dowel site works even when the browser does not allow reading the system clipboard. If you copy other text after copying in Dowel, the newer system clipboard content wins and Dowel does not paste the older copy.

## Canvas sections, default collapse, and neighborhood focus {#canvas-sections}

For large schemas with dozens or hundreds of tables, Dowel provides layout-only sections, automatic collapse above 100 tables, and neighborhood focus.

- **Layout-only semantics with zero DDL side effects.** A section lives strictly in canvas layout metadata and never enters the database model, SQL preview, diffs, versions, or migration scripts. Moving or deleting sections changes no database DDL.
- **Shared definitions and per-browser view state.**
  - Section names, colors, and table memberships sync in real time across project collaborators (viewers cannot edit sections). Each top-level table belongs to at most one section, sections cannot nest, and sections are independent of database schemas.
  - Sidebar view mode (`Schema` or `Sections`), canvas view mode (`Sections` or `Flat`), individual expand or collapse states, and table neighborhood focus stay in each user's local browser storage.
- **AI assistants can organize sections too.** An MCP token with the **Edit working copy** permission can create, rename, recolor, and delete sections, or move tables in and out of them, with `manage_sections` (see [AI assistants (MCP)](mcp.md#sections)). AI can't write table positions on the canvas.
- **Prefix suggestions.** Open Manage sections or click Suggest in the sidebar to group unassigned tables by their leading `_` or `-` name prefix. Dowel ignores common prefixes such as `t_`, `tbl_`, and `tb_`, folds basic singular and plural forms, and suggests groups with at least two tables so you can adjust names and colors before applying.
- **Automatic collapse over 100 tables.** Canvases with up to 100 top-level tables render expanded by default. Above 100 top-level tables, Dowel renders collapsed summary cards grouped by section (or by schema when no sections exist) that show table counts and cross-section or cross-schema foreign key counts. Click Expand to lay out a group on demand, or switch back to Flat mode at any time.
- **1-hop and 2-hop foreign key focus.** Click Focus neighborhood on a sidebar table row or in the properties panel to isolate tables connected by 1-hop or 2-hop undirected foreign keys. Use the top floating bar to switch between `1-hop` and `2-hop` or click Exit focus.

## Publishing, verification, and risk analysis {#publish-and-verify}

### Publishing and frozen scripts {#publish-and-freeze}

- Click Publish to freeze the working copy into a read-only version snapshot along with upgrade (`up`) and rollback (`down`) migration scripts. The `v0 · Baseline` version has no rollback script.
- **Every published version is verified.** Publishing first normalizes pending objects, then runs closed-loop verification in a shadow database, and only writes the version if it passes; the frozen model is exactly the one that was verified. Nothing is published in these cases, and the dialog explains why and what to do:
  - **No usable shadow database** (the project has no environments, every environment is production without a dedicated shadow URL or same-instance permission, or the shadow database is temporarily unreachable): configure a shadow database or allow a same-instance shadow on the Environments page, or try again later. Publishing as unverified no longer exists.
  - **Some objects could not be normalized**: the dialog lists them; try again later, or click Normalize in the status bar to see why.
  - **Verification failed**, including the **readback check**: after the upgrade, the structure read back from the shadow database must match this version's model property by property, and after the rollback it must match the previous version's model. Mismatches list the object, property, model value, and the value read back (differences marked "After rollback" are against the previous version). Dowel does not fix them automatically; change the model to the database's spelling and publish again.
  - **No shadow database matches the environments' versions**: the shadow databases that passed run versions that match none of the project's environments.
- Publishing groups the project's environments by **full database version**, verifies on one usable shadow database per version, and records one verification record per version; if any usable shadow database fails, nothing is published. A version with no usable shadow database does not block publishing; the dialog lists those uncovered environments instead. Executing on them is refused until you configure a shadow database with the same version and click Verify again on the version page (new records are merged with earlier ones by version).
- The `v0 · Baseline` created when importing an existing database is the only version that may be unverified when created.
- Only the latest version in the chain that has never executed against any environment allows manual script edits. Editing a script resets that version to unverified (clearing all verification records), so you must verify it again before execution.
- On the Versions or Migration page, download `.sql` scripts with pinned session parameters such as timezone and strict mode.

### Round-trip verification and lock or rewrite risk measurement {#verification-and-risk}

Clicking Verify in shadow database runs two checks:

1. **Round-trip parity.** Dowel starts from the previous version's structure, executes the upgrade script, reads back the live structure to confirm it matches the new version, runs the rollback script, and confirms the structure matches the starting version. The comparison is the same one the executor uses for its readback check, so a version verified on a database of the same version always passes that check when it runs.
2. **Measured risk analysis.** Dowel executes each step in the shadow database, records actual locks, sequential scans, and table rewrites, and assigns a `high`, `medium`, or `low` risk level:
   - **PostgreSQL.** Inspects relation locks in `pg_locks`, `relfilenode` changes for table rewrites, and `pg_stat_xact_user_tables` sequential scan counts.
   - **SQLite.** Flags 12-step table rebuilds (`EXCLUSIVE` lock and table rewrite), `VACUUM` database rewrites, and `DROP COLUMN` or `CREATE INDEX` (`RESERVED` lock).
   - **MySQL.** Probes each single-table `ALTER TABLE` statement progressively across `ALGORITHM=INSTANT` (low risk), `ALGORITHM=INPLACE, LOCK=NONE` (medium risk), `ALGORITHM=INPLACE, LOCK=SHARED` (medium risk), and `COPY` (high risk with table rewrite) to report the real engine algorithm.
   - **SQL Server.** Inspects object locks (`Sch-M` and `X`) in `sys.dm_tran_locks` and `sys.partitions.hobt_id` changes inside a transaction to detect data-page rewrites.

## PostgreSQL partitioned tables and modeling limits {#partitioning-and-limits}

### PostgreSQL partitioned table editing {#pg-partitioning}

- Create and edit declarative partitioned tables in the modeler with `RANGE`, `LIST`, or `HASH` strategies and column or expression partition keys, including operator classes and collations.
- Add, edit, and remove child partitions and bounds (`FOR VALUES FROM (...) TO (...)`, `FOR VALUES IN (...)`, `FOR VALUES WITH (modulus M, remainder R)`, and at most one `DEFAULT` partition per parent).
- Attach an existing regular table as a partition (`ATTACH PARTITION`) or detach a partition into an independent regular table (`DETACH PARTITION`).
- Because PostgreSQL forbids changing partitioning strategy in place, published partitioned tables lock the strategy field as read-only. Multi-level sub-partitions display as read-only badges in the properties panel. Primary keys and unique constraints on partitioned tables must include all partition key columns, and tables with expression partition keys cannot define primary keys or unique constraints.

### General modeling boundaries {#modeling-limits}

- **Opaque objects.** Views, materialized views, functions, stored procedures, triggers, row-level security policies, domains, custom composite types, and exclusion constraints are stored as opaque objects. Dowel imports them, drops and recreates them in dependency order during migrations, and has the shadow database rewrite their definitions during [normalization](#normalization) (manual, or automatic before publishing and generating migrations) after referenced tables or columns are renamed, while direct form editing in the canvas is disabled. On PostgreSQL, function and procedure edits that only change the body, routine options, or add/update parameter defaults are applied in place with `CREATE OR REPLACE`; changing a parameter's name, mode, or type, removing a parameter default, or changing the return type is applied as `DROP` then `CREATE` (which loses out-of-model grants and ownership, and fails if other objects such as `CHECK` constraints, column defaults, or indexes depend on it).
- **Read-only SQL views.** SQL previews and DDL panels in the UI are read-only. Modify the model on the canvas, in the properties panel, or by importing SQL.
- **Enum types.** PostgreSQL supports standalone `ENUM` objects. Adding values generates `ALTER TYPE ... ADD VALUE`, while removing or reordering values generates steps to rebuild the type and update affected column types. MySQL uses inline column `enum(...)` and `set(...)` definitions.
  - **Rebinding rebuilds and cost (PostgreSQL).** When enums swap names, rotate, swap schemas, or are dropped and recreated or rebuilt (values removed or reordered), dependent `CHECK` constraints, partial-index `WHERE` predicates, expression indexes, stored generated columns, column defaults, and views are automatically rebuilt to bind against the model's target enum (plain renames emit only `ALTER TYPE ... RENAME` with zero rebuilds). Rebuilding carries lock and rewrite costs: `CHECK` takes `ACCESS EXCLUSIVE` while re-validating existing rows, indexes drop and recreate non-concurrently (blocking writes), stored generated columns drop and re-add (rewriting the whole table and moving the column to the end), and defaults/views update catalog metadata quickly.
  - **Planning restrictions (PostgreSQL).** Planning fails with an explicit error if a partition-key column uses a rebuilt enum or a partition-key expression references an enum whose binding changes (PostgreSQL cannot alter partition keys on existing tables). Planning also fails when an early opaque object (domain, composite type, function, procedure, or aggregate) depends on a rebuilt enum, or depends on a dropped enum without being dropped or redefined away from it in the same version (pure enum drop; when a same-named replacement enum is created in the same version, functions, procedures, and aggregates are still blocked).
