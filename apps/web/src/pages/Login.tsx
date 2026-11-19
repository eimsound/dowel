// 登录页：用户名 + 密码，以及实例里启用的 OIDC 提供方。
// 实例名称和提供方从公开的 /api/instance 读；密码登录被关闭时给出提示并禁用表单。
// 没有注册入口：注册只能通过邀请（02-consensus.md 11.1）。
import type { Me } from '@dowel/api';
import { useMutation } from '@tanstack/react-query';
import { useNavigate, useRouterState, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { AuthShell, useSetMe } from '../components/AuthShell.tsx';
import { Banner } from '../components/ui.tsx';
import { useInstance } from '../instance.ts';
import { safeNext } from '../safe-next.ts';

export const Login = () => {
  const { t } = useTranslation();
  const nav = useNavigate();
  const instance = useInstance();
  const setMe = useSetMe();
  const { next: rawNext } = useSearch({ from: '/login' });
  const next = safeNext(rawNext);
  const [form, setForm] = useState({ username: '', password: '' });
  const run = useMutation({
    mutationFn: () => api<Me>('POST', '/api/auth/login', form),
    onSuccess: (me) => {
      setMe(me);
      // 未登录时被重定向过来的，登录后回到原地址（只接受站内路径）
      if (next && next !== '/') window.location.assign(next);
      else void nav({ to: '/' });
    },
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });
  const passwordDisabled = instance.data ? !instance.data.passwordLogin : false;
  // 回调失败时服务端只带回固定错误码；这里映射成固定文案，未知的码显示通用文案。
  // 不直接显示 URL 内容，避免 IdP 的 error_description 之类的输入被当成提示。
  const search = useRouterState({ select: (s) => s.location.searchStr ?? '' });
  const oidcError = new URLSearchParams(search).get('oidc_error');
  const oidcErrorKey = oidcError
    ? ({
        not_invited: 'account.oidcError.not_invited',
        disabled: 'account.oidcError.disabled',
        state: 'account.oidcError.state',
        provider: 'account.oidcError.provider',
        token: 'account.oidcError.token',
        link_conflict: 'account.oidcError.link_conflict',
        link_session: 'account.oidcError.link_session',
      }[oidcError] ?? 'account.oidcError.unknown')
    : null;
  const providers = instance.data?.providers ?? [];
  return (
    <AuthShell name={instance.data?.name ?? t('app.name')} tagline={t('app.tagline')} title={t('auth.login')}>
      {passwordDisabled && <Banner kind="warn">{t('account.passwordLoginOff')}</Banner>}
      {oidcErrorKey && (
        <Banner kind="danger" role="alert">
          {t(oidcErrorKey)}
        </Banner>
      )}
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
            autoComplete="current-password"
          />
        </label>
        {run.error && (
          <Banner kind="danger" role="alert">
            {run.error.message}
          </Banner>
        )}
        <button type="submit" className="btn primary w-full" disabled={run.isPending || passwordDisabled}>
          {t('auth.login')}
        </button>
      </form>
      {providers.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3.5">
          {providers.map((p) => (
            <a
              key={p.slug}
              className="btn w-full"
              href={`/api/auth/oidc/${encodeURIComponent(p.slug)}/start${
                next ? `?next=${encodeURIComponent(next)}` : ''
              }`}
            >
              {t('auth.oidcLogin', { name: p.name })}
            </a>
          ))}
        </div>
      )}
    </AuthShell>
  );
};
