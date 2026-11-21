// 组级 Webhook（P5b，E8）：配置接口与权限、URL / 密钥不回显、出站限制（含 DNS 重绑定的 lookup 单元测试）、
// 五种格式的报文与签名、重试与指数退避、不跟随重定向、超时、事件过滤、发送测试、投递记录只保留最近 50 条。
// 平台库用 SQLite（内存），接收端是本地 HTTP 服务器（127.0.0.1 随机端口）。

import { createHmac } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { WebhookDelivery, WebhookEventInput, WebhookInfo } from '@dowel/api';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { type ClusterEvent, EventBus } from '../src/bus.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { decrypt, encrypt } from '../src/secrets.ts';
import {
  EgressDeniedError,
  egressDenied,
  egressRules,
  guardedLookup,
  maskWebhookUrl,
  renderRequest,
  Webhooks,
} from '../src/webhooks.ts';
import { makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'webhooks-test-secret-0123456789';

const RETRY_BASE_MS = 30;
const TIMEOUT_MS = 600;

let db: PlatformDb;
let created: ReturnType<typeof createApp>;
const cookies: Record<string, string> = {};
let groupId = '';
const SLUG = 'hooks';

const call = async (method: string, path: string, json?: unknown, who = 'ga') => {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await created.app.request(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data: data as Record<string, unknown> & { error?: string }, text };
};

// ───── 本地接收端 ─────

interface Received {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
  at: number;
}

interface Receiver {
  base: string;
  port: number;
  received: Received[];
  /** 依次使用的响应；用完后用 fallback */
  replies: ((res: ServerResponse, req: Received) => void)[];
  fallback: (res: ServerResponse, req: Received) => void;
  close: () => Promise<void>;
}

const ok200 = (res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
};

const receivers: Receiver[] = [];
const startReceiver = async (fallback: Receiver['fallback'] = ok200): Promise<Receiver> => {
  const r = { received: [], replies: [], fallback } as unknown as Receiver;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const got: Received = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        at: performance.now(),
      };
      r.received.push(got);
      (r.replies.shift() ?? r.fallback)(res, got);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  r.port = (server.address() as AddressInfo).port;
  r.base = `http://127.0.0.1:${r.port}`;
  r.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  receivers.push(r);
  return r;
};

const setAllowlist = async (list: string[]) => {
  const r = await call('PATCH', '/api/admin/settings', { webhookAllowlist: list }, 'admin');
  expect(r.status, JSON.stringify(r.data)).toBe(200);
};

const createHook = async (body: Record<string, unknown>, who = 'ga') => {
  const r = await call('POST', `/api/groups/${SLUG}/webhooks`, body, who);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data as unknown as WebhookInfo;
};

const deliveries = async (id: string) => {
  const r = await call('GET', `/api/groups/${SLUG}/webhooks/${id}/deliveries`);
  expect(r.status).toBe(200);
  return r.data as unknown as WebhookDelivery[];
};

const event = (type: WebhookEventInput['type'] = 'request.created'): WebhookEventInput => ({
  type,
  title: '新的执行申请',
  lines: ['**张三** 申请在 `prod` 执行到 v3', '原因：上线'],
  url: 'https://dowel.example.com/p/x/requests/1',
  data: { project: 'shop', environment: 'prod', ok: true },
});

beforeAll(async () => {
  db = await openPlatformDb(':memory:');
  created = createApp(db, {
    loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
    connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    webhooks: { retryBaseMs: RETRY_BASE_MS, timeoutMs: TIMEOUT_MS },
  });
  await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
  for (const n of ['ga', 'member', 'outsider']) await makeUser(db, n, { name: n });
  for (const n of ['admin', 'ga', 'member', 'outsider']) {
    const r = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: n, password: PASSWORD }),
    });
    cookies[n] = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  }
  const g = await call('POST', '/api/groups', { slug: SLUG, name: '钩子组' }, 'ga');
  expect(g.status).toBe(201);
  groupId = g.data.id as string;
  expect(
    (await call('POST', `/api/groups/${SLUG}/members`, { username: 'member', role: 'member' })).status,
  ).toBe(200);
});

afterAll(async () => {
  await created.webhooks.close();
  for (const r of receivers) await r.close();
  await created.rooms.flush();
  await created.shadows.close();
  await db.close();
});

beforeEach(async () => {
  await created.webhooks.flush();
  await db.query('delete from webhooks');
  await setAllowlist(['127.0.0.0/8']);
});

