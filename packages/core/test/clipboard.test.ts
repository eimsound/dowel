import { describe, expect, test, vi } from 'vitest';

import {
  addCheck,
  addColumn,
  addForeignKey,
  addIndex,
  addPrimaryKey,
  addUnique,
  CLIPBOARD_FORMAT,
  CLIPBOARD_VERSION,
  ClipboardError,
  clonePlain,
  copyItems,
  copyTables,
  createEnum,
  createPartition,
  createSchema,
  createSequence,
  createTable,
  EditError,
  emptyModel,
  MAX_CLIPBOARD_BYTES,
  MAX_PASTE_OPS,
  type Opaque,
  parseClipboard,
  PasteError,
  planPaste,
  renameManyInExpr,
  runMutator,
  serializeClipboard,
  setComment,
  setPartitionBy,
  setSequenceOwnedBy,
  validate,
} from '../src/index.ts';

const SRC = { projectId: 'proj-1', projectName: '主项目', origin: 'canvas' as const, seq: null };

describe('剪贴板序列化、校验与表达式改写', () => {
  test('serializeClipboard / parseClipboard 往返及含 PG 非数组枚举列支持', () => {
    const m = emptyModel('pg');
    const pub = createSchema(m, 'public');
    const mood = createEnum(m, pub, 'mood', ['happy', 'sad']);
    const t = createTable(m, pub, 'users');
    addColumn(m, t, { name: 'id', type: 'bigint', notNull: true });
    addColumn(m, t, { name: 'feeling', type: '', typeRef: mood, notNull: true });
    expect(validate(m)).toEqual([]);

    const payload = copyTables(m, [t], {
      source: SRC,
      layout: { [t]: { x: 10, y: 20 }, ignored: { x: 0, y: 0 } },
      sections: { [t]: 'sec-1', ignored: 'sec-2' },
      now: () => new Date('2026-11-24T12:00:00.000Z'),
    });

    expect(payload.copiedAt).toBe('2026-11-24T12:00:00.000Z');
    expect(payload.layout).toEqual({ [t]: { x: 10, y: 20 } });
    expect(payload.sections).toEqual({ [t]: 'sec-1' });

    const text = serializeClipboard(payload);
    const parsed = parseClipboard(text);
    expect(parsed).toEqual(payload);
  });

  test('parseClipboard 识别非 Dowel 文本、不支持版本与篡改载荷', () => {
    expect(parseClipboard('not json')).toBeNull();
    expect(parseClipboard('123')).toBeNull();
    expect(parseClipboard('null')).toBeNull();
    expect(parseClipboard('[]')).toBeNull();
    expect(parseClipboard(JSON.stringify({ hello: 'world' }))).toBeNull();
    expect(parseClipboard(JSON.stringify({ format: 'other/format', v: 1 }))).toBeNull();

    expect(() => parseClipboard(JSON.stringify({ format: CLIPBOARD_FORMAT, v: 99 }))).toThrowError(
      ClipboardError,
    );
    try {
      parseClipboard(JSON.stringify({ format: CLIPBOARD_FORMAT, v: 2 }));
    } catch (e) {
      expect((e as ClipboardError).code).toBe('unsupported_version');
    }

    const m = emptyModel('pg');
    const s = createSchema(m, 'public');
    const t = createTable(m, s, 't');
    const c = addColumn(m, t, { name: 'a', type: 'integer' });
    const base = copyTables(m, [t], { source: SRC });

    // key 与 obj.id 不一致
    const badKey = clonePlain(base);
    badKey.fragment['wrong_key'] = clonePlain(badKey.fragment[t]!);
    expect(() => parseClipboard(JSON.stringify(badKey))).toThrowError(ClipboardError);
    try {
      parseClipboard(JSON.stringify(badKey));
    } catch (e) {
      expect((e as ClipboardError).code).toBe('invalid_payload');
    }

    // tables 引用不存在的表
    const missingTbl = clonePlain(base);
    delete missingTbl.fragment[t];
    expect(() => parseClipboard(JSON.stringify(missingTbl))).toThrowError(ClipboardError);

    // tables 引用了非表对象
    const wrongKindTbl = clonePlain(base);
    wrongKindTbl.tables = [c];
    expect(() => parseClipboard(JSON.stringify(wrongKindTbl))).toThrowError(ClipboardError);

    // 列既无 type 又无 typeRef
    const emptyColType = clonePlain(base);
    const colObj = emptyColType.fragment[c]!;
    if (colObj.kind === 'column') colObj.type = '';
    expect(() => parseClipboard(JSON.stringify(emptyColType))).toThrowError(ClipboardError);

    // external 引用缺失或非表
    const badExt = clonePlain(base);
    badExt.external = ['nonexistent'];
    expect(() => parseClipboard(JSON.stringify(badExt))).toThrowError(ClipboardError);

    // items 载荷缺失 table 或 items 引用类型错误
    const itemPayload = copyItems(m, t, [c], { source: SRC });
    const badItemsTable = clonePlain(itemPayload);
    badItemsTable.table = s;
    expect(() => parseClipboard(JSON.stringify(badItemsTable))).toThrowError(ClipboardError);

    const badItemsRef = clonePlain(itemPayload);
    badItemsRef.items = [t];
    expect(() => parseClipboard(JSON.stringify(badItemsRef))).toThrowError(ClipboardError);

    // tables / items / external 含重复 ID 必须被 parseClipboard 拒绝
    const dupTables = clonePlain(base);
    dupTables.tables = [t, t];
    try {
      parseClipboard(JSON.stringify(dupTables));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ClipboardError);
      expect((e as ClipboardError).code).toBe('invalid_payload');
    }

    const dupItems = clonePlain(itemPayload);
    dupItems.items = [c, c];
    try {
      parseClipboard(JSON.stringify(dupItems));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ClipboardError);
      expect((e as ClipboardError).code).toBe('invalid_payload');
    }
  });

  test('parseClipboard 在调用 JSON.parse 之前拦截超过 MAX_CLIPBOARD_BYTES 的输入', () => {
    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      // 超长 ASCII（即使不是合法 JSON 也必须在 JSON.parse 前直接抛 too_large）
      const hugeAscii = 'x'.repeat(MAX_CLIPBOARD_BYTES + 1);
      let err1: ClipboardError | null = null;
      try {
        parseClipboard(hugeAscii);
      } catch (e) {
        err1 = e as ClipboardError;
      }
      expect(err1).toBeInstanceOf(ClipboardError);
      expect(err1?.code).toBe('too_large');
      expect(parseSpy).not.toHaveBeenCalled();

      // 字符数 <= MAX_CLIPBOARD_BYTES，但 UTF-8 字节数 > MAX_CLIPBOARD_BYTES 的多字节文本
      const hugeUtf8 = `{"format":"${CLIPBOARD_FORMAT}","v":1,"pad":"${'甲'.repeat(Math.ceil(MAX_CLIPBOARD_BYTES / 3))}"}`;
      expect(hugeUtf8.length).toBeLessThan(MAX_CLIPBOARD_BYTES);
      expect(new TextEncoder().encode(hugeUtf8).byteLength).toBeGreaterThan(MAX_CLIPBOARD_BYTES);
      let err2: ClipboardError | null = null;
      try {
        parseClipboard(hugeUtf8);
      } catch (e) {
        err2 = e as ClipboardError;
      }
      expect(err2).toBeInstanceOf(ClipboardError);
      expect(err2?.code).toBe('too_large');
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  test('篡改载荷中索引/约束引用缺失列或跨表列：parseClipboard 拒绝且直接调用 planPaste 防御性跳过并保证 validate 通过', () => {
    const m = emptyModel('pg');
    const pub = createSchema(m, 'public');
    const tA = createTable(m, pub, 'a');
    const aId = addColumn(m, tA, { name: 'id', type: 'bigint', notNull: true });
    const aCode = addColumn(m, tA, { name: 'code', type: 'text', notNull: true });
    const aExtra = addColumn(m, tA, { name: 'extra', type: 'text' });
    const pkId = addPrimaryKey(m, tA, [aId]);
    const uqId = addUnique(m, tA, [aCode]);
    const ixId = addIndex(m, tA, [{ column: aCode }], { include: [aExtra] });

    const tB = createTable(m, pub, 'b');
    const bId = addColumn(m, tB, { name: 'id', type: 'bigint', notNull: true });
    const bAId = addColumn(m, tB, { name: 'a_id', type: 'bigint' });
    const fkId = addForeignKey(m, tB, [bAId], tA, [aId]);
    expect(validate(m)).toEqual([]);

    const base = copyTables(m, [tA, tB], { source: SRC });

    const assertInvalidAndSafePlan = (
      mutator: (p: ReturnType<typeof copyTables>) => void,
      expectedSkipKind: string,
    ) => {
      const crafted = clonePlain(base);
      mutator(crafted);

      let parseErr: ClipboardError | null = null;
      try {
        parseClipboard(JSON.stringify(crafted));
      } catch (e) {
        parseErr = e as ClipboardError;
      }
      expect(parseErr).toBeInstanceOf(ClipboardError);
      expect(parseErr?.code).toBe('invalid_payload');

      // 即使绕过 parseClipboard 直接调用 planPaste，也不能产生非法模型
      const target = emptyModel('pg');
      createSchema(target, 'public');
      const plan = planPaste(target, crafted);
      expect(plan.report.skipped.some((s) => s.kind === expectedSkipKind)).toBe(true);
      runMutator(target, 'paste', { ops: plan.ops });
      expect(validate(target)).toEqual([]);
    };

    // 1. 索引 element 引用缺失列
    assertInvalidAndSafePlan((p) => {
      const ix = p.fragment[ixId];
      if (ix?.kind === 'index') ix.elements[0]!.column = 'missing_col';
    }, 'index');

    // 2. 索引 include 引用缺失列
    assertInvalidAndSafePlan((p) => {
      const ix = p.fragment[ixId];
      if (ix?.kind === 'index') ix.include = ['missing_inc_col'];
    }, 'index');

    // 3. 索引 element 跨表引用另一张表的列
    assertInvalidAndSafePlan((p) => {
      const ix = p.fragment[ixId];
      if (ix?.kind === 'index') ix.elements[0]!.column = bId;
    }, 'index');

    // 4. 主键引用缺失列
    assertInvalidAndSafePlan((p) => {
      const pk = p.fragment[pkId];
      if (pk?.kind === 'primaryKey') pk.columns = ['missing_pk_col'];
    }, 'primaryKey');

    // 5. UNIQUE 引用缺失列
    assertInvalidAndSafePlan((p) => {
      const uq = p.fragment[uqId];
      if (uq?.kind === 'unique') uq.columns = ['missing_uq_col'];
    }, 'unique');

    // 6. FK 本地列缺失
    assertInvalidAndSafePlan((p) => {
      const fk = p.fragment[fkId];
      if (fk?.kind === 'foreignKey') fk.columns = ['missing_fk_local'];
    }, 'foreignKey');

    // 7. FK 内部 refColumns 缺失
    assertInvalidAndSafePlan((p) => {
      const fk = p.fragment[fkId];
      if (fk?.kind === 'foreignKey') fk.refColumns = ['missing_fk_ref'];
    }, 'foreignKey');
  });

  test('直接调用 planPaste 时对重复 tables / items ID 去重，不产生重复副本', () => {
    const m = emptyModel('pg');
    const pub = createSchema(m, 'public');
    const t = createTable(m, pub, 'users');
    const c = addColumn(m, t, { name: 'id', type: 'bigint', notNull: true });

    const dupTablesPayload = clonePlain(copyTables(m, [t], { source: SRC }));
    dupTablesPayload.tables = [t, t];
    const target1 = emptyModel('pg');
    createSchema(target1, 'public');
    const plan1 = planPaste(target1, dupTablesPayload);
    expect(plan1.newTables).toHaveLength(1);
    runMutator(target1, 'paste', { ops: plan1.ops });
    expect(validate(target1)).toEqual([]);
    expect(Object.values(target1.objects).filter((o) => o.kind === 'table')).toHaveLength(1);

    const dupItemsPayload = clonePlain(copyItems(m, t, [c], { source: SRC }));
    dupItemsPayload.items = [c, c];
    const target2 = emptyModel('pg');
    const pub2 = createSchema(target2, 'public');
    const t2 = createTable(target2, pub2, 'dest');
    const plan2 = planPaste(target2, dupItemsPayload, { targetTable: t2 });
    expect(plan2.newItems).toHaveLength(1);
    runMutator(target2, 'paste', { ops: plan2.ops });
    expect(validate(target2)).toEqual([]);
    expect(Object.values(target2.objects).filter((o) => o.kind === 'column')).toHaveLength(1);
  });

  test('serializeClipboard 超过 MAX_CLIPBOARD_BYTES 抛 too_large', () => {
    const m = emptyModel('pg');
    const s = createSchema(m, 'public');
    const t = createTable(m, s, 'big');
    addColumn(m, t, { name: 'id', type: 'integer' });
    setComment(m, t, '甲'.repeat(Math.ceil(MAX_CLIPBOARD_BYTES / 3)));
    const payload = copyTables(m, [t], { source: SRC });
    let err: ClipboardError | null = null;
    try {
      serializeClipboard(payload);
    } catch (e) {
      err = e as ClipboardError;
    }
    expect(err).toBeInstanceOf(ClipboardError);
    expect(err?.code).toBe('too_large');
  });

  test('renameManyInExpr 在四方言下实现单趟非级联替换', () => {
    const map = new Map([
      ['a', 'a_copy'],
      ['a_copy', 'a_copy2'],
      ['MixedCase', 'MixedCase_copy'],
    ]);

    expect(
      renameManyInExpr(
        'pg',
        `a > 0 AND a_copy < 10 AND lower(a) <> 'a'::text AND "MixedCase" = 'a_copy' AND t.a IS NOT NULL`,
        map,
      ),
    ).toBe(
      `a_copy > 0 AND a_copy2 < 10 AND lower(a_copy) <> 'a'::text AND "MixedCase_copy" = 'a_copy' AND t.a_copy IS NOT NULL`,
    );

    expect(
      renameManyInExpr('sqlite', `[a] + A_COPY > 0 AND CAST(a AS TEXT) <> 'a' AND [MixedCase] = 1`, map),
    ).toBe(`a_copy + a_copy2 > 0 AND CAST(a_copy AS TEXT) <> 'a' AND "MixedCase_copy" = 1`);

    expect(
      renameManyInExpr(
        'mysql',
        "`a` > 0 AND `a_copy` > 0 AND CHAR_LENGTH(a) > 0 AND CAST(mixedcase AS CHAR) <> 'a'",
        map,
      ),
    ).toBe(
      "`a_copy` > 0 AND `a_copy2` > 0 AND CHAR_LENGTH(`a_copy`) > 0 AND CAST(`MixedCase_copy` AS CHAR) <> 'a'",
    );

    expect(
      renameManyInExpr(
        'mssql',
        `[a] > 0 AND a_copy < 10 AND CONVERT(varchar(10), mixedcase) <> N'a' AND dbo.[a] IS NULL`,
        map,
      ),
    ).toBe(
      `[a_copy] > 0 AND [a_copy2] < 10 AND CONVERT(varchar(10), [MixedCase_copy]) <> N'a' AND dbo.[a] IS NULL`,
    );
  });
});

