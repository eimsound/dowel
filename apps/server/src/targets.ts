// 连接用户的 PostgreSQL 实例：检查连接、建同实例影子库 {原库名}_dowel、在影子库里执行检查、从线上库读结构。
// 共识 4.4：在目标实例上建影子库（版本、扩展、排序规则与目标一致）；没有可用的影子库就报错，不用任何兜底。
import { createHash } from 'node:crypto';

import type { SchemaInfo, TargetInfo, VerifyReport } from '@dowel/api';
import { ident, literal, type Model } from '@dowel/core';
import { type Db, DOWEL_SCHEMA, fromPostgres, importSnapshot, readSnapshot } from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';
import postgres from 'postgres';

import { maskUrl, scrubSecrets } from './secrets.ts';
import {
  isInfraFailure,
  SHADOW_STATEMENT_TIMEOUT_MS,
  type Shadow,
  ShadowError,
  ShadowUnavailableError,
  shadowOps,
} from './shadow.ts';

/**
 * 和数据库通信失败（连接失败、读取结构失败）。文案不带“影子库不可用：”前缀，
 * 因为同样的函数也服务于目标库（连接检查、从线上库导入）；为影子库服务时，由 prepareShadow（shadows.ts）
 * 统一转成带前缀的 ShadowUnavailableError。
 */
export class ConnectError extends ShadowError {}

/** 影子库准备过程中做的哪一件事：建库、认领已有的库、核对标记（决定失败时的文案） */
export type ShadowSetupStep = 'create' | 'claim' | 'claim-read' | 'check';

/**
 * 建影子库 / 认领影子库 / 核对标记时数据库抛出的原始错误 → ShadowError（发布据此标为“未验证”，而不是返回 500）：
 * - 影子库的问题（isInfraFailure：连接类故障、被取消的 57014、58 类等）→ ShadowUnavailableError，带“影子库不可用：”前缀；
 * - 其他按做的事分文案，都不带这个前缀：
 *   · create：“建影子库失败：…”（CREATE DATABASE 被拒绝、库已存在、模板库被占用……）；
 *   · claim：“认领影子库失败：…”，只有 COMMENT ON DATABASE 这一步报 42501（要求是库的所有者）才说“当前账号不是该库的所有者”；
 *   · claim-read：认领时读目录（核对标记、统计 pg_class）这一步，42501 说“当前账号缺少读取目录的权限”；
 *   · check：“检查影子库失败：…”。
 * 白名单拒绝（HTTPException）和已经是 ShadowError 的原样抛出。消息统一经 scrubSecrets：驱动错误里可能带着连接串。
 */
const pgCode = (e: unknown): string | null => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

export const shadowSetupError = (e: unknown, step: ShadowSetupStep): Error => {
  if (e instanceof HTTPException || e instanceof ShadowError) return e;
  const msg = pgError(e);
  if (isInfraFailure(e)) return new ShadowUnavailableError(msg);
  if (step === 'create') return new ShadowError(`建影子库失败：${msg}`);
  if (step === 'check') return new ShadowError(`检查影子库失败：${msg}`);
  const noPrivilege = pgCode(e) === '42501';
  if (step === 'claim-read')
    return new ShadowError(
      noPrivilege
        ? `认领影子库失败：当前账号缺少读取目录的权限，没法核对这个库是不是空库或已经标记过（${msg}）`
        : `认领影子库失败：${msg}`,
    );
  // 只有 COMMENT ON DATABASE 这一步（要求是库的所有者）报 42501 才说“不是该库的所有者”
  return new ShadowError(
    noPrivilege
      ? `认领影子库失败：当前账号不是该库的所有者，没法给它打 Dowel 影子库标记（${msg}）。请用库的所有者账号，或让 DBA 先建好并标记这个库`
      : `认领影子库失败：${msg}`,
  );
};

/** 影子库标记：只有带这个标记的库才会被清空，防止连接配错时误删业务库 */
export const SHADOW_MARK = 'dowel shadow database (safe to wipe)';

/** 连接检查的超时（秒）：地址可能不可达，不能一直等 */
export const CHECK_CONNECT_TIMEOUT = 5;

