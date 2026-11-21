// 环境行、版本链的读取，以及平台库里的执行状态缓存（当前版本、执行过哪些版本、漂移结果）。
// 事实来源是目标库里的 dowel 历史；这里的缓存让环境页、图标栏的警告、“版本是否执行过”的判断不用每次都连目标库。

import type {
  DriftInfo,
  DriftStatus,
  DriftSummary,
  EnvInfo,
  EnvPermissions,
  EnvVersion,
  EnvVersionRef,
} from '@dowel/api';
import { needsManualSchema } from '@dowel/api';
import { deriveTargetPgMajor, type Dialect, type Model, pgMajorOf } from '@dowel/core';
import type { Db, ScriptStep } from '@dowel/engines';
import { type ChainVersion, isNonTx, runTouched, runVersionId, type TargetState } from '@dowel/executor';
import { HTTPException } from 'hono/http-exception';

import { can, type Resource } from './authz.ts';
import { inList } from './db.ts';
import type { EnvAuth } from './policy.ts';
import type { Role } from './rooms.ts';
import { decrypt, maskUrl } from './secrets.ts';

/** postgres.js 把 timestamptz 读成 Date，SQLite 是文本：统一成 ISO 字符串 */
export const iso = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v.toISOString()
      : typeof v === 'string' || typeof v === 'number'
        ? String(v)
        : null;

export interface EnvRow {
  id: string;
  project_id: string;
  name: string;
  url_enc: string;
  production: boolean;
  allow_same_instance: boolean;
  shadow_url_enc: string | null;
  current_version_id: string | null;
  last_drift_check: unknown;
  drift_status: DriftStatus;
  drift_summary: DriftSummary | null;
  engine_version?: string | null;
  engine_version_num?: number | null;
}

/** 从版本号数值回退格式化简洁版本串（PG: 160004 → "16.4"；SQLite: 3054001 → "3.54.1"） */
export const formatVersionNum = (versionNum: number, dialect: Dialect = 'pg'): string => {
  if (dialect === 'sqlite') {
    const major = Math.floor(versionNum / 1_000_000);
    const minor = Math.floor((versionNum % 1_000_000) / 1000);
    const patch = versionNum % 1000;
    return `${major}.${minor}.${patch}`;
  }
  const major = Math.floor(versionNum / 10000);
  const minor = versionNum % 10000;
  return `${major}.${minor}`;
};

/**
 * 更新环境记录的引擎版本。
 * 传入 `expectedUrlEnc` 时在 WHERE 中校验 `url_enc = $4`，防止与并发 PATCH 改连接串发生倒挂。
 */
export const updateEnvVersion = async (
  db: Db,
  envId: string,
  version: string | null,
  versionNum: number | null,
  expectedUrlEnc?: string,
): Promise<boolean> => {
  if (expectedUrlEnc !== undefined) {
    const rows = await db.query<{ id: string }>(
      'update environments set engine_version = $2, engine_version_num = $3 where id = $1 and url_enc = $4 returning id',
      [envId, version, versionNum, expectedUrlEnc],
    );
    return rows.length > 0;
  }
  const rows = await db.query<{ id: string }>(
    'update environments set engine_version = $2, engine_version_num = $3 where id = $1 returning id',
    [envId, version, versionNum],
  );
  return rows.length > 0;
};

/** 汇总项目下全部环境的 PG 大版本（去重升序）并推导目标最低版本（非 PG 项目返回空） */
export const projectPgVersionSummary = async (
  db: Db,
  projectId: string,
): Promise<{ targetPgMajor: number | null; envPgMajors: number[] }> => {
  const [proj] = await db.query<{ dialect: Dialect }>('select dialect from projects where id = $1', [
    projectId,
  ]);
  if (proj && proj.dialect !== 'pg') return { targetPgMajor: null, envPgMajors: [] };
  const rows = await db.query<{ engine_version_num: number | null }>(
    'select engine_version_num from environments where project_id = $1',
    [projectId],
  );
  const majors = new Set<number>();
  for (const r of rows) {
    const major = pgMajorOf(r.engine_version_num);
    if (major !== null) majors.add(major);
  }
  const envPgMajors = [...majors].sort((a, b) => a - b);
  return {
    targetPgMajor: deriveTargetPgMajor(envPgMajors),
    envPgMajors,
  };
};

