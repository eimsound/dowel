# Execution, rollback, and drift

Applying published versions to a target database is called **Execution** in Dowel. This page describes the full validation pipeline, dialect history table locations and account privileges, dry runs, instance claiming, failure and checkpoint recovery, and drift detection and resolution.

> Related guides include [Execution policy and executors](execution-policy.md), [Execution requests and approvals](approvals.md), [Group webhooks](webhooks.md), [Takeover and disaster recovery](takeover.md), [CI HTTP API](api.md), and [Dialects and version support](dialects.md).

## Core concepts {#basic-concepts}

- **Migrations freeze at publish time.** When you publish a version, Dowel generates upgrade (`up`) and rollback (`down`) scripts against the previous version, verifies them in the shadow database, and freezes them. Every environment executes those exact frozen scripts in chain order without replanning at execution time.
- **Environment current version.** The version reached by the last completed (`status = 'done'`) run recorded in the target database's Dowel history.
- **Execution and rollback.** From the environment details page, you can upgrade an environment from its current version to a newer version or roll back along the `down` chain to an earlier version. Operations on production environments require typing the environment name to confirm.

## Target database privileges and history locations {#target-privileges}

Execution always connects with the database credentials configured on the environment. Dowel never elevates or switches database users. History tables are placed by dialect:

- **PostgreSQL and SQL Server.** Migration history lives in the `dowel` schema (`dowel.meta`, `dowel.projects`, `dowel.versions`, `dowel.history`, and `dowel.claims`).
- **SQLite and MySQL.** Because these engines lack per-database schema namespaces, migration history lives in `dowel_` prefixed tables inside the same database (`dowel_meta`, `dowel_projects`, `dowel_versions`, `dowel_history`, and `dowel_claims`).

### Required account privileges {#privilege-table}

Running migrations requires privileges on the business schemas and objects affected by the scripts. Managing Dowel history and running read-only checks require the dialect privileges below:

| Dialect    | Initializing history tables                                                                                                                                                                                                                                                | Reading and writing migration history                                                                                                            | Drift check and read-only history                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| PostgreSQL | Database `CREATE` (`GRANT CREATE ON DATABASE <db> TO <role>`) or a DBA pre-created `CREATE SCHEMA dowel AUTHORIZATION <role>`. If `dowel` already exists, `GRANT USAGE, CREATE ON SCHEMA dowel`                                                                            | `GRANT USAGE, CREATE ON SCHEMA dowel` plus read and write privileges on the history tables                                                       | `CONNECT`, catalog read privileges, and read-only access on `dowel` (allows drift checks, blocks apply)   |
| SQL Server | Database `CREATE SCHEMA` (or DBA pre-created `CREATE SCHEMA [dowel] AUTHORIZATION [role]`) and `CREATE TABLE`. If `[dowel]` exists without tables or triggers, `GRANT ALTER, SELECT, INSERT, UPDATE ON SCHEMA::[dowel]`                                                    | Once a DBA pre-creates all 5 tables and 2 guard triggers, minimal execution accounts need only `GRANT SELECT, INSERT, UPDATE ON SCHEMA::[dowel]` | `CONNECT`, catalog read privileges, and read-only access on `[dowel]` (allows drift checks, blocks apply) |
| MySQL      | `CREATE`, `INSERT`, `UPDATE`, and `TRIGGER` on the target database (with `read_only` and `super_read_only` off). When `log_bin=1` and `log_bin_trust_function_creators=0`, creating guard triggers also requires global `SUPER` unless `log_bin_trust_function_creators=1` | Read, write, and trigger privileges on `dowel_*` tables                                                                                          | `CONNECT`, read access on `information_schema`, and read-only access on `dowel_*` tables                  |
| SQLite     | Read and write access on the database file with `query_only = 0` so `dowel_*` tables and triggers can be created                                                                                                                                                           | Read and write access on the database file and `dowel_*` tables                                                                                  | Read access on the database file and `dowel_*` tables                                                     |

If the configured database account lacks permission to initialize history tables, Dowel returns an error containing exact DBA grant SQL instead of falling back to business schemas. The `dowel` schema and `dowel_*` table names are fixed and always skipped during imports and drift comparisons.

### History table schema {#history-tables}

