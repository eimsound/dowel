// 接手（P4c H5 / P6.5 ADR 0012）：从目标库的 dowel 历史恢复出一个平台项目，写入平台前强制经本实例影子库闭环验证。
//
// 为什么能恢复：目标库里的 dowel.versions 存了每个版本的完整模型（含对象 ID）、冻结脚本、checksum、schema 范围、序号和 parent
// （ADR 0003）。恢复就是把这些原样写回平台库：对象 ID 不变，所以接手之后改名仍然是 RENAME，不是先删后加。
//
// 这个文件只放“读目标库 + 影子库验证 + 写平台库”的函数，路由（routes/takeover.ts / routes/claims.ts）负责权限、进度和审计。
import type { StoredVerifyReport, VerifyReport } from '@dowel/api';
import { type Dialect, getDialect, type Model } from '@dowel/core';
import { type Db, HistoryError, type HistoryVersionRow, ScopeError } from '@dowel/engines';
import { ExecutorError, type MergedHistory, readState, type TargetState } from '@dowel/executor';
import { HTTPException } from 'hono/http-exception';

import { chainFrom } from './chain.ts';
import { syncEnvCache } from './envs.ts';
import { classifyError } from './executions.ts';
import { SecretError, scrubSecrets } from './secrets.ts';
import { type Shadow, ShadowError, storedReport } from './shadow.ts';
import { prepareShadow, type ShadowSource } from './shadows.ts';
import {
  CHECK_CONNECT_TIMEOUT,
  ConnectError,
  type ConnectionGuard,
  connectTarget,
  type PreparedShadow,
} from './targets.ts';

export type { PreparedShadow };

/** 接手 / 接入领先验证被拒绝：code 给界面分支（claim_required、claim_forbidden、shadow_unavailable、verify_failed、project_exists 等） */
export class TakeoverRejected extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TakeoverRejected';
    this.code = code;
  }
}

/** 读一个环境的目标库历史（只读，不建任何东西）；错误带上环境名 */
export const readSource = async (
  name: string,
  url: string,
  projectId: string,
  guard: ConnectionGuard,
  dialect: Dialect = 'pg',
): Promise<TargetState> => {
  const c = connectTarget(dialect, url, CHECK_CONNECT_TIMEOUT, guard);
  try {
    return await readState(c.db, projectId, dialect);
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    if (e instanceof ExecutorError && e.code !== 'unexpected') throw e;
    if (e instanceof HistoryError) throw new ExecutorError(e.code, `环境“${name}”：${e.message}`, {}, e);
    if (e instanceof ScopeError || e instanceof SecretError) throw e;
    const k = classifyError(e, url, dialect);
    if (k.kind === 'unexpected') throw e;
    throw new ConnectError(`环境“${name}”：${k.message}`);
  } finally {
    await c.close().catch(() => {});
  }
};

/**
 * 计算整条待验证版本链上全部版本 scope 的并集：任一版本为全量（null / 空）则返回 null（全部 schema），
 * 否则返回去重后的 schema 列表（避免链头 scope 窄于早期版本导致影子库未覆盖早期 schema）。
 */
export const unionScopes = (
  versions: { scope?: string[] | null }[],
  fallback: string[] | null = null,
): string[] | null => {
  if (!versions.length) return fallback?.length ? [...fallback] : null;
  const set = new Set<string>();
  for (const v of versions) {
    if (!v.scope?.length) return null;
    for (const s of v.scope) set.add(s);
  }
  return set.size ? [...set] : fallback?.length ? [...fallback] : null;
};

/**
 * 从候选环境中挑选第一个可用的影子库：优先使用配置了独立 shadowUrl 的环境，其余按原顺序尝试。
 * 找不到可用影子库时抛 TakeoverRejected('shadow_unavailable', …)；白名单拒绝 / 密钥错误等非 ShadowError 原样抛出。
 */
