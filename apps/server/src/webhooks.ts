// 组级 Webhook（P5b，E8）：各预设格式的渲染与签名、出站限制（SSRF）、异步投递与有限次重试、投递记录。
// 取舍见 ADR 0008（.agents/docs/adr/0008-webhook-outbound.md）：
// - 出站限制：默认只允许公网地址；实例设置 webhookAllowlist 里的 CIDR / 主机名额外放行。
//   检查在**真正连接时**做（给 http.request 传自定义 lookup，对解析出的每个地址判断），DNS 重绑定绕不过去；
//   URL 主机是 IP 字面量时不会调用 lookup，发请求前单独检查；
// - 不跟随重定向（3xx 算失败）；网络错误 / 超时 / 429 / 5xx 才重试，最多 3 次，指数退避（2s、8s、32s）；
// - 持久化队列（P7 HA3，ADR 0011）：投递与重试任务写入 webhook_jobs 表，PG 上通过 FOR UPDATE SKIP LOCKED
//   多副本并发认领不重复，并由 EventBus（webhooks.wake）实时唤醒与定时轮询兜底，进程重启不丢失。
// URL 和签名密钥在库里用 DOWEL_SECRET 加密，响应、审计、日志、投递记录里都不出现（错误文本去掉 URL 的路径和查询参数）。

import { createHmac, randomUUID } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { lookup as dnsLookupAsync } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { WebhookDelivery, WebhookEventInput, WebhookEventType, WebhookFormat } from '@dowel/api';
import { newId } from '@dowel/core';
import type { Db } from '@dowel/engines';
import { bytesOf, inCidr, isCidr, parseAllowlist, v6Bytes } from './allowlist.ts';
import type { EventBus } from './bus.ts';
import { inList, type PlatformDb } from './db.ts';
import type { HaCoordinator } from './ha.ts';
import { decrypt, scrubSecrets } from './secrets.ts';
import { readSettings } from './settings.ts';
import { scrubDeep } from './sse.ts';
import { atOf } from './time.ts';

export interface WebhookOptions {
  /** 第一次重试前等多久（毫秒），之后每次乘 4（默认 2000：2s、8s、32s）；测试里调短 */
  retryBaseMs?: number;
  /** 最多重试几次（默认 3，共 4 次尝试） */
  maxRetries?: number;
  /** 一次尝试的总时限（连接 + 发送 + 读响应，毫秒，默认 5000） */
  timeoutMs?: number;
  /** 同时进行的投递数（默认 4） */
  concurrency?: number;
  /** 跨副本事件总线（可选）：入队后广播 webhooks.wake，收到广播或重连时立即拉取 */
  bus?: EventBus;
  /** 副本协调器（可选）：用于标识认领任务的 workerId */
  ha?: HaCoordinator;
  /** 定时轮询 webhook_jobs 的间隔（毫秒，默认 1000；测试里随 retryBaseMs 自适应调短） */
  pollIntervalMs?: number;
  /** 任务认领租约时长（毫秒，默认 Math.max(30_000, timeoutMs * 3)） */
  leaseMs?: number;
}

type CoreWebhookOptions = Required<
  Pick<WebhookOptions, 'retryBaseMs' | 'maxRetries' | 'timeoutMs' | 'concurrency'>
>;

const DEFAULTS: CoreWebhookOptions = {
  retryBaseMs: 2000,
  maxRetries: 3,
  timeoutMs: 5000,
  concurrency: 4,
};

/** 每个 Webhook 只保留最近这么多条投递记录 */
export const KEEP_DELIVERIES = 50;
/** 响应体最多读这么多字节（只用来判断钉钉 / 飞书 / 企业微信的业务错误码和给失败原因带一小段） */
const MAX_RESPONSE_BYTES = 4096;

// ───── 出站限制（SSRF） ─────

/**
 * 默认拒绝的地址范围（Webhook 的接收端通常在公网；内网接收端由实例管理员加进 webhookAllowlist）。
 * 顺序有意义：先匹配到的说明更具体（::1 先于 ::/96）。
 */
