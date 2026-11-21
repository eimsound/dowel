// SSRF 防护：服务端会替用户去连他给的数据库地址，所以实例可以限定“能连到哪里”。
// 白名单项是 CIDR（IPv4 / IPv6）或主机名，空列表表示不限制（自托管默认）。
// 检查顺序：先看主机名是否在列表里，再把主机名解析成 IP，看解析结果是否落在某个 CIDR 里
// （列表里的主机名也先解析，避免两边的 DNS 结果写法不同）。
// PG 协议没有重定向，所以不需要考虑跟随重定向。
import { lookup } from 'node:dns/promises';
import { lstat, readlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

import type { Dialect } from '@dowel/core';
import { HTTPException } from 'hono/http-exception';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4 → 4 字节；非法返回 null */
export const v4Bytes = (ip: string): number[] | null => {
  const m = IPV4.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
};

/** IPv6 → 16 字节（支持 :: 缩写和末尾的 IPv4 写法）；非法返回 null */
export const v6Bytes = (ip: string): number[] | null => {
  let s = ip.toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      const v4 = v4Bytes(group);
      if (v4) {
        out.push(v4[0]!, v4[1]!, v4[2]!, v4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const n = Number.parseInt(group, 16);
      out.push(n >> 8, n & 0xff);
    }
    return out;
  };
  const head = parse(halves[0]!);
  if (!head) return null;
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!tail) return null;
  const fill = 16 - head.length - tail.length;
  if (halves.length === 1 && fill !== 0) return null;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
};

export const bytesOf = (ip: string): number[] | null => v4Bytes(ip) ?? v6Bytes(ip);

/** IPv4-mapped IPv6（::ffff:1.2.3.4）按 IPv4 再看一遍 */
export const mappedV4 = (ip: string): string | null => {
  const b = v6Bytes(ip);
  if (b?.length !== 16) return null;
  if (!b.slice(0, 10).every((x) => x === 0) || b[10] !== 0xff || b[11] !== 0xff) return null;
  return b.slice(12).join('.');
};

export const inCidr = (ip: string, cidr: string): boolean => {
  const [base, bitsText] = cidr.split('/');
  if (!base || bitsText === undefined) return false;
  const a = bytesOf(ip);
  const b = bytesOf(base);
  if (!a || !b || a.length !== b.length) return false;
  const bits = Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > a.length * 8) return false;
  let left = bits;
  for (let i = 0; i < a.length && left > 0; i++) {
    const take = Math.min(8, left);
    const mask = 0xff << (8 - take);
    if ((a[i]! & mask) !== (b[i]! & mask)) return false;
    left -= take;
  }
  return true;
};

/** 解析一个白名单项：CIDR、IP 或主机名 */
export const isCidr = (entry: string) => entry.includes('/');

/** 主机名（不含端口）：只允许字母、数字、-、. 和下划线 */
const isHostname = (entry: string) =>
  entry.length > 0 &&
  entry.length <= 253 &&
  /^[a-zA-Z0-9_.-]+$/.test(entry) &&
  !entry.startsWith('.') &&
  !entry.endsWith('.');

/** 白名单项是否合法（保存设置时校验，避免写错以后谁都连不上） */
export const validAllowlistEntry = (entry: string): boolean => {
  const v = entry.trim();
  if (!v) return false;
  if (isCidr(v)) {
    const [base, bits] = v.split('/');
    if (!base || bits === undefined || !/^\d{1,3}$/.test(bits)) return false;
    const bytes = bytesOf(base);
    if (!bytes) return false;
    const n = Number(bits);
    return n >= 0 && n <= bytes.length * 8;
  }
  return isIP(v) !== 0 || isHostname(v);
};

/** 文本 → 白名单项：逗号、空格、换行都算分隔符 */
export const parseAllowlist = (items: string[] | string | undefined | null): string[] => {
  const raw = Array.isArray(items) ? items : String(items ?? '').split(/[\s,]+/);
  return raw.map((s) => s.trim()).filter(Boolean);
};

const lookupIps = async (host: string): Promise<string[]> => {
  if (isIP(host)) return [host];
  try {
    const rows = await lookup(host, { all: true, verbatim: true });
    return rows.map((r) => r.address);
  } catch {
    return [];
  }
};