/** 建立连接前的检查（SSRF 白名单）；由 createApp 按实例设置注入 */
export type ConnectionGuard = (url: string) => Promise<void>;

/**
 * 连目标库 / 影子库。**所有外部连接都走这里**：`guard` 在第一条语句之前跑一次
 * （postgres.js 是懒连接的，所以签名保持同步，检查推迟到第一次 query / exec）。
 * 这样拉取、影子库、规范化、验证、向导都被同一道检查覆盖到。
 */
export const connectPg = (url: string, connectTimeout = 10, guard?: ConnectionGuard) => {
  const sql = postgres(url, {
    max: 1,
    onnotice: () => {},
    connect_timeout: connectTimeout,
    idle_timeout: 60,
    prepare: false,
  });
  const raw = fromPostgres(sql);
  let checked: Promise<void> | null = null;
  const ensure = () => {
    if (!guard) return null;
    checked ??= guard(url);
    return checked;
  };
  const db: Db = {
    query: async <T>(q: string, params?: unknown[]) => {
      await ensure();
      return raw.query<T>(q, params);
    },
    exec: async (q: string) => {
      await ensure();
      await raw.exec(q);
    },
  };
  return { db, close: () => sql.end({ timeout: 5 }) };
};

/** {原库名}_dowel；超过 63 字节时截断并加短哈希 */
export const shadowDbName = (db: string): string => {
  const full = `${db}_dowel`;
  if (Buffer.byteLength(full) <= 63) return full;
  const hash = createHash('sha256').update(db).digest('hex').slice(0, 8);
  let base = db;
  while (Buffer.byteLength(`${base}_${hash}_dowel`) > 63) base = base.slice(0, -1);
  return `${base}_${hash}_dowel`;
};

const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
};

/** 数据库错误的原始文本 */
const rawError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 数据库错误的文本；驱动 / PG 的错误消息里可能带着连接串，统一遮掉密码 */
const pgError = (e: unknown) => scrubSecrets(rawError(e));

/**
 * 错误信息里不能带密码：连接串本身换成打码后的形式，单独的密码也换掉。
 * （驱动一般不会回显密码，但错误信息里可能拼上用户输入的内容，这里统一洗一遍。）
 */
export const scrubUrl = (message: string, url: string): string => {
  let out = scrubSecrets(message.split(url).join(maskUrl(url)));
  let pw = '';
  try {
    pw = new URL(url).password;
  } catch {
    // 连接串不能用 URL 解析时只做上面的整串替换
  }
  if (!pw) return out;
  out = out.split(pw).join('***');
  try {
    // 解码后的原文也换掉；非法的百分号转义（例如 `p%zz`）解码会抛错，此时上面已经替换过原样的密码
    const decoded = decodeURIComponent(pw);
    if (decoded) out = out.split(decoded).join('***');
  } catch {
    // 忽略
  }
  return out;
};

/** 从 PG server_version（如 "16.4 (Debian 16.4-1.pgdg120+1)" 或 "18.1"）提取简洁版本串 */
export const normalizePgVersion = (raw: string): string => {
  const trimmed = raw.trim();
  const token = trimmed.split(/\s+/)[0];
  return token || trimmed;
};

