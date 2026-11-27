// PostgreSQL 服务端目标库驱动：连接、探测、同实例影子库、拉取结构。
import { createHash } from 'node:crypto';

import type { SchemaInfo, TargetInfo, VerifyReport } from '@dowel/api';
import { ident, literal, type Model } from '@dowel/core';
import { type Db, DOWEL_SCHEMA, fromPostgres, importSnapshot, readSnapshot } from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';
import postgres from 'postgres';

import { maskUrl, scrubSecrets } from '../secrets.ts';
import {
  isInfraFailure,
  SHADOW_STATEMENT_TIMEOUT_MS,
  type Shadow,
  ShadowError,
  ShadowUnavailableError,
  shadowOps,
} from '../shadow.ts';
import { serialShadowConnection } from './shadow-handle.ts';
import {
  CHECK_CONNECT_TIMEOUT,
  ConnectError,
  type ConnectionGuard,
  type PreparedShadow,
  SHADOW_MARK,
  type ShadowSource,
  type TargetConnection,
  type TargetDriver,
} from './types.ts';

export type ShadowSetupStep = 'create' | 'claim' | 'claim-read' | 'check';

export interface ShadowSetupErrorContext {
  url?: string;
  dbName?: string;
  currentUser?: string;
}

const pgCode = (e: unknown): string | null => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

const rawError = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (
    e &&
    typeof e === 'object' &&
    'message' in e &&
    typeof (e as { message?: unknown }).message === 'string'
  ) {
    return (e as { message: string }).message;
  }
  return String(e);
};
const pgError = (e: unknown) => scrubSecrets(rawError(e));

const PG_POOLER_HINT =
  '提示：检测到可能正在使用 PostgreSQL Transaction Pooler（事务池化器）。Dowel 的影子库与生命周期检查依赖会话级 advisory lock、SET 参数以及非事务块建库，不支持 Transaction Pooler，请改用直连地址或 Session Mode（通常为端口 5432）。';

export const isLikelyPgTransactionPoolerUrl = (url: string): boolean => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^postgres(?:ql)?:$/i.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  if (host.includes('-pooler.')) return true;
  if (host.endsWith('.pooler.supabase.com') && u.port === '6543') return true;
  if (u.port === '6543') return true;
  for (const [rawKey, rawVal] of u.searchParams.entries()) {
    const key = rawKey.trim().toLowerCase();
    const val = rawVal.trim().toLowerCase();
    if (key === 'pgbouncer' && val === 'true') return true;
    if (key === 'pool_mode' && val === 'transaction') return true;
  }
  return false;
};

export const isPgPoolerError = (e: unknown): boolean =>
  /pgbouncer|supavisor|transaction\s+mode|pool_mode|unsupported startup parameter|prepared statement[\s\S]*?(?:already exists|does not exist)/i.test(
    rawError(e),
  );

const isCreateInTransactionError = (e: unknown): boolean =>
  pgCode(e) === '25001' || /cannot run inside a transaction block/i.test(rawError(e));

export const appendPgPoolerHint = (
  message: string,
  ctx?: { url?: string; error?: unknown; step?: ShadowSetupStep },
): string => {
  if (message.includes(PG_POOLER_HINT)) return message;
  const matched =
    Boolean(ctx?.url && isLikelyPgTransactionPoolerUrl(ctx.url)) ||
    (ctx?.error !== undefined && isPgPoolerError(ctx.error)) ||
    (ctx?.step === 'create' && ctx?.error !== undefined && isCreateInTransactionError(ctx.error));
  if (!matched) return message;
  const trimmed = message.trimEnd();
  const sep = /[。！？.!?]$/.test(trimmed) ? '' : '。';
  return `${trimmed}${sep}${PG_POOLER_HINT}`;
};

