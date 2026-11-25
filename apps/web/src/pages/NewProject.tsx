// 新建项目向导（P3）：四步——基本信息 → 关联数据库（可跳过）→ 初始内容 → 确认。
// 每一步都能后退，表单状态全在这个组件里，后退不会丢（不卸载）。
// 创建是一个请求（POST /api/projects/wizard，SSE 推进度），完成后跳到项目概览。
// 布局按 DESIGN.md 的“向导”：用外壳的内容区（没有侧面板），步骤指示在顶部，上一步 / 下一步在底部右侧。
import type {
  Dialect,
  EnvVersionRef,
  GroupList,
  ProjectCreated,
  TakeoverInspectResult,
  TargetInfo,
  WizardEvent,
  WizardStage,
} from '@dowel/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Check, CircleCheck, Database, FileUp, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { ClaimDialog } from '../components/ClaimDialog.tsx';
import { AppShell, PageHeader } from '../components/Shell.tsx';
import { Banner, cx, IconButton } from '../components/ui.tsx';
import { DIALECT_UI_LIST, dialectUiSpec } from '../dialects.ts';
import { useMe } from '../session.ts';
import { readSse } from '../sse.ts';

type Kind = 'blank' | 'database' | 'sql' | 'takeover';

/** 向导里的一行数据库（还没保存，用的是本地 key） */
interface EnvDraft {
  key: string;
  name: string;
  url: string;
  production: boolean;
  allowSameInstance: boolean;
  shadowUrl: string;
  /** 连接检查的结果 / 错误（只影响显示，提交时按当前输入的值） */
  result: TargetInfo | null;
  error: string;
  pending: boolean;
}

const STEPS = ['basics', 'database', 'content', 'confirm'] as const;
/** 进度阶段的顺序（服务端可能跳过一些阶段，例如空白项目没有连接和读取） */
const STAGES: WizardStage[] = ['connect', 'read', 'canonicalize', 'write', 'done'];
/** 接手的阶段：读目标库历史、合并、影子库全链验证、写平台库，需要认领时最后认领 */
const TAKEOVER_STAGES: WizardStage[] = ['connect', 'read', 'verify', 'write', 'claim', 'done'];

/** 接手：某个环境的库里登记过哪些项目（读取结果或错误） */
interface TakeRead {
  loading: boolean;
  error: string;
  data: TakeoverInspectResult | null;
}

const EMPTY_ENV = (key: string): EnvDraft => ({
  key,
  name: '',
  url: '',
  production: true,
  allowSameInstance: false,
  shadowUrl: '',
  result: null,
  error: '',
  pending: false,
});

/** 由项目名生成 slug：小写、非字母数字换成 -、去掉首尾 -、最多 39 位（和服务的 slugSchema 一致） */
const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39);

/** 界面上的“全部”用 null 表示（与 projects.schemas 的含义一致）；一个都不选是无效状态，不能提交 */
const scopeOf = (selected: string[], all: string[]) =>
  all.length > 0 && selected.length === all.length ? null : selected;

