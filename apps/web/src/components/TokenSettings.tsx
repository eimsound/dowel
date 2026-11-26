// CI 令牌（P6）：项目设置里的令牌管理（T1）和实例 / 组 / 项目三层“谁能创建令牌”的配置（T2）。
// 令牌明文只在创建结果里出现一次；复制按钮遵循独立的 role="status" 实时区、失败提示与防重复定时器叠加。
import {
  CI_DOCS_PATH,
  type CiTokenCreated,
  type CiTokenInfo,
  type CiTokenList,
  effectiveTokenRules,
  type GroupList,
  TOKEN_CREATOR_DEFAULT,
  TOKEN_DEFAULT_DAYS,
  TOKEN_MAX_DAYS,
  type TokenCreatorGroup,
  type TokenCreatorRole,
  type TokenCreatorRule,
  type TokenPolicyLayer,
  type TokenPolicyNames,
  type TokenPolicyView,
} from '@dowel/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Lock, Plus, Trash2 } from 'lucide-react';
import { type Dispatch, type SetStateAction, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { formatTime } from '../format.ts';
import { Confirm } from './Modal.tsx';
import { useToast } from './Toasts.tsx';
import { Banner, IconButton } from './ui.tsx';

/** Clipboard API 不可用或被拒时的最后兜底 */
const legacyCopy = (text: string): boolean => {
  const field = Object.assign(document.createElement('textarea'), { value: text });
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
  }
};

/** 一次性令牌展示条：带独立 role="status" 实时区与失败兜底的复制按钮 */
const OneTimeToken = ({ created, onDismiss }: { created: CiTokenCreated; onDismiss: () => void }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [liveText, setLiveText] = useState('');
  const lastMsg = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const announce = (ok: boolean) => {
    clearTimeout(timer.current);
    let msg = t(ok ? 'tok.copied' : 'tok.copyFailed');
    if (msg === lastMsg.current) msg += '\u00A0';
    lastMsg.current = msg;
    setState(ok ? 'copied' : 'failed');
    setLiveText('');
    requestAnimationFrame(() => setLiveText(msg));
    timer.current = setTimeout(() => {
      setState('idle');
      setLiveText('');
    }, 2000);
  };

  const onCopy = async () => {
    const text = created.token;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else if (!legacyCopy(text)) throw new Error('copy failed');
      announce(true);
    } catch {
      if (legacyCopy(text)) announce(true);
      else announce(false);
    }
  };

  return (
    <Banner
      kind="ok"
      title={t('tok.createdTitle', { name: created.info.name })}
      action={
        <span className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5">
            <button
              type="button"
              className="btn sm min-h-6 min-w-6"
              data-copied={state === 'copied' ? '' : undefined}
              data-failed={state === 'failed' ? '' : undefined}
              onClick={() => void onCopy()}
            >
              {state === 'copied' ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
              {state === 'copied'
                ? t('tok.copied')
                : state === 'failed'
                  ? t('tok.copyFailed')
                  : t('tok.copy')}
            </button>
            <span className="sr-only" role="status">
              {liveText}
            </span>
          </span>
          <button type="button" className="btn ghost sm" onClick={onDismiss}>
            {t('tok.dismiss')}
          </button>
        </span>
      }
    >
      <span className="block">{t('tok.createdHint')}</span>
      <code
        data-testid="created-token-value"
        className="mt-1.5 block overflow-x-auto rounded-xs bg-surface-2 px-2 py-1.5 font-mono text-xs select-all"
      >
        {created.token}
      </code>
    </Banner>
  );
};

/** 规则的一行可读摘要 */
const describeRule = (
  t: ReturnType<typeof useTranslation>['t'],
  rule: TokenCreatorRule,
  names: TokenPolicyNames,
): string => {
  const parts: string[] = [];
  for (const r of rule.roles) parts.push(t(`tok.policy.role.${r}`));
  for (const g of rule.groups)
    parts.push(
      t(`tok.policy.group.${g.role}`, {
        name: names[g.groupId] ?? g.groupId,
      }),
    );
  return parts.length ? parts.join(' / ') : t('tok.policy.nobody');
};

/** 规则归一化（用于判断草稿是否脏） */
const normalizeDraft = (r: TokenCreatorRule | null) =>
  r
    ? {
        roles: [...new Set(r.roles)].sort(),
        groups: [...new Set(r.groups.map((g) => `${g.groupId}:${g.role}`))].sort(),
      }
    : null;

