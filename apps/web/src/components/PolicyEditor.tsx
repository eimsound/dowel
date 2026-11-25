// 执行策略配置（P5a，E9）：实例（管理后台）、组、项目、环境四处共用。
// 合并、严格程度、锁定都由服务端和这里共用的 @dowel/api 纯函数算（resolvePolicy / validateLayer）：
// 编辑时在本地重新合并，立刻显示生效值和来源；上级设定的下限显示为“由 X 锁定”，比它宽的选项禁用。
// 保存时服务端再校验一遍（只能收紧；放宽是特权操作），错误原样显示。
import {
  type ApprovalStage,
  type Approver,
  compareField,
  type Directory,
  type EffectiveValues,
  type EnvPolicyPut,
  type EnvPolicyView,
  type ExecPolicy,
  type LayerPolicy,
  normalizeSettings,
  type PolicyInput,
  type PolicyLayer,
  type PolicyLayerView,
  type PolicyNames,
  type PolicySettings,
  type ResolvedField,
  type ResolvedPolicy,
  resolvePolicy,
  validateLayer,
} from '@dowel/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { invalidatePolicyDependents } from '../policy-cache.ts';
import { tokenBypassRisk } from '../token-guard.ts';
import { useToast } from './Toasts.tsx';
import { Banner, IconButton } from './ui.tsx';

const WHO: ExecPolicy[] = ['editor', 'admin', 'executor'];

const KINDS: Approver['kind'][] = [
  'project_admins',
  'group_admins',
  'executors',
  'group_members',
  'group_admins_of',
  'users',
];

/** 把一层的设置拆回“上级输入 + 本层”，用来在本地重新合并（编辑时立刻显示生效值） */
const upperFrom = (r: ResolvedPolicy): PolicyInput => {
  const out: PolicyInput = {};
  const put = <K extends keyof PolicySettings>(layer: PolicyLayer, key: K, v: PolicySettings[K]) => {
    out[layer] = { ...(out[layer] ?? {}), [key]: v };
  };
  for (const f of [
    'whoCanExecute',
    'allowTokens',
    'statementTimeoutMs',
    'lockTimeoutMs',
    'requestTtlHours',
  ] as const) {
    const field = r[f] as ResolvedField<EffectiveValues[typeof f]>;
    if (field.floor !== null && field.floorSource) put(field.floorSource, f, field.floor as never);
  }
  for (const s of r.approval.stages)
    if (s.locked) put(s.source, 'approval', [...(out[s.source]?.approval ?? []), s.stage]);
  return out;
};

const secondsOf = (ms: number | undefined) => (ms === undefined ? '' : String(ms / 1000));

const useLabels = () => {
  const { t } = useTranslation();
  const value = <F extends keyof EffectiveValues>(f: F, v: EffectiveValues[F]) =>
    f === 'whoCanExecute'
      ? t(`pol.who.${v as ExecPolicy}`)
      : f === 'allowTokens'
        ? t(v ? 'pol.tokens.yes' : 'pol.tokens.no')
        : f === 'requestTtlHours'
          ? t('pol.hours', { n: v as number })
          : v === 0
            ? t('pol.unlimited')
            : t('pol.seconds', { n: (v as number) / 1000 });
  const source = (s: ResolvedField<unknown>['source']) => t(`pol.source.${s}`);
  const layer = (l: PolicyLayer) => t(`pol.layer.${l}`);
  return { t, value, source, layer };
};

/** 一个标量字段的生效值 / 来源 / 锁定说明 */
const Effective = <F extends keyof EffectiveValues>({
  field,
  r,
}: {
  field: F;
  r: ResolvedField<EffectiveValues[F]>;
}) => {
  const { t, value, source, layer } = useLabels();
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-xs text-text-3">
      <span>
        {t('pol.effective', { value: value(field, r.value) })} · {source(r.source)}
      </span>
      {r.floor !== null && r.floorSource && (
        <span className="chip inline-flex items-center gap-1" data-testid={`locked-${field}`}>
          <Lock size={12} aria-hidden="true" />
          {t('pol.lockedBy', { layer: layer(r.floorSource), value: value(field, r.floor) })}
        </span>
      )}
    </span>
  );
};

