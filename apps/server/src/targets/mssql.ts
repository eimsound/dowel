// MSSQL 服务端目标库驱动：连接解析（含 host\instance、TLS 默认严格校验）、探测、同实例影子库与扩展属性认领、拉取结构。
import { createHash } from 'node:crypto';

import type { SchemaInfo, TargetInfo, VerifyReport } from '@dowel/api';
import { MAX_MSSQL_IDENT, type Model, mssqlIdent, mssqlLiteral } from '@dowel/core';
import {
  type Db,
  fromMssql,
  importMssqlSnapshot,
  MSSQL_DOWEL_SCHEMA,
  mssqlErrorCode,
  mssqlErrorNumber,
  readMssqlSnapshot,
  setMssqlShadowGuard,
} from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';
import sql from 'mssql';

import { scrubSecrets } from '../secrets.ts';
import {
  SHADOW_STATEMENT_TIMEOUT_MS,
  type Shadow,
  ShadowError,
  ShadowUnavailableError,
  shadowOps,
} from '../shadow.ts';
import { scrubUrl } from './pg.ts';
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

const MSSQL_SCHEME = /^(?:mssql|sqlserver):\/\//i;
const MSSQL_SYSTEM_DATABASES = new Set(['master', 'tempdb', 'model', 'msdb']);
const SHADOW_PROP_NAME = 'dowel_shadow';
const SHADOW_LIFECYCLE_LOCK_TIMEOUT_MS = 15_000;

const rawError = (e: unknown) => (e instanceof Error ? e.message : String(e));
const mssqlErrText = (e: unknown) => scrubSecrets(rawError(e));

const parseBoolParam = (raw: string | null, fallback: boolean): boolean => {
  if (raw === null) return fallback;
  const low = raw.trim().toLowerCase();
  if (low === 'true' || low === '1' || low === 'yes') return true;
  if (low === 'false' || low === '0' || low === 'no') return false;
  throw new HTTPException(422, { message: `MSSQL 连接串布尔参数值不合法：${raw}` });
};

const parseIntParam = (raw: string | null, fallback: number, name: string): number => {
  if (raw === null) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new HTTPException(422, { message: `MSSQL 连接串参数 ${name} 必须为正整数` });
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new HTTPException(422, { message: `MSSQL 连接串参数 ${name} 必须为正整数` });
  }
  return n;
};

const parsePort = (raw: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new HTTPException(422, { message: 'MSSQL 连接串端口号不合法' });
  }
  const p = Number.parseInt(raw, 10);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) {
    throw new HTTPException(422, { message: 'MSSQL 连接串端口号不合法' });
  }
  return p;
};

export interface ParsedMssqlUrl {
  scheme: string;
  user?: string;
  password?: string;
  server: string;
  instanceName?: string;
  port?: number;
  database: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  appName?: string;
}

/**
 * 解析 `mssql://` / `sqlserver://` 连接串（支持 `host:port`、`host\instance` 及查询参数）：
 * 默认严格保持 `encrypt: true`、`trustServerCertificate: false`，绝不私自放宽 TLS 证书校验。
 */
