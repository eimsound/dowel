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
      append: (...args: Parameters<typeof baseStore.append>) => baseStore.append(...args),
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

  test('outcome 有界裁剪：按最近插入/访问顺序淘汰旧记录，保护活跃依赖与去重窗口，且系统提交不挤占额度', async () => {
    const room = new Room(emptyRoomState(emptyModel()), memoryStore(), { outcomeLimit: 4 });
    await room.handle('c1', '张三', {
      t: 'op',
      op: { client: 'c1', n: 1, name: 'createSchema', args: { id: 's', name: 'public' }, reads: [] },
    });
    await room.handle('c1', '张三', {
      t: 'op',
      op: {
        client: 'c1',
        n: 2,
        name: 'createTable',
        args: { id: 't1', schema: 's', name: 't1' },
        reads: [['s', 'p:c1:1']],
      },
    });

    // 系统提交（replace / patch）不进入 outcome，不会挤掉活跃客户端的待确认结果
    await room.replace('管理员', room.model, 'replaceModel');
    await room.replace('管理员', room.model, 'replaceModel');
    expect(room.stats.outcome).toBe(2);

    // c2 提交 1 次，c1 再提交第 3 次并引用 p:c1:1（刷新 c1:1 到较新位置）
    // 此时 outcome 满额 4 条，顺序为 [c1:2, c2:1, c1:1, c1:3]
    await room.handle('c2', '李四', {
      t: 'op',
      op: {
        client: 'c2',
        n: 1,
        name: 'createTable',
        args: { id: 't2', schema: 's', name: 't2' },
        reads: [['s', 1]],
      },
    });
    const refreshC1 = await room.handle('c1', '张三', {
      t: 'op',
      op: {
        client: 'c1',
        n: 3,
        name: 'createTable',
        args: { id: 't3', schema: 's', name: 't3' },
        reads: [['s', 'p:c1:1']],
      },
    });
    expect(refreshC1[0]?.msg).toMatchObject({ t: 'commit', client: 'c1', n: 3 });
    expect(room.stats.outcome).toBe(4);

    // c2 再提交 1 次：最久未使用的 c1:2 被淘汰，但被引用刷新保活的 c1:1 仍保留
    await room.handle('c2', '李四', {
      t: 'op',
      op: {
        client: 'c2',
        n: 2,
        name: 'createTable',
        args: { id: 't4', schema: 's', name: 't4' },
        reads: [['s', 1]],
      },
    });
    expect(room.stats.outcome).toBe(4);

    // c1 仍可引用被刷新保活的 p:c1:1
    const stillValid = await room.handle('c1', '张三', {
      t: 'op',
      op: {
        client: 'c1',
        n: 4,
        name: 'createTable',
        args: { id: 't5', schema: 's', name: 't5' },
        reads: [['s', 'p:c1:1']],
      },
    });
    expect(stillValid[0]?.msg).toMatchObject({ t: 'commit', client: 'c1', n: 4 });

    // c1 引用已被淘汰的 p:c1:2 时返回 dependency 拒绝
    const evictedRef = await room.handle('c1', '张三', {
      t: 'op',
      op: {
        client: 'c1',
        n: 5,
        name: 'addColumn',
        args: { table: 't1', column: { id: 'col1', name: 'id', type: 'integer' } },
        reads: [['t1', 'p:c1:2']],
      },
    });
    expect(evictedRef[0]?.msg).toEqual({
      t: 'reject',
      n: 5,
      code: 'dependency',
      message: '依赖的修改不存在',
    });
    expect(room.stats.outcome).toBe(4);

    // outcome 淘汰后，lastProcessed 与重复发送去重语义仍完全保留
    const dup = await room.handle('c1', '张三', {
      t: 'op',
      op: {
        client: 'c1',
        n: 2,
        name: 'createTable',
        args: { id: 't1_dup', schema: 's', name: 't1_dup' },
        reads: [],
      },
    });
    expect(dup).toEqual([]);
    const welcome = await room.handle('c1', '张三', { t: 'hello', client: 'c1', lastSeq: room.seq });
    expect(welcome[0]?.msg).toMatchObject({ t: 'welcome', lastProcessed: 5 });
  });

  test('rejections 单客户端与全局上限裁剪，兼容外部全量重放且不挤掉活跃客户端拒绝记录', async () => {
    const room = new Room(emptyRoomState(emptyModel()), memoryStore(), {
      rejectionsPerClientLimit: 3,
      rejectionsLimit: 5,
      outcomeLimit: 4,
    });

    // c1 连续触发 5 次拒绝（缺少 schema，renameSchema 直接报 EditError）
    for (let n = 1; n <= 5; n++) {
      const out = await room.handle('c1', '张三', {
        t: 'op',
        op: { client: 'c1', n, name: 'renameSchema', args: { id: 'missing', name: `s${n}` }, reads: [] },
      });
      expect(out[0]?.msg).toMatchObject({ t: 'reject', n, code: 'invalid' });
    }
    expect(room.stats.rejections).toBe(3);
    expect(room.stats.rejectionClients).toBe(1);

    // c1 重连握手：lastProcessed 为 5，仅保留最近的 [3, 4, 5]，重发旧 op n=1 仍按去重忽略
    const helloC1 = await room.handle('c1', '张三', { t: 'hello', client: 'c1', lastSeq: 0 });
    expect(helloC1[0]?.msg).toMatchObject({
      t: 'welcome',
      lastProcessed: 5,
      rejected: [
        expect.objectContaining({ n: 3 }),
        expect.objectContaining({ n: 4 }),
        expect.objectContaining({ n: 5 }),
      ],
    });
    expect(
      await room.handle('c1', '张三', {
        t: 'op',
        op: { client: 'c1', n: 1, name: 'renameSchema', args: { id: 'missing', name: 'dup' }, reads: [] },
      }),
    ).toEqual([]);

    // c2 与 c3 产生 5 条新拒绝，达到全局上限 5 后淘汰最旧的 c1 拒绝记录并清理空键
    for (let n = 1; n <= 3; n++) {
      await room.handle('c2', '李四', {
        t: 'op',
        op: { client: 'c2', n, name: 'renameSchema', args: { id: 'missing', name: `b${n}` }, reads: [] },
      });
    }
    for (let n = 1; n <= 2; n++) {
      await room.handle('c3', '王五', {
        t: 'op',
        op: { client: 'c3', n, name: 'renameSchema', args: { id: 'missing', name: `w${n}` }, reads: [] },
      });
    }
    expect(room.stats.rejections).toBe(5);
    expect(room.stats.rejectionClients).toBe(2);

    // 模拟 rooms.ts catchUpFrom 按 (client, n) 全量重放历史拒绝记录：已淘汰和已存在的记录一律幂等返回 false，绝不挤掉 c2/c3
    for (let n = 1; n <= 5; n++) {
      expect(room.applyExternalRejection('c1', { n, code: 'invalid', message: '旧拒绝' })).toBe(false);
    }
    for (let n = 1; n <= 3; n++) {
      expect(room.applyExternalRejection('c2', { n, code: 'invalid', message: '已存在' })).toBe(false);
    }
    const helloC2 = await room.handle('c2', '李四', { t: 'hello', client: 'c2', lastSeq: 0 });
    expect(helloC2[0]?.msg).toMatchObject({
      t: 'welcome',
      lastProcessed: 3,
      rejected: [
        expect.objectContaining({ n: 1 }),
        expect.objectContaining({ n: 2 }),
        expect.objectContaining({ n: 3 }),
      ],
    });
    const helloC3 = await room.handle('c3', '王五', { t: 'hello', client: 'c3', lastSeq: 0 });
    expect(helloC3[0]?.msg).toMatchObject({
      t: 'welcome',
      lastProcessed: 2,
      rejected: [expect.objectContaining({ n: 1 }), expect.objectContaining({ n: 2 })],
    });

    // c1 真正新增的外部拒绝 n=6 仍可正常合入并推进 lastProcessed
    expect(room.applyExternalRejection('c1', { n: 6, code: 'conflict', message: '新冲突' })).toBe(true);
    expect(room.stats.rejections).toBe(5);
    const helloC1After = await room.handle('c1', '张三', { t: 'hello', client: 'c1', lastSeq: 0 });
    expect(helloC1After[0]?.msg).toEqual({
      t: 'welcome',
      lastProcessed: 6,
      rejected: [{ n: 6, code: 'conflict', message: '新冲突' }],
    });

    // 乱序外部合入（先 n=10 后 n=9）触发全局裁剪时，同一客户端优先淘汰更旧的 n=9 而保留 n=10
    const oooRoom = new Room(emptyRoomState(emptyModel()), memoryStore(), {
      rejectionsPerClientLimit: 3,
      rejectionsLimit: 1,
    });
    expect(oooRoom.applyExternalRejection('c_ooo', { n: 10, code: 'conflict', message: '较新' })).toBe(true);
    expect(oooRoom.applyExternalRejection('c_ooo', { n: 9, code: 'conflict', message: '较旧' })).toBe(false);
    const oooHello = await oooRoom.handle('c_ooo', '测试', { t: 'hello', client: 'c_ooo', lastSeq: 0 });
    expect(oooHello[0]?.msg).toEqual({
      t: 'welcome',
      lastProcessed: 10,
      rejected: [{ n: 10, code: 'conflict', message: '较新' }],
    });

    // 构造器快照重载时自动裁剪超量历史 rejections，且优先保留近期有提交的活跃客户端记录
    const loadedState = emptyRoomState(emptyModel());
    loadedState.log = [
      {
        t: 'commit',
        seq: 1,
        client: 'active',
        n: 1,
        user: '活跃用户',
        changes: [{ id: 's1', obj: { kind: 'schema', id: 's1', name: 'public', comment: null } }],
      },
    ];
    loadedState.model.objects.s1 = { kind: 'schema', id: 's1', name: 'public', comment: null };
    loadedState.seq = 1;
    loadedState.processed = { stale: 3, active: 3 };
    loadedState.rejections = {
      stale: [
        { n: 1, code: 'conflict', message: 's1' },
        { n: 2, code: 'conflict', message: 's2' },
        { n: 3, code: 'conflict', message: 's3' },
      ],
      active: [
        { n: 2, code: 'conflict', message: 'a2' },
        { n: 3, code: 'conflict', message: 'a3' },
      ],
    };
    const loadedRoom = new Room(loadedState, memoryStore(), {
      rejectionsPerClientLimit: 2,
      rejectionsLimit: 3,
    });
    expect(loadedRoom.stats.rejections).toBe(3);
    const activeWelcome = await loadedRoom.handle('active', '活跃用户', {
      t: 'hello',
      client: 'active',
      lastSeq: 1,
    });
    expect(activeWelcome[0]?.msg).toEqual({
      t: 'welcome',
      lastProcessed: 3,
      rejected: [
        { n: 2, code: 'conflict', message: 'a2' },
        { n: 3, code: 'conflict', message: 'a3' },
      ],
    });
    const staleWelcome = await loadedRoom.handle('stale', '历史用户', {
      t: 'hello',
      client: 'stale',
      lastSeq: 1,
    });
    expect(staleWelcome[0]?.msg).toEqual({
      t: 'welcome',
      lastProcessed: 3,
      rejected: [{ n: 3, code: 'conflict', message: 's3' }],
    });
  });

  test('lastWriter 在对象删除、模型 replace、快照重载时清理，并在极端对象数下遵守上限', async () => {
    const room = new Room(emptyRoomState(emptyModel()), memoryStore());
    let n = 0;
    const send = (name: string, args: unknown, reads: [string, number | string | null][] = []) =>
      room.handle('c1', '张三', { t: 'op', op: { client: 'c1', n: ++n, name, args, reads } });

    await send('createSchema', { id: 's', name: 'public' });
    await send('createEnum', { id: 'e1', schema: 's', name: 'role_t', values: ['admin'] });
    await send('createTable', { id: 't1', schema: 's', name: 'users' });
    await send('addColumn', { table: 't1', column: { id: 'c1', name: 'id', type: 'integer' } });
    await send('addColumn', { table: 't1', column: { id: 'c2', name: 'age', type: 'integer' } });
    await send('addCheck', { id: 'chk1', table: 't1', expr: '(age > 0)' });
    await send('addIndex', { id: 'idx1', table: 't1', elements: [{ column: 'c1' }] });
    // 7 个存活对象：s, e1, t1, c1, c2, chk1, idx1
    expect(room.stats.lastWriter).toBe(7);

    // 逐类删除：约束、索引、列、枚举、表（含级联删列）都同步清理 lastWriter
    await send('dropKey', { id: 'chk1' });
    expect(room.stats.lastWriter).toBe(6);
    await send('dropKey', { id: 'idx1' });
    expect(room.stats.lastWriter).toBe(5);
    await send('dropColumn', { id: 'c2' });
    expect(room.stats.lastWriter).toBe(4);
    await send('dropEnum', { id: 'e1' });
    expect(room.stats.lastWriter).toBe(3);

    // 对已删除列发起冲突操作：回退文案“其他人”，不再残留旧 lastWriter
    const deletedConflict = await room.handle('c2', '李四', {
      t: 'op',
      op: {
        client: 'c2',
        n: 1,
        name: 'renameColumn',
        args: { id: 'c2', name: 'years' },
        reads: [['c2', 5]],
      },
    });
    expect(deletedConflict[0]?.msg).toEqual({
      t: 'reject',
      n: 1,
      code: 'conflict',
      message: '对象 已被 其他人 删除，请在最新数据上重新操作',
    });

    // dropTable 级联移除表与残留列 c1，仅剩 schema s
    await send('dropTable', { id: 't1' });
    expect(room.stats.lastWriter).toBe(1);

    // replace 加入不透明对象再清空：opaque 对象的 lastWriter 随 replace 正确增删
    const withOpaque = structuredClone(room.model);
    withOpaque.objects.op1 = {
      kind: 'opaque',
      id: 'op1',
      parent: 's',
      name: 'v_users',
      objType: 'view',
      ddl: ['CREATE VIEW public.v_users AS SELECT 1'],
      drop: 'DROP VIEW public.v_users',
      deps: [],
      order: 0,
      comment: null,
    };
    await room.replace('导入者', withOpaque, 'import');
    expect(room.stats.lastWriter).toBe(2);
    await room.replace('管理员', emptyModel(), 'reset');
    expect(room.stats.lastWriter).toBe(0);

    // 快照重载：log 里包含已删除对象的历史提交时，构造后的 lastWriter 只保留当前模型中存活的对象
    const reloadModel = emptyModel();
    reloadModel.objects.s = { kind: 'schema', id: 's', name: 'public', comment: null };
    const reloadState = emptyRoomState(reloadModel);
    reloadState.seq = 2;
    reloadState.versions = { s: 1 };
    reloadState.log = [
      {
        t: 'commit',
        seq: 1,
        client: 'c1',
        n: 1,
        user: '张三',
        changes: [
          { id: 's', obj: { kind: 'schema', id: 's', name: 'public', comment: null } },
          {
            id: 'gone',
            obj: {
              kind: 'table',
              id: 'gone',
              parent: 's',
              name: 'old',
              partitionBy: null,
              partitionOf: null,
              comment: null,
            },
          },
        ],
      },
      {
        t: 'commit',
        seq: 2,
        client: 'c1',
        n: 2,
        user: '李四',
        changes: [{ id: 'gone', obj: null }],
      },
    ];
    const reloaded = new Room(reloadState, memoryStore());
    expect(reloaded.stats.lastWriter).toBe(1);

    // lastWriterLimit 上限保护：创建超过上限的对象时淘汰最旧条目，保留最新写入者
    const capped = new Room(emptyRoomState(emptyModel()), memoryStore(), { lastWriterLimit: 3 });
    await capped.handle('c1', '张三', {
      t: 'op',
      op: { client: 'c1', n: 1, name: 'createSchema', args: { id: 's', name: 'public' }, reads: [] },
    });
    for (let i = 1; i <= 5; i++) {
      await capped.handle('c1', `用户${i}`, {
        t: 'op',
        op: {
          client: 'c1',
          n: i + 1,
          name: 'createTable',
          args: { id: `t${i}`, schema: 's', name: `t${i}` },
          reads: [['s', 1]],
        },
      });
    }
    expect(capped.stats.lastWriter).toBe(3);

    // 最旧的 t1 已被淘汰 → 冲突文案回退为“其他人”；最新的 t5 仍在缓存 → 保留“用户5”
    const oldConflict = await capped.handle('c2', '观察者', {
      t: 'op',
      op: { client: 'c2', n: 1, name: 'renameTable', args: { id: 't1', name: 't1_x' }, reads: [['t1', 0]] },
    });
    expect(oldConflict[0]?.msg).toEqual({
      t: 'reject',
      n: 1,
      code: 'conflict',
      message: '表 t1 已被 其他人 修改，请在最新数据上重新操作',
    });
    const newConflict = await capped.handle('c2', '观察者', {
      t: 'op',
      op: { client: 'c2', n: 2, name: 'renameTable', args: { id: 't5', name: 't5_x' }, reads: [['t5', 0]] },
    });
    expect(newConflict[0]?.msg).toEqual({
      t: 'reject',
      n: 2,
      code: 'conflict',
      message: '表 t5 已被 用户5 修改，请在最新数据上重新操作',
    });
  });

  test('SyncClient 在 lastSeq > 0（处于 log 窗口内）且拒绝记录被淘汰后重连：服务端下发 snapshot，pending 清空且视图收敛', async () => {
    const room = new Room(emptyRoomState(emptyModel()), memoryStore(), {
      logLimit: 2000,
      rejectionsPerClientLimit: 1,
      rejectionsLimit: 1,
    });
    const zhang = new SyncClient('zhang', emptyModel());
    const li = new SyncClient('li', emptyModel());

    const deliver = async (sender: SyncClient, user: string, msg: ToServer, dropToSender = false) => {
      const outs = await room.handle(sender.id, user, structuredClone(msg));
      for (const o of outs) {
        if (o.to === '*') {
          if (!dropToSender || sender !== zhang) zhang.receive(structuredClone(o.msg));
          if (!dropToSender || sender !== li) li.receive(structuredClone(o.msg));
        } else if (o.to === zhang.id && (!dropToSender || sender !== zhang)) {
          zhang.receive(structuredClone(o.msg));
        } else if (o.to === li.id && (!dropToSender || sender !== li)) {
          li.receive(structuredClone(o.msg));
        }
      }
      return outs;
    };

    // 同步辅助：顺序发送客户端发出的消息
    const wire = (c: SyncClient, user: string, opts: { dropReply?: boolean } = {}) => {
      const sent: ToServer[] = [];
      c.send = (m) => {
        sent.push(structuredClone(m));
      };
      return async () => {
        const allOuts: Awaited<ReturnType<typeof room.handle>> = [];
        while (sent.length) {
          const m = sent.shift()!;
          allOuts.push(...(await deliver(c, user, m, opts.dropReply)));
        }
        return allOuts;
      };
    };

    const flushZhang = wire(zhang, '张三');
    const flushLi = wire(li, '李四');

    // 建立初始模型并同步到两端（seq = 4，远小于 logLimit=2000）
    zhang.connect();
    li.connect();
    await flushZhang();
    await flushLi();

    zhang.mutate('createSchema', { id: 's', name: 'public' });
    zhang.mutate('createTable', { id: 't', schema: 's', name: 'users' });
    zhang.mutate('addColumn', { table: 't', column: { id: 'c1', name: 'email', type: 'text' } });
    zhang.mutate('addColumn', { table: 't', column: { id: 'c2', name: 'age', type: 'integer' } });
    await flushZhang();
    expect(li.seq).toBe(4);
    expect(same(li.view, room.model)).toBe(true);

    // 张三先将 email 改名为 mail（seq = 5），但先不推给李四（模拟网络延迟/断线窗口）
    const zhangMsg: ToServer[] = [];
    zhang.send = (m) => zhangMsg.push(structuredClone(m));
    zhang.mutate('renameColumn', { id: 'c1', name: 'mail' });
    for (const m of zhangMsg) {
      const outs = await room.handle('zhang', '张三', m);
      for (const o of outs) {
        if (o.to === '*' || o.to === 'zhang') zhang.receive(structuredClone(o.msg));
      }
    }
    expect(room.seq).toBe(5);
    expect(li.seq).toBe(4);

    // 李四基于旧视图修改 c1，op(n=1) 到达服务端被拒绝，但李四在收到 reject 之前就断线了
    const liOpMsgs: ToServer[] = [];
    li.send = (m) => liOpMsgs.push(structuredClone(m));
    li.mutate('renameColumn', { id: 'c1', name: 'e2' });
    expect(li.pending).toHaveLength(1);
    expect(li.viewVersions.c1).toBe('p:li:1');
    const rejOuts = await room.handle('li', '李四', liOpMsgs[0]!);
    expect(rejOuts[0]?.msg).toMatchObject({ t: 'reject', n: 1, code: 'conflict' });
    li.disconnect();

    // 另一客户端产生拒绝，把李四在 s.rejections 中的唯一拒绝记录淘汰（此时 seq=5 仍在 s.log 窗口内）
    const otherRej = await room.handle('other', '王五', {
      t: 'op',
      op: { client: 'other', n: 1, name: 'renameSchema', args: { id: 'missing', name: 'x' }, reads: [] },
    });
    expect(otherRej[0]?.msg).toMatchObject({ t: 'reject', n: 1, code: 'invalid' });
    expect(room.stats.rejections).toBe(1);
    expect(room.stats.evictedRejectionWatermarks).toBe(1);

    // 李四带 lastSeq=4 重连：服务端必须走 snapshot 分支兜底，不能仅发增量 log
    const flushLiReconnect = wire(li, '李四');
    li.connect();
    const reconnectOuts = await flushLiReconnect();
    expect(reconnectOuts.map((o) => o.msg.t)).toEqual(['welcome', 'snapshot']);
    expect(reconnectOuts[0]?.msg).toEqual({ t: 'welcome', lastProcessed: 1, rejected: [] });
    expect(li.pending).toEqual([]);
    expect(li.seq).toBe(5);
    expect(same(li.view, room.model)).toBe(true);
    expect(li.viewVersions.c1).toBe(5);

    // 李四继续编辑同一列 c1：不再携带残留的 p:li:1，能够正常提交生效
    li.mutate('renameColumn', { id: 'c1', name: 'contact_email' });
    const nextOuts = await flushLiReconnect();
    expect(nextOuts[0]?.msg).toMatchObject({ t: 'commit', client: 'li', n: 2 });
    expect(li.pending).toEqual([]);
    expect(same(li.view, room.model)).toBe(true);
    expect(all(room.model, 'column').find((c) => c.id === 'c1')?.name).toBe('contact_email');
  });

  test('evictedRejectionWatermark 有界淘汰防泄漏，溢出后兼容全量重放、缺口外部拒绝与 hello 快照兜底', async () => {
    const room = new Room(emptyRoomState(emptyModel()), memoryStore(), {
      logLimit: 2000,
      rejectionsPerClientLimit: 1,
      rejectionsLimit: 2,
      evictedRejectionWatermarkLimit: 3,
    });

    // 先写入一个 schema 提交，使 s.log 非空（seq = 1）
    await room.handle('seed', '初始化', {
      t: 'op',
      op: { client: 'seed', n: 1, name: 'createSchema', args: { id: 's', name: 'public' }, reads: [] },
    });

    // 8 个不同客户端各触发 1 次拒绝：仅留最新 2 个在 rejections，evictedRejectionWatermark 严格封顶为 3
    for (let i = 1; i <= 8; i++) {
      const cid = `tab-${i}`;
      const out = await room.handle(cid, `用户${i}`, {
        t: 'op',
        op: { client: cid, n: 1, name: 'renameSchema', args: { id: 'missing', name: `x${i}` }, reads: [] },
      });
      expect(out[0]?.msg).toMatchObject({ t: 'reject', n: 1, code: 'invalid' });
    }
    expect(room.stats.rejections).toBe(2);
    expect(room.stats.evictedRejectionWatermarks).toBe(3);

    // 溢出后全量重放被挤出 watermark 的老客户端 tab-1..tab-6：均幂等返回 false，绝不挤掉活跃的 tab-7 / tab-8
    for (let i = 1; i <= 6; i++) {
      expect(room.applyExternalRejection(`tab-${i}`, { n: 1, code: 'invalid', message: '旧拒绝' })).toBe(
        false,
      );
    }
    expect(room.stats.rejections).toBe(2);
    const tab7Hello = await room.handle('tab-7', '用户7', { t: 'hello', client: 'tab-7', lastSeq: 1 });
    expect(tab7Hello[0]?.msg).toMatchObject({
      t: 'welcome',
      lastProcessed: 1,
      rejected: [expect.objectContaining({ n: 1 })],
    });
    const tab8Hello = await room.handle('tab-8', '用户8', { t: 'hello', client: 'tab-8', lastSeq: 1 });
    expect(tab8Hello[0]?.msg).toMatchObject({
      t: 'welcome',
      lastProcessed: 1,
      rejected: [expect.objectContaining({ n: 1 })],
    });

    // watermark 溢出后，被挤出 watermark 的老客户端 tab-1 带 lastSeq=1（在 log 窗口内）重连必须安全走 snapshot
    const tab1Hello = await room.handle('tab-1', '用户1', { t: 'hello', client: 'tab-1', lastSeq: 1 });
    expect(tab1Hello.map((o) => o.msg.t)).toEqual(['welcome', 'snapshot']);
    expect(tab1Hello[0]?.msg).toEqual({ t: 'welcome', lastProcessed: 1, rejected: [] });

    // 无历史处理的只读客户端（lastProcessed=0）带 lastSeq=1 重连仍可走增量 log，不被误伤
    const viewerHello = await room.handle('viewer-1', '只读', {
      t: 'hello',
      client: 'viewer-1',
      lastSeq: 1,
    });
    expect(viewerHello.map((o) => o.msg.t)).toEqual(['welcome']);

    // watermark 溢出后，外部提交出现跳号（prevProcessed=0, commit.n=2）产生的合法缺口 n=1 仍可被 applyExternalRejection 合入
    expect(
      room.applyExternalCommit({
        t: 'commit',
        seq: room.seq + 1,
        client: 'gap-client',
        n: 2,
        user: '远端用户',
        changes: [
          {
            id: 't_gap',
            obj: {
              kind: 'table',
              id: 't_gap',
              parent: 's',
              name: 'gap_tbl',
              partitionBy: null,
              partitionOf: null,
              comment: null,
            },
          },
        ],
      }),
    ).toBe(true);
    expect(room.applyExternalRejection('gap-client', { n: 1, code: 'conflict', message: '缺口拒绝' })).toBe(
      true,
    );
    // 缺口消费后再次重放同一拒绝返回 false
    expect(room.applyExternalRejection('gap-client', { n: 1, code: 'conflict', message: '缺口拒绝' })).toBe(
      false,
    );
    // 老客户端 tab-1 产生真正更新的外部拒绝 n=2 仍可正常合入
    expect(room.applyExternalRejection('tab-1', { n: 2, code: 'conflict', message: '新拒绝' })).toBe(true);
    expect(room.stats.evictedRejectionWatermarks).toBeLessThanOrEqual(3);

    // 构造器重载包含大量不同客户端拒绝记录时，evictedRejectionWatermark 同样受上限约束
    const hugeState = emptyRoomState(emptyModel());
    for (let i = 1; i <= 10; i++) {
      hugeState.processed[`old-${i}`] = 1;
      hugeState.rejections[`old-${i}`] = [{ n: 1, code: 'conflict', message: `r${i}` }];
    }
    const reloaded = new Room(hugeState, memoryStore(), {
      rejectionsPerClientLimit: 1,
      rejectionsLimit: 2,
      evictedRejectionWatermarkLimit: 3,
    });
    expect(reloaded.stats.rejections).toBe(2);
    expect(reloaded.stats.evictedRejectionWatermarks).toBe(3);
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
