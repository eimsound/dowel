// 绑定检查（ADR 0007）：申请绑定的环境状态、版本链与审批流程是否仍然成立；以及版本作废导致的失效原因。
import type { Db } from '@dowel/engines';

import { type EnvRow, iso } from '../envs.ts';
import { loadPolicies, type PolicyStore, resolveEnv } from '../policy.ts';
import { type ProjectRow, projectRow } from '../roles.ts';
import { flowStillHolds } from './flow.ts';
import { connHash, type RequestRow } from './model.ts';

// ───── 绑定检查 ─────

export interface BindingProblem {
  status: 'invalid' | 'expired';
  reason: string;
}

const vlabel = (v: { number: number } | null | undefined) =>
  v ? `v${v.number}` : '（还没有执行过任何版本）';

/**
 * 一轮检查里共用的读取结果（第二轮审查：同一个环境 / 项目的申请不要每个都重新查环境行、版本、项目和策略）。
 * 只在同一个事务 / 同一轮只读检查里共用，不跨轮。
 */
export interface BindingCache {
  envs: Map<string, EnvRow | null>;
  versions: Map<string, Map<string, { id: string; number: number; checksum: string; retiredAt: unknown }>>;
  projects: Map<string, ProjectRow | null>;
  stores: Map<string, PolicyStore>;
}
export const newBindingCache = (): BindingCache => ({
  envs: new Map(),
  versions: new Map(),
  projects: new Map(),
  stores: new Map(),
});
const cached = async <V>(m: Map<string, V>, k: string, load: () => Promise<V>): Promise<V> => {
  if (m.has(k)) return m.get(k) as V;
  const v = await load();
  m.set(k, v);
  return v;
};

/**
 * 申请绑定的环境状态还成立吗（ADR 0007）。在执行策略锁里调用（审批、执行、定时清理），用传入的 db 重新读一切
 * （cache 只在同一轮里共用）。返回 null = 仍然有效；否则是该转成的状态和原因。正在执行（executing）的不检查。
 */
export const bindingProblem = async (
  db: Db,
  req: RequestRow,
  now = new Date(),
  cache: BindingCache = newBindingCache(),
): Promise<BindingProblem | null> => {
  const invalid = (reason: string): BindingProblem => ({ status: 'invalid', reason });
  const expires = new Date(iso(req.expires_at)!);
  if (expires.getTime() <= now.getTime())
    return { status: 'expired', reason: `申请已过期（有效期到 ${expires.toISOString()}）` };
  const env = await cached(
    cache.envs,
    req.environment_id,
    async () =>
      (await db.query<EnvRow>('select * from environments where id = $1', [req.environment_id]))[0] ?? null,
  );
  if (!env) return invalid('环境已经不存在');
  const versions = await cached(
    cache.versions,
    req.project_id,
    async () =>
      new Map(
        (
          await db.query<{ id: string; number: number; checksum: string; retiredAt: unknown }>(
            'select id, number, checksum, retired_at as "retiredAt" from versions where project_id = $1',
            [req.project_id],
          )
        ).map((v) => [v.id, v]),
      ),
  );
  if ((env.current_version_id ?? null) !== (req.from_version_id ?? null))
    return invalid(
      `环境的当前版本变了：提交时是 ${vlabel(req.from_version_id ? versions.get(req.from_version_id) : null)}，现在是 ${vlabel(env.current_version_id ? versions.get(env.current_version_id) : null)}`,
    );
  if (env.drift_status === 'drifted') return invalid('检测到漂移：目标库的结构和环境当前版本不一致');
  if (env.production !== req.production) return invalid('环境的“生产”标记变了');
  if (connHash(env) !== req.conn_hash) return invalid('环境的连接设置变了');
  const toVer = versions.get(req.to_version_id);
  if (!toVer) return invalid('目标版本已经不存在');
  // (a) 非回滚申请（执行 / 切换）：目标版本已作废 → 失效
  if (req.direction !== 'down' && iso(toVer.retiredAt) !== null)
    return invalid(`目标版本 v${toVer.number} 已作废`);
  const reqCreatedMs = new Date(iso(req.created_at)!).getTime();
  for (const m of req.migrations) {
    const v = versions.get(m.versionId);
    if (!v) return invalid(`版本 v${m.number} 已经不存在`);
    if (v.checksum !== m.checksum) return invalid(`版本 v${m.number} 的脚本在提交之后被修改过`);
    const retiredAtIso = iso(v.retiredAt);
    if (retiredAtIso !== null) {
      // (b) 绑定的升级迁移对应版本已作废 → 失效
      if (m.direction === 'up') return invalid(`版本 v${m.number} 已作废`);
      // (c) 绑定的回滚迁移对应版本在提交申请之后才被作废 → 失效；提交前已作废的（作废后发起的切换 / 回滚申请）保持有效
      if (new Date(retiredAtIso).getTime() > reqCreatedMs)
        return invalid(`版本 v${m.number} 在提交申请后被作废`);
    }
  }
  const project = await cached(cache.projects, req.project_id, () => projectRow(db, req.project_id));
  if (!project) return invalid('项目已经不存在');
  const store = await cached(cache.stores, project.id, () => loadPolicies(db, project));
  const resolved = resolveEnv(store, env);
  if (
    !flowStillHolds(
      req.flow,
      resolved.approval.stages.map((s) => s.stage),
    )
  )
    return invalid('环境的审批流程变严了：请按新的审批流程重新提交');
  return null;
};

/** 计算某条开放申请因版本作废而失效的原因（与 bindingProblem 规则与文案保持一致）；不受该作废段影响时返回 null */
export const retireInvalidReason = (
  req: Pick<RequestRow, 'direction' | 'to_version_id' | 'migrations'>,
  retiredSpan: ReadonlyMap<string, { number: number }>,
): string | null => {
  if (req.direction !== 'down') {
    const toVer = retiredSpan.get(req.to_version_id);
    if (toVer) return `目标版本 v${toVer.number} 已作废`;
  }
  for (const m of req.migrations) {
    if (!retiredSpan.has(m.versionId)) continue;
    if (m.direction === 'up') return `版本 v${m.number} 已作废`;
    return `版本 v${m.number} 在提交申请后被作废`;
  }
  return null;
};
