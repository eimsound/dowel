// 为一次检查选影子库（共识 4.4）：
//   - 不需要外部影子库的方言（SQLite）：直接使用进程内 `:memory:` 影子库，免环境配置；
//   - 需要外部影子库的方言（PG / MySQL / MSSQL）：
//     1. 环境里显式配置的影子库实例；
//     2. 默认：目标实例上的 {原库名}_dowel（生产环境需要明确同意才用同一实例）。
import { createHash } from 'node:crypto';

import type { ShadowConfigState } from '@dowel/api';
import { type Dialect, getDialect, publicMajorOf } from '@dowel/core';
import { HTTPException } from 'hono/http-exception';

import type { ClusterEvent, ClusterEventPayload, EventBus } from './bus.ts';
import type { PlatformDb } from './db.ts';
import { decrypt, scrubSecrets } from './secrets.ts';
import { type Shadow, ShadowConfigChangedError, ShadowError, ShadowUnavailableError } from './shadow.ts';
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
  /** 目标库对外大版本（core publicMajorOf：仅 PG 有值；尚未探测或非 PG 为 null） */
  engineMajor: number | null;
}

export interface VersionShadowEntry {
  /** 该代表影子库所在的版本组（DialectVersionMatrix.groupKeyOf，如 PG 16、MySQL 804）；不分组的方言或未探测版本为 null */
  groupKey: number | null;
  envId: string;
  shadow: Shadow;
  label: string;
}

export interface SkippedVersionGroup {
  /** 没有可用影子库的版本组（同 VersionShadowEntry.groupKey） */
  groupKey: number | null;
  reason: string;
}

export interface ProjectVersionShadows {
  /** 按版本组升序排列（已知版本组在前，null 在后），每个版本组至多 1 个代表影子库 */
  entries: VersionShadowEntry[];
  /** 无法获取可用影子库的版本组及其首个失败原因 */
  skippedGroups: SkippedVersionGroup[];
  /** 项目最低目标版本组（已知版本组的最小键；不分组的方言或无已探测环境为 null） */
  targetGroupKey: number | null;
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

/** 同版本组内候选环境选影优先级：显式 shadowUrl(0) > 非生产(1) > 允许同实例生产(2) > 其余(3) */
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
      engineMajor: publicMajorOf(r.dialect, engineVersionNum),
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
            { preConnect: true },
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
      if (this.closed) throw new ShadowUnavailableError('服务正在关闭');

