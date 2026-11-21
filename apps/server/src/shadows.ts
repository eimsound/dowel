// 为一次检查选影子库（共识 4.4）：
//   - 不需要外部影子库的方言（SQLite）：直接使用进程内 `:memory:` 影子库，免环境配置；
//   - 需要外部影子库的方言（PG / MySQL / MSSQL）：
//     1. 环境里显式配置的影子库实例；
//     2. 默认：目标实例上的 {原库名}_dowel（生产环境需要明确同意才用同一实例）。
import { createHash } from 'node:crypto';

import { type Dialect, deriveTargetPgMajor, getDialect, pgMajorOf } from '@dowel/core';
import { HTTPException } from 'hono/http-exception';

import type { ClusterEvent, ClusterEventPayload, EventBus } from './bus.ts';
import type { PlatformDb } from './db.ts';
import { decrypt, scrubSecrets } from './secrets.ts';
import { type Shadow, ShadowError, ShadowUnavailableError } from './shadow.ts';
import {
  type ConnectionGuard,
  getTargetDriver,
  type PreparedShadow,
  type ShadowSource,
  sqliteMemoryShadow,
} from './targets.ts';

export type { ShadowSource };

export interface Env {
  id: string;
  name: string;
  dialect: Dialect;
  url: string;
  production: boolean;
  allowSameInstance: boolean;
  shadowUrl: string | null;
  /** 项目的 schema 范围（null 表示全部，dowel 永远排除） */
  schemas: string[] | null;
  /** 目标库版本号数值（尚未探测为 null） */
  engineVersionNum: number | null;
  /** 目标库 PG 大版本（仅 PG；尚未探测或非 PG 为 null） */
  engineMajor: number | null;
}

export interface VersionShadowEntry {
  /** 该代表影子库对应的 PG 大版本号；未探测版本时为 null */
  major: number | null;
  envId: string;
  shadow: Shadow;
  label: string;
}

export interface SkippedMajorEntry {
  major: number | null;
  reason: string;
}

export interface ProjectVersionShadows {
  /** 按大版本升序排列（已知大版本在前，null 在后），每个大版本至多 1 个代表影子库 */
  entries: VersionShadowEntry[];
  /** 无法获取可用影子库的大版本及其首个失败原因 */
  skippedMajors: SkippedMajorEntry[];
  /** 项目所有环境推导出的最低目标 PG 大版本（仅已知版本） */
  targetPgMajor: number | null;
  /** 项目所有环境去重升序的已知 PG 大版本 */
  envPgMajors: number[];
}

/**
 * 为一个环境准备影子库（共识 4.4）：按方言分派到对应目标库驱动。
 * SQLite 直接返回 `:memory:` 影子库（env 可为 null）；PG 等外部库优先用显式 shadowUrl，否则建同实例 `{原库名}_dowel`。
 */
export const prepareShadow = async (
  env: ShadowSource | null,
  schemas: string[] | null,
  guard?: ConnectionGuard,
  dialect: Dialect = 'pg',
): Promise<PreparedShadow> => getTargetDriver(dialect).prepareShadow(env, schemas, guard);

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
        engineVersionNum: env.engineVersionNum,
      }),
    )
    .digest('hex');