describe('出站限制（SSRF）', () => {
  test('默认只允许公网：回环、私有、链路本地、CGNAT、IPv6 本地、IPv4-mapped 等都拒绝', () => {
    const rules = egressRules([]);
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:1::',
    ])
      expect(egressDenied(ip, rules), ip).not.toBeNull();
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])
      expect(egressDenied(ip, rules), ip).toBeNull();
    expect(egressDenied('169.254.169.254', rules)).toContain('元数据');
  });

  test('webhookAllowlist 里的 CIDR / IP 额外放行（含 IPv4-mapped 写法），其余照旧拒绝', () => {
    const rules = egressRules(['127.0.0.0/8', '10.0.0.5', 'hooks.internal']);
    expect(egressDenied('127.0.0.1', rules)).toBeNull();
    expect(egressDenied('::ffff:127.0.0.1', rules)).toBeNull();
    expect(egressDenied('10.0.0.5', rules)).toBeNull();
    expect(egressDenied('10.0.0.6', rules)).not.toBeNull();
    expect(egressDenied('::1', rules)).not.toBeNull();
    expect(rules.hosts.has('hooks.internal')).toBe(true);
  });

  /** 假的 DNS：模拟 DNS 重绑定（保存时解析到公网，发送时解析到内网） */
  const fakeResolver =
    (answers: Record<string, string[]>) =>
    (
      host: string,
      _options: unknown,
      cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
    ) =>
      cb(
        null,
        (answers[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      );
  const lookupOnce = (
    fn: ReturnType<typeof guardedLookup>,
    host: string,
    all: boolean,
  ): Promise<{ err: Error | null; value: unknown; family?: number }> =>
    new Promise((resolve) =>
      fn(
        host,
        { all } as never,
        ((err: Error | null, value: unknown, family?: number) => resolve({ err, value, family })) as never,
      ),
    );

  test('连接时的 lookup：解析结果有一个落在内网就拒绝；两种回调形式（all / 单个地址）都支持', async () => {
    const lookup = guardedLookup(
      egressRules([]),
      fakeResolver({
        'evil.example': ['93.184.216.34', '127.0.0.1'],
        'rebind.example': ['169.254.169.254'],
        'public.example': ['93.184.216.34', '2606:2800::1'],
      }) as never,
    );
    for (const all of [true, false]) {
      const evil = await lookupOnce(lookup, 'evil.example', all);
      expect(evil.err).toBeInstanceOf(EgressDeniedError);
      expect(evil.err?.message).toContain('127.0.0.1');
      expect((await lookupOnce(lookup, 'rebind.example', all)).err).toBeInstanceOf(EgressDeniedError);
    }
    const many = await lookupOnce(lookup, 'public.example', true);
    expect(many.err).toBeNull();
    expect(many.value).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800::1', family: 6 },
    ]);
    const one = await lookupOnce(lookup, 'public.example', false);
    expect(one).toEqual({ err: null, value: '93.184.216.34', family: 4 });
    // 解析不出地址
    expect((await lookupOnce(lookup, 'nothing.example', true)).err).toBeInstanceOf(Error);
  });

  test('允许列表里的主机名：不检查它的解析结果', async () => {
    const lookup = guardedLookup(
      egressRules(['hooks.internal']),
      fakeResolver({ 'hooks.internal': ['10.0.0.9'] }) as never,
    );
    expect(await lookupOnce(lookup, 'hooks.internal', false)).toEqual({
      err: null,
      value: '10.0.0.9',
      family: 4,
    });
  });

  test('允许列表为空时：创建 422；直接写库绕过创建，投递也被拒并记录原因；加进允许列表后成功', async () => {
    const rx = await startReceiver();
    await setAllowlist([]);
    for (const url of [
      `${rx.base}/hook`,
      `http://localhost:${rx.port}/hook`,
      'http://10.0.0.1/hook',
      'http://169.254.169.254/latest/meta-data',
      `http://[::1]:${rx.port}/hook`,
      `http://[::ffff:127.0.0.1]:${rx.port}/hook`,
    ]) {
      const r = await call('POST', `/api/groups/${SLUG}/webhooks`, {
        name: 'x',
        format: 'json',
        url,
        events: ['request.created'],
      });
      expect(r.status, url).toBe(422);
      expect(r.data.error).toContain('Webhook 出站允许列表');
    }
    // 不是 http / https：schema 拒绝
    expect(
      (
        await call('POST', `/api/groups/${SLUG}/webhooks`, {
          name: 'x',
          format: 'json',
          url: 'file:///etc/passwd',
          events: ['request.created'],
        })
      ).status,
    ).toBe(400);

    // 绕过创建：直接写库
    await db.query(
      `insert into webhooks (id, group_id, name, format, url_enc, events, enabled)
       values ('raw', $1, 'raw', 'json', $2, $3::text::jsonb, true)`,
      [groupId, encrypt(`${rx.base}/raw-token-123456`), JSON.stringify(['request.created'])],
    );
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    expect(rx.received).toHaveLength(0);
    const [denied] = await deliveries('raw');
    expect(denied).toMatchObject({ ok: false, status: null, attempt: 1, event: 'request.created' });
    expect(denied!.error).toContain('回环地址');
    expect(denied!.error).not.toContain('raw-token-123456');
    // 出站限制拒绝不重试
    expect(await deliveries('raw')).toHaveLength(1);

    // 加进允许列表后：创建成功、投递成功
    await setAllowlist(['127.0.0.0/8']);
    const hook = await createHook({
      name: 'ok',
      format: 'json',
      url: `${rx.base}/hook`,
      events: ['request.created'],
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    expect(rx.received.map((r) => r.path).sort()).toEqual(['/hook', '/raw-token-123456']);
    expect((await deliveries(hook.id))[0]).toMatchObject({ ok: true, status: 200 });
  });

  test('实例设置：webhookAllowlist 逐项校验', async () => {
    const bad = await call('PATCH', '/api/admin/settings', { webhookAllowlist: ['10.0.0.0/99'] }, 'admin');
    expect(bad.status).toBe(422);
    expect(bad.data.error).toContain('Webhook 出站允许列表');
    expect(
      (await call('PATCH', '/api/admin/settings', { webhookAllowlist: ['127.0.0.0/8'] }, 'ga')).status,
    ).toBe(403);
    const r = await call('GET', '/api/admin/settings', undefined, 'admin');
    expect(r.data.webhookAllowlist).toEqual(['127.0.0.0/8']);
  });
});