describe('setSequenceOwnedBy 与 paste mutator 防护', () => {
  test('setSequenceOwnedBy 校验序列、归属列与同 schema 约束', () => {
    const m = emptyModel('pg');
    const pub = createSchema(m, 'public');
    const app = createSchema(m, 'app');
    const s1 = createSequence(m, pub, 'seq_a');
    const tPub = createTable(m, pub, 't_pub');
    const cPub = addColumn(m, tPub, { name: 'id', type: 'bigint', notNull: true });
    const tApp = createTable(m, app, 't_app');
    const cApp = addColumn(m, tApp, { name: 'id', type: 'bigint', notNull: true });

    setSequenceOwnedBy(m, s1, cPub);
    expect(m.objects[s1]!.kind === 'sequence' && m.objects[s1]!.ownedBy).toBe(cPub);

    setSequenceOwnedBy(m, s1, null);
    expect(m.objects[s1]!.kind === 'sequence' && m.objects[s1]!.ownedBy).toBeNull();

    expect(() => setSequenceOwnedBy(m, s1, cApp)).toThrow(EditError);
    expect(() => setSequenceOwnedBy(m, s1, 'missing')).toThrow(EditError);

    const sq = emptyModel('sqlite');
    createSchema(sq, 'main');
    expect(() => setSequenceOwnedBy(sq, 'x', null)).toThrow(EditError);
  });

  test('runMutator(paste) 拒绝修改既有对象或使用非新鲜 ID', () => {
    const m = emptyModel('pg');
    const pub = createSchema(m, 'public');
    const t = createTable(m, pub, 'existing');
    const c = addColumn(m, t, { name: 'id', type: 'bigint', notNull: true });
    const seq = createSequence(m, pub, 'existing_seq');
    const ck = addCheck(m, t, 'id > 0');

    // 禁止篡改既有表注释
    expect(() =>
      runMutator(m, 'paste', { ops: [{ name: 'setComment', args: { id: t, comment: 'hacked' } }] }),
    ).toThrow(EditError);

    // 禁止篡改既有约束名
    expect(() =>
      runMutator(m, 'paste', { ops: [{ name: 'renameKey', args: { id: ck, name: 'hacked' } }] }),
    ).toThrow(EditError);

    // 禁止篡改既有序列归属到既有列或新建序列归属到既有列
    expect(() =>
      runMutator(m, 'paste', { ops: [{ name: 'setSequenceOwnedBy', args: { id: seq, column: c } }] }),
    ).toThrow(EditError);

    const freshSeq = '01950000-0000-7000-8000-000000000001';
    expect(() =>
      runMutator(m, 'paste', {
        ops: [
          { name: 'createSequence', args: { id: freshSeq, schema: pub, name: 'new_seq' } },
          { name: 'setSequenceOwnedBy', args: { id: freshSeq, column: c } },
        ],
      }),
    ).toThrow(EditError);

    // 禁止复用模型中已有 ID
    expect(() =>
      runMutator(m, 'paste', {
        ops: [{ name: 'createTable', args: { id: t, schema: pub, name: 'dup' } }],
      }),
    ).toThrow(EditError);
  });
});

