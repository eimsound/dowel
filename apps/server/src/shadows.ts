// 为一次检查选影子库（共识 4.4）：影子库必须是真实的 PostgreSQL 实例，没有兜底。
//   1. 环境里显式配置的影子库实例；
//   2. 默认：目标实例上的 {原库名}_dowel（生产环境需要明确同意才用同一实例）；
//   项目没有环境、或影子库不可用时直接报错。
import { createHash } from 'node:crypto';

import { HTTPException } from 'hono/http-exception';

import type { ClusterEvent, ClusterEventPayload, EventBus } from './bus.ts';
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

interface CacheEntry {
  shadow: Shadow;
  label: string;
  projectId: string;
  /** 环境影子库配置的完整 SHA-256 指纹（不保存明文连接串） */
  fingerprint: string;
}

/** 构造期间遇到并发失效时的最大重试次数 */
const MAX_PREPARE_ATTEMPTS = 3;

const configFingerprint = (env: Env): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        name: env.name,
        url: env.url,
        shadowUrl: env.shadowUrl,
        production: env.production,
        allowSameInstance: env.allowSameInstance,
        schemas: env.schemas ?? [],
      }),
    )
    .digest('hex');

export class Shadows {
  private db: PlatformDb;
  /** 连接前的检查（SSRF 白名单），由 createApp 注入 */
  private guard?: ConnectionGuard;
  private bus?: EventBus;
  private unsubBus: (() => void)[] = [];
  /** 环境 ID → 影子库（每个环境一个连接） */
  private cache = new Map<string, CacheEntry>();
  /** 失效代际计数：每次外部失效 / 重连 / 关闭时递增，防止并发 prepareShadow 把旧配置句柄回写缓存 */
  private invalidationGen = 0;
  private closed = false;

  constructor(db: PlatformDb, guard?: ConnectionGuard, bus?: EventBus) {
    this.db = db;
    this.guard = guard;
    this.bus = bus;
    if (bus) {
      this.unsubBus.push(
        bus.onEvent((event) => this.handleClusterEvent(event)),
        bus.onReconnect(() => this.handleBusReconnect()),
      );
    }
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
    for (let attempt = 0; attempt < MAX_PREPARE_ATTEMPTS; attempt++) {
      let id = eid;
      if (!id) {
        const rows = await this.db.query<{ id: string }>(
          'select id from environments where project_id = $1 order by created_at',
          [pid],
        );
        const liveIds = new Set(rows.map((r) => r.id));
        await this.pruneRemovedForProject(pid, liveIds);
        const first = rows[0];
        if (!first)
          throw new ShadowError(
            '项目还没有配置环境。导入 SQL、验证迁移都需要一个真实的 PostgreSQL 实例作影子库，请先在“环境”里添加项目要部署到的数据库',
          );
        id = first.id;
      }

      const gen = this.invalidationGen;
      let env: Env;
      try {
        env = await this.env(pid, id);
      } catch (e) {
        if (e instanceof HTTPException && e.status === 404 && this.cache.has(id)) {
          await this.forgetLocal(id);
        }
        throw e;
      }

      // 每次取影子库都重新过一遍白名单：缓存的连接可能是白名单收紧之前建立的，
      // 已经在用的连接不会自动重连，所以不能只靠连接层的检查（实例设置改严后要立刻生效）
      try {
        await this.guard?.(env.url);
        if (env.shadowUrl) await this.guard?.(env.shadowUrl);
      } catch (e) {
        if (this.cache.has(id)) await this.forgetLocal(id);
        throw e;
      }

      // 完整配置指纹校验：schema 范围、连接串、独立影子库、生产标记、允许同实例任一变更都必须淘汰旧连接
      const fingerprint = configFingerprint(env);
      const hit = this.cache.get(id);
      if (hit && hit.projectId === pid && hit.fingerprint === fingerprint) return hit;
      if (hit) await this.forgetLocal(id, false);

      const { shadow, label } = await prepareShadow(env, env.schemas, this.guard);

      if (this.closed) {
        await shadow.close().catch(() => {});
        throw new ShadowUnavailableError('服务正在关闭');
      }

      // prepareShadow 期间如果收到了外部失效/重连事件，复核最新配置再决定是否入缓存，避免旧配置句柄复活
      if (this.invalidationGen !== gen) {
        let latest: Env;
        try {
          latest = await this.env(pid, id);
          await this.guard?.(latest.url);
          if (latest.shadowUrl) await this.guard?.(latest.shadowUrl);
        } catch (e) {
          await shadow.close().catch(() => {});
          if (e instanceof HTTPException && e.status === 404 && this.cache.has(id)) {
            await this.forgetLocal(id);
          }
          throw e;
        }
        if (configFingerprint(latest) !== fingerprint) {
          await shadow.close().catch(() => {});
          continue;
        }
      }

      const existing = this.cache.get(id);
      if (existing) {
        if (existing.projectId === pid && existing.fingerprint === fingerprint) {
          await shadow.close().catch(() => {});
          return existing;
        }
        await this.forgetLocal(id, false);
      }

      const entry: CacheEntry = { shadow, label, projectId: pid, fingerprint };
      this.cache.set(id, entry);
      return entry;
    }

    throw new ShadowUnavailableError('影子库配置已变更，请重试');
  }