export const NewProject = () => {
  const { t } = useTranslation();
  const me = useMe().data;
  const qc = useQueryClient();
  const nav = useNavigate();
  const { group: groupFromSearch } = useSearch({ from: '/new' });
  const groups = useQuery({
    queryKey: ['groups'],
    queryFn: () => api<GroupList>('GET', '/api/groups'),
  });

  const [step, setStep] = useState(0);
  const [groupId, setGroupId] = useState('');
  const [dialect, setDialect] = useState<Dialect>('pg');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  /** 用户改过 slug 之后就不再跟着名字变 */
  const [slugTouched, setSlugTouched] = useState(false);
  const [envs, setEnvs] = useState<EnvDraft[]>([]);
  const [kind, setKind] = useState<Kind>('blank');
  const [importEnv, setImportEnv] = useState('');
  const uiSpec = dialectUiSpec(dialect);
  /** schema 勾选：记下是哪个环境的选择，换了环境就按新环境的 schema 重新全选 */
  const [schemaSel, setSchemaSel] = useState<{ key: string; names: string[] } | null>(null);
  const [sql, setSql] = useState('');
  const [error, setError] = useState('');
  const [warnings, setWarningsState] = useState<string[]>([]);
  const warningsRef = useRef<string[]>([]);
  const setWarnings = (w: string[]) => {
    warningsRef.current = w;
    setWarningsState(w);
  };
  const [retiredVersions, setRetiredVersionsState] = useState<EnvVersionRef[]>([]);
  const retiredRef = useRef<EnvVersionRef[]>([]);
  const setRetiredVersions = (v: EnvVersionRef[]) => {
    retiredRef.current = v;
    setRetiredVersionsState(v);
  };
  const [created, setCreated] = useState<ProjectCreated | null>(null);
  /** 接手：每个环境（按本地 key）读到的项目、选中的项目、认领确认对话框 */
  const [takeReads, setTakeReads] = useState<Record<string, TakeRead>>({});
  const [takeProject, setTakeProject] = useState('');
  const [claimOpen, setClaimOpen] = useState(false);
  const [stage, setStage] = useState<WizardStage | null>(null);
  const [stageDetail, setStageDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shadowHintId = useId();
  const envSeq = useRef(0);
  /** 接手读取的代次（切组递增）与每环境序号（失效或重读递增），防止在途旧请求晚返回污染状态 */
  const takeGroupGenRef = useRef(0);
  const takeSeqRef = useRef(0);
  const takeKeySeqRef = useRef<Record<string, number>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  const canCreateIn = (g: GroupList['groups'][number]) =>
    me?.role === 'admin' || g.role === 'admin' || (g.role === 'member' && g.projectCreation === 'members');
  const creatable = (groups.data?.groups ?? []).filter(canCreateIn);
  // 地址里带的是组的 slug（/new?group=<slug>）：按 slug 匹配，没匹配到就用第一个能建项目的组
  const groupFromUrl = creatable.find((g) => g.slug === groupFromSearch)?.id;
  const selectedGroupId = groupId || groupFromUrl || creatable[0]?.id || '';
  const group = creatable.find((g) => g.id === selectedGroupId);
  const effectiveGroupId = group?.id ?? '';

  /**
   * 真正要提交的数据库：名字和连接串都填了才算（空卡片是“还没填完”，提交时忽略）。
   * 名字统一 trim（到处都用这个列表，不再各自 trim）。
   */
  const filledEnvs = envs
    .map((e) => ({ ...e, name: e.name.trim(), url: e.url.trim() }))
    .filter((e) => e.name && e.url);
  const sourceEnv = filledEnvs.find((e) => e.name === importEnv.trim()) ?? filledEnvs[0];
  /** schema 勾选项来自“导入来源”那个环境的连接检查 */
  const schemaList = sourceEnv?.result?.schemas ?? [];
  const allSchemaNames = schemaList.map((s) => s.name);
  // 内部状态永远是显式列表：某个环境还没选过时，默认全选它的 schema
  const selectedNames =
    schemaSel && schemaSel.key === (sourceEnv?.key ?? '') ? schemaSel.names : allSchemaNames;
  const toggleSchema = (schema: string) => {
    const key = sourceEnv?.key ?? '';
    const next = selectedNames.includes(schema)
      ? selectedNames.filter((x) => x !== schema)
      : [...selectedNames, schema];
    setSchemaSel({ key, names: next });
  };

  const patchEnv = (key: string, patch: Partial<EnvDraft>) =>
    setEnvs((list) => list.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  const check = async (env: EnvDraft) => {
    patchEnv(env.key, { pending: true, error: '', result: null });
    try {
      const r = await api<TargetInfo>('POST', '/api/connection-check', {
        url: env.url.trim(),
        groupId: effectiveGroupId,
        dialect,
      });
      patchEnv(env.key, { pending: false, result: r });
    } catch (e) {
      patchEnv(env.key, { pending: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const pickEnv = (name: string) => {
    setImportEnv(name);
    // 换了环境：勾选重置（会按新环境的 schema 全选）；没检查过就自动检查一次
    setSchemaSel(null);
    const next = filledEnvs.find((x) => x.name === name);
    if (next && !next.result) void check(next);
  };

  /** 切组时重置所有接手临时状态并作废所有在途读取请求 */
  const resetTakeover = () => {
    takeGroupGenRef.current += 1;
    takeKeySeqRef.current = {};
    setTakeReads({});
    setTakeProject('');
    setClaimOpen(false);
  };

  /** 环境 url 变更或删除时，精确失效该环境的接手读取缓存与在途请求 */
  const invalidateTakeRead = (key: string) => {
    takeKeySeqRef.current[key] = ++takeSeqRef.current;
    setTakeReads((m) => {
      if (!(key in m)) return m;
      const next = { ...m };
      delete next[key];
      return next;
    });
  };

  /** 接手：读指定环境（默认全部已填环境）的库，列出里面登记过的项目（只读） */
  const readTakeover = async (targets: EnvDraft[] = filledEnvs, replace = true) => {
    if (!effectiveGroupId || targets.length === 0) return;
    const groupGen = takeGroupGenRef.current;
    const seqs = new Map<string, number>();
    for (const e of targets) {
      const seq = ++takeSeqRef.current;
      takeKeySeqRef.current[e.key] = seq;
      seqs.set(e.key, seq);
    }
    setTakeReads((m) => {
      const base: Record<string, TakeRead> = replace ? {} : { ...m };
      for (const e of targets) base[e.key] = { loading: true, error: '', data: null };
      return base;
    });
    await Promise.all(
      targets.map(async (e) => {
        const seq = seqs.get(e.key)!;
        try {
          const data = await api<TakeoverInspectResult>('POST', '/api/takeover/inspect', {
            url: e.url,
            groupId: effectiveGroupId,
            dialect,
          });
          if (takeGroupGenRef.current !== groupGen || takeKeySeqRef.current[e.key] !== seq) return;
          setTakeReads((m) => ({ ...m, [e.key]: { loading: false, error: '', data } }));
        } catch (x) {
          if (takeGroupGenRef.current !== groupGen || takeKeySeqRef.current[e.key] !== seq) return;
          setTakeReads((m) => ({
            ...m,
            [e.key]: { loading: false, error: x instanceof Error ? x.message : String(x), data: null },
          }));
        }
      }),
    );
  };

  /** 自动补读：只读取尚未存在于 takeReads 中的已填环境 */
  const readMissingTakeover = () => {
    const missing = filledEnvs.filter((e) => !takeReads[e.key]);
    if (missing.length > 0) void readTakeover(missing, false);
  };

  const goto = (next: number) => {
    setError('');
    // 进入“初始内容”时，如果要从数据库导入而来源还没检查过，先自动检查一次（拿 schema 列表）
    if (next === 2 && sourceEnv && !sourceEnv.result && !sourceEnv.pending) void check(sourceEnv);
    if (next === 2 && !importEnv && filledEnvs[0]) setImportEnv(filledEnvs[0].name);
    // 进入“初始内容”且已选接手：自动补读尚未读取（新增或改 url 失效）的环境
    if (next === 2 && kind === 'takeover') readMissingTakeover();
    setStep(next);
  };

  /** 各环境里出现过的项目（按项目 ID 合并），每个带上出现在哪些环境（按稳定 key 关联） */
  const candidates = (() => {
    const map = new Map<
      string,
      {
        id: string;
        name: string | null;
        envs: { key: string; env: string; p: TakeoverInspectResult['projects'][number] }[];
      }
    >();
    for (const e of filledEnvs) {
      for (const p of takeReads[e.key]?.data?.projects ?? []) {
        const c = map.get(p.projectId) ?? { id: p.projectId, name: p.name, envs: [] };
        c.envs.push({ key: e.key, env: e.name, p });
        map.set(p.projectId, c);
      }
    }
    return [...map.values()];
  })();
  const takeCand = candidates.find((c) => c.id === takeProject);
  const selectedTakeProject = takeCand ? takeProject : '';
  const readsDone =
    filledEnvs.length > 0 && filledEnvs.every((e) => takeReads[e.key] && !takeReads[e.key]!.loading);
  const takeReading = filledEnvs.some((e) => takeReads[e.key]?.loading);
  const hasAnyTakeRead = filledEnvs.some((e) => Boolean(takeReads[e.key]));
  const takeMissing = takeCand ? filledEnvs.filter((e) => !takeCand.envs.some((x) => x.key === e.key)) : [];
  const takeExists = takeCand?.envs.some((x) => x.p.existsHere) ?? false;
  /** 需要认领：有环境里这个项目由另一个实例认领 */
  const takeClaim = takeCand?.envs.find((x) => !x.p.mine) ?? null;
  const isInstanceAdmin = me?.role === 'admin';

  /** 接手时是否至少有一个环境可以提供影子库（SQLite 内置 :memory: 始终可用；外部库需非生产、允许同实例或独立 shadowUrl） */
  const hasTakeoverShadow =
    !uiSpec.requiresExternalShadow ||
    filledEnvs.some((e) => !e.production || e.allowSameInstance || e.shadowUrl.trim().length > 0);
  const validBasics = name.trim().length > 0 && !!effectiveGroupId;
  const envMissing =
    (kind === 'database' || (kind === 'sql' && uiSpec.requiresExternalShadow)) && filledEnvs.length === 0;
  // schema 勾选不能为空（仅多 schema 方言检查；不知道 schema 列表时不拦，交给服务端报错）
  const schemaMissing =
    uiSpec.schemas && kind === 'database' && allSchemaNames.length > 0 && selectedNames.length === 0;
  const validContent =
    kind === 'blank'
      ? true
      : kind === 'sql'
        ? (!uiSpec.requiresExternalShadow || filledEnvs.length > 0) && sql.trim().length > 0
        : kind === 'takeover'
          ? readsDone &&
            !!takeCand &&
            takeMissing.length === 0 &&
            !takeExists &&
            (!takeClaim || isInstanceAdmin)
          : filledEnvs.length > 0 && !schemaMissing;

  const canNext =
    (step === 0 && validBasics) ||
    step === 1 ||
    (step === 2 && validContent) ||
    (step === 3 && validBasics && validContent);

  const create = async (claimConfirmed = false) => {
    // 接手别的实例认领的库：先弹出认领确认（说明后果），确认之后才提交
    if (kind === 'takeover' && takeClaim && !claimConfirmed) {
      setClaimOpen(true);
      return;
    }
    setClaimOpen(false);
    setBusy(true);
    setError('');
    setWarnings([]);
    setRetiredVersions([]);
    setStage(null);
    setStageDetail(null);
    const body = {
      name: name.trim(),
      groupId: effectiveGroupId,
      slug: slug.trim() || undefined,
      dialect,
      // 名字在 filledEnvs 里已经 trim 过（界面上到处用的都是它）
      environments: filledEnvs.map((e) => ({
        name: e.name,
        url: e.url,
        production: e.production,
        allowSameInstance: uiSpec.requiresExternalShadow ? e.allowSameInstance : false,
        shadowUrl: uiSpec.requiresExternalShadow ? e.shadowUrl.trim() || null : null,
      })),
      // 勾选的正好是全部时存 null（“全部 schema”）；单 schema 方言始终传 null
      schemas: uiSpec.schemas && kind === 'database' ? scopeOf(selectedNames, allSchemaNames) : null,
      content: {
        kind,
        env: kind === 'database' ? sourceEnv?.name : undefined,
        sql: kind === 'sql' ? sql : undefined,
        projectId: kind === 'takeover' ? selectedTakeProject : undefined,
        claim: kind === 'takeover' && (claimConfirmed || !!takeClaim) ? true : undefined,
      },
    };
    let project = null as ProjectCreated | null; // 在 readSse 的回调里赋值，不加断言 TS 会把它收窄成 null
    try {
      const res = await fetch('/api/projects/wizard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? t('err.generic', { msg: res.statusText }));
        setBusy(false);
        return;
      }
      // 读 SSE：每条消息的 data 是一个 WizardEvent 的 JSON（解析见 sse.ts）
      await readSse(res, (data) => {
        const event = JSON.parse(data) as WizardEvent;
        if (event.error) {
          // TOCTOU 或缓存陈旧时服务端可能在提交阶段才要求确认认领：管理员弹认领确认框，普通用户照常显示错误
          if (event.code === 'claim_required' && isInstanceAdmin && !claimConfirmed) {
            setClaimOpen(true);
          } else {
            setError(event.error);
          }
        } else {
          setStage(event.stage);
          setStageDetail(event.detail ?? null);
        }
        if (event.project) project = event.project;
        if (event.warnings?.length) setWarnings(event.warnings);
        if (event.retiredVersions?.length) setRetiredVersions(event.retiredVersions);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
    if (!project) return;
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['projects'] }),
      qc.invalidateQueries({ queryKey: ['groups'] }),
    ]);
    // 项目建好了但有没做完的事（例如某个库认领失败）或识别出已作废岔路版本：先让用户看到，再进项目
    if (warningsRef.current.length || retiredRef.current.length) {
      setCreated(project);
      return;
    }
    await nav({
      to: '/project/$owner/$project',
      params: { owner: project.group.slug, project: project.slug },
    });
  };

  if (!me) return null;

  const stepTitle = t(`wiz.steps.${STEPS[step]}`);

  return (
    <AppShell me={me} groupSlug={group?.slug}>
      <PageHeader
        crumbs={[{ label: t('nav.myProjects'), to: '/' }, { label: t('wiz.title') }]}
        center={
          <ol className="flex items-center gap-1" aria-label={t('wiz.title')}>
            {STEPS.map((key, i) => (
              <li key={key} className="flex items-center gap-1">
                {i > 0 && (
                  <span aria-hidden="true" className="text-text-3">
                    ›
                  </span>
                )}
                <span
                  aria-current={i === step ? 'step' : undefined}
                  className={cx(
                    'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs',
                    i === step
                      ? 'bg-primary-soft font-medium text-primary-text'
                      : i < step
                        ? 'text-text-2'
                        : 'text-text-3',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cx(
                      'grid size-[18px] place-items-center rounded-full border text-[11px]',
                      i === step
                        ? 'text-on-primary border-primary bg-primary'
                        : i < step
                          ? 'border-primary text-primary-text'
                          : 'border-border-strong',
                    )}
                  >
                    {i < step ? <Check size={11} aria-hidden="true" /> : i + 1}
                  </span>
                  {t(`wiz.steps.${key}`)}
                </span>
              </li>
            ))}
          </ol>
        }
      />
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[880px] px-6 py-6">
          <h2 className="section-title mb-1">
            {stepTitle}
            <span className="count">{t('wiz.stepOf', { n: step + 1, total: STEPS.length })}</span>
          </h2>

          {step === 0 && (
            <section className="mt-4 space-y-4">
              <p className="hint">{t('wiz.basicsHint')}</p>
              {!groups.isLoading && creatable.length === 0 && (
                <Banner kind="info">{t('wiz.needGroup')}</Banner>
              )}
              <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 max-[800px]:grid-cols-1">
                <label className="field">
                  <span className="label">{t('wiz.group')}</span>
                  <select
                    className="select"
                    value={effectiveGroupId}
                    onChange={(e) => {
                      setGroupId(e.target.value);
                      resetTakeover();
                    }}
                    disabled={!creatable.length}
                  >
                    {creatable.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                  <span className="hint">{t('wiz.groupHint')}</span>
                </label>
                <label className="field">
                  <span className="label">{t('wiz.name')}</span>
                  <input
                    className="input"
                    value={name}
                    placeholder={t('wiz.namePlaceholder')}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (!slugTouched) setSlug(slugify(e.target.value));
                    }}
                    required
                  />
                </label>
                <label className="field">
                  <span className="label">{t('wiz.slug')}</span>
                  <input
                    className="input font-mono"
                    value={slug}
                    onChange={(e) => {
                      setSlug(e.target.value);
                      setSlugTouched(true);
                    }}
                    placeholder={t('wiz.slugPlaceholder')}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                  <span className="hint">{t('wiz.slugHint')}</span>
                </label>
              </div>
              <fieldset className="m-0 space-y-2 border-0 p-0">
                <legend className="label">{t('wiz.dialect')}</legend>
                <div className="grid grid-cols-2 gap-2.5 max-[640px]:grid-cols-1">
                  {DIALECT_UI_LIST.map((d) => {
                    const active = dialect === d.id;
                    return (
                      <label
                        key={d.id}
                        className={cx(
                          'flex items-start gap-2.5 rounded-md border p-3',
                          d.implemented ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
                          active ? 'border-primary bg-primary-soft' : 'border-border bg-panel',
                        )}
                      >
                        <input
                          type="radio"
                          name="dialect"
                          value={d.id}
                          className="mt-0.5"
                          checked={active}
                          disabled={!d.implemented}
                          onChange={() => {
                            if (!d.implemented || dialect === d.id) return;
                            setDialect(d.id);
                            setEnvs([]);
                            setImportEnv('');
                            setSchemaSel(null);
                            resetTakeover();
                            setError('');
                            setWarnings([]);
                          }}
                        />
                        <span className="min-w-0 flex-1 space-y-0.5">
                          <span className="flex items-center gap-2 text-sm font-medium">
                            <span>{d.name}</span>
                            {!d.implemented && <span className="chip">{t('wiz.dialectComingSoon')}</span>}
                          </span>
                          <span className="block text-xs text-text-2">{t(`wiz.dialectDesc.${d.id}`)}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <p className="hint m-0">{t('wiz.dialectHint')}</p>
              </fieldset>
            </section>
          )}

          {step === 1 && (
            <section className="mt-4 space-y-4">
              <p className="hint">
                {uiSpec.requiresExternalShadow
                  ? t('wiz.databaseHint', { dialect: uiSpec.name })
                  : t('wiz.databaseHintSqlite')}
              </p>
              {dialect === 'mssql' && envs.length > 0 && <Banner kind="info">{t('wiz.mssqlTlsHint')}</Banner>}
              {envs.length === 0 && <p className="hint">{t('wiz.envEmpty')}</p>}
              <ul className="m-0 list-none space-y-3 p-0">
                {envs.map((env) => (
                  <li key={env.key} className="space-y-2.5 rounded-md border border-border bg-panel p-4">
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 max-[800px]:grid-cols-1">
                      <label className="field">
                        <span className="label">{t('wiz.envName')}</span>
                        <input
                          className="input"
                          aria-label={t('wiz.envName')}
                          value={env.name}
                          placeholder="dev"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          onChange={(e) => patchEnv(env.key, { name: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span className="label">{t('wiz.envUrl')}</span>
                        <input
                          className="input font-mono"
                          aria-label={t('wiz.envUrl')}
                          value={env.url}
                          placeholder={uiSpec.urlPlaceholder}
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          onChange={(e) => {
                            // 连接串变了，之前的检查结果和接手读取缓存都作废
                            patchEnv(env.key, { url: e.target.value, result: null, error: '' });
                            invalidateTakeRead(env.key);
                          }}
                        />
                      </label>
                      {uiSpec.requiresExternalShadow && (
                        <div className="field col-span-2">
                          <label className="field">
                            <span className="label">{t('wiz.envShadowUrl')}</span>
                            <input
                              className="input font-mono"
                              aria-label={t('wiz.envShadowUrl')}
                              aria-describedby={`${shadowHintId}-${env.key}`}
                              value={env.shadowUrl}
                              placeholder={uiSpec.shadowPlaceholder}
                              autoCapitalize="none"
                              autoCorrect="off"
                              spellCheck={false}
                              onChange={(e) => patchEnv(env.key, { shadowUrl: e.target.value })}
                            />
                          </label>
                          <span id={`${shadowHintId}-${env.key}`} className="hint">
                            {t('wiz.envShadowHint')}
                          </span>
                        </div>
                      )}
                      <div className="checks col-span-2">
                        <label>
                          <input
                            type="checkbox"
                            checked={env.production}
                            onChange={(e) => patchEnv(env.key, { production: e.target.checked })}
                          />
                          {t('wiz.envProduction')}
                        </label>
                        {uiSpec.requiresExternalShadow && (
                          <label>
                            <input
                              type="checkbox"
                              checked={env.allowSameInstance}
                              onChange={(e) => patchEnv(env.key, { allowSameInstance: e.target.checked })}
                            />
                            {t('wiz.envAllowSame')}
                          </label>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="btn"
                        disabled={env.pending || !env.url.trim() || !effectiveGroupId}
                        aria-busy={env.pending}
                        onClick={() => void check(env)}
                      >
                        {env.pending ? t('wiz.checking') : t('wiz.check')}
                      </button>
                      <IconButton
                        label={t('wiz.removeEnv', { name: env.name || env.url || t('wiz.envName') })}
                        onClick={() => {
                          setEnvs((list) => list.filter((x) => x.key !== env.key));
                          invalidateTakeRead(env.key);
                        }}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </IconButton>
                    </div>
                    {env.error && (
                      <Banner kind="danger" role="alert">
                        {env.error}
                      </Banner>
                    )}
                    {env.result && <CheckResult info={env.result} dialect={dialect} />}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn"
                onClick={() => setEnvs((list) => [...list, EMPTY_ENV(`env-${++envSeq.current}`)])}
              >
                <Plus size={16} aria-hidden="true" />
                {t('wiz.addEnv')}
              </button>
            </section>
          )}

          {step === 2 && (
            <section className="mt-4 space-y-4">
              <fieldset className="m-0 space-y-2 border-0 p-0">
                <legend className="label">{t('wiz.contentTitle')}</legend>
                {(['blank', 'database', 'sql', 'takeover'] as const).map((k) => (
                  <label
                    key={k}
                    className={cx(
                      'flex cursor-pointer items-start gap-2.5 rounded-md border p-3',
                      kind === k ? 'border-primary bg-primary-soft' : 'border-border bg-panel',
                    )}
                  >
                    <input
                      type="radio"
                      name="content"
                      className="mt-0.5"
                      checked={kind === k}
                      onChange={() => {
                        setKind(k);
                        // 接手：选中时自动补读尚未读取的环境
                        if (k === 'takeover') readMissingTakeover();
                      }}
                    />
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium">{t(`wiz.content${cap(k)}`)}</span>
                      <span className="block text-xs text-text-2">
                        {k === 'blank'
                          ? t(
                              dialect === 'sqlite'
                                ? 'wiz.contentBlankHintSqlite'
                                : dialect === 'mysql'
                                  ? 'wiz.contentBlankHintMysql'
                                  : dialect === 'mssql'
                                    ? 'wiz.contentBlankHintMssql'
                                    : 'wiz.contentBlankHint',
                            )
                          : k === 'sql'
                            ? t(
                                dialect === 'sqlite'
                                  ? 'wiz.contentSqlHintSqlite'
                                  : dialect === 'mysql'
                                    ? 'wiz.contentSqlHintMysql'
                                    : dialect === 'mssql'
                                      ? 'wiz.contentSqlHintMssql'
                                      : 'wiz.contentSqlHint',
                              )
                            : t(`wiz.content${cap(k)}Hint`)}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {kind === 'takeover' && (
                <div className="space-y-3 rounded-md border border-border bg-panel p-4">
                  <h3 className="section-title">{t('tk.wizTitle')}</h3>
                  <p className="hint">
                    {t(uiSpec.historyStorage === 'prefix' ? 'tk.wizHintPrefix' : 'tk.wizHint')}
                  </p>
                  {filledEnvs.length === 0 ? (
                    <Banner kind="warn" role="alert">
                      {t('tk.needEnv')}
                    </Banner>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="btn"
                          disabled={takeReading}
                          aria-busy={takeReading || undefined}
                          onClick={() => void readTakeover(filledEnvs, true)}
                        >
                          {takeReading ? t('tk.reading') : hasAnyTakeRead ? t('tk.reread') : t('tk.read')}
                        </button>
                      </div>
                      {filledEnvs.map(
                        (e) =>
                          takeReads[e.key]?.error && (
                            <Banner key={e.key} kind="danger" role="alert">
                              {e.name}：{t('tk.readError', { msg: takeReads[e.key]!.error })}
                            </Banner>
                          ),
                      )}
                      {readsDone &&
                        candidates.length === 0 &&
                        !filledEnvs.some((e) => takeReads[e.key]?.error) && (
                          <Banner kind="warn" role="status">
                            {filledEnvs.every((e) => takeReads[e.key]?.data?.hasHistory === false)
                              ? t('tk.noHistory')
                              : t(
                                  uiSpec.historyStorage === 'prefix'
                                    ? 'tk.noProjectsPrefix'
                                    : 'tk.noProjects',
                                )}
                          </Banner>
                        )}
                      {candidates.length > 0 && (
                        <fieldset className="m-0 space-y-2 border-0 p-0">
                          <legend className="label">{t('tk.pick')}</legend>
                          {candidates.map((c) => {
                            const first = c.envs[0]!.p;
                            return (
                              <label
                                key={c.id}
                                className={cx(
                                  'flex cursor-pointer items-start gap-2.5 rounded-md border p-3',
                                  selectedTakeProject === c.id
                                    ? 'border-primary bg-primary-soft'
                                    : 'border-border bg-bg',
                                )}
                              >
                                <input
                                  type="radio"
                                  name="takeover-project"
                                  className="mt-0.5"
                                  checked={selectedTakeProject === c.id}
                                  onChange={() => setTakeProject(c.id)}
                                />
                                <span className="space-y-0.5">
                                  <span className="block text-sm font-medium">{c.name ?? c.id}</span>
                                  <span className="block font-mono text-xs text-text-2">{c.id}</span>
                                  <span className="block text-xs text-text-2">
                                    {t('tk.versionsInfo', {
                                      count: first.versions,
                                      head: first.headNumber ?? '?',
                                    })}
                                    {' · '}
                                    {first.currentNumber === null
                                      ? t('tk.notExecuted')
                                      : t('tk.currentInfo', { number: first.currentNumber })}
                                    {' · '}
                                    {c.envs.every((x) => x.p.mine)
                                      ? t('tk.claimedMine')
                                      : t('tk.claimedOther')}
                                  </span>
                                  <span className="block text-xs text-text-2">
                                    {t('tk.inEnvs', { envs: c.envs.map((x) => x.env).join('、') })}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </fieldset>
                      )}
                      {readsDone && takeCand && takeMissing.length > 0 && (
                        <Banner kind="warn" role="alert">
                          {t('tk.missingIn', { envs: takeMissing.map((e) => e.name).join('、') })}
                        </Banner>
                      )}
                      {takeCand && takeExists && (
                        <Banner kind="warn" role="alert">
                          {takeCand.envs.some((x) => x.p.existsHere && !x.p.hidden)
                            ? t('tk.existsHere')
                            : t('tk.existsHidden')}
                        </Banner>
                      )}
                      {takeCand && takeClaim && (
                        <Banner kind="info" role="status">
                          {isInstanceAdmin ? t('tk.needsClaim') : t('tk.claimNeedsAdmin')}
                        </Banner>
                      )}
                      {uiSpec.requiresExternalShadow && (
                        <div className="space-y-2.5 border-t border-border pt-3">
                          <h4 className="section-title">{t('tk.shadowTitle')}</h4>
                          <p className="hint m-0">{t('tk.shadowHint')}</p>
                          {!hasTakeoverShadow && (
                            <Banner kind="warn" role="alert">
                              {t('tk.shadowMissingWarn')}
                            </Banner>
                          )}
                          <div className="space-y-2">
                            {filledEnvs.map((env) => (
                              <fieldset
                                key={env.key}
                                className="m-0 min-w-0 overflow-hidden rounded-sm border border-border bg-bg p-0"
                              >
                                <legend className="float-left flex w-full items-center gap-2 border-b border-border bg-panel px-3 py-2 font-mono text-xs font-medium text-text">
                                  {env.name}
                                  {env.production ? ` · ${t('wiz.envProduction')}` : ''}
                                </legend>
                                <div className="clear-both space-y-2 p-3">
                                  <label className="field">
                                    <span className="label">{t('wiz.envShadowUrl')}</span>
                                    <input
                                      className="input font-mono"
                                      value={env.shadowUrl}
                                      placeholder={uiSpec.shadowPlaceholder}
                                      autoCapitalize="none"
                                      autoCorrect="off"
                                      spellCheck={false}
                                      onChange={(e) => patchEnv(env.key, { shadowUrl: e.target.value })}
                                    />
                                  </label>
                                  <div className="checks">
                                    <label>
                                      <input
                                        type="checkbox"
                                        checked={env.allowSameInstance}
                                        onChange={(e) =>
                                          patchEnv(env.key, { allowSameInstance: e.target.checked })
                                        }
                                      />
                                      {t('wiz.envAllowSame')}
                                    </label>
                                  </div>
                                </div>
                              </fieldset>
                            ))}
                          </div>
                        </div>
                      )}
                      <p className="hint m-0">{t('tk.mergeHint')}</p>
                    </>
                  )}
                </div>
              )}

              {envMissing && (
                <Banner kind="warn" role="alert">
                  {t('wiz.envNeeded')}
                </Banner>
              )}

              {kind === 'database' && filledEnvs.length > 0 && (
                <div className="space-y-3 pt-4">
                  <label className="field max-w-md">
                    <span className="label">{t('wiz.pickEnv')}</span>
                    <select
                      className="select"
                      value={sourceEnv?.name ?? ''}
                      onChange={(e) => pickEnv(e.target.value)}
                    >
                      {filledEnvs.map((e) => (
                        <option key={e.key} value={e.name}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {uiSpec.schemas && (
                    <div className="rounded-md border border-border bg-panel p-4">
                      <div className="flex items-center gap-2">
                        <span className="label mb-0">{t('wiz.pickSchemas')}</span>
                        {sourceEnv?.pending && (
                          <span className="text-xs text-text-3">{t('wiz.checking')}</span>
                        )}
                      </div>
                      <p className="hint">{t('wiz.schemasHint')}</p>
                      {schemaList.length === 0 ? (
                        <p className="hint">{t('wiz.noSchemas')}</p>
                      ) : (
                        <div className="checks mt-1 flex-col items-start gap-1">
                          {schemaList.map((s) => (
                            <label key={s.name}>
                              <input
                                type="checkbox"
                                checked={selectedNames.includes(s.name)}
                                onChange={() => toggleSchema(s.name)}
                              />
                              <span className="font-mono text-xs">{s.name}</span>
                              <span className="chip">{t('wiz.tables', { count: s.tables })}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      {schemaMissing && (
                        <p className="hint error" role="alert">
                          {t('wiz.schemaNeeded')}
                        </p>
                      )}
                      {sourceEnv?.error && (
                        <Banner kind="danger" role="alert">
                          {sourceEnv.error}
                        </Banner>
                      )}
                    </div>
                  )}
                </div>
              )}

              {kind === 'sql' && (
                <div className="space-y-2">
                  <label className="field">
                    <span className="label">{t('wiz.sqlText')}</span>
                    <textarea
                      className="textarea h-64 font-mono"
                      value={sql}
                      placeholder={t(
                        dialect === 'sqlite'
                          ? 'wiz.sqlPlaceholderSqlite'
                          : dialect === 'mysql'
                            ? 'wiz.sqlPlaceholderMysql'
                            : dialect === 'mssql'
                              ? 'wiz.sqlPlaceholderMssql'
                              : 'wiz.sqlPlaceholderPg',
                      )}
                      spellCheck={false}
                      onChange={(e) => setSql(e.target.value)}
                    />
                  </label>
                  <div className="flex items-center gap-2">
                    <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
                      <FileUp size={16} aria-hidden="true" />
                      {t('wiz.sqlFile')}
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".sql,text/plain"
                      className="sr-only"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setSql(await file.text());
                        e.target.value = '';
                      }}
                    />
                    {kind === 'sql' && !sql.trim() && <span className="hint">{t('wiz.sqlNeeded')}</span>}
                    {kind === 'sql' && filledEnvs.length === 0 && (
                      <span className="hint">
                        {uiSpec.requiresExternalShadow
                          ? t('wiz.sqlNeedsEnv', { dialect: uiSpec.name })
                          : t('wiz.sqlMemoryShadowHint')}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          {step === 3 && (
            <section className="mt-4 space-y-4">
              <p className="hint">{t('wiz.confirmHint')}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-md border border-border bg-panel px-4 py-3 text-sm">
                <dt className="text-text-2">{t('wiz.sumBasics')}</dt>
                <dd className="m-0">
                  {name} · <span className="font-mono text-xs text-text-3">{slug || t('wiz.slugAuto')}</span>
                  {group && <span className="ml-2 text-text-2">{group.name}</span>}
                </dd>
                <dt className="text-text-2">{t('wiz.sumDialect')}</dt>
                <dd className="m-0 font-mono text-xs">{uiSpec.name}</dd>
                <dt className="text-text-2">{t('wiz.sumEnvs')}</dt>
                <dd className="m-0">
                  {filledEnvs.length === 0 ? (
                    <span className="text-text-2">{t('wiz.sumNoEnv')}</span>
                  ) : (
                    <span className="font-mono text-xs">{filledEnvs.map((e) => e.name).join('、')}</span>
                  )}
                </dd>
                <dt className="text-text-2">{t('wiz.sumContent')}</dt>
                <dd className="m-0">
                  {kind === 'takeover' && takeCand
                    ? t('tk.sumTakeover', { name: takeCand.name ?? takeCand.id, id: takeCand.id })
                    : t(`wiz.content${cap(kind)}`)}
                  {kind === 'takeover' && <p className="hint m-0 mt-1">{t('tk.sumVerify')}</p>}
                  {kind === 'takeover' && takeClaim && <p className="hint m-0 mt-1">{t('tk.sumClaim')}</p>}
                  {kind === 'database' && sourceEnv && (
                    <span className="ml-2 font-mono text-xs text-text-3">{sourceEnv.name}</span>
                  )}
                  {kind === 'sql' && (
                    <div className="bg-code-bg mt-1 max-h-40 overflow-auto rounded-sm border border-border p-2 font-mono text-xs whitespace-pre-wrap">
                      {sql.slice(0, 2000)}
                    </div>
                  )}
                </dd>
                {uiSpec.schemas && (
                  <>
                    <dt className="text-text-2">{t('wiz.sumSchemas')}</dt>
                    <dd className="m-0 font-mono text-xs">
                      {kind === 'database' && allSchemaNames.length > 0
                        ? (scopeOf(selectedNames, allSchemaNames) ?? [t('wiz.sumAll')]).join('、')
                        : t('wiz.sumAll')}
                    </dd>
                  </>
                )}
              </dl>
              {busy && (
                <Progress
                  stage={stage}
                  detail={stageDetail}
                  stages={kind === 'takeover' ? TAKEOVER_STAGES : STAGES}
                />
              )}
              {created && warnings.length > 0 && (
                <Banner kind="warn" title={t('tk.warnTitle')} role="alert">
                  <ul className="m-0 list-disc pl-5">
                    {warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Banner>
              )}
              {created && retiredVersions.length > 0 && (
                <Banner kind="info" title={t('tk.retiredTitle')} role="status">
                  <p className="m-0">{t('tk.retiredBody')}</p>
                  <ul className="m-0 mt-1.5 list-disc space-y-0.5 pl-5">
                    {retiredVersions.map((v) => (
                      <li key={v.id}>
                        <span className="font-mono">v{v.number}</span>
                        {v.name ? ` · ${v.name}` : ''}
                      </li>
                    ))}
                  </ul>
                </Banner>
              )}
              {created && (warnings.length > 0 || retiredVersions.length > 0) && (
                <div>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() =>
                      void nav({
                        to: '/project/$owner/$project',
                        params: { owner: created.group.slug, project: created.slug },
                      })
                    }
                  >
                    {t('tk.openProject')}
                  </button>
                </div>
              )}
              {error && (
                <Banner kind="danger" role="alert" title={t('wiz.failed')}>
                  {error}
                </Banner>
              )}
            </section>
          )}

          {error && step !== 3 && (
            <Banner kind="danger" role="alert">
              {error}
            </Banner>
          )}

          <div className="mt-6 flex items-center gap-2">
            <button
              type="button"
              className="btn"
              onClick={() => goto(step - 1)}
              disabled={step === 0 || busy || created !== null}
            >
              {t('wiz.back')}
            </button>
            <span className="flex-1" />
            {step === 1 && (
              <button type="button" className="btn" onClick={() => goto(2)} disabled={busy}>
                {t('wiz.skip')}
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                className="btn primary"
                onClick={() => goto(step + 1)}
                disabled={!canNext || busy}
              >
                {t('wiz.next')}
              </button>
            ) : (
              <button
                type="button"
                className="btn primary"
                onClick={() => void create()}
                disabled={!canNext || busy || created !== null}
                aria-busy={busy}
              >
                {busy ? t('wiz.running') : t('wiz.create')}
              </button>
            )}
          </div>
        </div>
      </main>
      <ClaimDialog
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        onConfirm={() => void create(true)}
        pending={busy}
        error={undefined}
        instanceId={takeClaim?.p.claimedBy}
        isAdmin={isInstanceAdmin}
        confirmLabel={t('tk.claimConfirmTakeover')}
      />
    </AppShell>
  );
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** 连接检查的结果：版本、账号、权限、schema（每个带表数） */
const CheckResult = ({ info, dialect }: { info: TargetInfo; dialect: Dialect }) => {
  const { t } = useTranslation();
  const uiSpec = dialectUiSpec(dialect);
  const yesNo = (v: boolean) => (v ? t('wiz.yes') : t('wiz.no'));
  return (
    <div className="space-y-2 rounded-sm border border-border bg-surface-2 p-3 text-xs">
      <p className="flex items-center gap-1.5 font-medium">
        <CircleCheck size={14} aria-hidden="true" className="text-ok" />
        {t('wiz.checkOk')}
        <span className="text-text-2">
          {t('wiz.checkVersionGeneric', { dialect: uiSpec.name, version: info.version })}
        </span>
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {uiSpec.requiresExternalShadow && (
          <>
            <dt className="text-text-2">{t('wiz.checkUser')}</dt>
            <dd className="m-0 font-mono">{info.currentUser}</dd>
            <dt className="text-text-2">{t('wiz.checkSuper')}</dt>
            <dd className="m-0">
              {yesNo(info.superuser)}
              {!info.superuser && (
                <span className="ml-3 text-text-2">
                  {t('wiz.checkCreateDb')}：{yesNo(info.canCreateDb)}
                  {uiSpec.schemas && (
                    <>
                      {' · '}
                      {t('wiz.checkCreateSchema')}：{yesNo(info.canCreateSchema)}
                    </>
                  )}
                </span>
              )}
            </dd>
          </>
        )}
        <dt className="text-text-2">{uiSpec.schemas ? t('wiz.schemasTitle') : t('wiz.databaseTitle')}</dt>
        <dd className="m-0 flex flex-wrap items-center gap-1.5">
          {info.schemas.length === 0 && <span className="text-text-2">{t('wiz.noSchemas')}</span>}
          {info.schemas.map((s) => (
            <span key={s.name} className="chip font-mono">
              {s.name} · {t('wiz.tables', { count: s.tables })}
            </span>
          ))}
          {info.dowelSchema && (
            <span className="chip flex items-center gap-1 font-mono" title={t('wiz.schemasHint')}>
              <TriangleAlert size={12} aria-hidden="true" />
              dowel
              {info.dowelMeta && <Database size={12} aria-hidden="true" />}
            </span>
          )}
        </dd>
      </dl>
    </div>
  );
};

/** 进度：阶段粒度（连接 / 读取结构 / 影子库验证 / 规范化 / 写入 / 认领 / 完成） */
const Progress = ({
  stage,
  detail,
  stages,
}: {
  stage: WizardStage | null;
  detail: string | null;
  stages: WizardStage[];
}) => {
  const { t } = useTranslation();
  const at = stage ? stages.indexOf(stage) : -1;
  return (
    <div className="rounded-md border border-border bg-panel p-4" role="status" aria-live="polite">
      <p className="label">{t('wiz.progress')}</p>
      <ol className="m-0 flex list-none flex-wrap items-center gap-2 p-0 text-xs">
        {stages.map((s, i) => (
          <li
            key={s}
            className={cx(
              'flex items-center gap-1 rounded-full border px-2.5 py-1',
              i < at
                ? 'border-primary text-primary-text'
                : i === at
                  ? 'border-primary bg-primary-soft font-medium text-primary-text'
                  : 'border-border text-text-3',
            )}
          >
            {i < at ? <Check size={12} aria-hidden="true" /> : <span aria-hidden="true">{i + 1}</span>}
            {t(`wiz.stage.${s}`)}
            {i === at && detail && <span className="font-mono text-text-2">· {detail}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
};