const BLOCKED: readonly (readonly [string, string])[] = [
  ['0.0.0.0/8', '“本网络”地址（0.0.0.0/8，含未指定地址）'],
  ['10.0.0.0/8', '私有地址（10.0.0.0/8）'],
  ['100.64.0.0/10', '运营商级 NAT 地址（100.64.0.0/10）'],
  ['127.0.0.0/8', '回环地址'],
  ['169.254.0.0/16', '链路本地地址（169.254.0.0/16，含云服务器的元数据地址）'],
  ['172.16.0.0/12', '私有地址（172.16.0.0/12）'],
  ['192.0.0.0/24', '保留地址（192.0.0.0/24）'],
  ['192.0.2.0/24', '文档示例地址'],
  ['192.88.99.0/24', '保留地址（192.88.99.0/24）'],
  ['192.168.0.0/16', '私有地址（192.168.0.0/16）'],
  ['198.18.0.0/15', '测试用地址（198.18.0.0/15）'],
  ['198.51.100.0/24', '文档示例地址'],
  ['203.0.113.0/24', '文档示例地址'],
  ['224.0.0.0/4', '组播地址'],
  ['240.0.0.0/4', '保留地址（240.0.0.0/4，含广播地址）'],
  ['::/128', '未指定地址'],
  ['::1/128', '回环地址'],
  ['::/96', 'IPv4 兼容地址（已废弃）'],
  ['100::/64', '丢弃地址（100::/64）'],
  ['2001::/32', 'Teredo 隧道地址'],
  ['2001:db8::/32', '文档示例地址'],
  ['fc00::/7', '唯一本地地址（fc00::/7）'],
  ['fe80::/10', '链路本地地址（fe80::/10）'],
  ['fec0::/10', '站点本地地址（已废弃）'],
  ['ff00::/8', '组播地址'],
];

const bare = (host: string) => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);

/** IPv6 里嵌着的 IPv4（IPv4-mapped、NAT64、6to4）：按 IPv4 再判断一次，避免 ::ffff:127.0.0.1 这种写法绕过 */
const embeddedV4 = (ip: string): string | null => {
  const b = v6Bytes(ip);
  if (b?.length !== 16) return null;
  if (inCidr(ip, '::ffff:0:0/96') || inCidr(ip, '64:ff9b::/96')) return b.slice(12).join('.');
  if (inCidr(ip, '2002::/16')) return b.slice(2, 6).join('.');
  return null;
};

/** 实例设置 webhookAllowlist 解析后的规则：CIDR（IP 字面量当成 /32、/128）和主机名 */
export interface EgressRules {
  cidrs: string[];
  hosts: Set<string>;
}

export const egressRules = (allowlist: string[]): EgressRules => {
  const cidrs: string[] = [];
  const hosts = new Set<string>();
  for (const raw of parseAllowlist(allowlist)) {
    const e = bare(raw.toLowerCase());
    if (isCidr(e)) cidrs.push(e);
    else if (isIP(e)) cidrs.push(`${e}/${isIP(e) === 4 ? 32 : 128}`);
    else hosts.add(e);
  }
  return { cidrs, hosts };
};

/**
 * 一个 IP 能不能发：webhookAllowlist 里的 CIDR 先放行，否则落在默认拒绝的范围里就拒绝。
 * 返回拒绝原因（null = 允许）。
 */
export const egressDenied = (ip: string, rules: EgressRules): string | null => {
  const addr = bare(ip).toLowerCase();
  if (!bytesOf(addr)) return `无法识别的地址 ${addr}`;
  const v4 = embeddedV4(addr);
  const candidates = v4 ? [addr, v4] : [addr];
  if (rules.cidrs.some((c) => candidates.some((x) => inCidr(x, c)))) return null;
  for (const x of candidates)
    for (const [cidr, label] of BLOCKED) if (inCidr(x, cidr)) return `${addr} 是${label}`;
  return null;
};

/** 出站限制拒绝：不重试（重试也一样被拒） */
export class EgressDeniedError extends Error {
  readonly code = 'DOWEL_EGRESS_DENIED';
}

const deniedMessage = (host: string, ip: string, why: string) =>
  `${host === ip ? '' : `${host} 解析到 `}${why}：Webhook 默认只能发往公网地址，内网的接收端需要实例管理员加进“Webhook 出站允许列表”`;