/** 审批人范围的显示 */
const approverText = (t: ReturnType<typeof useTranslation>['t'], a: Approver, names: PolicyNames) => {
  if (a.kind === 'group_members' || a.kind === 'group_admins_of')
    return `${t(`pol.approval.kinds.${a.kind}`)} · ${names[a.groupId] ?? a.groupId}`;
  if (a.kind === 'users')
    return `${t('pol.approval.kinds.users')} · ${a.userIds.map((u) => names[u] ?? u).join('、')}`;
  return t(`pol.approval.kinds.${a.kind}`);
};

/**
 * 审批人里的“指定用户”：按名字 / 用户名搜索（目录接口），选中的显示成可以移除的标签（P5b，替换 P5a 的前 20 个用户多选）。
 */
const UserPicker = ({
  value,
  onChange,
  disabled,
  names,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
  names: PolicyNames;
}) => {
  const { t } = useTranslation();
  const id = useId();
  const [q, setQ] = useState('');
  const [known, setKnown] = useState<Record<string, string>>({});
  const term = q.trim();
  const search = useQuery({
    queryKey: ['directory', term],
    queryFn: () => api<Directory>('GET', `/api/directory?q=${encodeURIComponent(term)}`),
    enabled: !disabled && term.length > 0,
  });
  const nameOf = (u: string) => known[u] ?? names[u] ?? u;
  const results = (search.data?.users ?? []).filter((u) => !value.includes(u.id)).slice(0, 8);
  return (
    <fieldset className="field min-w-56">
      <legend className="label">{t('pol.approval.users')}</legend>
      {value.length > 0 ? (
        <ul className="flex list-none flex-wrap gap-1 p-0" aria-label={t('pol.approval.usersPicked')}>
          {value.map((u) => (
            <li key={u} className="chip">
              {nameOf(u)}
              {!disabled && (
                <button
                  type="button"
                  className="text-text-3 hover:text-danger"
                  aria-label={t('pol.approval.userRemove', { name: nameOf(u) })}
                  onClick={() => onChange(value.filter((x) => x !== u))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <span className="hint">{t('pol.approval.usersNone')}</span>
      )}
      {!disabled && (
        <>
          <input
            id={`${id}-q`}
            className="input"
            type="search"
            value={q}
            placeholder={t('pol.approval.userSearch')}
            aria-label={t('pol.approval.userSearch')}
            autoComplete="off"
            onChange={(e) => setQ(e.target.value)}
          />
          {term && (
            <ul className="list-none space-y-0.5 p-0" aria-label={t('pol.approval.userResults')}>
              {results.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setKnown((k) => ({ ...k, [u.id]: `${u.name}（${u.slug}）` }));
                      onChange([...value, u.id]);
                      setQ('');
                    }}
                  >
                    {t('pol.approval.userAdd', { name: `${u.name}（${u.slug}）` })}
                  </button>
                </li>
              ))}
              {search.data && results.length === 0 && (
                <li className="hint">{t('pol.approval.userNoMatch')}</li>
              )}
            </ul>
          )}
        </>
      )}
    </fieldset>
  );
};

/**
 * 两个环节的审批人范围可能重叠（P5b 配置页提示）：同一个人可以分别批这两个环节（每个环节单独确认）。
 * 只列出明显的情况：范围相同、指定用户有交集、组管理员 ⊆ 项目管理员、同一个组的组管理员 ⊆ 组成员。
 */
export const approversOverlap = (a: Approver, b: Approver): boolean => {
  if (a.kind === 'users' && b.kind === 'users') return a.userIds.some((u) => b.userIds.includes(u));
  const g = (x: Approver) => ('groupId' in x ? x.groupId : null);
  if (a.kind === b.kind) return g(a) === g(b);
  const kinds = new Set([a.kind, b.kind]);
  if (kinds.has('project_admins') && kinds.has('group_admins')) return true;
  if (kinds.has('group_members') && kinds.has('group_admins_of')) return g(a) === g(b);
  return false;
};

const StageEditor = ({
  stage,
  index,
  last,
  onChange,
  onRemove,
  disabled,
  dir,
  names,
}: {
  stage: ApprovalStage;
  index: number;
  last: boolean;
  onChange: (s: ApprovalStage) => void;
  onRemove: () => void;
  disabled: boolean;
  dir: Directory | undefined;
  names: PolicyNames;
}) => {
  const { t } = useTranslation();
  const id = useId();
  const a = stage.approvers;
  const setKind = (kind: Approver['kind']) => {
    const g = dir?.groups[0]?.id ?? '';
    const next: Approver =
      kind === 'group_members' || kind === 'group_admins_of'
        ? { kind, groupId: g }
        : kind === 'users'
          ? { kind, userIds: [] }
          : { kind };
    onChange({ ...stage, approvers: next, count: 1 });
  };
  return (
    <li className="flex flex-wrap items-end gap-2 rounded-md border border-border px-3 py-2">
      <span className="pb-1.5 text-sm font-medium">{t('pol.approval.stage', { n: index + 1 })}</span>
      <label className="field w-44" htmlFor={`${id}-k`}>
        <span className="label">{t('pol.approval.approvers')}</span>
        <select
          id={`${id}-k`}
          className="select"
          value={a.kind}
          disabled={disabled}
          onChange={(e) => setKind(e.target.value as Approver['kind'])}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`pol.approval.kinds.${k}`)}
            </option>
          ))}
        </select>
      </label>
      {(a.kind === 'group_members' || a.kind === 'group_admins_of') && (
        <label className="field w-40" htmlFor={`${id}-g`}>
          <span className="label">{t('pol.approval.group')}</span>
          <select
            id={`${id}-g`}
            className="select"
            value={a.groupId}
            disabled={disabled}
            onChange={(e) => onChange({ ...stage, approvers: { ...a, groupId: e.target.value } })}
          >
            {(dir?.groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {a.kind === 'users' && (
        <UserPicker
          value={a.userIds}
          names={names}
          disabled={disabled}
          onChange={(userIds) => onChange({ ...stage, approvers: { kind: 'users', userIds } })}
        />
      )}
      <label className="field w-20" htmlFor={`${id}-n`}>
        <span className="label">{t('pol.approval.count')}</span>
        <input
          id={`${id}-n`}
          className="input"
          type="number"
          min={1}
          max={10}
          value={stage.count}
          disabled={disabled}
          onChange={(e) => onChange({ ...stage, count: Math.max(1, Number(e.target.value) || 1) })}
        />
      </label>
      {last && (
        <label className="flex items-center gap-1.5 pb-1.5 text-sm">
          <input
            type="checkbox"
            checked={stage.lastApproverExecutes}
            disabled={disabled}
            onChange={(e) => onChange({ ...stage, lastApproverExecutes: e.target.checked })}
          />
          {t('pol.approval.last')}
        </label>
      )}
      <IconButton
        label={t('pol.approval.remove', { n: index + 1 })}
        className="hover:!text-danger"
        disabled={disabled}
        onClick={onRemove}
      >
        <Trash2 size={16} aria-hidden="true" />
      </IconButton>
    </li>
  );
};

/**
 * 编辑一套设置（生产或非生产；环境层只有一套）。resolved 是服务端给出的“从这一层看”的生效策略，
 * 用它拆出上级的下限，再和正在编辑的值在本地合并。
 */
export const PolicySetEditor = ({
  title,
  at,
  production,
  resolved,
  value,
  onChange,
  disabled,
  canEdit = !disabled,
  names,
}: {
  title?: string;
  at: PolicyLayer;
  production: boolean;
  resolved: ResolvedPolicy;
  value: PolicySettings;
  onChange: (v: PolicySettings) => void;
  disabled: boolean;
  /** 这一层能不能改（区分“只读”和“正在保存”：保存中只禁用操作，不隐藏） */
  canEdit?: boolean;
  names: PolicyNames;
}) => {
  const { t, value: label, layer } = useLabels();
  const id = useId();
  const tokRef = useRef<HTMLSelectElement>(null);
  const upper = useMemo(() => upperFrom(resolved), [resolved]);
  const live = resolvePolicy({ ...upper, [at]: value }, production, at);
  const problems = validateLayer(upper, value, production, at);
  const bypass = tokenBypassRisk(live);
  // 令牌提醒的礼貌播报：挂载时不播（静态内容读屏按顺序能读到），之后因编辑出现时播一次结论，消失时清空
  const [announce, setAnnounce] = useState('');
  const [prevBypass, setPrevBypass] = useState(bypass);
  if (bypass !== prevBypass) {
    setPrevBypass(bypass);
    setAnnounce(bypass ? t('pol.tokenGuard.title') : '');
  }
  const dir = useQuery({
    queryKey: ['directory', ''],
    queryFn: () => api<Directory>('GET', '/api/directory?q='),
    enabled: !disabled,
  });
  const set = <K extends keyof PolicySettings>(k: K, v: PolicySettings[K] | undefined) => {
    const next = { ...value };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  const tooLoose = <F extends 'whoCanExecute' | 'allowTokens'>(f: F, v: EffectiveValues[F]) => {
    const floor = live[f].floor as EffectiveValues[F] | null;
    return floor !== null && compareField(f, v, floor) < 0;
  };
  const timeout = (f: 'statementTimeoutMs' | 'lockTimeoutMs', labelKey: string) => (
    <div className="space-y-1">
      <label className="field" htmlFor={`${id}-${f}`}>
        <span className="label">{t(labelKey)}</span>
        <input
          id={`${id}-${f}`}
          className="input w-40"
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          placeholder={t('pol.inheritShort')}
          value={secondsOf(value[f])}
          disabled={disabled}
          aria-describedby={`${id}-${f}-hint`}
          onChange={(e) => {
            const raw = e.target.value.trim();
            const n = Number(raw);
            set(f, raw === '' || !Number.isFinite(n) || n < 0 ? undefined : Math.round(n * 1000));
          }}
        />
      </label>
      <span id={`${id}-${f}-hint`} className="block">
        <Effective field={f} r={live[f]} />
      </span>
    </div>
  );
  const own = value.approval ?? [];
  const locked = live.approval.stages.filter((s) => s.locked);
  const all = [...locked.map((s) => s.stage), ...own];
  const overlaps: [number, number][] = [];
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      if (approversOverlap(all[i]!.approvers, all[j]!.approvers)) overlaps.push([i + 1, j + 1]);
  return (
    <fieldset className="m-0 min-w-0 overflow-hidden rounded-md border border-border bg-panel p-0">
      {title && (
        <legend className="float-left flex w-full items-center gap-2 border-b border-border bg-[var(--node-head)] px-4 py-2.5 text-sm font-semibold text-text">
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${production ? 'bg-warn' : 'bg-border-strong'}`}
          />
          {title}
        </legend>
      )}
      <div className="clear-both space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="field" htmlFor={`${id}-who`}>
              <span className="label">{t('pol.who.label')}</span>
              <select
                id={`${id}-who`}
                className="select"
                value={value.whoCanExecute ?? ''}
                disabled={disabled}
                onChange={(e) =>
                  set('whoCanExecute', (e.target.value || undefined) as ExecPolicy | undefined)
                }
              >
                <option value="">{t('pol.inherit')}</option>
                {WHO.map((w) => (
                  <option key={w} value={w} disabled={tooLoose('whoCanExecute', w)}>
                    {label('whoCanExecute', w)}
                    {tooLoose('whoCanExecute', w) ? ` ${t('pol.tooLoose')}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <Effective field="whoCanExecute" r={live.whoCanExecute} />
          </div>
          <div className="space-y-1">
            <label className="field" htmlFor={`${id}-tok`}>
              <span className="label">{t('pol.tokens.label')}</span>
              <select
                ref={tokRef}
                id={`${id}-tok`}
                className="select"
                value={value.allowTokens === undefined ? '' : String(value.allowTokens)}
                disabled={disabled}
                aria-describedby={`${id}-tok-hint`}
                onChange={(e) =>
                  set('allowTokens', e.target.value === '' ? undefined : e.target.value === 'true')
                }
              >
                <option value="">{t('pol.inherit')}</option>
                <option value="true" disabled={tooLoose('allowTokens', true)}>
                  {t('pol.tokens.yes')}
                  {tooLoose('allowTokens', true) ? ` ${t('pol.tooLoose')}` : ''}
                </option>
                <option value="false">{t('pol.tokens.no')}</option>
              </select>
            </label>
            <span id={`${id}-tok-hint`} className="block">
              <Effective field="allowTokens" r={live.allowTokens} />
            </span>
          </div>
          {timeout('lockTimeoutMs', 'pol.lockTimeout')}
          {timeout('statementTimeoutMs', 'pol.statementTimeout')}
          <div className="space-y-1">
            <label className="field" htmlFor={`${id}-ttl`}>
              <span className="label">{t('pol.ttl')}</span>
              <input
                id={`${id}-ttl`}
                className="input w-40"
                type="number"
                min={1}
                max={720}
                step={1}
                inputMode="numeric"
                placeholder={t('pol.inheritShort')}
                value={value.requestTtlHours ?? ''}
                disabled={disabled}
                aria-describedby={`${id}-ttl-hint`}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const n = Number(raw);
                  set(
                    'requestTtlHours',
                    raw === '' || !Number.isInteger(n) || n < 1 ? undefined : Math.min(720, n),
                  );
                }}
              />
            </label>
            <span id={`${id}-ttl-hint`} className="block">
              <Effective field="requestTtlHours" r={live.requestTtlHours} />
            </span>
          </div>
        </div>
        <div className="space-y-1">
          <p className="hint m-0">{t('pol.timeoutHint')}</p>
          <p className="hint m-0">{t('pol.ttlHint')}</p>
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          <h3 className="text-sm font-medium">{t('pol.approval.label')}</h3>
          <p className="hint">{t('pol.approval.note')}</p>
          {locked.length === 0 && own.length === 0 && (
            <p className="text-sm text-text-2">{t('pol.approval.default')}</p>
          )}
          <ol className="list-none space-y-1.5 p-0">
            {locked.map((s, i) => (
              <li
                key={`l${i}`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-2"
              >
                <Lock size={12} aria-hidden="true" />
                <span>{t('pol.approval.stage', { n: i + 1 })}</span>
                <span>{approverText(t, s.stage.approvers, names)}</span>
                <span>· {t('pol.approval.countN', { n: s.stage.count })}</span>
                <span className="chip">{t('pol.approval.lockedStage', { layer: layer(s.source) })}</span>
              </li>
            ))}
          </ol>
          <ol className="list-none space-y-1.5 p-0">
            {own.map((s, i) => (
              <StageEditor
                key={i}
                stage={s}
                index={locked.length + i}
                last={i === own.length - 1}
                disabled={disabled}
                dir={dir.data}
                names={names}
                onChange={(n) =>
                  set(
                    'approval',
                    own.map((x, j) => (j === i ? n : x)),
                  )
                }
                onRemove={() => {
                  const rest = own.filter((_, j) => j !== i);
                  set(
                    'approval',
                    rest.length
                      ? rest.map((x, j) => (j < rest.length - 1 ? { ...x, lastApproverExecutes: false } : x))
                      : undefined,
                  );
                }}
              />
            ))}
          </ol>
          {overlaps.length > 0 && (
            <p className="hint" role="note" data-testid="approval-overlap">
              {t('pol.approval.overlap', { pairs: overlaps.map(([x, y]) => `${x} / ${y}`).join('、') })}
            </p>
          )}
          {!disabled && (
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                set('approval', [
                  ...own.map((x) => ({ ...x, lastApproverExecutes: false })),
                  { approvers: { kind: 'project_admins' }, count: 1, lastApproverExecutes: false },
                ])
              }
            >
              <Plus size={14} aria-hidden="true" />
              {t('pol.approval.add')}
            </button>
          )}
        </div>
        {bypass && (
          // 提示条本身不是 live region（里面有按钮，放进 live region 会被压平成纯文本）；出现 / 一键关闭的播报走下面单独的区域。
          // 一键关闭只改草稿（整层替换保存，不能顺带提交其他未完成的修改），保存后才生效
          <Banner
            kind="warn"
            action={
              canEdit && (
                <button
                  type="button"
                  className="btn sm shrink-0"
                  disabled={disabled}
                  aria-describedby={`${id}-tokwarn`}
                  onClick={() => {
                    // 先同步提交草稿再移焦点：提示条随之消失，焦点落到本套的“允许 CI 令牌执行”时读屏读到的是新值
                    flushSync(() => set('allowTokens', false));
                    tokRef.current?.focus();
                    // 稍后再播报“保存后生效”，不和聚焦时的朗读重叠
                    window.setTimeout(() => setAnnounce(t('pol.tokenGuard.pending')), 400);
                  }}
                >
                  {t('pol.tokenGuard.action')}
                </button>
              )
            }
          >
            <span id={`${id}-tokwarn`} data-testid="token-bypass-warn">
              <strong className="block">{t('pol.tokenGuard.title')}</strong>
              {t(at === 'environment' ? 'pol.tokenGuard.bodyEnv' : 'pol.tokenGuard.bodyLayer')}
            </span>
          </Banner>
        )}
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {announce}
        </div>
        {problems.length > 0 && (
          <Banner kind="warn" role="status">
            {problems.map((p) => p.message).join('；')}
          </Banner>
        )}
      </div>
    </fieldset>
  );
};

/** 实例 / 组 / 项目层的配置页：生产、非生产两套 */
export const PolicyLayerPanel = ({ path, queryKey }: { path: string; queryKey: unknown[] }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey, queryFn: () => api<PolicyLayerView>('GET', path) });
  const [edited, setEdited] = useState<{ base: PolicyLayerView; draft: LayerPolicy } | null>(null);
  const draft = edited && edited.base === q.data ? edited.draft : (q.data?.settings ?? null);
  const setDraft = (next: LayerPolicy) => {
    if (q.data) setEdited({ base: q.data, draft: next });
  };
  const save = useMutation({
    mutationFn: (body: LayerPolicy) => api<PolicyLayerView>('PUT', path, body),
    onSuccess: (v) => {
      qc.setQueryData(queryKey, v);
      void invalidatePolicyDependents(qc, queryKey);
      toast(t('pol.saved'));
    },
  });
  if (!q.data || !draft) return q.error ? <Banner kind="danger">{q.error.message}</Banner> : null;
  const v = q.data;
  const dirty =
    JSON.stringify([normalizeSettings(draft.production), normalizeSettings(draft.nonProduction)]) !==
    JSON.stringify([normalizeSettings(v.settings.production), normalizeSettings(v.settings.nonProduction)]);
  return (
    <div className="space-y-4">
      <p className="hint">{t('pol.intro')}</p>
      {!v.canEdit && <p className="hint">{t(`pol.readonly.${v.layer}`)}</p>}
      {v.canEdit && v.loosenNote && (
        <Banner kind="info" role="status">
          {v.loosenNote}
        </Banner>
      )}
      <PolicySetEditor
        title={t('pol.production')}
        at={v.layer}
        production
        resolved={v.resolved.production}
        value={draft.production}
        onChange={(p) => setDraft({ ...draft, production: p })}
        disabled={!v.canEdit || save.isPending}
        canEdit={v.canEdit}
        names={v.names}
      />
      <PolicySetEditor
        title={t('pol.nonProduction')}
        at={v.layer}
        production={false}
        resolved={v.resolved.nonProduction}
        value={draft.nonProduction}
        onChange={(p) => setDraft({ ...draft, nonProduction: p })}
        disabled={!v.canEdit || save.isPending}
        canEdit={v.canEdit}
        names={v.names}
      />
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
            {t('pol.save')}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={!dirty || save.isPending}
            onClick={() => setDraft(v.settings)}
          >
            {t('pol.reset')}
          </button>
        </div>
      )}
    </div>
  );
};

