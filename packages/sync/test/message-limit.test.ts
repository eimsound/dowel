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

  test('dropPending：丢掉全部待确认修改并回到已确认状态', () => {
    const m = emptyModel('pg');
    createSchema(m, 'public');
    const schema = Object.keys(m.objects)[0]!;
    const { c } = onlineClient(m);
    c.mutate('createTable', { id: 't1', schema, name: 'a' });
    c.mutate('createTable', { id: 't2', schema, name: 'b' });
    expect(c.dropPending()).toBe(2);
    expect(c.pending).toEqual([]);
    expect(c.view.objects.t1).toBeUndefined();
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
