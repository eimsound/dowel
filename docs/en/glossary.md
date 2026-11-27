# Glossary

This glossary defines the core concepts and canonical terms used across Dowel documentation and UI.

## Accounts and ownership {#accounts-and-ownership}

- **Instance.** A single Dowel deployment serving one company.
- **User.** A person with a unique username inside an instance who signs in with a username and password or an external OIDC identity. Email is an optional profile field enforced case-insensitively unique when set, used for forgot-password resets and invite delivery, and never used as a sign-in username.
- **Instance admin.** A user who manages the entire instance, has visibility across all groups, projects, and audit logs, and holds all privileges.
- **Group.** A flat collection of users that owns projects. Groups and their member lists are visible to every signed-in user, while projects inside a group are visible only to authorized users. One user may belong to multiple groups.
- **Group admin.** A group member who manages that group's membership, group execution policy, group webhooks, and default permission on projects in the group.

## Permissions and governance {#permissions-and-governance}

- **Project role.** Access level on a project's model, ordered as Viewer, Editor, and Project admin. Project roles govern schema modeling and publishing rather than direct execution against production target databases.
- **Default permission.** The project role that members of a group inherit automatically on projects in that group. Each group sets a default that group admins can override per project.
- **Grant.** Assigning a project role or Executor role to a user or group across one of four scopes: an environment, a single project, all projects in a group, or the entire instance.
- **Executor.** A user or group explicitly granted permission to perform privileged operations within a scope (for example, a DBA group), and eligible under every "Who can execute" level.
- **Privileged operation.** An action that writes directly to a target database or weakens environment safeguards, including executing, rolling back, marking as applied, changing connection or shadow database settings, unmarking production, deleting an environment, and attaching existing history. Model editing and publishing are not privileged operations.
- **Execution policy.** A tighten-only rule set configured across four layers (instance, group, project, and environment) governing who can execute, lock and statement timeouts, CI token execution, request lifetime, and approval flows.
- **Execution request.** A formal request to apply or roll back an environment to a target version, approved stage by stage according to the environment's approval flow before execution.
- **Emergency execution.** An instance-admin action that skips the approval flow to apply or roll back directly during incidents. It requires a written reason, enforces drift, integrity, claim, and verification checks, records dedicated audit entries, and notifies every approver on the environment.
- **Approval flow.** An ordered sequence of approval stages defined in an execution policy. The default flow contains a single stage.
- **Approval stage.** One step in an approval flow specifying eligible approvers and the required approval count.
- **CI token.** A project-scoped credential with a required expiration (maximum 365 days) for automated pipelines. It can query state and apply forward migrations on environments where CI token execution is enabled, and cannot edit models, publish versions, or roll back.
- **MCP token.** A user-scoped credential that lets an AI coding assistant access Dowel as that user through the MCP server. Its permission is the intersection of the user's current project role and the token's permissions (read / verify in shadow database / edit working copy), optionally limited to selected projects, and it always expires. It can't publish or execute and never connects to target databases.

## Projects and environments {#projects-and-environments}

- **Project.** A modeling unit belonging to a group and bound to one database dialect. Each project contains a real-time collaborative working copy, a version chain, and zero or more environments.
- **Environment.** A named deployment target inside a project, such as `dev`, `staging`, or `prod`. Each environment maps to one independent target database.
- **Target database.** The real database an environment points to, where migrations run and where Dowel writes its migration history.
- **Shadow database.** A dedicated database used solely for SQL imports, expression normalization, round-trip verification, and measured lock or rewrite analysis without touching business target data. SQLite uses an in-process `:memory:` shadow database, while PostgreSQL, MySQL, and SQL Server use a configured shadow URL or `{database}_dowel` on the same instance.
- **Import.** Reading schema structure from a target database's system catalogs or a `.sql` script to initialize or update a project model. Imports inspect structure only and never touch data or restore version history.
- **Takeover.** Rebuilding a complete Dowel platform project from migration history stored inside a target database's `dowel` schema (or `dowel_` tables in SQLite and MySQL). Takeover preserves the version chain, stable object IDs, and frozen scripts after platform loss, server migration, or cross-instance handoff.
- **Claim.** Switching the claiming instance recorded in a target database's migration history to the current Dowel instance, confirmed by an instance admin. Once claimed, executions from the previous instance are rejected while read-only drift checks and history reads remain available.

## Canvas {#canvas}

- **Section.** A named, color-coded visual grouping on the canvas that boxes related tables together and collapses into a summary card. Sections live only in canvas layout metadata and never alter the schema model, SQL output, migrations, diffs, or versions. A table belongs to at most one section, sections never nest, and sections have no relation to database schemas. Section names, colors, and table assignments sync across the project, while collapse and neighborhood focus states stay local to each user's browser.

## Versions and migrations {#versions-and-migrations}

- **Working copy.** The live, collaboratively edited model inside a project that has not yet been frozen as a version.
- **Version.** An immutable snapshot of the working copy taken at publish time. Published versions form an ordered linear chain.
- **Migration.** The upgrade (`up`) and rollback (`down`) scripts between two adjacent versions on the chain, generated and frozen when publishing so every environment runs identical SQL.
- **Publish.** Saving the working copy as the next immutable version on the chain and freezing its migration scripts.
- **Apply.** Executing one or more frozen migrations sequentially against an environment's target database (upgrade or rollback).
- **Drift.** A state where a target database's live structure differs from the model of its current version, typically caused by out-of-band manual DDL changes.
- **Retire.** Marking one or more consecutive non-first versions at the end of the active chain as no longer part of it. The versions, their frozen migrations and the target history are kept and numbers are never reused; until a newer version is published from the parent you can **unretire** them. You cannot execute to, or mark an environment as applied to, a retired version.
- **Active chain.** The chain from the first version to the active chain head (the highest-numbered version that is not retired). New versions use the head as their parent; in a target history, the path from the root to the highest number is the active chain.
- **Switch.** Bringing an environment on a retired version back to the active chain through the common ancestor: roll back to the ancestor, then upgrade to the target. It must be confirmed in the web UI; CI tokens never roll back automatically.
- **Apply to canvas.** Replacing the working copy with any version's model (retired versions included) as a new commit in canvas history.
- **Mark as applied.** Recording an environment at version `X` in migration history without executing SQL after verifying that the live database structure matches version `X`'s model exactly. Used after applying hotfixes out of band, finishing failed runs manually, or rolling back by hand. Writing a baseline on first execution is a special case.
- **Repair script.** An on-demand SQL script generated for a drifted environment to revert the live structure back to its current version model. Shown for manual review and copy only; Dowel never executes repair scripts or records them in the version chain.