/** 推导项目目标兼容的最低 PG 大版本（无已探测环境时为 null） */
export const projectTargetPgMajor = async (db: Db, projectId: string): Promise<number | null> =>
  (await projectPgVersionSummary(db, projectId)).targetPgMajor;

export const loadEnv = async (db: Db, pid: string, eid: string): Promise<EnvRow> => {
  const [r] = await db.query<EnvRow>('select * from environments where id = $1 and project_id = $2', [
    eid,
    pid,
  ]);
  if (!r) throw new HTTPException(404, { message: '环境不存在' });
  return r;
};

/** 版本概要（不含模型，状态页用） */
export interface VersionMeta {
  id: string;
  number: number;
  name: string;
  verifiedAt: unknown;
  edited: boolean;
  upSteps: ScriptStep[];
  downSteps: ScriptStep[];
  verifyReport: { risks?: { level: 'low' | 'medium' | 'high'; note?: string }[]; riskError?: string } | null;
}

export const loadVersionMetas = async (db: Db, pid: string): Promise<VersionMeta[]> =>
  db.query<VersionMeta>(
    `select id, number, name, verified_at as "verifiedAt", edited, up_steps as "upSteps",
            down_steps as "downSteps", verify_report as "verifyReport"
       from versions where project_id = $1 order by number`,
    [pid],
  );

/** 完整的版本链（含模型和冻结脚本，执行器 / 漂移检测用） */
export const loadChain = async (db: Db, pid: string): Promise<ChainVersion[]> => {
  const rows = await db.query<{
    id: string;
    number: number;
    parentId: string | null;
    name: string;
    model: Model;
    upSteps: ScriptStep[];
    downSteps: ScriptStep[];
    checksum: string;
    verifiedAt: unknown;
    createdAt: unknown;
    createdBy: string | null;
    scope: string[] | null;
  }>(
    `select id, number, parent_id as "parentId", name, model, up_steps as "upSteps", down_steps as "downSteps",
            checksum, verified_at as "verifiedAt", created_at as "createdAt", created_by as "createdBy", scope
       from versions where project_id = $1 order by number`,
    [pid],
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    parentId: r.parentId,
    name: r.name,
    model: r.model,
    upSteps: r.upSteps,
    downSteps: r.downSteps,
    checksum: r.checksum,
    verified: r.verifiedAt !== null && r.verifiedAt !== undefined,
    publishedAt: iso(r.createdAt) ?? new Date(0).toISOString(),
    publishedBy: r.createdBy,
    scope: r.scope?.length ? r.scope : null,
  }));
};

// ───── 执行状态缓存 ─────

/** 版本执行过：第一次确认时写入，之后不再改（永久，见 versionExecutedAnywhere） */
export const markExecuted = async (db: Db, versionId: string, at = new Date().toISOString()) => {
  await db.query('update versions set executed_at = $2 where id = $1 and executed_at is null', [
    versionId,
    at,
  ]);
};

const upsertConfirmed = (db: Db, envId: string, versionId: string) =>
  db.query(
    `insert into environment_versions (environment_id, version_id, state) values ($1, $2, 'confirmed')
     on conflict (environment_id, version_id) do update set state = 'confirmed'`,
    [envId, versionId],
  );

/** 确认执行：永久写下 executed_at，并把这个环境上的登记改成 confirmed */
export const confirmVersion = async (db: Db, envId: string, versionId: string) => {
  await markExecuted(db, versionId);
  await upsertConfirmed(db, envId, versionId);
};

/** 撤销执行前的登记（只撤销 claimed；confirmed 的不动）：目标库没有被改动的失败 */
export const releaseClaim = async (db: Db, envId: string, versionId: string) => {
  await db.query(
    "delete from environment_versions where environment_id = $1 and version_id = $2 and state = 'claimed'",
    [envId, versionId],
  );
};