export const pickShadow = async (
  sources: ShadowSource[],
  schemas: string[] | null,
  guard?: ConnectionGuard,
  dialect: Dialect = 'pg',
): Promise<PreparedShadow> => {
  if (!getDialect(dialect).capabilities.requiresExternalShadow) {
    return prepareShadow(null, schemas, guard, dialect);
  }
  if (!sources.length)
    throw new TakeoverRejected(
      'shadow_unavailable',
      '没有可用的影子库：请先为至少一个环境配置独立影子库连接串，或允许使用同实例影子库',
    );
  const ordered = [...sources.filter((s) => !!s.shadowUrl), ...sources.filter((s) => !s.shadowUrl)];
  const reasons: string[] = [];
  for (const env of ordered) {
    try {
      return await prepareShadow(env, schemas, guard, dialect);
    } catch (e) {
      if (!(e instanceof ShadowError)) throw e;
      reasons.push(scrubSecrets(e.message));
    }
  }
  throw new TakeoverRejected(
    'shadow_unavailable',
    `找不到可用的影子库，无法验证迁移版本链：${reasons[0] ?? '没有配置影子库'}`,
  );
};

const formatVerifyFailure = (v: Pick<HistoryVersionRow, 'number' | 'name'>, report: VerifyReport): string => {
  const parts: string[] = [];
  if (report.error) parts.push(report.error.message);
  if (report.upDiff.length)
    parts.push(`升级后结构与模型不一致（${report.upDiff.length} 处差异，如：${report.upDiff[0]}）`);
  if (report.downDiff.length)
    parts.push(`回滚后结构与上一版本不一致（${report.downDiff.length} 处差异，如：${report.downDiff[0]}）`);
  const reason = parts.join('；') || '验证未通过';
  return `版本 v${v.number}「${v.name}」在影子库闭环验证失败：${reason}`;
};

/**
 * 按顺序在影子库中闭环验证一条版本链（ADR 0012）：
 * - 接手整条链时 baseModel 为 null（首版本按其 scope 建空库模型起跑）；
 * - 接入领先环境时 baseModel 为原平台链头模型；
 * - 任意一个版本失败或影子库中途不可用立即拒绝并指明版本号和原因。
 */
export const verifyVersionChain = async (o: {
  shadow: Shadow;
  shadowLabel: string;
  versions: HistoryVersionRow[];
  baseModel: Model | null;
  onVersion?: (v: HistoryVersionRow, index: number, total: number) => Promise<void> | void;
}): Promise<Map<string, StoredVerifyReport>> => {
  const reports = new Map<string, StoredVerifyReport>();
  let prevModel = o.baseModel;
  for (let i = 0; i < o.versions.length; i++) {
    const v = o.versions[i]!;
    await o.onVersion?.(v, i, o.versions.length);
    const parent = prevModel ? { model: prevModel } : null;
    const from = chainFrom(parent, v.model, v.scope);
    const checkDown = !(v.number === 0 && v.downSteps.length === 0);
    let report: VerifyReport;
    try {
      report = await o.shadow.verifyScripts(from, v.model, v.upSteps, v.downSteps, { checkDown });
    } catch (e) {
      if (e instanceof ShadowError)
        throw new TakeoverRejected(
          'shadow_unavailable',
          `验证版本 v${v.number}「${v.name}」时影子库不可用：${scrubSecrets(e.message)}`,
        );
      throw e;
    }
    if (!report.ok) throw new TakeoverRejected('verify_failed', formatVerifyFailure(v, report));
    reports.set(v.versionId, storedReport(report, o.shadowLabel));
    prevModel = v.model;
  }
  return reports;
};

/** 恢复版本并非由当前画布提交序列发布，seq 统一写哨兵值 -1（正常画布提交 seq >= 0） */
const RESTORED_VERSION_SEQ = -1;

