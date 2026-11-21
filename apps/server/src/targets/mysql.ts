// MySQL 服务端目标库驱动：连接、探测、同实例影子库认领与清理、拉取结构。
import { createHash } from 'node:crypto';

import type { TargetInfo, VerifyReport } from '@dowel/api';
import { MAX_MYSQL_IDENT, type Model, MYSQL_SHADOW_MARK_TABLE, mysqlIdent } from '@dowel/core';
import {
  type Db,
  destroyMysqlConn,
  fromMysql2,
  importMysqlSnapshot,
  MYSQL_POOL_DEFAULTS,
  mysqlGrantMatchesDb,
  parseMysqlGrantPrivileges,
  parseMysqlVersion,
  readMysqlSnapshot,
} from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';
import { createPool, type Pool, type PoolOptions } from 'mysql2/promise';

import { maskUrl, scrubSecrets } from '../secrets.ts';
import {
  isInfraFailure,
  SHADOW_STATEMENT_TIMEOUT_MS,
  type Shadow,
  ShadowError,
  ShadowUnavailableError,
  shadowOps,
} from '../shadow.ts';
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

const rawError = (e: unknown) => (e instanceof Error ? e.message : String(e));

const mysqlErrno = (e: unknown): number | null => {
  const n = (e as { errno?: unknown } | null)?.errno;
  return typeof n === 'number' ? n : null;
};

const mysqlCode = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : null;
};

const scrubMysqlUrl = (message: string, url: string): string => {
  let out = scrubSecrets(message.split(url).join(maskUrl(url)));
  let pw = '';
  try {
    pw = new URL(url).password;
  } catch {
    // 忽略
  }
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

const parseTlsFromParams = (params: URLSearchParams): PoolOptions['ssl'] => {
  const rawSsl = params.get('ssl');
  const rawMode = (params.get('ssl-mode') ?? params.get('sslmode') ?? '').trim().toUpperCase();

  if (rawMode !== '') {
    if (rawMode === 'DISABLED') return undefined;
    if (
      rawMode === 'REQUIRED' ||
      rawMode === 'REQUIRE' ||
      rawMode === 'VERIFY_CA' ||
      rawMode === 'VERIFY-CA' ||
      rawMode === 'VERIFY_IDENTITY' ||
      rawMode === 'VERIFY-FULL' ||
      rawMode === 'PREFERRED'
    ) {
      return { rejectUnauthorized: true };
    }
    throw new HTTPException(422, {
      message: `不支持的 MySQL ssl-mode 参数：${rawMode}（允许 DISABLED、PREFERRED、REQUIRED/REQUIRE、VERIFY_CA/VERIFY-CA、VERIFY_IDENTITY/VERIFY-FULL）`,
    });
  }

  if (rawSsl === 'false' || rawSsl === '0') return undefined;

  if (rawSsl !== null) {
    const trimmed = rawSsl.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'true' || trimmed === '1') {
      return { rejectUnauthorized: true };
    }
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        return {
          rejectUnauthorized: true,
          ...(typeof parsed.rejectUnauthorized === 'boolean'
            ? { rejectUnauthorized: parsed.rejectUnauthorized }
            : {}),
          ...(typeof parsed.ca === 'string' ? { ca: parsed.ca } : {}),
          ...(typeof parsed.cert === 'string' ? { cert: parsed.cert } : {}),
          ...(typeof parsed.key === 'string' ? { key: parsed.key } : {}),
          ...(typeof parsed.minVersion === 'string' ? { minVersion: parsed.minVersion } : {}),
        };
      } catch {
        throw new HTTPException(422, { message: 'MySQL 连接串里的 ssl JSON 参数不合法' });
      }
    }
    return { rejectUnauthorized: true };
  }

  return undefined;
};