/** 在已有目标库连接上做基础探测（只读，不建影子库；inspectTarget 与 claims.ts 复用） */
export const inspectTargetOn = async (tdb: Db, url: string): Promise<TargetInfo> => {
  try {
    const [r] = await tdb.query<{
      version: string;
      num: number;
      database: string;
      createdb: boolean;
      currentUser: string;
      superuser: boolean;
      canCreateSchema: boolean;
    }>(
      `select current_setting('server_version') as version, current_setting('server_version_num')::int as num,
              current_database() as database,
              (select rolcreatedb or rolsuper from pg_roles where rolname = current_user) as createdb,
              current_user as "currentUser",
              (select rolsuper from pg_roles where rolname = current_user) as superuser,
              has_database_privilege(current_database(), 'CREATE') as "canCreateSchema"`,
    );
    const shadow = shadowDbName(r!.database);
    const [ex] = await tdb.query<{ n: number }>(
      'select count(*)::int as n from pg_database where datname = $1',
      [shadow],
    );
    // schema 列表：排除系统 schema（pg_*、information_schema）和 dowel，每个带上表数
    const schemas = await tdb.query<SchemaInfo>(
      `select n.nspname as name, count(c.oid)::int as tables
         from pg_namespace n
         left join pg_class c on c.relnamespace = n.oid and c.relkind in ('r', 'p')
        where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and n.nspname <> $1
        group by n.nspname order by n.nspname`,
      [DOWEL_SCHEMA],
    );
    const [dowel] = await tdb.query<{ schema: boolean; meta: boolean }>(
      `select exists(select 1 from pg_namespace where nspname = $1) as schema,
              exists(select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = $1 and c.relname = 'meta' and c.relkind in ('r', 'p')) as meta`,
      [DOWEL_SCHEMA],
    );
    return {
      version: normalizePgVersion(r!.version),
      versionNum: Number(r!.num),
      database: r!.database,
      canCreateDb: r!.createdb,
      shadow,
      shadowExists: ex!.n > 0,
      currentUser: r!.currentUser,
      superuser: r!.superuser,
      canCreateSchema: r!.canCreateSchema,
      schemas,
      dowelSchema: dowel!.schema,
      dowelMeta: dowel!.meta,
    };
  } catch (e) {
    // 白名单等前置检查的 422 不包装成“连接失败”（它本来就不是连接问题）
    if (e instanceof HTTPException) throw e;
    throw new ConnectError(`连接失败：${scrubUrl(rawError(e), url)}`);
  }
};

/** 连接检查：版本、当前用户和权限、schema 列表（带表数）、dowel schema 是否存在。只读，不建影子库。 */
export const inspectTarget = async (
  url: string,
  connectTimeout = CHECK_CONNECT_TIMEOUT,
  guard?: ConnectionGuard,
): Promise<TargetInfo> => {
  const c = connectPg(url, connectTimeout, guard);
  try {
    return await inspectTargetOn(c.db, url);
  } finally {
    await c.close();
  }
};

/** 维护库上同实例影子库生命周期锁（保护 CREATE / claim / DROP 互不干扰）的等待上限（毫秒） */
const SHADOW_LIFECYCLE_LOCK_TIMEOUT_MS = 15_000;

const tryShadowLifecycleLock = async (db: Db, name: string): Promise<boolean> => {
  const [r] = await db.query<{ ok: boolean }>(
    "select pg_try_advisory_lock(hashtext('dowel_shadow_lifecycle'), hashtext($1)) as ok",
    [name],
  );
  return r?.ok === true;
};

const unlockShadowLifecycle = async (db: Db, name: string) => {
  await db
    .query("select pg_advisory_unlock(hashtext('dowel_shadow_lifecycle'), hashtext($1))", [name])
    .catch(() => {});
};

/**
 * 确保目标实例上有影子库（没有就建），返回影子库的连接串。
 * `created` 表示这个库是本次调用新建的（平台库写入失败时可以尝试清理）。
 * 建库与认领受维护库上的会话级 advisory lock 保护；若仍遇到并发建库（42P04 / 23505），
 * 回退到 claimShadow 复用并保持 created = false。
 */