describe('格式与签名', () => {
  test('通用 JSON：报文、X-Dowel-* 头、HMAC 签名', async () => {
    const rx = await startReceiver();
    const secret = 'json-signing-secret';
    const hook = await createHook({
      name: 'json',
      format: 'json',
      url: `${rx.base}/json?token=abc`,
      secret,
      events: ['request.created'],
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    expect(rx.received).toHaveLength(1);
    const got = rx.received[0]!;
    expect(got.method).toBe('POST');
    expect(got.path).toBe('/json?token=abc');
    expect(got.headers['content-type']).toBe('application/json');
    expect(got.headers['user-agent']).toBe('Dowel-Webhook');
    expect(got.headers['x-dowel-event']).toBe('request.created');
    const ts = got.headers['x-dowel-timestamp'] as string;
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(30);
    const body = JSON.parse(got.body);
    expect(body).toEqual({
      id: got.headers['x-dowel-delivery'],
      type: 'request.created',
      at: expect.any(String),
      title: '新的执行申请',
      text: '**张三** 申请在 `prod` 执行到 v3\n原因：上线',
      url: 'https://dowel.example.com/p/x/requests/1',
      data: { project: 'shop', environment: 'prod', ok: true },
    });
    const expected = createHmac('sha256', secret).update(`${ts}.${got.body}`).digest('hex');
    expect(got.headers['x-dowel-signature']).toBe(`sha256=${expected}`);
    const [d] = await deliveries(hook.id);
    expect(d).toMatchObject({ ok: true, status: 200, attempt: 1, deliveryId: body.id, test: false });

    // 没有密钥：不带签名头
    await call('PATCH', `/api/groups/${SLUG}/webhooks/${hook.id}`, { secret: null });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    expect(rx.received[1]!.headers['x-dowel-signature']).toBeUndefined();
  });

  test('钉钉：markdown；加签时 URL 带 timestamp 和 sign；errcode ≠ 0 算失败且不重试', async () => {
    const rx = await startReceiver((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"errcode":0,"errmsg":"ok"}');
    });
    const secret = 'SECdingtalk-secret';
    const hook = await createHook({
      name: '钉钉',
      format: 'dingtalk',
      url: `${rx.base}/robot/send?access_token=dt-token-abcdef`,
      secret,
      events: ['request.created'],
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    const got = rx.received[0]!;
    const u = new URL(got.path, rx.base);
    expect(u.searchParams.get('access_token')).toBe('dt-token-abcdef');
    const ts = u.searchParams.get('timestamp')!;
    expect(Math.abs(Number(ts) - Date.now())).toBeLessThan(30_000);
    // 按钉钉文档重算：base64(HMAC-SHA256(key=secret, msg=`${timestamp}\n${secret}`))，再 urlencode
    const sign = createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
    expect(u.searchParams.get('sign')).toBe(sign);
    expect(got.path).toContain(`sign=${encodeURIComponent(sign)}`);
    const body = JSON.parse(got.body);
    expect(body.msgtype).toBe('markdown');
    expect(body.markdown.title).toBe('新的执行申请');
    expect(body.markdown.text).toContain('#### 新的执行申请');
    expect(body.markdown.text).toContain('**张三** 申请在 `prod` 执行到 v3');
    expect(body.markdown.text).toContain('[查看详情](https://dowel.example.com/p/x/requests/1)');
    expect((await deliveries(hook.id))[0]).toMatchObject({ ok: true, status: 200 });

    // 业务错误码：HTTP 200 但 errcode ≠ 0
    rx.replies.push((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"errcode":310000,"errmsg":"sign not match, more: [dt-token-abcdef]"}');
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    const list = await deliveries(hook.id);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ ok: false, status: 200 });
    expect(list[0]!.error).toContain('钉钉返回错误码 310000');
    // 对方回显的令牌也被去掉
    expect(list[0]!.error).not.toContain('dt-token-abcdef');
  });

  test('飞书：text；加签时 body 带 timestamp（秒）和 sign；code ≠ 0 算失败', async () => {
    const rx = await startReceiver((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"code":0,"msg":"success"}');
    });
    const secret = 'feishu-secret';
    const hook = await createHook({
      name: '飞书',
      format: 'feishu',
      url: `${rx.base}/open-apis/bot/v2/hook/fs-token-uuid`,
      secret,
      events: ['request.created'],
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    const body = JSON.parse(rx.received[0]!.body);
    expect(body.msg_type).toBe('text');
    expect(body.content.text).toBe(
      '新的执行申请\n张三 申请在 prod 执行到 v3\n原因：上线\n详情：https://dowel.example.com/p/x/requests/1',
    );
    expect(typeof body.timestamp).toBe('string');
    expect(Math.abs(Number(body.timestamp) - Date.now() / 1000)).toBeLessThan(30);
    // 飞书文档：key = `${timestamp}\n${secret}`，对空字符串做 HMAC-SHA256，再 base64
    expect(body.sign).toBe(createHmac('sha256', `${body.timestamp}\n${secret}`).update('').digest('base64'));
    expect((await deliveries(hook.id))[0]).toMatchObject({ ok: true });

    rx.replies.push((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"code":19021,"msg":"sign match fail or timestamp is not within one hour from current time"}');
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    const [d] = await deliveries(hook.id);
    expect(d).toMatchObject({ ok: false, status: 200 });
    expect(d!.error).toContain('飞书返回错误码 19021');
    // 旧版接口的 StatusCode
    rx.replies.push((res) => {
      res.writeHead(200);
      res.end('{"StatusCode":9499,"StatusMessage":"Bad Request"}');
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    expect((await deliveries(hook.id))[0]!.error).toContain('9499');
    expect(await deliveries(hook.id)).toHaveLength(3);
  });

  test('企业微信：markdown，不签名；errcode ≠ 0 算失败', async () => {
    const rx = await startReceiver((res) => {
      res.writeHead(200);
      res.end('{"errcode":0,"errmsg":"ok"}');
    });
    const hook = await createHook({
      name: '企业微信',
      format: 'wecom',
      url: `${rx.base}/cgi-bin/webhook/send?key=wecom-key-xyz`,
      events: ['request.created'],
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    const body = JSON.parse(rx.received[0]!.body);
    expect(body).toEqual({
      msgtype: 'markdown',
      markdown: {
        content:
          '**新的执行申请**\n**张三** 申请在 `prod` 执行到 v3\n原因：上线\n[查看详情](https://dowel.example.com/p/x/requests/1)',
      },
    });
    rx.replies.push((res) => {
      res.writeHead(200);
      res.end('{"errcode":93000,"errmsg":"invalid webhook url"}');
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    expect((await deliveries(hook.id))[0]!.error).toContain('企业微信返回错误码 93000');
  });

  test('Slack：{ text }（mrkdwn），转义 & < >', async () => {
    const rx = await startReceiver((res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await createHook({
      name: 'Slack',
      format: 'slack',
      url: `${rx.base}/services/T000/B000/XXXX`,
      events: ['request.created'],
    });
    created.webhooks.emit(groupId, { ...event(), lines: ['**a** < b & c'] });
    await created.webhooks.flush();
    expect(JSON.parse(rx.received[0]!.body)).toEqual({
      text: '*新的执行申请*\n*a* &lt; b &amp; c\n<https://dowel.example.com/p/x/requests/1|查看详情>',
    });
  });

  test('消息里的字符串发送前再脱敏一次', () => {
    const r = renderRequest('json', 'https://example.com/h', null, 'd1', {
      ...event(),
      lines: ['连接失败：postgres://app:hunter2@db:5432/x'],
      data: { detail: 'password=hunter2' },
    });
    expect(r.body).not.toContain('hunter2');
  });
});

describe('投递：重试、重定向、超时、事件过滤', () => {
  test('前两次 500、第三次 200：3 条投递记录、同一个 delivery_id，间隔指数增长', async () => {
    const rx = await startReceiver();
    for (let i = 0; i < 2; i++)
      rx.replies.push((res) => {
        res.writeHead(500);
        res.end('boom');
      });
    const hook = await createHook({
      name: 'retry',
      format: 'json',
      url: `${rx.base}/r`,
      events: ['request.created'],
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    expect(rx.received).toHaveLength(3);
    const ids = new Set(rx.received.map((r) => r.headers['x-dowel-delivery']));
    expect(ids.size).toBe(1);
    const gap1 = rx.received[1]!.at - rx.received[0]!.at;
    const gap2 = rx.received[2]!.at - rx.received[1]!.at;
    expect(gap1).toBeGreaterThanOrEqual(RETRY_BASE_MS - 5);
    expect(gap2).toBeGreaterThanOrEqual(RETRY_BASE_MS * 4 - 5);
    const list = await deliveries(hook.id);
    expect(list.map((d) => [d.attempt, d.ok, d.status])).toEqual([
      [3, true, 200],
      [2, false, 500],
      [1, false, 500],
    ]);
    expect(new Set(list.map((d) => d.deliveryId)).size).toBe(1);
    expect(list[0]!.deliveryId).toBe([...ids][0]);
  });

  test('一直 5xx：最多重试 3 次（共 4 次）；429 也重试', async () => {
    const rx = await startReceiver((res) => {
      res.writeHead(503);
      res.end();
    });
    rx.replies.push((res) => {
      res.writeHead(429);
      res.end();
    });
    const hook = await createHook({
      name: '5xx',
      format: 'json',
      url: `${rx.base}/r`,
      events: ['request.created'],
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    expect(rx.received).toHaveLength(4);
    expect((await deliveries(hook.id)).map((d) => d.status)).toEqual([503, 503, 503, 429]);
  });

  test('4xx 不重试；失败原因不含 URL 的路径和查询参数', async () => {
    const rx = await startReceiver((res, req) => {
      res.writeHead(404);
      res.end(`no such hook: ${req.path}`);
    });
    const hook = await createHook({
      name: '4xx',
      format: 'json',
      url: `${rx.base}/hooks/very-secret-token?sig=another-secret`,
      events: ['request.created'],
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    expect(rx.received).toHaveLength(1);
    const [d] = await deliveries(hook.id);
    expect(d).toMatchObject({ ok: false, status: 404, attempt: 1 });
    expect(d!.error).toContain('HTTP 404');
    expect(d!.error).not.toContain('very-secret-token');
    expect(d!.error).not.toContain('another-secret');
  });

  test('不跟随重定向：302 算失败，重定向目标收不到请求', async () => {
    const target = await startReceiver();
    const rx = await startReceiver((res) => {
      res.writeHead(302, { location: `${target.base}/stolen` });
      res.end();
    });
    const hook = await createHook({
      name: '302',
      format: 'json',
      url: `${rx.base}/r`,
      events: ['request.created'],
    });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    expect(rx.received).toHaveLength(1);
    expect(target.received).toHaveLength(0);
    const list = await deliveries(hook.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ok: false, status: 302 });
    expect(list[0]!.error).toContain('不跟随重定向');
  });

  test('超时：接收端不响应时在时限后失败（发送测试只尝试一次）', async () => {
    const rx = await startReceiver(() => {
      /* 永远不响应 */
    });
    const hook = await createHook({
      name: 'slow',
      format: 'json',
      url: `${rx.base}/r`,
      events: ['request.created'],
    });
    const started = performance.now();
    const r = await call('POST', `/api/groups/${SLUG}/webhooks/${hook.id}/test`);
    expect(r.status).toBe(200);
    const d = r.data as unknown as WebhookDelivery;
    expect(d).toMatchObject({ ok: false, status: null, test: true, event: 'test', attempt: 1 });
    expect(d.error).toContain('超时');
    expect(performance.now() - started).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
    expect(d.durationMs).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
    expect(await deliveries(hook.id)).toHaveLength(1);
  });

  test('连不上：网络错误会重试', async () => {
    const rx = await startReceiver();
    const url = `${rx.base}/r`;
    await rx.close();
    receivers.splice(receivers.indexOf(rx), 1);
    const hook = await createHook({ name: 'down', format: 'json', url, events: ['request.created'] });
    created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    const list = await deliveries(hook.id);
    expect(list).toHaveLength(4);
    expect(list[0]!.error).toContain('ECONNREFUSED');
  });

  test('事件过滤：没订阅的事件不发，停用的不发，别的组不发', async () => {
    const rx = await startReceiver();
    await createHook({ name: 'a', format: 'json', url: `${rx.base}/a`, events: ['request.approved'] });
    await createHook({
      name: 'off',
      format: 'json',
      url: `${rx.base}/off`,
      events: ['request.created', 'request.approved'],
      enabled: false,
    });
    created.webhooks.emit(groupId, event('request.created'));
    created.webhooks.emit('other-group', event('request.approved'));
    await created.webhooks.flush();
    expect(rx.received).toHaveLength(0);
    created.webhooks.emit(groupId, event('request.approved'));
    await created.webhooks.flush();
    expect(rx.received.map((r) => r.path)).toEqual(['/a']);
  });

  test('投递记录只保留最近 50 条', async () => {
    const rx = await startReceiver();
    const hook = await createHook({
      name: 'many',
      format: 'json',
      url: `${rx.base}/m`,
      events: ['request.created'],
    });
    for (let i = 0; i < 55; i++) created.webhooks.emit(groupId, event());
    await created.webhooks.flush();
    expect(rx.received).toHaveLength(55);
    const [{ n }] = (await db.query<{ n: number }>(
      'select count(*) as n from webhook_deliveries where webhook_id = $1',
      [hook.id],
    )) as [{ n: number }];
    expect(Number(n)).toBe(50);
    expect(await deliveries(hook.id)).toHaveLength(50);
  });
});

describe('配置接口', () => {
  test('权限：组成员 / 无关用户 403，组不存在 404，组管理员和实例管理员可以', async () => {
    const rx = await startReceiver();
    const hook = await createHook({
      name: 'p',
      format: 'json',
      url: `${rx.base}/p`,
      events: ['request.created'],
    });
    const paths: [string, string, unknown?][] = [
      ['GET', `/api/groups/${SLUG}/webhooks`],
      [
        'POST',
        `/api/groups/${SLUG}/webhooks`,
        { name: 'x', format: 'json', url: `${rx.base}/x`, events: ['request.created'] },
      ],
      ['PATCH', `/api/groups/${SLUG}/webhooks/${hook.id}`, { name: 'y' }],
      ['GET', `/api/groups/${SLUG}/webhooks/${hook.id}/deliveries`],
      ['POST', `/api/groups/${SLUG}/webhooks/${hook.id}/test`],
      ['DELETE', `/api/groups/${SLUG}/webhooks/${hook.id}`],
    ];
    for (const who of ['member', 'outsider'])
      for (const [m, p, b] of paths) expect((await call(m, p, b, who)).status, `${who} ${m} ${p}`).toBe(403);
    expect((await call('GET', '/api/groups/nope/webhooks')).status).toBe(404);
    const anon = await created.app.request(`/api/groups/${SLUG}/webhooks`);
    expect(anon.status).toBe(401);
    for (const who of ['admin', 'ga']) {
      expect((await call('GET', `/api/groups/${SLUG}/webhooks`, undefined, who)).status).toBe(200);
      expect(
        (await call('PATCH', `/api/groups/${SLUG}/webhooks/${hook.id}`, { name: who }, who)).status,
      ).toBe(200);
      expect(
        (await call('POST', `/api/groups/${SLUG}/webhooks/${hook.id}/test`, undefined, who)).status,
      ).toBe(200);
    }
    expect((await call('DELETE', `/api/groups/${SLUG}/webhooks/${hook.id}`, undefined, 'admin')).status).toBe(
      200,
    );
    expect((await call('GET', `/api/groups/${SLUG}/webhooks/${hook.id}/deliveries`)).status).toBe(404);
  });

  test('别的组的 Webhook：404', async () => {
    const rx = await startReceiver();
    const hook = await createHook({
      name: 'mine',
      format: 'json',
      url: `${rx.base}/p`,
      events: ['request.created'],
    });
    expect((await call('POST', '/api/groups', { slug: 'other', name: '另一个组' })).status).toBe(201);
    for (const [m, p, b] of [
      ['PATCH', `/api/groups/other/webhooks/${hook.id}`, { name: 'z' }],
      ['DELETE', `/api/groups/other/webhooks/${hook.id}`],
      ['GET', `/api/groups/other/webhooks/${hook.id}/deliveries`],
      ['POST', `/api/groups/other/webhooks/${hook.id}/test`],
    ] as [string, string, unknown?][])
      expect((await call(m, p, b)).status, `${m} ${p}`).toBe(404);
    expect((await call('GET', '/api/groups/other/webhooks')).data).toEqual([]);
  });

  test('URL 和密钥：库里是密文，响应和审计里都不回显；修改时 url 不给就保留、secret null 清除', async () => {
    const rx = await startReceiver();
    const url = `${rx.base}/hooks/path-token-123456?access_token=query-token-654321`;
    const secret = 'S3CRET-signing-value';
    const createdRes = await call('POST', `/api/groups/${SLUG}/webhooks`, {
      name: '密钥测试',
      format: 'json',
      url,
      secret,
      events: ['request.created', 'request.executed'],
    });
    expect(createdRes.status).toBe(201);
    const hook = createdRes.data as unknown as WebhookInfo;
    expect(hook).toMatchObject({
      name: '密钥测试',
      format: 'json',
      urlMasked: `http://127.0.0.1:${rx.port}/…`,
      hasSecret: true,
      events: ['request.created', 'request.executed'],
      enabled: true,
      lastDelivery: null,
    });
    const leaks = (text: string) =>
      ['path-token-123456', 'query-token-654321', 'S3CRET'].filter((s) => text.includes(s));
    expect(leaks(createdRes.text)).toEqual([]);

    const [row] = await db.query<{ url_enc: string; secret_enc: string }>(
      'select url_enc, secret_enc from webhooks where id = $1',
      [hook.id],
    );
    expect(row!.url_enc.startsWith('v1:')).toBe(true);
    expect(row!.secret_enc.startsWith('v1:')).toBe(true);
    expect(leaks(row!.url_enc + row!.secret_enc)).toEqual([]);
    expect(decrypt(row!.url_enc)).toBe(url);
    expect(decrypt(row!.secret_enc)).toBe(secret);

    const list = await call('GET', `/api/groups/${SLUG}/webhooks`);
    expect(leaks(list.text)).toEqual([]);

    // 只改名字：URL 和密钥保留
    const renamed = await call('PATCH', `/api/groups/${SLUG}/webhooks/${hook.id}`, { name: '改名' });
    expect(renamed.status).toBe(200);
    expect(leaks(renamed.text)).toEqual([]);
    expect(renamed.data).toMatchObject({ name: '改名', hasSecret: true });
    const [kept] = await db.query<{ url_enc: string; secret_enc: string }>(
      'select url_enc, secret_enc from webhooks where id = $1',
      [hook.id],
    );
    expect(decrypt(kept!.url_enc)).toBe(url);
    expect(decrypt(kept!.secret_enc)).toBe(secret);

    // 换 URL（要再过出站限制）、换密钥、清除密钥
    await setAllowlist([]);
    expect(
      (await call('PATCH', `/api/groups/${SLUG}/webhooks/${hook.id}`, { url: `${rx.base}/new` })).status,
    ).toBe(422);
    await setAllowlist(['127.0.0.0/8']);
    const changed = await call('PATCH', `/api/groups/${SLUG}/webhooks/${hook.id}`, {
      url: `${rx.base}/new-path-token-777777`,
      secret: 'another-S3CRET',
      enabled: false,
    });
    expect(changed.status).toBe(200);
    expect(changed.data).toMatchObject({ enabled: false, hasSecret: true });
    expect(changed.text).not.toContain('777777');
    const cleared = await call('PATCH', `/api/groups/${SLUG}/webhooks/${hook.id}`, { secret: null });
    expect(cleared.data).toMatchObject({ hasSecret: false });
    expect(
      (
        await db.query<{ secret_enc: string | null }>('select secret_enc from webhooks where id = $1', [
          hook.id,
        ])
      )[0]!.secret_enc,
    ).toBeNull();
    // 未知字段（例如想读回 url）被拒绝
    expect((await call('PATCH', `/api/groups/${SLUG}/webhooks/${hook.id}`, { foo: 1 })).status).toBe(400);

    const test = await call('POST', `/api/groups/${SLUG}/webhooks/${hook.id}/test`);
    expect(test.status).toBe(200);
    expect(await call('DELETE', `/api/groups/${SLUG}/webhooks/${hook.id}`)).toMatchObject({
      status: 200,
      data: { ok: true },
    });

    // 审计：四种动作都有，data 里有组、名字、格式、事件、改没改，没有 URL 和密钥
    const audits = await db.query<{ action: string; target_kind: string; data: Record<string, unknown> }>(
      'select action, target_kind, data from audit_events where target_id = $1 order by at, rowid' /* 同一毫秒的按插入顺序（SQLite 的 rowid） */,
      [hook.id],
    );
    expect(audits.map((a) => a.action)).toEqual([
      'webhook.create',
      'webhook.update',
      'webhook.update',
      'webhook.update',
      'webhook.test',
      'webhook.delete',
    ]);
    expect(audits.every((a) => a.target_kind === 'webhook' && a.data.groupId === groupId)).toBe(true);
    expect(audits[0]!.data).toMatchObject({ name: '密钥测试', format: 'json', hasSecret: true });
    expect(audits[1]!.data).toMatchObject({ name: '改名', urlChanged: false, secretChanged: false });
    expect(audits[2]!.data).toMatchObject({ urlChanged: true, secretChanged: true, enabled: false });
    expect(audits[3]!.data).toMatchObject({ urlChanged: false, secretChanged: true, hasSecret: false });
    const auditText = JSON.stringify(audits);
    expect(leaks(auditText)).toEqual([]);
    expect(auditText).not.toContain('777777');
    expect(auditText).not.toContain(rx.base);
  });

  test('发送测试：同步发一条、记进投递记录（test、event = test），失败也是 200；列表带最近一次投递', async () => {
    const rx = await startReceiver();
    const hook = await createHook({
      name: '测试',
      format: 'json',
      url: `${rx.base}/t`,
      secret: 'k',
      events: ['request.created'],
      enabled: false,
    });
    const r = await call('POST', `/api/groups/${SLUG}/webhooks/${hook.id}/test`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      ok: true,
      status: 200,
      test: true,
      event: 'test',
      attempt: 1,
      error: null,
    });
    expect(rx.received).toHaveLength(1);
    const body = JSON.parse(rx.received[0]!.body);
    expect(body.type).toBe('test');
    expect(body.title).toBe('Dowel Webhook 测试');
    expect(body.text).toContain('钩子组');
    expect(rx.received[0]!.headers['x-dowel-event']).toBe('test');

    rx.replies.push((res) => {
      res.writeHead(500);
      res.end();
    });
    const failed = await call('POST', `/api/groups/${SLUG}/webhooks/${hook.id}/test`);
    expect(failed.status).toBe(200);
    expect(failed.data).toMatchObject({ ok: false, status: 500, test: true });
    await created.webhooks.flush();
    // 测试不重试
    expect(rx.received).toHaveLength(2);
    const list = (await call('GET', `/api/groups/${SLUG}/webhooks`)).data as unknown as WebhookInfo[];
    expect(list[0]!.lastDelivery).toMatchObject({ ok: false, status: 500, test: true });
    expect((await deliveries(hook.id)).map((d) => d.ok)).toEqual([false, true]);
  });

  test('遮蔽 URL：只留协议和主机', () => {
    expect(maskWebhookUrl('https://oapi.dingtalk.com/robot/send?access_token=abc')).toBe(
      'https://oapi.dingtalk.com/…',
    );
    expect(maskWebhookUrl('https://user:pass@hooks.example.com:8443/x')).toBe(
      'https://hooks.example.com:8443/…',
    );
  });
});

describe('租约超时与 locked_by 校验（#21）', () => {
  const waitInFlight = async (wh: Webhooks) => {
    const internal = wh as unknown as {
      enqueuing: Set<Promise<unknown>>;
      inFlight: Set<Promise<unknown>>;
    };
    while (internal.enqueuing.size || internal.inFlight.size) {
      await Promise.allSettled([...internal.enqueuing, ...internal.inFlight]);
    }
  };

  const setupIsolated = async (url: string) => {
    const localDb = await openPlatformDb(':memory:');
    await localDb.query(
      `insert into instance_settings (key, value) values ('webhook_allowlist', $1::text::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify(['127.0.0.0/8'])],
    );
    await localDb.query("insert into groups (id, slug, name) values ('g-lease', 'g-lease', '租约组')");
    await localDb.query(
      `insert into webhooks (id, group_id, name, format, url_enc, events, enabled)
       values ('w-lease', 'g-lease', 'lease-hook', 'json', $1, $2::text::jsonb, true)`,
      [encrypt(url), JSON.stringify(['request.created'])],
    );
    return localDb;
  };

  test('副本 A 投递失败重试写回时，若租约已被副本 B 接管，不破坏 locked_by / locked_until / attempts 且跳过本地唤醒', async () => {
    let enteredA!: () => void;
    const inReqA = new Promise<void>((r) => {
      enteredA = r;
    });
    let releaseA!: () => void;
    const holdA = new Promise<void>((r) => {
      releaseA = r;
    });
    const rx = await startReceiver((res) => {
      enteredA();
      void holdA.then(() => {
        res.writeHead(500);
        res.end('temporary failure');
      });
    });

    const localDb = await setupIsolated(`${rx.base}/retry-takeover`);
    const whA = new Webhooks(localDb, {
      retryBaseMs: 50,
      pollIntervalMs: 60_000,
      timeoutMs: 2000,
      leaseMs: 100,
    });
    let wakeCalls = 0;
    const origScheduleWake = (whA as unknown as { scheduleWake: (ms: number) => void }).scheduleWake.bind(
      whA,
    );
    (whA as unknown as { scheduleWake: (ms: number) => void }).scheduleWake = (ms: number) => {
      wakeCalls++;
      origScheduleWake(ms);
    };

    try {
      whA.emit('g-lease', event());
      await inReqA;

      const [claimed] = await localDb.query<{ id: string; locked_by: string | null; attempts: number }>(
        'select id, locked_by, attempts from webhook_jobs',
      );
      expect(claimed).toMatchObject({ locked_by: whA.workerId, attempts: 0 });

      // 模拟租约超时后被副本 B 重领并推进 attempts = 2
      const bLockedUntil = new Date(Date.now() + 60_000);
      await localDb.query(
        'update webhook_jobs set locked_by = $1, locked_until = $2, attempts = 2 where id = $3',
        ['replica-b', bLockedUntil, claimed!.id],
      );

      // 副本 A 迟到的 500 失败尝试完成写回
      releaseA();
      await waitInFlight(whA);

      const [after] = await localDb.query<{
        id: string;
        locked_by: string | null;
        locked_until: string | null;
        attempts: number;
      }>('select id, locked_by, locked_until, attempts from webhook_jobs where id = $1', [claimed!.id]);
      expect(after).toEqual({
        id: claimed!.id,
        locked_by: 'replica-b',
        locked_until: bLockedUntil.toISOString(),
        attempts: 2,
      });
      // 租约已被接管时跳过无谓的本地退避唤醒
      expect(wakeCalls).toBe(0);

      // 关闭副本 A 也不释放副本 B 的锁
      await whA.close();
      const [afterClose] = await localDb.query<{ locked_by: string | null; locked_until: string | null }>(
        'select locked_by, locked_until from webhook_jobs where id = $1',
        [claimed!.id],
      );
      expect(afterClose).toEqual({ locked_by: 'replica-b', locked_until: bLockedUntil.toISOString() });
    } finally {
      await whA.close();
      await localDb.close();
    }
  });

  test('副本 A 投递成功删除时，若租约已被副本 B 接管则不误删；仍由本副本持有时正常删除', async () => {
    let enteredA!: () => void;
    const inReqA = new Promise<void>((r) => {
      enteredA = r;
    });
    let releaseA!: () => void;
    const holdA = new Promise<void>((r) => {
      releaseA = r;
    });
    const rx = await startReceiver();
    rx.replies.push((res) => {
      enteredA();
      void holdA.then(() => ok200(res));
    });

    const localDb = await setupIsolated(`${rx.base}/ok-takeover`);
    const whA = new Webhooks(localDb, {
      retryBaseMs: 50,
      pollIntervalMs: 60_000,
      timeoutMs: 2000,
      leaseMs: 100,
    });

    try {
      whA.emit('g-lease', event());
      await inReqA;

      const [claimed] = await localDb.query<{ id: string }>('select id from webhook_jobs');
      const bLockedUntil = new Date(Date.now() + 60_000);
      await localDb.query(
        'update webhook_jobs set locked_by = $1, locked_until = $2, attempts = 2 where id = $3',
        ['replica-b', bLockedUntil, claimed!.id],
      );

      // 副本 A 迟到的 200 投递完成，不得删除副本 B 持有的任务行
      releaseA();
      await waitInFlight(whA);

      const [after] = await localDb.query<{
        id: string;
        locked_by: string | null;
        locked_until: string | null;
        attempts: number;
      }>('select id, locked_by, locked_until, attempts from webhook_jobs where id = $1', [claimed!.id]);
      expect(after).toEqual({
        id: claimed!.id,
        locked_by: 'replica-b',
        locked_until: bLockedUntil.toISOString(),
        attempts: 2,
      });

      // 当任务重新归属本副本且投递成功时，应正常删除
      await localDb.query('update webhook_jobs set locked_until = $1, next_run_at = $1 where id = $2', [
        new Date(Date.now() - 1000),
        claimed!.id,
      ]);
      whA.wake(false);
      await waitInFlight(whA);
      expect(await localDb.query('select id from webhook_jobs')).toEqual([]);
    } finally {
      await whA.close();
      await localDb.close();
    }
  });

  test('hook 停用清理路径校验 locked_by：租约已被接管时不误删，仍由本副本持有时正常删除', async () => {
    const rx = await startReceiver();
    const localDb = await setupIsolated(`${rx.base}/disabled-takeover`);
    const whA = new Webhooks(localDb, {
      retryBaseMs: 50,
      pollIntervalMs: 60_000,
      timeoutMs: 2000,
      leaseMs: 100,
    });

    const origLoad = (whA as unknown as { load: (id: string) => Promise<unknown> }).load.bind(whA);
    let takeoverOnce = true;
    const bLockedUntil = new Date(Date.now() + 60_000);
    (whA as unknown as { load: (id: string) => Promise<unknown> }).load = async (id: string) => {
      if (takeoverOnce) {
        takeoverOnce = false;
        // 模拟认领后 hook 被停用，且租约超时已被副本 B 接管
        await localDb.query('update webhooks set enabled = false where id = $1', [id]);
        await localDb.query(
          'update webhook_jobs set locked_by = $1, locked_until = $2, attempts = 1 where webhook_id = $3',
          ['replica-b', bLockedUntil, id],
        );
      }
      return origLoad(id);
    };

    try {
      whA.emit('g-lease', event());
      await waitInFlight(whA);

      // 副本 A 命中 !hook?.enabled 清理路径，但因 locked_by 已变为 replica-b，不得误删
      const [after] = await localDb.query<{
        id: string;
        locked_by: string | null;
        locked_until: string | null;
        attempts: number;
      }>('select id, locked_by, locked_until, attempts from webhook_jobs');
      expect(after).toMatchObject({
        locked_by: 'replica-b',
        locked_until: bLockedUntil.toISOString(),
        attempts: 1,
      });

      // 当租约过期重新被本副本持有并读到停用 hook 时，正常删除
      await localDb.query('update webhook_jobs set locked_until = $1, next_run_at = $1 where id = $2', [
        new Date(Date.now() - 1000),
        after!.id,
      ]);
      whA.wake(false);
      await waitInFlight(whA);
      expect(await localDb.query('select id from webhook_jobs')).toEqual([]);
      expect(rx.received).toHaveLength(0);
    } finally {
      await whA.close();
      await localDb.close();
    }
  });
});

describe('close() 排空入队与释放残留锁后的唤醒广播（#27）', () => {
  const waitStartupPump = async (wh: Webhooks) => {
    await new Promise<void>((r) => setTimeout(r, 0));
    const internal = wh as unknown as {
      enqueuing: Set<Promise<unknown>>;
      inFlight: Set<Promise<unknown>>;
    };
    while (internal.enqueuing.size || internal.inFlight.size) {
      await Promise.allSettled([...internal.enqueuing, ...internal.inFlight]);
    }
  };

  const setupCloseEnv = async (url = 'http://127.0.0.1:1/close-hook') => {
    const localDb = await openPlatformDb(':memory:');
    await localDb.query(
      `insert into instance_settings (key, value) values ('webhook_allowlist', $1::text::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify(['127.0.0.0/8'])],
    );
    await localDb.query("insert into groups (id, slug, name) values ('g-close', 'g-close', '关闭组')");
    await localDb.query(
      `insert into webhooks (id, group_id, name, format, url_enc, events, enabled)
       values ('w-close', 'g-close', 'close-hook', 'json', $1, $2::text::jsonb, true)`,
      [encrypt(url), JSON.stringify(['request.created'])],
    );
    const bus = new EventBus(localDb, { replicaId: 'replica-close' });
    await bus.start();
    const published: ClusterEvent[] = [];
    bus.onEvent((ev) => {
      published.push(ev);
    });
    return { localDb, bus, published };
  };

  test('存在由本副本持有的 locked_by 任务时调用 close()，释放锁后会经 bus 广播 webhooks.wake', async () => {
    const { localDb, bus, published } = await setupCloseEnv();
    const wh = new Webhooks(localDb, {
      bus,
      pollIntervalMs: 60_000,
      timeoutMs: 2000,
    });
    try {
      await waitStartupPump(wh);
      const now = new Date();
      await localDb.query(
        `insert into webhook_jobs
           (id, webhook_id, delivery_id, event_type, payload, attempts, max_retries, next_run_at, locked_by, locked_until, created_at)
         values ('job-held', 'w-close', 'del-held', 'request.created', $1::text::jsonb, 0, 3, $2, $3, $4, $2)`,
        [JSON.stringify(event()), now, wh.workerId, new Date(now.getTime() + 60_000)],
      );
      expect(published).toEqual([]);

      await wh.close();

      const [job] = await localDb.query<{ locked_by: string | null; locked_until: string | null }>(
        'select locked_by, locked_until from webhook_jobs where id = $1',
        ['job-held'],
      );
      expect(job).toEqual({ locked_by: null, locked_until: null });
      expect(published).toEqual([{ t: 'webhooks.wake', origin: bus.replicaId }]);

      // 重复调用 close() 幂等，不重复广播
      await wh.close();
      expect(published).toHaveLength(1);
    } finally {
      await wh.close();
      await bus.close();
      await localDb.close();
    }
  });

  test('emit() 入队进行中立即调用 close()，排空入队后会经 bus 广播 webhooks.wake', async () => {
    const { localDb, bus, published } = await setupCloseEnv();
    const wh = new Webhooks(localDb, {
      bus,
      pollIntervalMs: 60_000,
      timeoutMs: 2000,
    });
    try {
      await waitStartupPump(wh);
      expect(published).toEqual([]);

      wh.emit('g-close', event('request.created'));
      await wh.close();

      const jobs = await localDb.query<{
        webhook_id: string;
        locked_by: string | null;
        locked_until: string | null;
      }>('select webhook_id, locked_by, locked_until from webhook_jobs');
      expect(jobs).toEqual([{ webhook_id: 'w-close', locked_by: null, locked_until: null }]);
      expect(published).toEqual([{ t: 'webhooks.wake', origin: bus.replicaId }]);
    } finally {
      await wh.close();
      await bus.close();
      await localDb.close();
    }
  });

  test('无残留锁且无在途入队时调用 close()，不发送多余的 webhooks.wake', async () => {
    const { localDb, bus, published } = await setupCloseEnv();
    const wh = new Webhooks(localDb, {
      bus,
      pollIntervalMs: 60_000,
      timeoutMs: 2000,
    });
    try {
      await waitStartupPump(wh);
      // 即便存在其他副本持有的任务，本副本也未释放锁，不应广播唤醒
      const now = new Date();
      await localDb.query(
        `insert into webhook_jobs
           (id, webhook_id, delivery_id, event_type, payload, attempts, max_retries, next_run_at, locked_by, locked_until, created_at)
         values ('job-other', 'w-close', 'del-other', 'request.created', $1::text::jsonb, 0, 3, $2, 'other-replica', $3, $2)`,
        [JSON.stringify(event()), now, new Date(now.getTime() + 60_000)],
      );
      // 触发一条无匹配 Webhook 的 emit（inserted = 0），也不应产生多余广播
      wh.emit('g-close', event('request.approved'));
      await wh.close();

      const [otherJob] = await localDb.query<{ locked_by: string | null }>(
        'select locked_by from webhook_jobs where id = $1',
        ['job-other'],
      );
      expect(otherJob).toEqual({ locked_by: 'other-replica' });
      expect(published).toEqual([]);
    } finally {
      await wh.close();
      await bus.close();
      await localDb.close();
    }
  });
});

describe('显式 start() 与后台轮询生命周期（#25）', () => {
  test('默认构造不自启后台轮询，显式 start() 后自动拾取遗留任务；未 start() 时 emit + 重试仍正常工作', async () => {
    const rx = await startReceiver();
    const localDb = await openPlatformDb(':memory:');
    await localDb.query(
      `insert into instance_settings (key, value) values ('webhook_allowlist', $1::text::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify(['127.0.0.0/8'])],
    );
    await localDb.query("insert into groups (id, slug, name) values ('g-start', 'g-start', '启动组')");
    await localDb.query(
      `insert into webhooks (id, group_id, name, format, url_enc, events, enabled)
       values ('w-start', 'g-start', 'start-hook', 'json', $1, $2::text::jsonb, true)`,
      [encrypt(`${rx.base}/start-hook`), JSON.stringify(['request.created'])],
    );
    // 预先写入一条已到期的持久化任务（模拟旧进程遗留）
    const now = new Date();
    await localDb.query(
      `insert into webhook_jobs
         (id, webhook_id, delivery_id, event_type, payload, attempts, max_retries, next_run_at, created_at)
       values ('job-legacy', 'w-start', 'del-legacy', 'request.created', $1::text::jsonb, 0, 3, $2, $2)`,
      [JSON.stringify(event()), now],
    );

    const wh = new Webhooks(localDb, {
      retryBaseMs: 25,
      pollIntervalMs: 20,
      timeoutMs: 2000,
    });
    try {
      // 未调用 start()：不应启动后台轮询去主动消费遗留任务
      await new Promise((r) => setTimeout(r, 80));
      expect(rx.received).toHaveLength(0);
      expect(await localDb.query('select id from webhook_jobs')).toEqual([{ id: 'job-legacy' }]);

      // 显式调用 start()（重复调用幂等）：立即拾取遗留任务并完成投递
      wh.start();
      wh.start();
      await wh.flush();
      expect(rx.received).toHaveLength(1);
      expect(rx.received[0]!.headers['x-dowel-delivery']).toBe('del-legacy');
      expect(await localDb.query('select id from webhook_jobs')).toEqual([]);
    } finally {
      await wh.close();
    }

    // 未调用 start() 的实例：通过 emit() + 500 退避重试也能独立完成投递
    rx.received.length = 0;
    rx.replies.push((res) => {
      res.writeHead(500);
      res.end('retry once');
    });
    const whNoPoll = new Webhooks(localDb, {
      retryBaseMs: 25,
      pollIntervalMs: 60_000,
      timeoutMs: 2000,
    });
    try {
      whNoPoll.emit('g-start', event());
      const deadline = Date.now() + 2000;
      while (rx.received.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      expect(rx.received).toHaveLength(2);
      await whNoPoll.flush();
      expect(await localDb.query('select id from webhook_jobs')).toEqual([]);
    } finally {
      await whNoPoll.close();
      await localDb.close();
    }
  });
});

// 平台库是 PG 时：同一套 SQL（布尔 / JSON / 时间列、清理最近 50 条）也能用（没有 Docker 时跳过）
describe.skipIf(!PG_URL)('平台库 PG', () => {
  test('建 Webhook、投递、发送测试、列表与投递记录、清理', async () => {
    const platform = await createTestDb('webhooks_pg');
    const pdb = await openPlatformDb(platform.url);
    const app = createApp(pdb, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      webhooks: { retryBaseMs: RETRY_BASE_MS, timeoutMs: TIMEOUT_MS },
    });
    try {
      await makeUser(pdb, 'pgadmin', { name: '管理员', role: 'admin' });
      const login = await app.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'pgadmin', password: PASSWORD }),
      });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
      const req = async (method: string, path: string, json?: unknown) => {
        const res = await app.app.request(path, {
          method,
          headers: { cookie, ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
          body: json === undefined ? undefined : JSON.stringify(json),
        });
        return { status: res.status, data: (await res.json()) as Record<string, unknown> };
      };
      expect((await req('PATCH', '/api/admin/settings', { webhookAllowlist: ['127.0.0.0/8'] })).status).toBe(
        200,
      );
      const g = await req('POST', '/api/groups', { slug: 'pg', name: 'PG 组' });
      expect(g.status).toBe(201);
      const rx = await startReceiver();
      rx.replies.push((res) => {
        res.writeHead(500);
        res.end();
      });
      const h = await req('POST', '/api/groups/pg/webhooks', {
        name: 'pg',
        format: 'json',
        url: `${rx.base}/pg`,
        events: ['request.created'],
      });
      expect(h.status, JSON.stringify(h.data)).toBe(201);
      const id = h.data.id as string;
      for (let i = 0; i < 26; i++) app.webhooks.emit(g.data.id as string, event());
      await app.webhooks.flush();
      // 第一次 500 重试一次，共 27 次请求
      expect(rx.received).toHaveLength(27);
      const t = await req('POST', `/api/groups/pg/webhooks/${id}/test`);
      expect(t.data).toMatchObject({ ok: true, test: true, event: 'test' });
      for (let i = 0; i < 30; i++) app.webhooks.emit(g.data.id as string, event());
      await app.webhooks.flush();
      const logs = (await req('GET', `/api/groups/pg/webhooks/${id}/deliveries`))
        .data as unknown as WebhookDelivery[];
      expect(logs).toHaveLength(50);
      expect(logs.every((d) => typeof d.at === 'string' && typeof d.ok === 'boolean')).toBe(true);
      const list = (await req('GET', '/api/groups/pg/webhooks')).data as unknown as WebhookInfo[];
      expect(list[0]).toMatchObject({ enabled: true, hasSecret: false, events: ['request.created'] });
      expect(list[0]!.lastDelivery).toMatchObject({ ok: true });
      expect((await req('DELETE', `/api/groups/pg/webhooks/${id}`)).status).toBe(200);
    } finally {
      await app.webhooks.close();
      await app.rooms.flush();
      await app.shadows.close();
      await pdb.close();
      await platform.close();
    }
  });
});