Multiple projects can share one database; rows inside the history tables isolate projects by `project_id`:

| Table (schema or prefix)      | Purpose                                                                                                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta` / `dowel_meta`         | Key-value metadata holding `format_version` (currently `1`). Dowel refuses to read or write histories with a newer `format_version` and asks to upgrade the server                                                                            |
| `projects` / `dowel_projects` | One row per project storing project ID, name, current claiming `instance_id`, claim timestamp, actor, and `previous_instance_id`                                                                                                              |
| `versions` / `dowel_versions` | One row per version applied to this database storing sequence number, name, `parent_id`, frozen `up_steps` and `down_steps`, `checksum`, full `model` with object IDs, frozen `scope`, fingerprint, and publish metadata                      |
| `claims` / `dowel_claims`     | Append-only log of instance claim events protected against updates and deletes by triggers                                                                                                                                                    |
| `history` / `dowel_history`   | One row per run recording `from_version` and `to_version`, `direction` (`baseline`, `up`, `down`, or `mark`), `status` (`running`, `done`, or `failed`), `step_index`, error text, actor, source (`web` or `ci`), instance ID, and timestamps |

Key guarantees:

- **`history` and `claims` are append-only.** Triggers across all four dialects forbid `DELETE` and block updates to finished (`done` or `failed`) rows or identity columns. Because database owners or superusers can alter triggers, this acts as accidental-edit protection rather than a privilege barrier.
- **`checksum` integrity verification.** Computed as the SHA-256 hash of canonicalized `up` and `down` script JSON. Before execution, Dowel recomputes checksums for every version and rejects tampered scripts.
- **Cross-instance recovery.** Because every applied version's complete model and object IDs live inside the target database, you can rebuild a lost platform database via [Takeover and disaster recovery](takeover.md).

## First execution against a database {#first-run}

When a target database contains no Dowel history for the current project, Dowel reads the target's live structure first:

| Live database state                                                                           | First execution behavior                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structure equals the first version in the chain (for example after importing `v0 · Baseline`) | **Write baseline.** Creates history tables, records the first version and a `baseline` history row without running DDL, then proceeds with newer versions |
| **Empty database** with no user objects inside the schema scope                               | Creates history tables and runs the first version's upgrade script to build the schema                                                                    |
| Any other mismatched structure                                                                | Reports **drift** with differences against the baseline, refuses execution, and creates no `dowel` history tables                                         |

The baseline is only recorded automatically during your first migration execution (for example, executing `v1` or later). If you need to establish migration history at `v0` before publishing newer versions, use [Mark as applied](#mark-as-applied) (executing directly to `v0` with no further migrations on a matching database is rejected with `mark_required`).

## Execution validation order {#execution-steps}

Every execution or rollback passes through six sequential checks. Failure at any check stops immediately without changing the target database:

1. **Acquire project lock.** Only one execution per project and target database can run at once. Concurrent requests wait up to 30 seconds by default before returning `lock_timeout`. PostgreSQL uses transaction or session advisory locks, SQL Server uses `sp_getapplock` on a dedicated session connection, MySQL uses `GET_LOCK` on a dedicated connection, and SQLite uses a mutex keyed by canonical file path.
2. **Verify claim and chain integrity.** Confirms `projects.instance_id` matches this Dowel instance (otherwise `foreign_instance`), then verifies contiguous version numbers, `parent_id` links, and matching script `checksum` values between the platform database and target database.
3. **Check drift.** Reads the live structure using the environment's current version `scope` and refuses execution if any mismatch exists.
4. **Verify shadow validation status.** Every migration along the path must have passed shadow verification and must have a passing record for the target database's **full version** (two parts for PG such as `17.4`, three for MySQL such as `8.4.3`, the build number for SQL Server; SQLite's built-in shadow database does not distinguish versions). Versions verified only on other versions, or whose scripts were edited without re-verification, are rejected with `unverified`. This applies to upgrades, rollbacks, dry runs, execution requests, emergency execution, and CI alike, with no bypass; Mark as applied runs no scripts and is not affected. The Versions page and the environment details flag such versions as "Not verified on this version": give the environment a shadow database running the same version (or allow a same-instance shadow), then click Verify again on the version page to add the record. In CI, read each version's `verifiedHere` in the [live environment status](api.md#get-environment) to tell beforehand whether it would be rejected.
5. **Check for dangerous statements.** Blocks migrations containing instance-level statements or statements altering `dowel` history objects.
6. **Execute migrations and verify read-back.** Runs each migration in chain order and reads back the live structure afterward. If the live structure does not strictly equal the target version model, the run fails.

### Transactions, non-transactional steps, and implicit commits {#tx-and-nontx}

- **Transactional migrations.** Standard DDL in PostgreSQL, SQL Server, and SQLite runs together with history table updates inside one transaction. Any error or read-back mismatch rolls back completely.
- **Non-transactional steps and MySQL auto-commit DDL.**
  - **PostgreSQL.** `CREATE/DROP INDEX CONCURRENTLY`, `VACUUM`, `REINDEX DATABASE/SYSTEM`, table-less `CLUSTER`, and `ALTER TYPE ... ADD VALUE`.
  - **SQLite.** 12-step table rebuild blocks (toggling `PRAGMA foreign_keys` outside transactions around an internal `BEGIN IMMEDIATE ... PRAGMA foreign_key_check ... COMMIT` block) and `VACUUM`.
  - **SQL Server.** Statements disallowed inside transactions such as `CREATE/ALTER/DROP FULLTEXT`.
  - **MySQL.** All DDL statements commit implicitly.
    Non-atomic migrations execute segment by segment and update `history.step_index` after every step. In MySQL, if the process crashes after a DDL statement commits but before the checkpoint persists, retrying queries `information_schema` and MySQL error codes to skip confirmed single-table or single-constraint steps safely.
- Every execution applies the same pinned session parameters (such as UTC timezone and strict mode) used during shadow verification and restores original connection settings afterward.

### Rollback and permanent script locking {#rollback-and-lock}

- Rollback runs each version's `down` script along the chain using the same validation rules as upgrades. The `v0 · Baseline` or root version has no rollback script, so you cannot roll back past it. Rollbacks follow the `parent` links back, and you can only roll back to an ancestor of the current version.
- **Permanent execution lock.** Once a version leaves a write on any target database (either a committed transaction or the first non-transactional or MySQL step begins), the platform records `executed_at` permanently. Script editing remains blocked even if you later roll back, delete the environment, change its connection string, or wipe the target database.
- **Configuration lock during execution.** While an environment holds its execution lock, editing the connection string, changing shadow settings, deleting the environment, or unmarking production returns HTTP `409`. If an earlier crashed process left stale `running` claims with no active execution, editing the environment conservatively marks those versions executed and clears the stale claims.

## Dry run {#dry-run}

Opening the Execute migrations or Roll back migrations dialog triggers a read-only dry run automatically:

- Runs the exact same pre-execution checks as live execution (project lock, integrity, claim, drift, verification status, dangerous statements, and history table write permissions).
- Previews the planned migrations, every SQL statement, non-transactional or implicit-commit flags, stored risk summaries, checkpoint resume offsets, and whether `dowel` history tables will be created on first run.
- Writes nothing to the target database or platform database.
- Returns differences and exact failure reasons if checks fail, and waits only a few seconds for busy locks. Dry runs on production environments do not require typing the environment name.

## Claim {#claim}

Only the claiming instance recorded in the target database history can execute or roll back migrations on that database:

- First execution against a new database registers this Dowel instance as the claimer automatically.
- If another instance currently holds the claim (including after a platform rebuild that generated a new `instance_id`), an instance admin must confirm Claim this database on the environment details page or during takeover.
- Claiming updates `dowel.projects` or `dowel_projects` and appends an event row to `claims` or `dowel_claims` while keeping prior run records intact.
- Once claimed, execution and rollback attempts from the previous instance fail with `foreign_instance`, while its read-only drift checks and history reads continue to work. Dowel has no revoke action; return ownership by having an admin on the original instance claim the database back.

## Failure and checkpoint recovery {#failure-recovery}

- **Policy timeout cancellation (`step_timeout`).** When a lock wait or statement exceeds the threshold configured in [Execution policy](execution-policy.md#timeouts), Dowel cancels the step and reports the timeout kind and threshold distinctly from regular SQL errors. Transactional migrations roll back cleanly and can be retried; non-transactional and MySQL migrations resume from the saved checkpoint.
- **Mid-run failure and checkpoint resume.** When a non-transactional or MySQL migration stops partway, `history.step_index` stores the last completed step index (`-1` if the first non-transactional step started). In this unfinished state, Dowel skips drift checks and blocks rolling back or skipping versions until you either resume the migration to completion or fix the database by hand and use Mark as applied.
- **PostgreSQL concurrent operation recovery.**
  - When `CREATE INDEX CONCURRENTLY` fails and leaves an `INVALID` index, Dowel runs `DROP INDEX CONCURRENTLY IF EXISTS` before retrying if the schema-qualified table and index names parse unambiguously; otherwise it prompts for manual cleanup.
  - When `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY` times out on locks in `detach pending`, retrying runs `ALTER TABLE ... DETACH PARTITION ... FINALIZE` automatically.
- **Read-back mismatch (`[readback_mismatch]`).** When all steps of a non-transactional migration complete but the live structure still differs from the target model (for instance due to an edited script), Dowel stops retrying, marks the run `failed`, and raises a drift alert. You can restore the database to the current version and retry, or adjust the live database to match the target version and align history with Mark as applied.
- **Credential scrubbing.** Passwords and connection credentials are stripped from all error messages returned to the UI, written to audit logs, or stored in target history tables.

## Drift {#drift}

Drift occurs when a target database's live schema diverges from the model of that environment's current version, usually because someone modified the database outside Dowel. Execution and rollback are blocked whenever drift exists.

### Drift checks and triggers {#drift-check}

- **Comparison flow.** Dowel compares a snapshot fingerprint against the recorded fingerprint (ignoring non-structural traits such as physical column order). When fingerprints differ, it imports the live schema and generates a diff list capped at the first 100 items alongside the total difference count.
- **When checks run.** Automatically before every execution or rollback, manually via Check drift on the environment page, and periodically on the `DOWEL_DRIFT_INTERVAL_MINUTES` schedule (default `60`, set `0` to disable). Results cache in the platform database and display alerts in the navigation bar and project overview.
- Checks skip automatically while an environment is executing or stopped mid-run. Connection, permission, or integrity failures report Check failed with the specific cause.

### Keep live changes via import, publish, and mark as applied {#drift-keep}

When out-of-band database edits belong in your schema model:

1. Click Keep the live changes (Import structure from this database) on the drift view. Dowel reads the live schema and aligns object IDs against your working copy by qualified name. Before confirming, Dowel previews changes and warns if the working copy has unpublished edits, the environment lags behind the chain head, or a migration is unfinished. Confirming verifies both the live fingerprint and `workingSeq` to block concurrent overwrites (`409`).
2. Review the imported working copy (for example, convert an out-of-band column drop and add back into a rename to emit `RENAME`).
3. Publish a new version and pass shadow database verification.
4. Click Mark as applied on the environment to align its history to the new version, then execute that version on remaining environments normally.

### Discard live changes with a repair script {#drift-discard}

When out-of-band changes should be reverted, Discard the live changes generates a repair script transitioning from the live structure back to the current version model, complete with pinned session settings, drop warnings, type rewrite warnings, and any unresolvable manual items.

> **Dowel never runs repair scripts for you.** Because a repair script is unverified SQL generated for a drifted live state, review and run it on the target database yourself, then click Re-check drift. If more than 100 differences exist, apply the script and re-check in batches.

### Mark as applied {#mark-as-applied}

Mark as applied writes a `direction = 'mark'` history entry aligning the environment to a target version `X` without executing SQL, provided the live database structure matches version `X`'s model exactly.

- You can mark forward (skipping versions already hotfixed into the database), mark backward (after a manual rollback), or mark at the current version after reverting a failed non-transactional run by hand to clear its unfinished state.
- When marking forward, the confirmation dialog previews the live check, lists every skipped version and script, explains that script data steps will not run, requires explicit checkbox confirmation, re-verifies the live fingerprint under the project lock, and marks skipped versions with `executed_at`. Marking backward or at the current version preserves script editability for unexecuted versions.
- Mark as applied is a privileged operation gated by the environment's "Who can execute" policy. Production environments require typing the environment name. CI tokens cannot invoke mark operations.

- **Cross-branch mark**: when an environment is on a [retired](#retire) version and the live structure already matches a version on the active chain, you can mark the environment as applied to that active version. Only the versions after the common ancestor up to the target are recorded as applied; unrelated retired versions are never included. The same confirmation is required. You cannot mark an environment as applied to a retired version.

### Known drift limits {#drift-limits}

- **Drifted environment behind the chain head.** If `prod` sits at `v5` with an out-of-band hotfix while the chain head is `v7`, revert `prod` back to `v5` with the repair script before upgrading, or merge the hotfix into `v8` and mark `prod` as applied.
- Three-way automatic merges during import are not supported.

## Retiring tail versions {#retire}

If a version was published by mistake, or you want to drop the last few versions and redesign, you can **retire** one or more consecutive versions at the end of the active chain from the version detail page (the first version cannot be retired). Retiring happens on the platform only:

- **No target database is touched**; the original versions, their frozen migrations and the history in target databases are kept;
- **Version numbers are never reused**: after retiring `v5`, the next version published from `v4` is `v6`, with parent `v4`;
- By default the working copy is **reverted** to the model of the retired range's parent (as a new commit in canvas history that you can restore anytime); you can choose to keep the current working copy instead;
- Open execution requests that reference these versions are invalidated (the requester is notified and a `request.invalidated` webhook is sent);
- Retiring is rejected (409) while an environment is executing one of these versions; retry after it finishes;
- **Tiered permission**: project editors can retire a range in which no version has ever run in any environment; if any version in the range has run, a project admin is required;
- Every retire is written to the audit log (`version.retire`).

You cannot execute (upgrade) to a retired version, mark an environment as applied to it, or edit its scripts. The version list can be filtered by Active / Retired.

### Unretire {#unretire}

As long as **no newer version has been published from the parent** (the retired range attaches directly to the current active chain head and reaches the highest version number), you can **unretire** the whole range in one click from a retired version's detail page. The same tiered permission applies; previously invalidated requests stay invalid; you can optionally restore the working copy to the restored head's model.

Once a newer version has been published from the parent, the superseded branch can **never be unretired**. Use Apply to canvas below if you need its structure.

### Apply to canvas {#apply-to-canvas}

Every version, including retired ones, has **Apply to canvas** on its detail page: Dowel shows the differences from the working copy to that version, then replaces the working copy with the version's model as a new commit in canvas history (restorable from canvas history). If the working copy changes while you review, you are asked to confirm again.

### Environments on a retired version: switching back to the active chain {#switch}

After you retire a version that has already run, the environments that ran it stay on the retired version (for example on `v5` while the active chain is `… → v4 → v6`). Such an environment has three options:

1. **Switch**: the environment page's execute button becomes "Switch to v6". The route goes through the common ancestor: it runs the rollback script of `v5` back to `v4`, then the upgrade script of `v6`. The dry run and execution requests list the **rollback segment** and the **upgrade segment** separately, with a prominent "Rollback" tag on every rolled-back version. Rollback scripts may drop columns, tables and their data, so you must tick the confirmation that the rollback segment may cause data loss before confirming. Switching is subject to both execute and rollback permission; approvals and typing the environment name for production work the same as for execution; execution requests bind the checksums of both segments.
2. **Roll back to an ancestor**: roll back to `v4` or an earlier version.
3. **Mark as applied across branches**: if the live structure already matches a version on the active chain and a rollback's data loss is unacceptable, align the history with no SQL using [Mark as applied](#mark-as-applied).

Each migration of a switch commits separately and is read back and verified: if the rollback segment succeeds and the upgrade segment fails, the environment stays on the common ancestor (for example `v4`); run it again to reach `v6`.

**CI tokens never roll back automatically**: when reaching the target requires a rollback first, the CI API returns `switch_requires_web` (409) and the switch must be confirmed in the Dowel web UI; a retired target version returns `version_retired` (409).

The structure and format version of the `dowel` history tables in target databases do not change: retired branches are simply the versions that are not on the path from the root to the highest number, and takeover classifies them automatically (see [Takeover](takeover.md#multi-env-merge)).
