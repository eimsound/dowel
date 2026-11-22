// 强制改密（/change-password）、接受邀请（/invite/:token）、重置密码（/reset/:token）。
// 三个页面都很简单：一个表单，成功后跳转；完整的管理界面留到下一个阶段。
import type { InviteInfo, Me, OidcConfirmInfo, Ok } from '@dowel/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { AuthShell, useSetMe } from '../components/AuthShell.tsx';
import { Banner } from '../components/ui.tsx';
import { useInstance } from '../instance.ts';
import { AUTH_NEXT_EXCLUDES, safeNextPath } from '../safe-next.ts';
import { meQuery, useSignOut } from '../session.ts';

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

type ChangePasswordField = 'oldPassword' | 'newPassword' | 'confirmPassword';

export const ChangePassword = () => {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const instance = useInstance();
  const signOut = useSignOut();
  const { next: rawNext } = useSearch({ from: '/change-password' });
  const next = safeNextPath(rawNext, AUTH_NEXT_EXCLUDES);

  const [values, setValues] = useState({
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [dirty, setDirty] = useState<Record<ChangePasswordField, boolean>>({
    oldPassword: false,
    newPassword: false,
    confirmPassword: false,
  });
  const [errors, setErrors] = useState<Partial<Record<ChangePasswordField, string>>>({});

  const oldRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const validateField = (field: ChangePasswordField, vals: typeof values): string | undefined => {
    if (field === 'oldPassword') {
      return vals.oldPassword ? undefined : t('account.oldPasswordRequired');
    }
    if (field === 'newPassword') {
      if (!vals.newPassword || vals.newPassword.length < 8) return t('account.passwordTooShort');
      if (vals.oldPassword && vals.newPassword === vals.oldPassword) return t('account.passwordSameAsOld');
      return undefined;
    }
    if (!vals.confirmPassword || vals.confirmPassword !== vals.newPassword) {
      return t('account.passwordMismatch');
    }
    return undefined;
  };

  const onChange = (field: ChangePasswordField) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextValues = { ...values, [field]: e.target.value };
    setValues(nextValues);
    setDirty((prev) => ({ ...prev, [field]: true }));
    setErrors((prev) => {
      const nextErrors = { ...prev, [field]: undefined };
      if (field === 'oldPassword' && prev.newPassword === t('account.passwordSameAsOld')) {
        nextErrors.newPassword = undefined;
      }
      if (field === 'newPassword') {
        nextErrors.confirmPassword = undefined;
      }
      return nextErrors;
    });
  };

  const onBlur = (field: ChangePasswordField) => () => {
    if (!dirty[field]) return;
    setErrors((prev) => ({
      ...prev,
      [field]: validateField(field, values),
      ...(field === 'oldPassword' && dirty.newPassword
        ? { newPassword: validateField('newPassword', values) }
        : {}),
      ...(field === 'newPassword' && dirty.confirmPassword
        ? { confirmPassword: validateField('confirmPassword', values) }
        : {}),
    }));
  };

  const run = useMutation({
    mutationFn: () =>
      api<Ok>('POST', '/api/me/password', {
        oldPassword: values.oldPassword,
        newPassword: values.newPassword,
      }),
    onSuccess: async () => {
      await qc.fetchQuery({ ...meQuery, staleTime: 0 });
      if (next && next !== '/') window.location.assign(next);
      else void nav({ to: '/', replace: true });
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors: Partial<Record<ChangePasswordField, string>> = {
      oldPassword: validateField('oldPassword', values),
      newPassword: validateField('newPassword', values),
      confirmPassword: validateField('confirmPassword', values),
    };
    const firstInvalid = (['oldPassword', 'newPassword', 'confirmPassword'] as const).find(
      (k) => nextErrors[k],
    );
    if (firstInvalid) {
      setDirty({ oldPassword: true, newPassword: true, confirmPassword: true });
      setErrors(nextErrors);
      if (firstInvalid === 'oldPassword') oldRef.current?.focus();
      else if (firstInvalid === 'newPassword') newRef.current?.focus();
      else confirmRef.current?.focus();
      return;
    }
    run.mutate();
  };

  return (
    <AuthShell
      name={instance.data?.name ?? t('app.name')}
      tagline={t('app.tagline')}
      title={t('account.changePasswordTitle')}
    >
      <Banner kind="warn">{t('account.changePasswordBanner')}</Banner>
      <form className="space-y-3.5" noValidate onSubmit={onSubmit}>
        <label className="field">
          <span className="label">{t('account.oldPassword')}</span>
          <input
            ref={oldRef}
            className="input"
            type="password"
            name="oldPassword"
            value={values.oldPassword}
            onChange={onChange('oldPassword')}
            onBlur={onBlur('oldPassword')}
            autoComplete="current-password"
            aria-invalid={errors.oldPassword ? 'true' : 'false'}
            aria-describedby={errors.oldPassword ? 'cp-old-err' : undefined}
          />
          {errors.oldPassword && (
            <p id="cp-old-err" className="hint error">
              {errors.oldPassword}
            </p>
          )}
        </label>
        <label className="field">
          <span className="label">{t('account.newPassword')}</span>
          <input
            ref={newRef}
            className="input"
            type="password"
            name="newPassword"
            value={values.newPassword}
            onChange={onChange('newPassword')}
            onBlur={onBlur('newPassword')}
            autoComplete="new-password"
            aria-invalid={errors.newPassword ? 'true' : 'false'}
            aria-describedby={errors.newPassword ? 'cp-new-err cp-new-hint' : 'cp-new-hint'}
          />
          <p id="cp-new-hint" className="hint">
            {t('auth.passwordHint')}
          </p>
          {errors.newPassword && (
            <p id="cp-new-err" className="hint error">
              {errors.newPassword}
            </p>
          )}
        </label>
        <label className="field">
          <span className="label">{t('account.confirmPassword')}</span>
          <input
            ref={confirmRef}
            className="input"
            type="password"
            name="confirmPassword"
            value={values.confirmPassword}
            onChange={onChange('confirmPassword')}
            onBlur={onBlur('confirmPassword')}
            autoComplete="new-password"
            aria-invalid={errors.confirmPassword ? 'true' : 'false'}
            aria-describedby={errors.confirmPassword ? 'cp-confirm-err' : undefined}
          />
          {errors.confirmPassword && (
            <p id="cp-confirm-err" className="hint error">
              {errors.confirmPassword}
            </p>
          )}
        </label>
        {run.error && (
          <Banner kind="danger" role="alert">
            {run.error.message}
          </Banner>
        )}
        <button
          type="submit"
          className="btn primary w-full"
          disabled={run.isPending}
          aria-busy={run.isPending}
        >
          {t('account.changePasswordSubmit')}
        </button>
      </form>
      <button
        type="button"
        className="btn ghost w-full"
        disabled={run.isPending}
        onClick={() => void signOut()}
      >
        {t('auth.logout')}
      </button>
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
