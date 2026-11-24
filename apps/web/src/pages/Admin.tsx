// 管理后台（/admin）：只有实例管理员能进；其他人看到普通的 404 页，不暴露后台存在。
// 导航和“个人设置”一样放在外壳的侧面板里（useShellPanel）；每节是独立的嵌套路由。
// 涉及“最后一个管理员”“关闭密码登录”这类保护时，服务端返回 422，界面原样显示它的说明。
import type {
  AdminResetPasswordResult,
  AdminUser,
  AuditEvent,
  AuditPage,
  Directory,
  EmailSettings,
  GrantInfo,
  GrantRole,
  GrantSubjectKind,
  InstanceRole,
  InstanceSettings,
  InviteCreated,
  InviteListItem,
  OidcProviderInfo,
  OidcProviderPreset,
  Ok,
  SmtpSecurity,
  UserStatus,
} from '@dowel/api';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  Copy,
  Gauge,
  KeyRound,
  MailPlus,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { actionText, viaMcp } from '../activity.ts';
import { api } from '../api.ts';
import { AdminUserMcpTokens, McpBadge } from '../components/McpTokens.tsx';
import { Confirm, Modal } from '../components/Modal.tsx';
import { PolicyLayerPanel } from '../components/PolicyEditor.tsx';
import { Row, Rows, Section } from '../components/ProjectPage.tsx';
import { SettingsNav } from '../components/SettingsNav.tsx';
import { AppShell, PageHeader, useShellPanel } from '../components/Shell.tsx';
import { useToast } from '../components/Toasts.tsx';
import { TokenPolicyPanel } from '../components/TokenSettings.tsx';
import { Avatar, Banner, Empty, IconButton } from '../components/ui.tsx';
import { formatTime } from '../format.ts';
import { useInstance } from '../instance.ts';
import { useMe } from '../session.ts';

const SECTIONS = [
  { to: '/admin', label: 'adm.navUsers', icon: Users },
  { to: '/admin/invites', label: 'adm.navInvites', icon: MailPlus },
  { to: '/admin/sign-in', label: 'adm.navSignIn', icon: KeyRound },
  { to: '/admin/settings', label: 'adm.navSettings', icon: SettingsIcon },
  { to: '/admin/grants', label: 'adm.navGrants', icon: ShieldCheck },
  { to: '/admin/policy', label: 'pol.title', icon: Gauge },
  { to: '/admin/audit', label: 'adm.navAudit', icon: ScrollText },
] as const;

/** 不是实例管理员：一律当作页面不存在（G4 的同样做法，不暴露后台存在） */
const NotFound = () => {
  const { t } = useTranslation();
  return (
    <div className="grid h-dvh place-items-center px-4">
      <div className="space-y-3 text-center">
        <p className="text-lg font-medium">{t('err.notFound')}</p>
        <Link to="/" className="btn">
          {t('nav.myProjects')}
        </Link>
      </div>
    </div>
  );
};

export const AdminLayout = () => {
  const me = useMe().data;
  if (!me) return null;
  if (me.role !== 'admin') return <NotFound />;
  return (
    <AppShell me={me}>
      <AdminShell />
    </AppShell>
  );
};

const AdminShell = () => {
  const { t } = useTranslation();
  const path = useRouterState({ select: (s) => s.location.pathname });
  useShellPanel(
    t('adm.panel'),
    <SettingsNav
      label={t('adm.panel')}
      path={path}
      items={SECTIONS.map((s) => {
        const Icon = s.icon;
        return { to: s.to, label: t(s.label), icon: <Icon size={16} aria-hidden="true" /> };
      })}
    />,
    [path, t],
  );
  return (
    <>
      <PageHeader crumbs={[{ label: t('nav.myProjects'), to: '/' }, { label: t('nav.admin') }]} />
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1100px] space-y-6 px-6 py-6">
          <Outlet />
        </div>
      </main>
    </>
  );
};

/** 一次性链接：只显示这一次，带复制按钮（DESIGN.md：code-block + 幽灵按钮） */
const OneTimeLink = ({
  label,
  hint,
  url,
  onDismiss,
}: {
  label: string;
  hint: string;
  url: string;
  onDismiss: () => void;
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(new URL(url, location.origin).toString());
    setCopied(true);
  };
  return (
    <Banner
      kind="ok"
      title={label}
      action={
        <span className="flex items-center gap-1.5">
          <button type="button" className="btn sm" onClick={() => void copy()}>
            <Copy size={14} aria-hidden="true" />
            {copied ? t('adm.copied') : t('adm.copy')}
          </button>
          <button type="button" className="btn ghost sm" onClick={onDismiss}>
            {t('adm.cancel')}
          </button>
        </span>
      }
      role="status"
    >
      <span className="block">{hint}</span>
      <code className="mt-1 block truncate rounded-xs bg-surface-2 px-1.5 py-1 font-mono text-xs">
        {new URL(url, location.origin).toString()}
      </code>
    </Banner>
  );
};

/** 一次性临时密码：只显示这一次，带复制按钮 */
const OneTimeSecret = ({
  label,
  hint,
  secret,
  onDismiss,
}: {
  label: string;
  hint: string;
  secret: string;
  onDismiss: () => void;
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
  };
  return (
    <Banner
      kind="ok"
      title={label}
      action={
        <span className="flex items-center gap-1.5">
          <button type="button" className="btn sm" onClick={() => void copy()}>
            <Copy size={14} aria-hidden="true" />
            {copied ? t('adm.copied') : t('adm.copy')}
          </button>
          <button type="button" className="btn ghost sm" onClick={onDismiss}>
            {t('adm.cancel')}
          </button>
        </span>
      }
      role="status"
    >
      <span className="block">{hint}</span>
      <code className="mt-1 block truncate rounded-xs bg-surface-2 px-1.5 py-1 font-mono text-xs select-all">
        {secret}
      </code>
    </Banner>
  );
};