/**
 * 地址是否允许连接：白名单为空表示不限制；否则主机名或它解析出的任一 IP 要在列表里。
 * 解析不出 IP 的主机名一律拒绝（宁可连不上，也不要让服务端去连一个说了不算的地址）。
 */
export const isAllowedHost = async (host: string, allowlist: string[]): Promise<boolean> => {
  if (!allowlist.length) return true;
  const name = host.toLowerCase();
  const ips = await lookupIps(name);
  const alternates = [name, ...ips.flatMap((ip) => (mappedV4(ip) ? [mappedV4(ip)!] : []))];
  for (const entry of allowlist) {
    const e = entry.trim().toLowerCase();
    if (!e) continue;
    if (isCidr(e)) {
      if (ips.some((ip) => inCidr(ip, e))) return true;
      continue;
    }
    // 主机名：直接相等，或者两边解析出的 IP 有交集
    if (e === name) return true;
    const entryIps = await lookupIps(e);
    if (entryIps.some((ip) => alternates.includes(ip))) return true;
  }
  return false;
};

/** URL 的主机名以外的部分交给驱动，这里关心的是“实际要连哪些主机” */
export interface ConnectionTarget {
  /** 主机名或 IP（已去掉 IPv6 的方括号、转小写） */
  host: string;
  port: number | null;
}

const POSTGRES_SCHEME = /^postgres(?:ql)?:\/\//i;
const MYSQL_SCHEME = /^mysql:\/\//i;
const MSSQL_SCHEME = /^(?:mssql|sqlserver):\/\//i;
const SQLITE_SCHEME = /^sqlite:\/\//i;

/** 从连接串协议推断方言 */
export const detectUrlDialect = (url: string): Dialect | null => {
  if (POSTGRES_SCHEME.test(url)) return 'pg';
  if (SQLITE_SCHEME.test(url)) return 'sqlite';
  if (MYSQL_SCHEME.test(url)) return 'mysql';
  if (MSSQL_SCHEME.test(url)) return 'mssql';
  return null;
};

/** 校验连接串协议与项目方言一致（不一致返回 422） */
export const assertUrlMatchesDialect = (url: string, dialect: Dialect): void => {
  const actual = detectUrlDialect(url);
  if (actual === dialect) return;
  const expected: Record<Dialect, string> = {
    pg: 'postgres:// 或 postgresql://',
    sqlite: 'sqlite:///',
    mysql: 'mysql://',
    mssql: 'mssql:// 或 sqlserver://',
  };
  throw new HTTPException(422, {
    message: `连接串协议与项目方言（${dialect}）不匹配：必须以 ${expected[dialect]} 开头`,
  });
};

/** 服务端默认 SQLite 平台库路径（与 main.ts 共享，防止未显式设置 DOWEL_DB 时漏掉平台库自保护） */
export const DEFAULT_SQLITE_PLATFORM_DB = './data/dowel.db';

const MAX_SYMLINK_DEPTH = 40;

/**
 * 逐段消解路径中的符号链接（包括悬空符号链接与中间目录符号链接），防止通过悬空软链越出白名单目录。
 * 遇到符号链接循环时抛出 422。
 */
const resolveRealWithMissingTail = async (absPath: string, depth = 0): Promise<string> => {
  if (depth > MAX_SYMLINK_DEPTH) {
    throw new HTTPException(422, { message: 'SQLite 目标库路径存在符号链接循环' });
  }
  const resolved = path.resolve(absPath);
  const { root } = path.parse(resolved);
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(cur, parts[i]!);
    let st;
    try {
      st = await lstat(next);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') {
        return path.join(cur, ...parts.slice(i));
      }
      throw new HTTPException(422, { message: 'SQLite 目标库路径无法访问或包含非法路径段' });
    }
    if (st.isSymbolicLink()) {
      const linkTarget = await readlink(next);
      const targetAbs = path.resolve(cur, linkTarget);
      return resolveRealWithMissingTail(path.join(targetAbs, ...parts.slice(i + 1)), depth + 1);
    }
    cur = next;
  }
  return cur;
};