export const parseMssqlUrl = (
  url: string,
  opts: { connectTimeoutSec?: number; requestTimeoutMs?: number } = {},
): ParsedMssqlUrl => {
  const m = MSSQL_SCHEME.exec(url);
  if (!m) {
    throw new HTTPException(422, { message: 'MSSQL 连接串必须以 mssql:// 或 sqlserver:// 开头' });
  }
  const scheme = m[0];
  const rest = url.slice(scheme.length);
  const hashIdx = rest.indexOf('#');
  const withoutHash = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const qIdx = withoutHash.indexOf('?');
  const queryStr = qIdx >= 0 ? withoutHash.slice(qIdx + 1) : '';
  const beforeQuery = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash;
  const slashIdx = beforeQuery.indexOf('/');
  const authority = slashIdx >= 0 ? beforeQuery.slice(0, slashIdx) : beforeQuery;
  const rawDb = slashIdx >= 0 ? beforeQuery.slice(slashIdx + 1) : '';

  const atIdx = authority.lastIndexOf('@');
  const userinfo = atIdx >= 0 ? authority.slice(0, atIdx) : '';
  const hostPortRaw = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
  if (!hostPortRaw.trim()) {
    throw new HTTPException(422, { message: 'MSSQL 连接串缺少主机名' });
  }

  let user: string | undefined;
  let password: string | undefined;
  if (atIdx >= 0) {
    const colon = userinfo.indexOf(':');
    const rawUser = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
    const rawPass = colon >= 0 ? userinfo.slice(colon + 1) : undefined;
    try {
      user = decodeURIComponent(rawUser);
      password = rawPass !== undefined ? decodeURIComponent(rawPass) : undefined;
    } catch {
      throw new HTTPException(422, { message: 'MSSQL 连接串用户名或密码包含非法百分号编码' });
    }
  }

  let server = '';
  let instanceName: string | undefined;
  let port: number | undefined;
  const trimmedHostPort = hostPortRaw.trim();
  if (trimmedHostPort.startsWith('[')) {
    const end = trimmedHostPort.indexOf(']');
    if (end < 0) throw new HTTPException(422, { message: 'MSSQL 连接串中的 IPv6 地址不合法' });
    server = trimmedHostPort.slice(1, end);
    const tail = trimmedHostPort.slice(end + 1);
    if (tail) {
      if (!tail.startsWith(':')) {
        throw new HTTPException(422, { message: 'MSSQL 连接串中的 IPv6 地址不合法' });
      }
      port = parsePort(tail.slice(1));
    }
  } else {
    const colon = trimmedHostPort.lastIndexOf(':');
    const hostPart = colon >= 0 ? trimmedHostPort.slice(0, colon) : trimmedHostPort;
    if (colon >= 0) {
      port = parsePort(trimmedHostPort.slice(colon + 1));
    }
    const bs = hostPart.indexOf('\\');
    if (bs >= 0) {
      server = hostPart.slice(0, bs).trim();
      const inst = hostPart.slice(bs + 1).trim();
      if (!inst) throw new HTTPException(422, { message: 'MSSQL 命名实例名不能为空' });
      instanceName = inst;
    } else {
      server = hostPart.trim();
    }
  }
  if (!server) throw new HTTPException(422, { message: 'MSSQL 连接串缺少主机名' });
  if (port === undefined && !instanceName) port = 1433;

  let database = '';
  if (rawDb) {
    try {
      database = decodeURIComponent(rawDb);
    } catch {
      throw new HTTPException(422, { message: 'MSSQL 连接串数据库名包含非法百分号编码' });
    }
  }

  // 大小写不敏感解析 query 参数
  const params = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(queryStr)) {
    params.set(k.toLowerCase(), v);
  }
  const encrypt = parseBoolParam(params.get('encrypt') ?? null, true);
  const trustServerCertificate = parseBoolParam(params.get('trustservercertificate') ?? null, false);
  const defaultConnectMs = Math.max(1000, Math.trunc((opts.connectTimeoutSec ?? 10) * 1000));
  const connectTimeoutMs = parseIntParam(
    params.get('connecttimeout') ?? params.get('connectiontimeout') ?? null,
    defaultConnectMs,
    'connectTimeout',
  );
  const requestTimeoutMs = parseIntParam(
    params.get('requesttimeout') ?? null,
    opts.requestTimeoutMs ?? 30_000,
    'requestTimeout',
  );
  const appName = params.get('appname') ?? undefined;

  return {
    scheme,
    user,
    password,
    server,
    instanceName,
    port,
    database,
    encrypt,
    trustServerCertificate,
    connectTimeoutMs,
    requestTimeoutMs,
    appName,
  };
};

export const toMssqlConfig = (
  url: string,
  opts: { connectTimeoutSec?: number; requestTimeoutMs?: number; maxPool?: number } = {},
): sql.config => {
  const p = parseMssqlUrl(url, opts);
  const max = opts.maxPool ?? 1;
  return {
    server: p.server,
    ...(p.port !== undefined ? { port: p.port } : {}),
    ...(p.user !== undefined ? { user: p.user } : {}),
    ...(p.password !== undefined ? { password: p.password } : {}),
    ...(p.database ? { database: p.database } : {}),
    connectionTimeout: p.connectTimeoutMs,
    requestTimeout: p.requestTimeoutMs,
    pool: {
      max,
      min: 0,
      idleTimeoutMillis: 60_000,
    },
    options: {
      encrypt: p.encrypt,
      trustServerCertificate: p.trustServerCertificate,
      ...(p.instanceName ? { instanceName: p.instanceName } : {}),
      ...(p.appName ? { appName: p.appName } : {}),
      enableArithAbort: true,
    },
  };
};