const ResetPasswordModal = ({
  user,
  onClose,
  onReset,
}: {
  user: AdminUser | null;
  onClose: () => void;
  onReset: (res: AdminResetPasswordResult, username: string) => void;
}) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const hintId = useId();
  const errId = useId();

  const validate = (val: string) =>
    val.length > 0 && val.length < 8 ? t('account.passwordTooShort') : undefined;

  const resetFormState = () => {
    setPassword('');
    setDirty(false);
    setError(undefined);
    resetMutation();
  };

  const handleClose = () => {
    resetFormState();
    onClose();
  };

  const {
    mutate,
    reset: resetMutation,
    isPending,
    error: apiError,
  } = useMutation({
    mutationFn: (body: { id: string; password?: string }) =>
      api<AdminResetPasswordResult>(
        'POST',
        `/api/admin/users/${body.id}/reset-password`,
        body.password ? { password: body.password } : {},
      ),
    onSuccess: (res) => {
      const username = user?.username ?? '';
      resetFormState();
      onReset(res, username);
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const nextError = validate(password);
    if (nextError) {
      setDirty(true);
      setError(nextError);
      inputRef.current?.focus();
      return;
    }
    mutate({ id: user.id, password: password || undefined });
  };

  return (
    <Modal
      open={!!user}
      onClose={handleClose}
      size="sm"
      title={user ? t('adm.resetPasswordTitle', { username: user.username }) : ''}
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className="btn" disabled={isPending} onClick={handleClose}>
            {t('adm.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            className="btn primary"
            disabled={isPending}
            aria-busy={isPending}
          >
            {t('adm.resetPasswordSubmit')}
          </button>
        </>
      }
    >
      <form id={formId} className="space-y-3" noValidate onSubmit={onSubmit}>
        <p className="text-sm text-text-2">{t('adm.resetPasswordBody')}</p>
        <p className="text-sm text-text-2">{t('mcp.adminRevokeAllNote')}</p>
        <label className="field">
          <span className="label">{t('adm.resetPasswordField')}</span>
          <input
            ref={inputRef}
            className="input"
            type="password"
            value={password}
            autoComplete="new-password"
            aria-invalid={error ? 'true' : 'false'}
            aria-describedby={error ? `${errId} ${hintId}` : hintId}
            onChange={(e) => {
              setPassword(e.target.value);
              setDirty(true);
              setError(undefined);
              if (apiError) resetMutation();
            }}
            onBlur={() => {
              if (!dirty) return;
              setError(validate(password));
            }}
          />
          <p id={hintId} className="hint">
            {t('adm.resetPasswordHint')}
          </p>
          {error && (
            <p id={errId} className="hint error">
              {error}
            </p>
          )}
        </label>
        {apiError && (
          <Banner kind="danger" role="alert">
            {apiError.message}
          </Banner>
        )}
      </form>
    </Modal>
  );
};

const ROLE_OPTIONS: InstanceRole[] = ['member', 'admin'];

export const AdminUsers = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const [q, setQ] = useState('');
  const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [mcpTarget, setMcpTarget] = useState<AdminUser | null>(null);
  const [disableTarget, setDisableTarget] = useState<AdminUser | null>(null);
  const [create, setCreate] = useState({
    username: '',
    name: '',
    email: '',
    password: '',
    role: 'member' as InstanceRole,
  });
  const users = useQuery({
    queryKey: ['admin-users', q],
    queryFn: () => api<AdminUser[]>('GET', `/api/admin/users?q=${encodeURIComponent(q)}`),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin-users'] });

  const patch = useMutation({
    mutationFn: (x: { id: string; body: { role?: InstanceRole; status?: UserStatus } }) =>
      api<AdminUser>('PATCH', `/api/admin/users/${x.id}`, x.body),
    onSuccess: () => {
      toast(t('adm.updated'));
      refresh();
    },
  });
  const disable = useMutation({
    mutationFn: (id: string) => api<AdminUser>('PATCH', `/api/admin/users/${id}`, { status: 'disabled' }),
    onSuccess: () => {
      setDisableTarget(null);
      toast(t('adm.updated'));
      refresh();
    },
  });
  const add = useMutation({
    mutationFn: () =>
      api<AdminUser>('POST', '/api/admin/users', {
        username: create.username,
        name: create.name,
        email: create.email.trim() || undefined,
        password: create.password || undefined,
        role: create.role,
      }),
    onSuccess: () => {
      setCreate({ username: '', name: '', email: '', password: '', role: 'member' });
      toast(t('adm.created'));
      refresh();
    },
  });
  const error = patch.error ?? add.error;
  const userActionPending = patch.isPending || disable.isPending;

  return (
    <>
      <Section title={t('adm.navUsers')} count={users.data?.length}>
        <div className="space-y-3">
          <input
            className="input max-w-sm"
            type="search"
            aria-label={t('adm.search')}
            placeholder={t('adm.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {error && (
            <Banner kind="danger" role="alert">
              {error.message}
            </Banner>
          )}
          {tempPassword && (
            <OneTimeSecret
              label={t('adm.resetPasswordTempTitle', { username: tempPassword.username })}
              hint={t('adm.resetPasswordTempHint')}
              secret={tempPassword.password}
              onDismiss={() => setTempPassword(null)}
            />
          )}
          <div className="overflow-x-auto rounded-md border border-border bg-panel">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('adm.username')}</th>
                  <th scope="col">{t('adm.role')}</th>
                  <th scope="col">{t('adm.status')}</th>
                  <th scope="col">{t('adm.lastLogin')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('adm.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(users.data ?? []).map((u) => (
                  <tr key={u.id}>
                    <td>
                      <span className="flex items-center gap-2">
                        <Avatar name={u.name} color="var(--peer-2)" />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-base">{u.name}</span>
                            {u.mustChangePassword && (
                              <span className="badge warn shrink-0">{t('adm.mustChangePassword')}</span>
                            )}
                          </span>
                          <span className="block truncate font-mono text-xs text-text-3">
                            {u.username}
                            {u.email ? ` · ${u.email}` : ''}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td>
                      <select
                        className="select w-32"
                        aria-label={`${t('adm.role')} · ${u.username}`}
                        value={u.role}
                        disabled={userActionPending}
                        onChange={(e) =>
                          patch.mutate({ id: u.id, body: { role: e.target.value as InstanceRole } })
                        }
                      >
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r} value={r}>
                            {t(r === 'admin' ? 'adm.roleAdmin' : 'adm.roleMember')}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className="flex items-center gap-2">
                        {/* 状态用“圆点 + 文字”：文字保持正文色（12.5px 的 ok 色达不到 4.5:1） */}
                        <span
                          aria-hidden="true"
                          className={`size-[7px] rounded-full ${
                            u.status === 'active' ? 'bg-ok' : 'bg-border-strong'
                          }`}
                        />
                        <span className={u.status === 'active' ? 'text-text' : 'text-text-3'}>
                          {t(u.status === 'active' ? 'adm.active' : 'adm.disabled')}
                        </span>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={userActionPending}
                          onClick={() => {
                            // 停用会吊销会话与全部 MCP 令牌，先确认；启用直接生效
                            if (u.status === 'active') {
                              disable.reset();
                              setDisableTarget(u);
                            } else {
                              patch.mutate({ id: u.id, body: { status: 'active' } });
                            }
                          }}
                        >
                          {t(u.status === 'active' ? 'adm.disable' : 'adm.enable')}
                        </button>
                      </span>
                    </td>
                    <td>
                      <time dateTime={u.lastLoginAt ?? undefined} className="text-xs text-text-3">
                        {u.lastLoginAt ? formatTime(u.lastLoginAt) : '—'}
                      </time>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={userActionPending || u.id === me?.id}
                        onClick={() => setResetTarget(u)}
                      >
                        {t('adm.resetPassword')}
                      </button>
                      <button
                        type="button"
                        className="btn sm ml-1.5"
                        aria-label={t('mcp.adminOpen', { username: u.username })}
                        onClick={() => setMcpTarget(u)}
                      >
                        {t('mcp.adminButton')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {users.data?.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-text-3">{t('adm.empty')}</p>
            )}
          </div>
        </div>
      </Section>

      <Section title={t('adm.createTitle')}>
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-panel p-4"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <label className="field w-44">
            <span className="label">{t('adm.username')}</span>
            <input
              className="input font-mono"
              value={create.username}
              onChange={(e) => setCreate({ ...create, username: e.target.value })}
              required
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="field w-44">
            <span className="label">{t('adm.name')}</span>
            <input
              className="input"
              value={create.name}
              onChange={(e) => setCreate({ ...create, name: e.target.value })}
              required
              autoComplete="off"
            />
          </label>
          <label className="field w-52">
            <span className="label">{t('adm.email')}</span>
            <input
              className="input"
              type="email"
              value={create.email}
              onChange={(e) => setCreate({ ...create, email: e.target.value })}
              autoComplete="off"
            />
          </label>
          <label className="field w-40">
            <span className="label">{t('adm.password')}</span>
            <input
              className="input"
              type="password"
              value={create.password}
              onChange={(e) => setCreate({ ...create, password: e.target.value })}
              minLength={8}
              autoComplete="new-password"
            />
          </label>
          <label className="field w-36">
            <span className="label">{t('adm.role')}</span>
            <select
              className="select"
              value={create.role}
              onChange={(e) => setCreate({ ...create, role: e.target.value as InstanceRole })}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {t(r === 'admin' ? 'adm.roleAdmin' : 'adm.roleMember')}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn primary" disabled={add.isPending} aria-busy={add.isPending}>
            <UserPlus size={16} aria-hidden="true" />
            {t('adm.create')}
          </button>
          <p className="hint w-full">{t('adm.passwordHint')}</p>
        </form>
      </Section>
      <ResetPasswordModal
        user={resetTarget}
        onClose={() => setResetTarget(null)}
        onReset={(res, username) => {
          setResetTarget(null);
          setTempPassword({ username, password: res.password });
          toast(t('adm.resetPasswordDone'));
          refresh();
        }}
      />
      <AdminUserMcpTokens user={mcpTarget} onClose={() => setMcpTarget(null)} />
      <Confirm
        open={!!disableTarget}
        onClose={() => {
          setDisableTarget(null);
          disable.reset();
        }}
        title={t('adm.disableTitle', { username: disableTarget?.username ?? '' })}
        confirmLabel={t('adm.disableConfirm')}
        pending={disable.isPending}
        error={disable.error?.message}
        onConfirm={() => disableTarget && disable.mutate(disableTarget.id)}
      >
        {t('adm.disableBody')}
      </Confirm>
    </>
  );
};

export const AdminInvites = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const instance = useInstance();
  const emailEnabled = instance.data?.emailEnabled ?? false;
  const [days, setDays] = useState('7');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [sendEmail, setSendEmail] = useState(false);
  const [created, setCreated] = useState<InviteCreated | null>(null);
  const willSendEmail = emailEnabled && sendEmail;
  const invites = useQuery({
    queryKey: ['admin-invites'],
    queryFn: () => api<InviteListItem[]>('GET', '/api/admin/invites'),
  });
  const groups = useQuery({
    queryKey: ['groups'],
    queryFn: () => api<{ groups: { id: string; name: string }[] }>('GET', '/api/groups'),
  });
  const create = useMutation({
    mutationFn: () =>
      api<InviteCreated>('POST', '/api/admin/invites', {
        expiresInDays: Number(days) || 7,
        groupIds,
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(willSendEmail ? { sendEmail: true } : {}),
      }),
    onSuccess: (invite) => {
      setCreated(invite);
      setGroupIds([]);
      setEmail('');
      setSendEmail(false);
      void qc.invalidateQueries({ queryKey: ['admin-invites'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/admin/invites/${id}`),
    onSuccess: () => {
      toast(t('adm.invite.revoked'));
      void qc.invalidateQueries({ queryKey: ['admin-invites'] });
    },
  });

  return (
    <>
      <Section title={t('adm.invite.create')}>
        <form
          className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-panel p-4"
          aria-label={t('adm.invite.create')}
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="field w-32">
            <span className="label">{t('adm.invite.expires')}</span>
            <input
              className="input"
              type="number"
              name="expiresInDays"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </label>
          <label className="field w-64">
            <span className="label">{t('adm.invite.email')}</span>
            <input
              className="input"
              type="email"
              name="inviteEmail"
              value={email}
              required={willSendEmail}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <fieldset className="field w-64">
            <legend className="label mb-1">{t('adm.invite.groups')}</legend>
            <div className="max-h-24 overflow-auto rounded-sm border border-border px-2 py-1.5">
              <div className="checks flex-col items-start gap-1">
                {(groups.data?.groups ?? []).map((g) => (
                  <label key={g.id} className="check">
                    <input
                      type="checkbox"
                      checked={groupIds.includes(g.id)}
                      onChange={(e) =>
                        setGroupIds(
                          e.target.checked ? [...groupIds, g.id] : groupIds.filter((x) => x !== g.id),
                        )
                      }
                    />
                    <span className="truncate">{g.name}</span>
                  </label>
                ))}
              </div>
            </div>
            <span className="hint">{t('adm.invite.noGroupsHint')}</span>
          </fieldset>
          <div className="field w-full">
            <label className="check">
              <input
                type="checkbox"
                checked={willSendEmail}
                disabled={!emailEnabled}
                onChange={(e) => setSendEmail(e.target.checked)}
              />
              <span>{t('adm.invite.sendEmail')}</span>
            </label>
            {!emailEnabled && (
              <span className="hint">
                {t('adm.invite.emailDisabledHint')}{' '}
                <Link to="/admin/settings" className="text-primary-text underline">
                  {t('adm.invite.goEmailSettings')}
                </Link>
              </span>
            )}
          </div>
          <button
            type="submit"
            className="btn primary"
            disabled={create.isPending}
            aria-busy={create.isPending}
          >
            <MailPlus size={16} aria-hidden="true" />
            {t('adm.invite.create')}
          </button>
          {create.error && (
            <Banner kind="danger" role="alert">
              {create.error.message}
            </Banner>
          )}
        </form>
        {created && (
          <OneTimeLink
            label={
              created.emailSent && created.email
                ? t('adm.invite.sentTitle', { email: created.email })
                : t('adm.invite.create')
            }
            hint={created.emailSent ? t('adm.invite.sentLinkHint') : t('adm.invite.linkHint')}
            url={created.url}
            onDismiss={() => setCreated(null)}
          />
        )}
      </Section>

      <Section title={t('adm.invite.list')} count={invites.data?.length}>
        {revoke.error && (
          <Banner kind="danger" role="alert">
            {revoke.error.message}
          </Banner>
        )}
        <div className="overflow-x-auto rounded-md border border-border bg-panel">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('adm.status')}</th>
                <th scope="col">{t('adm.invite.emailCol')}</th>
                <th scope="col">{t('adm.createdAt')}</th>
                <th scope="col">{t('adm.invite.expiresAt')}</th>
                <th scope="col">{t('adm.invite.createdBy')}</th>
                <th scope="col">{t('adm.invite.usedBy')}</th>
                <th scope="col">
                  <span className="sr-only">{t('adm.invite.revoke')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(invites.data ?? []).map((i) => (
                <tr key={i.id}>
                  <td>{t(`adm.invite.state.${i.state}`)}</td>
                  <td className="font-mono text-xs">{i.email ?? '—'}</td>
                  <td>
                    <time dateTime={i.createdAt} className="text-xs text-text-3">
                      {formatTime(i.createdAt)}
                    </time>
                  </td>
                  <td>
                    <time dateTime={i.expiresAt} className="text-xs text-text-3">
                      {formatTime(i.expiresAt)}
                    </time>
                  </td>
                  <td className="font-mono text-xs">{i.createdBy ?? '—'}</td>
                  <td className="font-mono text-xs">{i.usedBy ?? '—'}</td>
                  <td>
                    {i.state === 'ok' && (
                      <button
                        type="button"
                        className="btn sm danger"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(i.id)}
                      >
                        {t('adm.invite.revoke')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {invites.data?.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-text-3">{t('adm.invite.empty')}</p>
          )}
        </div>
      </Section>
    </>
  );
};

const emptyProvider = {
  slug: '',
  name: '',
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid profile email',
  enabled: true,
  autoProvision: false,
};

export const AdminSignIn = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(emptyProvider);
  const [preset, setPreset] = useState('');
  const [removing, setRemoving] = useState<OidcProviderInfo | null>(null);
  const settings = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api<InstanceSettings>('GET', '/api/admin/settings'),
  });
  const providers = useQuery({
    queryKey: ['admin-oidc'],
    queryFn: () => api<OidcProviderInfo[]>('GET', '/api/admin/oidc'),
  });
  const presets = useQuery({
    queryKey: ['admin-oidc-presets'],
    queryFn: () => api<OidcProviderPreset[]>('GET', '/api/admin/oidc/presets'),
  });
  const enabledCount = (providers.data ?? []).filter((p) => p.enabled).length;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-oidc'] });
    void qc.invalidateQueries({ queryKey: ['instance'] });
  };
  const togglePassword = useMutation({
    mutationFn: (passwordLogin: boolean) =>
      api<InstanceSettings>('PATCH', '/api/admin/settings', { passwordLogin }),
    onSuccess: (next) => {
      qc.setQueryData(['admin-settings'], next);
      toast(t('adm.settings.saved'));
      void qc.invalidateQueries({ queryKey: ['instance'] });
    },
  });
  const create = useMutation({
    mutationFn: () => api<OidcProviderInfo>('POST', '/api/admin/oidc', form),
    onSuccess: () => {
      setForm(emptyProvider);
      setPreset('');
      toast(t('adm.signIn.saved'));
      refresh();
    },
  });
  const patch = useMutation({
    mutationFn: (x: { id: string; body: Record<string, unknown> }) =>
      api<OidcProviderInfo>('PATCH', `/api/admin/oidc/${x.id}`, x.body),
    onSuccess: () => {
      toast(t('adm.signIn.saved'));
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/admin/oidc/${id}`),
    onSuccess: () => {
      setRemoving(null);
      toast(t('adm.signIn.deleted'));
      refresh();
    },
  });
  const error = togglePassword.error ?? create.error ?? patch.error ?? remove.error;
  const pickPreset = (key: string) => {
    setPreset(key);
    const p = presets.data?.find((x) => x.key === key);
    if (p) setForm({ ...form, name: p.name, issuer: p.issuer, scopes: p.scopes });
  };

  return (
    <>
      <Section title={t('adm.navSignIn')}>
        <div className="space-y-2 rounded-md border border-border bg-panel p-4">
          <label className="check">
            <input
              type="checkbox"
              checked={settings.data?.passwordLogin ?? true}
              disabled={!enabledCount || togglePassword.isPending}
              onChange={(e) => togglePassword.mutate(e.target.checked)}
              aria-describedby="password-login-hint"
            />
            <span>{t('adm.signIn.passwordLogin')}</span>
          </label>
          <p id="password-login-hint" className="hint">
            {enabledCount ? t('adm.signIn.passwordLoginHint') : t('adm.signIn.passwordLoginBlocked')}
          </p>
        </div>
        {error && (
          <Banner kind="danger" role="alert">
            {error.message}
          </Banner>
        )}
      </Section>

      <Section
        title={t('adm.signIn.add')}
        action={
          <select
            className="select w-48"
            aria-label={t('adm.signIn.preset')}
            value={preset}
            onChange={(e) => pickPreset(e.target.value)}
          >
            <option value="">{t('adm.signIn.presetCustom')}</option>
            {(presets.data ?? []).map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        }
      >
        <form
          className="grid grid-cols-1 gap-2 rounded-md border border-border bg-panel p-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="field">
            <span className="label">{t('adm.signIn.name')}</span>
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span className="label">{t('adm.signIn.slug')}</span>
            <input
              className="input font-mono"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              required
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="field sm:col-span-2">
            <span className="label">{t('adm.signIn.issuer')}</span>
            <input
              className="input font-mono"
              value={form.issuer}
              onChange={(e) => setForm({ ...form, issuer: e.target.value })}
              required
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="label">{t('adm.signIn.clientId')}</span>
            <input
              className="input font-mono"
              value={form.clientId}
              onChange={(e) => setForm({ ...form, clientId: e.target.value })}
              required
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="label">{t('adm.signIn.clientSecret')}</span>
            <input
              className="input font-mono"
              type="password"
              value={form.clientSecret}
              onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
              required
              autoComplete="new-password"
            />
          </label>
          <label className="field">
            <span className="label">{t('adm.signIn.scopes')}</span>
            <input
              className="input font-mono"
              value={form.scopes}
              onChange={(e) => setForm({ ...form, scopes: e.target.value })}
              required
            />
          </label>
          {/* 复选框组统一用 .checks（flex + 间距），不要用 space-y：.check 是 inline-flex，会挤在同一行 */}
          <div className="checks flex-col items-start gap-1.5">
            <label className="check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              <span>{t('adm.signIn.enabled')}</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.autoProvision}
                onChange={(e) => setForm({ ...form, autoProvision: e.target.checked })}
              />
              <span>{t('adm.signIn.autoProvision')}</span>
            </label>
          </div>
          <div className="flex items-end sm:col-span-2">
            <button
              type="submit"
              className="btn primary"
              disabled={create.isPending}
              aria-busy={create.isPending}
            >
              {t('adm.signIn.add')}
            </button>
          </div>
          <p className="hint sm:col-span-2">{t('adm.signIn.presetsHint')}</p>
        </form>
      </Section>

      <Section title={t('adm.signIn.providers')} count={providers.data?.length}>
        <div className="space-y-3">
          {(providers.data ?? []).map((p) => (
            <ProviderRow key={p.id} provider={p} onSave={patch.mutate} onRemove={() => setRemoving(p)} />
          ))}
          {providers.data?.length === 0 && (
            <Empty
              icon={<KeyRound size={28} strokeWidth={1.5} aria-hidden="true" />}
              title={t('adm.signIn.empty')}
            />
          )}
        </div>
      </Section>

      <Confirm
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={t('adm.signIn.delete')}
        confirmLabel={t('adm.signIn.delete')}
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() => removing && remove.mutate(removing.id)}
      >
        {removing ? `${removing.name} · ${removing.slug}` : ''}
      </Confirm>
    </>
  );
};

/** 提供方的一行：常用字段就地编辑；secret 只能重新设置，不能查看 */
const ProviderRow = ({
  provider,
  onSave,
  onRemove,
}: {
  provider: OidcProviderInfo;
  onSave: (x: { id: string; body: Record<string, unknown> }) => void;
  onRemove: () => void;
}) => {
  const { t } = useTranslation();
  const [name, setName] = useState(provider.name);
  const [issuer, setIssuer] = useState(provider.issuer);
  const [clientId, setClientId] = useState(provider.clientId);
  const [scopes, setScopes] = useState(provider.scopes);
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const save = (body: Record<string, unknown>) => onSave({ id: provider.id, body });
  return (
    <div className="space-y-2 rounded-md border border-border bg-panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{provider.name}</span>
        <span className="font-mono text-xs text-text-3">{provider.slug}</span>
        <span className="chip">{provider.enabled ? t('adm.active') : t('adm.disabled')}</span>
        {provider.autoProvision && <span className="chip">{t('adm.signIn.autoProvision')}</span>}
        <span className="flex-1" />
        <label className="check">
          <input
            type="checkbox"
            checked={provider.enabled}
            aria-label={`${t('adm.signIn.enabled')} · ${provider.name}`}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
          <span>{t('adm.signIn.enabled')}</span>
        </label>
        <IconButton label={`${t('adm.signIn.delete')} · ${provider.name}`} onClick={onRemove}>
          <Trash2 size={16} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="field">
          <span className="label">{t('adm.signIn.name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">{t('adm.signIn.issuer')}</span>
          <input
            className="input font-mono"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="label">{t('adm.signIn.clientId')}</span>
          <input
            className="input font-mono"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="label">{t('adm.signIn.scopes')}</span>
          <input className="input font-mono" value={scopes} onChange={(e) => setScopes(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">{t('adm.signIn.resetSecret')}</span>
          <input
            className="input font-mono"
            type="password"
            value={secret}
            placeholder="••••••"
            autoComplete="new-password"
            aria-describedby={`secret-hint-${provider.id}`}
            onChange={(e) => setSecret(e.target.value)}
          />
          <span id={`secret-hint-${provider.id}`} className="hint">
            {t('adm.signIn.secretHint')}
          </span>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            className="btn"
            onClick={() =>
              save({
                name,
                issuer,
                clientId,
                scopes,
                ...(secret ? { clientSecret: secret } : {}),
              })
            }
          >
            {t('adm.signIn.save')}
          </button>
        </div>
      </div>
      <div className="space-y-1">
        <span className="label">{t('adm.signIn.callback')}</span>
        {provider.callbackUrl ? (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-xs bg-surface-2 px-1.5 py-1 font-mono text-xs">
              {provider.callbackUrl}
            </code>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                void navigator.clipboard.writeText(provider.callbackUrl!);
                setCopied(true);
              }}
            >
              <Copy size={14} aria-hidden="true" />
              {copied ? t('adm.copied') : t('adm.copy')}
            </button>
          </div>
        ) : (
          <p className="hint">{t('adm.signIn.callbackUnavailable')}</p>
        )}
        <p className="hint">{t('adm.signIn.callbackHint')}</p>
      </div>
    </div>
  );
};

const SMTP_DEFAULT_PORTS: Record<SmtpSecurity, string> = {
  starttls: '587',
  tls: '465',
  none: '25',
};

const AdminEmailSettings = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const emailQuery = useQuery({
    queryKey: ['admin-email'],
    queryFn: () => api<EmailSettings>('GET', '/api/admin/email'),
  });

  interface EmailFormState {
    enabled: boolean;
    host: string;
    port: string;
    security: SmtpSecurity;
    username: string;
    password: string;
    clearPassword: boolean;
    fromAddress: string;
    fromName: string;
  }

  const [form, setForm] = useState<EmailFormState | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const portRef = useRef<HTMLInputElement>(null);

  const [testTo, setTestTo] = useState(me?.email ?? '');
  const testToTouched = useRef(false);
  useEffect(() => {
    if (me?.email && !testToTouched.current) {
      setTestTo(me.email);
    }
  }, [me?.email]);

  const saved = emailQuery.data;
  const base: EmailFormState | null = saved
    ? {
        enabled: saved.enabled,
        host: saved.host,
        port: String(saved.port),
        security: saved.security,
        username: saved.username,
        password: '',
        clearPassword: false,
        fromAddress: saved.fromAddress,
        fromName: saved.fromName,
      }
    : null;
  const value = form ?? base;
  const isDirty =
    Boolean(form && base) &&
    (form!.enabled !== base!.enabled ||
      form!.host !== base!.host ||
      form!.port !== base!.port ||
      form!.security !== base!.security ||
      form!.username !== base!.username ||
      form!.password !== '' ||
      form!.clearPassword ||
      form!.fromAddress !== base!.fromAddress ||
      form!.fromName !== base!.fromName);

  const save = useMutation({
    mutationFn: (body: EmailFormState) =>
      api<EmailSettings>('PATCH', '/api/admin/email', {
        enabled: body.enabled,
        host: body.host,
        port: Number(body.port),
        security: body.security,
        username: body.username,
        ...(body.clearPassword ? { password: null } : body.password ? { password: body.password } : {}),
        fromAddress: body.fromAddress,
        fromName: body.fromName,
      }),
    onSuccess: (next) => {
      qc.setQueryData(['admin-email'], next);
      setForm(null);
      setPortError(null);
      toast(t('adm.smtp.saved'));
      void qc.invalidateQueries({ queryKey: ['instance'] });
    },
  });

  const [sentTo, setSentTo] = useState<string | null>(null);
  const test = useMutation({
    mutationFn: (to: string) => api<Ok>('POST', '/api/admin/email/test', { to }),
    onSuccess: (_res, to) => {
      setSentTo(to);
    },
  });

  const isConfigured = Boolean(saved?.host.trim() && saved?.fromAddress.trim());
  const canTest = !isDirty && isConfigured;

  return (
    <Section title={t('adm.smtp.title')}>
      {value && (
        <div className="space-y-4 rounded-md border border-border bg-panel p-4">
          <form
            className="space-y-3"
            aria-label={t('adm.smtp.title')}
            onSubmit={(e) => {
              e.preventDefault();
              const portNum = Number(value.port.trim());
              if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
                setPortError(t('adm.smtp.portInvalid'));
                portRef.current?.focus();
                return;
              }
              setPortError(null);
              test.reset();
              setSentTo(null);
              save.mutate(value);
            }}
          >
            <label className="check">
              <input
                type="checkbox"
                checked={value.enabled}
                onChange={(e) => setForm({ ...value, enabled: e.target.checked })}
              />
              <span>{t('adm.smtp.enabled')}</span>
            </label>
            <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="field">
                <span className="label">{t('adm.smtp.host')}</span>
                <input
                  className="input font-mono"
                  name="smtpHost"
                  value={value.host}
                  placeholder="smtp.example.com"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setForm({ ...value, host: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="label">{t('adm.smtp.security')}</span>
                <select
                  className="select"
                  name="smtpSecurity"
                  value={value.security}
                  onChange={(e) => {
                    const nextSec = e.target.value as SmtpSecurity;
                    const oldDefault = SMTP_DEFAULT_PORTS[value.security];
                    const shouldSwitchPort = value.port.trim() === '' || value.port.trim() === oldDefault;
                    setForm({
                      ...value,
                      security: nextSec,
                      port: shouldSwitchPort ? SMTP_DEFAULT_PORTS[nextSec] : value.port,
                    });
                    setPortError(null);
                  }}
                >
                  <option value="starttls">{t('adm.smtp.securityOption.starttls')}</option>
                  <option value="tls">{t('adm.smtp.securityOption.tls')}</option>
                  <option value="none">{t('adm.smtp.securityOption.none')}</option>
                </select>
              </label>
              <label className="field">
                <span className="label">{t('adm.smtp.port')}</span>
                <input
                  ref={portRef}
                  className="input font-mono"
                  type="text"
                  inputMode="numeric"
                  name="smtpPort"
                  value={value.port}
                  placeholder={SMTP_DEFAULT_PORTS[value.security]}
                  aria-invalid={portError ? 'true' : 'false'}
                  aria-describedby={portError ? 'smtp-port-err smtp-port-hint' : 'smtp-port-hint'}
                  onChange={(e) => {
                    setForm({ ...value, port: e.target.value });
                    setPortError(null);
                  }}
                />
                <span id="smtp-port-hint" className="hint">
                  {t('adm.smtp.portHint')}
                </span>
                {portError && (
                  <span id="smtp-port-err" className="hint error">
                    {portError}
                  </span>
                )}
              </label>
              <label className="field">
                <span className="label">{t('adm.smtp.username')}</span>
                <input
                  className="input font-mono"
                  name="smtpUsername"
                  value={value.username}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setForm({ ...value, username: e.target.value })}
                />
              </label>
              <div className="field">
                <label className="field">
                  <span className="label">{t('adm.smtp.password')}</span>
                  <input
                    className="input"
                    type="password"
                    name="smtpPassword"
                    value={value.password}
                    placeholder={saved?.hasPassword && !value.clearPassword ? '••••••' : ''}
                    autoComplete="new-password"
                    aria-describedby="smtp-pw-hint"
                    onChange={(e) =>
                      setForm({
                        ...value,
                        password: e.target.value,
                        clearPassword: e.target.value ? false : value.clearPassword,
                      })
                    }
                  />
                  <span id="smtp-pw-hint" className="hint">
                    {t('adm.smtp.passwordHint')}
                  </span>
                </label>
                {saved?.hasPassword && (
                  <label className="check mt-1">
                    <input
                      type="checkbox"
                      checked={value.clearPassword}
                      onChange={(e) =>
                        setForm({
                          ...value,
                          clearPassword: e.target.checked,
                          password: e.target.checked ? '' : value.password,
                        })
                      }
                    />
                    <span>{t('adm.smtp.clearPassword')}</span>
                  </label>
                )}
              </div>
              <label className="field">
                <span className="label">{t('adm.smtp.fromAddress')}</span>
                <input
                  className="input"
                  type="email"
                  name="smtpFromAddress"
                  value={value.fromAddress}
                  placeholder="noreply@example.com"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setForm({ ...value, fromAddress: e.target.value })}
                />
              </label>
              <label className="field sm:col-span-2">
                <span className="label">{t('adm.smtp.fromName')}</span>
                <input
                  className="input"
                  name="smtpFromName"
                  value={value.fromName}
                  placeholder="Dowel"
                  autoComplete="off"
                  onChange={(e) => setForm({ ...value, fromName: e.target.value })}
                />
              </label>
            </div>
            <p className="hint">{t('adm.smtp.publicUrlHint')}</p>
            {save.error && (
              <Banner kind="danger" role="alert">
                {save.error.message}
              </Banner>
            )}
            <div className="flex justify-end">
              <button
                type="submit"
                className="btn primary"
                disabled={save.isPending}
                aria-busy={save.isPending}
              >
                {t('adm.smtp.save')}
              </button>
            </div>
          </form>

          <hr className="border-border" />

          <form
            className="space-y-2.5"
            aria-label={t('adm.smtp.testTitle')}
            onSubmit={(e) => {
              e.preventDefault();
              if (!canTest) return;
              setSentTo(null);
              test.mutate(testTo.trim());
            }}
          >
            <h3 className="text-sm font-medium text-text">{t('adm.smtp.testTitle')}</h3>
            <div className="flex flex-wrap items-end gap-2">
              <label className="field w-72">
                <span className="label">{t('adm.smtp.testTo')}</span>
                <input
                  className="input"
                  type="email"
                  name="testRecipient"
                  value={testTo}
                  required
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => {
                    testToTouched.current = true;
                    setTestTo(e.target.value);
                    if (test.error) test.reset();
                    if (sentTo) setSentTo(null);
                  }}
                />
              </label>
              <button
                type="submit"
                className="btn"
                disabled={test.isPending || !canTest || !testTo.trim()}
                aria-busy={test.isPending}
              >
                {t('adm.smtp.sendTest')}
              </button>
            </div>
            {isDirty ? (
              <p className="hint">{t('adm.smtp.saveBeforeTestHint')}</p>
            ) : !isConfigured ? (
              <p className="hint">{t('adm.smtp.configureBeforeTestHint')}</p>
            ) : null}
            {sentTo && (
              <Banner kind="ok" role="status">
                {t('adm.smtp.testSent', { to: sentTo })}
              </Banner>
            )}
            {test.error && (
              <Banner kind="danger" role="alert">
                {test.error.message}
              </Banner>
            )}
          </form>
        </div>
      )}
    </Section>
  );
};

export const AdminSettings = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api<InstanceSettings>('GET', '/api/admin/settings'),
  });
  type Form = {
    name: string;
    groupCreation: 'all' | 'admin';
    allowlist: string;
    webhookAllowlist: string;
    allowMcpAccess: boolean;
  };
  const [form, setForm] = useState<Form | null>(null);
  const value: Form | null =
    form ??
    (settings.data
      ? {
          name: settings.data.name,
          groupCreation: settings.data.groupCreation,
          allowlist: settings.data.connectionAllowlist.join('\n'),
          webhookAllowlist: settings.data.webhookAllowlist.join('\n'),
          allowMcpAccess: settings.data.allowMcpAccess,
        }
      : null);
  const save = useMutation({
    mutationFn: (body: Form) =>
      api<InstanceSettings>('PATCH', '/api/admin/settings', {
        name: body.name,
        groupCreation: body.groupCreation,
        // 一行一项（逗号、空格也当分隔符）；空表示不限制
        connectionAllowlist: body.allowlist.split(/[\s,]+/).filter(Boolean),
        // Webhook 出站额外放行的地址（默认只允许公网）
        webhookAllowlist: body.webhookAllowlist.split(/[\s,]+/).filter(Boolean),
        // MCP 访问总开关（M3-C，ADR 0014）
        allowMcpAccess: body.allowMcpAccess,
      }),
    onSuccess: (next) => {
      qc.setQueryData(['admin-settings'], next);
      setForm(null);
      toast(t('adm.settings.saved'));
      void qc.invalidateQueries({ queryKey: ['instance'] });
      // 顶栏 / 登录页用的实例信息也要刷新
      void qc.invalidateQueries({ queryKey: ['groups'] });
      // “允许 MCP 访问”改了之后个人设置里的令牌列表（allowed）也要刷新
      void qc.invalidateQueries({ queryKey: ['mcp-tokens'] });
    },
  });
  return (
    <>
      <Section title={t('adm.navSettings')}>
        {value && (
          <form
            className="space-y-3 rounded-md border border-border bg-panel p-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(value);
            }}
          >
            <label className="field max-w-md">
              <span className="label">{t('adm.settings.name')}</span>
              <input
                className="input"
                value={value.name}
                onChange={(e) => setForm({ ...value, name: e.target.value })}
                required
              />
            </label>
            <label className="field max-w-md">
              <span className="label">{t('adm.settings.groupCreation')}</span>
              <select
                className="select"
                value={value.groupCreation}
                onChange={(e) =>
                  setForm({ ...value, groupCreation: e.target.value === 'admin' ? 'admin' : 'all' })
                }
              >
                <option value="all">{t('adm.settings.groupCreationAll')}</option>
                <option value="admin">{t('adm.settings.groupCreationAdmin')}</option>
              </select>
            </label>
            <label className="field max-w-md">
              <span className="label">{t('adm.settings.allowlist')}</span>
              <textarea
                className="textarea h-28 font-mono"
                value={value.allowlist}
                spellCheck={false}
                placeholder="10.0.0.0/8\ndb.internal"
                onChange={(e) => setForm({ ...value, allowlist: e.target.value })}
              />
              <span className="hint">{t('adm.settings.allowlistHint')}</span>
            </label>
            <label className="field max-w-md">
              <span className="label">{t('adm.settings.webhookAllowlist')}</span>
              <textarea
                className="textarea h-28 font-mono"
                value={value.webhookAllowlist}
                spellCheck={false}
                placeholder="10.1.2.0/24\nhooks.internal"
                onChange={(e) => setForm({ ...value, webhookAllowlist: e.target.value })}
              />
              <span className="hint">{t('adm.settings.webhookAllowlistHint')}</span>
            </label>
            <div className="field max-w-md">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={value.allowMcpAccess}
                  aria-describedby="adm-settings-mcp-hint"
                  onChange={(e) => setForm({ ...value, allowMcpAccess: e.target.checked })}
                />
                <span>{t('adm.settings.allowMcpAccess')}</span>
              </label>
              <span id="adm-settings-mcp-hint" className="hint">
                {t('adm.settings.allowMcpAccessHint')}
              </span>
            </div>
            <label className="field max-w-md">
              <span className="label">{t('adm.settings.instanceId')}</span>
              <input className="input font-mono" value={settings.data?.instanceId ?? ''} readOnly />
              <span className="hint">{t('adm.settings.instanceIdHint')}</span>
            </label>
            {save.error && (
              <Banner kind="danger" role="alert">
                {save.error.message}
              </Banner>
            )}
            <div className="flex justify-end">
              <button type="submit" className="btn primary" disabled={save.isPending}>
                {t('adm.settings.save')}
              </button>
            </div>
          </form>
        )}
      </Section>
      <AdminEmailSettings />
    </>
  );
};