export const ensureSameInstanceShadow = async (
  targetUrl: string,
  guard?: ConnectionGuard,
): Promise<{ url: string; shadow: string; created: boolean }> => {
  const info = await inspectTarget(targetUrl, CHECK_CONNECT_TIMEOUT, guard);
  const url = withDb(targetUrl, info.shadow);
  let created = false;
  const c = connectPg(targetUrl, 10, guard);
  let locked = false;
  try {
    const deadline = Date.now() + SHADOW_LIFECYCLE_LOCK_TIMEOUT_MS;
    while (!(await tryShadowLifecycleLock(c.db, info.shadow))) {
      if (Date.now() > deadline)
        throw new ShadowUnavailableError('影子库正在被其他请求初始化或清理，请稍后再试');
      await new Promise((r) => setTimeout(r, 100));
    }
    locked = true;
    const [ex] = await c.db.query<{ n: number }>(
      'select count(*)::int as n from pg_database where datname = $1',
      [info.shadow],
    );
    if ((ex?.n ?? 0) === 0) {
      if (!info.canCreateDb)
        throw new ShadowError(
          `当前账号没有建库权限。请在目标实例上手动执行：CREATE DATABASE ${ident(info.shadow)} OWNER <Dowel 使用的账号>;`,
        );
      try {
        await c.db.exec(`CREATE DATABASE ${ident(info.shadow)}`);
        created = true;
      } catch (e) {
        const code = pgCode(e);
        // 并发建库（如跨维护库或外部抢先建库）：回退到 claimShadow 复用，不记为本次新建
        if (code !== '42P04' && code !== '23505') throw shadowSetupError(e, 'create');
      }
    }
    await claimShadow(url, guard);
  } catch (e) {
    throw shadowSetupError(e, 'create');
  } finally {
    if (locked) await unlockShadowLifecycle(c.db, info.shadow);
    await c.close().catch(() => {});
  }
  return { url, shadow: info.shadow, created };
};

/**
 * 删掉本次新建的影子库（平台库写入失败等预提交失败时清理用）；尽力而为，绝不强杀并发连接：
 * - 非阻塞获取维护库生命周期锁：若正有其他请求在创建 / 认领 / 清理则安静跳过；
 * - 校验目标库确实带有 SHADOW_MARK，绝不误删非影子库；
 * - 连到影子库用非阻塞 advisory lock 确认当前无人持验证锁，有人在用则安静跳过；
 * - 使用普通 DROP DATABASE IF EXISTS（不带 WITH (FORCE)），遇到 55006（object_in_use）安静跳过。
 */
export const dropSameInstanceShadow = async (targetUrl: string, name: string, guard?: ConnectionGuard) => {
  const c = connectPg(targetUrl, 10, guard);
  let locked = false;
  try {
    if (!(await tryShadowLifecycleLock(c.db, name))) return;
    locked = true;
    const [row] = await c.db.query<{ c: string | null }>(
      "select shobj_description(oid, 'pg_database') as c from pg_database where datname = $1",
      [name],
    );
    if (!row || row.c !== SHADOW_MARK) return;

    const probe = connectPg(withDb(targetUrl, name), CHECK_CONNECT_TIMEOUT, guard);
    let probeLocked = false;
    try {
      const [lk] = await probe.db.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext('dowel_shadow')) as ok",
      );
      if (!lk?.ok) return;
      probeLocked = true;
      if (!(await isMarked(probe.db))) return;
    } catch (e) {
      if (pgCode(e) === '3D000') return;
      console.error('清理影子库前检查失败，跳过删除', name, pgError(e));
      return;
    } finally {
      if (probeLocked)
        await probe.db.query("select pg_advisory_unlock(hashtext('dowel_shadow'))").catch(() => {});
      await probe.close().catch(() => {});
    }

    await c.db.exec(`DROP DATABASE IF EXISTS ${ident(name)}`);
  } catch (e) {
    if (pgCode(e) === '55006') return;
    console.error('清理影子库失败', name, pgError(e));
  } finally {
    if (locked) await unlockShadowLifecycle(c.db, name);
    await c.close().catch(() => {});
  }
};

/** 给影子库打标记：已有标记直接通过；没有标记的库只有在是空库时才打标记，否则拒绝 */
export const claimShadow = async (url: string, guard?: ConnectionGuard) => {
  const c = connectPg(url, CHECK_CONNECT_TIMEOUT, guard);
  // 出错时区分是哪一步：读目录（核对标记、统计 pg_class）缺权限，和 COMMENT ON DATABASE 不是所有者，提示不一样
  let phase: ShadowSetupStep = 'claim-read';
  try {
    if (await isMarked(c.db)) return;
    const [r] = await c.db.query<{ n: number }>(
      `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`,
    );
    if (r!.n > 0)
      throw new ShadowError(
        '拒绝使用这个库作影子库：它不是空库，也没有 Dowel 影子库标记。影子库每次检查前都会被清空',
      );
    const [d] = await c.db.query<{ d: string }>('select current_database() as d');
    phase = 'claim';
    try {
      await c.db.exec(`COMMENT ON DATABASE ${ident(d!.d)} IS ${literal(SHADOW_MARK)}`);
    } catch (e) {
      if (pgCode(e) === 'XX000' && (await isMarked(c.db).catch(() => false))) return;
      throw e;
    }
  } catch (e) {
    throw shadowSetupError(e, phase);
  } finally {
    await c.close();
  }
};