/** 替换 MSSQL 连接串中的数据库名（保留 host\instance 与全部查询参数） */
export const withMssqlDb = (url: string, dbName: string): string => {
  const m = MSSQL_SCHEME.exec(url);
  if (!m) throw new HTTPException(422, { message: 'MSSQL 连接串必须以 mssql:// 或 sqlserver:// 开头' });
  const scheme = m[0];
  const rest = url.slice(scheme.length);
  const qIdx = rest.indexOf('?');
  const hIdx = rest.indexOf('#');
  const tailIdx = qIdx >= 0 && hIdx >= 0 ? Math.min(qIdx, hIdx) : qIdx >= 0 ? qIdx : hIdx;
  const tail = tailIdx >= 0 ? rest.slice(tailIdx) : '';
  const beforeTail = tailIdx >= 0 ? rest.slice(0, tailIdx) : rest;
  const slashIdx = beforeTail.indexOf('/');
  const authority = slashIdx >= 0 ? beforeTail.slice(0, slashIdx) : beforeTail;
  return `${scheme}${authority}/${encodeURIComponent(dbName)}${tail}`;
};

/** MSSQL 同实例影子库名：`{db}_dowel`，上限 128 字符（超出截断 + `_<8hex>_dowel`） */
export const mssqlShadowDbName = (db: string): string => {
  const full = `${db}_dowel`;
  if (Array.from(full).length <= MAX_MSSQL_IDENT) return full;
  const hash = createHash('sha256').update(db).digest('hex').slice(0, 8);
  let chars = Array.from(db);
  while (chars.length + 1 + hash.length + 6 > MAX_MSSQL_IDENT && chars.length > 1) {
    chars = chars.slice(0, -1);
  }
  return `${chars.join('')}_${hash}_dowel`;
};

const isMssqlInfraFailure = (e: unknown): boolean => {
  if (e instanceof ShadowError) return true;
  const code = mssqlErrorCode(e);
  if (
    code &&
    /^(ELOGIN|ETIMEOUT|ESOCKET|ECONNCLOSED|EINSTLOOKUP|ENOTOPEN|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH)$/.test(
      code,
    )
  ) {
    return true;
  }
  const num = mssqlErrorNumber(e);
  return num === 18456 || num === 4060 || num === -2;
};

const shadowSetupError = (e: unknown, step: 'create' | 'claim' | 'claim-read' | 'check'): Error => {
  if (e instanceof HTTPException || e instanceof ShadowError) return e;
  const msg = mssqlErrText(e);
  if (isMssqlInfraFailure(e)) return new ShadowUnavailableError(msg);
  if (step === 'create') return new ShadowError(`建影子库失败：${msg}`);
  if (step === 'check') return new ShadowError(`检查影子库失败：${msg}`);
  const num = mssqlErrorNumber(e);
  const noPriv = num === 229 || num === 262 || num === 15151 || num === 15247;
  if (step === 'claim-read') {
    return new ShadowError(
      noPriv
        ? `认领影子库失败：当前账号缺少读取系统目录的权限，无法核对目标库是否为空库或已打标记（${msg}）`
        : `认领影子库失败：${msg}`,
    );
  }
  return new ShadowError(
    noPriv
      ? `认领影子库失败：当前账号没有给该库写入 Dowel 影子库扩展属性的权限（${msg}）。请使用 db_owner 账号或让 DBA 提前标记`
      : `认领影子库失败：${msg}`,
  );
};