/** 实例层的执行策略（P5a）和“谁能创建 CI 令牌”规则（P6）：组、项目、环境各层都在它之下，只能收紧 */
export const AdminPolicy = () => {
  const { t } = useTranslation();
  return (
    <>
      <Section title={t('pol.title')}>
        <PolicyLayerPanel path="/api/admin/exec-policy" queryKey={['exec-policy', 'instance']} />
      </Section>
      <Section title={t('tok.policy.title')}>
        <TokenPolicyPanel path="/api/admin/token-policy" queryKey={['token-policy', 'instance']} />
      </Section>
    </>
  );
};

export const AdminGrants = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [subject, setSubject] = useState<{ kind: GrantSubjectKind; id: string; name: string } | null>(null);
  const [role, setRole] = useState<GrantRole>('viewer');
  const grants = useQuery({
    queryKey: ['admin-grants'],
    queryFn: () => api<GrantInfo[]>('GET', '/api/admin/grants'),
  });
  const dir = useQuery({
    queryKey: ['admin-directory', q],
    queryFn: () => api<Directory>('GET', `/api/directory?q=${encodeURIComponent(q)}`),
    enabled: !subject,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin-grants'] });
  const add = useMutation({
    mutationFn: () =>
      api<GrantInfo>('POST', '/api/admin/grants', {
        subjectKind: subject!.kind,
        subjectId: subject!.id,
        role,
      }),
    onSuccess: () => {
      setSubject(null);
      setQ('');
      toast(t('adm.grants.added'));
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/admin/grants/${id}`),
    onSuccess: () => {
      toast(t('adm.grants.removed'));
      refresh();
    },
  });
  const error = add.error ?? remove.error;
  return (
    <Section title={t('adm.navGrants')} count={grants.data?.length}>
      <p className="hint">{t('adm.grants.hint')}</p>
      {error && (
        <Banner kind="danger" role="alert">
          {error.message}
        </Banner>
      )}
      <Rows>
        {(grants.data ?? []).map((g) => (
          <Row key={g.id}>
            <Avatar name={g.subject.name} color="var(--me)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base">{g.subject.name}</span>
              <span className="block truncate font-mono text-xs text-text-3">
                {g.subject.slug} · {t(g.subject.kind === 'user' ? 'dlg.subjectUser' : 'dlg.subjectGroup')} ·{' '}
                {t('adm.grants.scope')}
              </span>
            </span>
            <span className="chip">{t(`projects.role.${g.role}`)}</span>
            <IconButton
              label={t('dlg.removeGrant', { name: g.subject.name })}
              className="hover:!text-danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(g.id)}
            >
              <Trash2 size={16} aria-hidden="true" />
            </IconButton>
          </Row>
        ))}
        {(grants.data ?? []).length === 0 && (
          <li className="px-3 py-4 text-center text-sm text-text-3">{t('adm.grants.empty')}</li>
        )}
      </Rows>

      <div className="space-y-2 rounded-md border border-border bg-panel p-3.5">
        {subject ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip">
              {subject.name} · {t(subject.kind === 'user' ? 'dlg.subjectUser' : 'dlg.subjectGroup')}
            </span>
            <button type="button" className="btn ghost" onClick={() => setSubject(null)}>
              {t('dlg.change')}
            </button>
            <select
              className="select w-32"
              aria-label={t('dlg.role')}
              value={role}
              onChange={(e) => setRole(e.target.value as GrantRole)}
            >
              {(['viewer', 'editor', 'admin', 'executor'] as const).map((r) => (
                <option key={r} value={r}>
                  {t(`projects.role.${r}`)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn primary"
              disabled={add.isPending}
              onClick={() => add.mutate()}
            >
              {t('adm.grants.add')}
            </button>
          </div>
        ) : (
          <>
            <input
              className="input"
              aria-label={t('dlg.searchSubject')}
              placeholder={t('dlg.searchSubject')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <ul className="m-0 list-none p-0">
              {(dir.data?.users ?? []).map((u) => (
                <li key={`u-${u.id}`}>
                  <button
                    type="button"
                    className="w-full rounded-sm px-1.5 py-1 text-left text-base hover:bg-surface-hover"
                    onClick={() => setSubject({ kind: 'user', id: u.id, name: u.name })}
                  >
                    {u.name} <span className="font-mono text-xs text-text-3">{u.slug}</span>
                  </button>
                </li>
              ))}
              {(dir.data?.groups ?? []).map((g) => (
                <li key={`g-${g.id}`}>
                  <button
                    type="button"
                    className="w-full rounded-sm px-1.5 py-1 text-left text-base hover:bg-surface-hover"
                    onClick={() => setSubject({ kind: 'group', id: g.id, name: g.name })}
                  >
                    {g.name} <span className="font-mono text-xs text-text-3">{g.slug}</span>{' '}
                    <span className="chip">{t('dlg.subjectGroup')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Section>
  );
};

const TARGET_KINDS = [
  'project',
  'user',
  'group',
  'version',
  'environment',
  'exec_request',
  'webhook',
  'ci_token',
  'mcp_token',
  'invite',
  'session',
  'oidc_provider',
  'instance',
] as const;

interface AuditFilters {
  action: string;
  actor: string;
  targetKind: string;
  targetId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: AuditFilters = { action: '', actor: '', targetKind: '', targetId: '', from: '', to: '' };

/** 过滤器 → 查询串（时间是 datetime-local 的本地时间，转成 ISO 再发） */
const auditQuery = (f: AuditFilters, cursor: string | null) => {
  const p = new URLSearchParams();
  for (const key of ['action', 'actor', 'targetKind', 'targetId'] as const)
    if (f[key].trim()) p.set(key, f[key].trim());
  for (const key of ['from', 'to'] as const) if (f[key]) p.set(key, new Date(f[key]).toISOString());
  if (cursor) p.set('cursor', cursor);
  return p.toString();
};

export const AdminAudit = () => {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_FILTERS);
  const [open, setOpen] = useState<string | null>(null);
  const audit = useInfiniteQuery({
    queryKey: ['audit', applied],
    queryFn: ({ pageParam }) => api<AuditPage>('GET', `/api/admin/audit?${auditQuery(applied, pageParam)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const events = audit.data?.pages.flatMap((p) => p.events) ?? [];
  const set = (k: keyof AuditFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFilters({ ...filters, [k]: e.target.value });
  return (
    <Section title={t('adm.navAudit')}>
      <form
        className="grid grid-cols-1 gap-2 rounded-md border border-border bg-panel p-3.5 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(filters);
          setOpen(null);
        }}
      >
        <label className="field">
          <span className="label">{t('adm.audit.action')}</span>
          <input
            className="input font-mono"
            value={filters.action}
            onChange={set('action')}
            aria-describedby="audit-action-hint"
            spellCheck={false}
          />
          <span id="audit-action-hint" className="hint">
            {t('adm.audit.actionHint')}
          </span>
        </label>
        <label className="field">
          <span className="label">{t('adm.audit.actor')}</span>
          <input className="input" value={filters.actor} onChange={set('actor')} />
        </label>
        <label className="field">
          <span className="label">{t('adm.audit.targetKind')}</span>
          <select className="select" value={filters.targetKind} onChange={set('targetKind')}>
            <option value="">{t('adm.audit.all')}</option>
            {TARGET_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`adm.audit.target.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">{t('adm.audit.targetId')}</span>
          <input className="input font-mono" value={filters.targetId} onChange={set('targetId')} />
        </label>
        <label className="field">
          <span className="label">{t('adm.audit.from')}</span>
          <input className="input" type="datetime-local" value={filters.from} onChange={set('from')} />
        </label>
        <label className="field">
          <span className="label">{t('adm.audit.to')}</span>
          <input className="input" type="datetime-local" value={filters.to} onChange={set('to')} />
        </label>
        <div className="flex items-end gap-2 sm:col-span-3">
          <button type="submit" className="btn primary">
            {t('adm.audit.filter')}
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setApplied(EMPTY_FILTERS);
            }}
          >
            {t('adm.audit.clear')}
          </button>
        </div>
      </form>

      {audit.error && (
        <Banner kind="danger" role="alert">
          {audit.error.message}
        </Banner>
      )}

      <div className="overflow-x-auto rounded-md border border-border bg-panel">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('adm.audit.time')}</th>
              <th scope="col">{t('adm.audit.actorCol')}</th>
              <th scope="col">{t('adm.audit.actionCol')}</th>
              <th scope="col">{t('adm.audit.targetCol')}</th>
              <th scope="col">{t('adm.audit.ip')}</th>
              <th scope="col">
                <span className="sr-only">{t('adm.audit.data')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <AuditRow
                key={e.id}
                event={e}
                open={open === e.id}
                onToggle={() => setOpen(open === e.id ? null : e.id)}
              />
            ))}
          </tbody>
        </table>
        {events.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-text-3">{t('adm.audit.empty')}</p>
        )}
      </div>
      {audit.hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            className="btn"
            disabled={audit.isFetchingNextPage}
            aria-busy={audit.isFetchingNextPage}
            onClick={() => void audit.fetchNextPage()}
          >
            {t('adm.audit.loadMore')}
          </button>
        </div>
      )}
    </Section>
  );
};

const AuditRow = ({ event, open, onToggle }: { event: AuditEvent; open: boolean; onToggle: () => void }) => {
  const { t } = useTranslation();
  const actor = event.actorUsername ?? event.actorId ?? t('adm.audit.system');
  // 对象 ID 比较长（ULID），只显示末尾 8 位：前缀是时间戳，截前面反而每个都一样
  const target = event.targetKind
    ? `${t(`adm.audit.target.${event.targetKind}`)}${event.targetId ? ` · ${event.targetId.slice(-8)}` : ''}`
    : '—';
  return (
    <>
      <tr>
        <td>
          <time dateTime={event.at} className="text-xs whitespace-nowrap text-text-3">
            {formatTime(event.at)}
          </time>
        </td>
        <td className="font-mono text-xs">{actor}</td>
        <td>
          {actionText(event.action, event.data)}
          {viaMcp(event.data) && (
            <>
              {' '}
              <McpBadge />
            </>
          )}
          <span className="block font-mono text-xs text-text-3">{event.action}</span>
        </td>
        <td className="font-mono text-xs">{target}</td>
        <td className="font-mono text-xs">{event.ip ?? '—'}</td>
        <td>
          <button type="button" className="btn ghost sm" aria-expanded={open} onClick={onToggle}>
            {open ? t('adm.audit.collapse') : t('adm.audit.expand')}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6}>
            <pre className="code m-0 max-h-64 overflow-auto">
              {JSON.stringify(event.data ?? null, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
};