type Resolver = (
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * 给 http.request 用的 lookup：真正连接时解析主机名，**每一个**解析结果都要通过出站限制（有一个不通过就整个拒绝），
 * 所以 DNS 重绑定（保存时解析到公网、发送时解析到内网）绕不过去。
 * Node 可能以 `{ all: true }` 调用（autoSelectFamily），也可能要单个地址，两种回调形式都支持。
 * 主机名本身在 webhookAllowlist 里时不检查解析结果（实例管理员明确信任它）。
 */
export const guardedLookup =
  (rules: EgressRules, resolve: Resolver = dnsLookup as unknown as Resolver): LookupFunction =>
  (hostname, options, callback) => {
    const opts = (typeof options === 'object' && options ? options : {}) as {
      family?: number | 'IPv4' | 'IPv6';
      hints?: number;
      all?: boolean;
    };
    const fail = (err: NodeJS.ErrnoException) =>
      (callback as (e: NodeJS.ErrnoException, address: string, family: number) => void)(err, '', 0);
    resolve(hostname, { family: opts.family ?? 0, hints: opts.hints, all: true }, (err, addresses) => {
      if (err) return fail(err);
      if (!addresses.length) return fail(new Error(`无法解析主机名 ${hostname}`));
      if (!rules.hosts.has(hostname.toLowerCase()))
        for (const a of addresses) {
          const why = egressDenied(a.address, rules);
          if (why) return fail(new EgressDeniedError(deniedMessage(hostname, a.address, why)));
        }
      if (opts.all) (callback as (e: null, addresses: LookupAddress[]) => void)(null, addresses);
      else
        (callback as (e: null, address: string, family: number) => void)(
          null,
          addresses[0]!.address,
          addresses[0]!.family,
        );
    });
  };

/** URL 能不能用（保存时校验）：只允许 http / https；主机要通过出站限制。返回问题说明（null = 可以） */
export const webhookUrlProblem = async (url: string, allowlist: string[]): Promise<string | null> => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'URL 不合法';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL 必须以 http:// 或 https:// 开头';
  const host = bare(u.hostname).toLowerCase();
  if (!host) return 'URL 里没有主机';
  const rules = egressRules(allowlist);
  if (rules.hosts.has(host)) return null;
  if (isIP(host)) {
    const why = egressDenied(host, rules);
    return why ? deniedMessage(host, host, why) : null;
  }
  let ips: string[];
  try {
    ips = (await dnsLookupAsync(host, { all: true, verbatim: true })).map((r) => r.address);
  } catch {
    return `无法解析主机名 ${host}`;
  }
  for (const ip of ips) {
    const why = egressDenied(ip, rules);
    if (why) return deniedMessage(host, ip, why);
  }
  return null;
};

/** 显示用：只留协议和主机（URL 的路径、查询参数里常常带着令牌） */
export const maskWebhookUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '（无效的 URL）';
  }
};

/**
 * 失败原因里去掉 URL 的路径 / 查询参数（令牌常在里面）和连接串密码，截短。
 * 对方的错误响应可能把请求地址原样回显，所以按整段 URL、路径、查询串和其中较长的片段都替换一遍。
 */
const redact = (text: string, url: URL | null): string => {
  let s = text;
  if (url) {
    const parts = [url.href, url.pathname + url.search, url.search, url.pathname];
    for (const seg of url.pathname.split('/')) if (seg.length >= 6) parts.push(seg);
    for (const [, v] of url.searchParams) if (v.length >= 6) parts.push(v, encodeURIComponent(v));
    for (const part of parts.sort((a, b) => b.length - a.length))
      if (part.length > 1) s = s.split(part).join('…');
  }
  s = scrubSecrets(s).replace(/\s+/g, ' ').trim();
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
};

// ───── 渲染与签名 ─────

/** 投递的事件：业务事件或“发送测试” */
export interface OutgoingEvent extends Omit<WebhookEventInput, 'type'> {
  type: WebhookEventType | 'test';
}

export interface PreparedRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
}

const hmac = (key: string, msg: string) => createHmac('sha256', key).update(msg);

/** Markdown 子集（**粗体**、`代码`）→ 纯文本 */
const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1');
/** Markdown 子集 → Slack mrkdwn：先转义 & < >，**粗体** → *粗体* */
const slackText = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '*$1*');

/**
 * 按格式生成请求：
 * - json：{ id, type, at, title, text, url, data }，X-Dowel-* 头，有密钥时 X-Dowel-Signature = sha256=HMAC(secret, `${秒}.${body}`)；
 * - dingtalk：markdown；加签时 URL 加 timestamp（毫秒）和 sign = base64(HMAC(secret, `${timestamp}\n${secret}`))；
 * - feishu：text；加签时 body 加 timestamp（秒）和 sign = base64(HMAC(key = `${timestamp}\n${secret}`, msg = ''))；
 * - wecom：markdown，不签名；slack：{ text }（mrkdwn），不签名。
 */
