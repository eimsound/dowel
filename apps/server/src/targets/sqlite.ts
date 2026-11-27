// SQLite 服务端目标库驱动：支持内存影子库（免环境配置）与受 DOWEL_SQLITE_ROOTS 目录白名单保护的本地 SQLite 文件目标库。
import path from 'node:path';

import type { TargetInfo, VerifyReport } from '@dowel/api';
import type { Model } from '@dowel/core';
import {
  type Db,
  importSqliteSnapshot,
  openSqliteDb,
  parseSqliteVersionNum,
  readSqliteSnapshot,
  type SqliteDbHandle,
} from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';

import { resolveSqlitePath } from '../allowlist.ts';
import { type Shadow, ShadowConfigChangedError, shadowOps } from '../shadow.ts';
import {
  CHECK_CONNECT_TIMEOUT,
  ConnectError,
  type ConnectionGuard,
  type PreparedShadow,
  type ShadowSource,
  type TargetConnection,
  type TargetDriver,
} from './types.ts';

const rawError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 内存 SQLite 影子库：每次操作打开独立 `:memory:` 数据库并在结束时关闭（毫秒级开销、天然并发安全、免环境配置）。
 */
export const sqliteMemoryShadow = (): Shadow => {
  // 每次操作各开各的 :memory:，没有外部连接可泄漏；只为和外部影子库同一份 close() 契约：关闭后拒绝所有操作
  let closed = false;
  const withMem = async <T>(fn: (ops: ReturnType<typeof shadowOps>) => Promise<T>): Promise<T> => {
    if (closed) throw new ShadowConfigChangedError();
    const handle = openSqliteDb(':memory:');
    try {
      const result = await fn(shadowOps(async () => handle.db, null, { dialect: 'sqlite' })).catch((e) => {
        throw closed ? new ShadowConfigChangedError() : e;
      });
      if (closed) throw new ShadowConfigChangedError();
      return result;
    } finally {
      handle.close();
    }
  };
  return {
    importSql: (sql) => withMem((ops) => ops.importSql(sql)),
    verify: (from, to, opts): Promise<VerifyReport> => withMem((ops) => ops.verify(from, to, opts)),
    verifyScripts: (from, to, up, down, options): Promise<VerifyReport> =>
      withMem((ops) => ops.verifyScripts(from, to, up, down, options)),
    canonicalize: (prev, next) => withMem((ops) => ops.canonicalize(prev, next)),
    close: async () => {
      closed = true;
    },
  };
};

/**
 * 连接本地 SQLite 文件目标库：延迟到第一次 query/exec 前先过 guard 与 DOWEL_SQLITE_ROOTS 目录白名单守卫。
 */
export const connectSqlite = (
  url: string,
  connectTimeoutSec = 10,
  guard?: ConnectionGuard,
): TargetConnection => {
  let handle: SqliteDbHandle | null = null;
  let opening: Promise<SqliteDbHandle> | null = null;
  let closed = false;

  const ensureOpen = (): Promise<SqliteDbHandle> => {
    if (closed) return Promise.reject(new ConnectError('SQLite 连接已关闭'));
    if (handle) return Promise.resolve(handle);
    opening ??= (async () => {
      await guard?.(url);
      if (closed) throw new ConnectError('SQLite 连接已关闭');
      const filePath = await resolveSqlitePath(url);
      if (closed) throw new ConnectError('SQLite 连接已关闭');
      let h: SqliteDbHandle;
      try {
        h = openSqliteDb(filePath, { busyTimeoutMs: Math.max(1000, connectTimeoutSec * 1000) });
      } catch (e) {
        throw new ConnectError(`打开 SQLite 数据库失败：${rawError(e)}`);
      }
      if (closed) {
        h.close();
        throw new ConnectError('SQLite 连接已关闭');
      }
      handle = h;
      return h;
    })();
    return opening;
  };

  const db: Db = {
    query: async <T>(sql: string, params?: unknown[]) => {
      const h = await ensureOpen();
      return h.db.query<T>(sql, params);
    },
    exec: async (sql: string) => {
      const h = await ensureOpen();
      await h.db.exec(sql);
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
        opened?.close();
      }
      const h = handle;
      handle = null;
      h?.close();
    },
  };
};

