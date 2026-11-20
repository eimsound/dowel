// 同步层：固定场景 + 随机测试（多客户端、随机延迟、断线重连、草稿）。
// 原型和结论见 .agents/docs/01-research.md 第 9 节。
import { all, emptyModel, exprReferences, type Model, newId, validate } from '@dowel/core';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  emptyRoomState,
  isValidClientId,
  memoryStore,
  type Rejection,
  Room,
  SyncClient,
  type ToClient,
  type ToServer,
  type Versions,
} from '../src/index.ts';

// ───── 模拟网络：虚拟时钟、随机延迟、同一连接内保持顺序、断线丢消息、重连是新连接 ─────
class Net {
  now = 0;
  queue: { at: number; k: number; run: () => Promise<void> | void }[] = [];
  lastAt = new Map<string, number>();
  epoch = new Map<string, number>();
  k = 0;
  room: Room;
  clients = new Map<string, SyncClient>();
  users = new Map<string, string>();
  rnd: () => number;
  constructor(model: Model, rnd: () => number) {
    this.rnd = rnd;
    this.room = new Room(emptyRoomState(model), memoryStore());
  }
  private schedule(link: string, run: () => Promise<void> | void) {
    const at = Math.max(this.lastAt.get(link) ?? 0, this.now + 1 + Math.floor(this.rnd() * 30));
    this.lastAt.set(link, at);
    this.queue.push({ at, k: this.k++, run });
  }
  private toClient(id: string, msg: ToClient) {
    const c = this.clients.get(id)!;
    if (!c.online) return;
    const ep = this.epoch.get(id);
    const copy = structuredClone(msg);
    this.schedule(`s>${id}`, () => {
      if (c.online && this.epoch.get(id) === ep) c.receive(copy);
    });
  }
  add(id: string, user: string) {
    const c = new SyncClient(id, emptyModel());
    this.clients.set(id, c);
    this.users.set(id, user);
    this.epoch.set(id, 0);
    c.send = (msg: ToServer) => {
      const ep = this.epoch.get(id);
      const copy = structuredClone(msg);
      this.schedule(`${id}>s`, async () => {
        if (!(c.online && this.epoch.get(id) === ep)) return;
        for (const o of await this.room.handle(id, user, copy)) {
          if (o.to === '*') for (const cid of this.clients.keys()) this.toClient(cid, o.msg);
          else this.toClient(o.to, o.msg);
        }
      });
    };
    c.connect();
    return c;
  }
  disconnect(id: string) {
    this.clients.get(id)!.disconnect();
  }
  reconnect(id: string) {
    this.epoch.set(id, (this.epoch.get(id) ?? 0) + 1);
    this.clients.get(id)!.connect();
  }
  async step() {
    this.queue.sort((a, b) => a.at - b.at || a.k - b.k);
    const e = this.queue.shift();
    if (!e) return false;
    this.now = e.at;
    await e.run();
    return true;
  }
  async settle() {
    while (await this.step());
  }
  async until(cond: () => boolean) {
    while (!cond() && (await this.step()));
  }
  async advance(dt: number) {
    const end = this.now + dt;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.k - b.k);
      if (!this.queue.length || this.queue[0]!.at > end) break;
      await this.step();
    }
    this.now = end;
  }
}

const mulberry32 = (a: number) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const same = (a: Model, b: Model) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(sortKeys)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, sortKeys((x as Record<string, unknown>)[k])]),
        )
      : x;

/** 服务器状态的语义不变量：模型一致性校验通过；CHECK 只引用本表存在的列 */
const invariant = (m: Model): string | null => {
  const errs = validate(m);
  if (errs.length) return errs[0]!;
  for (const k of all(m, 'check')) {
    const cols = new Set(
      all(m, 'column')
        .filter((c) => c.parent === k.parent)
        .map((c) => c.name),
    );
    for (const w of k.expr.match(/[a-z_]+/g) ?? [])
      if (!cols.has(w) && exprReferences(k.expr, w)) return `CHECK ${k.name} 引用了不存在的列 ${w}`;
  }
  return null;
};