/** 延迟建立 MSSQL 连接（首次 query/exec 前才过 guard 与连接池建连） */
export const connectMssql = (
  url: string,
  connectTimeoutSec = 10,
  guard?: ConnectionGuard,
  requestTimeoutMs = 30_000,
): TargetConnection => {
  let pool: sql.ConnectionPool | null = null;
  let innerDb: Db | null = null;
  let opening: Promise<Db> | null = null;
  let closed = false;

  const ensureOpen = (): Promise<Db> => {
    if (closed) return Promise.reject(new ConnectError('MSSQL 连接已关闭'));
    if (innerDb) return Promise.resolve(innerDb);
    opening ??= (async () => {
      await guard?.(url);
      if (closed) throw new ConnectError('MSSQL 连接已关闭');
      const config = toMssqlConfig(url, { connectTimeoutSec, requestTimeoutMs, maxPool: 1 });
      const p = new sql.ConnectionPool(config);
      p.on('error', () => {});
      try {
        await p.connect();
      } catch (e) {
        await p.close().catch(() => {});
        throw e;
      }
      if (closed) {
        await p.close().catch(() => {});
        throw new ConnectError('MSSQL 连接已关闭');
      }
      pool = p;
      innerDb = fromMssql(p, config);
      return innerDb;
    })();
    return opening;
  };

  const db: Db = {
    query: async <T>(q: string, params?: unknown[]) => {
      const d = await ensureOpen();
      return d.query<T>(q, params);
    },
    exec: async (q: string) => {
      const d = await ensureOpen();
      await d.exec(q);
    },
    reserve: async () => {
      const d = await ensureOpen();
      return d.reserve ? d.reserve() : d;
    },
  };

  return {
    db,
    close: async () => {
      closed = true;
      const inFlight = opening;
      opening = null;
      if (inFlight) await inFlight.catch(() => null);
      const p = pool;
      pool = null;
      innerDb = null;
      await p?.close().catch(() => {});
    },
  };
};

export const inspectMssqlTargetOn = async (tdb: Db, url: string): Promise<TargetInfo> => {
  try {
    const [r] = await tdb.query<{
      version: string;
      major: number;
      minor: number;
      database: string;
      currentUser: string;
      isSysadmin: number;
      isDbcreator: number;
      canCreateAnyDb: number;
      canCreateSchema: number;
    }>(
      `SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS version,
              CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major,
              CAST(SERVERPROPERTY('ProductMinorVersion') AS int) AS minor,
              DB_NAME() AS [database],
              USER_NAME() AS currentUser,
              ISNULL(IS_SRVROLEMEMBER('sysadmin'), 0) AS isSysadmin,
              ISNULL(IS_SRVROLEMEMBER('dbcreator'), 0) AS isDbcreator,
              ISNULL(HAS_PERMS_BY_NAME(NULL, 'SERVER', 'CREATE ANY DATABASE'), 0) AS canCreateAnyDb,
              ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE SCHEMA'), 0) AS canCreateSchema`,
    );
    const database = r!.database;
    const shadow = mssqlShadowDbName(database);
    const [ex] = await tdb.query<{ n: number }>(`SELECT COUNT(*) AS n FROM sys.databases WHERE name = @p1`, [
      shadow,
    ]);
    const schemas = await tdb.query<SchemaInfo>(
      `SELECT s.name, COUNT(t.object_id) AS tables
         FROM sys.schemas s
         LEFT JOIN sys.tables t ON t.schema_id = s.schema_id AND t.is_ms_shipped = 0
        WHERE s.schema_id < 16384
          AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc', @p1)
          AND s.name NOT LIKE N'db[_]%'
        GROUP BY s.name
        ORDER BY s.name`,
      [MSSQL_DOWEL_SCHEMA],
    );
    const [dowel] = await tdb.query<{ hasSchema: number; hasMeta: number }>(
      `SELECT CASE WHEN SCHEMA_ID(@p1) IS NOT NULL THEN 1 ELSE 0 END AS hasSchema,
              CASE WHEN OBJECT_ID(N'[${MSSQL_DOWEL_SCHEMA}].[meta]', N'U') IS NOT NULL THEN 1 ELSE 0 END AS hasMeta`,
      [MSSQL_DOWEL_SCHEMA],
    );
    const major = Number(r!.major);
    const minor = Number(r!.minor ?? 0);
    return {
      version: String(r!.version).trim(),
      versionNum: major * 10000 + minor,
      database,
      canCreateDb:
        Number(r!.isSysadmin) === 1 || Number(r!.isDbcreator) === 1 || Number(r!.canCreateAnyDb) === 1,
      shadow,
      shadowExists: Number(ex?.n ?? 0) > 0,
      currentUser: r!.currentUser,
      superuser: Number(r!.isSysadmin) === 1,
      canCreateSchema: Number(r!.canCreateSchema) === 1 || Number(r!.isSysadmin) === 1,
      schemas: schemas.map((s) => ({ name: s.name, tables: Number(s.tables) })),
      dowelSchema: Number(dowel?.hasSchema ?? 0) === 1,
      dowelMeta: Number(dowel?.hasMeta ?? 0) === 1,
    };
  } catch (e) {
    if (e instanceof HTTPException || e instanceof ConnectError) throw e;
    throw new ConnectError(`连接失败：${scrubUrl(rawError(e), url)}`);
  }
};

