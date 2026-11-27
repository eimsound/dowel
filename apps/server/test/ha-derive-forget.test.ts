// 跨副本删除项目时 OpaqueRefresher 的 forget 同步（Issue #153，真实 PG 双副本，ADR 0011 / ADR 0016）：
// 1. 副本 A 删除项目 → 副本 B 收到 derive.forget：内存基线清掉（tracked = false）；
// 2. 副本 B 正在 POST /normalize（影子库 canonicalize 中）时副本 A 删除项目：B 回 404（不回 200 verified / 422）；
// 3. 副本 B 正在 flush 时副本 A 删除项目、随后 B 的影子库被关闭：B 返回 skipped('forgotten')（不报 shadow_unavailable）；
// 4. 副本 B 收不到 A 的事件（总线断开）：在途 normalize 仍回 404（保存基线更新 0 行），重连后复核清掉残留的内存基线。
import {
  addCheck,
  addColumn,
  all,
  createSchema,
  createTable,
  type Model,
  newId,
  type Obj,
} from '@dowel/core';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp } from '../src/app.ts';
import { openPlatformDb, type PlatformDb } from '../src/db.ts';
import { type Shadow, ShadowError } from '../src/shadow.ts';
import { editModel, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'ha-derive-forget-secret-0123456789';

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

type App = ReturnType<typeof createApp>;

const call = async (app: App['app'], method: string, path: string, json?: unknown, cookie = '') => {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await app.request(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return {
    status: res.status,
    data: data as Record<string, unknown>,
    cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '',
  };
};

/** B 上影子库 canonicalize 卡住，由测试决定结局 */
const gatedShadow = () => {
  const entered = deferred();
  const result = deferred<'empty' | 'canonical'>();
  const shadow = {
    canonicalize: async (_prev: Model, next: Model): Promise<Obj[]> => {
      entered.resolve();
      const r = await result.promise;
      if (r === 'empty') return [];
      return Object.values(next.objects)
        .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
        .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj);
    },
    close: async () => {},
  } as unknown as Shadow;
  return { entered, result, shadow };
};

interface Fixture {
  dbA: PlatformDb;
  dbB: PlatformDb;
  appA: App;
  appB: App;
  cookie: string;
  pid: string;
  slug: string;
  branchId: string;
  channelB: string;
  /** B 收到 t 类型事件（在 B 自己的处理器之后触发） */
  arrivedOnB: (t: string) => Promise<void>;
  close: () => Promise<void>;
}

const fixtures: Fixture[] = [];

/** sameChannel = false：B 订阅另一个通道，收不到 A 发出的任何事件（模拟 B 的 LISTEN 断开期间错过删除） */
const setup = async (tag: string, sameChannel = true): Promise<Fixture> => {
  const pg = await createTestDb(tag);
  const dbA = await openPlatformDb(pg.url);
  const dbB = await openPlatformDb(pg.url);
  const channel = `dowel_ha_dforget_${tag}_${newId()
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 8)
    .toLowerCase()}`;
  const channelB = sameChannel ? channel : `${channel}_b`;
  const appA = createApp(dbA, { bus: { replicaId: `${tag}-a`, channel } });
  const appB = createApp(dbB, { bus: { replicaId: `${tag}-b`, channel: channelB } });
  await appA.bus.start();
  await appB.bus.start();
  const waiters = new Map<string, (() => void)[]>();
  appB.bus.onEvent((e) => {
    for (const w of waiters.get(e.t)?.splice(0) ?? []) w();
  });
  const arrivedOnB = (t: string) =>
    new Promise<void>((resolve) => waiters.set(t, [...(waiters.get(t) ?? []), resolve]));

  await makeUser(dbA, 'admin', { name: '管理员', role: 'admin' });
  const login = await call(appA.app, 'POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
  expect(login.status).toBe(200);
  const cookie = login.cookie;
  const slug = tag.replace(/_/g, '-');
  const grp = await call(appA.app, 'POST', '/api/groups', { slug, name: tag, defaultRole: 'none' }, cookie);
  expect(grp.status).toBe(201);
  const proj = await call(
    appA.app,
    'POST',
    '/api/projects',
    { name: tag, slug, groupId: grp.data.id },
    cookie,
  );
  expect(proj.status, JSON.stringify(proj.data)).toBe(201);
  const pid = proj.data.id as string;
  const [b] = await dbA.query<{ id: string }>(
    "select id from branches where project_id = $1 and name = 'main'",
    [pid],
  );
  // 副本 B 的工作副本带一条待规范化的 CHECK（直接替换房间，不改写黄金基线）
  await editModel(appB.rooms, dbB, pid, (m) => {
    const schema = all(m, 'schema')[0]?.id ?? createSchema(m, 'public');
    const t = createTable(m, schema, 'orders');
    addColumn(m, t, { name: 'total', type: 'integer' });
    addCheck(m, t, 'total>0', 'ck_total');
  });

  const f: Fixture = {
    dbA,
    dbB,
    appA,
    appB,
    cookie,
    pid,
    slug,
    branchId: b!.id,
    channelB,
    arrivedOnB,
    close: async () => {
      for (const app of [appA, appB]) {
        app.refresher.stop();
        await app.refresher.drain();
        app.rooms.close();
        await app.rooms.flush();
        await app.shadows.close();
        await app.bus.close();
      }
      await dbA.close();
      await dbB.close();
      await pg.close();
    },
  };
  fixtures.push(f);
  return f;
};

const deleteOnA = (f: Fixture) =>
  call(f.appA.app, 'DELETE', `/api/projects/${f.pid}`, { confirm: f.slug }, f.cookie);

describe.skipIf(!PG_URL)('跨副本删除项目：OpaqueRefresher.forget 同步（Issue #153，真实 PG 双副本）', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const f of fixtures.splice(0)) await f.close();
  });

  test('1. 副本 A 删除项目后副本 B 收到 derive.forget，不再残留内存基线', async () => {
    const f = await setup('dforget_clear');
    await f.appB.refresher.reset(f.branchId, (await f.appB.rooms.model(f.branchId)).model);
    expect(f.appB.refresher.tracked(f.branchId)).toBe(true);
    const arrived = f.arrivedOnB('derive.forget');
    expect((await deleteOnA(f)).status).toBe(200);
    await arrived;
    expect(f.appB.refresher.tracked(f.branchId)).toBe(false);
  });

  test('2. 副本 B 在途 POST /normalize（canonicalize 中）期间副本 A 删除项目 → B 回 404，不回 200 verified', async () => {
    const f = await setup('dforget_norm');
    const g = gatedShadow();
    f.appB.shadows.forProjectTarget = async () => ({ shadow: g.shadow, label: 'fake-shadow' });
    const res = call(f.appB.app, 'POST', `/api/projects/${f.pid}/normalize`, {}, f.cookie);
    await g.entered.promise;
    const arrived = f.arrivedOnB('derive.forget');
    expect((await deleteOnA(f)).status).toBe(200);
    await arrived;
    // 最坏情况：影子库还开着、canonicalize 认为没什么要改的（main 上会报 200 verified）
    g.result.resolve('empty');
    const out = await res;
    expect(out.status, JSON.stringify(out.data)).toBe(404);
    await f.appB.refresher.drain();
    expect(f.appB.refresher.tracked(f.branchId)).toBe(false);
  });

  test('3. 副本 B 在途 flush 期间副本 A 删除项目、随后 B 的影子库被关闭 → skipped(forgotten)，不打告警', async () => {
    const f = await setup('dforget_flush');
    const g = gatedShadow();
    f.appB.shadows.forProjectTarget = async () => ({ shadow: g.shadow, label: 'fake-shadow' });
    const warn = vi.spyOn(console, 'warn');
    const p = f.appB.refresher.flush(f.branchId);
    await g.entered.promise;
    const arrived = Promise.all([f.arrivedOnB('derive.forget'), f.arrivedOnB('shadows.forget')]);
    expect((await deleteOnA(f)).status).toBe(200);
    await arrived;
    g.result.reject(new ShadowError('影子库连接已关闭'));
    await expect(p).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('规范化'), expect.anything());
    await f.appB.refresher.drain();
    expect(f.appB.refresher.tracked(f.branchId)).toBe(false);
  });

  test('4. 副本 B 收不到事件（总线断开）：在途 normalize 仍回 404；重连后复核清掉残留的内存基线', async () => {
    const f = await setup('dforget_missed', false);
    // (a) 在途 normalize：事件到不了 B，保存基线更新 0 行 → 404
    const g = gatedShadow();
    f.appB.shadows.forProjectTarget = async () => ({ shadow: g.shadow, label: 'fake-shadow' });
    const res = call(f.appB.app, 'POST', `/api/projects/${f.pid}/normalize`, {}, f.cookie);
    await g.entered.promise;
    expect((await deleteOnA(f)).status).toBe(200);
    g.result.resolve('empty');
    const out = await res;
    expect(out.status, JSON.stringify(out.data)).toBe(404);
    await f.appB.refresher.drain();
    expect(f.appB.refresher.tracked(f.branchId)).toBe(false);
  });

  test('5. 副本 B 断线期间错过删除：LISTEN 重连后按 branches 复核，清掉已删分支的内存基线', async () => {
    const f = await setup('dforget_reconn', false);
    await f.appB.refresher.reset(f.branchId, (await f.appB.rooms.model(f.branchId)).model);
    expect((await deleteOnA(f)).status).toBe(200);
    // B 收不到 A 的事件：仍残留内存基线
    expect(f.appB.refresher.tracked(f.branchId)).toBe(true);
    const reconnected = deferred();
    f.appB.bus.onReconnect(() => reconnected.resolve());
    // 强杀 B 的 LISTEN 连接，触发 postgres.js 自动重连与 bus.onReconnect
    await f.dbA.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and query ilike $1`,
      [`listen%${f.channelB}%`],
    );
    await reconnected.promise;
    await vi.waitFor(() => expect(f.appB.refresher.tracked(f.branchId)).toBe(false), { timeout: 10_000 });
  });
});
