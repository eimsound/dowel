# Execution policy and executors

The execution policy controls who can perform privileged operations on an environment, which approval flow runs before execution, and what lock wait and statement timeouts apply. Policies stack across four layers that can only tighten downward. For the execution workflow, see [Execution, rollback, and drift](execution.md).

## Four-layer configuration and merging {#policy-layers}

| Layer       | Configuration location                 | Who can edit   |
| ----------- | -------------------------------------- | -------------- |
| Instance    | Execution policy under Admin           | Instance admin |
| Group       | Execution policy on the group home     | Group admin    |
| Project     | Execution policy in project settings   | Project admin  |
| Environment | Execution policy on environment detail | Project admin  |

- The instance, group, and project layers each maintain separate rule sets for production environments and non-production environments. The environment layer stores one rule set and inherits from the parent rule set matching its production flag.
- Unset fields inherit from above. When no layer sets a field, Dowel applies the built-in default. Each control displays its effective value and source layer.
- **Tighten-only merging.** Once an upper layer sets a stricter rule, lower layers lock looser options in the UI and reject looser values via the API with HTTP `422`.

## Policy fields, defaults, and tightening direction {#policy-items}

| Policy field             | Allowed values                                    | Default (non-production / production)         | Tightening direction (stricter)                   |
| ------------------------ | ------------------------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| Who can execute          | Project editors / Project admins / Executors only | Project editors / Project admins              | Executors only > Project admins > Project editors |
| Lock wait timeout        | Seconds, `0` means no limit                       | `5` s / `5` s                                 | Shorter is stricter; no limit is loosest          |
| Statement timeout        | Seconds, `0` means no limit                       | No limit / No limit                           | Shorter is stricter; no limit is loosest          |
| Allow CI token execution | Allowed / Not allowed                             | Allowed / Not allowed                         | Not allowed is stricter                           |
| Execution request TTL    | `1` to `720` hours                                | `24` hours / `24` hours                       | Shorter is stricter                               |
| Approval flow            | Ordered list of approval stages                   | One stage (authorized users execute directly) | Append stages only after upper-layer stages       |

- **Who can execute.** "Project editors" permits editors, project admins, and executors. "Project admins" permits project admins and executors. "Executors only" permits only users or groups holding an executor grant. Instance admins bypass this restriction.
- **Defaults are not floors.** Unless an upper layer explicitly sets a rule, a lower layer can configure a looser value than the default, such as allowing editors on a specific production environment when production policies above are unset.
- **Allow CI token execution.** CI token execution (see [CI HTTP API](api.md)) checks only this field and is **not subject to "Who can execute" or the approval flow**. Non-production environments allow it by default, so when you tighten a non-production rule set ("Who can execute" set to Project admins or Executors only, or approval stages configured) while this field stays "Allowed", members permitted to create CI tokens can still issue a token and execute forward without approval. The policy editor shows a notice at the bottom of the non-production rule set, and anyone who can edit that layer can set the field to "Not allowed" with one click (this only changes the form; save the execution policy to apply it. Turning token execution off is a tightening, so upper-layer locks never block it). The default is unchanged, so teams relying on CI deployments can keep it on.

## Privileged operations governed by policy {#privileged-ops}

Privileged operations include:

- Execute, roll back, and [mark as applied](execution.md#mark-as-applied), including dry runs.
- Update connection strings or shadow database settings, unmark production, and delete an environment.
- [Attach an existing environment to an existing project](takeover.md#attach-existing).

Configuration changes (editing connection strings, unmarking production, deleting an environment, and attaching existing history) also require at least the Project admin role. An executor without Project admin cannot alter environment settings. Editing the model, publishing versions, and manual drift checks follow project roles and are not gated by execution policy.

## Modifying policies and group transfer protection {#changing-policy}

- **Tightening a policy.** The layer's admin (instance, group, or project admin) can tighten any field or append approval stages at any time.
- **Loosening a policy.** Widening any field or removing approval stages weakens protection and counts as a privileged operation. In addition to being that layer's admin, the actor must satisfy the effective "Who can execute" rule in force before the edit. Loosening requires no approval request and is written to the audit log. For example, on an "Executors only" environment, a project admin who is not an executor cannot loosen that rule; an authorized executor or instance admin must change it.
- **Unmarking production.** Removing the production flag switches inheritance from the production rule set to the non-production rule set. For any field where the non-production parent value is looser than the previously effective value, Dowel pins the stricter effective value directly at the environment layer automatically so protection never drops silently.
- **Transferring a project between groups.** When a project moves to another group, each environment re-merges against the new group's rules. Any field that would become looser is automatically pinned at the environment layer. Verify after a transfer whether existing executors remain valid under the new group.
- **Concurrency and open requests.** Policy saves re-read and validate existing values inside a transaction to prevent stale overwrites. Tightening a policy immediately invalidates open execution requests on affected environments, whereas loosening allows open requests to finish under their stricter submitted snapshot.

## Executors {#executors}

Executors are users or groups granted permission to run privileged operations within a scope (for example, a DBA group) independently of model editing roles.

- Grant the Executor role to a user or group across an environment, a single project, all projects in a group, or the entire instance under Members and grants, group settings, or Admin.
- Executor grants include read-only Viewer visibility on covered projects without granting model edit permissions.
- **Production protection.** When a production environment's effective "Who can execute" level is "Executors only", only an instance admin can grant valid executors for it. Executor grants created by project or group admins do not count on that production environment, and the UI labels valid grants as granted by instance admin.

## Timeouts for locks and statements {#timeouts}

Before running each migration or rollback step, the executor applies the environment's effective lock wait timeout and statement timeout to the target session and resets session defaults when the step finishes. Dowel's own read-back checks and history writes are exempt from these timeouts. Setting `0` (no limit) leaves the database or role default unchanged.

| Dialect    | Lock wait timeout mechanism                                                                                    | Statement timeout mechanism                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| PostgreSQL | `SET lock_timeout = <ms>` (`CREATE/DROP INDEX CONCURRENTLY` and `REINDEX ... CONCURRENTLY` skip it, see below) | `SET statement_timeout = <ms>`                              |
| SQLite     | `PRAGMA busy_timeout = <ms>`                                                                                   | None on the server (lock wait timeout only)                 |
| MySQL      | `SET SESSION lock_wait_timeout = <seconds>` (milliseconds rounded up to whole seconds, minimum `1` s)          | `SET SESSION max_execution_time = <ms>`                     |
| SQL Server | `SET LOCK_TIMEOUT <ms>` (SQL error `1222` maps to timeout)                                                     | Client driver cancels request after `<ms>` (`req.cancel()`) |

PostgreSQL behavior notes:

- **`CONCURRENTLY` index operations skip `lock_timeout`.** `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, and `REINDEX ... CONCURRENTLY` do not block normal reads or writes and instead wait for existing long transactions to drain. Dowel keeps `statement_timeout` active while skipping the default 5-second lock timeout, and skips it when cleaning up `INVALID` indexes before retrying as well.
- **`DETACH PARTITION ... CONCURRENTLY` keeps `lock_timeout`.** Because its second phase takes an access exclusive lock, Dowel keeps `lock_timeout` enforced and switches automatically to `FINALIZE` on retry if a lock timeout left the partition in `detach pending`.

Steps cancelled by policy timeouts return `step_timeout` with the timeout type and configured threshold in logs. Transactional migrations roll back for clean retry, while non-transactional and MySQL migrations resume from checkpoints. The project lock wait limit itself stays fixed at 30 seconds.

## Approval flows {#approval-flow}

An approval flow defines who must approve execution or rollback requests in sequence before a run begins. For request lifecycles and inbox behavior, see [Execution requests and approvals](approvals.md).

- Each **approval stage** specifies the eligible approver pool (Project admins, Admins of the project's group, Executors, Members of a group, Admins of a group, or Specific users) and the required approval count. The final stage may enable Last approver executes.
- **Append-only layer merging.** The effective approval flow concatenates stages from instance, group, project, and environment layers in order. Stages inherited from upper layers appear locked below and cannot be edited or removed.
- **Default single-stage flow.** When no stages are configured across all four layers, authorized users execute directly, and unauthorized users submit requests for an authorized user to approve and execute.
- **Configured multi-stage flows.** Once at least one stage is configured, every execution and rollback (other than mark as applied, which executes no SQL) must go through the approval flow, including for instance admins unless they use [Emergency execution](approvals.md#emergency-execution).
- **Approval grants no execution rights.** The user clicking Execute or Approve and execute must satisfy the environment's "Who can execute" level or hold an executor grant. If the same user appears in multiple stages, they must confirm each stage separately, and only users who can view the project count as eligible approvers.
