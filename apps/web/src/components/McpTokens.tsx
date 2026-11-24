// 个人 MCP 令牌（M3-C，ADR 0014；界面规格见 .agents/docs/ui/mcp-tokens.md）：
// - 个人设置「MCP 访问」：新建（权限 / 项目范围 / 有效期）→ 一次性展示明文与客户端配置 → 列表与吊销；
// - 管理后台「用户」：查看与吊销某个用户的 MCP 令牌（AdminUserMcpTokens）。
// 复制按钮遵循 modern-web-guidance 的 copy-button：独立 role="status" 气泡、失败也提示、重复点击重置定时器且不禁用按钮。
import {
  type AdminMcpTokenList,
  type AdminUser,
  MCP_TOKEN_DEFAULT_DAYS,
  MCP_TOKEN_MAX_ACTIVE_PER_USER,
  MCP_TOKEN_MAX_PROJECTS,
  type McpExtraScope,
  type McpTokenCreated,
  type McpTokenInfo,
  type McpTokenList,
  type ProjectListItem,
} from '@dowel/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Copy, KeyRound } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api.ts';
import { formatTime } from '../format.ts';
import { Confirm, Modal } from './Modal.tsx';
import { Tabs } from './Tabs.tsx';
import { useToast } from './Toasts.tsx';
import { Banner, cx, Empty } from './ui.tsx';

const EXPIRY_CHOICES = [7, 30, 90, 180, 365] as const;
const SOON_MS = 7 * 24 * 3600_000;

/** Clipboard API 不可用或被拒时的最后兜底（与 CI 令牌的复制按钮相同） */
const legacyCopy = (text: string): boolean => {
  const previous = document.activeElement as HTMLElement | null;
  const field = Object.assign(document.createElement('textarea'), { value: text });
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
    previous?.focus({ preventScroll: true });
  }
};

/** VoiceOver 会跳过与上一条相同的播报：页面级记录上一条，相同时追加不换行空格 */
let lastCopyMessage = '';

/** 复制按钮：可见文字即可访问名字（或图标按钮用 label）；结果写进相邻的 role="status" 气泡 */
export const CopyButton = ({
  text,
  label,
  iconOnly,
}: {
  text: string;
  label: string;
  iconOnly?: boolean;
}) => {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [live, setLive] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const report = (ok: boolean) => {
    clearTimeout(timer.current);
    let msg = t(ok ? 'mcp.copied' : 'mcp.copyFailed');
    if (msg === lastCopyMessage) msg += ' ';
    lastCopyMessage = msg;
    setState(ok ? 'copied' : 'failed');
    setLive('');
    requestAnimationFrame(() => setLive(msg));
    timer.current = setTimeout(() => {
      setState('idle');
      setLive('');
    }, 2000);
  };

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      report(true);
    } catch {
      report(legacyCopy(text));
    }
  };

  const Icon = state === 'copied' ? Check : Copy;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        className={cx('btn sm min-h-6 min-w-6', iconOnly && 'px-1.5')}
        aria-label={iconOnly ? label : undefined}
        data-copied={state === 'copied' ? '' : undefined}
        data-failed={state === 'failed' ? '' : undefined}
        onClick={() => void copy()}
      >
        <Icon size={14} aria-hidden="true" />
        {!iconOnly && label}
      </button>
      <span role="status" className={cx('text-xs', state === 'failed' ? 'text-danger' : 'text-text-2')}>
        {live}
      </span>
    </span>
  );
};

/** “通过 MCP”标记（修改历史、项目动态、审计日志）：可见文字 MCP 包含在可访问名字“通过 MCP”里 */
export const McpBadge = () => {
  const { t } = useTranslation();
  return (
    <span className="chip shrink-0" title={t('mcp.viaHint')}>
      <span aria-hidden="true">MCP</span>
      <span className="sr-only">{t('mcp.via')}</span>
    </span>
  );
};