/**
 * 把目标库历史同步到平台库缓存，**完全对齐**：
 * - `environment_versions`：目标库历史里有的版本（含停在中途 / 读回失败的那个迁移）→ confirmed，同时写 `versions.executed_at`；
 *   历史里没有的**删掉**（claimed 的残留、换了连接串或目标库重建之后的旧行），所以 `executedHere` 是准确的；
 * - `environments.current_version_id` 更新成目标库的当前版本。
 * 删掉记录不会丢保护：“执行过”的永久事实在 `versions.executed_at`，只写不清。
 * **调用方必须在目标库的项目锁里读状态并调用它**（拿不到锁就跳过，见 syncTarget）：持锁时不可能有执行在进行，
 * 所以 claimed 的残留一定是进程崩溃留下的，可以安全清掉。
 * 先一次读出现有的行，只对需要变化的行写（已经对齐时一条写入都没有）。
 */
export const syncEnvCache = async (db: Db, envId: string, state: TargetState) => {
  // 目标库历史里“碰过”这个库的版本：版本行，加上**全部**执行记录里碰过目标库的那些（完成、做了一部分、读回失败）——
  // 不能只看最后一次：v2 读回失败（动过库）、手工修好后再来一次干净的失败，v2 仍然算执行过。只有完全干净的失败不算
  const inHistory = new Set(state.versions.map((v) => v.versionId));
  for (const r of state.runs) {
    const vid = runTouched(r) ? runVersionId(r) : null;
    if (vid) inHistory.add(vid);
  }

  const have = new Map(
    (
      await db.query<{ version_id: string; state: string }>(
        'select version_id, state from environment_versions where environment_id = $1',
        [envId],
      )
    ).map((r) => [r.version_id, r.state]),
  );
  // 平台库里确实有的版本，以及它们有没有 executed_at（一次查完）
  const known = new Map<string, boolean>();
  if (inHistory.size) {
    const ids = [...inHistory];
    for (const r of await db.query<{ id: string; executed_at: unknown }>(
      `select id, executed_at from versions where id in (${inList(ids)})`,
      ids,
    ))
      known.set(r.id, r.executed_at !== null && r.executed_at !== undefined);
  }
  for (const [id, hasExecutedAt] of known) {
    if (have.get(id) !== 'confirmed') await upsertConfirmed(db, envId, id);
    if (!hasExecutedAt) await markExecuted(db, id);
  }
  for (const id of have.keys())
    if (!known.has(id))
      await db.query('delete from environment_versions where environment_id = $1 and version_id = $2', [
        envId,
        id,
      ]);
  const [env] = await db.query<{ current_version_id: string | null }>(
    'select current_version_id from environments where id = $1',
    [envId],
  );
  if (env && env.current_version_id !== state.current)
    await db.query('update environments set current_version_id = $2 where id = $1', [envId, state.current]);
};

export const setDrift = async (
  db: Db,
  envId: string,
  status: DriftStatus,
  summary: DriftSummary | null,
  at = new Date().toISOString(),
) => {
  await db.query(
    'update environments set drift_status = $2, drift_summary = $3::text::jsonb, last_drift_check = $4 where id = $1',
    [envId, status, summary ? JSON.stringify(summary) : null, at],
  );
};

// ───── 映射成 API 的形状 ─────

/**
 * 读出缓存的漂移摘要。旧数据里 `needsManual` 可能是 `true`（早期格式），或者别的不合格式的值：
 * 用 `needsManualSchema.safeParse` 校验，不是合格的 `{ direction, versionId, … }` 对象就当作没有，不让界面渲染出空方向或问号。
 */
export const sanitizeSummary = (s: DriftSummary | null | undefined): DriftSummary | null => {
  if (!s) return null;
  const raw = (s as { needsManual?: unknown }).needsManual;
  if (raw === undefined) return s;
  const { needsManual: _drop, ...rest } = s;
  const parsed = needsManualSchema.safeParse(raw);
  return parsed.success ? { ...rest, needsManual: parsed.data } : rest;
};

export const driftInfo = (r: EnvRow): DriftInfo => ({
  status: r.drift_status,
  checkedAt: iso(r.last_drift_check),
  summary: sanitizeSummary(r.drift_summary),
});