describe('copyTables / copyItems 提取规则与 planPaste 错误边界', () => {
  test('copyTables 归并分区子表、忽略非表 ID、统计不透明对象并深拷贝', () => {
    const m = emptyModel('pg');
    const pub = createSchema(m, 'public');
    const t = createTable(m, pub, 'events');
    const cid = addColumn(m, t, { name: 'id', type: 'bigint', notNull: true });
    addPrimaryKey(m, t, [cid]);
    setPartitionBy(m, t, {
      strategy: 'range',
      keys: [{ column: cid, expr: null, opclass: null, collation: null }],
    });
    const p1 = createPartition(m, t, 'events_p1', 'FOR VALUES FROM (0) TO (100)');

    // 挂载两个与 events 相关的不透明对象（一个以表为 parent，一个通过 deps 依赖列）+ 一个无关视图
    const op1: Opaque = {
      id: 'op_trig',
      kind: 'opaque',
      objType: 'trigger',
      parent: t,
      name: 'events_trig',
      ddl: ['CREATE TRIGGER events_trig ...'],
      drop: 'DROP TRIGGER events_trig',
      deps: [t],
      order: 1,
      comment: null,
    };
    const op2: Opaque = {
      id: 'op_view',
      kind: 'opaque',
      objType: 'view',
      parent: pub,
      name: 'events_view',
      ddl: ['CREATE VIEW events_view AS SELECT id FROM events'],
      drop: 'DROP VIEW events_view',
      deps: [cid],
      order: 2,
      comment: null,
    };
    const op3: Opaque = {
      id: 'op_unrelated',
      kind: 'opaque',
      objType: 'function',
      parent: pub,
      name: 'helper()',
      ddl: ['CREATE FUNCTION helper() ...'],
      drop: 'DROP FUNCTION helper()',
      deps: [],
      order: 3,
      comment: null,
    };
    m.objects[op1.id] = op1;
    m.objects[op2.id] = op2;
    m.objects[op3.id] = op3;

    expect(() => copyTables(m, [cid, 'missing'], { source: SRC })).toThrowError(ClipboardError);

    // 传入子分区 + 非表 + 根表，应归并去重为单一根表
    const payload = copyTables(m, [p1, cid, t], { source: SRC });
    expect(payload.tables).toEqual([t]);
    expect(payload.skippedOpaque).toBe(2);
    expect(payload.fragment[op1.id]).toBeUndefined();
    expect(payload.fragment[op2.id]).toBeUndefined();
    expect(payload.fragment[p1]).toBeDefined();

    // 修改原模型不影响载荷（深拷贝）
    (m.objects[t] as { name: string }).name = 'mutated';
    expect(payload.fragment[t]!.name).toBe('events');

    // planPaste 产出 opaqueSkipped 提示，且不修改 target
    const targetSnapshot = JSON.stringify(m);
    const plan = planPaste(m, payload);
    expect(JSON.stringify(m)).toBe(targetSnapshot);
    expect(plan.report.notes).toContainEqual({ code: 'opaqueSkipped', count: 2 });
  });

  test('copyItems 按稳定顺序排序并处理分区子表、错误抛错', () => {
    const m = emptyModel('pg');
    const pub = createSchema(m, 'public');
    const ref = createTable(m, pub, 'ref');
    const rid = addColumn(m, ref, { name: 'id', type: 'bigint', notNull: true });
    addPrimaryKey(m, ref, [rid]);

    const t = createTable(m, pub, 'src');
    const c1 = addColumn(m, t, { name: 'c1', type: 'bigint', notNull: true });
    const c2 = addColumn(m, t, { name: 'c2', type: 'text' });
    const fk = addForeignKey(m, t, [c1], ref, [rid]);
    const ix = addIndex(m, t, [{ column: c2 }]);
    const ck = addCheck(m, t, 'c1 > 0');
    const uq = addUnique(m, t, [c2]);
    const pk = addPrimaryKey(m, t, [c1]);

    expect(() => copyItems(m, pub, [c1], { source: SRC })).toThrowError(ClipboardError);
    expect(() => copyItems(m, t, ['missing'], { source: SRC })).toThrowError(ClipboardError);

    // 刻意打乱输入顺序，验证输出顺序：columns (pos) -> PK -> unique -> check -> index -> FK
    const payload = copyItems(m, t, [fk, ix, c2, ck, uq, c1, pk], { source: SRC });
    expect(payload.items).toEqual([c1, c2, pk, uq, ck, ix, fk]);
    expect(payload.external).toEqual([ref]);
  });

  test('planPaste 前置错误校验（方言不匹配、目标缺失/非法/分区子表、空载荷、ops 上限）', () => {
    const pg = emptyModel('pg');
    const pub = createSchema(pg, 'public');
    const t = createTable(pg, pub, 'events');
    const c = addColumn(pg, t, { name: 'id', type: 'bigint', notNull: true });
    setPartitionBy(pg, t, {
      strategy: 'range',
      keys: [{ column: c, expr: null, opclass: null, collation: null }],
    });
    const p1 = createPartition(pg, t, 'events_p1', 'FOR VALUES FROM (0) TO (10)');
    const ck = addCheck(pg, t, 'id > 0');

    const sq = emptyModel('sqlite');
    createSchema(sq, 'main');

    const tblPayload = copyTables(pg, [t], { source: SRC });
    expect(() => planPaste(sq, tblPayload)).toThrowError(PasteError);
    try {
      planPaste(sq, tblPayload);
    } catch (e) {
      expect((e as PasteError).code).toBe('dialect_mismatch');
    }

    const emptyTablesPayload = { ...tblPayload, tables: [] };
    try {
      planPaste(pg, emptyTablesPayload);
      expect.unreachable();
    } catch (e) {
      expect((e as PasteError).code).toBe('nothing_to_paste');
    }

    const itemPayload = copyItems(pg, t, [ck], { source: SRC });
    for (const [opts, expectedCode] of [
      [{}, 'no_target'],
      [{ targetTable: pub }, 'target_not_table'],
      [{ targetTable: p1 }, 'target_is_partition'],
    ] as const) {
      try {
        planPaste(pg, itemPayload, opts);
        expect.unreachable();
      } catch (e) {
        expect((e as PasteError).code).toBe(expectedCode);
      }
    }

    // 所有 item 都被跳过时，items 模式不抛错而是返回 ops: []
    const tOther = createTable(pg, pub, 'other');
    addColumn(pg, tOther, { name: 'other_col', type: 'text' });
    const emptyPlan = planPaste(pg, itemPayload, { targetTable: tOther });
    expect(emptyPlan.ops).toEqual([]);
    expect(emptyPlan.report.skipped).toHaveLength(1);
    expect(emptyPlan.report.skipped[0]!.reason).toBe('invalidExpr');

    // MAX_PASTE_OPS 上限保护
    const huge = emptyModel('pg');
    const hPub = createSchema(huge, 'public');
    const hugeTableIds: string[] = [];
    // 直接写入对象构造大模型（逐个 addColumn 每次都会全表重算推导名，构造本身就要几十秒）
    for (let i = 0; i < 400; i++) {
      const tid = `huge_t_${i}`;
      huge.objects[tid] = {
        id: tid,
        kind: 'table',
        parent: hPub,
        name: `tbl_${i}`,
        partitionBy: null,
        partitionOf: null,
        comment: null,
      };
      for (let j = 0; j < 50; j++) {
        const cid = `huge_c_${i}_${j}`;
        huge.objects[cid] = {
          id: cid,
          kind: 'column',
          parent: tid,
          name: `c_${j}`,
          pos: `a${String(j).padStart(3, '0')}`,
          type: 'integer',
          typeRef: null,
          notNull: false,
          notNullName: null,
          notNullNameMode: 'derived',
          default: null,
          identity: null,
          generated: null,
          collation: null,
          comment: null,
        };
      }
      hugeTableIds.push(tid);
    }
    expect(validate(huge)).toEqual([]);
    const hugePayload = copyTables(huge, hugeTableIds, { source: SRC });
    let limitErr: PasteError | null = null;
    try {
      planPaste(huge, hugePayload);
    } catch (e) {
      limitErr = e as PasteError;
    }
    expect(limitErr).toBeInstanceOf(PasteError);
    expect(limitErr?.code).toBe('too_many_ops');
    expect(CLIPBOARD_VERSION).toBe(1);
    expect(MAX_PASTE_OPS).toBe(20_000);
  });
});
