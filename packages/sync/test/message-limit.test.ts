// 单条同步消息上限（Issue #150）：SyncClient 发送前自查，超限在本地拒绝、不进待确认队列；
// 以及合法的大粘贴（200 张表 × 12 列、接近粘贴上限的 680 张表）远低于上限。
import {
  copyTables,
  createSchema,
  type Dialect,
  emptyModel,
  getDialect,
  MAX_CLIPBOARD_BYTES,
  type Model,
  planPaste,
  serializeClipboard,
} from '@dowel/core';
import { describe, expect, test } from 'vitest';

import { MAX_SYNC_MESSAGE_BYTES, SyncClient, SyncMessageTooLargeError, type ToServer } from '../src/index.ts';

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

/** 已上线、收到 welcome 的客户端；send 记下发出的每一帧 */
const onlineClient = (model: Model, maxMessageBytes?: number) => {
  const c = new SyncClient('tab-limit', model, { maxMessageBytes });
  const frames: string[] = [];
  c.send = (m: ToServer) => frames.push(JSON.stringify(m));
  c.connect();
  c.receive({ t: 'welcome', lastProcessed: 0, rejected: [] });
  frames.length = 0;
  return { c, frames };
};

describe('SyncClient 发送前自查单条消息大小', () => {
  test('超限：抛 SyncMessageTooLargeError，不发送、不进队列、不占用序号；恰好等于上限照常发送', () => {
    const m = emptyModel('pg');
    createSchema(m, 'public');
    const schema = Object.keys(m.objects)[0]!;
    const probe = onlineClient(m);
    probe.c.mutate('createTable', { id: 't1', schema, name: 'a' });
    const size = bytes(probe.frames[0]!);

    // 上限比这一帧少 1 字节：拒绝
    const { c, frames } = onlineClient(m, size - 1);
    const err = (() => {
      try {
        c.mutate('createTable', { id: 't1', schema, name: 'a' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SyncMessageTooLargeError);
    expect((err as SyncMessageTooLargeError).bytes).toBe(size);
    expect(frames).toEqual([]);
    expect(c.pending).toEqual([]);
    expect(c.view).toBe(c.confirmed);

    // 恰好等于上限：放行，而且序号从 1 开始（被拒的那次没有占用序号）
    const ok = onlineClient(m, size);
    expect(ok.c.mutate('createTable', { id: 't1', schema, name: 'a' })).toBe(1);
    expect(ok.frames).toHaveLength(1);
    expect(bytes(ok.frames[0]!)).toBe(size);
  });

  test('含中文消息按 UTF-8 字节而非字符数自查：恰好等于字节上限放行，超出 1 字节拒绝', () => {
    const m = emptyModel('pg');
    const schema = createSchema(m, 'public');
    const probe = onlineClient(m);
    probe.c.mutate('createTable', { id: 't1', schema, name: 'orders' });
    probe.c.receive({
      t: 'commit',
      seq: 1,
      client: probe.c.id,
      n: 1,
      user: 'u',
      changes: [{ id: 't1', obj: probe.c.view.objects.t1! }],
    });
    probe.frames.length = 0;

    const cjkComment = '中'.repeat(200);
    probe.c.mutate('setComment', { id: 't1', comment: cjkComment });
    const frame = probe.frames[0]!;
    const byteLen = bytes(frame);
    // 字符数远低于字节上限（至少少 400），确保按字符计数的变异会被这里直接抓到
    expect(frame.length).toBeLessThan(byteLen - 1);

    const { c, frames } = onlineClient(probe.c.confirmed, byteLen - 1);
    expect(() => c.mutate('setComment', { id: 't1', comment: cjkComment })).toThrow(SyncMessageTooLargeError);
    expect(frames).toEqual([]);
    expect(c.pending).toEqual([]);
    expect(c.view).toBe(c.confirmed);
    // 被拒后不占用序号，较小的修改仍从 n=1 开始
    expect(c.mutate('setComment', { id: 't1', comment: 'ok' })).toBe(1);

    const ok = onlineClient(probe.c.confirmed, byteLen);
    expect(ok.c.mutate('setComment', { id: 't1', comment: cjkComment })).toBe(1);
    expect(ok.frames).toHaveLength(1);
    expect(bytes(ok.frames[0]!)).toBe(byteLen);
    expect(schema).toBeDefined();
  });

  test('dropPending：丢掉全部待确认修改、换新客户端标识并重置序号，重连强制拉取快照', () => {
    const m = emptyModel('pg');
    createSchema(m, 'public');
    const schema = Object.keys(m.objects)[0]!;
    const { c, frames } = onlineClient(m);
    const oldId = c.id;
    c.mutate('createTable', { id: 't1', schema, name: 'a' });
    c.receive({
      t: 'commit',
      seq: 1,
      client: oldId,
      n: 1,
      user: 'u',
      changes: [{ id: 't1', obj: c.view.objects.t1! }],
    });
    c.mutate('createTable', { id: 't2', schema, name: 'b' });
    c.mutate('createTable', { id: 't3', schema, name: 'c' });

    expect(c.dropPending()).toBe(2);
    expect(c.pending).toEqual([]);
    expect(c.view.objects.t2).toBeUndefined();
    expect(c.view.objects.t3).toBeUndefined();
    expect(c.id).not.toBe(oldId);

    frames.length = 0;
    c.disconnect();
    c.connect();
    expect(JSON.parse(frames[0]!)).toEqual({ t: 'hello', client: c.id, lastSeq: 0 });
    // 收到 welcome 时若 snapshot 尚未到达，ready 仍保持 false，等 snapshot 到后再开放发送
    c.receive({ t: 'welcome', lastProcessed: 0, rejected: [] });
    expect(c.ready).toBe(false);
    c.receive({
      t: 'snapshot',
      seq: 1,
      model: c.confirmed,
      versions: c.versions,
      lastProcessed: 0,
    });
    expect(c.ready).toBe(true);
    frames.length = 0;
    expect(c.mutate('createTable', { id: 't4', schema, name: 'd' })).toBe(1);
    expect(JSON.parse(frames[0]!)).toMatchObject({ t: 'op', op: { client: c.id, n: 1 } });
  });

  test('dropPending 后恢复窗口内排队的修改在快照到达后补发并确认，之后普通重连不再强制拉快照', () => {
    const m = emptyModel('pg');
    createSchema(m, 'public');
    const schema = Object.keys(m.objects)[0]!;
    const { c, frames } = onlineClient(m);
    const oldId = c.id;

    // 先确认 1 条修改，使当前 seq = 1（非 0，供末尾普通重连验证 lastSeq !== 0）
    c.mutate('createTable', { id: 't1', schema, name: 'a' });
    c.receive({
      t: 'commit',
      seq: 1,
      client: oldId,
      n: 1,
      user: 'u',
      changes: [{ id: 't1', obj: c.view.objects.t1! }],
    });
    c.mutate('createTable', { id: 't_dropped', schema, name: 'dropped' });
    expect(c.pending).toHaveLength(1);

    // 1009 断开恢复：dropPending 换新标识并重置序号
    expect(c.dropPending()).toBe(1);
    const newId = c.id;
    expect(newId).not.toBe(oldId);
    c.disconnect();
    frames.length = 0;

    // 1) 断开期间用户发起修改：仅进入 pending，不发送
    expect(c.mutate('createTable', { id: 't2', schema, name: 'b' })).toBe(1);
    expect(frames).toEqual([]);
    expect(c.pending.map((p) => [p.client, p.n])).toEqual([[newId, 1]]);

    // 2) 重连发送 hello（lastSeq: 0），快照到达前用户再发起第 2 条修改
    c.connect();
    expect(frames.map((f): unknown => JSON.parse(f))).toEqual([{ t: 'hello', client: newId, lastSeq: 0 }]);
    frames.length = 0;

    expect(c.mutate('createTable', { id: 't3', schema, name: 'c' })).toBe(2);
    c.receive({ t: 'welcome', lastProcessed: 0, rejected: [] });
    expect(c.ready).toBe(false);
    expect(frames).toEqual([]);
    expect(c.pending.map((p) => [p.client, p.n])).toEqual([
      [newId, 1],
      [newId, 2],
    ]);

    // 3) 快照到达：按序补发恢复窗口内排队的两条 op（n = 1, 2，带新 client id）并置 ready = true
    c.receive({
      t: 'snapshot',
      seq: 1,
      model: structuredClone(c.confirmed),
      versions: { ...c.versions },
      lastProcessed: 0,
    });
    expect(c.ready).toBe(true);
    expect(frames).toHaveLength(2);
    expect(frames.map((f): unknown => JSON.parse(f))).toMatchObject([
      { t: 'op', op: { client: newId, n: 1, name: 'createTable', args: { id: 't2', schema, name: 'b' } } },
      { t: 'op', op: { client: newId, n: 2, name: 'createTable', args: { id: 't3', schema, name: 'c' } } },
    ]);

    // 4) 服务端确认两条 op 后 pending 清零、confirmed 同步更新
    c.receive({
      t: 'commit',
      seq: 2,
      client: newId,
      n: 1,
      user: 'u',
      changes: [{ id: 't2', obj: c.view.objects.t2! }],
    });
    c.receive({
      t: 'commit',
      seq: 3,
      client: newId,
      n: 2,
      user: 'u',
      changes: [{ id: 't3', obj: c.view.objects.t3! }],
    });
    expect(c.pending).toEqual([]);
    expect(c.seq).toBe(3);
    expect(c.confirmed.objects.t2).toBeDefined();
    expect(c.confirmed.objects.t3).toBeDefined();

    // 5) 再次普通重连：forceSnapshot 已清除，hello 应携带当前 seq（3）而非 0
    frames.length = 0;
    c.disconnect();
    c.connect();
    expect(frames.map((f): unknown => JSON.parse(f))).toEqual([
      { t: 'hello', client: newId, lastSeq: c.seq },
    ]);
  });
});

describe('合法的大粘贴远低于单条消息上限', () => {
  const SRC = { projectId: 'p', projectName: 'P', origin: 'canvas' as const, seq: null };
  // 与 clipboard-sync.test.ts 的大模型同构：直接写对象，避免逐个 addColumn 重算推导名
  const buildLarge = (
    dialect: Dialect,
    prefix: string,
    tables: number,
    cols: number,
    comment: string | null,
  ) => {
    const intType = dialect === 'pg' ? 'integer' : 'int';
    const m = emptyModel(dialect);
    const sch = createSchema(m, getDialect(dialect).capabilities.defaultSchema);
    const ids: string[] = [];
    let prev: { t: string; pk: string } | null = null;
    for (let i = 0; i < tables; i++) {
      const t = `${prefix}_t_${i}`;
      ids.push(t);
      m.objects[t] = {
        id: t,
        kind: 'table',
        parent: sch,
        name: `${prefix}_${i}`,
        partitionBy: null,
        partitionOf: null,
        comment,
      };
      const cs: string[] = [];
      for (let j = 0; j < cols; j++) {
        const c = `${prefix}_c_${i}_${j}`;
        cs.push(c);
        m.objects[c] = {
          id: c,
          kind: 'column',
          parent: t,
          name: j === 0 ? 'id' : j === 1 ? 'ref_id' : `col_${j}`,
          pos: `a${String(j).padStart(3, '0')}`,
          type: intType,
          typeRef: null,
          notNull: j < 2,
          notNullName: null,
          notNullNameMode: 'derived',
          default: null,
          identity: null,
          generated: null,
          collation: null,
          comment,
        };
      }
      const base = { parent: t, name: '', nameMode: 'derived' as const, comment: null };
      m.objects[`${t}_pk`] = { ...base, id: `${t}_pk`, kind: 'primaryKey', columns: [cs[0]!] };
      m.objects[`${t}_ix`] = {
        ...base,
        id: `${t}_ix`,
        kind: 'index',
        unique: false,
        method: 'btree',
        elements: [
          { column: cs[1]!, expr: null, desc: false, nullsFirst: null, opclass: null, collation: null },
        ],
        include: [],
        where: null,
        nullsNotDistinct: false,
      };
      m.objects[`${t}_fk`] = {
        ...base,
        id: `${t}_fk`,
        kind: 'foreignKey',
        columns: [cs[1]!],
        refTable: prev?.t ?? t,
        refColumns: [prev?.pk ?? cs[0]!],
        onDelete: 'noAction',
        onUpdate: 'noAction',
        match: 'simple',
        deferrable: false,
        initiallyDeferred: false,
      };
      prev = { t, pk: cs[0]! };
    }
    for (const t of ids) getDialect(dialect).refreshDerivedNames(m, t);
    return { m, ids };
  };
  const CJK = '这是一段用于说明字段用途的中文注释内容，大约四十个汉字长度的示例文本。';

  const pasteFrame = (target: Model, tables: number, comment: string | null) => {
    const src = buildLarge(target.dialect, 'copied', tables, 12, comment);
    const payload = copyTables(src.m, src.ids, { source: SRC });
    const clip = bytes(serializeClipboard(payload));
    const plan = planPaste(target, payload);
    // 不跑 execute（大粘贴的客户端执行要数秒，性能另有守卫）：按 SyncClient 发出的帧结构序列化，reads 留空。
    // 实测带上 reads 后整帧比这里多约 11%（200 张表：1304 KiB → 1447 KiB；680 张表整帧约 4.9 MiB）
    const frame = JSON.stringify({
      t: 'op',
      op: { client: 'tab-limit', n: 1, name: 'paste', args: { ops: plan.ops }, reads: [] },
    } satisfies ToServer);
    return { clip, frame: bytes(frame) };
  };

  // 帧大小只取决于粘贴的内容，与目标模型大小无关：目标用只有默认 schema 的空模型
  test('粘贴 200 张表 × 12 列（带中文注释）约 1.4 MiB；接近剪贴板 / 子操作上限的 680 张表仍不到上限的 1/3', () => {
    const target = buildLarge('pg', 'existing', 0, 0, null).m;
    const p200 = pasteFrame(target, 200, CJK);
    expect(p200.frame).toBeGreaterThan(1024 * 1024);
    expect(p200.frame).toBeLessThan(MAX_SYNC_MESSAGE_BYTES / 8);

    const p680 = pasteFrame(target, 680, CJK);
    expect(p680.clip).toBeLessThanOrEqual(MAX_CLIPBOARD_BYTES);
    expect(p680.clip).toBeGreaterThan(MAX_CLIPBOARD_BYTES * 0.9);
    expect(p680.frame).toBeLessThan(MAX_SYNC_MESSAGE_BYTES / 3);
  }, 60_000);
});
