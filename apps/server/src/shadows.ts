// 为一次检查选影子库（共识 4.4）：影子库必须是真实的 PostgreSQL 实例，没有兜底。
//   1. 环境里显式配置的影子库实例；
//   2. 默认：目标实例上的 {原库名}_dowel（生产环境需要明确同意才用同一实例）；
//   项目没有环境、或影子库不可用时直接报错。
import { HTTPException } from 'hono/http-exception';
import type { PlatformDb } from './db.ts';
import { decrypt } from './secrets.ts';
import { type Shadow, ShadowError, ShadowUnavailableError } from './shadow.ts';
import { ConnectError, type ConnectionGuard, ensureSameInstanceShadow, pgShadow } from './targets.ts';

export interface Env {
  id: string;
  name: string;
  url: string;
  production: boolean;
  allowSameInstance: boolean;
  shadowUrl: string | null;
  /** 项目的 schema 范围（null 表示全部，dowel 永远排除） */
  schemas: string[] | null;
}

/** 选影子库需要的环境信息（Env 和向导里还没入库的环境都满足） */
export interface ShadowSource {
  name: string;
  url: string;
  production: boolean;
  allowSameInstance?: boolean;
  shadowUrl?: string | null;
}

/**
 * 为一个环境准备影子库（共识 4.4）：显式配置的影子库实例用它（调用方已经 claimShadow 过）；
 * 否则用目标实例上的 {原库名}_dowel（没有就建）。生产环境默认不用同一实例（检查会占用生产实例的资源）。
 * 不可用时抛 ShadowError。Shadows.forProject、向导的 SQL 导入、向导的基线验证三处共用这一份，文案只有这一处。
 * `created`：这个影子库是本次调用新建的（向导在平台库写入失败时可以把它删掉）。
 */
export const prepareShadow = async (
  env: ShadowSource,
  schemas: string[] | null,
  guard?: ConnectionGuard,
): Promise<{
  shadow: Shadow;
  label: string;
  url: string;
  created: { targetUrl: string; name: string } | null;
}> => {
  let url = env.shadowUrl ?? null;
  let created: { targetUrl: string; name: string } | null = null;
  if (!url) {
    if (env.production && !env.allowSameInstance)
      throw new ShadowError(
        `环境“${env.name}”是生产环境，默认不在同一实例上建影子库（检查会占用生产实例的资源）。请为它配置单独的影子库实例，或明确允许使用同一实例`,
      );
    // 连不上目标实例 / 建影子库失败是影子库的基础设施故障：在这个边界统一加一次“影子库不可用：”前缀
    // （没有建库权限、拒绝使用这个库之类的配置性文案保持原样）
    const prepared = await ensureSameInstanceShadow(env.url, guard).catch((e: unknown) => {
      throw e instanceof ConnectError ? new ShadowUnavailableError(e.message) : e;
    });
    url = prepared.url;
    if (prepared.created) created = { targetUrl: env.url, name: prepared.shadow };
  }
  return {
    shadow: pgShadow(url, schemas, guard),
    label: `${env.name}：${new URL(url).pathname.slice(1)}`,
    url,
    created,
  };
};

export class Shadows {
  private db: PlatformDb;
  /** 连接前的检查（SSRF 白名单），由 createApp 注入 */
  private guard?: ConnectionGuard;
  /** 环境 ID → 影子库（每个环境一个连接） */
  private cache = new Map<string, { shadow: Shadow; label: string; scope: string }>();

  constructor(db: PlatformDb, guard?: ConnectionGuard) {
    this.db = db;
    this.guard = guard;
  }

  async env(pid: string, eid: string): Promise<Env> {
    const [r] = await this.db.query<{
      id: string;
      name: string;
      url_enc: string;
      production: boolean;
      allow_same_instance: boolean;
      shadow_url_enc: string | null;
      schemas: string[] | null;
    }>(
      `select e.id, e.name, e.url_enc, e.production, e.allow_same_instance, e.shadow_url_enc, p.schemas
         from environments e join projects p on p.id = e.project_id
        where e.id = $1 and e.project_id = $2`,
      [eid, pid],
    );
    if (!r) throw new HTTPException(404, { message: '环境不存在' });
    return {
      id: r.id,
      name: r.name,
      url: decrypt(r.url_enc),
      production: r.production,
      allowSameInstance: r.allow_same_instance,
      shadowUrl: r.shadow_url_enc ? decrypt(r.shadow_url_enc) : null,
      schemas: r.schemas ?? null,
    };
  }

  /** 选影子库：指定了环境用它；没指定用项目的第一个环境；项目没有环境时报错 */
  async forProject(pid: string, eid?: string): Promise<{ shadow: Shadow; label: string }> {
    let id = eid;
    if (!id) {
      const [first] = await this.db.query<{ id: string }>(
        'select id from environments where project_id = $1 order by created_at limit 1',
        [pid],
      );
      if (!first)
        throw new ShadowError(
          '项目还没有配置环境。导入 SQL、验证迁移都需要一个真实的 PostgreSQL 实例作影子库，请先在“环境”里添加项目要部署到的数据库',
        );
      id = first.id;
    }
    const env = await this.env(pid, id);
    // 影子库读结构时按项目的 schema 范围过滤；范围改了要重建连接上的过滤条件（键里带上范围）
    const scope = (env.schemas ?? []).join('\u0000');
    // 每次取影子库都重新过一遍白名单：缓存的连接可能是白名单收紧之前建立的，
    // 已经在用的连接不会自动重连，所以不能只靠连接层的检查（实例设置改严后要立刻生效）
    await this.guard?.(env.url);
    if (env.shadowUrl) await this.guard?.(env.shadowUrl);
    const hit = this.cache.get(id);
    if (hit && hit.scope === scope) return hit;
    if (hit) await this.forget(id);
    const { shadow, label } = await prepareShadow(env, env.schemas, this.guard);
    const entry = { shadow, label, scope };
    this.cache.set(id, entry);
    return entry;
  }

  /** 项目的 schema 范围变了：这个项目下所有环境的影子库过滤条件都要重建 */
  async forgetProject(pid: string) {
    const rows = await this.db.query<{ id: string }>('select id from environments where project_id = $1', [
      pid,
    ]);
    for (const r of rows) await this.forget(r.id);
  }

  async forget(eid: string) {
    const hit = this.cache.get(eid);
    this.cache.delete(eid);
    await hit?.shadow.close();
  }

  /** 测试和排查用：这个环境是否还缓存着影子库连接 */
  has(eid: string): boolean {
    return this.cache.has(eid);
  }

  async close() {
    for (const { shadow } of this.cache.values()) await shadow.close();
    this.cache.clear();
  }
}