export const renderRequest = (
  format: WebhookFormat,
  rawUrl: string,
  secret: string | null,
  deliveryId: string,
  event: OutgoingEvent,
  now: Date = new Date(),
): PreparedRequest => {
  // 消息里的所有字符串再过一次脱敏（构造事件时已经不放敏感信息，这里兜底；和 SSE 共用 sse.ts 的 scrubDeep）
  const ev = scrubDeep(event) as OutgoingEvent;
  const url = new URL(rawUrl);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'Dowel-Webhook',
  };
  const seconds = String(Math.floor(now.getTime() / 1000));
  let payload: unknown;
  switch (format) {
    case 'json': {
      const body = JSON.stringify({
        id: deliveryId,
        type: ev.type,
        at: now.toISOString(),
        title: ev.title,
        text: ev.lines.join('\n'),
        url: ev.url,
        data: ev.data,
      });
      headers['x-dowel-event'] = ev.type;
      headers['x-dowel-delivery'] = deliveryId;
      headers['x-dowel-timestamp'] = seconds;
      if (secret) headers['x-dowel-signature'] = `sha256=${hmac(secret, `${seconds}.${body}`).digest('hex')}`;
      return { url, headers, body };
    }
    case 'dingtalk': {
      const text = [`#### ${ev.title}`, ...ev.lines, ...(ev.url ? [`[查看详情](${ev.url})`] : [])].join(
        '\n\n',
      );
      payload = { msgtype: 'markdown', markdown: { title: ev.title, text } };
      if (secret) {
        const ts = String(now.getTime());
        url.searchParams.set('timestamp', ts);
        url.searchParams.set('sign', hmac(secret, `${ts}\n${secret}`).digest('base64'));
      }
      break;
    }
    case 'feishu': {
      const text = [ev.title, ...ev.lines.map(plain), ...(ev.url ? [`详情：${ev.url}`] : [])].join('\n');
      payload = {
        ...(secret ? { timestamp: seconds, sign: hmac(`${seconds}\n${secret}`, '').digest('base64') } : {}),
        msg_type: 'text',
        content: { text },
      };
      break;
    }
    case 'wecom': {
      const content = [`**${ev.title}**`, ...ev.lines, ...(ev.url ? [`[查看详情](${ev.url})`] : [])].join(
        '\n',
      );
      payload = { msgtype: 'markdown', markdown: { content } };
      break;
    }
    case 'slack': {
      const text = [
        `*${slackText(ev.title)}*`,
        ...ev.lines.map(slackText),
        ...(ev.url ? [`<${ev.url}|查看详情>`] : []),
      ].join('\n');
      payload = { text };
      break;
    }
  }
  return { url, headers, body: JSON.stringify(payload) };
};

// ───── 发送一次 ─────

export interface AttemptResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
  /** 失败时是否值得重试（网络错误 / 超时 / 429 / 5xx） */
  retry: boolean;
}

const FORMAT_LABEL: Record<WebhookFormat, string> = {
  json: '接收端',
  dingtalk: '钉钉',
  feishu: '飞书',
  wecom: '企业微信',
  slack: 'Slack',
};

/** HTTP 2xx 时按格式检查业务错误码（钉钉 / 企业微信 errcode，飞书 code / StatusCode）；返回错误说明或 null */
const businessError = (format: WebhookFormat, text: string): string | null => {
  if (format !== 'dingtalk' && format !== 'wecom' && format !== 'feishu') return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const code = format === 'feishu' ? (j.code ?? j.StatusCode) : j.errcode;
  if (code === undefined || code === null || code === 0 || code === '0') return null;
  const msg = format === 'feishu' ? (j.msg ?? j.StatusMessage) : j.errmsg;
  return `${FORMAT_LABEL[format]}返回错误码 ${String(code)}${typeof msg === 'string' && msg ? `：${msg}` : ''}`;
};

/**
 * 发送一次（不重试、不跟随重定向）。总时限 timeoutMs（连接 + 发送 + 读响应），响应体最多读 4 KB。
 * 永不抛错：结果里带是否成功、状态码、失败原因（已去掉 URL 的路径 / 查询参数并脱敏）和是否值得重试。
 */
export const sendOnce = (
  req: PreparedRequest,
  format: WebhookFormat,
  rules: EgressRules,
  timeoutMs: number,
): Promise<AttemptResult> => {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const host = bare(req.url.hostname).toLowerCase();
  // IP 字面量不会经过 lookup：发之前单独检查
  if (isIP(host) && !rules.hosts.has(host)) {
    const why = egressDenied(host, rules);
    if (why)
      return Promise.resolve({
        ok: false,
        status: null,
        error: redact(deniedMessage(host, host, why), req.url),
        durationMs: 0,
        retry: false,
      });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Omit<AttemptResult, 'durationMs'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.destroy();
      resolve({ ...r, error: r.error === null ? null : redact(r.error, req.url), durationMs: elapsed() });
    };
    const judge = (res: IncomingMessage, text: string) => {
      const status = res.statusCode ?? 0;
      const snippet = text.trim() ? `：${text.trim().slice(0, 200)}` : '';
      if (status >= 300 && status < 400)
        return finish({
          ok: false,
          status,
          error: `收到 ${status} 重定向：Webhook 不跟随重定向，请填写最终的地址`,
          retry: false,
        });
      if (status === 429 || status >= 500)
        return finish({ ok: false, status, error: `HTTP ${status}${snippet}`, retry: true });
      if (status < 200 || status >= 300)
        return finish({ ok: false, status, error: `HTTP ${status}${snippet}`, retry: false });
      const biz = businessError(format, text);
      finish({ ok: !biz, status, error: biz, retry: false });
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          status: null,
          error: `超时：${Math.round(timeoutMs / 100) / 10} 秒内没有完成`,
          retry: true,
        }),
      timeoutMs,
    );
    const send = req.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(
      req.url,
      {
        method: 'POST',
        headers: { ...req.headers, 'content-length': String(Buffer.byteLength(req.body)) },
        // 每次新建连接：连接时的 lookup 检查一定会执行（不复用连接池里别的请求建立的连接）
        agent: false,
        lookup: guardedLookup(rules),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const text = () => Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_BYTES);
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          // 读够了就不再读（对方可能回一个很大的响应）
          if (size >= MAX_RESPONSE_BYTES) judge(res, text());
        });
        res.on('end', () => judge(res, text()));
        res.on('error', () => judge(res, text()));
      },
    );
    request.on('error', (err: NodeJS.ErrnoException) => {
      if (err instanceof EgressDeniedError)
        return finish({ ok: false, status: null, error: err.message, retry: false });
      const code = err.code ? `（${err.code}）` : '';
      finish({ ok: false, status: null, error: `连接失败${code}：${err.message}`, retry: true });
    });
    request.end(req.body);
  });
};