// ───── 固定场景 ─────

/** 初始模型：public.users(id, email, age) */
const setup = async (seed = 1) => {
  const m = emptyModel();
  const net = new Net(m, mulberry32(seed));
  const zhang = net.add('zhang', '张三');
  const li = net.add('li', '李四');
  await net.settle();
  zhang.mutate('createSchema', { id: 's', name: 'public' });
  zhang.mutate('createTable', { id: 't', schema: 's', name: 'users' });
  for (const [id, name, type] of [
    ['c1', 'id', 'integer'],
    ['c2', 'email', 'text'],
    ['c3', 'age', 'integer'],
  ] as const)
    zhang.mutate('addColumn', { table: 't', column: { id, name, type } });
  await net.settle();
  return { net, zhang, li };
};

describe('同步：固定场景', () => {
  test('李四编辑 CHECK 期间，张三把 email 改名为 mail（张三先到）→ 李四被拒绝并刷新', async () => {
    const { net, zhang, li } = await setup();
    const draft: Versions = li.basisOf(['t', 'c2']); // 李四打开编辑框
    zhang.mutate('renameColumn', { id: 'c2', name: 'mail' });
    await net.until(() => net.room.seq === 6); // 张三的修改已被服务器处理，广播还没到李四
    li.mutate('addCheck', { id: 'k1', table: 't', expr: "email LIKE '%@%'" }, draft);
    await net.settle();
    expect(li.notices.map((x) => x.message)).toEqual(['列 mail 已被 张三 修改，请在最新数据上重新操作']);
    expect(all(net.room.model, 'check')).toEqual([]);
    for (const c of [zhang, li]) expect(same(c.view, net.room.model)).toBe(true);
  });

  test('张三改 age，李四同时给 email 加 CHECK → 都成功', async () => {
    const { net, zhang, li } = await setup();
    zhang.mutate('renameColumn', { id: 'c3', name: 'years' });
    li.mutate('addCheck', { id: 'k1', table: 't', expr: "(email <> '')" });
    await net.settle();
    expect(li.notices).toEqual([]);
    expect(all(net.room.model, 'check').map((k) => k.expr)).toEqual(["(email <> '')"]);
  });

  test('先加 CHECK 再改名 → 表达式和推导名都跟着改', async () => {
    const { net, zhang, li } = await setup();
    li.mutate('addCheck', { id: 'k1', table: 't', expr: "(email <> '')" });
    await net.settle();
    zhang.mutate('renameColumn', { id: 'c2', name: 'mail' });
    await net.settle();
    const k = all(net.room.model, 'check')[0]!;
    expect([k.expr, k.name]).toEqual(["(mail <> '')", 'users_mail_check']);
  });

  test('连发三个修改，第 1 个冲突 → 依赖它的第 2 个也被拒绝，无关的第 3 个成功', async () => {
    const { net, zhang, li } = await setup();
    zhang.mutate('renameColumn', { id: 'c2', name: 'mail' });
    await net.until(() => net.room.seq === 6);
    li.mutate('renameColumn', { id: 'c2', name: 'e2' });
    li.mutate('addCheck', { id: 'k1', table: 't', expr: "(e2 <> '')" });
    li.mutate('addColumn', { table: 't', column: { id: 'c9', name: 'nickname', type: 'text' } });
    await net.settle();
    expect(li.notices.length).toBe(2);
    expect(
      all(net.room.model, 'column')
        .map((c) => c.name)
        .sort(),
    ).toEqual(['age', 'id', 'mail', 'nickname']);
  });

  test('断线期间各自修改，重连后补发；确认丢失后重发不会重复生效', async () => {
    const { net, zhang, li } = await setup();
    net.disconnect('li');
    li.mutate('addColumn', { table: 't', column: { id: 'c9', name: 'nickname', type: 'text' } });
    zhang.mutate('renameColumn', { id: 'c3', name: 'years' });
    await net.settle();
    net.reconnect('li');
    await net.settle();
    li.mutate('addColumn', { table: 't', column: { id: 'c8', name: 'phone', type: 'text' } });
    await net.advance(1);
    net.disconnect('li');
    await net.settle();
    net.reconnect('li');
    await net.settle();
    expect(
      all(net.room.model, 'column')
        .map((c) => c.name)
        .sort(),
    ).toEqual(['email', 'id', 'nickname', 'phone', 'years']);
    for (const c of [zhang, li]) expect(same(c.view, net.room.model)).toBe(true);
  });

  test('只读拒绝不推进 processed、不调用 store.reject，且禁止保留标识 system 与跨客户端依赖探测', async () => {
    expect(isValidClientId('tab-123')).toBe(true);
    expect(isValidClientId('')).toBe(false);
    expect(isValidClientId('system')).toBe(false);
    expect(isValidClientId('SYSTEM')).toBe(false);
    expect(isValidClientId('a'.repeat(129))).toBe(false);
    expect(isValidClientId('u1:tab-1')).toBe(false);
    expect(isValidClientId('tab\n1')).toBe(false);

    const rejectedCalls: { client: string; r: Rejection }[] = [];
    const baseStore = memoryStore();
    const store = {
      append: baseStore.append,
      reject: async (client: string, r: Rejection) => {
        rejectedCalls.push({ client, r });
      },
    };
    const m = emptyModel();
    const room = new Room(emptyRoomState(m), store);
    await room.handle('u1:c1', '张三', {
      t: 'op',
      op: { client: 'u1:c1', n: 1, name: 'createSchema', args: { id: 's', name: 'public' }, reads: [] },
    });

    // 保留标识 system 直接被 Room.handle 拒绝，无法干扰 replace
    await expect(
      room.handle('system', '攻击者', { t: 'hello', client: 'system', lastSeq: 0 }),
    ).rejects.toThrow('无效的客户端标识');
    const replaced = await room.replace('管理员', room.model, 'replaceModel');
    expect(replaced[0]?.msg).toMatchObject({ t: 'commit', client: 'system', n: 1 });

    // 只读拒绝绝不推进 processed、绝不写入 store.reject，连发多条也不报乱序
    const ro1 = await room.handle(
      'u1:c1',
      '只读者',
      {
        t: 'op',
        op: {
          client: 'u1:c1',
          n: 2,
          name: 'createTable',
          args: { id: 't_bad', schema: 's', name: 'bad' },
          reads: [['s', 1]],
        },
      },
      { readOnly: true },
    );
    expect(ro1).toEqual([
      {
        to: 'u1:c1',
        msg: { t: 'reject', n: 2, code: 'invalid', message: '你在这个项目里是查看者，不能修改' },
      },
    ]);
    const ro2 = await room.handle(
      'u1:c1',
      '只读者',
      {
        t: 'op',
        op: {
          client: 'u1:c1',
          n: 5,
          name: 'createTable',
          args: { id: 't_bad2', schema: 's', name: 'bad2' },
          reads: [['s', 1]],
        },
      },
      { readOnly: true },
    );
    expect(ro2[0]?.msg).toMatchObject({ t: 'reject', n: 5, code: 'invalid' });
    expect(rejectedCalls).toEqual([]);

    // 合法编辑者随后提交 n=2 必须正常提交生效
    const ok = await room.handle('u1:c1', '张三', {
      t: 'op',
      op: {
        client: 'u1:c1',
        n: 2,
        name: 'createTable',
        args: { id: 't_ok', schema: 's', name: 'orders' },
        reads: [['s', 1]],
      },
    });
    expect(ok[0]?.msg).toMatchObject({ t: 'commit', client: 'u1:c1', n: 2 });
    expect(all(room.model, 'table').map((t) => t.name)).toEqual(['orders']);

    // 跨客户端伪造 p:<他人client>:<n> 依赖引用必须被拒绝
    const probe = await room.handle('u2:c2', '李四', {
      t: 'op',
      op: {
        client: 'u2:c2',
        n: 1,
        name: 'createTable',
        args: { id: 't_probe', schema: 's', name: 'probe' },
        reads: [['t_ok', 'p:u1:c1:2']],
      },
    });
    expect(probe[0]?.msg).toMatchObject({ t: 'reject', n: 1, code: 'dependency' });
  });
});

