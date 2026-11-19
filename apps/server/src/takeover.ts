// 接手（P4c H5）：从目标库的 dowel 历史恢复出一个平台项目。
//
// 为什么能恢复：目标库里的 dowel.versions 存了每个版本的完整模型（含对象 ID）、冻结脚本、checksum、schema 范围、序号和 parent
// （ADR 0003）。恢复就是把这些原样写回平台库：对象 ID 不变，所以接手之后改名仍然是 RENAME，不是先删后加。
//
// 这个文件只放“读目标库 + 整理 + 写平台库”的函数，路由（routes/takeover.ts）负责权限、进度和审计。
import { type Db, HistoryError, ScopeError } from '@dowel/engines';
import { ExecutorError, type MergedHistory, readState, type TargetState } from '@dowel/executor';
import { HTTPException } from 'hono/http-exception';
import { syncEnvCache } from './envs.ts';
import { classifyError } from './executions.ts';
import { SecretError } from './secrets.ts';
import { CHECK_CONNECT_TIMEOUT, ConnectError, type ConnectionGuard, connectPg } from './targets.ts';

/** 接手被拒绝：code 给界面分支（claim_required 需要确认认领、claim_forbidden 需要实例管理员、project_exists 等） */
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
): Promise<TargetState> => {
  const c = connectPg(url, CHECK_CONNECT_TIMEOUT, guard);
  try {
    return await readState(c.db, projectId);
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    if (e instanceof ExecutorError && e.code !== 'unexpected') throw e;
    if (e instanceof HistoryError) throw new ExecutorError(e.code, `环境“${name}”：${e.message}`, {}, e);
    if (e instanceof ScopeError || e instanceof SecretError) throw e;
    const k = classifyError(e, url);
    if (k.kind === 'unexpected') throw e;
    throw new ConnectError(`环境“${name}”：${k.message}`);
  } finally {
    await c.close().catch(() => {});
  }
};

export interface RestoreEnv {
  id: string;
  name: string;
  url_enc: string;
  production: boolean;
  allowSameInstance: boolean;
  shadow_url_enc: string | null;
  state: TargetState;
}

/**
 * 在一个平台库事务里恢复整个项目：项目、授权由调用方写；这里写 分支 / 工作副本 / 环境 / 版本链。
 * - 工作副本 = 链头版本的模型（也是派生数据的基线：恢复的模型本来就是引擎读出的规范形式）；
 * - 版本链原样恢复（id、序号、parent、模型、冻结脚本、checksum、schema 范围、发布时间），**一律未验证**（verified_at 为空）、
 *   标 restored_at：见 05-implementation.md P4c 的取舍；
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
    restoredAt?: string;
  },
) => {
  const head = o.merged.versions.at(-1)!;
  const restoredAt = o.restoredAt ?? new Date().toISOString();
  await tx.query(
    "insert into branches (id, project_id, name, baseline) values ($1, $2, 'main', $3::text::jsonb)",
    [o.branch, o.pid, JSON.stringify(head.model)],
  );
  await tx.query(
    'insert into room_snapshots (branch_id, seq, model, versions) values ($1, 0, $2::text::jsonb, $3::text::jsonb)',
    [o.branch, JSON.stringify(head.model), '{}'],
  );
  for (const v of o.merged.versions)
    await tx.query(
      `insert into versions (id, project_id, branch_id, seq, name, model, created_by, created_at, number, parent_id,
                             up_steps, down_steps, checksum, verified_at, verify_report, scope, restored_at)
       values ($1, $2, $3, $4, $5, $6::text::jsonb, null, $7, $8, $9, $10::text::jsonb, $11::text::jsonb, $12,
               null, null, $13::text::jsonb, $14)`,
      [
        v.versionId,
        o.pid,
        o.branch,
        v.number,
        v.name,
        JSON.stringify(v.model),
        v.publishedAt,
        v.number,
        v.parentId,
        JSON.stringify(v.upSteps),
        JSON.stringify(v.downSteps),
        v.checksum,
        v.scope?.length ? JSON.stringify(v.scope) : null,
        restoredAt,
      ],
    );
  for (const e of o.envs) {
    await tx.query(
      `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc,
                                 current_version_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.id, o.pid, e.name, e.url_enc, e.production, e.allowSameInstance, e.shadow_url_enc, e.state.current],
    );
    await syncEnvCache(tx, e.id, e.state);
  }
};