// ───── 队列与投递记录 ─────

interface HookRow {
  id: string;
  groupId: string;
  name: string;
  format: WebhookFormat;
  urlEnc: string;
  secretEnc: string | null;
  events: string[];
  enabled: boolean;
}

export interface DeliveryRow {
  id: string;
  deliveryId: string;
  event: string;
  attempt: number;
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number | null;
  test: boolean;
  at: unknown;
}

export const DELIVERY_COLUMNS = `id, delivery_id as "deliveryId", event, attempt, ok, status, error,
  duration_ms as "durationMs", test, at`;

export const deliveryOf = (r: DeliveryRow): WebhookDelivery => ({
  id: r.id,
  deliveryId: r.deliveryId,
  event: r.event as WebhookDelivery['event'],
  attempt: Number(r.attempt),
  ok: Boolean(r.ok),
  status: r.status === null ? null : Number(r.status),
  error: r.error,
  durationMs: r.durationMs === null ? null : Number(r.durationMs),
  test: Boolean(r.test),
  at: atOf(r.at),
});

interface Job {
  webhookId: string;
  deliveryId: string;
  event: OutgoingEvent;
  attempt: number;
}

interface JobRow {
  id: string;
  webhookId: string;
  deliveryId: string;
  eventType: string;
  payload: OutgoingEvent;
  attempts: number;
  maxRetries: number;
}

const isDbClosedError = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e);
  const code =
    typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
  return (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    code === '3D000' ||
    code === '57P01' ||
    /database is not open|connection.*ended|connection.*closed|does not exist/i.test(msg)
  );
};

export class Webhooks {
  readonly db: PlatformDb;
  readonly options: CoreWebhookOptions;
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  private readonly bus: EventBus | null;
  /** 正在写入 webhook_jobs 的异步入队操作 */
  private readonly enqueuing = new Set<Promise<unknown>>();
  /** 正在认领或执行中的投递任务 */
  private readonly inFlight = new Set<Promise<unknown>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeAt = Number.POSITIVE_INFINITY;
  private busUnsubs: (() => void)[] = [];
  private pumping = false;
  private needPump = false;
  private running = 0;
  private closed = false;

  constructor(db: PlatformDb, options: WebhookOptions = {}) {
    this.db = db;
    this.options = {
      retryBaseMs: options.retryBaseMs ?? DEFAULTS.retryBaseMs,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      concurrency: options.concurrency ?? DEFAULTS.concurrency,
    };
    this.bus = options.bus ?? null;
    this.workerId = options.ha?.replicaId ?? options.bus?.replicaId ?? randomUUID();
    this.pollIntervalMs = options.pollIntervalMs ?? Math.min(1000, Math.max(20, this.options.retryBaseMs));
    this.leaseMs = options.leaseMs ?? Math.max(30_000, this.options.timeoutMs * 3);
    this.attachBus();
    this.startPolling();
  }