const isMarked = async (db: Db) => {
  const [r] = await db.query<{ c: string | null }>(
    `select shobj_description(oid, 'pg_database') as c from pg_database where datname = current_database()`,
  );
  return r?.c === SHADOW_MARK;
};

/** 真实实例上的影子库：一个连接，请求串行；每次检查用 advisory lock 与其他 Dowel 进程互斥，并再次核对标记 */
export const pgShadow = (shadowUrl: string, schemas?: string[] | null, guard?: ConnectionGuard): Shadow => {
  let conn: ReturnType<typeof connectPg> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  // 丢掉常驻连接：先关掉再置空。只写 conn = null 的话旧连接还活着，挂在它上面的 advisory lock 不会释放，
  // 下一次检查会一直等到“被占用”超时
  const discard = async () => {
    const old = conn;
    conn = null;
    await old?.close().catch(() => {});
  };
  const run = <T>(fn: (ops: ReturnType<typeof shadowOps>) => Promise<T>): Promise<T> => {
    const p = queue.then(async () => {
      conn ??= connectPg(shadowUrl, 10, guard);
      const db = conn.db;
      try {
        await db.exec(
          `SET lock_timeout = '10s'; SET statement_timeout = '${SHADOW_STATEMENT_TIMEOUT_MS / 1000}s'`,
        );
        const deadline = Date.now() + 60_000;
        while (
          !(
            await db.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext('dowel_shadow')) as ok")
          )[0]!.ok
        ) {
          if (Date.now() > deadline) throw new ShadowUnavailableError('正被其他检查占用，请稍后再试');
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (e) {
        await discard();
        throw e instanceof ShadowError ? e : new ShadowUnavailableError(`连接失败：${pgError(e)}`);
      }
      // 执行阶段：fn 正常返回才算连接是干净的；它抛错（或者解锁失败）时连接可能停在中止的事务里、
      // 锁也可能还挂着，一律丢掉这条连接（关掉就会释放锁），下一次检查用新连接
      let clean = false;
      try {
        if (!(await isMarked(db).catch((e) => Promise.reject(shadowSetupError(e, 'check')))))
          throw new ShadowError('拒绝执行：影子库的 Dowel 标记不见了');
        const result = await fn(shadowOps(async () => db, schemas));
        clean = true;
        return result;
      } finally {
        const unlocked = await db
          .query<{ ok: boolean }>("select pg_advisory_unlock(hashtext('dowel_shadow')) as ok")
          .then(
            (rows) => rows[0]?.ok === true,
            () => false,
          );
        if (!clean || !unlocked) await discard();
      }
    });
    queue = p.catch(() => {});
    return p;
  };
  return {
    importSql: (sql) => run((ops) => ops.importSql(sql)),
    verify: (from, to, opts): Promise<VerifyReport> => run((ops) => ops.verify(from, to, opts)),
    verifyScripts: (from, to, up, down, options): Promise<VerifyReport> =>
      run((ops) => ops.verifyScripts(from, to, up, down, options)),
    canonicalize: (prev, next) => run((ops) => ops.canonicalize(prev, next)),
    close: async () => {
      await conn?.close();
      conn = null;
    },
  };
};

/** 从线上库读结构（只读：只执行 SET 和 SELECT），只读 schema 范围内的（dowel 永远排除） */
export const pullSchema = async (
  url: string,
  schemas?: string[] | null,
  guard?: ConnectionGuard,
): Promise<Model> => {
  const c = connectPg(url, CHECK_CONNECT_TIMEOUT, guard);
  try {
    return importSnapshot(await readSnapshot(c.db, schemas));
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    throw new ConnectError(`读取结构失败：${scrubUrl(rawError(e), url)}`);
  } finally {
    await c.close();
  }
};
