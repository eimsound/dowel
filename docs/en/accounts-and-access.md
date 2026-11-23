# Accounts, OIDC, and access

This page explains Dowel's single-company account model, invitations and password resets, OIDC sign-in, group and project role calculation, personal settings, and audit logs.

## Accounts and login {#accounts-and-login}

- **Single-company instance model.** One Dowel deployment serves a single company. Every signed-in user can see all group names and member lists. Projects are visible only to users with access. Unauthorized API queries return `404`, WebSocket connections for inaccessible or missing projects close with code `4401`, and active connections close with code `4403` when a user is disabled or loses access.
- **Username and email rules.** Users sign in with a username and password or an external OIDC identity. Usernames allow lowercase letters, digits, and `-`, from 1 to 39 characters, unique across the instance, and editable in personal settings. Email is an optional profile field. Non-empty addresses are enforced case-insensitively unique across the instance and can receive invitation links or self-service password resets, while remaining invalid as a sign-in username and never used to merge external OIDC identities automatically. When a first-time OIDC user arrives with an email already claimed by another user, Dowel clears email to `null` rather than linking accounts or failing onboarding.
- **Invite-only onboarding.** Open self-registration is disabled. Instance admins can create users directly under Admin (providing an initial password marks the user to change it on first sign-in; leaving it blank restricts the account to external OIDC sign-in), or generate one-time invitation links (`/invite/<token>`, valid for 7 days by default) that let recipients choose a username and password and join pre-assigned groups. Creating an invite accepts an optional recipient email and, when SMTP is enabled, can email the link directly and prefill the email field on the invite page.
- **Forgot password and admin resets.**
  - **Self-service password reset.** When email service is enabled and password sign-in is available, `/login` shows a "Forgot password?" link. Submitting an email returns the same neutral confirmation regardless of whether an account matches; for active password accounts, Dowel sends a one-time `/reset/<token>` link valid for 1 hour and revokes earlier reset tokens.
  - **Admin password reset.** Instance admins can click Reset password on any user row to enter a temporary password or let Dowel generate a one-time random temporary password. Resetting immediately invalidates all active sessions, disconnects active WebSockets with close code `4403`, and requires a password change on the next sign-in.
- **Reset link API compatibility.** The standalone admin reset-link endpoint (`POST /api/admin/users/:id/reset-link` and `/reset/<token>`, valid for 24 hours) remains available. Completing any `/reset/<token>` flow revokes all active sessions and clears the forced password-change flag.
- **Disabling users.** Disabling a user immediately revokes all active sessions and disconnects all open collaboration WebSockets with close code `4403`. Dowel guarantees at least one active instance admin remains enabled and prevents disabling or demoting the last one.

## Configure email service (SMTP) {#smtp}

Instance admins configure SMTP under **Admin -> Settings** (`GET /api/admin/email` and `PATCH /api/admin/email`). Settings live in `instance_settings`, so all replicas in a PostgreSQL high-availability deployment share one configuration. Phase 1 uses SMTP only for invite emails and forgot-password reset links.

1. **Transport security and ports.** Choose `starttls` (default port `587`, fails closed if the server does not advertise `STARTTLS`), `tls` (implicit TLS, default port `465`), or `none` (plaintext internal relay only, default port `25`).
2. **Credentials and environment variables.**
   - Non-empty SMTP passwords are encrypted with `DOWEL_SECRET` (minimum 16 characters) and omitted from API responses. Leave username and password blank for unauthenticated relays without requiring `DOWEL_SECRET`.
   - Set `DOWEL_PUBLIC_URL` (such as `https://dowel.example.com`) so invite and reset links use the canonical external origin.
3. **Test delivery.** Use the separate test form on the settings page (`POST /api/admin/email/test`, rate-limited by `DOWEL_EMAIL_TEST_LIMIT`) to send a test message to any recipient address.

## Configure OIDC sign-in {#oidc}

Dowel supports standard OpenID Connect with Authorization Code flow and PKCE S256. Instance admins configure providers on the Sign-in methods page under Admin, using presets for Google or GitLab or entering any generic OIDC provider.

### Prerequisites {#oidc-prerequisites}

- Set `DOWEL_SECRET` to at least 16 characters. Dowel encrypts each provider's `clientSecret` with this key and never returns plaintext secrets to the list view. If you rotate `DOWEL_SECRET`, re-enter `clientSecret` for each provider.
- Set `DOWEL_PUBLIC_URL` (for example `https://dowel.example.com`) so Dowel generates accurate callback URLs. Behind a reverse proxy, also set `DOWEL_TRUST_PROXY=1`.
- The fixed callback URL format is:

```text
{DOWEL_PUBLIC_URL}/api/auth/oidc/{slug}/callback
```

Here `{slug}` is the identifier you choose when adding the provider, such as `google`, `gitlab`, or `corp-sso`.

### Common setup steps for Google and GitLab {#oidc-providers}