export const inspectMssqlTarget = async (
  url: string,
  connectTimeout = CHECK_CONNECT_TIMEOUT,
  guard?: ConnectionGuard,
): Promise<TargetInfo> => {
  const c = connectMssql(url, connectTimeout, guard);
  try {
    return await inspectMssqlTargetOn(c.db, url);
  } finally {
    await c.close();
  }
};

const isMarkedMssql = async (db: Db): Promise<boolean> => {
  const [r] = await db.query<{ v: string | null }>(
    `SELECT CAST(value AS nvarchar(max)) AS v
       FROM sys.extended_properties
      WHERE class = 0 AND major_id = 0 AND minor_id = 0 AND name = @p1`,
    [SHADOW_PROP_NAME],
  );
  return r?.v === SHADOW_MARK;
};

const tryAppLock = async (db: Db, resource: string, timeoutMs: number): Promise<boolean> => {
  const [r] = await db.query<{ rc: number }>(
    `DECLARE @rc int;
     EXEC @rc = sys.sp_getapplock
       @Resource = @p1,
       @LockMode = 'Exclusive',
       @LockOwner = 'Session',
       @LockTimeout = @p2;
     SELECT @rc AS rc;`,
    [resource.slice(0, 255), Math.max(0, Math.trunc(timeoutMs))],
  );
  return Number(r?.rc ?? -999) >= 0;
};

const releaseAppLock = async (db: Db, resource: string): Promise<boolean> => {
  const [r] = await db
    .query<{ rc: number }>(
      `DECLARE @rc int;
       EXEC @rc = sys.sp_releaseapplock @Resource = @p1, @LockOwner = 'Session';
       SELECT @rc AS rc;`,
      [resource.slice(0, 255)],
    )
    .catch(() => [{ rc: -999 }]);
  return Number(r?.rc ?? -999) >= 0;
};