// ───── 随机测试 ─────

const NAMES = ['a', 'b', 'c', 'x', 'y'];

/** 在客户端当前看到的模型上随机挑一个修改 */
const randomOp = (m: Model, r: () => number): [string, unknown] | null => {
  const pick = <T>(xs: T[]) => (xs.length ? xs[Math.floor(r() * xs.length)] : undefined);
  const tables = all(m, 'table');
  const cols = all(m, 'column');
  const checks = all(m, 'check');
  const t = pick(tables);
  const name = pick(NAMES)!;
  const x = r();
  if (!tables.length || x < 0.08) {
    const s = pick(all(m, 'schema'));
    return s ? ['createTable', { id: newId(), schema: s.id, name }] : ['createSchema', { id: newId(), name }];
  }
  if (x < 0.35) return ['addColumn', { table: t!.id, column: { id: newId(), name, type: 'integer' } }];
  if (x < 0.55 && cols.length) return ['renameColumn', { id: pick(cols)!.id, name }];
  if (x < 0.65 && cols.length) return ['dropColumn', { id: pick(cols)!.id }];
  if (x < 0.85) {
    const tc = cols.filter((c) => c.parent === t!.id);
    const refs = [pick(tc)?.name, pick(tc)?.name].filter(Boolean);
    if (!refs.length) return null;
    const expr = refs.map((n) => `(${n} > 0)`).join(' AND ');
    const k = r() < 0.5 ? pick(checks.filter((k) => k.parent === t!.id)) : undefined;
    return k ? ['setCheckExpr', { id: k.id, expr }] : ['addCheck', { id: newId(), table: t!.id, expr }];
  }
  if (x < 0.92) return ['renameTable', { id: t!.id, name }];
  return ['dropTable', { id: t!.id }];
};