/**
 * 三层“谁能创建 CI 令牌”的配置（管理后台、组设置、项目设置共用）。
 * 规则逐层取与（下级只能收紧，ADR 0010）；上级已设置的规则灰显锁定。
 */
export const TokenPolicyPanel = ({ path, queryKey }: { path: string; queryKey: unknown[] }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const id = useId();
  const q = useQuery({ queryKey, queryFn: () => api<TokenPolicyView>('GET', path) });
  // 本地未保存草稿（按 path 隔离）：undefined 表示直接跟随服务端值，后台 refetch 不会覆盖正在编辑的草稿
  const [localDraft, setLocalDraft] = useState<{ path: string; rule: TokenCreatorRule | null } | undefined>(
    undefined,
  );
  const serverRule = q.data?.rule ?? null;
  const draft = localDraft?.path === path ? localDraft.rule : serverRule;
  const setDraft: Dispatch<SetStateAction<TokenCreatorRule | null>> = (next) => {
    setLocalDraft((prev) => {
      const base = prev?.path === path ? prev.rule : serverRule;
      const value = typeof next === 'function' ? next(base) : next;
      return JSON.stringify(normalizeDraft(value)) === JSON.stringify(normalizeDraft(serverRule))
        ? undefined
        : { path, rule: value };
    });
  };

  const canEdit = q.data?.canEdit ?? false;
  // 读取全部组列表（/api/groups 不受 /api/directory 的 20 条上限截断）
  const groupsQuery = useQuery({
    queryKey: ['groups'],
    queryFn: () => api<GroupList>('GET', '/api/groups'),
    enabled: canEdit,
  });

  const save = useMutation({
    mutationFn: (rule: TokenCreatorRule | null) => api<TokenPolicyView>('PUT', path, { rule }),
    onSuccess: (v) => {
      qc.setQueryData(queryKey, v);
      setLocalDraft(undefined);
      void qc.invalidateQueries({ queryKey: ['token-policy'] });
      void qc.invalidateQueries({ queryKey: ['ci-tokens'] });
      void qc.invalidateQueries({ queryKey: ['project'] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['group'] });
      toast(t('tok.policy.saved'));
    },
  });

  if (q.error)
    return (
      <Banner kind="danger" role="alert">
        {q.error.message}
      </Banner>
    );
  if (!q.data) return null;

  const v = q.data;
  const allGroups = groupsQuery.data?.groups ?? [];
  const names: TokenPolicyNames = {
    ...v.names,
    ...Object.fromEntries(allGroups.map((g) => [g.id, g.name])),
  };
  const liveLayers: Partial<Record<TokenPolicyLayer, TokenCreatorRule | null>> = {};
  for (const u of v.upper) liveLayers[u.layer] = u.rule;
  liveLayers[v.layer] = draft;
  const liveEffective = effectiveTokenRules(liveLayers);

  const dirty = JSON.stringify(normalizeDraft(draft)) !== JSON.stringify(normalizeDraft(v.rule));
  const disabled = !v.canEdit || save.isPending;
  const pickedGroupIds = new Set(draft?.groups.map((g) => g.groupId) ?? []);
  const remainingGroups = allGroups.filter((g) => !pickedGroupIds.has(g.id));

  const toggleRole = (role: TokenCreatorRole) => {
    if (!draft) return;
    const roles = draft.roles.includes(role) ? draft.roles.filter((r) => r !== role) : [...draft.roles, role];
    setDraft({ ...draft, roles });
  };

  const addGroup = () => {
    setDraft((prev) => {
      if (!prev) return prev;
      const picked = new Set(prev.groups.map((g) => g.groupId));
      const next = allGroups.find((g) => !picked.has(g.id));
      if (!next) return prev;
      return { ...prev, groups: [...prev.groups, { groupId: next.id, role: 'member' }] };
    });
  };

  const updateGroup = (idx: number, patch: Partial<TokenCreatorGroup>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      if (
        patch.groupId !== undefined &&
        prev.groups.some((g, i) => i !== idx && g.groupId === patch.groupId)
      ) {
        return prev;
      }
      return {
        ...prev,
        groups: prev.groups.map((g, i) => (i === idx ? { ...g, ...patch } : g)),
      };
    });
  };

  const removeGroup = (idx: number) => {
    if (!draft) return;
    setDraft({ ...draft, groups: draft.groups.filter((_, i) => i !== idx) });
  };

  return (
    <div className="space-y-3 rounded-md border border-border bg-panel p-4" data-testid="token-policy-panel">
      <p className="hint mt-0">{t('tok.policy.intro')}</p>
      {!v.canEdit && <p className="hint">{t(`tok.policy.readonly.${v.layer}`)}</p>}

      {v.upper.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-text-2">{t('tok.policy.upperTitle')}</p>
          <ul className="m-0 list-none space-y-1.5 p-0">
            {v.upper.map((u) => (
              <li
                key={u.layer}
                data-testid={`token-policy-locked-${u.layer}`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-2"
              >
                <Lock size={12} aria-hidden="true" />
                <span className="chip">{t('tok.policy.lockedBy', { layer: t(`pol.layer.${u.layer}`) })}</span>
                <span>{describeRule(t, u.rule, names)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <fieldset className="space-y-2 border-0 p-0">
        <legend className="label mb-1">{t('tok.policy.modeLabel')}</legend>
        <div className="flex flex-wrap gap-4">
          <label className="check">
            <input
              type="radio"
              name={`${id}-mode`}
              checked={draft === null}
              disabled={disabled}
              onChange={() => setDraft(null)}
            />
            <span>{v.upper.length ? t('tok.policy.inheritUpper') : t('tok.policy.inheritDefault')}</span>
          </label>
          <label className="check">
            <input
              type="radio"
              name={`${id}-mode`}
              checked={draft !== null}
              disabled={disabled}
              onChange={() => setDraft(v.rule ?? { ...TOKEN_CREATOR_DEFAULT })}
            />
            <span>{t('tok.policy.custom')}</span>
          </label>
        </div>
      </fieldset>

      {draft !== null && (
        <div className="bg-surface-1 space-y-3 rounded-md border border-border p-3">
          <fieldset className="space-y-1.5 border-0 p-0">
            <legend className="label mb-1">{t('tok.policy.rolesLabel')}</legend>
            <div className="checks">
              {(['admin', 'editor'] as const).map((r) => (
                <label key={r} className="check">
                  <input
                    type="checkbox"
                    name={`${id}-role-${r}`}
                    checked={draft.roles.includes(r)}
                    disabled={disabled}
                    onChange={() => toggleRole(r)}
                  />
                  <span>{t(`tok.policy.role.${r}`)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="label">{t('tok.policy.groupsLabel')}</span>
              {!disabled && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={remainingGroups.length === 0}
                  onClick={addGroup}
                >
                  <Plus size={14} aria-hidden="true" />
                  {t('tok.policy.addGroup')}
                </button>
              )}
            </div>
            {draft.groups.length > 0 ? (
              <ul className="m-0 list-none space-y-1.5 p-0">
                {draft.groups.map((g, i) => (
                  <li key={i} className="flex flex-wrap items-end gap-2">
                    <div className="field w-48">
                      <label className="label" htmlFor={`${id}-g-${i}`}>
                        {t('tok.policy.groupCol')}
                      </label>
                      <select
                        id={`${id}-g-${i}`}
                        name={`group-${i}`}
                        className="select"
                        value={g.groupId}
                        disabled={disabled}
                        onChange={(e) => updateGroup(i, { groupId: e.target.value })}
                      >
                        {allGroups.map((x) => (
                          <option
                            key={x.id}
                            value={x.id}
                            disabled={x.id !== g.groupId && pickedGroupIds.has(x.id)}
                          >
                            {x.name}
                          </option>
                        ))}
                        {g.groupId && !allGroups.some((x) => x.id === g.groupId) && (
                          <option value={g.groupId}>{names[g.groupId] ?? g.groupId}</option>
                        )}
                      </select>
                    </div>
                    <div className="field w-44">
                      <label className="label" htmlFor={`${id}-gr-${i}`}>
                        {t('tok.policy.groupRoleCol')}
                      </label>
                      <select
                        id={`${id}-gr-${i}`}
                        name={`group-role-${i}`}
                        className="select"
                        value={g.role}
                        disabled={disabled}
                        onChange={(e) => updateGroup(i, { role: e.target.value as 'admin' | 'member' })}
                      >
                        <option value="member">{t('tok.policy.groupRole.member')}</option>
                        <option value="admin">{t('tok.policy.groupRole.admin')}</option>
                      </select>
                    </div>
                    {!disabled && (
                      <IconButton
                        label={t('tok.policy.removeGroup', { n: i + 1 })}
                        className="hover:!text-danger"
                        onClick={() => removeGroup(i)}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </IconButton>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">{t('tok.policy.noGroups')}</p>
            )}
          </div>

          {draft.roles.length === 0 && draft.groups.length === 0 && (
            <Banner kind="warn">{t('tok.policy.nobodyWarn')}</Banner>
          )}
        </div>
      )}

      <div className="space-y-1 text-xs text-text-2" data-testid="token-policy-effective">
        <span className="font-medium">{t('tok.policy.effectiveLabel')}</span>{' '}
        <span>
          {liveEffective
            .map((e) =>
              e.layer === 'default'
                ? `${describeRule(t, e.rule, names)}（${t('pol.source.default')}）`
                : `${t(`pol.layer.${e.layer}`)}：${describeRule(t, e.rule, names)}`,
            )
            .join(t('tok.policy.andJoin'))}
        </span>
      </div>
      <p className="hint">{t('tok.policy.visibilityHint')}</p>
      <Banner kind="warn">{t('tok.policy.execWarn')}</Banner>

      {save.error && (
        <Banner kind="danger" role="alert">
          {save.error.message}
        </Banner>
      )}

      {v.canEdit && (
        <div className="flex gap-2">
          <button
            type="button"
            className="btn primary"
            disabled={!dirty || save.isPending}
            aria-busy={save.isPending}
            onClick={() => save.mutate(draft)}
          >
            {t('tok.policy.save')}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={!dirty || save.isPending}
            onClick={() => setDraft(v.rule)}
          >
            {t('pol.reset')}
          </button>
        </div>
      )}
    </div>
  );
};

/** 项目设置里的 CI 令牌管理：创建（明文只显示一次）、列表、吊销 */
export const ProjectTokensPanel = ({ pid }: { pid: string }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const formId = useId();
  const headingId = `${formId}-heading`;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [days, setDays] = useState(String(TOKEN_DEFAULT_DAYS));
  const [created, setCreated] = useState<CiTokenCreated | null>(null);
  const [revoking, setRevoking] = useState<CiTokenInfo | null>(null);

  const list = useQuery({
    queryKey: ['ci-tokens', pid],
    queryFn: () => api<CiTokenList>('GET', `/api/projects/${pid}/tokens`),
  });

  const create = useMutation({
    mutationFn: () =>
      api<CiTokenCreated>('POST', `/api/projects/${pid}/tokens`, {
        name: name.trim(),
        description: description.trim(),
        expiresInDays: Number(days),
      }),
    onSuccess: (res) => {
      setCreated(res);
      setName('');
      setDescription('');
      setDays(String(TOKEN_DEFAULT_DAYS));
      toast(t('tok.createdToast'));
      void qc.invalidateQueries({ queryKey: ['ci-tokens', pid] });
    },
  });

  const revoke = useMutation({
    mutationFn: (tid: string) => api<CiTokenInfo>('POST', `/api/projects/${pid}/tokens/${tid}/revoke`, {}),
    onSuccess: () => {
      setRevoking(null);
      toast(t('tok.revokedToast'));
      void qc.invalidateQueries({ queryKey: ['ci-tokens', pid] });
    },
  });

  if (list.error)
    return (
      <Banner kind="danger" role="alert">
        {list.error.message}
      </Banner>
    );

  const tokens = list.data?.tokens ?? [];
  const canCreate = list.data?.canCreate ?? false;

  return (
    <div className="space-y-4" data-testid="ci-tokens-panel">
      <p className="hint mt-0">
        {t('tok.intro')} {/* CI API 交互文档（M3-C）：服务端页面，登录会话即可查看，不走 SPA 路由 */}
        <a className="text-primary-text underline" href={CI_DOCS_PATH}>
          {t('tok.apiDocs')}
        </a>
      </p>

      {created && <OneTimeToken created={created} onDismiss={() => setCreated(null)} />}

      {canCreate && (
        <form
          aria-labelledby={headingId}
          className="space-y-3 rounded-md border border-border bg-panel p-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <h3 id={headingId} className="m-0 text-sm font-medium">
            {t('tok.createTitle')}
          </h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="field w-52">
              <label className="label" htmlFor={`${formId}-name`}>
                {t('tok.name')}
              </label>
              <input
                id={`${formId}-name`}
                name="name"
                className="input"
                value={name}
                maxLength={100}
                required
                autoComplete="off"
                placeholder={t('tok.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field min-w-52 flex-1">
              <label className="label" htmlFor={`${formId}-desc`}>
                {t('tok.description')}
              </label>
              <input
                id={`${formId}-desc`}
                name="description"
                className="input"
                value={description}
                maxLength={500}
                autoComplete="off"
                placeholder={t('tok.descriptionPlaceholder')}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="field w-36">
              <label className="label" htmlFor={`${formId}-days`}>
                {t('tok.expiresInDays')}
              </label>
              <input
                id={`${formId}-days`}
                name="expiresInDays"
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={TOKEN_MAX_DAYS}
                required
                aria-describedby={`${formId}-days-hint`}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </div>
            <button
              type="submit"
              className="btn primary"
              disabled={create.isPending}
              aria-busy={create.isPending}
            >
              <KeyRound size={16} aria-hidden="true" />
              {t('tok.create')}
            </button>
          </div>
          <p id={`${formId}-days-hint`} className="hint mb-0">
            {t('tok.expiresHint', { defaultDays: TOKEN_DEFAULT_DAYS, maxDays: TOKEN_MAX_DAYS })}
          </p>
          {create.error && (
            <Banner kind="danger" role="alert">
              {create.error.message}
            </Banner>
          )}
        </form>
      )}

      <div className="overflow-x-auto rounded-md border border-border bg-panel">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('tok.col.name')}</th>
              <th scope="col">{t('tok.col.status')}</th>
              <th scope="col">{t('tok.col.createdBy')}</th>
              <th scope="col">{t('tok.col.expiresAt')}</th>
              <th scope="col">{t('tok.col.lastUsed')}</th>
              <th scope="col">
                <span className="sr-only">{t('tok.revoke')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((tok) => (
              <tr key={tok.id}>
                <td>
                  <span className="block font-medium">{tok.name}</span>
                  <span className="block font-mono text-xs text-text-3">{tok.prefix}…</span>
                  {tok.description && <span className="block text-xs text-text-2">{tok.description}</span>}
                </td>
                <td>
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    <span
                      aria-hidden="true"
                      className={`size-[7px] rounded-full ${
                        tok.status === 'active'
                          ? 'bg-ok'
                          : tok.status === 'expired'
                            ? 'bg-warn'
                            : 'bg-border-strong'
                      }`}
                    />
                    <span className={tok.status === 'active' ? 'text-text' : 'text-text-3'}>
                      {t(`tok.status.${tok.status}`)}
                    </span>
                  </span>
                </td>
                <td className="text-xs text-text-2">
                  <span className="block">{tok.createdBy?.name ?? '—'}</span>
                  <time dateTime={tok.createdAt} className="text-text-3">
                    {formatTime(tok.createdAt)}
                  </time>
                </td>
                <td>
                  <time dateTime={tok.expiresAt} className="text-xs whitespace-nowrap text-text-3">
                    {formatTime(tok.expiresAt)}
                  </time>
                </td>
                <td className="text-xs text-text-3">
                  {tok.lastUsedAt ? (
                    <>
                      <time dateTime={tok.lastUsedAt} className="block whitespace-nowrap">
                        {formatTime(tok.lastUsedAt)}
                      </time>
                      {tok.lastUsedIp && <span className="font-mono">{tok.lastUsedIp}</span>}
                    </>
                  ) : (
                    t('tok.neverUsed')
                  )}
                </td>
                <td>
                  {tok.canRevoke && (
                    <button
                      type="button"
                      className="btn sm danger"
                      disabled={revoke.isPending}
                      onClick={() => setRevoking(tok)}
                    >
                      {t('tok.revoke')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tokens.length === 0 && <p className="px-3 py-6 text-center text-sm text-text-3">{t('tok.empty')}</p>}
      </div>

      <Confirm
        open={!!revoking}
        onClose={() => {
          setRevoking(null);
          revoke.reset();
        }}
        title={t('tok.revokeTitle', { name: revoking?.name ?? '' })}
        confirmLabel={t('tok.revoke')}
        pending={revoke.isPending}
        error={revoke.error?.message}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      >
        {t('tok.revokeHint', { prefix: revoking?.prefix ?? '' })}
      </Confirm>
    </div>
  );
};