/** 解析 mysql:// 连接串为安全的 mysql2 PoolOptions（拒绝 socketPath、强制 multipleStatements: false、兼容 IPv6） */
export const parseMysqlUrl = (url: string, connectTimeoutSec = 10): PoolOptions => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HTTPException(422, { message: 'MySQL 连接串格式不合法' });
  }
  if (u.protocol.toLowerCase() !== 'mysql:') {
    throw new HTTPException(422, { message: 'MySQL 连接串必须以 mysql:// 开头' });
  }
  for (const key of u.searchParams.keys()) {
    if (key.toLowerCase() === 'socketpath') {
      throw new HTTPException(422, {
        message: '不支持在 MySQL 连接串里使用 socketPath（无法通过主机白名单校验），请使用 TCP 地址',
      });
    }
  }
  if (!u.hostname) {
    throw new HTTPException(422, { message: 'MySQL 连接串缺少主机名' });
  }
  const host = u.hostname.startsWith('[') && u.hostname.endsWith(']') ? u.hostname.slice(1, -1) : u.hostname;
  const database = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  const port = u.port ? Number.parseInt(u.port, 10) : 3306;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new HTTPException(422, { message: 'MySQL 连接串端口号不合法' });
  }
  const ssl = parseTlsFromParams(u.searchParams);

  return {
    ...MYSQL_POOL_DEFAULTS,
    host,
    port,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ...(database ? { database } : {}),
    connectTimeout: Math.max(1000, Math.trunc(connectTimeoutSec * 1000)),
    connectionLimit: 2,
    waitForConnections: true,
    ...(ssl ? { ssl } : {}),
  };
};

export const mysqlShadowDbName = (db: string): string => {
  const full = `${db}_dowel`;
  if (Array.from(full).length <= MAX_MYSQL_IDENT) return full;
  const hash = createHash('sha256').update(db).digest('hex').slice(0, 8);
  const chars = Array.from(db);
  const maxBase = MAX_MYSQL_IDENT - `_${hash}_dowel`.length;
  return `${chars.slice(0, Math.max(1, maxBase)).join('')}_${hash}_dowel`;
};

const withDb = (url: string, name: string): string => {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
};

const mysqlShadowLockName = (prefix: string, name: string): string =>
  `${prefix}${createHash('sha256').update(name).digest('hex').slice(0, 32)}`;

/** 构造懒连接的 MySQL TargetConnection（首次查询前过 guard 与 parseMysqlUrl；并发 close 不泄漏连接池） */
export const connectMysql = (
  url: string,
  connectTimeoutSec = 10,
  guard?: ConnectionGuard,
): TargetConnection => {
  let pool: Pool | null = null;
  let opening: Promise<{ pool: Pool; db: Db }> | null = null;
  let closed = false;

  const ensureOpen = (): Promise<{ pool: Pool; db: Db }> => {
    if (closed) return Promise.reject(new ConnectError('MySQL 连接已关闭'));
    if (pool) return Promise.resolve({ pool, db: fromMysql2(pool) });
    opening ??= (async () => {
      await guard?.(url);
      if (closed) throw new ConnectError('MySQL 连接已关闭');
      const opts = parseMysqlUrl(url, connectTimeoutSec);
      if (closed) throw new ConnectError('MySQL 连接已关闭');
      const p = createPool(opts);
      if (closed) {
        await p.end().catch(() => {});
        throw new ConnectError('MySQL 连接已关闭');
      }
      pool = p;
      return { pool: p, db: fromMysql2(p) };
    })();
    return opening;
  };

  const db: Db = {
    query: async <T>(sql: string, params?: unknown[]) => {
      const { db: inner } = await ensureOpen();
      return inner.query<T>(sql, params);
    },
    exec: async (sql: string) => {
      const { db: inner } = await ensureOpen();
      await inner.exec(sql);
    },
    reserve: async () => {
      const { db: inner } = await ensureOpen();
      return inner.reserve!();
    },
  };

  return {
    db,
    close: async () => {
      closed = true;
      const inFlight = opening;
      opening = null;
      if (inFlight) {
        const opened = await inFlight.catch(() => null);
        if (opened) await opened.pool.end().catch(() => {});
      }
      const p = pool;
      pool = null;
      if (p) await p.end().catch(() => {});
    },
  };
};

const isMarked = async (db: Db): Promise<boolean> => {
  const tbl = await db.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_NAME = ?`,
    [MYSQL_SHADOW_MARK_TABLE],
  );
  if (Number(tbl[0]?.n ?? 0) === 0) return false;
  const rows = await db.query<{ mark: string }>(
    `SELECT \`mark\` FROM ${mysqlIdent(MYSQL_SHADOW_MARK_TABLE)} WHERE \`mark\` = ? LIMIT 1`,
    [SHADOW_MARK],
  );
  return rows.length > 0;
};

const isMysqlInfraFailure = (e: unknown): boolean => {
  if (isInfraFailure(e)) return true;
  const code = mysqlCode(e);
  if (
    code !== null &&
    /^(PROTOCOL_|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|HANDSHAKE_|ER_CON_COUNT_ERROR|ER_SERVER_SHUTDOWN)/.test(
      code,
    )
  ) {
    return true;
  }
  const errno = mysqlErrno(e);
  return (
    errno === 1040 || errno === 1053 || errno === 2002 || errno === 2003 || errno === 2006 || errno === 2013
  );
};

