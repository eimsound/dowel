// 个人设置（/account）：资料、密码、登录方式、会话、MCP 访问（M3-C，见 components/McpTokens.tsx）、偏好。
// 导航方式是外壳的侧面板（和后台一致，见 DESIGN.md 的 Layout）：每节是独立的嵌套路由，地址可以直接分享。
// P1c 里 OIDC 关联成功后的回调就落在 /account（本页的资料一节）。
import type { Me, MeIdentity, SessionInfo } from '@dowel/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Bot, KeyRound, Link2, MonitorSmartphone, Palette, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api.ts';
import { SettingsNav } from '../components/SettingsNav.tsx';
import { AppShell, PageHeader, useShellPanel } from '../components/Shell.tsx';
import { useToast } from '../components/Toasts.tsx';
import { Banner, IconButton } from '../components/ui.tsx';
import { formatTime } from '../format.ts';
import i18n, { setLang } from '../i18n.ts';
import { useInstance } from '../instance.ts';
import { useMe, useSignOut } from '../session.ts';
import { getScheme, type Scheme, setScheme } from '../theme.ts';

const SECTIONS = [
  { to: '/account', label: 'acc.profile', icon: UserRound },
  { to: '/account/password', label: 'acc.password', icon: KeyRound },
  { to: '/account/identities', label: 'acc.identities', icon: Link2 },
  { to: '/account/sessions', label: 'acc.sessions', icon: MonitorSmartphone },
  { to: '/account/mcp', label: 'mcp.title', icon: Bot },
  { to: '/account/preferences', label: 'acc.preferences', icon: Palette },
] as const;

/** 个人设置的嵌套布局：外壳 + 侧面板导航 + 当前一节 */
export const AccountLayout = () => {
  const me = useMe().data;
  const path = useRouterState({ select: (s) => s.location.pathname });
  if (!me) return null;
  return (
    <AppShell me={me}>
      <AccountShell path={path} />
    </AppShell>
  );
};

const AccountShell = ({ path }: { path: string }) => {
  const { t } = useTranslation();
  useShellPanel(
    t('acc.panel'),
    <SettingsNav
      label={t('acc.panel')}
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
      <PageHeader crumbs={[{ label: t('nav.myProjects'), to: '/' }, { label: t('acc.title') }]} />
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[760px] space-y-6 px-6 py-6">
          <Outlet />
        </div>
      </main>
    </>
  );
};

/** 一端有标题的区块（分节之间用留白分隔，不用卡片套卡片） */
const Block = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section className="space-y-2">
    <h2 className="section-title">{title}</h2>
    {hint && <p className="hint">{hint}</p>}
    {children}
  </section>
);

export const AccountProfile = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data!;
  const [form, setForm] = useState({
    name: me.name,
    username: me.username,
    email: me.email ?? '',
  });
  const save = useMutation({
    mutationFn: () => api<Me>('PATCH', '/api/me', form),
    onSuccess: (next) => {
      qc.setQueryData(['me'], next);
      toast(t('acc.saved'));
    },
  });
  const field = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });
  return (
    <Block title={t('acc.profile')}>
      <form
        className="space-y-3 rounded-md border border-border bg-panel p-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className="field max-w-md">
          <span className="label">{t('acc.displayName')}</span>
          <input className="input" value={form.name} onChange={field('name')} required autoComplete="name" />
        </label>
        <label className="field max-w-md">
          <span className="label">{t('acc.username')}</span>
          <input
            className="input font-mono"
            value={form.username}
            onChange={field('username')}
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="acc-username-hint"
          />
          <span id="acc-username-hint" className="hint">
            {t('acc.usernameImpact')}
          </span>
        </label>
        <label className="field max-w-md">
          <span className="label">{t('acc.email')}</span>
          <input className="input" type="email" value={form.email} onChange={field('email')} />
          <span className="hint">{t('acc.emailHint')}</span>
        </label>
        {save.error && (
          <Banner kind="danger" role="alert">
            {save.error.message}
          </Banner>
        )}
        <div className="flex justify-end">
          <button type="submit" className="btn primary" disabled={save.isPending} aria-busy={save.isPending}>
            {t('acc.save')}
          </button>
        </div>
      </form>
    </Block>
  );
};