  /** 在业务事务（或普通连接）内将事件写入 webhook_jobs，返回入队条数；提交后由调用方调用 wake() 唤醒投递 */
  async enqueueIn(tx: Db, groupId: string, event: WebhookEventInput): Promise<number> {
    const hooks = await tx.query<{ id: string; events: string[]; enabled: boolean }>(
      'select id, events, enabled from webhooks where group_id = $1',
      [groupId],
    );
    const now = new Date();
    let count = 0;
    for (const h of hooks) {
      if (!h.enabled || !Array.isArray(h.events) || !h.events.includes(event.type)) continue;
      if (this.db.dialect === 'pg') {
        await tx.query(
          `insert into webhook_jobs (id, webhook_id, delivery_id, event_type, payload, attempts, max_retries, next_run_at, created_at)
           values ($1, $2, $3, $4, $5::text::jsonb, 0, $6, now(), now())`,
          [newId(), h.id, newId(), event.type, JSON.stringify(event), this.options.maxRetries],
        );
      } else {
        await tx.query(
          `insert into webhook_jobs (id, webhook_id, delivery_id, event_type, payload, attempts, max_retries, next_run_at, created_at)
           values ($1, $2, $3, $4, $5::text::jsonb, 0, $6, $7, $7)`,
          [newId(), h.id, newId(), event.type, JSON.stringify(event), this.options.maxRetries, now],
        );
      }
      count++;
    }
    return count;
  }

  /** 触发本副本立即拉取并广播唤醒其他副本 */
  wake(broadcast = true): void {
    if (this.closed) return;
    this.pump();
    if (broadcast && this.bus) {
      void this.bus.publish({ t: 'webhooks.wake' }).catch((e) => {
        if (!this.closed && !isDbClosedError(e))
          console.error('Webhook 唤醒广播失败：', scrubSecrets(String(e)));
      });
    }
  }

  /** 投递一个事件给这个组里订阅了它的所有启用的 Webhook（异步入队到 webhook_jobs，不等结果、不抛错） */
  emit(groupId: string, event: WebhookEventInput): void {
    if (this.closed) return;
    this.trackSet(
      this.enqueuing,
      (async () => {
        const inserted = await this.enqueueIn(this.db, groupId, event);
        if (inserted > 0 && !this.closed) this.wake(true);
      })().catch((e) => {
        if (!isDbClosedError(e)) console.error('Webhook 排队失败：', scrubSecrets(String(e)));
      }),
    );
  }

  /** “发送测试”：同步发一次（不重试），记录进投递记录（test = true），返回这条记录 */
  async test(webhookId: string, groupName: string): Promise<WebhookDelivery> {
    const hook = await this.load(webhookId);
    if (!hook) throw new Error('Webhook 不存在');
    const event: OutgoingEvent = {
      type: 'test',
      title: 'Dowel Webhook 测试',
      lines: [
        `这是来自组 **${groupName}** 的测试消息：Webhook「${hook.name}」配置正确，可以收到 Dowel 的通知。`,
      ],
      url: null,
      data: { group: groupName, webhook: hook.name },
    };
    const job: Job = { webhookId, deliveryId: newId(), event, attempt: 1 };
    const result = await this.attemptOnce(hook, job);
    return this.recordIn(this.db, hook.id, job, result, true);
  }

