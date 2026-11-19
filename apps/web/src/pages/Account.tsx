// 首次初始化（/setup）、接受邀请（/invite/:token）、重置密码（/reset/:token）。
// 三个页面都很简单：一个表单，成功后跳转；完整的管理界面留到下一个阶段。
import type { InviteInfo, Me, OidcConfirmInfo, Ok } from '@dowel/api';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { AuthShell, useSetMe } from '../components/AuthShell.tsx';
import { Banner } from '../components/ui.tsx';
import { useInstance } from '../instance.ts';

const useToken = () => (useParams({ strict: false }) as { token: string }).token;

/** 邀请、重置密码页面的状态说明 */
const stateMessage = (state: InviteInfo['state'], t: (k: string) => string) =>
  ({
    ok: '',
    missing: t('account.inviteInvalid'),
    used: t('account.inviteUsed'),
    revoked: t('account.inviteRevoked'),
    expired: t('account.inviteExpired'),
  })[state];

export const Setup = () => {
  const { t } = useTranslation();
  const nav = useNavigate();
  const instance = useInstance();
  const setMe = useSetMe();
  const [form, setForm] = useState({ token: '', username: '', name: '', password: '' });
  const run = useMutation({
    mutationFn: () => api<Me>('POST', '/api/setup', form),
    onSuccess: async (me) => {
      setMe(me);
      // 先等实例信息刷新：根路由在 needsSetup 还是 true 时会把人送回 /setup
      await instance.refetch();
      void nav({ to: '/' });
    },
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  if (instance.data && !instance.data.needsSetup)
    return (
      <AuthShell name={instance.data.name} tagline={t('app.tagline')} title={t('account.setupTitle')}>
        <Banner kind="info">{t('account.setupAlready')}</Banner>
        <button type="button" className="btn primary w-full" onClick={() => void nav({ to: '/login' })}>
          {t('account.goLogin')}
        </button>
      </AuthShell>
    );

  return (
    <AuthShell
      name={instance.data?.name ?? t('app.name')}
      tagline={t('app.tagline')}
      title={t('account.setupTitle')}
    >
      <p className="text-sm text-text-2">{t('account.setupHint')}</p>
      <form
        className="space-y-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <label className="field">
          <span className="label">{t('account.setupToken')}</span>
          <input
            className="input font-mono"
            value={form.token}
            onChange={set('token')}
            required
            autoComplete="off"
            spellCheck={false}
          />
          <p className="hint">{t('account.setupTokenHint')}</p>
        </label>
        <label className="field">
          <span className="label">{t('account.username')}</span>
          <input
            className="input font-mono"
            value={form.username}
            onChange={set('username')}
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="username-hint"
          />
          <p id="username-hint" className="hint">
            {t('account.usernameHint')}
          </p>
        </label>
        <label className="field">
          <span className="label">{t('account.displayName')}</span>
          <input className="input" value={form.name} onChange={set('name')} required autoComplete="name" />
        </label>
        <label className="field">
          <span className="label">{t('auth.password')}</span>
          <input
            className="input"
            type="password"
            value={form.password}
            onChange={set('password')}
            required
            minLength={8}
            autoComplete="new-password"
            aria-describedby="pw-hint"
          />
          <p id="pw-hint" className="hint">
            {t('auth.passwordHint')}
          </p>
        </label>
        {run.error && (
          <Banner kind="danger" role="alert">
            {run.error.message}
          </Banner>
        )}
        <button type="submit" className="btn primary w-full" disabled={run.isPending}>
          {t('account.setupSubmit')}
        </button>
      </form>
    </AuthShell>
  );
};

export const Invite = () => {
  const { t } = useTranslation();
  const token = useToken();
  const nav = useNavigate();
  const setMe = useSetMe();
  const instance = useInstance();
  const info = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InviteInfo>('GET', `/api/invites/${token}`),
  });
  const [form, setForm] = useState({ username: '', name: '', email: '', password: '' });
  const run = useMutation({
    mutationFn: () => api<Me>('POST', `/api/invites/${token}/accept`, form),
    onSuccess: (me) => {
      setMe(me);
      void nav({ to: '/' });
    },
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });
  const name = info.data?.instanceName ?? t('app.name');
  const message = info.data ? stateMessage(info.data.state, t) : '';

  return (
    <AuthShell name={name} tagline={t('app.tagline')} title={t('account.inviteTitle')}>
      {message ? (
        <>
          <Banner kind="danger">{message}</Banner>
          <button type="button" className="btn w-full" onClick={() => void nav({ to: '/login' })}>
            {t('account.goLogin')}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-text-2">{t('account.inviteHint', { instance: name })}</p>
          <form
            className="space-y-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate();
            }}
          >
            <label className="field">
              <span className="label">{t('account.username')}</span>
              <input
                className="input font-mono"
                value={form.username}
                onChange={set('username')}
                required
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby="username-hint"
              />
              <p id="username-hint" className="hint">
                {t('account.usernameHint')}
              </p>
            </label>
            <label className="field">
              <span className="label">{t('account.displayName')}</span>
              <input
                className="input"
                value={form.name}
                onChange={set('name')}
                required
                autoComplete="name"
              />
            </label>
            <label className="field">
              <span className="label">{t('account.email')}</span>
              <input
                className="input"
                type="email"
                value={form.email}
                onChange={set('email')}
                autoComplete="email"
              />
            </label>
            <label className="field">
              <span className="label">{t('auth.password')}</span>
              <input
                className="input"
                type="password"
                value={form.password}
                onChange={set('password')}
                required
                minLength={8}
                autoComplete="new-password"
                aria-describedby="pw-hint"
              />
              <p id="pw-hint" className="hint">
                {t('auth.passwordHint')}
              </p>
            </label>
            {run.error && (
              <Banner kind="danger" role="alert">
                {run.error.message}
              </Banner>
            )}
            <button type="submit" className="btn primary w-full" disabled={run.isPending}>
              {t('account.inviteAccept')}
            </button>
          </form>
          {(instance.data?.providers ?? []).length > 0 && (
            <div className="space-y-2 border-t border-border pt-3.5">
              {(instance.data?.providers ?? []).map((p) => (
                <a
                  key={p.slug}
                  className="btn w-full"
                  href={`/api/auth/oidc/${encodeURIComponent(p.slug)}/start?invite=${encodeURIComponent(token)}&next=/`}
                >
                  {t('account.inviteWithOidc', { name: p.name })}
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </AuthShell>
  );
};

export const Reset = () => {
  const { t } = useTranslation();
  const token = useToken();
  const nav = useNavigate();
  const instance = useInstance();
  const [password, setPassword] = useState('');
  const run = useMutation({
    mutationFn: () => api<Ok>('POST', `/api/reset/${token}`, { password }),
  });
  return (
    <AuthShell
      name={instance.data?.name ?? t('app.name')}
      tagline={t('app.tagline')}
      title={t('account.resetTitle')}
    >
      {run.isSuccess ? (
        <>
          <Banner kind="ok">{t('account.resetDone')}</Banner>
          <button type="button" className="btn primary w-full" onClick={() => void nav({ to: '/login' })}>
            {t('account.goLogin')}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-text-2">{t('account.resetHint')}</p>
          <form
            className="space-y-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate();
            }}
          >
            <label className="field">
              <span className="label">{t('account.newPassword')}</span>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                aria-describedby="pw-hint"
              />
              <p id="pw-hint" className="hint">
                {t('auth.passwordHint')}
              </p>
            </label>
            {run.error && (
              <Banner kind="danger" role="alert">
                {run.error.message}
              </Banner>
            )}
            <button type="submit" className="btn primary w-full" disabled={run.isPending}>
              {t('account.resetSubmit')}
            </button>
          </form>
        </>
      )}
    </AuthShell>
  );
};

/** OIDC 首次开户时 preferred_username 冲突或不合法：让本人改用户名后再完成开户 */
export const OidcConfirm = () => {
  const { t } = useTranslation();
  const nav = useNavigate();
  const setMe = useSetMe();
  const info = useQuery({
    queryKey: ['oidc-confirm'],
    queryFn: () => api<OidcConfirmInfo>('GET', '/api/auth/oidc/confirm'),
  });
  const [username, setUsername] = useState('');
  const initialized = useRef(false);
  useEffect(() => {
    if (info.data && !initialized.current) {
      initialized.current = true;
      setUsername(info.data.username);
    }
  }, [info.data]);
  const run = useMutation({
    mutationFn: () => api<Me>('POST', '/api/auth/oidc/confirm', { username }),
    onSuccess: (me) => {
      setMe(me);
      void nav({ to: '/' });
    },
  });
  return (
    <AuthShell
      name={info.data?.providerName ?? t('app.name')}
      tagline={t('app.tagline')}
      title={t('account.oidcConfirmTitle')}
    >
      {info.error ? (
        <>
          <Banner kind="danger" role="alert">
            {info.error.message}
          </Banner>
          <button type="button" className="btn w-full" onClick={() => void nav({ to: '/login' })}>
            {t('account.goLogin')}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-text-2">{t('account.oidcConfirmHint')}</p>
          <form
            className="space-y-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate();
            }}
          >
            <label className="field">
              <span className="label">{t('account.username')}</span>
              <input
                className="input font-mono"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby="oidc-username-hint"
              />
              <p id="oidc-username-hint" className="hint">
                {t('account.usernameHint')}
              </p>
            </label>
            {run.error && (
              <Banner kind="danger" role="alert">
                {run.error.message}
              </Banner>
            )}
            <button type="submit" className="btn primary w-full" disabled={run.isPending}>
              {t('account.oidcConfirmSubmit')}
            </button>
          </form>
        </>
      )}
    </AuthShell>
  );
};