/** 在已有连接上认领影子库：先拒绝系统库/空库名，再核对 dowel_shadow 扩展属性或确认空库，然后打上 SHADOW_MARK */
export const claimMssqlShadowOn = async (db: Db): Promise<void> => {
  let phase: 'claim-read' | 'claim' = 'claim-read';
  try {
    const [ctx] = await db.query<{ dbName: string | null }>(`SELECT DB_NAME() AS dbName`);
    const currentDb = ctx?.dbName?.trim() ?? '';
    if (!currentDb || MSSQL_SYSTEM_DATABASES.has(currentDb.toLowerCase())) {
      throw new ShadowError(
        `拒绝使用 SQL Server 系统库或未指定数据库（${currentDb || '(empty)'}）作影子库，请指定独立的空用户数据库`,
      );
    }
    if (await isMarkedMssql(db)) return;
    const [counts] = await db.query<{
      objs: number;
      schemas: number;
      types: number;
      dbTriggers: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM sys.objects o
           JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE o.is_ms_shipped = 0 AND s.schema_id < 16384
            AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc')
            AND s.name NOT LIKE N'db[_]%'
            AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'TR', 'SO', 'SN')) AS objs,
         (SELECT COUNT(*) FROM sys.schemas s
          WHERE s.schema_id < 16384
            AND s.name NOT IN (N'dbo', N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc')
            AND s.name NOT LIKE N'db[_]%') AS schemas,
         (SELECT COUNT(*) FROM sys.types ty
           JOIN sys.schemas s ON s.schema_id = ty.schema_id
          WHERE ty.is_user_defined = 1 AND s.schema_id < 16384
            AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc')
            AND s.name NOT LIKE N'db[_]%') AS [types],
         (SELECT COUNT(*) FROM sys.triggers tr
          WHERE tr.parent_class = 0 AND tr.is_ms_shipped = 0) AS dbTriggers`,
    );
    if (
      Number(counts?.objs ?? 0) > 0 ||
      Number(counts?.schemas ?? 0) > 0 ||
      Number(counts?.types ?? 0) > 0 ||
      Number(counts?.dbTriggers ?? 0) > 0
    ) {
      throw new ShadowError(
        '拒绝使用这个库作影子库：它不是空库，也没有 Dowel 影子库标记。影子库每次检查前都会被清空',
      );
    }
    phase = 'claim';
    const [existingProp] = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sys.extended_properties
        WHERE class = 0 AND major_id = 0 AND minor_id = 0 AND name = @p1`,
      [SHADOW_PROP_NAME],
    );
    const proc =
      Number(existingProp?.n ?? 0) > 0 ? 'sys.sp_updateextendedproperty' : 'sys.sp_addextendedproperty';
    try {
      await db.exec(
        `EXEC ${proc} @name = ${mssqlLiteral(SHADOW_PROP_NAME)}, @value = ${mssqlLiteral(SHADOW_MARK)}`,
      );
    } catch (e) {
      // 并发认领可能同时写入同一个扩展属性（15233 Property already exists）
      if (mssqlErrorNumber(e) === 15233 && (await isMarkedMssql(db).catch(() => false))) return;
      throw e;
    }
  } catch (e) {
    throw shadowSetupError(e, phase);
  }
};

/** 认领影子库：先校验非系统库，再核对 dowel_shadow 扩展属性或确认空库，然后打上 SHADOW_MARK 防误删业务库 */
export const claimMssqlShadow = async (url: string, guard?: ConnectionGuard): Promise<void> => {
  const parsed = parseMssqlUrl(url);
  if (parsed.database && MSSQL_SYSTEM_DATABASES.has(parsed.database.toLowerCase())) {
    throw new ShadowError(
      `拒绝使用 SQL Server 系统库或未指定数据库（${parsed.database}）作影子库，请指定独立的空用户数据库`,
    );
  }
  const c = connectMssql(url, CHECK_CONNECT_TIMEOUT, guard);
  try {
    await claimMssqlShadowOn(c.db);
  } finally {
    await c.close();
  }
};