=== "Google"

    1. Create an OAuth 2.0 Client of type Web application in Google Cloud Console.
    2. Set the Authorized redirect URI to `https://your-domain.example/api/auth/oidc/google/callback`.
    3. Add the provider in Admin or via `POST /api/admin/oidc` with `slug` set to `google`, `issuer` set to `https://accounts.google.com`, and `scopes` set to `openid profile email`.

=== "GitLab"

    1. Create an OAuth application under Admin, then Applications in GitLab (`gitlab.com` or self-hosted).
    2. Set the Redirect URI to `https://your-domain.example/api/auth/oidc/gitlab/callback` and select scopes `openid`, `profile`, and `email`.
    3. Set `issuer` to `https://gitlab.com` or your self-hosted GitLab origin such as `https://gitlab.example.com`.
    4. By default, only invited users can sign in and link their account. Set `autoProvision` to `true` if uninvited users should get an account automatically on first OIDC login.

### Linking identities and toggling password login {#oidc-linking}

- **Identity linking.** Signed-in users can link or unlink external OIDC identities at `/account/identities` (linking calls `GET /api/auth/oidc/{slug}/start?mode=link`). Dowel identifies external users strictly by `(provider_id, subject)` and never merges accounts by email address. Unlinking the last usable sign-in method when no password is set returns HTTP `422`.
- **Disabling password login.** Password login can be disabled under Admin only while at least one OIDC provider is enabled. If an OIDC outage locks admins out, set `DOWEL_ALLOW_PASSWORD_LOGIN=1` on the server to re-enable password login temporarily.

## Groups, project roles, and grants {#groups-and-grants}

### Groups and project creation {#groups}

- Groups are flat and never nest. One user may belong to multiple groups.
- Any user can create groups by default and becomes the first group admin of that group. Instance admins can restrict group creation to instance admins only. Inside a group, all group members can create projects by default, or a group admin can restrict project creation to group admins only.
- A group that still owns projects cannot be deleted.
- Moving a project to another group on the Members and grants or Settings page requires group admin permissions in both the source and target groups, or instance admin access. Moving updates the project URL to the new group slug, redirects old URLs automatically, and drops grants and executors scoped to the previous group.

### Project roles and effective access {#project-roles}

A project role controls model access (editing the canvas, importing schemas, publishing versions, and viewing scripts or environments) independently from target database execution privileges. Three roles exist:

- **Viewer.** Read-only access to the model, version chain, migration scripts, environments, and activity log.
- **Editor.** Can edit the working copy, import schemas, publish versions, run manual drift checks, and submit execution requests or execute on environments whose execution policy allows editors.
- **Project admin.** Can manage project grants, update project settings, edit environment connections and shadow databases, delete the project, and configure project-level execution policy.

A user's effective project role is the highest level granted by any of four sources:

1. **Instance admin.** Has full project admin access across all groups and projects.
2. **Group admin of the owning group.** Has project admin access on every project in that group.
3. **Default permission.** Group members inherit the project default permission, or the group default permission when not overridden on the project.
4. **Grant.** Explicit role granted to the user or one of their groups at the project, group, or instance scope.

Role and grant changes take effect immediately. Connected collaboration clients downgrade to read-only or disconnect with close code `4403` without requiring a page reload. Dowel ensures every project keeps at least one project admin and every group keeps at least one group admin, and excludes instance admins from that count.

### Executor grants {#executors}

Alongside project roles, you can grant the Executor role to a user or group at the environment, project, group, or instance scope. An executor grant automatically provides read-only Viewer visibility to the covered projects and permits privileged execution under any "Who can execute" level. When a production environment requires "Executors only", only executors granted by an instance admin are valid; see [Execution policy and executors](execution-policy.md).

### Deleting a project {#delete-project}

Project admins can delete a project from its Settings page by typing the project identifier (`slug`). Deletion runs inside a single transaction to remove the project, room state, version chain, environment configurations, grants, execution policies, and CI tokens from the platform database, disconnects active collaboration sessions, and closes related shadow database pools. Target databases, live schemas, `dowel` migration histories, and audit logs remain intact. You can reconstruct the platform project later through [Takeover and disaster recovery](takeover.md).

## Personal settings, command palette, and audit log {#account-and-audit}

- **Personal settings (`/account`).** Update username, display name, and optional email (`/account`), set or change password (`/account/password`), link OIDC accounts (`/account/identities`), inspect and revoke active browser sessions (`/account/sessions`), and switch UI language or color scheme preferences (`/account/preferences`).
- **Command palette.** Press `⌘K` or `Ctrl+K` to jump across groups and projects, open New project or New group dialogs, and trigger workspace actions.
- **Project activity and instance audit log.**
  - Open Activity inside a project (`/project/:owner/:project/activity`) to review imports, publishes, restores, environment edits, member grants, and execution requests.
  - Instance admins can open the Audit log under Admin (`/admin/audit`) and filter across the entire instance by action prefix, actor, target kind, target ID, and time range.