/** 解析并校验本地 SQLite 目标库路径（DOWEL_SQLITE_ROOTS 白名单 + 防符号链接越权 + 禁止指向 DOWEL_DB 平台库） */
export const resolveSqlitePath = async (
  url: string,
  opts: { rootsEnv?: string; platformDbEnv?: string; platformDbPath?: string } = {},
): Promise<string> => {
  if (!SQLITE_SCHEME.test(url)) {
    throw new HTTPException(422, { message: 'SQLite 连接串必须以 sqlite:///绝对路径 开头' });
  }
  const rest = url.slice('sqlite://'.length);
  if (!rest || rest.startsWith(':memory:') || rest.includes('?') || rest.includes('#')) {
    throw new HTTPException(422, {
      message: 'SQLite 目标库连接串必须为 sqlite:///绝对路径，不支持 :memory: 或查询参数',
    });
  }
  if (!rest.startsWith('/')) {
    throw new HTTPException(422, {
      message: 'SQLite 目标库连接串必须使用绝对路径（sqlite:///path/to/app.db）',
    });
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    throw new HTTPException(422, { message: 'SQLite 连接串路径包含非法百分号编码' });
  }
  if (decoded.includes('\0') || decoded.split('/').includes('..')) {
    throw new HTTPException(422, { message: 'SQLite 连接串路径不合法（禁止包含空字节或 ..）' });
  }

  const rawRoots = (opts.rootsEnv ?? process.env.DOWEL_SQLITE_ROOTS ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!rawRoots.length) {
    throw new HTTPException(422, {
      message:
        '服务端默认禁用直连本地 SQLite 文件：请在服务端配置环境变量 DOWEL_SQLITE_ROOTS（冒号分隔的绝对目录白名单）后再连接本地 SQLite 目标库',
    });
  }

  const resolvedTarget = await resolveRealWithMissingTail(decoded);
  const resolvedRoots: string[] = [];
  for (const r of rawRoots) {
    if (!path.isAbsolute(r)) continue;
    resolvedRoots.push(await resolveRealWithMissingTail(r));
  }
  const allowed = resolvedRoots.some((root) => {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return resolvedTarget !== root && resolvedTarget.startsWith(prefix);
  });
  if (!allowed) {
    throw new HTTPException(422, {
      message: 'SQLite 目标库路径不在服务端允许的目录范围（DOWEL_SQLITE_ROOTS）内',
    });
  }

  // 严禁指向平台库自身路径（含 WAL/SHM/Journal 附属文件），涵盖实际打开的平台库路径及默认 ./data/dowel.db
  const protectedDbs = new Set<string>();
  if (opts.platformDbPath) protectedDbs.add(opts.platformDbPath);
  if (opts.platformDbEnv !== undefined) {
    if (opts.platformDbEnv) protectedDbs.add(opts.platformDbEnv);
  } else {
    protectedDbs.add(process.env.DOWEL_DB || DEFAULT_SQLITE_PLATFORM_DB);
  }
  for (const platformDb of protectedDbs) {
    if (!platformDb || platformDb === ':memory:' || /^postgres(?:ql)?:\/\//i.test(platformDb)) continue;
    const realPlatform = await resolveRealWithMissingTail(platformDb);
    if (
      resolvedTarget === realPlatform ||
      resolvedTarget === `${realPlatform}-wal` ||
      resolvedTarget === `${realPlatform}-shm` ||
      resolvedTarget === `${realPlatform}-journal`
    ) {
      throw new HTTPException(422, {
        message: '禁止将 Dowel 平台库自身（DOWEL_DB）配置为 SQLite 目标库',
      });
    }
  }

  return resolvedTarget;
};

/** 解析 authority 里的一个 host[:port]（支持 [IPv6]:port 与 MSSQL host\instance）；unix socket 直接拒绝 */
const parseHostPort = (entry: string, allowInstanceName = false): ConnectionTarget => {
  const decoded = (() => {
    try {
      return decodeURIComponent(entry);
    } catch {
      throw new HTTPException(422, { message: '连接串里的主机名不合法' });
    }
  })();
  if (decoded.startsWith('/'))
    throw new HTTPException(422, {
      message:
        '不支持用 unix socket 连数据库（实例的 connection_allowlist 只能限制 TCP 地址），请写主机名和端口',
    });
  if (decoded.startsWith('[')) {
    const end = decoded.indexOf(']');
    if (end < 0) throw new HTTPException(422, { message: '连接串里的 IPv6 地址不合法' });
    const rest = decoded.slice(end + 1);
    if (rest && !rest.startsWith(':')) {
      throw new HTTPException(422, { message: '连接串里的 IPv6 地址不合法' });
    }
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : null;
    return { host: decoded.slice(1, end).toLowerCase(), port: Number.isFinite(port) ? port : null };
  }
  const colon = decoded.lastIndexOf(':');
  const rawHost = colon >= 0 ? decoded.slice(0, colon) : decoded;
  const host = allowInstanceName ? rawHost.split('\\')[0]! : rawHost;
  const port = colon >= 0 ? Number(decoded.slice(colon + 1)) : null;
  return {
    host: host.toLowerCase(),
    port: port !== null && Number.isFinite(port) ? port : null,
  };
};

/**
 * 连接串里实际要连的 TCP 目标（按协议分派）：
 * - postgres(ql)?://：支持逗号分隔多主机；禁 ?host= / ?hostaddr= 与 unix socket；
 * - mysql://：禁 ?socketPath= 与 unix socket；
 * - mssql:// / sqlserver://：支持 host[:port] 与 host\instance；
 * - sqlite://：非 TCP 目标（走 resolveSqlitePath 目录白名单守卫），返回空数组。
 */
export const connectionTargets = (url: string): ConnectionTarget[] => {
  if (SQLITE_SCHEME.test(url)) return [];
  const scheme = POSTGRES_SCHEME.exec(url) ?? MYSQL_SCHEME.exec(url) ?? MSSQL_SCHEME.exec(url);
  if (!scheme) {
    throw new HTTPException(422, {
      message: '连接串必须以 postgres://、sqlite://、mysql:// 或 mssql:// 开头',
    });
  }
  const dialect = detectUrlDialect(url)!;
  const rest = url.slice(scheme[0].length);
  const hash = rest.indexOf('#');
  const withoutHash = hash >= 0 ? rest.slice(0, hash) : rest;
  const q = withoutHash.indexOf('?');
  const query = q >= 0 ? withoutHash.slice(q + 1) : '';
  const beforeQuery = q >= 0 ? withoutHash.slice(0, q) : withoutHash;
  const slash = beforeQuery.indexOf('/');
  const authority = slash >= 0 ? beforeQuery.slice(0, slash) : beforeQuery;

  const params = new URLSearchParams(query);
  if (dialect === 'pg') {
    for (const key of ['host', 'hostaddr'] as const)
      if (params.has(key))
        throw new HTTPException(422, {
          message: `不支持在连接串里用 ?${key}= 指定主机（它可以绕过实例的允许列表），请把主机写进 postgres://主机:端口/库`,
        });
  } else if (dialect === 'mysql') {
    for (const k of params.keys()) {
      if (k.toLowerCase() === 'socketpath') {
        throw new HTTPException(422, {
          message: '不支持在 MySQL 连接串里使用 socketPath（无法通过主机白名单校验），请使用 TCP 地址',
        });
      }
    }
  }

  const at = authority.lastIndexOf('@');
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  if (!hostPort.trim()) throw new HTTPException(422, { message: '连接串里没有主机' });
  if (dialect === 'pg') {
    return hostPort.split(',').map((entry) => parseHostPort(entry.trim()));
  }
  return [parseHostPort(hostPort.trim(), dialect === 'mssql')];
};

/**
 * 连接地址的 SSRF / 本地目录边界检查：
 * - sqlite:// → 校验 DOWEL_SQLITE_ROOTS 目录白名单与防 DOWEL_DB 碰撞；
 * - postgres(ql)?:// / mysql:// / mssql:// / sqlserver:// → 校验主机白名单。
 */
export const assertUrlAllowed = async (
  url: string,
  allowlist: string[],
  opts?: { platformDbPath?: string },
): Promise<void> => {
  if (SQLITE_SCHEME.test(url)) {
    await resolveSqlitePath(url, { platformDbPath: opts?.platformDbPath });
    return;
  }
  for (const target of connectionTargets(url)) {
    if (await isAllowedHost(target.host, allowlist)) continue;
    throw new HTTPException(422, {
      message: `连接地址 ${target.host} 不在实例允许的范围内（实例设置里的 connection_allowlist）`,
    });
  }
};
