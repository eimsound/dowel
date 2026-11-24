# Execution requests and approvals

When a user lacks direct execution rights or an environment defines approval stages, executions and rollbacks run through an **execution request**. You submit a request, collect approvals across every stage, and trigger execution once approved. For four-layer policy merging, see [Execution policy and executors](execution-policy.md#approval-flow); for webhook alerts, see [Group webhooks](webhooks.md).

## When an execution request is required {#when-to-request}

| Approval flow configuration    | Users with execution permission                              | Users without execution permission                                |
| ------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Default (no stages configured) | Click Execute migrations or Roll back migrations directly    | Submit request; an authorized user clicks Approve and execute     |
| One or more stages configured  | Must submit an execution request first (instance admins too) | Submit request; once all stages pass, an authorized user executes |

When approval is required, buttons on the environment page read Submit execution request or Request rollback. Project editors and above, or environment executors, can submit requests; viewers cannot. Write baseline and [mark as applied](execution.md#mark-as-applied) execute no SQL and bypass approval flows while remaining subject to "Who can execute".

## Submission and snapshot invalidation {#submit-and-invalidation}

Opening the request submission dialog automatically runs a complete [dry run](execution.md#dry-run). You cannot submit a request if the dry run fails. Submitting captures optional notes and binds the request to:

- The starting version (the environment's current version at submission), target version, and direction (execute or roll back).
- The `checksum` of every migration on the path.
- The environment's effective approval flow snapshot at submission time.
- The environment's connection fingerprint and production flag.

### What invalidates a request {#invalidation-reasons}

Any underlying state change before execution begins marks the request invalid automatically and notifies the requester:

- The environment's current version changed because another request, a CI token, a manual execution or rollback, or a mark as applied ran first.
- Drift was detected on the target database.
- A script on the path was edited, or the target version state changed.
- The environment's connection string or production flag changed.
- A version referenced by the request was [retired](execution.md#retire). Requests that upgrade to or through a retired version become invalid; a request that rolls back a retired version becomes invalid only if the version was retired after the request was submitted, so switch requests submitted after a retire stay valid.
- The approval flow tightened (stages added, stricter pools, or higher approval counts). If the policy loosened, open requests continue under the stricter snapshot captured at submission.

Requests also expire automatically after the policy TTL (default `24` hours, configurable from `1` to `720` hours across layers).

The server runs periodic distributed sweeps across open requests and triggers immediate re-checks after executions, drift scans, script edits, and policy saves. Before executing an approved request, the executor re-verifies the live current version and migration checksums inside the target database project lock so stale cached state can never execute.

### Switch requests {#switch-requests}

When an environment is on a [retired version](execution.md#switch) and needs to return to the active chain, you submit a **switch request**: it rolls back to the common ancestor, then upgrades to the target version. The request detail lists the rollback segment and the upgrade segment separately (rolled-back versions are tagged "Rollback") and binds the checksums of both segments; submitting requires confirming that the rollback segment may cause data loss. Whoever executes a switch request must hold both execute and rollback permission; the approval flow is the same as for execution requests, and production still requires typing the environment name.

## Approval and execution handover {#approval-and-handover}

- **Sequential stage progression.** Each stage unlocks the next stage and notifies its approvers only after reaching the required approval count. Rejecting a request at any stage (a reason is required) closes the request immediately.
- **Four-eyes principle and per-stage confirmation.** A requester cannot approve their own request even if they belong to an approver pool. If one user appears in multiple stages, each approval click confirms only the current stage.
- **Live eligibility at approval time.** Approver eligibility is checked dynamically using group memberships, grants, and project visibility at the moment of the action.
- If membership or policy changes leave a stage with fewer eligible approvers than its required count, the request page displays a warning so an admin can adjust grants or the approval flow.

### Who triggers final execution {#who-triggers-execution}

Approval alone never grants execution rights. The user clicking Execute or Approve and execute must satisfy the environment's "Who can execute" rule or hold an executor grant:

- **Last approver executes enabled (default single-stage behavior).** When the final approval slot in the last stage is filled, clicking Approve and execute approves and runs the migration in one action. An approver without execution rights cannot click it; the UI instructs an authorized executor to take over.
- **Last approver executes disabled.** After all stages approve, the request moves to Approved, and any user with execution permission (including the requester if authorized) can click Execute.

Production executions require typing the environment name. If execution fails with a recoverable error such as a lock wait timeout while the bound state remains valid, you can click Retry execution on the request page; if the environment state changed, the request turns Invalid. Before execution begins, the requester can withdraw the request at any time.

## Emergency execution {#emergency-execution}

During urgent production incidents, **only an instance admin** can trigger emergency execution or emergency rollback from the environment details page:

- **Skips approval only, never safety checks.** Project locks, chain integrity, instance claims, drift checks, and shadow verification remain strictly enforced.
- Requires entering an emergency reason and checking confirmation (plus typing the environment name on production).
- Writes dedicated audit records and notifies **every approver in the environment's approval flow** through the in-app inbox and group webhooks when execution starts and finishes (including failures or invalidated pre-checks).
- Emergency runs appear in the request list with an Emergency badge. Failed emergency runs cannot be retried or withdrawn; verify the environment state and initiate a new emergency run or regular request.

## Inbox and audit trail {#inbox-and-audit}

The inbox icon displays live unread counts via SSE (synchronized across replicas over PostgreSQL `LISTEN/NOTIFY` in HA mode):

- **Waiting for me.** Open requests currently awaiting your approval, plus fully approved requests ready for you to execute.
- **Notifications.** New approval prompts, status updates on your submitted requests (approved, rejected, invalidated, expired, executed, or failed), emergency execution alerts, and **production CI token execution notices**. Production token notices notify project admins and environment approvers only when migrations execute or fail; non-production runs, `noop` runs, dry runs, and pre-check rejections emit no inbox notices (see [CI HTTP API](api.md#execution-rules)).
- **My requests.** All execution requests you submitted.

The inbox filters strictly by projects you currently have permission to view. Losing project access immediately hides and excludes notifications from that project. Submissions, stage approvals, rejections, withdrawals, invalidations, expirations, execution starts and completions, and emergency executions all write to the audit log and the request timeline.

## Known limitations {#limitations}

- For active-active HA architecture details, including lease recovery for running requests when a replica crashes, see [Multi-replica high availability](deployment.md#ha).
- Built-in email (SMTP) notifications are not implemented. Use the in-app inbox or [Group webhooks](webhooks.md).