/** 写入从目标库恢复并已验证通过的版本行（接手整条链与接入领先版本共用） */
export const insertRestoredVersions = async (
  tx: Db,
  o: {
    pid: string;
    branch: string;
    versions: HistoryVersionRow[];
    verifiedReports: Map<string, StoredVerifyReport>;
    restoredAt?: string;
  },
) => {
  const restoredAt = o.restoredAt ?? new Date().toISOString();
  for (const v of o.versions) {
    const report = o.verifiedReports.get(v.versionId) ?? null;
    const verifiedAt = report?.ok ? report.at : null;
    await tx.query(
      `insert into versions (id, project_id, branch_id, seq, name, model, created_by, created_at, number, parent_id,
                             up_steps, down_steps, checksum, verified_at, verify_report, scope, restored_at)
       values ($1, $2, $3, $4, $5, $6::text::jsonb, null, $7, $8, $9, $10::text::jsonb, $11::text::jsonb, $12,
               $13, $14::text::jsonb, $15::text::jsonb, $16)`,
      [
        v.versionId,
        o.pid,
        o.branch,
        RESTORED_VERSION_SEQ,
        v.name,
        JSON.stringify(v.model),
        v.publishedAt,
        v.number,
        v.parentId,
        JSON.stringify(v.upSteps),
        JSON.stringify(v.downSteps),
        v.checksum,
        verifiedAt,
        report ? JSON.stringify(report) : null,
        v.scope?.length ? JSON.stringify(v.scope) : null,
        restoredAt,
      ],
    );
  }
};

export interface RestoreEnv {
  id: string;
  name: string;
  url_enc: string;
  production: boolean;
  allowSameInstance: boolean;
  shadow_url_enc: string | null;
  engineVersion?: string | null;
  engineVersionNum?: number | null;
  state: TargetState;
}

/**
 * 在一个平台库事务里恢复整个项目：项目、授权由调用方写；这里写 分支 / 工作副本 / 环境 / 版本链。
 * - 工作副本 = 链头版本的模型（也是派生数据的基线：恢复的模型本来就是引擎读出的规范形式）；
 * - 版本链原样恢复（id、序号、parent、模型、冻结脚本、checksum、schema 范围、发布时间），
 *   写入全部通过影子库闭环验证后的 verified_at 与 verify_report，并保留 restored_at 标明来源（ADR 0012）；
 * - 环境：当前版本 = 各自目标库历史里最后完成的版本；“执行过哪些版本”和 executed_at 由 syncEnvCache 按各环境的历史对齐
 *   （和读历史时的同步是同一份逻辑）。
 */
export const restoreChain = async (
  tx: Db,
  o: {
    pid: string;
    branch: string;
    merged: MergedHistory;
    envs: RestoreEnv[];
    verifiedReports: Map<string, StoredVerifyReport>;
    restoredAt?: string;
  },
) => {
  const head = o.merged.versions.at(-1)!;
  await tx.query(
    "insert into branches (id, project_id, name, baseline) values ($1, $2, 'main', $3::text::jsonb)",
    [o.branch, o.pid, JSON.stringify(head.model)],
  );
  await tx.query(
    'insert into room_snapshots (branch_id, seq, model, versions) values ($1, 0, $2::text::jsonb, $3::text::jsonb)',
    [o.branch, JSON.stringify(head.model), '{}'],
  );
  await insertRestoredVersions(tx, {
    pid: o.pid,
    branch: o.branch,
    versions: o.merged.versions,
    verifiedReports: o.verifiedReports,
    restoredAt: o.restoredAt,
  });
  for (const e of o.envs) {
    await tx.query(
      `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc,
                                 current_version_id, engine_version, engine_version_num)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.id,
        o.pid,
        e.name,
        e.url_enc,
        e.production,
        e.allowSameInstance,
        e.shadow_url_enc,
        e.state.current,
        e.engineVersion ?? null,
        e.engineVersionNum ?? null,
      ],
    );
    await syncEnvCache(tx, e.id, e.state);
  }
};