const extractRawPassword = (url: string): string => {
  try {
    const pw = new URL(url).password;
    if (pw) return pw;
  } catch {
    // MSSQL host\instance 等不被 WHATWG URL 接受的连接串回退到权威段解析
  }
  const schemeEnd = url.indexOf('://');
  if (schemeEnd < 0) return '';
  const rest = url.slice(schemeEnd + 3);
  const boundary = rest.search(/[/?#]/);
  const authority = boundary >= 0 ? rest.slice(0, boundary) : rest;
  const at = authority.lastIndexOf('@');
  if (at < 0) return '';
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(':');
  return colon >= 0 ? userinfo.slice(colon + 1) : '';
};

export const scrubUrl = (message: string, url: string): string => {
  let out = scrubSecrets(message.split(url).join(maskUrl(url)));
  const pw = extractRawPassword(url);
  if (!pw) return out;
  out = out.split(pw).join('***');
  try {
    const decoded = decodeURIComponent(pw);
    if (decoded) out = out.split(decoded).join('***');
  } catch {
    // 忽略
  }
  return out;
};

export const shadowSetupError = (e: unknown, step: ShadowSetupStep, ctx?: ShadowSetupErrorContext): Error => {
  if (e instanceof HTTPException || e instanceof ShadowError) return e;
  const msg = ctx?.url ? scrubUrl(rawError(e), ctx.url) : pgError(e);
  const withHint = (text: string) => appendPgPoolerHint(text, { url: ctx?.url, error: e, step });
  if (isInfraFailure(e)) return new ShadowUnavailableError(withHint(msg));
  if (step === 'create') return new ShadowError(withHint(`建影子库失败：${msg}`));
  if (step === 'check') return new ShadowError(withHint(`检查影子库失败：${msg}`));
  const noPrivilege = pgCode(e) === '42501';
  if (step === 'claim-read')
    return new ShadowError(
      withHint(
        noPrivilege
          ? `认领影子库失败：当前账号缺少读取目录的权限，没法核对这个库是不是空库或已经标记过（${msg}）`
          : `认领影子库失败：${msg}`,
      ),
    );
  const claimSuffix =
    ctx?.dbName && ctx?.currentUser
      ? `。请让管理员执行：ALTER DATABASE ${ident(ctx.dbName)} OWNER TO ${ident(ctx.currentUser)};（或由库所有者在移交库与 schema 所有权后执行：COMMENT ON DATABASE ${ident(ctx.dbName)} IS ${literal(SHADOW_MARK)};）`
      : '。请用库的所有者账号，或让 DBA 先建好并标记这个库';
  return new ShadowError(
    withHint(
      noPrivilege
        ? `认领影子库失败：当前账号不是该库的所有者，没法给它打 Dowel 影子库标记（${msg}）${claimSuffix}`
        : `认领影子库失败：${msg}`,
    ),
  );
};

export const connectPg = (url: string, connectTimeout = 10, guard?: ConnectionGuard): TargetConnection => {
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

export const normalizePgVersion = (raw: string): string => {
  const trimmed = raw.trim();
  const token = trimmed.split(/\s+/)[0];
  return token || trimmed;
};

export const inspectPgTargetOn = async (tdb: Db, url: string): Promise<TargetInfo> => {
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
    if (e instanceof HTTPException) throw e;
    throw new ConnectError(appendPgPoolerHint(`连接失败：${scrubUrl(rawError(e), url)}`, { url, error: e }));
  }
};

export const inspectPgTarget = async (
  url: string,
  connectTimeout = CHECK_CONNECT_TIMEOUT,
  guard?: ConnectionGuard,
): Promise<TargetInfo> => {
  const c = connectPg(url, connectTimeout, guard);
  try {
    return await inspectPgTargetOn(c.db, url);
  } finally {
    await c.close();
  }
};

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

const isMarked = async (db: Db) => {
  const [r] = await db.query<{ c: string | null }>(
    `select shobj_description(oid, 'pg_database') as c from pg_database where datname = current_database()`,
  );
  return r?.c === SHADOW_MARK;
};

export const claimPgShadow = async (url: string, guard?: ConnectionGuard) => {
  const c = connectPg(url, CHECK_CONNECT_TIMEOUT, guard);
  let phase: ShadowSetupStep = 'claim-read';
  let dbName: string | undefined;
  let currentUser: string | undefined;
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
    const [d] = await c.db.query<{ d: string; u: string }>(
      'select current_database() as d, current_user as u',
    );
    dbName = d?.d;
    currentUser = d?.u;
    phase = 'claim';
    try {
      await c.db.exec(`COMMENT ON DATABASE ${ident(d!.d)} IS ${literal(SHADOW_MARK)}`);
    } catch (e) {
      if (pgCode(e) === 'XX000' && (await isMarked(c.db).catch(() => false))) return;
      throw e;
    }
  } catch (e) {
    throw shadowSetupError(e, phase, { url, dbName, currentUser });
  } finally {
    await c.close();
  }
};

export const ensureSameInstanceShadow = async (
  targetUrl: string,
  guard?: ConnectionGuard,
): Promise<{ url: string; shadow: string; created: boolean }> => {
  const info = await inspectPgTarget(targetUrl, CHECK_CONNECT_TIMEOUT, guard);
  const url = withDb(targetUrl, info.shadow);
  let created = false;
  const c = connectPg(targetUrl, 10, guard);
  let locked = false;
  try {
    const deadline = Date.now() + SHADOW_LIFECYCLE_LOCK_TIMEOUT_MS;
    while (!(await tryShadowLifecycleLock(c.db, info.shadow))) {
      if (Date.now() > deadline)
        throw new ShadowUnavailableError(
          appendPgPoolerHint('影子库正在被其他请求初始化或清理，请稍后再试', { url: targetUrl }),
        );
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
          `当前账号没有建库权限。请在目标实例上手动执行：CREATE DATABASE ${ident(info.shadow)} OWNER ${ident(info.currentUser)};（也可为该环境配置独立的影子库连接串）`,
        );
      try {
        await c.db.exec(`CREATE DATABASE ${ident(info.shadow)}`);
        created = true;
      } catch (e) {
        const code = pgCode(e);
        if (code !== '42P04' && code !== '23505') throw shadowSetupError(e, 'create', { url: targetUrl });
      }
    }
    await claimPgShadow(url, guard);
  } catch (e) {
    throw shadowSetupError(e, 'create', { url: targetUrl });
  } finally {
    if (locked) await unlockShadowLifecycle(c.db, info.shadow);
    await c.close().catch(() => {});
  }
  return { url, shadow: info.shadow, created };
};