export const ensureSameInstanceMssqlShadow = async (
  targetUrl: string,
  guard?: ConnectionGuard,
): Promise<{ url: string; shadow: string; created: boolean }> => {
  const info = await inspectMssqlTarget(targetUrl, CHECK_CONNECT_TIMEOUT, guard);
  const url = withMssqlDb(targetUrl, info.shadow);
  let created = false;
  const c = connectMssql(targetUrl, 10, guard);
  const lockRes = `dowel_shadow_lifecycle:${info.shadow}`;
  let locked = false;
  try {
    if (!(await tryAppLock(c.db, lockRes, SHADOW_LIFECYCLE_LOCK_TIMEOUT_MS))) {
      throw new ShadowUnavailableError('影子库正在被其他请求初始化或清理，请稍后再试');
    }
    locked = true;
    const [ex] = await c.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM sys.databases WHERE name = @p1`, [
      info.shadow,
    ]);
    if (Number(ex?.n ?? 0) === 0) {
      if (!info.canCreateDb) {
        throw new ShadowError(
          `当前账号没有建库权限。请在目标实例上手动执行：CREATE DATABASE ${mssqlIdent(info.shadow)};`,
        );
      }
      try {
        await c.db.exec(`CREATE DATABASE ${mssqlIdent(info.shadow)}`);
        created = true;
      } catch (e) {
        // 1801 = Database already exists（并发建库回退复用）
        if (mssqlErrorNumber(e) !== 1801) throw shadowSetupError(e, 'create');
      }
    }
    await claimMssqlShadow(url, guard);
  } catch (e) {
    throw shadowSetupError(e, 'create');
  } finally {
    if (locked) await releaseAppLock(c.db, lockRes);
    await c.close().catch(() => {});
  }
  return { url, shadow: info.shadow, created };
};

export const dropMssqlSameInstanceShadow = async (
  targetUrl: string,
  name: string,
  guard?: ConnectionGuard,
): Promise<void> => {
  const c = connectMssql(targetUrl, 10, guard);
  const lockRes = `dowel_shadow_lifecycle:${name}`;
  let locked = false;
  try {
    if (!(await tryAppLock(c.db, lockRes, 0))) return;
    locked = true;

    const [ex] = await c.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM sys.databases WHERE name = @p1`, [
      name,
    ]);
    if (Number(ex?.n ?? 0) === 0) return;

    // 切到影子库核实 SHADOW_MARK 并确认无正在进行的检查
    const probe = connectMssql(withMssqlDb(targetUrl, name), CHECK_CONNECT_TIMEOUT, guard);
    let probeLocked = false;
    try {
      if (!(await tryAppLock(probe.db, 'dowel_shadow', 0))) return;
      probeLocked = true;
      if (!(await isMarkedMssql(probe.db))) return;
    } catch (e) {
      if (mssqlErrorNumber(e) === 4060) return; // 数据库已不存在
      console.error('清理 MSSQL 影子库前检查失败，跳过删除', name, mssqlErrText(e));
      return;
    } finally {
      if (probeLocked) await releaseAppLock(probe.db, 'dowel_shadow');
      await probe.close().catch(() => {});
    }

    const q = mssqlIdent(name);
    await c.db.exec(`IF DB_ID(${mssqlLiteral(name)}) IS NOT NULL DROP DATABASE ${q};`);
  } catch (e) {
    // 3702 = Cannot drop database because it is currently in use（有其他并发会话在使用，安全跳过）
    if (mssqlErrorNumber(e) === 3702) return;
    console.error('清理 MSSQL 影子库失败', name, mssqlErrText(e));
  } finally {
    if (locked) await releaseAppLock(c.db, lockRes);
    await c.close().catch(() => {});
  }
};

export const mssqlShadow = (
  shadowUrl: string,
  schemas?: string[] | null,
  guard?: ConnectionGuard,
): Shadow => {
  const expectedDb = parseMssqlUrl(shadowUrl).database;
  const checkDbMatches = async (db: Db): Promise<boolean> => {
    const [r] = await db.query<{ dbName: string | null }>(`SELECT DB_NAME() AS dbName`);
    const cur = r?.dbName?.trim() ?? '';
    if (!cur || MSSQL_SYSTEM_DATABASES.has(cur.toLowerCase())) return false;
    return !expectedDb || cur.toLowerCase() === expectedDb.toLowerCase();
  };
  // 串行、懒建连、关闭后永不重连（Issue #154，见 serialShadowConnection）
  const session = serialShadowConnection(() =>
    connectMssql(shadowUrl, 10, guard, SHADOW_STATEMENT_TIMEOUT_MS),
  );
  const run = <T>(fn: (ops: ReturnType<typeof shadowOps>) => Promise<T>): Promise<T> =>
    session.run(async ({ db }, discard) => {
      try {
        await db.exec('SET LOCK_TIMEOUT 10000');
        setMssqlShadowGuard(db, { expectedDb, mark: SHADOW_MARK });
        if (!(await tryAppLock(db, 'dowel_shadow', 60_000))) {
          throw new ShadowUnavailableError('正被其他检查占用，请稍后再试');
        }
      } catch (e) {
        await discard();
        throw e instanceof ShadowError ? e : new ShadowUnavailableError(`连接失败：${mssqlErrText(e)}`);
      }
      let clean = false;
      try {
        if (!(await checkDbMatches(db).catch((e) => Promise.reject(shadowSetupError(e, 'check'))))) {
          throw new ShadowError(`拒绝执行：影子库会话当前数据库与预期（${expectedDb}）不一致`);
        }
        if (!(await isMarkedMssql(db).catch((e) => Promise.reject(shadowSetupError(e, 'check'))))) {
          throw new ShadowError('拒绝执行：影子库的 Dowel 标记不见了');
        }
        const result = await fn(shadowOps(async () => db, schemas, { dialect: 'mssql' }));
        // 执行后复核会话上下文与影子库标记，防止动态 SQL 切换库后污染后续复用连接
        const stillSafe =
          (await checkDbMatches(db).catch(() => false)) && (await isMarkedMssql(db).catch(() => false));
        clean = stillSafe;
        return result;
      } finally {
        const unlocked = await releaseAppLock(db, 'dowel_shadow');
        if (!clean || !unlocked) await discard();
      }
    });
  return {
    importSql: (sqlText) => run((ops) => ops.importSql(sqlText)),
    verify: (from, to, opts): Promise<VerifyReport> => run((ops) => ops.verify(from, to, opts)),
    verifyScripts: (from, to, up, down, options): Promise<VerifyReport> =>
      run((ops) => ops.verifyScripts(from, to, up, down, options)),
    canonicalize: (prev, next) => run((ops) => ops.canonicalize(prev, next)),
    close: () => session.close(),
  };
};