export const AccountPassword = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const instance = useInstance();
  const me = useMe().data!;
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const hasPassword = me.hasPassword;
  const change = useMutation({
    mutationFn: () =>
      api('POST', '/api/me/password', hasPassword ? { oldPassword, newPassword } : { newPassword }),
    onSuccess: async () => {
      setOld('');
      setNew('');
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
      toast(t(hasPassword ? 'acc.passwordChanged' : 'acc.passwordSet'));
    },
  });
  // 首次设置密码要求最近 10 分钟内登录：会话太旧时服务端返回 403，这里给一个重新登录的入口
  const needRelogin = !hasPassword && change.error instanceof ApiError && change.error.status === 403;
  const providers = instance.data?.providers ?? [];
  return (
    <Block title={t('acc.password')} hint={hasPassword ? t('acc.passwordHint') : t('acc.setPasswordHint')}>
      <form
        className="space-y-3 rounded-md border border-border bg-panel p-4"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
      >
        {hasPassword && (
          <label className="field max-w-md">
            <span className="label">{t('acc.currentPassword')}</span>
            <input
              className="input"
              type="password"
              value={oldPassword}
              onChange={(e) => setOld(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
        )}
        <label className="field max-w-md">
          <span className="label">{t('acc.newPassword')}</span>
          <input
            className="input"
            type="password"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            aria-describedby="acc-pw-hint"
          />
          <span id="acc-pw-hint" className="hint">
            {t('auth.passwordHint')}
          </span>
        </label>
        {change.error && (
          <Banner
            kind="danger"
            role="alert"
            action={
              needRelogin && providers.length > 0 ? (
                <span className="flex flex-wrap gap-1.5">
                  {providers.map((p) => (
                    <a
                      key={p.slug}
                      className="btn sm"
                      href={`/api/auth/oidc/${encodeURIComponent(p.slug)}/start?next=${encodeURIComponent(
                        '/account/password',
                      )}`}
                    >
                      {t('acc.reloginWith', { name: p.name })}
                    </a>
                  ))}
                </span>
              ) : undefined
            }
          >
            {change.error.message}
          </Banner>
        )}
        <div className="flex justify-end">
          <button
            type="submit"
            className="btn primary"
            disabled={change.isPending}
            aria-busy={change.isPending}
          >
            {hasPassword ? t('acc.changePassword') : t('acc.setPassword')}
          </button>
        </div>
      </form>
    </Block>
  );
};

export const AccountIdentities = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data!;
  const instance = useInstance();
  const identities = useQuery({
    queryKey: ['identities'],
    queryFn: () => api<MeIdentity[]>('GET', '/api/me/identities'),
  });
  const unlink = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/me/identities/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['identities'] });
      toast(t('acc.unlinked'));
    },
  });
  // 密码登录被实例关掉时，密码不算“可用的登录方式”
  const passwordUsable = me.hasPassword && (instance.data?.passwordLogin ?? true);
  const list = identities.data ?? [];
  const usable = list.length + (passwordUsable ? 1 : 0);
  const lastMethod = usable <= 1;
  const linked = new Set(list.map((i) => i.providerSlug));
  const available = (instance.data?.providers ?? []).filter((p) => !linked.has(p.slug));

  return (
    <Block title={t('acc.identities')} hint={t('acc.identitiesHint')}>
      <ul className="m-0 list-none overflow-hidden rounded-md border border-border bg-panel p-0">
        <li className="flex items-center gap-2.5 px-3 py-2.5 not-first:border-t not-first:border-border">
          <KeyRound size={16} aria-hidden="true" className="text-text-3" />
          <span className="min-w-0 flex-1">
            <span className="block text-base">{t('acc.passwordMethod')}</span>
            <span className="block text-xs text-text-3">
              {me.hasPassword ? t('acc.hasPasswordLabel') : t('acc.noPassword')}
            </span>
          </span>
          {!me.hasPassword && (
            <Link to="/account/password" className="btn sm">
              {t('acc.setPassword')}
            </Link>
          )}
        </li>
        {list.map((i) => (
          <li
            key={i.id}
            className="flex items-center gap-2.5 px-3 py-2.5 not-first:border-t not-first:border-border"
          >
            <Link2 size={16} aria-hidden="true" className="text-text-3" />
            <span className="min-w-0 flex-1">
              <span className="block text-base">{i.providerName}</span>
              <span className="block truncate font-mono text-xs text-text-3">{i.subject}</span>
            </span>
            <IconButton
              label={t('acc.unlink')}
              className="hover:!text-danger"
              disabled={lastMethod || unlink.isPending}
              onClick={() => unlink.mutate(i.id)}
            >
              <Trash2 size={16} aria-hidden="true" />
            </IconButton>
          </li>
        ))}
        {list.length === 0 && <li className="px-3 py-3 text-sm text-text-3">{t('acc.noIdentities')}</li>}
      </ul>
      {/* 只有真的有关联可以解除时才说明（没有关联时这段说明没有意义） */}
      {lastMethod && list.length > 0 && <p className="hint">{t('acc.unlinkLast')}</p>}
      {available.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {available.map((p) => (
            <a
              key={p.slug}
              className="btn"
              href={`/api/auth/oidc/${encodeURIComponent(p.slug)}/start?mode=link&next=${encodeURIComponent('/account/identities')}`}
            >
              <Link2 size={16} aria-hidden="true" />
              {t('acc.link', { name: p.name })}
            </a>
          ))}
        </div>
      )}
      {unlink.error && (
        <Banner kind="danger" role="alert">
          {unlink.error.message}
        </Banner>
      )}
    </Block>
  );
};

