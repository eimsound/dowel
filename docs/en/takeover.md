# Takeover and disaster recovery

The `dowel` migration history stored inside each target database (the `dowel` schema on PostgreSQL and SQL Server, or `dowel_` prefixed tables on SQLite and MySQL) preserves the complete model, object IDs, and frozen scripts of every published version. As long as your target databases exist, you can reconstruct the full platform project in a new Dowel instance after platform database loss, server migration, or cross-instance handoff.

## Take over an existing project in the wizard {#takeover-wizard}

Open the New project wizard (`/new`), select the project's dialect, and choose Take over an existing project under Initial content.

1. **Provide connection strings.** You can enter multiple environments of the same project at once, such as `dev` and `prod`. Dowel inspects each database read-only and lists registered projects along with version counts, latest and current versions, last execution timestamps, and the current claiming instance ID.
2. **Select the project.** Dowel creates the platform project while preserving the original project ID from the target history. If that project ID already exists on this instance, takeover cannot run twice (to attach another database to the existing project, use [Attach an existing environment to an existing project](#attach-existing)). When an existing project is hidden from the current user, the API returns only that it already exists and asks to contact an administrator without leaking its name or group.
3. **Confirm claim if owned by another instance.** When the project is currently claimed by a different Dowel instance, an instance admin on this instance must confirm the claim. Dowel explains that claiming blocks the previous instance from running future executions while leaving its read-only drift checks and history reads intact. Group admins without instance admin access can take over unclaimed histories only. If this instance already holds the claim, no extra confirmation is required.
4. **Create and restore.** Takeover is equivalent to creating a project and requires project creation permission in the target group.

## What takeover restores {#what-is-restored}

- **Full version chain and object IDs.** Restores every version ID, sequence number, parent ID, model (with stable object IDs and explicit name locks), frozen `up_steps` and `down_steps`, `checksum`, frozen `scope`, and publish timestamp. Renaming tables or columns afterward continues to emit `RENAME` statements instead of dropping and recreating objects.
- **Working copy and scope.** Sets the working copy to the head version's model and sets the project schema scope to the head version's `scope`.
- **Environment state and run history.** Sets each environment's current version to the latest `done` record in its target history, imports executed version records, and locks executed versions against script edits.
- **Post-takeover drift check.** Immediately runs a drift check on each restored environment. Takeover itself never alters target database structures or resolves existing drift; handle any detected differences via [Drift handling](execution.md#drift).
- **Claim happens after platform creation.** Dowel writes the platform project first and then locks and writes claims to each target database. If claiming fails on a subset of environments (such as missing write privileges on `dowel`) or another instance executes concurrently during the read, the platform project stays intact with warnings so you can retry claiming on the environment page or delete and redo takeover.

## Mandatory shadow database verification before takeover {#forced-shadow-verify}

Before writing any restored records to the platform database, Dowel verifies the entire merged version chain in chronological order from `v0` to `vN` in this instance's shadow database.

- SQLite projects use the built-in `:memory:` shadow database.
- PostgreSQL, MySQL, and SQL Server projects require a dedicated shadow database URL or checking Allow a shadow database on the same instance in the wizard, as production environments disallow same-instance shadow databases by default.
- If no usable shadow database is found or any version fails upgrade or rollback round-trip verification, takeover aborts without touching the platform database or claiming target databases and reports the failing version and reason.
- Once every version passes, each restored version stores `verified_at` and its verification report tagged as Restored, ready for execution and rollback.

## When takeover is rejected {#takeover-rejection}

Takeover stops before writing anything to the platform or target databases if any of these conditions occur:

- Incomplete single-environment history, such as gaps in version numbers, a broken `parent_id` chain, or a `checksum` mismatch against frozen script bytes.
- Conflicting definitions for the same version ID across environments, including `checksum`, model, version number, parent ID, name, or schema scope.
- Forked version chains across environments, such as two distinct children sharing the same parent or different root versions.
- Missing project history in the provided target databases, or a history `format_version` newer than this Dowel version supports.
- No reachable shadow database or a round-trip verification failure on any version.

## Merging multiple environments {#multi-env-merge}

When taking over multiple environments at once, Dowel merges their histories by version ID into one linear chain. No forks are permitted and matching version IDs must agree completely, while environments may sit at different positions along the chain. For example, if `dev` is at `v3` and `prod` is at `v2`, the restored chain spans `v0` through `v3`, `dev` records current version `v3`, `prod` records current version `v2`, and `v3` appears as pending for `prod`.

## Attach an existing environment to an existing project {#attach-existing}

When you add an environment to an existing Dowel project (such as restoring a production backup or reconnecting a database previously managed elsewhere) and that database already holds history for the same project ID, Dowel attaches it as follows:

- **Authorization.** Attaching is a [privileged operation](execution-policy.md#privileged-ops) requiring at least Project admin plus satisfying the environment's "Who can execute" policy.
- **Chain comparison.** The target database history must match the platform chain or extend it cleanly as a strict ahead suffix with contiguous versions and no forks. Any fork or conflicting version definition rejects the attachment.
- **When the target database is ahead of the platform chain.**
  1. Starting from the platform head model, Dowel runs round-trip shadow verification sequentially on every ahead version. Missing shadow databases or verification failures reject the attachment.
  2. Once verified, Dowel appends the ahead versions to the platform chain (tagged as Restored with verification reports) and updates the working copy to the new head. If the working copy has unpublished edits, Dowel previews the diff and ahead version list for confirmation. The overwritten draft remains recoverable in [Canvas history](modeling.md#canvas-history).
- **Claiming and ordering.** If another instance currently claims the database, an instance admin must confirm the claim. Dowel saves the environment first and then attempts claiming and state synchronization; claim failures return warnings so you can fix credentials and retry on the environment page. Databases with no history for the project attach as ordinary new environments.

## Disaster recovery {#disaster-recovery}

When the platform database is lost without a backup or reinstalling Dowel changes `instance_id`, recover using any surviving target databases:

1. Deploy and initialize a fresh Dowel instance with `DOWEL_SECRET` and create the first instance admin through `/setup` or unattended environment variables.
2. As an instance admin, open the [New project wizard](#takeover-wizard), pick the dialect, choose Take over an existing project, enter the connection strings (and shadow database settings) for all known environments, and select the detected project.
3. Confirm the claim. Because the fresh instance has a new `instance_id`, Dowel prompts for instance admin claim confirmation. Once confirmed, Dowel verifies the entire chain in the shadow database, rebuilds the platform project, and locks out the old instance from executing against those targets.
4. Verify the restored version chain, current environment versions, and post-takeover drift checks before resuming normal modeling and execution.

### Data scope in disaster recovery {#dr-data-scope}

- **Data lost (stored only in the platform database).** Unpublished working copy drafts, canvas node coordinates and sections, platform users, groups and grants (the operator running takeover becomes project admin and other members must be re-invited or re-granted), platform audit logs, project settings, and environment execution policies or production flags (reconfigured during takeover).
- **Data preserved.** Every published version (full models, stable object IDs, derived or explicit names, and frozen upgrade and rollback scripts) and every target database's execution history.