export const pullMssqlSchema = async (
  url: string,
  schemas?: string[] | null,
  guard?: ConnectionGuard,
): Promise<Model> => {
  const c = connectMssql(url, CHECK_CONNECT_TIMEOUT, guard);
  try {
    return importMssqlSnapshot(await readMssqlSnapshot(c.db, schemas));
  } catch (e) {
    if (e instanceof HTTPException || e instanceof ConnectError) throw e;
    throw new ConnectError(`读取结构失败：${scrubUrl(rawError(e), url)}`);
  } finally {
    await c.close();
  }
};

export const prepareMssqlShadow = async (
  env: ShadowSource | null,
  schemas: string[] | null,
  guard?: ConnectionGuard,
): Promise<PreparedShadow> => {
  if (!env) {
    throw new ShadowError(
      '项目还没有配置环境。导入 SQL、验证迁移都需要一个真实的 SQL Server 实例作影子库，请先在“环境”里添加项目要部署到的数据库',
      { preConnect: true },
    );
  }
  let url = env.shadowUrl ?? null;
  let created: { targetUrl: string; name: string } | null = null;
  if (!url) {
    if (env.production && !env.allowSameInstance) {
      throw new ShadowError(
        `环境“${env.name}”是生产环境，默认不在同一实例上建影子库（检查会占用生产实例的资源）。请为它配置单独的影子库实例，或明确允许使用同一实例`,
        { preConnect: true },
      );
    }
    const prepared = await ensureSameInstanceMssqlShadow(env.url, guard).catch((e: unknown) => {
      throw e instanceof ConnectError ? new ShadowUnavailableError(e.message) : e;
    });
    url = prepared.url;
    if (prepared.created) created = { targetUrl: env.url, name: prepared.shadow };
  }
  const dbLabel = parseMssqlUrl(url).database || 'master';
  return {
    shadow: mssqlShadow(url, schemas, guard),
    label: `${env.name}：${dbLabel}`,
    url,
    created,
  };
};

export const mssqlTargetDriver: TargetDriver = {
  dialect: 'mssql',
  shadowDbName: mssqlShadowDbName,
  connect: (url, connectTimeoutSec, guard) => connectMssql(url, connectTimeoutSec, guard),
  inspectTarget: inspectMssqlTarget,
  inspectTargetOn: inspectMssqlTargetOn,
  pullSchema: pullMssqlSchema,
  claimShadow: claimMssqlShadow,
  prepareShadow: prepareMssqlShadow,
  dropSameInstanceShadow: dropMssqlSameInstanceShadow,
  classifyDriverError: (e) => {
    const code = mssqlErrorCode(e);
    const num = mssqlErrorNumber(e);
    if (
      (code !== null &&
        /^(ELOGIN|ETIMEOUT|ESOCKET|ECONNCLOSED|EINSTLOOKUP|ENOTOPEN|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)/.test(
          code,
        )) ||
      num === 18456 ||
      num === 4060
    ) {
      return 'connect';
    }
    if (
      code === 'EREQUEST' ||
      code === 'EABORT' ||
      num !== null ||
      (e instanceof Error && (e.name === 'RequestError' || e.name === 'TransactionError'))
    ) {
      return 'database';
    }
    return null;
  },
};