/** 状态：圆点 + 正文色文字（DESIGN.md：状态色文字要满足 4.5:1） */
const TokenStatus = ({ tok }: { tok: McpTokenInfo }) => {
  const { t } = useTranslation();
  // 渲染期不调用 Date.now()（react purity）：挂载时取一次当前时间即可
  const [now] = useState(Date.now);
  const soon = tok.status === 'active' && Date.parse(tok.expiresAt) - now < SOON_MS;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span
          aria-hidden="true"
          className={cx(
            'size-[7px] rounded-full',
            tok.status === 'active'
              ? soon
                ? 'bg-warn'
                : 'bg-ok'
              : tok.status === 'expired'
                ? 'bg-warn'
                : 'bg-border-strong',
          )}
        />
        <span className={tok.status === 'active' ? 'text-text' : 'text-text-2'}>
          {soon ? t('mcp.status.soon') : t(`mcp.status.${tok.status}`)}
        </span>
      </span>
      {tok.status === 'revoked' && tok.revokedReason && (
        <span className="text-xs text-text-2">{t(`mcp.reason.${tok.revokedReason}`)}</span>
      )}
    </span>
  );
};

const ScopeMarks = ({ tok }: { tok: McpTokenInfo }) => {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap gap-1">
      {tok.scopes.map((s) => (
        <span key={s} className="chip">
          {t(`mcp.scope.${s}`)}
        </span>
      ))}
    </span>
  );
};

const ProjectsCell = ({ tok }: { tok: McpTokenInfo }) => {
  const { t } = useTranslation();
  if (tok.projects === null) return <span>{t('mcp.allProjects')}</span>;
  return (
    <ul className="m-0 list-none space-y-0.5 p-0">
      {tok.projects.map((p) => (
        <li key={p.id} className={p.path ? 'font-mono text-xs' : 'text-xs text-text-2'}>
          {p.path ?? t('mcp.projectGone')}
        </li>
      ))}
    </ul>
  );
};

