// SSRF 防护：服务端会替用户去连他给的数据库地址，所以实例可以限定“能连到哪里”。
// 白名单项是 CIDR（IPv4 / IPv6）或主机名，空列表表示不限制（自托管默认）。
// 检查顺序：先看主机名是否在列表里，再把主机名解析成 IP，看解析结果是否落在某个 CIDR 里
// （列表里的主机名也先解析，避免两边的 DNS 结果写法不同）。
// PG 协议没有重定向，所以不需要考虑跟随重定向。
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HTTPException } from 'hono/http-exception';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4 → 4 字节；非法返回 null */
const v4Bytes = (ip: string): number[] | null => {
  const m = IPV4.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
};

/** IPv6 → 16 字节（支持 :: 缩写和末尾的 IPv4 写法）；非法返回 null */
const v6Bytes = (ip: string): number[] | null => {
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

const bytesOf = (ip: string): number[] | null => v4Bytes(ip) ?? v6Bytes(ip);

/** IPv4-mapped IPv6（::ffff:1.2.3.4）按 IPv4 再看一遍 */
const mappedV4 = (ip: string): string | null => {
  const b = v6Bytes(ip);
  if (b?.length !== 16) return null;
  if (!b.slice(0, 10).every((x) => x === 0) || b[10] !== 0xff || b[11] !== 0xff) return null;
  return b.slice(12).join('.');
};

const inCidr = (ip: string, cidr: string): boolean => {
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

/** 解析 authority 里的一个 host[:port]（也支持 [IPv6]:port）；unix socket 直接拒绝 */
const parseHostPort = (entry: string): ConnectionTarget => {
  const decoded = (() => {
    try {
      return decodeURIComponent(entry);
    } catch {
      throw new HTTPException(422, { message: '连接串里的主机名不合法' });
    }
  })();
  // unix socket（postgres://%2Fvar%2Frun/postgresql 或主机以 / 开头）：白名单对它没有意义，直接拒绝
  if (decoded.startsWith('/'))
    throw new HTTPException(422, {
      message:
        '不支持用 unix socket 连数据库（实例的 connection_allowlist 只能限制 TCP 地址），请写主机名和端口',
    });
  if (decoded.startsWith('[')) {
    const end = decoded.indexOf(']');
    if (end < 0) throw new HTTPException(422, { message: '连接串里的 IPv6 地址不合法' });
    const rest = decoded.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : null;
    return { host: decoded.slice(1, end).toLowerCase(), port: Number.isFinite(port) ? port : null };
  }
  const colon = decoded.lastIndexOf(':');
  if (colon >= 0) {
    const port = Number(decoded.slice(colon + 1));
    return {
      host: decoded.slice(0, colon).toLowerCase(),
      port: Number.isFinite(port) ? port : null,
    };
  }
  return { host: decoded.toLowerCase(), port: null };
};

/**
 * 连接串里实际要连的目标（可能多个）：
 * - authority 可以是逗号分隔的多个 host:port（postgres.js 支持故障转移），**每一个都要检查**；
 * - `?host=` / `?hostaddr=` 会覆盖 authority 里的主机 —— 这等于绕过白名单，直接拒绝；
 * - unix socket（主机以 `/` 开头）也拒绝；
 * - `?port=` 只改端口、不改主机，不影响白名单判断（但一并解析出来，避免漏掉“实际要连到哪里”）。
 *
 * 不用 `new URL()` 解析 authority：Node 的 URL 不接受逗号分隔的多主机，会把合法的连接串当成非法。
 */
export const connectionTargets = (url: string): ConnectionTarget[] => {
  const scheme = POSTGRES_SCHEME.exec(url);
  if (!scheme) throw new HTTPException(422, { message: '连接串必须以 postgres:// 或 postgresql:// 开头' });
  const rest = url.slice(scheme[0].length);
  const hash = rest.indexOf('#');
  const withoutHash = hash >= 0 ? rest.slice(0, hash) : rest;
  const q = withoutHash.indexOf('?');
  const query = q >= 0 ? withoutHash.slice(q + 1) : '';
  const beforeQuery = q >= 0 ? withoutHash.slice(0, q) : withoutHash;
  const slash = beforeQuery.indexOf('/');
  const authority = slash >= 0 ? beforeQuery.slice(0, slash) : beforeQuery;

  const params = new URLSearchParams(query);
  for (const key of ['host', 'hostaddr'] as const)
    if (params.has(key))
      throw new HTTPException(422, {
        message: `不支持在连接串里用 ?${key}= 指定主机（它可以绕过实例的允许列表），请把主机写进 postgres://主机:端口/库`,
      });

  const at = authority.lastIndexOf('@');
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  if (!hostPort.trim()) throw new HTTPException(422, { message: '连接串里没有主机' });
  return hostPort.split(',').map((entry) => parseHostPort(entry.trim()));
};

/**
 * 连接地址的 SSRF 检查：只允许 postgres:// / postgresql://，并且**每个**主机都要在白名单里。
 * 不通过时抛 422（和“连不上”一样是用户可修正的错误，不是服务器错误）。
 */
export const assertUrlAllowed = async (url: string, allowlist: string[]): Promise<void> => {
  for (const target of connectionTargets(url)) {
    if (await isAllowedHost(target.host, allowlist)) continue;
    throw new HTTPException(422, {
      message: `连接地址 ${target.host} 不在实例允许的范围内（实例设置里的 connection_allowlist）`,
    });
  }
};