      const { shadow, label } = await prepareShadow(env, env.schemas, this.guard, env.dialect);
      const entry = await this.admit(pid, id, gen, { shadow, label, projectId: pid, fingerprint });
      if (entry) return entry;
    }

    throw new ShadowConfigChangedError();
  }

  /**
   * 把刚建好的句柄放进缓存，或者判定它已经过期（Issue #154）。**每一次 await 之后**都重新检查 `closed`
   * 与失效代际：复核最新配置、关掉缓存里过期的条目都要 await，期间可能又来一次失效事件或 `Shadows.close()`，
   * 只在 await 之前查过一次就会把旧配置句柄、或关闭之后建出的句柄放进缓存（没人负责关闭、拖住停机）。
   * - 返回缓存条目（刚放进去的，或缓存里已有的、与最新配置一致的那个——此时关掉自己建的）；
   * - 返回 null：自己建的句柄相对最新配置已过期，已关闭，由 forProject 重试；
   * - 服务关闭、复核时读配置 / 白名单失败：关掉自己建的句柄并抛错。
   */
  private async admit(pid: string, id: string, gen: number, entry: CacheEntry): Promise<CacheEntry | null> {
    const drop = () => entry.shadow.close().catch(() => {});
    let checked = gen;
    for (let round = 0; ; round++) {
      if (this.closed) {
        await drop();
        throw new ShadowUnavailableError('服务正在关闭');
      }
      const existing = this.cache.get(id);
      if (existing && existing.projectId === pid && existing.fingerprint === entry.fingerprint) {
        await drop();
        return existing;
      }
      // 期间收到过外部失效 / 重连事件，或缓存里出现了别的配置的条目（谁的配置才是最新的不知道）：复核最新配置
      if (this.invalidationGen !== checked || existing) {
        if (round >= MAX_PREPARE_ATTEMPTS) {
          await drop();
          throw new ShadowConfigChangedError();
        }
        checked = this.invalidationGen;
        let latest: string;
        try {
          const env = await this.env(pid, id);
          await this.guard?.(env.url);
          if (env.shadowUrl) await this.guard?.(env.shadowUrl);
          latest = configFingerprint(env);
        } catch (e) {
          await drop();
          if (e instanceof HTTPException && e.status === 404 && this.cache.has(id)) {
            await this.forgetLocal(id);
          }
          throw e;
        }
        if (latest !== entry.fingerprint) {
          // 自己建的是旧配置：关掉重来（缓存里若是按最新配置建的条目，重试时直接命中它，不会误关）
          await drop();
          return null;
        }
        // 自己的配置就是最新的，缓存里的条目才过期：关掉它，然后回到循环开头重新检查（关闭期间又可能有新事件）
        const stale = this.cache.get(id);
        if (stale && (stale.projectId !== pid || stale.fingerprint !== entry.fingerprint)) {
          await this.forgetLocal(id, false);
        }
        continue;
      }
      this.cache.set(id, entry);
      return entry;
    }
  }

  /**
   * 按项目全部环境的版本组分组（DialectVersionMatrix.groupKeyOf；去重升序，未知版本归为 null 组），为每个版本组选出 1 个代表影子库：
   * 优先级：显式 shadowUrl > 非生产环境 > 允许同实例的生产环境；该版本组全部不可用时记入 skippedGroups。
   * 兼容测试中直接覆写实例级 `forProject` 的场景。
   */
  async forProjectVersions(pid: string): Promise<ProjectVersionShadows> {
    if (this.forProject !== Shadows.prototype.forProject) {
      const s = await this.forProject(pid);
      return {
        entries: [{ groupKey: null, envId: '', shadow: s.shadow, label: s.label }],
        skippedGroups: [],
        targetGroupKey: null,
      };
    }

    const spec = getDialect(await this.projectDialect(pid));
    if (!spec.capabilities.requiresExternalShadow) {
      return {
        entries: [{ groupKey: null, envId: '', shadow: sqliteMemoryShadow(), label: 'SQLite :memory:' }],
        skippedGroups: [],
        targetGroupKey: null,
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
        { preConnect: true },
      );
    }

    const groups = new Map<number | null, typeof rows>();
    const knownKeys = new Set<number>();
    for (const r of rows) {
      const key = spec.versioning.matrix?.groupKeyOf(r.engine_version_num) ?? null;
      if (key !== null) knownKeys.add(key);
      const list = groups.get(key);
      if (list) list.push(r);
      else groups.set(key, [r]);
    }
    const sortedKnownKeys = [...knownKeys].sort((a, b) => a - b);
    // 最低已知版本组即项目兼容目标（PG 最低大版本、MySQL 最低主次版本）
    const targetGroupKey = sortedKnownKeys[0] ?? null;
    const orderedKeys: (number | null)[] = [...sortedKnownKeys, ...(groups.has(null) ? [null] : [])];

    const entries: VersionShadowEntry[] = [];
    const skippedGroups: SkippedVersionGroup[] = [];
    for (const groupKey of orderedKeys) {
      const candidates = [...(groups.get(groupKey) ?? [])].sort(
        (a, b) => candidatePriority(a) - candidatePriority(b),
      );
      let picked = false;
      let firstReason = '没有可用的影子库';
      for (const cand of candidates) {
        try {
          const s = await this.forProject(pid, cand.id);
          entries.push({
            groupKey,
            envId: cand.id,
            shadow: s.shadow,
            label: s.label,
          });
          picked = true;
          break;
        } catch (e) {
          // 配置已变更是可重试的暂时状态：整体重试，不能把这个版本组当成“没有可用影子库”跳过
          if (!(e instanceof ShadowError) || e instanceof ShadowConfigChangedError) throw e;
          if (firstReason === '没有可用的影子库') firstReason = scrubSecrets(e.message);
        }
      }
      if (!picked) {
        skippedGroups.push({ groupKey, reason: firstReason });
      }
    }

    return { entries, skippedGroups, targetGroupKey };
  }

  /**
   * 为 OpaqueRefresher 等单影子库派生场景选影：优先选择最低目标版本组（`groupKey === targetGroupKey`）的可用环境影子库，
   * 若无可用则回退到首个可用环境影子库。
   */
  async forProjectTarget(pid: string): Promise<{ shadow: Shadow; label: string }> {
    const res = await this.forProjectVersions(pid);
    if (res.targetGroupKey !== null) {
      const exact = res.entries.find((e) => e.groupKey === res.targetGroupKey);
      if (exact) return { shadow: exact.shadow, label: exact.label };
    }
    const first = res.entries[0];
    if (first) return { shadow: first.shadow, label: first.label };
    throw new ShadowError(res.skippedGroups[0]?.reason ?? '没有可用的影子库');
  }

  /**
   * 影子库的配置状态（纯平台库查询，不建任何影子库连接）：
   * - memory：不需要外部影子库的方言（SQLite 进程内 `:memory:`）；
   * - none：没有环境，或所有环境都是“生产且不允许同实例、也没配独立影子库”（candidatePriority 3）；
   * - configured：至少有一个可用的影子库来源（连不连得上要真正连了才知道）。
   */
  async configState(pid: string): Promise<ShadowConfigState> {
    const dialect = await this.projectDialect(pid);
    if (!getDialect(dialect).capabilities.requiresExternalShadow) return 'memory';
    const rows = await this.db.query<{
      production: boolean;
      allow_same_instance: boolean;
      shadow_url_enc: string | null;
    }>('select production, allow_same_instance, shadow_url_enc from environments where project_id = $1', [
      pid,
    ]);
    return rows.some((r) => candidatePriority(r) < 3) ? 'configured' : 'none';
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
    // 同步递增代际：事件到达时还在 prepareShadow 的 forProject 会复核最新配置再决定是否入缓存
    this.invalidationGen++;
    const ids = new Set(event.envIds ?? []);
    if (event.projectId) {
      for (const [eid, entry] of this.cache.entries()) {
        if (entry.projectId === event.projectId) ids.add(eid);
      }
    }
    for (const eid of ids) {
      await this.revalidateLocal(eid);
    }
  }

  /**
   * 远端失效事件 → 按平台库里的最新配置复核本地缓存条目：指纹一致说明本副本已经按变更后的配置重建过
   * （事件比本副本的下一次 forProject 晚到），保留它，不要关掉一个正在用的新连接；指纹不一致、环境 / 项目已删除、
   * 或者读配置失败，都按原来的做法关闭并移除。复核期间条目被并发替换，就复核新条目。
   */
  private async revalidateLocal(eid: string) {
    for (;;) {
      const hit = this.cache.get(eid);
      if (!hit) return;
      let fingerprint: string | null;
      try {
        fingerprint = configFingerprint(await this.env(hit.projectId, eid));
      } catch {
        fingerprint = null;
      }
      if (this.cache.get(eid) !== hit) continue;
      if (fingerprint !== hit.fingerprint) await this.forgetLocal(eid, false);
      return;
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

  private async forgetProjectLocal(pid: string): Promise<string[]> {
    this.invalidationGen++;
    const ids = new Set<string>();
    for (const [eid, entry] of this.cache.entries()) {
      if (entry.projectId === pid) ids.add(eid);
    }
    const rows = await this.db
      .query<{ id: string }>('select id from environments where project_id = $1', [pid])
      .catch(() => []);
    for (const r of rows) ids.add(r.id);
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