test('同步：随机测试（4 个客户端，随机延迟、断线、草稿）', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer(), async (seed) => {
      const r = mulberry32(seed);
      const net = new Net(emptyModel(), r);
      const ids = ['a', 'b', 'c', 'd'];
      for (const id of ids) net.add(id, id);
      await net.settle();
      net.clients.get('a')!.mutate('createSchema', { id: 's', name: 'public' });
      await net.settle();
      const drafts = new Map<string, Versions>();
      let violation: string | null = null;
      for (let i = 0; i < 150; i++) {
        const id = ids[Math.floor(r() * ids.length)]!;
        const c = net.clients.get(id)!;
        const x = r();
        if (x < 0.05) {
          if (c.online) net.disconnect(id);
          else net.reconnect(id);
          continue;
        }
        if (x < 0.12) {
          drafts.set(id, c.basisOf(Object.keys(c.view.objects)));
          continue;
        }
        const op = randomOp(c.view, r);
        if (op) {
          try {
            c.mutate(op[0], op[1], r() < 0.5 ? drafts.get(id) : undefined);
          } catch {
            // 本地不合法：不发给服务器
          }
        }
        await net.advance(Math.floor(r() * 15));
        violation ??= invariant(net.room.model);
      }
      for (const id of ids) if (!net.clients.get(id)!.online) net.reconnect(id);
      await net.settle();
      expect(violation).toBeNull();
      expect(invariant(net.room.model)).toBeNull();
      for (const c of net.clients.values()) {
        expect(c.pending).toEqual([]);
        expect(same(c.view, net.room.model)).toBe(true);
      }
    }),
    { numRuns: Number(process.env.SYNC_RUNS ?? 200) },
  );
}, 600_000);