/** 同大版本内候选环境选影优先级：显式 shadowUrl(0) > 非生产(1) > 允许同实例生产(2) > 其余(3) */
const candidatePriority = (r: {
  shadow_url_enc: string | null;
  production: boolean;
  allow_same_instance: boolean;
}): number => {
  if (r.shadow_url_enc) return 0;
  if (!r.production) return 1;
  if (r.allow_same_instance) return 2;
  return 3;
};

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
      dialect: Dialect;
      url_enc: string;
      production: boolean;
      allow_same_instance: boolean;
      shadow_url_enc: string | null;
      schemas: string[] | null;
      engine_version_num: number | null;
    }>(
      `select e.id, e.name, p.dialect, e.url_enc, e.production, e.allow_same_instance, e.shadow_url_enc, p.schemas,
              e.engine_version_num
         from environments e join projects p on p.id = e.project_id
        where e.id = $1 and e.project_id = $2`,
      [eid, pid],
    );
    if (!r) throw new HTTPException(404, { message: '环境不存在' });
    const engineVersionNum = r.engine_version_num ?? null;
    return {
      id: r.id,
      name: r.name,
      dialect: r.dialect,
      url: decrypt(r.url_enc),
      production: r.production,
      allowSameInstance: r.allow_same_instance,
      shadowUrl: r.shadow_url_enc ? decrypt(r.shadow_url_enc) : null,
      schemas: r.schemas ?? null,
      engineVersionNum,
      engineMajor: r.dialect === 'pg' ? pgMajorOf(engineVersionNum) : null,
    };
  }

  private async projectDialect(pid: string): Promise<Dialect> {
    const [p] = await this.db.query<{ dialect: Dialect }>('select dialect from projects where id = $1', [
      pid,
    ]);
    return p?.dialect ?? 'pg';
  }

  /** 选影子库：SQLite 直接用内存影子库（无需环境）；PG 等指定了环境用它，没指定用项目的第一个环境 */
  async forProject(pid: string, eid?: string): Promise<{ shadow: Shadow; label: string }> {
    const dialect = await this.projectDialect(pid);
    if (!getDialect(dialect).capabilities.requiresExternalShadow) {
      return { shadow: sqliteMemoryShadow(), label: 'SQLite :memory:' };
    }
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
            '项目还没有配置环境。导入 SQL、验证迁移都需要一个真实的数据库实例作影子库，请先在“环境”里添加项目要部署到的数据库',
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

      const { shadow, label } = await prepareShadow(env, env.schemas, this.guard, env.dialect);

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

  /**
   * 按项目全部环境的 PG 大版本分组（去重升序，未知版本归为 null 组），为每个大版本选出 1 个代表影子库：
   * 优先级：显式 shadowUrl > 非生产环境 > 允许同实例的生产环境；该大版本全部不可用时记入 skippedMajors。
   * 兼容测试中直接覆写实例级 `forProject` 的场景。
   */
  async forProjectVersions(pid: string): Promise<ProjectVersionShadows> {
    if (this.forProject !== Shadows.prototype.forProject) {
      const s = await this.forProject(pid);
      return {
        entries: [{ major: null, envId: '', shadow: s.shadow, label: s.label }],
        skippedMajors: [],
        targetPgMajor: null,
        envPgMajors: [],
      };
    }

    const dialect = await this.projectDialect(pid);
    if (!getDialect(dialect).capabilities.requiresExternalShadow) {
      return {
        entries: [{ major: null, envId: '', shadow: sqliteMemoryShadow(), label: 'SQLite :memory:' }],
        skippedMajors: [],
        targetPgMajor: null,
        envPgMajors: [],
      };
    }

    const rows = await this.db.query<{
      id: string;
      production: boolean;
      allow_same_instance: boolean;
      shadow_url_enc: string | null;
      engine_version_num: number | null;
    }>(
      `select id, production, allow_same_instance, shadow_url_enc, engine_version_num
         from environments where project_id = $1 order by created_at`,
      [pid],
    );
    const liveIds = new Set(rows.map((r) => r.id));
    await this.pruneRemovedForProject(pid, liveIds);
    if (!rows.length) {
      throw new ShadowError(
        '项目还没有配置环境。导入 SQL、验证迁移都需要一个真实的数据库实例作影子库，请先在“环境”里添加项目要部署到的数据库',
      );
    }

    const groups = new Map<number | null, typeof rows>();
    const knownMajors = new Set<number>();
    for (const r of rows) {
      const major = dialect === 'pg' ? pgMajorOf(r.engine_version_num) : null;
      if (major !== null) knownMajors.add(major);
      const list = groups.get(major);
      if (list) list.push(r);
      else groups.set(major, [r]);
    }
    const envPgMajors = [...knownMajors].sort((a, b) => a - b);
    const targetPgMajor = deriveTargetPgMajor(envPgMajors);
    const orderedKeys: (number | null)[] = [...envPgMajors, ...(groups.has(null) ? [null] : [])];

    const entries: VersionShadowEntry[] = [];
    const skippedMajors: SkippedMajorEntry[] = [];
    for (const major of orderedKeys) {
      const candidates = [...(groups.get(major) ?? [])].sort(
        (a, b) => candidatePriority(a) - candidatePriority(b),
      );
      let picked = false;
      let firstReason = '没有可用的影子库';
      for (const cand of candidates) {
        try {
          const s = await this.forProject(pid, cand.id);
          entries.push({ major, envId: cand.id, shadow: s.shadow, label: s.label });
          picked = true;
          break;
        } catch (e) {
          if (!(e instanceof ShadowError)) throw e;
          if (firstReason === '没有可用的影子库') firstReason = scrubSecrets(e.message);
        }
      }
      if (!picked) {
        skippedMajors.push({ major, reason: firstReason });
      }
    }

    return { entries, skippedMajors, targetPgMajor, envPgMajors };
  }

  /**
   * 为 OpaqueRefresher 等单影子库派生场景选影：优先选择 `engineMajor === targetPgMajor` 的可用环境影子库，
   * 若无可用则回退到首个可用环境影子库。
   */
  async forProjectTarget(pid: string): Promise<{ shadow: Shadow; label: string }> {
    const res = await this.forProjectVersions(pid);
    if (res.targetPgMajor !== null) {
      const exact = res.entries.find((e) => e.major === res.targetPgMajor);
      if (exact) return { shadow: exact.shadow, label: exact.label };
    }
    const first = res.entries[0];
    if (first) return { shadow: first.shadow, label: first.label };
    throw new ShadowError(res.skippedMajors[0]?.reason ?? '没有可用的影子库');
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