/** 环境层：环境自己的那一套执行策略 */
export const EnvPolicyPanel = ({ pid, eid }: { pid: string; eid: string }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const path = `/api/projects/${pid}/environments/${eid}/exec-policy`;
  const queryKey = ['env-policy', pid, eid];
  const q = useQuery({ queryKey, queryFn: () => api<EnvPolicyView>('GET', path) });
  const [edited, setEdited] = useState<{ base: EnvPolicyView; draft: EnvPolicyPut } | null>(null);
  const draft =
    edited && edited.base === q.data ? edited.draft : q.data ? { settings: q.data.settings } : null;
  const setDraft = (next: EnvPolicyPut) => {
    if (q.data) setEdited({ base: q.data, draft: next });
  };
  const save = useMutation({
    mutationFn: (body: EnvPolicyPut) => api<EnvPolicyView>('PUT', path, body),
    onSuccess: (v) => {
      qc.setQueryData(queryKey, v);
      void invalidatePolicyDependents(qc, queryKey);
      toast(t('pol.saved'));
    },
  });
  if (!q.data || !draft) return q.error ? <Banner kind="danger">{q.error.message}</Banner> : null;
  const v = q.data;
  const disabled = !v.canEdit || save.isPending;
  const dirty =
    JSON.stringify(normalizeSettings(draft.settings)) !== JSON.stringify(normalizeSettings(v.settings));
  return (
    <div className="space-y-3" data-testid="env-policy">
      <p className="hint">{t('pol.envIntro')}</p>
      {!v.canEdit && <p className="hint">{t('pol.readonly.environment')}</p>}
      {v.canEdit && v.loosenNote && (
        <Banner kind="info" role="status">
          {t('pol.loosenEnv')} {v.loosenNote}
        </Banner>
      )}
      <PolicySetEditor
        title={t(v.production ? 'pol.envSetProd' : 'pol.envSetNonProd')}
        at="environment"
        production={v.production}
        resolved={v.resolved}
        value={draft.settings}
        onChange={(s) => setDraft({ settings: s })}
        disabled={disabled}
        canEdit={v.canEdit}
        names={v.names}
      />
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
            {t('pol.save')}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={!dirty || save.isPending}
            onClick={() => setDraft({ settings: v.settings })}
          >
            {t('pol.reset')}
          </button>
        </div>
      )}
    </div>
  );
};

/** 确认对话框里的生效策略摘要（一行） */
export const PolicySummary = ({ policy }: { policy: ResolvedPolicy }) => {
  const { t, value, source } = useLabels();
  const stages = policy.approval.stages.length;
  return (
    <p className="text-sm text-text-2" data-testid="policy-summary">
      {t('pol.summary', {
        who: value('whoCanExecute', policy.whoCanExecute.value),
        whoSource: source(policy.whoCanExecute.source),
        lock: value('lockTimeoutMs', policy.lockTimeoutMs.value),
        stmt: value('statementTimeoutMs', policy.statementTimeoutMs.value),
      })}
      {' · '}
      {stages ? t('pol.approval.stagesN', { n: stages }) : t('pol.approval.defaultShort')}
    </p>
  );
};