  /** 项目的 schema 范围变了或项目被删除：关闭并移除该项目下所有环境的影子库缓存，并广播给其他副本 */
  async forgetProject(pid: string) {
    const envIds = await this.forgetProjectLocal(pid);
    await this.publish({
      t: 'shadows.forget',
      projectId: pid,
      ...(envIds.length ? { envIds } : {}),
    });
  }

  /** 关闭并移除指定环境的影子库缓存，并广播给其他副本 */
  async forget(eid: string) {
    await this.forgetLocal(eid);
    await this.publish({ t: 'shadows.forget', envIds: [eid] });
  }

  /** 测试和排查用：这个环境是否还缓存着影子库连接 */
  has(eid: string): boolean {
    return this.cache.has(eid);
  }

  /** 测试和排查用：当前缓存中的影子库连接数 */
  get size(): number {
    return this.cache.size;
  }

  async close() {
    this.closed = true;
    for (const off of this.unsubBus) off();
    this.unsubBus = [];
    await this.clearLocal();
  }

  private async publish(event: ClusterEventPayload) {
    if (!this.bus) return;
    try {
      await this.bus.publish(event);
    } catch (e) {
      console.error(`发布影子库缓存失效事件失败（t=${event.t}）`, e);
    }
  }

  private async handleClusterEvent(event: ClusterEvent) {
    if (!this.bus || event.origin === this.bus.replicaId) return;
    if (event.t !== 'shadows.forget') return;
    if (event.all) {
      await this.clearLocal();
      return;
    }
    if (event.projectId) {
      await this.forgetProjectLocal(event.projectId, false);
    }
    if (event.envIds?.length) {
      for (const eid of event.envIds) {
        await this.forgetLocal(eid);
      }
    }
  }

  private async handleBusReconnect() {
    await this.clearLocal();
  }

  private async forgetLocal(eid: string, bump = true) {
    if (bump) this.invalidationGen++;
    const hit = this.cache.get(eid);
    this.cache.delete(eid);
    if (hit) {
      await hit.shadow.close().catch((e) => {
        console.error(`关闭影子库连接失败（env=${eid}）`, e);
      });
    }
  }

  private async forgetProjectLocal(pid: string, queryDb = true): Promise<string[]> {
    this.invalidationGen++;
    const ids = new Set<string>();
    for (const [eid, entry] of this.cache.entries()) {
      if (entry.projectId === pid) ids.add(eid);
    }
    if (queryDb) {
      const rows = await this.db
        .query<{ id: string }>('select id from environments where project_id = $1', [pid])
        .catch(() => []);
      for (const r of rows) ids.add(r.id);
    }
    for (const eid of ids) {
      await this.forgetLocal(eid, false);
    }
    return [...ids];
  }

  private async pruneRemovedForProject(pid: string, liveIds: Set<string>) {
    const staleIds: string[] = [];
    for (const [eid, entry] of this.cache.entries()) {
      if (entry.projectId === pid && !liveIds.has(eid)) staleIds.push(eid);
    }
    for (const eid of staleIds) {
      await this.forgetLocal(eid);
    }
  }

  private async clearLocal() {
    this.invalidationGen++;
    const entries = [...this.cache.entries()];
    this.cache.clear();
    await Promise.all(
      entries.map(([eid, entry]) =>
        entry.shadow.close().catch((e) => {
          console.error(`关闭影子库连接失败（env=${eid}）`, e);
        }),
      ),
    );
  }
}