  /** 等队列里的投递（含持久化在 webhook_jobs 里的待重试任务）全部结束（测试用） */
  async flush(): Promise<void> {
    for (;;) {
      while (this.enqueuing.size) await Promise.allSettled([...this.enqueuing]);
      while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
      if (this.closed) return;
      let pending: { n: number | string; nextRunAt: unknown } | undefined;
      try {
        [pending] = await this.db.query<{ n: number | string; nextRunAt: unknown }>(
          'select count(*) as n, min(next_run_at) as "nextRunAt" from webhook_jobs',
        );
      } catch (e) {
        if (isDbClosedError(e)) return;
        throw e;
      }
      if (!pending || Number(pending.n) === 0) {
        if (!this.enqueuing.size && !this.inFlight.size) return;
        continue;
      }
      const dueMs = pending.nextRunAt ? new Date(atOf(pending.nextRunAt)).getTime() - Date.now() : 0;
      if (dueMs <= 0) {
        this.pump();
        if (this.inFlight.size) {
          await Promise.allSettled([...this.inFlight]);
          if (this.running > 0 || this.enqueuing.size) continue;
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.max(5, Math.min(20, this.pollIntervalMs)));
          t.unref?.();
        });
      } else {
        const waitMs = Math.min(dueMs, this.pollIntervalMs);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.max(5, waitMs));
          t.unref?.();
        });
        if (!this.closed) this.pump();
      }
    }
  }

  /** flush() 别名 */
  drain(): Promise<void> {
    return this.flush();
  }

  /** 停止：清掉轮询与唤醒定时器、取消总线订阅，等待在途任务结束并释放残留锁（进程退出时） */
  close(): Promise<void> {
    this.closed = true;
    this.stopPolling();
    for (const off of this.busUnsubs) off();
    this.busUnsubs = [];
    return (async () => {
      while (this.enqueuing.size || this.inFlight.size) {
        await Promise.allSettled([...this.enqueuing, ...this.inFlight]);
      }
      await this.db
        .query('update webhook_jobs set locked_by = null, locked_until = null where locked_by = $1', [
          this.workerId,
        ])
        .catch(() => {});
    })();
  }

  private attachBus(): void {
    if (!this.bus) return;
    const replicaId = this.bus.replicaId;
    this.busUnsubs.push(
      this.bus.onEvent((event) => {
        if (this.closed) return;
        if (event.t === 'webhooks.wake' && event.origin !== replicaId) this.pump();
      }),
      this.bus.onReconnect(() => {
        if (!this.closed) this.pump();
      }),
    );
  }

  private startPolling(): void {
    if (this.closed || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (!this.closed) this.pump();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
    // 启动后立即尝试拾取可能因重启或崩溃遗留的到期任务
    queueMicrotask(() => {
      if (!this.closed) this.pump();
    });
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
      this.wakeAt = Number.POSITIVE_INFINITY;
    }
  }

  private scheduleWake(delayMs: number): void {
    if (this.closed) return;
    const wait = Math.max(1, Math.ceil(delayMs));
    const target = Date.now() + wait;
    if (this.wakeTimer && this.wakeAt <= target) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeAt = target;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeAt = Number.POSITIVE_INFINITY;
      if (!this.closed) this.pump();
    }, wait);
    this.wakeTimer.unref?.();
  }

  private trackSet(set: Set<Promise<unknown>>, p: Promise<unknown>): void {
    set.add(p);
    const drop = () => set.delete(p);
    p.then(drop, drop);
  }

  private pump(): void {
    if (this.closed) return;
    if (this.pumping) {
      this.needPump = true;
      return;
    }
    if (this.running >= this.options.concurrency) return;
    this.pumping = true;
    const p = (async () => {
      try {
        while (!this.closed) {
          const free = this.options.concurrency - this.running;
          if (free <= 0) break;
          const jobs = await this.claimBatch(free);
          if (!jobs.length) break;
          for (const row of jobs) {
            this.running++;
            const task = this.executeJob(row)
              .catch((e) => {
                if (!isDbClosedError(e)) console.error('Webhook 投递失败：', scrubSecrets(String(e)));
              })
              .finally(() => {
                this.running--;
                if (!this.closed) this.pump();
              });
            this.trackSet(this.inFlight, task);
          }
          if (jobs.length < free) break;
        }
      } catch (e) {
        if (isDbClosedError(e)) {
          this.stopPolling();
          return;
        }
        console.error('Webhook 任务认领失败：', scrubSecrets(String(e)));
      } finally {
        this.pumping = false;
        if (this.needPump && !this.closed) {
          this.needPump = false;
          if (this.running < this.options.concurrency) this.pump();
        }
      }
    })();
    this.trackSet(this.inFlight, p);
  }

  private async claimBatch(limit: number): Promise<JobRow[]> {
    if (limit <= 0 || this.closed) return [];
    if (this.db.dialect === 'pg') {
      return this.db.transaction(async (tx) => {
        const rows = await tx.query<JobRow>(
          `select id, webhook_id as "webhookId", delivery_id as "deliveryId",
                  event_type as "eventType", payload, attempts, max_retries as "maxRetries"
             from webhook_jobs
            where next_run_at <= now()
              and (locked_until is null or locked_until <= now())
            order by next_run_at, id
            limit $1
              for update skip locked`,
          [limit],
        );
        if (!rows.length) return [];
        const ids = rows.map((r) => r.id);
        await tx.query(
          `update webhook_jobs
              set locked_by = $1,
                  locked_until = now() + ($2::double precision * interval '1 millisecond')
            where id in (${inList(ids, 3)})`,
          [this.workerId, this.leaseMs, ...ids],
        );
        return rows;
      });
    }
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const rows = await tx.query<JobRow>(
        `select id, webhook_id as "webhookId", delivery_id as "deliveryId",
                event_type as "eventType", payload, attempts, max_retries as "maxRetries"
           from webhook_jobs
          where next_run_at <= $1
            and (locked_until is null or locked_until <= $1)
          order by next_run_at, id
          limit $2`,
        [now, limit],
      );
      if (!rows.length) return [];
      const ids = rows.map((r) => r.id);
      const lockedUntil = new Date(now.getTime() + this.leaseMs);
      await tx.query(
        `update webhook_jobs
            set locked_by = $1,
                locked_until = $2
          where id in (${inList(ids, 3)})`,
        [this.workerId, lockedUntil, ...ids],
      );
      return rows;
    });
  }

  private async load(webhookId: string): Promise<HookRow | null> {
    const [row] = await this.db.query<HookRow>(
      `select id, group_id as "groupId", name, format, url_enc as "urlEnc", secret_enc as "secretEnc", events, enabled
       from webhooks where id = $1`,
      [webhookId],
    );
    return row ?? null;
  }

  /** 一次尝试：每次都重新读设置（允许列表）、重新渲染（时间戳和签名要新的） */
  private async attemptOnce(hook: HookRow, job: Job): Promise<AttemptResult> {
    let url: string;
    let secret: string | null;
    try {
      url = decrypt(hook.urlEnc);
      secret = hook.secretEnc ? decrypt(hook.secretEnc) : null;
    } catch (e) {
      return { ok: false, status: null, error: (e as Error).message, durationMs: 0, retry: false };
    }
    const rules = egressRules((await readSettings(this.db)).webhookAllowlist);
    return sendOnce(
      renderRequest(hook.format, url, secret, job.deliveryId, job.event),
      hook.format,
      rules,
      this.options.timeoutMs,
    );
  }

  private async executeJob(row: JobRow): Promise<void> {
    if (this.closed) {
      await this.db
        .query(
          'update webhook_jobs set locked_by = null, locked_until = null where id = $1 and locked_by = $2',
          [row.id, this.workerId],
        )
        .catch(() => {});
      return;
    }
    // 重试时 Webhook 可能已经被删除 / 停用：仅在仍持有该任务租约时清理
    const hook = await this.load(row.webhookId);
    if (!hook?.enabled) {
      await this.db
        .query('delete from webhook_jobs where id = $1 and locked_by = $2', [row.id, this.workerId])
        .catch(() => {});
      return;
    }
    const attempts = Number(row.attempts);
    const maxRetries = Number(row.maxRetries);
    const job: Job = {
      webhookId: row.webhookId,
      deliveryId: row.deliveryId,
      event: row.payload,
      attempt: attempts + 1,
    };
    const result = await this.attemptOnce(hook, job);
    const shouldRetry = !result.ok && result.retry && attempts < maxRetries;
    const delayMs = shouldRetry ? this.options.retryBaseMs * 4 ** attempts : 0;

    let rescheduled = false;
    try {
      rescheduled = await this.db.transaction(async (tx) => {
        await this.recordIn(tx, hook.id, job, result, false);
        if (!shouldRetry) {
          await tx.query('delete from webhook_jobs where id = $1 and locked_by = $2', [
            row.id,
            this.workerId,
          ]);
          return false;
        }
        const nextAttempts = attempts + 1;
        const updated =
          this.db.dialect === 'pg'
            ? await tx.query<{ id: string }>(
                `update webhook_jobs
                    set attempts = $2,
                        next_run_at = now() + ($3::double precision * interval '1 millisecond'),
                        locked_by = null,
                        locked_until = null
                  where id = $1
                    and locked_by = $4
                  returning id`,
                [row.id, nextAttempts, delayMs, this.workerId],
              )
            : await tx.query<{ id: string }>(
                `update webhook_jobs
                    set attempts = $2,
                        next_run_at = $3,
                        locked_by = null,
                        locked_until = null
                  where id = $1
                    and locked_by = $4
                  returning id`,
                [row.id, nextAttempts, new Date(Date.now() + delayMs), this.workerId],
              );
        return updated.length > 0;
      });
    } catch (e) {
      // 发送期间 Webhook 被删除（外键）：webhook_jobs 会随外键级联删除，没有地方记了，也不用再重试
      if (!(await this.load(row.webhookId).catch(() => null))) return;
      throw e;
    }

    if (rescheduled && !this.closed) this.scheduleWake(delayMs);
  }

  /** 写一行投递记录，然后只保留这个 Webhook 最近 KEEP_DELIVERIES 条 */
  private async recordIn(
    db: Db,
    webhookId: string,
    job: Job,
    r: AttemptResult,
    test: boolean,
  ): Promise<WebhookDelivery> {
    const row: DeliveryRow = {
      id: newId(),
      deliveryId: job.deliveryId,
      event: job.event.type,
      attempt: job.attempt,
      ok: r.ok,
      status: r.status,
      error: r.error,
      durationMs: r.durationMs,
      test,
      at: new Date().toISOString(),
    };
    await db.query(
      `insert into webhook_deliveries (id, webhook_id, delivery_id, event, attempt, ok, status, error, duration_ms, test, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        row.id,
        webhookId,
        row.deliveryId,
        row.event,
        row.attempt,
        row.ok,
        row.status,
        row.error,
        row.durationMs,
        row.test,
        row.at,
      ],
    );
    await db.query(
      `delete from webhook_deliveries where webhook_id = $1 and id not in
         (select id from webhook_deliveries where webhook_id = $1 order by at desc, id desc limit ${KEEP_DELIVERIES})`,
      [webhookId],
    );
    return deliveryOf(row);
  }
}