/** 浏览器 UA 的简化描述：浏览器 · 操作系统（DESIGN.md：只给能帮人认出会话的信息） */
export const describeAgent = (ua: string | null | undefined, unknown: string) => {
  if (!ua) return unknown;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : unknown;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} · ${os}` : browser;
};

export const AccountSessions = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const signOut = useSignOut();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<SessionInfo[]>('GET', '/api/me/sessions'),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['sessions'] });
  const revoke = useMutation({
    mutationFn: async (s: SessionInfo) => {
      await api('DELETE', `/api/me/sessions/${s.id}`);
      return s.current;
    },
    onSuccess: async (wasCurrent) => {
      toast(t('acc.sessionRevoked'));
      if (wasCurrent) {
        // 当前会话被吊销了：和退出登录一样先清空缓存（里面还有这个用户的项目 / 组），再回登录页
        await signOut();
        return;
      }
      refresh();
    },
  });
  const revokeOthers = useMutation({
    mutationFn: async () => {
      const others = (sessions.data ?? []).filter((s) => !s.current);
      for (const s of others) await api('DELETE', `/api/me/sessions/${s.id}`);
    },
    onSuccess: () => {
      toast(t('acc.othersRevoked'));
      refresh();
    },
  });
  const list = sessions.data ?? [];
  const others = list.filter((s) => !s.current).length;
  const error = revoke.error ?? revokeOthers.error;

  return (
    <Block title={t('acc.sessions')} hint={t('acc.sessionsHint')}>
      <ul className="m-0 list-none overflow-hidden rounded-md border border-border bg-panel p-0">
        {list.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center gap-2.5 px-3 py-2.5 not-first:border-t not-first:border-border"
          >
            <MonitorSmartphone size={16} aria-hidden="true" className="text-text-3" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-base">
                {describeAgent(s.userAgent, t('acc.unknownBrowser'))}
                {s.current && <span className="chip">{t('acc.sessionCurrent')}</span>}
              </span>
              <span className="block truncate text-xs text-text-3">
                {t('acc.sessionIp')} {s.ip ?? '—'} · {t('acc.sessionLastSeen')} {formatTime(s.lastSeenAt)} ·{' '}
                {t('acc.sessionCreated')} {formatTime(s.createdAt)}
              </span>
            </span>
            <button
              type="button"
              className="btn sm"
              disabled={revoke.isPending}
              aria-label={t('acc.sessionRevokeOf', {
                browser: describeAgent(s.userAgent, t('acc.unknownBrowser')),
              })}
              onClick={() => revoke.mutate(s)}
            >
              {t('acc.sessionRevoke')}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <Banner kind="danger" role="alert">
          {error.message}
        </Banner>
      )}
      {others > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            className="btn danger"
            disabled={revokeOthers.isPending}
            onClick={() => revokeOthers.mutate()}
          >
            {t('acc.revokeOthers')}
          </button>
        </div>
      )}
    </Block>
  );
};

export const AccountPreferences = () => {
  const { t } = useTranslation();
  const [scheme, setS] = useState<Scheme>(getScheme());
  const [lang, setL] = useState(i18n.language === 'en' ? 'en' : 'zh');
  const pick = (s: Scheme) => {
    setScheme(s);
    setS(s);
  };
  return (
    <Block title={t('acc.preferences')} hint={t('acc.preferencesHint')}>
      <div className="space-y-4 rounded-md border border-border bg-panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="label w-16">{t('acc.language')}</span>
          <select
            className="select w-48"
            aria-label={t('acc.language')}
            value={lang}
            onChange={(e) => {
              const lng = e.target.value === 'en' ? 'en' : 'zh';
              setL(lng);
              setLang(lng);
            }}
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="label w-16">{t('acc.scheme')}</span>
          <div className="seg">
            {(['auto', 'light', 'dark'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={scheme === s} onClick={() => pick(s)}>
                {t(`acc.schemeOption.${s}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Block>
  );
};