type ShadowSetupStep = 'create' | 'claim' | 'claim-read' | 'check';

const mysqlShadowSetupError = (e: unknown, step: ShadowSetupStep): Error => {
  if (e instanceof HTTPException || e instanceof ShadowError) return e;
  const msg = scrubSecrets(rawError(e));
  if (isMysqlInfraFailure(e)) return new ShadowUnavailableError(msg);
  if (step === 'create') return new ShadowError(`建 MySQL 影子库失败：${msg}`);
  if (step === 'check') return new ShadowError(`检查 MySQL 影子库失败：${msg}`);
  const errno = mysqlErrno(e);
  const noPriv = errno === 1044 || errno === 1142 || errno === 1227;
  if (step === 'claim-read') {
    return new ShadowError(
      noPriv
        ? `认领 MySQL 影子库失败：当前账号缺少读取 information_schema 的权限（${msg}）`
        : `认领 MySQL 影子库失败：${msg}`,
    );
  }
  return new ShadowError(
    noPriv
      ? `认领 MySQL 影子库失败：当前账号缺少建表/写入 \`${MYSQL_SHADOW_MARK_TABLE}\` 标记的权限（${msg}）`
      : `认领 MySQL 影子库失败：${msg}`,
  );
};

export const inspectMysqlTargetOn = async (tdb: Db, url: string): Promise<TargetInfo> => {
  try {
    const [r] = await tdb.query<{
      ver: string;
      db: string | null;
      currentUser: string;
      lowerCaseTableNames: number | string;
    }>(
      `SELECT VERSION() AS ver,
              DATABASE() AS db,
              CURRENT_USER() AS currentUser,
              @@lower_case_table_names AS lowerCaseTableNames`,
    );
    const database = r?.db ?? '';
    if (!database) {
      throw new ConnectError('MySQL 连接串未指定数据库名（请使用 mysql://user:pass@host:3306/dbname）');
    }
    const { version, versionNum } = parseMysqlVersion(String(r?.ver ?? '8.4.0'));
    const shadow = mysqlShadowDbName(database);

    const [shadowRow] = await tdb.query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
      [shadow],
    );

    const [tblCountRow] = await tdb.query<{ n: number | string }>(
      `SELECT COUNT(*) AS n
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_TYPE = 'BASE TABLE'
          AND TABLE_NAME NOT LIKE 'dowel!_%' ESCAPE '!'
          AND TABLE_NAME <> ?`,
      [MYSQL_SHADOW_MARK_TABLE],
    );

    const dowelRows = await tdb.query<{ name: string }>(
      `SELECT TABLE_NAME AS name
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_TYPE = 'BASE TABLE'
          AND TABLE_NAME IN ('dowel_meta', 'dowel_versions', 'dowel_history', 'dowel_projects')`,
    );
    const dowelSet = new Set(dowelRows.map((x) => x.name.toLowerCase()));
    const hasHistory =
      dowelSet.has('dowel_versions') && dowelSet.has('dowel_history') && dowelSet.has('dowel_projects');

    let canCreateDb = false;
    let superuser = false;
    try {
      const grants = await tdb.query<Record<string, unknown>>('SHOW GRANTS');
      const lines = grants.map((row) => {
        const v = Object.values(row)[0];
        return typeof v === 'string' ? v : '';
      });
      superuser = lines.some((l) => {
        if (!/^\s*GRANT\s+(?![`'"]).+?\s+ON\s+\*\.\*(?:\s|$)/i.test(l)) return false;
        const privs = parseMysqlGrantPrivileges(l);
        return privs.has('ALL PRIVILEGES') || privs.has('ALL') || privs.has('SUPER');
      });
      canCreateDb =
        superuser ||
        lines.some((l) => {
          if (!mysqlGrantMatchesDb(l, shadow)) return false;
          const privs = parseMysqlGrantPrivileges(l);
          return privs.has('ALL PRIVILEGES') || privs.has('ALL') || privs.has('CREATE');
        });
    } catch {
      canCreateDb = false;
      superuser = false;
    }

    return {
      version,
      versionNum,
      database,
      canCreateDb,
      shadow,
      shadowExists: Number(shadowRow?.n ?? 0) > 0,
      currentUser: String(r?.currentUser ?? ''),
      superuser,
      canCreateSchema: false,
      schemas: [{ name: 'default', tables: Number(tblCountRow?.n ?? 0) }],
      dowelSchema: hasHistory,
      dowelMeta: dowelSet.has('dowel_meta'),
    };
  } catch (e) {
    if (e instanceof HTTPException || e instanceof ConnectError) throw e;
    throw new ConnectError(`连接失败：${scrubMysqlUrl(rawError(e), url)}`);
  }
};

export const inspectMysqlTarget = async (
  url: string,
  connectTimeout = CHECK_CONNECT_TIMEOUT,
  guard?: ConnectionGuard,
): Promise<TargetInfo> => {
  const c = connectMysql(url, connectTimeout, guard);
  try {
    return await inspectMysqlTargetOn(c.db, url);
  } finally {
    await c.close();
  }
};

export const claimMysqlShadow = async (url: string, guard?: ConnectionGuard): Promise<void> => {
  const c = connectMysql(url, CHECK_CONNECT_TIMEOUT, guard);
  let phase: ShadowSetupStep = 'claim-read';
  try {
    if (await isMarked(c.db)) return;

    // 核对目标库是否完全为空（0 表/视图/例程/触发器/事件），防止误清空业务库
    const [tablesRow] = await c.db.query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
    );
    const [routinesRow] = await c.db.query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()`,
    );
    const [triggersRow] = await c.db.query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()`,
    );
    const [eventsRow] = await c.db.query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()`,
    );
    const total =
      Number(tablesRow?.n ?? 0) +
      Number(routinesRow?.n ?? 0) +
      Number(triggersRow?.n ?? 0) +
      Number(eventsRow?.n ?? 0);
    if (total > 0) {
      throw new ShadowError(
        '拒绝使用这个库作影子库：它不是空库，也没有 Dowel 影子库标记。影子库每次检查前都会被清空',
      );
    }

    phase = 'claim';
    await c.db.exec(
      `CREATE TABLE IF NOT EXISTS ${mysqlIdent(MYSQL_SHADOW_MARK_TABLE)} (
        \`mark\` VARCHAR(128) NOT NULL PRIMARY KEY
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    );
    await c.db.query(
      `INSERT INTO ${mysqlIdent(MYSQL_SHADOW_MARK_TABLE)} (\`mark\`) VALUES (?) AS new_row
       ON DUPLICATE KEY UPDATE \`mark\` = new_row.\`mark\``,
      [SHADOW_MARK],
    );
  } catch (e) {
    throw mysqlShadowSetupError(e, phase);
  } finally {
    await c.close();
  }
};

const SHADOW_LIFECYCLE_LOCK_TIMEOUT_MS = 15_000;

const tryMysqlLock = async (conn: Db, name: string): Promise<boolean> => {
  const [r] = await conn.query<{ ok: number | string | null }>('SELECT GET_LOCK(?, 0) AS ok', [name]);
  return Number(r?.ok) === 1;
};

const unlockMysqlLock = async (conn: Db, name: string): Promise<boolean> =>
  conn
    .query<{ ok: number | string | null }>('SELECT RELEASE_LOCK(?) AS ok', [name])
    .then((rows) => Number(rows[0]?.ok) === 1)
    .catch(() => false);

export const ensureSameInstanceMysqlShadow = async (
  targetUrl: string,
  guard?: ConnectionGuard,
): Promise<{ url: string; shadow: string; created: boolean }> => {
  const info = await inspectMysqlTarget(targetUrl, CHECK_CONNECT_TIMEOUT, guard);
  const url = withDb(targetUrl, info.shadow);
  let created = false;
  const c = connectMysql(targetUrl, 10, guard);
  let conn: Db | null = null;
  const lockName = mysqlShadowLockName('dowel:shadow:', info.shadow);
  let locked = false;
  let broken = false;

  try {
    conn = await c.db.reserve!();
    const deadline = Date.now() + SHADOW_LIFECYCLE_LOCK_TIMEOUT_MS;
    for (;;) {
      let ok: boolean;
      try {
        ok = await tryMysqlLock(conn, lockName);
      } catch (e) {
        broken = true;
        throw e;
      }
      if (ok) break;
      if (Date.now() > deadline) {
        throw new ShadowUnavailableError('MySQL 影子库正在被其他请求初始化或清理，请稍后再试');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    locked = true;

    const [ex] = await conn.query<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [info.shadow],
    );
    if (Number(ex?.n ?? 0) === 0) {
      if (!info.canCreateDb) {
        throw new ShadowError(
          `当前账号没有建库权限。请在目标 MySQL 实例上手动执行：CREATE DATABASE ${mysqlIdent(info.shadow)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`,
        );
      }
      try {
        await conn.exec(
          `CREATE DATABASE ${mysqlIdent(info.shadow)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
        created = true;
      } catch (e) {
        // 1007 = ER_DB_CREATE_EXISTS（并发建库竞争）
        if (mysqlErrno(e) !== 1007) throw mysqlShadowSetupError(e, 'create');
      }
    }
    await claimMysqlShadow(url, guard);
  } catch (e) {
    throw mysqlShadowSetupError(e, 'create');
  } finally {
    if (locked && conn) {
      const ok = await unlockMysqlLock(conn, lockName);
      if (!ok) broken = true;
    }
    if (conn) {
      if (broken) destroyMysqlConn(conn);
      else conn.release?.();
    }
    await c.close().catch(() => {});
  }
  return { url, shadow: info.shadow, created };
};

export const dropMysqlSameInstanceShadow = async (
  targetUrl: string,
  name: string,
  guard?: ConnectionGuard,
): Promise<void> => {
  const c = connectMysql(targetUrl, 10, guard);
  let conn: Db | null = null;
  const lifecycleLock = mysqlShadowLockName('dowel:shadow:', name);
  const runLock = mysqlShadowLockName('dowel:shadow:run:', name);
  let locked = false;
  let broken = false;

  try {
    conn = await c.db.reserve!();
    try {
      if (!(await tryMysqlLock(conn, lifecycleLock))) return;
    } catch (e) {
      broken = true;
      throw e;
    }
    locked = true;

    const probe = connectMysql(withDb(targetUrl, name), CHECK_CONNECT_TIMEOUT, guard);
    let probeConn: Db | null = null;
    let probeLocked = false;
    let probeBroken = false;
    try {
      probeConn = await probe.db.reserve!();
      try {
        if (!(await tryMysqlLock(probeConn, runLock))) return;
      } catch (e) {
        probeBroken = true;
        throw e;
      }
      probeLocked = true;
      if (!(await isMarked(probeConn))) return;
    } catch (e) {
      // 1049 = ER_BAD_DB_ERROR（库已经不存在）
      if (mysqlErrno(e) === 1049) return;
      console.error('清理 MySQL 影子库前检查失败，跳过删除', name, scrubSecrets(rawError(e)));
      return;
    } finally {
      if (probeLocked && probeConn) {
        const ok = await unlockMysqlLock(probeConn, runLock);
        if (!ok) probeBroken = true;
      }
      if (probeConn) {
        if (probeBroken) destroyMysqlConn(probeConn);
        else probeConn.release?.();
      }
      await probe.close().catch(() => {});
    }

    await conn.exec(`DROP DATABASE IF EXISTS ${mysqlIdent(name)}`);
  } catch (e) {
    console.error('清理 MySQL 影子库失败', name, scrubSecrets(rawError(e)));
  } finally {
    if (locked && conn) {
      const ok = await unlockMysqlLock(conn, lifecycleLock);
      if (!ok) broken = true;
    }
    if (conn) {
      if (broken) destroyMysqlConn(conn);
      else conn.release?.();
    }
    await c.close().catch(() => {});
  }
};

export const mysqlShadow = (
  shadowUrl: string,
  _schemas?: string[] | null,
  guard?: ConnectionGuard,
): Shadow => {
  let conn: TargetConnection | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const dbName = (() => {
    try {
      return decodeURIComponent(new URL(shadowUrl).pathname.replace(/^\/+/, '')) || 'shadow';
    } catch {
      return 'shadow';
    }
  })();
  const runLock = mysqlShadowLockName('dowel:shadow:run:', dbName);

  const discard = async () => {
    const old = conn;
    conn = null;
    await old?.close().catch(() => {});
  };

  const run = <T>(fn: (ops: ReturnType<typeof shadowOps>) => Promise<T>): Promise<T> => {
    const p = queue.then(async () => {
      conn ??= connectMysql(shadowUrl, 10, guard);
      let sessionConn: Db | null = null;
      let locked = false;
      let clean = false;
      try {
        sessionConn = await conn.db.reserve!();
        await sessionConn.exec(`SET SESSION lock_wait_timeout = 10`);
        await sessionConn.exec(`SET SESSION max_execution_time = ${SHADOW_STATEMENT_TIMEOUT_MS}`);
        const deadline = Date.now() + 60_000;
        while (!(await tryMysqlLock(sessionConn, runLock))) {
          if (Date.now() > deadline)
            throw new ShadowUnavailableError('MySQL 影子库正被其他检查占用，请稍后再试');
          await new Promise((r) => setTimeout(r, 500));
        }
        locked = true;
      } catch (e) {
        if (sessionConn) destroyMysqlConn(sessionConn);
        await discard();
        throw e instanceof ShadowError
          ? e
          : new ShadowUnavailableError(`连接失败：${scrubSecrets(rawError(e))}`);
      }

      try {
        if (!(await isMarked(sessionConn).catch((e) => Promise.reject(mysqlShadowSetupError(e, 'check'))))) {
          throw new ShadowError('拒绝执行：MySQL 影子库的 Dowel 标记不见了');
        }
        const result = await fn(shadowOps(async () => sessionConn!, null, { dialect: 'mysql' }));
        clean = true;
        return result;
      } finally {
        let unlocked = true;
        if (locked) unlocked = await unlockMysqlLock(sessionConn, runLock);
        if (!clean || !unlocked) {
          destroyMysqlConn(sessionConn);
          await discard();
        } else {
          sessionConn.release?.();
        }
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

export const pullMysqlSchema = async (
  url: string,
  _schemas?: string[] | null,
  guard?: ConnectionGuard,
): Promise<Model> => {
  const c = connectMysql(url, CHECK_CONNECT_TIMEOUT, guard);
  try {
    return importMysqlSnapshot(await readMysqlSnapshot(c.db));
  } catch (e) {
    if (e instanceof HTTPException || e instanceof ConnectError) throw e;
    throw new ConnectError(`读取结构失败：${scrubMysqlUrl(rawError(e), url)}`);
  } finally {
    await c.close();
  }
};

export const prepareMysqlShadow = async (
  env: ShadowSource | null,
  schemas: string[] | null,
  guard?: ConnectionGuard,
): Promise<PreparedShadow> => {
  if (!env) {
    throw new ShadowError(
      '项目还没有配置环境。导入 SQL、验证迁移都需要一个真实的 MySQL 实例作影子库，请先在“环境”里添加项目要部署到的数据库',
    );
  }
  let url = env.shadowUrl ?? null;
  let created: { targetUrl: string; name: string } | null = null;
  if (!url) {
    if (env.production && !env.allowSameInstance) {
      throw new ShadowError(
        `环境“${env.name}”是生产环境，默认不在同一实例上建影子库（检查会占用生产实例的资源）。请为它配置单独的影子库实例，或明确允许使用同一实例`,
      );
    }
    const prepared = await ensureSameInstanceMysqlShadow(env.url, guard).catch((e: unknown) => {
      throw e instanceof ConnectError ? new ShadowUnavailableError(e.message) : e;
    });
    url = prepared.url;
    if (prepared.created) created = { targetUrl: env.url, name: prepared.shadow };
  }
  return {
    shadow: mysqlShadow(url, schemas, guard),
    label: `${env.name}：${decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''))}`,
    url,
    created,
  };
};

const CONNECT_ERRNOS = new Set([1040, 1044, 1045, 1049, 1053, 1129, 1130, 2002, 2003, 2006, 2013]);

export const mysqlTargetDriver: TargetDriver = {
  dialect: 'mysql',
  shadowDbName: mysqlShadowDbName,
  connect: connectMysql,
  inspectTarget: inspectMysqlTarget,
  inspectTargetOn: inspectMysqlTargetOn,
  pullSchema: pullMysqlSchema,
  claimShadow: claimMysqlShadow,
  prepareShadow: prepareMysqlShadow,
  dropSameInstanceShadow: dropMysqlSameInstanceShadow,
  classifyDriverError: (e) => {
    const code = mysqlCode(e);
    const errno = mysqlErrno(e);
    if (
      (errno !== null && CONNECT_ERRNOS.has(errno)) ||
      (code !== null &&
        /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|PROTOCOL_|HANDSHAKE_|ER_ACCESS_DENIED|ER_BAD_DB|ER_DBACCESS_DENIED)/.test(
          code,
        ))
    ) {
      return 'connect';
    }
    const sqlState = (e as { sqlState?: unknown } | null)?.sqlState;
    if (errno !== null || (typeof sqlState === 'string' && sqlState.length === 5)) {
      return 'database';
    }
    return null;
  },
};