/** 环境资源：生效的“谁能执行”和调用者是不是执行者由 policy.ts 算好（envAuthOf） */
export const envResource = (r: EnvRow, role: Role, auth: EnvAuth): Resource => ({
  kind: 'environment',
  role,
  production: r.production,
  execPolicy: auth.resolved.whoCanExecute.value,
  isExecutor: auth.isExecutor,
});

export const permissionsOf = (
  actor: Parameters<typeof can>[0],
  r: EnvRow,
  role: Role,
  auth: EnvAuth,
): EnvPermissions => {
  const res = envResource(r, role, auth);
  const approvalRequired = auth.resolved.approval.stages.length > 0;
  return {
    execute: can(actor, 'environment.execute', res),
    configure: can(actor, 'environment.change_connection', res),
    unmarkProduction: can(actor, 'environment.unmark_production', res),
    approvalRequired,
    request: can(actor, 'environment.request', res),
    emergency: approvalRequired && can(actor, 'instance.emergency_execute', { kind: 'instance' }),
  };
};

export const safeMask = (enc: string) => {
  try {
    return maskUrl(decrypt(enc));
  } catch {
    return '（无法解密）';
  }
};

export const versionRef = (m: { id: string; number: number; name: string }): EnvVersionRef => ({
  id: m.id,
  number: m.number,
  name: m.name,
});

/** 版本的轻量引用（id / 序号 / 名字），不读脚本、模型和验证报告 */
export type VersionRefRow = { id: string; number: number; name: string };

export const loadVersionRefs = async (db: Db, pid: string): Promise<Map<string, VersionRefRow>> =>
  new Map(
    (await db.query<VersionRefRow>('select id, number, name from versions where project_id = $1', [pid])).map(
      (v) => [v.id, v],
    ),
  );

/** 环境信息（列表、PATCH 的响应）：当前版本由调用方给（各自用最便宜的方式读） */
export const toEnvInfo = (
  r: EnvRow,
  actor: Parameters<typeof can>[0],
  role: Role,
  auth: EnvAuth,
  refs: { currentVersion: EnvVersionRef | null },
  dialect: Dialect = 'pg',
): EnvInfo => ({
  id: r.id,
  name: r.name,
  url: safeMask(r.url_enc),
  production: r.production,
  allowSameInstance: r.allow_same_instance,
  shadowUrl: r.shadow_url_enc ? safeMask(r.shadow_url_enc) : null,
  execPolicy: auth.resolved.whoCanExecute.own,
  effectiveExecPolicy: auth.resolved.whoCanExecute.value,
  policy: auth.resolved,
  currentVersion: refs.currentVersion,
  engineVersion: r.engine_version ?? null,
  engineVersionNum: r.engine_version_num ?? null,
  engineMajor: dialect === 'pg' ? pgMajorOf(r.engine_version_num) : null,
  drift: driftInfo(r),
  permissions: permissionsOf(actor, r, role, auth),
});

const LEVELS = { low: 0, medium: 1, high: 2 } as const;

/** 环境状态里的一个版本：相对环境当前版本是已执行 / 当前 / 待执行 */
export const toEnvVersion = (
  m: VersionMeta,
  current: VersionMeta | undefined,
  executed: Set<string>,
  dialect: Dialect = 'pg',
): EnvVersion => {
  const state =
    !current || m.number > current.number ? 'pending' : m.id === current.id ? 'current' : 'applied';
  const risks = m.verifyReport?.risks ?? [];
  const analysed = risks.filter((r) => !r.note);
  return {
    id: m.id,
    number: m.number,
    name: m.name,
    state,
    verified: m.verifiedAt !== null && m.verifiedAt !== undefined,
    edited: m.edited,
    upSteps: m.upSteps.length,
    downSteps: m.downSteps.length,
    // 和执行器用同一条规则（冻结标记 + 语句文本）
    nonTransactional: m.upSteps.some((s) => isNonTx(s, dialect)),
    risk: analysed.length
      ? analysed.reduce(
          (a, r) => (LEVELS[r.level] > LEVELS[a] ? r.level : a),
          'low' as 'low' | 'medium' | 'high',
        )
      : null,
    riskError: m.verifyReport?.riskError ?? null,
    executedHere: executed.has(m.id),
  };
};
