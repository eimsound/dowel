// 数据库连接串与结构化字段双向解析 / 序列化：覆盖 PostgreSQL、MySQL、SQL Server 与 SQLite。
// 解析规则与服务端 drivers（pg / mysql / mssql / allowlist sqlite）保持一致。
import type { Dialect } from '@dowel/core';

export interface DbUrlFields {
  scheme: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  params: string;
  filePath: string;
}

export interface DialectUrlDefault {
  scheme: string;
  schemes: readonly string[];
  port: string;
  hostPlaceholder: string;
  paramsPlaceholder: string;
}

export const DIALECT_URL_DEFAULTS: Record<Dialect, DialectUrlDefault> = {
  pg: {
    scheme: 'postgres',
    schemes: ['postgres', 'postgresql'],
    port: '5432',
    hostPlaceholder: 'localhost',
    paramsPlaceholder: 'sslmode=require',
  },
  mysql: {
    scheme: 'mysql',
    schemes: ['mysql'],
    port: '3306',
    hostPlaceholder: 'localhost',
    paramsPlaceholder: 'ssl-mode=REQUIRED',
  },
  mssql: {
    scheme: 'mssql',
    schemes: ['mssql', 'sqlserver'],
    port: '1433',
    hostPlaceholder: 'localhost',
    paramsPlaceholder: 'encrypt=true&trustServerCertificate=true',
  },
  sqlite: {
    scheme: 'sqlite',
    schemes: ['sqlite'],
    port: '',
    hostPlaceholder: '',
    paramsPlaceholder: '',
  },
};

export const emptyDbUrlFields = (dialect: Dialect): DbUrlFields => ({
  scheme: DIALECT_URL_DEFAULTS[dialect].scheme,
  host: '',
  port: '',
  database: '',
  user: '',
  password: '',
  params: '',
  filePath: '',
});

const safeDecode = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * 解析连接串为结构化字段；空串返回全空字段，无法识别或正在输入中的半截地址返回 null。
 */
export const parseDbUrl = (rawUrl: string, dialect: Dialect): DbUrlFields | null => {
  const trimmed = rawUrl.trim();
  if (!trimmed) return emptyDbUrlFields(dialect);

  if (dialect === 'sqlite') {
    const m = /^sqlite:\/\/(.*)$/i.exec(trimmed);
    if (!m) return null;
    const rest = m[1]!;
    if (rest.includes('?') || rest.includes('#')) return null;
    return {
      ...emptyDbUrlFields('sqlite'),
      filePath: safeDecode(rest),
    };
  }

  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(trimmed);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  if (!DIALECT_URL_DEFAULTS[dialect].schemes.includes(scheme)) return null;

  const rest = m[2]!;
  const hashIdx = rest.indexOf('#');
  const withoutHash = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const qIdx = withoutHash.indexOf('?');
  const beforeQuery = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash;
  const params = qIdx >= 0 ? withoutHash.slice(qIdx + 1) : '';
  const slashIdx = beforeQuery.indexOf('/');
  const authority = slashIdx >= 0 ? beforeQuery.slice(0, slashIdx) : beforeQuery;
  const rawDb = slashIdx >= 0 ? beforeQuery.slice(slashIdx + 1) : '';

  const atIdx = authority.lastIndexOf('@');
  const userinfo = atIdx >= 0 ? authority.slice(0, atIdx) : '';
  const hostPortRaw = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;

  let user = '';
  let password = '';
  if (atIdx >= 0) {
    const colon = userinfo.indexOf(':');
    const rawUser = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
    const rawPass = colon >= 0 ? userinfo.slice(colon + 1) : undefined;
    user = safeDecode(rawUser);
    password = rawPass !== undefined ? safeDecode(rawPass) : '';
  }

  let host = '';
  let port = '';
  const trimmedHostPort = hostPortRaw.trim();
  if (trimmedHostPort.startsWith('[')) {
    const end = trimmedHostPort.indexOf(']');
    if (end < 0) return null;
    host = trimmedHostPort.slice(1, end);
    const tail = trimmedHostPort.slice(end + 1);
    if (tail) {
      if (!tail.startsWith(':')) return null;
      port = tail.slice(1);
    }
  } else {
    const firstColon = trimmedHostPort.indexOf(':');
    const lastColon = trimmedHostPort.lastIndexOf(':');
    if (firstColon >= 0 && firstColon === lastColon) {
      host = trimmedHostPort.slice(0, firstColon);
      port = trimmedHostPort.slice(firstColon + 1);
    } else {
      host = trimmedHostPort;
    }
  }

  return {
    scheme,
    host,
    port,
    database: rawDb ? safeDecode(rawDb) : '',
    user,
    password,
    params,
    filePath: '',
  };
};

/** 按结构化字段重新拼装对应方言的连接串 */
export const formatDbUrl = (fields: DbUrlFields, dialect: Dialect): string => {
  if (dialect === 'sqlite') {
    if (!fields.filePath.trim()) return '';
    const raw = fields.filePath.trim();
    const encoded = raw
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const absPath = encoded.startsWith('/') ? encoded : `/${encoded}`;
    return `sqlite://${absPath}`;
  }

  const host = fields.host.trim();
  const port = fields.port.trim();
  const database = fields.database.trim();
  const user = fields.user;
  const password = fields.password;
  const cleanParams = fields.params.trim().replace(/^\?+/, '');

  if (!host && !port && !database && !user && !password && !cleanParams) {
    return '';
  }

  const spec = DIALECT_URL_DEFAULTS[dialect];
  const lowerScheme = fields.scheme.toLowerCase();
  const scheme = spec.schemes.includes(lowerScheme) ? lowerScheme : spec.scheme;

  const auth =
    user !== '' || password !== ''
      ? `${encodeURIComponent(user)}${password !== '' ? `:${encodeURIComponent(password)}` : ''}@`
      : '';
  const hostOut = host.includes(':') && !(host.startsWith('[') && host.endsWith(']')) ? `[${host}]` : host;
  const portOut = port ? `:${port}` : '';
  const dbOut = database ? `/${encodeURIComponent(database)}` : '';
  const queryOut = cleanParams ? `?${cleanParams}` : '';

  return `${scheme}://${auth}${hostOut}${portOut}${dbOut}${queryOut}`;
};