export const inspectSqliteTargetOn = async (tdb: Db, url: string): Promise<TargetInfo> => {
  try {
    const [verRow] = await tdb.query<{ v: string }>('SELECT sqlite_version() AS v');
    const version = String(verRow?.v ?? '3.0.0');
    const versionNum = parseSqliteVersionNum(version);
    const tables = await tdb.query<{ n: number }>(
      `SELECT count(*) AS n FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'dowel_%'`,
    );
    const dowelRows = await tdb.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('dowel_meta', 'dowel_versions', 'dowel_history', 'dowel_projects')`,
    );
    const dowelNames = new Set(dowelRows.map((r) => r.name));
    const hasHistory =
      dowelNames.has('dowel_versions') && dowelNames.has('dowel_history') && dowelNames.has('dowel_projects');
    const filePart = url.replace(/^sqlite:\/\//i, '');
    const dbName = path.basename(filePart) || filePart;

    return {
      version,
      versionNum,
      database: dbName,
      canCreateDb: false,
      shadow: ':memory:',
      shadowExists: true,
      currentUser: 'local',
      superuser: false,
      canCreateSchema: false,
      schemas: [{ name: 'main', tables: Number(tables[0]?.n ?? 0) }],
      dowelSchema: hasHistory,
      dowelMeta: dowelNames.has('dowel_meta'),
    };
  } catch (e) {
    if (e instanceof HTTPException || e instanceof ConnectError) throw e;
    throw new ConnectError(`连接失败：${rawError(e)}`);
  }
};

export const inspectSqliteTarget = async (
  url: string,
  connectTimeout = CHECK_CONNECT_TIMEOUT,
  guard?: ConnectionGuard,
): Promise<TargetInfo> => {
  const c = connectSqlite(url, connectTimeout, guard);
  try {
    return await inspectSqliteTargetOn(c.db, url);
  } finally {
    await c.close();
  }
};

export const pullSqliteSchema = async (
  url: string,
  _schemas?: string[] | null,
  guard?: ConnectionGuard,
): Promise<Model> => {
  const c = connectSqlite(url, CHECK_CONNECT_TIMEOUT, guard);
  try {
    return importSqliteSnapshot(await readSqliteSnapshot(c.db));
  } catch (e) {
    if (e instanceof HTTPException || e instanceof ConnectError) throw e;
    throw new ConnectError(`读取结构失败：${rawError(e)}`);
  } finally {
    await c.close();
  }
};

export const prepareSqliteShadow = async (
  _env: ShadowSource | null,
  _schemas: string[] | null,
  _guard?: ConnectionGuard,
): Promise<PreparedShadow> => ({
  shadow: sqliteMemoryShadow(),
  label: 'SQLite :memory:',
  url: 'sqlite://:memory:',
  created: null,
});

export const sqliteTargetDriver: TargetDriver = {
  dialect: 'sqlite',
  shadowDbName: () => ':memory:',
  connect: connectSqlite,
  inspectTarget: inspectSqliteTarget,
  inspectTargetOn: inspectSqliteTargetOn,
  pullSchema: pullSqliteSchema,
  prepareShadow: prepareSqliteShadow,
  classifyDriverError: (e) => {
    const code = (e as { code?: unknown } | null)?.code;
    const errcode = (e as { errcode?: unknown } | null)?.errcode;
    const msg = rawError(e);
    if (errcode === 14 || /unable to open database|SQLITE_CANTOPEN/i.test(msg)) return 'connect';
    if (code === 'ERR_SQLITE_ERROR' || /SQLITE_/i.test(msg)) return 'database';
    return null;
  },
};