/** 令牌表格（个人设置与管理后台共用）；onRevoke 为空时不显示吊销按钮 */
export const McpTokenTable = ({
  tokens,
  caption,
  onRevoke,
  tableRef,
}: {
  tokens: McpTokenInfo[];
  caption: string;
  onRevoke?: (tok: McpTokenInfo) => void;
  /** 吊销后用来接住焦点（tabIndex=-1，只能由脚本聚焦） */
  tableRef?: React.Ref<HTMLDivElement>;
}) => {
  const { t } = useTranslation();
  const captionId = useId();
  return (
    <div
      ref={tableRef}
      tabIndex={-1}
      className="overflow-x-auto rounded-md border border-border bg-panel"
      role="region"
      aria-labelledby={captionId}
    >
      <table className="data-table" data-testid="mcp-token-table">
        <caption id={captionId} className="sr-only">
          {caption}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('mcp.col.name')}</th>
            <th scope="col">{t('mcp.col.projects')}</th>
            <th scope="col">{t('mcp.col.lastUsed')}</th>
            <th scope="col">{t('mcp.col.status')}</th>
            {onRevoke && (
              <th scope="col">
                <span className="sr-only">{t('mcp.col.actions')}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {tokens.map((tok) => (
            <tr key={tok.id} className={tok.status === 'active' ? undefined : 'text-text-2'}>
              <th scope="row" className="text-left font-normal">
                <span className="block font-medium text-text">{tok.name}</span>
                <span className="block font-mono text-xs text-text-2">{tok.prefix}…</span>
                <span className="mt-1 block">
                  <ScopeMarks tok={tok} />
                </span>
              </th>
              <td>
                <ProjectsCell tok={tok} />
              </td>
              <td className="text-xs">
                {tok.lastUsedAt ? (
                  <>
                    <time dateTime={tok.lastUsedAt} className="block whitespace-nowrap">
                      {formatTime(tok.lastUsedAt)}
                    </time>
                    {tok.lastUsedIp && <span className="font-mono">{tok.lastUsedIp}</span>}
                  </>
                ) : (
                  t('mcp.neverUsed')
                )}
              </td>
              <td>
                <TokenStatus tok={tok} />
                <span className="block text-xs whitespace-nowrap">
                  {t('mcp.expiresOn')} <time dateTime={tok.expiresAt}>{formatTime(tok.expiresAt)}</time>
                </span>
              </td>
              {onRevoke && (
                <td>
                  {tok.status !== 'revoked' && (
                    <button
                      type="button"
                      className="btn sm danger"
                      aria-label={t('mcp.revokeNamed', { name: tok.name })}
                      onClick={() => onRevoke(tok)}
                    >
                      {t('mcp.revoke')}
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** 按状态排序：有效 → 已过期 → 已吊销，同组内新的在前（服务端已排好，这里兜底） */
const sortTokens = (tokens: McpTokenInfo[]) => {
  const rank = { active: 0, expired: 1, revoked: 2 } as const;
  return [...tokens].sort(
    (a, b) => rank[a.status] - rank[b.status] || Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
};

const mcpUrl = () => `${location.origin}/api/mcp`;

/** 客户端配置片段（令牌嵌在片段里；只在一次性展示时出现） */
export const clientSnippets = (token: string, url = mcpUrl()) => ({
  // --scope user：对这台机器上的所有项目生效（默认 local 只对当前目录生效）
  claude: `claude mcp add --transport http --scope user dowel ${url} --header "Authorization: Bearer ${token}"`,
  cursor: JSON.stringify(
    { mcpServers: { dowel: { url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  ),
  vscode: JSON.stringify(
    { servers: { dowel: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  ),
});

type ClientKey = keyof ReturnType<typeof clientSnippets> | 'other';

const Snippet = ({ text, label, hint }: { text: string; label: string; hint?: string }) => (
  <div className="space-y-1.5 pt-2">
    {hint && <p className="hint m-0">{hint}</p>}
    <pre className="m-0 overflow-x-auto rounded-md border border-border bg-bg p-3 font-mono text-xs whitespace-pre">
      <code>{text}</code>
    </pre>
    <CopyButton text={text} label={label} />
  </div>
);

/** 其他客户端：地址、传输、请求头分别复制 */
const OtherClient = ({ token }: { token: string }) => {
  const { t } = useTranslation();
  const rows = [
    { key: 'url', label: t('mcp.other.url'), value: mcpUrl() },
    { key: 'transport', label: t('mcp.other.transport'), value: 'Streamable HTTP' },
    { key: 'header', label: t('mcp.other.header'), value: `Authorization: Bearer ${token}` },
  ];
  return (
    <div className="space-y-2 pt-2">
      <p className="hint m-0">{t('mcp.clientHint.other')}</p>
      <dl className="m-0 space-y-2">
        {rows.map((r) => (
          <div key={r.key} className="space-y-1">
            <dt className="label">{r.label}</dt>
            <dd className="m-0 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs">
                {r.value}
              </code>
              <CopyButton text={r.value} label={t('mcp.copyNamed', { name: r.label })} iconOnly />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
};

/** 一次性展示：令牌明文 + 客户端配置 */
const Reveal = ({ created }: { created: McpTokenCreated }) => {
  const { t } = useTranslation();
  const [client, setClient] = useState<ClientKey>('claude');
  const snippets = clientSnippets(created.token);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="space-y-3" data-testid="mcp-token-reveal">
      <div id="mcp-token-once-warn">
        <Banner kind="warn">{t('mcp.onceWarn')}</Banner>
      </div>
      <div className="field">
        <label className="label" htmlFor="mcp-token-plain">
          {t('mcp.tokenLabel')}
        </label>
        <span className="flex items-center gap-2">
          <input
            id="mcp-token-plain"
            ref={inputRef}
            className="input flex-1 font-mono"
            readOnly
            aria-describedby="mcp-token-once-warn"
            onFocus={(e) => e.currentTarget.select()}
            value={created.token}
            spellCheck={false}
            autoComplete="off"
          />
          <CopyButton text={created.token} label={t('mcp.copyToken')} />
        </span>
      </div>
      <section className="space-y-1" aria-labelledby="mcp-clients-heading">
        <h3 id="mcp-clients-heading" className="m-0 text-sm font-medium">
          {t('mcp.clientsTitle')}
        </h3>
        <Tabs
          label={t('mcp.clientsTitle')}
          value={client}
          onChange={setClient}
          tabs={[
            { key: 'claude', title: 'Claude Code' },
            { key: 'cursor', title: 'Cursor' },
            { key: 'vscode', title: 'VS Code' },
            { key: 'other', title: t('mcp.clientOther') },
          ]}
        >
          {(k) =>
            k === 'other' ? (
              <OtherClient token={created.token} />
            ) : (
              <Snippet text={snippets[k]} label={t('mcp.copyConfig')} hint={t(`mcp.clientHint.${k}`)} />
            )
          }
        </Tabs>
      </section>
    </div>
  );
};

/** 新建对话框：表单态 → 创建成功后切到一次性展示态 */
const CreateDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const base = useId();
  const [name, setName] = useState('');
  const [extra, setExtra] = useState<McpExtraScope[]>([]);
  const [mode, setMode] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [days, setDays] = useState(MCP_TOKEN_DEFAULT_DAYS);
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<McpTokenCreated | null>(null);

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<ProjectListItem[]>('GET', '/api/projects'),
    enabled: open && mode === 'some',
  });

  const reset = () => {
    setName('');
    setExtra([]);
    setMode('all');
    setPicked([]);
    setFilter('');
    setDays(MCP_TOKEN_DEFAULT_DAYS);
    setTouched(false);
    setCreated(null);
    create.reset();
  };

  const create = useMutation({
    mutationFn: () =>
      api<McpTokenCreated>('POST', '/api/me/mcp-tokens', {
        name: name.trim(),
        scopes: extra,
        projectIds: mode === 'all' ? null : picked,
        expiresInDays: days,
      }),
    onSuccess: (res) => {
      setCreated(res);
      void qc.invalidateQueries({ queryKey: ['mcp-tokens'] });
    },
  });

  const projectsMissing = mode === 'some' && picked.length === 0;
  const toggleScope = (s: McpExtraScope, on: boolean) =>
    setExtra((xs) => (on ? [...new Set([...xs, s])] : xs.filter((x) => x !== s)));
  const togglePick = (id: string, on: boolean) =>
    setPicked((xs) =>
      on ? (xs.length >= MCP_TOKEN_MAX_PROJECTS ? xs : [...xs, id]) : xs.filter((x) => x !== id),
    );
  const list = (projects.data ?? []).filter((p) =>
    `${p.group.slug}/${p.slug} ${p.name}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const formId = `${base}-form`;

  const close = () => {
    onClose();
    reset();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      size="md"
      icon={<KeyRound size={16} aria-hidden="true" />}
      title={created ? t('mcp.createdTitle') : t('mcp.createTitle')}
      // 一次性展示态：只能用底部“我已保存，关闭”关闭，防止误点外部丢失明文
      dismissible={!created}
      footer={
        created ? (
          <span className="ml-auto">
            <button type="button" className="btn primary" onClick={close}>
              {t('mcp.done')}
            </button>
          </span>
        ) : (
          <span className="ml-auto flex gap-2">
            <button type="button" className="btn" onClick={close}>
              {t('mcp.cancel')}
            </button>
            <button
              type="submit"
              form={formId}
              className="btn primary"
              disabled={create.isPending}
              aria-busy={create.isPending}
            >
              {t('mcp.createSubmit')}
            </button>
          </span>
        )
      }
    >
      {created ? (
        <Reveal created={created} />
      ) : (
        <form
          id={formId}
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!name.trim() || projectsMissing) return;
            create.mutate();
          }}
        >
          <div className="field">
            <label className="label" htmlFor={`${base}-name`}>
              {t('mcp.name')}
            </label>
            <input
              id={`${base}-name`}
              className="input"
              value={name}
              maxLength={100}
              required
              autoComplete="off"
              placeholder={t('mcp.namePlaceholder')}
              aria-invalid={touched && !name.trim() ? true : undefined}
              aria-describedby={touched && !name.trim() ? `${base}-name-err` : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {touched && !name.trim() && (
              <span id={`${base}-name-err`} className="text-xs text-danger" role="alert">
                {t('mcp.nameRequired')}
              </span>
            )}
          </div>

          <fieldset className="m-0 space-y-2 border-0 p-0">
            <legend className="label mb-1">{t('mcp.permissions')}</legend>
            {(
              [
                { key: 'read', fixed: true },
                { key: 'verify', fixed: false },
                { key: 'write', fixed: false },
              ] as const
            ).map(({ key, fixed }) => (
              <div key={key} className="flex items-start gap-2">
                <input
                  id={`${base}-scope-${key}`}
                  type="checkbox"
                  className="mt-0.5"
                  checked={fixed || extra.includes(key as McpExtraScope)}
                  disabled={fixed}
                  aria-describedby={`${base}-scope-${key}-hint`}
                  onChange={(e) => !fixed && toggleScope(key as McpExtraScope, e.target.checked)}
                />
                <span>
                  <label htmlFor={`${base}-scope-${key}`} className="block text-base">
                    {t(`mcp.scope.${key}Long`)}
                  </label>
                  <span id={`${base}-scope-${key}-hint`} className="hint block">
                    {t(`mcp.scopeHint.${key}`)}
                  </span>
                </span>
              </div>
            ))}
          </fieldset>

          <fieldset className="m-0 space-y-2 border-0 p-0">
            <legend className="label mb-1">{t('mcp.projects')}</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`${base}-mode`}
                checked={mode === 'all'}
                onChange={() => setMode('all')}
              />
              {t('mcp.projectsAll')}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`${base}-mode`}
                checked={mode === 'some'}
                onChange={() => setMode('some')}
              />
              {t('mcp.projectsSome')}
            </label>
            {mode === 'some' && (
              <div className="space-y-2 pl-6">
                <input
                  type="search"
                  className="input"
                  aria-label={t('mcp.projectsFilter')}
                  placeholder={t('mcp.projectsFilter')}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <div
                  className="max-h-60 overflow-auto rounded-md border border-border"
                  role="group"
                  aria-label={t('mcp.projects')}
                  aria-describedby={`${base}-projects-hint`}
                  aria-busy={projects.isLoading}
                >
                  {list.map((p) => {
                    const path = `${p.group.slug}/${p.slug}`;
                    const checked = picked.includes(p.id);
                    return (
                      <label
                        key={p.id}
                        className="flex items-center gap-2 px-3 py-1.5 not-first:border-t not-first:border-border"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checked && picked.length >= MCP_TOKEN_MAX_PROJECTS}
                          onChange={(e) => togglePick(p.id, e.target.checked)}
                        />
                        <span className="font-mono text-xs">{path}</span>
                        <span className="truncate text-xs text-text-2">{p.name}</span>
                      </label>
                    );
                  })}
                  {projects.data && list.length === 0 && (
                    <p className="m-0 px-3 py-3 text-sm text-text-2">{t('mcp.projectsNone')}</p>
                  )}
                </div>
                <p id={`${base}-projects-hint`} className="hint m-0">
                  {t('mcp.projectsPicked', { count: picked.length, max: MCP_TOKEN_MAX_PROJECTS })}
                </p>
                {touched && projectsMissing && (
                  <p className="m-0 text-xs text-danger" role="alert">
                    {t('mcp.projectsRequired')}
                  </p>
                )}
              </div>
            )}
          </fieldset>

          <div className="field max-w-60">
            <label className="label" htmlFor={`${base}-days`}>
              {t('mcp.expiry')}
            </label>
            <select
              id={`${base}-days`}
              className="select"
              value={days}
              aria-describedby={`${base}-days-hint`}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {EXPIRY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d === 365 ? t('mcp.expiryYear') : t('mcp.expiryDays', { count: d })}
                </option>
              ))}
            </select>
            <span id={`${base}-days-hint`} className="hint">
              {t('mcp.expiryHint')}
            </span>
          </div>

          {create.error && (
            <Banner kind="danger" role="alert">
              {mcpErrorText(t, create.error)}
            </Banner>
          )}
        </form>
      )}
    </Modal>
  );
};

/** 服务端错误码 → 界面文案（未登记的用服务端的原文） */
const mcpErrorText = (t: (k: string) => string, e: Error) => {
  const code = e instanceof ApiError ? e.code : undefined;
  if (code === 'mcp_disabled') return t('mcp.err.disabled');
  if (code === 'mcp_token_limit') return t('mcp.err.limit');
  return e.message;
};

/** 个人设置 → MCP 访问 */
export const AccountMcp = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<McpTokenInfo | null>(null);
  const disabledId = useId();
  // 吊销后那一行的吊销按钮会消失，确认框关闭时焦点无处可回：移到本节标题
  const headingRef = useRef<HTMLHeadingElement>(null);

  const list = useQuery({
    queryKey: ['mcp-tokens'],
    queryFn: () => api<McpTokenList>('GET', '/api/me/mcp-tokens'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api<McpTokenInfo>('POST', `/api/me/mcp-tokens/${id}/revoke`, {}),
    onSuccess: () => {
      setRevoking(null);
      toast(t('mcp.revokedToast'));
      void qc.invalidateQueries({ queryKey: ['mcp-tokens'] });
      requestAnimationFrame(() => headingRef.current?.focus());
    },
  });

  const allowed = list.data?.allowed ?? true;
  const tokens = sortTokens(list.data?.tokens ?? []);
  const activeCount = tokens.filter((x) => x.status === 'active').length;
  const atLimit = activeCount >= MCP_TOKEN_MAX_ACTIVE_PER_USER;
  const blocked = !allowed || atLimit;
  // 不能新建时用 aria-disabled（仍在 Tab 顺序里，原因经 aria-describedby 读出），不用原生 disabled
  const createButton = (
    <button
      type="button"
      className="btn primary"
      aria-disabled={blocked || undefined}
      aria-describedby={blocked ? disabledId : undefined}
      onClick={() => !blocked && setCreating(true)}
    >
      <KeyRound size={16} aria-hidden="true" />
      {t('mcp.create')}
    </button>
  );

  return (
    <section className="space-y-3" data-testid="account-mcp">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 ref={headingRef} tabIndex={-1} className="section-title">
            {t('mcp.title')}
          </h2>
          <p className="hint">{t('mcp.intro')}</p>
        </div>
        {tokens.length > 0 && createButton}
      </div>
      {blocked && (
        <div id={disabledId}>
          <Banner kind="warn">{!allowed ? t('mcp.disabledBanner') : t('mcp.err.limit')}</Banner>
        </div>
      )}
      {tokens.length > 0 && (
        <p className="hint m-0">
          {t('mcp.activeCount', { count: activeCount, max: MCP_TOKEN_MAX_ACTIVE_PER_USER })}
        </p>
      )}
      {list.error && (
        <Banner kind="danger" role="alert">
          {list.error.message}
        </Banner>
      )}
      {list.data &&
        (tokens.length ? (
          <McpTokenTable tokens={tokens} caption={t('mcp.tableCaption')} onRevoke={setRevoking} />
        ) : (
          <Empty
            icon={<Bot size={20} aria-hidden="true" />}
            title={t('mcp.emptyTitle')}
            action={createButton}
          >
            {t('mcp.empty')}
          </Empty>
        ))}

      <CreateDialog open={creating} onClose={() => setCreating(false)} />
      <Confirm
        open={!!revoking}
        onClose={() => {
          setRevoking(null);
          revoke.reset();
        }}
        title={t('mcp.revokeTitle', { name: revoking?.name ?? '' })}
        confirmLabel={t('mcp.revokeConfirm')}
        pending={revoke.isPending}
        error={revoke.error?.message}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      >
        {t('mcp.revokeBody')}
      </Confirm>
    </section>
  );
};

/** 管理后台 → 用户 → 某个用户的 MCP 令牌（查看与吊销） */
export const AdminUserMcpTokens = ({ user, onClose }: { user: AdminUser | null; onClose: () => void }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [revoking, setRevoking] = useState<McpTokenInfo | null>(null);
  // 吊销后行内按钮消失：焦点移到表格区域，不掉回 <body>
  const tableRef = useRef<HTMLDivElement>(null);
  const list = useQuery({
    queryKey: ['admin-mcp-tokens', user?.id],
    queryFn: () => api<AdminMcpTokenList>('GET', `/api/admin/users/${user!.id}/mcp-tokens`),
    enabled: !!user,
  });
  const revoke = useMutation({
    mutationFn: (tid: string) =>
      api<McpTokenInfo>('POST', `/api/admin/users/${user!.id}/mcp-tokens/${tid}/revoke`, {}),
    onSuccess: () => {
      setRevoking(null);
      toast(t('mcp.revokedToast'));
      void qc.invalidateQueries({ queryKey: ['admin-mcp-tokens', user?.id] });
      requestAnimationFrame(() => tableRef.current?.focus());
    },
  });
  const tokens = sortTokens(list.data?.tokens ?? []);
  return (
    <>
      <Modal
        open={!!user}
        onClose={onClose}
        size="lg"
        icon={<Bot size={16} aria-hidden="true" />}
        title={t('mcp.adminTitle', { name: user?.name ?? '' })}
        footer={
          <span className="ml-auto">
            <button type="button" className="btn" onClick={onClose}>
              {t('mcp.close')}
            </button>
          </span>
        }
      >
        {list.error && (
          <Banner kind="danger" role="alert">
            {list.error.message}
          </Banner>
        )}
        {list.data &&
          (tokens.length ? (
            <McpTokenTable
              tableRef={tableRef}
              tokens={tokens}
              caption={t('mcp.adminTitle', { name: user?.name ?? '' })}
              onRevoke={setRevoking}
            />
          ) : (
            <p className="m-0 py-4 text-center text-sm text-text-2">{t('mcp.adminEmpty')}</p>
          ))}
      </Modal>
      <Confirm
        open={!!revoking}
        onClose={() => {
          setRevoking(null);
          revoke.reset();
        }}
        title={t('mcp.revokeTitle', { name: revoking?.name ?? '' })}
        confirmLabel={t('mcp.revokeConfirm')}
        pending={revoke.isPending}
        error={revoke.error?.message}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      >
        {t('mcp.adminRevokeBody')}
      </Confirm>
    </>
  );
};