export const dropPgSameInstanceShadow = async (targetUrl: string, name: string, guard?: ConnectionGuard) => {
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

export const pgShadow = (shadowUrl: string, schemas?: string[] | null, guard?: ConnectionGuard): Shadow => {
  // 串行、懒建连、关闭后永不重连（Issue #154，见 serialShadowConnection）
  const session = serialShadowConnection(() => connectPg(shadowUrl, 10, guard));
  const run = <T>(fn: (ops: ReturnType<typeof shadowOps>) => Promise<T>): Promise<T> =>
    session.run(async ({ db }, discard) => {
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
          if (Date.now() > deadline)
            throw new ShadowUnavailableError(
              appendPgPoolerHint('正被其他检查占用，请稍后再试', { url: shadowUrl }),
            );
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (e) {
        await discard();
        throw e instanceof ShadowError
          ? e
          : new ShadowUnavailableError(
              appendPgPoolerHint(`连接失败：${scrubUrl(rawError(e), shadowUrl)}`, {
                url: shadowUrl,
                error: e,
              }),
            );
      }
      let clean = false;
      try {
        if (
          !(await isMarked(db).catch((e) => Promise.reject(shadowSetupError(e, 'check', { url: shadowUrl }))))
        )
          throw new ShadowError('拒绝执行：影子库的 Dowel 标记不见了');
        const result = await fn(shadowOps(async () => db, schemas, { dialect: 'pg' }));
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
  return {
    importSql: (sql) => run((ops) => ops.importSql(sql)),
    verify: (from, to, opts): Promise<VerifyReport> => run((ops) => ops.verify(from, to, opts)),
    verifyScripts: (from, to, up, down, options): Promise<VerifyReport> =>
      run((ops) => ops.verifyScripts(from, to, up, down, options)),
    canonicalize: (prev, next) => run((ops) => ops.canonicalize(prev, next)),
    close: () => session.close(),
  };
};

export const pullPgSchema = async (
  url: string,
  schemas?: string[] | null,
  guard?: ConnectionGuard,
): Promise<Model> => {
  const c = connectPg(url, CHECK_CONNECT_TIMEOUT, guard);
  try {
    return importSnapshot(await readSnapshot(c.db, schemas));
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    throw new ConnectError(
      appendPgPoolerHint(`读取结构失败：${scrubUrl(rawError(e), url)}`, { url, error: e }),
    );
  } finally {
    await c.close();
  }
};

export const preparePgShadow = async (
  env: ShadowSource | null,
  schemas: string[] | null,
  guard?: ConnectionGuard,
): Promise<PreparedShadow> => {
  if (!env) {
    throw new ShadowError(
      '项目还没有配置环境。导入 SQL、验证迁移都需要一个真实的 PostgreSQL 实例作影子库，请先在“环境”里添加项目要部署到的数据库',
      { preConnect: true },
    );
  }
  let url = env.shadowUrl ?? null;
  let created: { targetUrl: string; name: string } | null = null;
  if (!url) {
    if (env.production && !env.allowSameInstance)
      throw new ShadowError(
        `环境“${env.name}”是生产环境，默认不在同一实例上建影子库（检查会占用生产实例的资源）。请为它配置单独的影子库实例，或明确允许使用同一实例`,
        { preConnect: true },
      );
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

export const pgTargetDriver: TargetDriver = {
  dialect: 'pg',
  shadowDbName,
  connect: connectPg,
  inspectTarget: inspectPgTarget,
  inspectTargetOn: inspectPgTargetOn,
  pullSchema: pullPgSchema,
  claimShadow: claimPgShadow,
  prepareShadow: preparePgShadow,
  dropSameInstanceShadow: dropPgSameInstanceShadow,
  classifyDriverError: (e) => {
    const code = pgCode(e);
    if (
      code !== null &&
      /^(08|53|57|28|3D|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|CONNECT_TIMEOUT|CONNECTION_)/.test(code)
    ) {
      return 'connect';
    }
    if (e instanceof Error && e.name === 'PostgresError') return 'database';
    return null;
  },
};
