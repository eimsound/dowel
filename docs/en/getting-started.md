# Getting started

This guide walks through starting Dowel locally, setting up the instance, creating a project, publishing a version, verifying migrations, and executing them against a target database. For production operations, account rules, and dialect details, see the dedicated guides.

## 1. Start the server {#start-service}

Start the single container with Docker Compose. By default, Dowel stores its platform database in a SQLite file inside the `dowel-data` volume.

```sh
docker compose up -d
```

Before starting, edit `docker-compose.yml` in the repository root and set `DOWEL_SECRET` to a random string of at least 16 characters. Dowel uses `DOWEL_SECRET` to encrypt database connection strings, OIDC client secrets, and webhook URLs or secrets in the platform database. Do not change this secret after you save environments or secrets.

For building from source, using an external PostgreSQL platform database, running multiple replicas for high availability, or configuring a reverse proxy, read [Deployment and configuration](deployment.md).

## 2. Set up the instance and create a group {#setup-and-group}

1. On first startup when no users exist yet, Dowel automatically creates the initial instance admin (username defaults to `admin`, or the value of `DOWEL_ADMIN_USERNAME`):
   - When no preset password is configured, the server generates a random temporary password and writes it with mode `0600` to `initial-admin-password` in the data directory (`/data/initial-admin-password` inside the `dowel-data` volume under Docker Compose). Startup logs print the file path only, never the plaintext password.
   - Open <http://localhost:4600> and sign in as `admin` with that temporary password. Dowel routes you directly to the password-change page, and automatically removes `initial-admin-password` once you set your new password.
   - To supply an operator-managed password without forcing a password change on first login, set `DOWEL_ADMIN_PASSWORD_FILE` or `DOWEL_ADMIN_PASSWORD` before startup (setting both causes startup to fail).
2. After signing in, open Admin or the home page and create a group. Every project belongs to a group and lives at `/project/<group-slug>/<project-slug>`.

For user invites, OIDC sign-in, and access rules, read [Accounts, OIDC, and access](accounts-and-access.md).

## 3. Create a project with the four-step wizard {#create-project}

On the My projects page, click New project, or press `⌘K` to open the command palette and choose New project. This opens the `/new` wizard.

1. **Basics.** Select a group, enter a project name and identifier, and pick the target database dialect:
   - PostgreSQL 15 to 19.
   - SQLite. Using a local SQLite file as a target database requires `DOWEL_SQLITE_ROOTS` on the server. Modeling and SQL import require no target environment because SQLite includes a built-in `:memory:` shadow database.
   - MySQL 8.4 and 9.7.
   - SQL Server 2019, 2022, and 2025.
2. **Databases.** Add one or more environments such as `dev`, `staging`, or `prod`. Click Check connection to inspect the database version, account privileges, and existing table count.
   - For SQLite projects, you can skip this step. SQL import and migration verification use the built-in `:memory:` shadow database.
   - For PostgreSQL, MySQL, and SQL Server projects, importing SQL and verifying migrations require at least one reachable real shadow database. Dowel creates `{database}_dowel` on the target instance by default, or you can enter a separate shadow database URL in environment settings. Production environments disallow same-instance shadow databases by default.
3. **Initial content.** Choose one of four starting points:
   - Empty. Start with the dialect default schema, such as `public`, `main`, `default`, or `dbo`.
   - Import from a database. Read the existing structure from an attached environment. This operation is read-only and never writes to the target database.
   - Import from SQL. Paste or upload a `.sql` schema script. Dowel runs it in the shadow database and reads the resulting model.
   - Take over an existing project. Restore the full version chain and object IDs from a target database that already contains `dowel` migration history. See [Takeover and disaster recovery](takeover.md).
4. **Confirm.** Review the project and environment summary. Projects created from an import automatically publish `v0 · Baseline`. Creating the project writes only to the Dowel platform database and never modifies the target database or creates `dowel` history tables.

## 4. Edit the model and publish a version {#edit-and-publish}

1. Open the project canvas to drag tables or use the right-hand properties panel to edit tables, columns, primary keys, unique constraints, foreign keys, CHECK constraints, indexes, and dialect options.
2. When you rename a table or column, Dowel keeps the same object ID and updates derived names and expression references automatically. You can inspect canvas history from the top-right toolbar button and restore any earlier state.
3. Click Publish and enter a version name to freeze the working copy as an immutable version. Publishing generates both upgrade (`up`) and rollback (`down`) migration scripts.

For object IDs, import permissions, shadow database boundaries, and PostgreSQL partition editing, read [Modeling, versions, and canvas history](modeling.md). For SQL syntax and engine differences across versions, read [Dialects and version support](dialects.md).

## 5. Verify migrations in the shadow database {#verify-migration}

Open the Versions or Migration view, select two versions to generate upgrade and rollback scripts, and click Verify in shadow database.

- Dowel executes the upgrade script in the dialect shadow database, verifies that the resulting schema matches the target version, and then executes the rollback script to verify that the schema returns to the source version. It also runs the same readback check as execution. These are the exact scripts publishing would freeze, so a migration that passes here also passes verification when you publish it.
- Dowel measures each statement and builds a step-by-step risk summary showing lock modes, table rewrites, sequential scans, or MySQL algorithm levels (`INSTANT`, `INPLACE`, or `COPY`).
- By default the check covers all environments: like publishing, Dowel groups the project environments by full database version (such as PG `16.4` or MySQL `8.4.3`), verifies on one shadow database per version, and lists environments that have no usable shadow database of the same version. You can also pick a single environment to verify only on its shadow database.

You can also download the `.sql` migration script with pinned session settings for manual review or execution.

## 6. Dry run and execute to a target database {#apply-to-target}

On the environment details page, click Execute migrations for a target version, or choose an earlier version to roll back.

1. Opening the confirmation dialog runs a read-only dry run. Dowel checks the project lock, version chain integrity, instance claim, live drift, verification status, and history table write permissions without modifying the target database.
2. Confirm execution once the dry run passes. Production environments require typing the environment name. If the environment has approval stages configured, the button reads Submit execution request, and execution waits until every stage is approved.
3. On the first execution against a target database, Dowel creates the `dowel` schema, or `dowel_` prefixed tables in SQLite and MySQL, records execution history, and reads back the target structure after each migration to verify parity.

Continue with the guides below for checkpoint recovery, drift handling, and CI automation:

- [Execution, rollback, and drift](execution.md)
- [Execution policy and executors](execution-policy.md)
- [Execution requests and approvals](approvals.md)
- [CI HTTP API](api.md) and [CI pipeline integration](ci-action.md)
