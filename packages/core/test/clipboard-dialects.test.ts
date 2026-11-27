import { describe, expect, test } from 'vitest';

import {
  addCheck,
  addColumn,
  addForeignKey,
  addIndex,
  addPrimaryKey,
  addUnique,
  all,
  childrenOf,
  clonePlain,
  columnsOf,
  copyItems,
  copyTables,
  createEnum,
  createPartition,
  createSchema,
  createSequence,
  createTable,
  type Dialect,
  emptyModel,
  type ForeignKey,
  getDialect,
  type Model,
  parseClipboard,
  planPaste,
  renameKey,
  renameTable,
  runMutator,
  serializeClipboard,
  setColumnExt,
  setComment,
  setPartitionBy,
  setSequenceOwnedBy,
  setTableExt,
  validate,
} from '../src/index.ts';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SRC = { projectId: 'p1', projectName: '测试项目', origin: 'canvas' as const, seq: null };
const DIALECTS: readonly Dialect[] = ['pg', 'sqlite', 'mysql', 'mssql'];

const setupBase = (d: Dialect): { m: Model; schema: string } => {
  const m = emptyModel(d);
  const schema = createSchema(m, getDialect(d).capabilities.defaultSchema);
  return { m, schema };
};

const colTypeFor = (d: Dialect, kind: 'int' | 'bigint' | 'text'): string => {
  if (d === 'sqlite') return kind === 'text' ? 'TEXT' : 'INTEGER';
  if (d === 'mysql') return kind === 'int' ? 'int' : kind === 'bigint' ? 'bigint' : 'varchar(100)';
  if (d === 'mssql') return kind === 'int' ? 'int' : kind === 'bigint' ? 'bigint' : 'nvarchar(100)';
  return kind === 'int' ? 'integer' : kind === 'bigint' ? 'bigint' : 'text';
};

describe('四方言通用复制粘贴矩阵', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: 同模型复制粘贴单表两次（_copy / _copy2 及防 _copy_copy）与全字段保留`, () => {
      const { m, schema } = setupBase(dialect);
      const t = createTable(m, schema, 'orders');
      setComment(m, t, '订单表');
      const idCol = addColumn(m, t, { name: 'id', type: colTypeFor(dialect, 'bigint'), notNull: true });
      const codeCol = addColumn(m, t, {
        name: 'code',
        type: colTypeFor(dialect, 'text'),
        notNull: true,
        default: { expr: "'N/A'" },
      });
      const totalCol = addColumn(m, t, { name: 'total', type: colTypeFor(dialect, 'int'), notNull: true });
      setComment(m, codeCol, '订单编号');

      const pk = addPrimaryKey(m, t, [idCol]);
      if (dialect !== 'mysql') renameKey(m, pk, 'pk_orders_explicit');
      const uq = addUnique(m, t, [codeCol]);
      renameKey(m, uq, 'uq_orders_code_explicit');
      addCheck(m, t, 'total >= 0');
      addIndex(m, t, [{ column: totalCol, desc: true }]);
      expect(validate(m)).toEqual([]);

      const sourceIds = new Set(Object.keys(m.objects));
      const payload = parseClipboard(serializeClipboard(copyTables(m, [t], { source: SRC })))!;

      // 第一次粘贴：orders -> orders_copy
      const mSnap1 = JSON.stringify(m);
      const plan1 = planPaste(m, payload);
      expect(JSON.stringify(m)).toBe(mSnap1); // planPaste 不修改 target
      expect(plan1.newTables).toHaveLength(1);
      const newT1 = plan1.newTables[0]!;
      expect(newT1).toMatch(UUID_V7_RE);
      expect(sourceIds.has(newT1)).toBe(false);

      runMutator(m, 'paste', { ops: plan1.ops });
      expect(validate(m)).toEqual([]);

      const tbl1 = m.objects[newT1]!;
      expect(tbl1.kind === 'table' && tbl1.name).toBe('orders_copy');
      expect(tbl1.comment).toBe('订单表');
      const cols1 = columnsOf(m, newT1);
      expect(cols1.map((c) => c.name)).toEqual(['id', 'code', 'total']);
      expect(cols1[1]!.comment).toBe('订单编号');
      expect(cols1[1]!.default).toEqual({ expr: "'N/A'" });
      for (const obj of [
        tbl1,
        ...cols1,
        ...childrenOf(m, newT1, 'primaryKey'),
        ...childrenOf(m, newT1, 'unique'),
        ...childrenOf(m, newT1, 'check'),
        ...childrenOf(m, newT1, 'index'),
      ]) {
        expect(obj.id).toMatch(UUID_V7_RE);
        expect(sourceIds.has(obj.id)).toBe(false);
      }

      // 显式名重名才加后缀：PG / MSSQL 的唯一约束名在 schema 级命名空间里与原表冲突；
      // SQLite（约束名按表）与 MySQL（唯一约束是表内索引）在新表上不冲突，保留原名
      expect(childrenOf(m, newT1, 'unique')[0]!.name).toBe(
        dialect === 'sqlite' || dialect === 'mysql'
          ? 'uq_orders_code_explicit'
          : 'uq_orders_code_explicit_copy',
      );
      if (dialect === 'mysql') {
        expect(childrenOf(m, newT1, 'primaryKey')[0]!.name).toBe('PRIMARY');
        expect(
          plan1.ops.some(
            (op) =>
              op.name === 'renameKey' &&
              (op.args as { id: string }).id === childrenOf(m, newT1, 'primaryKey')[0]!.id,
          ),
        ).toBe(false);
      } else {
        expect(childrenOf(m, newT1, 'primaryKey')[0]!.name).toBe(
          dialect === 'sqlite' ? 'pk_orders_explicit' : 'pk_orders_explicit_copy',
        );
      }

      // 第二次粘贴同一个 orders 载荷：orders_copy2
      const plan2 = planPaste(m, payload);
      runMutator(m, 'paste', { ops: plan2.ops });
      expect(validate(m)).toEqual([]);
      const newT2 = plan2.newTables[0]!;
      expect(m.objects[newT2]!.name).toBe('orders_copy2');

      // 复制 orders_copy 并再粘贴：剥离 _copy 后得到 orders_copy3，绝不产生 orders_copy_copy
      const copyPayload = copyTables(m, [newT1], { source: SRC });
      const plan3 = planPaste(m, copyPayload);
      runMutator(m, 'paste', { ops: plan3.ops });
      expect(validate(m)).toEqual([]);
      expect(m.objects[plan3.newTables[0]!]!.name).toBe('orders_copy3');
    });

    test(`${dialect}: 复制多张带内部外键与自引用外键的表，自动重连到新表`, () => {
      const { m, schema } = setupBase(dialect);
      const customers = createTable(m, schema, 'customers');
      const cid = addColumn(m, customers, { name: 'id', type: colTypeFor(dialect, 'bigint'), notNull: true });
      const parentId = addColumn(m, customers, { name: 'parent_id', type: colTypeFor(dialect, 'bigint') });
      addPrimaryKey(m, customers, [cid]);
      addForeignKey(m, customers, [parentId], customers, [cid]);

      const invoices = createTable(m, schema, 'invoices');
      const iid = addColumn(m, invoices, { name: 'id', type: colTypeFor(dialect, 'bigint'), notNull: true });
      const invCid = addColumn(m, invoices, {
        name: 'customer_id',
        type: colTypeFor(dialect, 'bigint'),
        notNull: true,
      });
      addPrimaryKey(m, invoices, [iid]);
      addForeignKey(m, invoices, [invCid], customers, [cid]);
      expect(validate(m)).toEqual([]);

      const payload = parseClipboard(
        serializeClipboard(copyTables(m, [customers, invoices], { source: SRC })),
      )!;
      const plan = planPaste(m, payload);
      runMutator(m, 'paste', { ops: plan.ops });
      expect(validate(m)).toEqual([]);

      const newCustomers = plan.tableMap[customers]!;
      const newInvoices = plan.tableMap[invoices]!;
      const selfFk = childrenOf(m, newCustomers, 'foreignKey')[0]!;
      expect(selfFk.refTable).toBe(newCustomers);
      expect(selfFk.refColumns).toEqual([childrenOf(m, newCustomers, 'primaryKey')[0]!.columns[0]!]);

      const crossFk = childrenOf(m, newInvoices, 'foreignKey')[0]!;
      expect(crossFk.refTable).toBe(newCustomers);
    });

    test(`${dialect}: 外部外键重连与各种跳过原因（missingRefTable / missingRefColumns / refTypeMismatch / refNotUnique）`, () => {
      const { m, schema } = setupBase(dialect);
      const orgs = createTable(m, schema, 'orgs');
      const orgId = addColumn(m, orgs, { name: 'id', type: colTypeFor(dialect, 'bigint'), notNull: true });
      addPrimaryKey(m, orgs, [orgId]);

      const users = createTable(m, schema, 'users');
      const uid = addColumn(m, users, { name: 'id', type: colTypeFor(dialect, 'bigint'), notNull: true });
      const uOrg = addColumn(m, users, {
        name: 'org_id',
        type: colTypeFor(dialect, 'bigint'),
        notNull: true,
      });
      addPrimaryKey(m, users, [uid]);
      addForeignKey(m, users, [uOrg], orgs, [orgId]);

      // 只复制 users（orgs 为外部表）
      const payload = parseClipboard(serializeClipboard(copyTables(m, [users], { source: SRC })))!;
      expect(payload.external).toEqual([orgs]);

      // 1. 同模型粘贴：重连到原 orgs
      const pSame = planPaste(m, payload);
      const mSame = clonePlain(m);
      runMutator(mSame, 'paste', { ops: pSame.ops });
      expect(validate(mSame)).toEqual([]);
      expect(childrenOf(mSame, pSame.newTables[0]!, 'foreignKey')[0]!.refTable).toBe(orgs);

      // 2. 跨模型且无 orgs：missingRefTable
      const mMissingTbl = setupBase(dialect);
      const pMissingTbl = planPaste(mMissingTbl.m, payload);
      runMutator(mMissingTbl.m, 'paste', { ops: pMissingTbl.ops });
      expect(validate(mMissingTbl.m)).toEqual([]);
      expect(childrenOf(mMissingTbl.m, pMissingTbl.newTables[0]!, 'foreignKey')).toHaveLength(0);
      expect(pMissingTbl.report.skipped[0]!.reason).toBe('missingRefTable');

      // 3. 跨模型 orgs 缺 id 列：missingRefColumns
      const mMissingCol = setupBase(dialect);
      const org2 = createTable(mMissingCol.m, mMissingCol.schema, 'orgs');
      addColumn(mMissingCol.m, org2, { name: 'other', type: colTypeFor(dialect, 'text') });
      const pMissingCol = planPaste(mMissingCol.m, payload);
      runMutator(mMissingCol.m, 'paste', { ops: pMissingCol.ops });
      expect(validate(mMissingCol.m)).toEqual([]);
      expect(pMissingCol.report.skipped[0]!.reason).toBe('missingRefColumns');

      // 4. 跨模型 orgs.id 类型不一致：refTypeMismatch
      const mBadType = setupBase(dialect);
      const org3 = createTable(mBadType.m, mBadType.schema, 'orgs');
      const org3Id = addColumn(mBadType.m, org3, {
        name: 'id',
        type: colTypeFor(dialect, 'text'),
        notNull: true,
      });
      addPrimaryKey(mBadType.m, org3, [org3Id]);
      const pBadType = planPaste(mBadType.m, payload);
      runMutator(mBadType.m, 'paste', { ops: pBadType.ops });
      expect(validate(mBadType.m)).toEqual([]);
      expect(pBadType.report.skipped[0]!.reason).toBe('refTypeMismatch');

      // 5. 跨模型 orgs.id 无主键 / 唯一约束 / 唯一索引支撑：refNotUnique（MySQL 仅普通前导索引可支撑）
      const mNoUq = setupBase(dialect);
      const org4 = createTable(mNoUq.m, mNoUq.schema, 'orgs');
      const org4Id = addColumn(mNoUq.m, org4, {
        name: 'id',
        type: colTypeFor(dialect, 'bigint'),
        notNull: true,
      });
      const pNoUq = planPaste(mNoUq.m, payload);
      runMutator(mNoUq.m, 'paste', { ops: pNoUq.ops });
      expect(validate(mNoUq.m)).toEqual([]);
      expect(pNoUq.report.skipped[0]!.reason).toBe('refNotUnique');

      // 加上非唯一索引后：MySQL 允许前导列普通索引支撑，其他方言仍 refNotUnique
      addIndex(mNoUq.m, org4, [{ column: org4Id }]);
      const pWithPlainIdx = planPaste(mNoUq.m, payload);
      runMutator(mNoUq.m, 'paste', { ops: pWithPlainIdx.ops });
      expect(validate(mNoUq.m)).toEqual([]);
      if (dialect === 'mysql') {
        expect(childrenOf(mNoUq.m, pWithPlainIdx.newTables[0]!, 'foreignKey')).toHaveLength(1);
      } else {
        expect(pWithPlainIdx.report.skipped[0]!.reason).toBe('refNotUnique');
      }
    });

    test(`${dialect}: items 表内粘贴（列名后缀、按名映射、表达式改写、去重、跳过与自引用外键）`, () => {
      const { m, schema } = setupBase(dialect);
      const extTbl = createTable(m, schema, 'categories');
      const catId = addColumn(m, extTbl, { name: 'id', type: colTypeFor(dialect, 'bigint'), notNull: true });
      addPrimaryKey(m, extTbl, [catId]);

      const srcTbl = createTable(m, schema, 'src_items');
      const sId = addColumn(m, srcTbl, { name: 'id', type: colTypeFor(dialect, 'bigint'), notNull: true });
      const sAmt = addColumn(m, srcTbl, { name: 'amount', type: colTypeFor(dialect, 'int'), notNull: true });
      const sCat = addColumn(m, srcTbl, { name: 'cat_id', type: colTypeFor(dialect, 'bigint') });
      const sMiss = addColumn(m, srcTbl, { name: 'only_in_src', type: colTypeFor(dialect, 'int') });
      const sPk = addPrimaryKey(m, srcTbl, [sId]);
      const sUqAmt = addUnique(m, srcTbl, [sAmt]);
      const sUqMiss = addUnique(m, srcTbl, [sMiss]);
      const sCkAmt = addCheck(m, srcTbl, 'amount >= 0');
      const sCkMiss = addCheck(m, srcTbl, 'only_in_src > 0');
      const sIxAmt = addIndex(m, srcTbl, [{ column: sAmt }]);
      const sFkExt = addForeignKey(m, srcTbl, [sCat], extTbl, [catId]);
      const sFkSelf = addForeignKey(m, srcTbl, [sCat], srcTbl, [sId]);

      // 目标表已有 id、pk，以及与 amount 碰撞的列；无 only_in_src，无 cat_id
      const tgtTbl = createTable(m, schema, 'tgt_items');
      const tId = addColumn(m, tgtTbl, { name: 'id', type: colTypeFor(dialect, 'bigint'), notNull: true });
      addColumn(m, tgtTbl, { name: 'amount', type: colTypeFor(dialect, 'int'), notNull: true });
      addPrimaryKey(m, tgtTbl, [tId]);

      const payload = parseClipboard(
        serializeClipboard(
          copyItems(m, srcTbl, [sAmt, sCat, sPk, sUqAmt, sUqMiss, sCkAmt, sCkMiss, sIxAmt, sFkExt, sFkSelf], {
            source: SRC,
          }),
        ),
      )!;
      const plan1 = planPaste(m, payload, { targetTable: tgtTbl });
      runMutator(m, 'paste', { ops: plan1.ops });
      expect(validate(m)).toEqual([]);

      // amount 冲突改名为 amount_copy；check 里的 amount 也随之单趟改写为 amount_copy
      const tgtCols = columnsOf(m, tgtTbl);
      expect(tgtCols.map((c) => c.name)).toContain('amount_copy');
      expect(
        plan1.report.renamed.some(
          (r) => r.kind === 'column' && r.from === 'amount' && r.to === 'amount_copy',
        ),
      ).toBe(true);
      const pastedCheck = childrenOf(m, tgtTbl, 'check')[0]!;
      expect(getDialect(dialect).exprReferences(pastedCheck.expr, 'amount_copy')).toBe(true);
      expect(getDialect(dialect).exprReferences(pastedCheck.expr, 'amount')).toBe(false);

      // 自引用 FK 应重连到目标表 tgtTbl 自身且映射到目标表列 id
      const fks = childrenOf(m, tgtTbl, 'foreignKey') as ForeignKey[];
      expect(fks.some((f) => f.refTable === extTbl)).toBe(true);
      expect(fks.some((f) => f.refTable === tgtTbl && f.refColumns[0] === tId)).toBe(true);

      // 跳过原因校验
      expect(plan1.report.skipped).toContainEqual(
        expect.objectContaining({ kind: 'primaryKey', reason: 'targetHasPrimaryKey' }),
      );
      expect(plan1.report.skipped).toContainEqual(
        expect.objectContaining({ kind: 'unique', reason: 'missingColumns' }),
      );
      expect(plan1.report.skipped).toContainEqual(
        expect.objectContaining({ kind: 'check', reason: 'invalidExpr' }),
      );

      // 只复制 check / unique / index / FK（不复制列）再次粘贴到 tgtTbl（若以原名 amount 匹配目标已有列，触发 duplicate）
      const noColPayload = copyItems(m, srcTbl, [sUqAmt, sCkAmt, sIxAmt, sFkExt], { source: SRC });
      const planDup1 = planPaste(m, noColPayload, { targetTable: tgtTbl });
      runMutator(m, 'paste', { ops: planDup1.ops });
      expect(validate(m)).toEqual([]);
      // 紧接着再贴一次相同约束/索引，全部命中 duplicate
      const planDup2 = planPaste(m, noColPayload, { targetTable: tgtTbl });
      expect(planDup2.ops).toEqual([]);
      expect(planDup2.report.skipped.map((s) => s.reason)).toEqual([
        'duplicate',
        'duplicate',
        'duplicate',
        'duplicate',
      ]);
    });
  }
});

describe('各方言专属特性测试', () => {
  test('PG: 枚举复用（完全一致/真超集）与非超集新建后缀、限定名改写', () => {
    const src = emptyModel('pg');
    const srcPub = createSchema(src, 'public');
    const srcMood = createEnum(src, srcPub, 'mood', ['a', 'b']);
    const srcTbl = createTable(src, srcPub, 'posts');
    addColumn(src, srcTbl, {
      name: 'mood',
      type: '',
      typeRef: srcMood,
      notNull: true,
      default: { expr: "'a'::public.mood" },
    });
    const payload = copyTables(src, [srcTbl], { source: SRC });

    // 1. 目标完全一致枚举 -> reusedType valuesDiffer: false
    const tgtExact = clonePlain(src);
    const planExact = planPaste(tgtExact, payload);
    runMutator(tgtExact, 'paste', { ops: planExact.ops });
    expect(validate(tgtExact)).toEqual([]);
    expect(planExact.report.notes).toContainEqual({
      code: 'reusedType',
      kind: 'enum',
      name: 'mood',
      valuesDiffer: false,
    });

    // 2. 目标超集枚举 -> reusedType valuesDiffer: true
    const tgtSuper = emptyModel('pg');
    const supPub = createSchema(tgtSuper, 'public');
    createEnum(tgtSuper, supPub, 'mood', ['a', 'b', 'c']);
    const planSup = planPaste(tgtSuper, payload);
    runMutator(tgtSuper, 'paste', { ops: planSup.ops });
    expect(validate(tgtSuper)).toEqual([]);
    expect(planSup.report.notes).toContainEqual({
      code: 'reusedType',
      kind: 'enum',
      name: 'mood',
      valuesDiffer: true,
    });

    // 3. 目标非超集枚举 -> 新建 mood_copy 并改写 default.expr 的 ::public.mood
    const tgtDisjoint = emptyModel('pg');
    const disPub = createSchema(tgtDisjoint, 'public');
    createEnum(tgtDisjoint, disPub, 'mood', ['a', 'z']);
    const planDis = planPaste(tgtDisjoint, payload);
    runMutator(tgtDisjoint, 'paste', { ops: planDis.ops });
    expect(validate(tgtDisjoint)).toEqual([]);
    expect(planDis.report.notes).toContainEqual({
      code: 'createdType',
      kind: 'enum',
      name: 'mood_copy',
    });
    expect(planDis.report.renamed).toContainEqual({
      kind: 'enum',
      table: null,
      from: 'mood',
      to: 'mood_copy',
    });
    const newCol = columnsOf(tgtDisjoint, planDis.newTables[0]!)[0]!;
    expect(newCol.default).toEqual({ expr: "'a'::public.mood_copy" });
  });

  test('PG: 归属序列总是新建并 setSequenceOwnedBy，非归属序列按 schema+name 复用或新建，identity 参数保留', () => {
    const src = emptyModel('pg');
    const pub = createSchema(src, 'public');
    const ownedSeq = createSequence(src, pub, 'users_id_seq', {
      type: 'integer',
      increment: '2',
      start: '10',
      cycle: true,
    });
    const sharedSeq = createSequence(src, pub, 'global_seq');
    const t = createTable(src, pub, 'users');
    const idCol = addColumn(src, t, {
      name: 'id',
      type: 'integer',
      notNull: true,
      default: { nextval: ownedSeq },
    });
    setSequenceOwnedBy(src, ownedSeq, idCol);
    addColumn(src, t, {
      name: 'ticket',
      type: 'bigint',
      notNull: true,
      default: { nextval: sharedSeq },
    });
    addColumn(src, t, {
      name: 'ident_col',
      type: 'integer',
      notNull: true,
      identity: { always: true, options: { increment: '5', start: '100', cache: '10', cycle: true } },
    });
    addPrimaryKey(src, t, [idCol]);
    expect(validate(src)).toEqual([]);

    const payload = copyTables(src, [t], { source: SRC });
    // 同模型粘贴：ownedSeq 绝不复用且必须新建+后缀并绑定归属到新列；sharedSeq 复用！
    const plan = planPaste(src, payload);
    runMutator(src, 'paste', { ops: plan.ops });
    expect(validate(src)).toEqual([]);

    const newT = plan.newTables[0]!;
    const newCols = columnsOf(src, newT);
    const newIdCol = newCols.find((c) => c.name === 'id')!;
    const newTicketCol = newCols.find((c) => c.name === 'ticket')!;
    const newIdentCol = newCols.find((c) => c.name === 'ident_col')!;

    expect(newIdCol.default && 'nextval' in newIdCol.default).toBe(true);
    const newOwnedSeqId = (newIdCol.default as { nextval: string }).nextval;
    expect(newOwnedSeqId).not.toBe(ownedSeq);
    const newOwnedSeq = src.objects[newOwnedSeqId]!;
    expect(newOwnedSeq.kind === 'sequence' && newOwnedSeq.ownedBy).toBe(newIdCol.id);
    expect(newOwnedSeq.kind === 'sequence' && newOwnedSeq.name).toBe('users_id_seq_copy');
    expect(newOwnedSeq.kind === 'sequence' && newOwnedSeq.options.cycle).toBe(true);

    // 非归属序列复用原 sharedSeq
    expect(newTicketCol.default).toEqual({ nextval: sharedSeq });
    expect(plan.report.notes).toContainEqual({
      code: 'reusedType',
      kind: 'sequence',
      name: 'global_seq',
      valuesDiffer: false,
    });

    // identity options 保留
    expect(newIdentCol.identity?.always).toBe(true);
    expect(newIdentCol.identity?.options.increment).toBe('5');
    expect(newIdentCol.identity?.options.start).toBe('100');
    expect(newIdentCol.identity?.options.cache).toBe('10');
    expect(newIdentCol.identity?.options.cycle).toBe(true);
  });

  test('PG: 分区表与多级子分区复制（跳过子分区局部索引并记入 partitionObjectsSkipped）', () => {
    const m = emptyModel('pg');
    const pub = createSchema(m, 'public');
    const events = createTable(m, pub, 'events');
    const eid = addColumn(m, events, { name: 'id', type: 'bigint', notNull: true });
    const reg = addColumn(m, events, { name: 'region', type: 'text', notNull: true });
    addPrimaryKey(m, events, [eid, reg]);
    setPartitionBy(m, events, {
      strategy: 'range',
      keys: [{ column: eid, expr: null, opclass: null, collation: null }],
    });
    const p1 = createPartition(m, events, 'events_p1', 'FOR VALUES FROM (0) TO (1000)');
    const p2 = createPartition(m, events, 'events_p2', 'FOR VALUES FROM (1000) TO (2000)');
    setPartitionBy(m, p2, {
      strategy: 'list',
      keys: [{ column: reg, expr: null, opclass: null, collation: null }],
    });
    const p2Us = createPartition(m, p2, 'events_p2_us', "FOR VALUES IN ('us')");
    addIndex(m, p1, [{ column: reg }]);
    expect(validate(m)).toEqual([]);

    const payload = copyTables(m, [events], { source: SRC });
    const plan = planPaste(m, payload);
    runMutator(m, 'paste', { ops: plan.ops });
    expect(validate(m)).toEqual([]);

    const newRoot = plan.tableMap[events]!;
    expect(m.objects[newRoot]!.name).toBe('events_copy');
    expect(m.objects[plan.tableMap[p1]!]!.name).toBe('events_p1_copy');
    expect(m.objects[plan.tableMap[p2]!]!.name).toBe('events_p2_copy');
    expect(m.objects[plan.tableMap[p2Us]!]!.name).toBe('events_p2_us_copy');
    expect(plan.report.notes).toContainEqual({ code: 'partitionObjectsSkipped', count: 1 });
  });

  test('PG: 跨项目缺失 schema 回退到 public，以及 63 字节多字节标识符截断', () => {
    const src = emptyModel('pg');
    const sales = createSchema(src, 'sales');
    const longAscii = 'a'.repeat(63);
    const longCjk = '表'.repeat(21); // 21 * 3 = 63 UTF-8 bytes
    const t1 = createTable(src, sales, longAscii);
    addColumn(src, t1, { name: 'id', type: 'integer', notNull: true });
    const t2 = createTable(src, sales, longCjk);
    addColumn(src, t2, { name: 'id', type: 'integer', notNull: true });

    const tgt = emptyModel('pg');
    const tgtPub = createSchema(tgt, 'public');
    // 在目标 public 先占掉原长名，强迫触发 63 字节下加 _copy 后缀裁剪
    const occupy1 = createTable(tgt, tgtPub, longAscii);
    addColumn(tgt, occupy1, { name: 'id', type: 'integer' });
    const occupy2 = createTable(tgt, tgtPub, longCjk);
    addColumn(tgt, occupy2, { name: 'id', type: 'integer' });

    const payload = copyTables(src, [t1, t2], { source: SRC });
    const plan = planPaste(tgt, payload);
    runMutator(tgt, 'paste', { ops: plan.ops });
    expect(validate(tgt)).toEqual([]);

    const enc = new TextEncoder();
    const pasted1 = tgt.objects[plan.newTables[0]!]!;
    const pasted2 = tgt.objects[plan.newTables[1]!]!;
    expect(pasted1.kind === 'table' && pasted1.parent).toBe(tgtPub);
    expect(pasted2.kind === 'table' && pasted2.parent).toBe(tgtPub);
    expect(enc.encode(pasted1.name).length).toBeLessThanOrEqual(63);
    expect(enc.encode(pasted2.name).length).toBeLessThanOrEqual(63);
    expect(pasted1.name.endsWith('_copy')).toBe(true);
    expect(pasted2.name.endsWith('_copy')).toBe(true);
    expect(plan.report.notes).toContainEqual({
      code: 'schemaFallback',
      from: 'sales',
      to: 'public',
      tables: 2,
    });
  });

  test('SQLite: STRICT + WITHOUT ROWID、AUTOINCREMENT、大小写不敏感碰撞与 items 校验', () => {
    const m = emptyModel('sqlite');
    const main = createSchema(m, 'main');

    const strictTbl = createTable(m, main, 'Users', undefined, null, {
      sqlite: { strict: true, withoutRowid: true },
    });
    const uid = addColumn(m, strictTbl, { name: 'id', type: 'INTEGER', notNull: true });
    const uEmail = addColumn(m, strictTbl, { name: 'Email', type: 'TEXT', notNull: true });
    addPrimaryKey(m, strictTbl, [uid]);
    setTableExt(m, strictTbl, { sqlite: { strict: true, withoutRowid: true } });

    const autoTbl = createTable(m, main, 'logs');
    const lid = addColumn(m, autoTbl, { name: 'id', type: 'INTEGER', notNull: true });
    addPrimaryKey(m, autoTbl, [lid]);
    setColumnExt(m, lid, { sqlite: { autoincrement: true } });
    addColumn(m, autoTbl, { name: 'bad_strict_type', type: 'VARCHAR(32)' });
    expect(validate(m)).toEqual([]);

    // 复制 strict+withoutRowid 与 autoincrement 两张表并同模型粘贴
    const payload = copyTables(m, [strictTbl, autoTbl], { source: SRC });
    const plan = planPaste(m, payload);
    runMutator(m, 'paste', { ops: plan.ops });
    expect(validate(m)).toEqual([]);

    const newStrict = m.objects[plan.tableMap[strictTbl]!]!;
    const newAutoCol = columnsOf(m, plan.tableMap[autoTbl]!)[0]!;
    expect(newStrict.kind === 'table' && newStrict.ext?.sqlite).toEqual({
      strict: true,
      withoutRowid: true,
    });
    expect(newAutoCol.ext?.sqlite?.autoincrement).toBe(true);

    // 大小写碰撞测试：粘贴到含小写 users 的目标库，应碰撞改名为 Users_copy
    const tgt = emptyModel('sqlite');
    const tMain = createSchema(tgt, 'main');
    const lowerUsers = createTable(tgt, tMain, 'users', undefined, null, { sqlite: { strict: true } });
    addColumn(tgt, lowerUsers, { name: 'email', type: 'TEXT' });
    const planCi = planPaste(tgt, copyTables(m, [strictTbl], { source: SRC }));
    runMutator(tgt, 'paste', { ops: planCi.ops });
    expect(validate(tgt)).toEqual([]);
    expect(tgt.objects[planCi.newTables[0]!]!.name).toBe('Users_copy');

    // items 粘贴：Email 与小写 email 碰撞，且 bad_strict_type 在 STRICT 表被跳过为 unsupported
    const itemPayload = copyItems(m, autoTbl, [columnsOf(m, autoTbl)[1]!.id, lid], { source: SRC });
    // 也测从 strictTbl 复制 Email 到 lowerUsers
    const emailItem = copyItems(m, strictTbl, [uEmail], { source: SRC });
    const pEmail = planPaste(tgt, emailItem, { targetTable: lowerUsers });
    runMutator(tgt, 'paste', { ops: pEmail.ops });
    expect(validate(tgt)).toEqual([]);
    expect(columnsOf(tgt, lowerUsers).map((c) => c.name)).toContain('Email_copy');

    const pBadStrict = planPaste(tgt, itemPayload, { targetTable: lowerUsers });
    expect(pBadStrict.report.skipped).toContainEqual(
      expect.objectContaining({ kind: 'column', name: 'bad_strict_type', reason: 'unsupported' }),
    );
    expect(pBadStrict.report.skipped).toContainEqual(
      expect.objectContaining({ kind: 'column', name: 'id', reason: 'unsupported' }),
    );
  });

  test('SQLite: 复制粘贴非 STRICT 无类型列与 BIGINT 主键保留原文，粘进 STRICT 表时拦截', () => {
    const src = emptyModel('sqlite');
    const sMain = createSchema(src, 'main');
    const tbl = createTable(src, sMain, 'raw_items');
    const pk = addColumn(src, tbl, { name: 'id', type: 'bigint', notNull: true });
    addPrimaryKey(src, tbl, [pk]);
    const untyped = addColumn(src, tbl, { name: 'payload', type: '' });
    addColumn(src, tbl, { name: 'active', type: 'boolean' });

    // 表粒度：同模型 + 跨 SQLite 模型往返保留 '' / BIGINT / BOOLEAN
    const tblPayload = parseClipboard(serializeClipboard(copyTables(src, [tbl], { source: SRC })))!;
    const samePlan = planPaste(src, tblPayload);
    const srcCopy = clonePlain(src);
    runMutator(srcCopy, 'paste', { ops: samePlan.ops });
    expect(validate(srcCopy)).toEqual([]);
    expect(columnsOf(srcCopy, samePlan.newTables[0]!).map((c) => [c.name, c.type])).toEqual([
      ['id', 'BIGINT'],
      ['payload', ''],
      ['active', 'BOOLEAN'],
    ]);

    const other = emptyModel('sqlite');
    const oMain = createSchema(other, 'main');
    const otherPlan = planPaste(other, tblPayload);
    runMutator(other, 'paste', { ops: otherPlan.ops });
    expect(validate(other)).toEqual([]);
    expect(columnsOf(other, otherPlan.newTables[0]!).map((c) => [c.name, c.type])).toEqual([
      ['id', 'BIGINT'],
      ['payload', ''],
      ['active', 'BOOLEAN'],
    ]);

    // items 粒度：粘进非 STRICT 表保留 ''，粘进 STRICT 表报错并跳过
    const itemPayload = parseClipboard(serializeClipboard(copyItems(src, tbl, [untyped], { source: SRC })))!;
    const looseTgt = createTable(other, oMain, 'loose');
    addColumn(other, looseTgt, { name: 'k', type: 'TEXT' });
    const pLoose = planPaste(other, itemPayload, { targetTable: looseTgt });
    runMutator(other, 'paste', { ops: pLoose.ops });
    expect(validate(other)).toEqual([]);
    expect(columnsOf(other, looseTgt).find((c) => c.name === 'payload')?.type).toBe('');

    const strictTgt = createTable(other, oMain, 'strict_tbl', undefined, null, { sqlite: { strict: true } });
    addColumn(other, strictTgt, { name: 'k', type: 'TEXT' });
    const pStrict = planPaste(other, itemPayload, { targetTable: strictTgt });
    expect(pStrict.report.skipped).toContainEqual(
      expect.objectContaining({
        kind: 'column',
        name: 'payload',
        reason: 'unsupported',
        detail: 'STRICT 表的列必须声明类型',
      }),
    );
  });

  test('MySQL: ENGINE/CHARSET、UNSIGNED、AUTO_INCREMENT、FULLTEXT 索引、inline enum 与 items 限制', () => {
    const m = emptyModel('mysql');
    const def = createSchema(m, 'default');
    const articles = createTable(m, def, 'Articles', undefined, null, {
      mysql: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' },
    });
    const aid = addColumn(m, articles, {
      name: 'id',
      type: 'bigint',
      notNull: true,
      ext: { mysql: { unsigned: true, autoIncrement: true } },
    });
    const status = addColumn(m, articles, {
      name: 'status',
      type: "enum('draft','pub')",
      notNull: true,
      ext: { mysql: { enumValues: ['draft', 'pub'] } },
    });
    const body = addColumn(m, articles, { name: 'body', type: 'text' });
    addPrimaryKey(m, articles, [aid]);
    addIndex(m, articles, [{ column: body }], { ext: { mysql: { indexType: 'FULLTEXT' } } });
    expect(validate(m)).toEqual([]);

    const payload = copyTables(m, [articles], { source: SRC });
    const plan = planPaste(m, payload);
    runMutator(m, 'paste', { ops: plan.ops });
    expect(validate(m)).toEqual([]);

    const newT = plan.newTables[0]!;
    expect(m.objects[newT]!.name).toBe('Articles_copy');
    const newAid = columnsOf(m, newT)[0]!;
    expect(newAid.ext?.mysql).toEqual({ unsigned: true, autoIncrement: true });
    expect(childrenOf(m, newT, 'primaryKey')[0]!.name).toBe('PRIMARY');
    expect(childrenOf(m, newT, 'index')[0]!.ext?.mysql?.indexType).toBe('FULLTEXT');

    // items 粘贴第二个 AUTO_INCREMENT 列到 articles：应跳过 unsupported
    const other = createTable(m, def, 'other');
    const oid = addColumn(m, other, {
      name: 'other_id',
      type: 'int',
      notNull: true,
      ext: { mysql: { autoIncrement: true } },
    });
    const opk = addPrimaryKey(m, other, [oid]);
    const aiItem = copyItems(m, other, [oid, opk], { source: SRC });
    const pAi = planPaste(m, aiItem, { targetTable: articles });
    expect(pAi.report.skipped).toContainEqual(
      expect.objectContaining({ kind: 'column', name: 'other_id', reason: 'unsupported' }),
    );
    expect(pAi.report.skipped).toContainEqual(
      expect.objectContaining({ kind: 'primaryKey', reason: 'targetHasPrimaryKey' }),
    );

    // 大小写不敏感碰撞：articles vs Articles
    const tgt = emptyModel('mysql');
    const tDef = createSchema(tgt, 'default');
    const lowerArt = createTable(tgt, tDef, 'articles');
    addColumn(tgt, lowerArt, { name: 'id', type: 'int' });
    const pCi = planPaste(tgt, payload);
    runMutator(tgt, 'paste', { ops: pCi.ops });
    expect(validate(tgt)).toEqual([]);
    expect(tgt.objects[pCi.newTables[0]!]!.name).toBe('Articles_copy');
    void status;
  });

  test('MSSQL: IDENTITY、显式/推导 DEFAULT 约束名后缀、CLUSTERED/NONCLUSTERED 与 items 单例限制', () => {
    const m = emptyModel('mssql');
    const dbo = createSchema(m, 'dbo');
    const tbl = createTable(m, dbo, 'Items');
    const idCol = addColumn(m, tbl, {
      name: 'Id',
      type: 'bigint',
      notNull: true,
      ext: { mssql: { identity: { seed: '10', increment: '5' } } },
    });
    addColumn(m, tbl, {
      name: 'Qty',
      type: 'int',
      notNull: true,
      default: { expr: '((0))' },
      ext: { mssql: { defaultName: 'DF_Items_Qty_Custom', defaultNameMode: 'explicit' } },
    });
    const codeCol = addColumn(m, tbl, { name: 'Code', type: 'nvarchar(50)', notNull: true });
    addPrimaryKey(m, tbl, [idCol], undefined, { mssql: { clustered: true } });
    addUnique(m, tbl, [codeCol], false, undefined, { mssql: { clustered: false } });
    expect(validate(m)).toEqual([]);

    // 同模型粘贴：显式 DF 约束名应后缀并记入 report.renamed(kind='column')
    const payload = copyTables(m, [tbl], { source: SRC });
    const plan = planPaste(m, payload);
    runMutator(m, 'paste', { ops: plan.ops });
    expect(validate(m)).toEqual([]);

    const newT = plan.newTables[0]!;
    expect(m.objects[newT]!.name).toBe('Items_copy');
    const newCols = columnsOf(m, newT);
    expect(newCols[0]!.ext?.mssql?.identity).toEqual({ seed: '10', increment: '5' });
    expect(newCols[1]!.ext?.mssql?.defaultName).toBe('DF_Items_Qty_Custom_copy');
    expect(plan.report.renamed).toContainEqual({
      kind: 'column',
      table: 'Items_copy',
      from: 'DF_Items_Qty_Custom',
      to: 'DF_Items_Qty_Custom_copy',
    });

    // items 粘贴：第二 IDENTITY 列与第二 CLUSTERED 索引应跳过为 unsupported
    const src2 = createTable(m, dbo, 'SrcExtra');
    const s2Id = addColumn(m, src2, {
      name: 'ExtraId',
      type: 'int',
      notNull: true,
      ext: { mssql: { identity: { seed: '1', increment: '1' } } },
    });
    const s2Code = addColumn(m, src2, { name: 'Tag', type: 'nvarchar(20)', notNull: true });
    const s2ClUq = addUnique(m, src2, [s2Code], false, undefined, { mssql: { clustered: true } });
    // 来源表本身也必须合法（每表最多 1 个 CLUSTERED）：聚集索引放在另一张来源表上
    const src3 = createTable(m, dbo, 'SrcIdx');
    const s3Code = addColumn(m, src3, { name: 'Code', type: 'nvarchar(50)', notNull: true });
    const s2ClIx = addIndex(m, src3, [{ column: s3Code }], { ext: { mssql: { clustered: true } } });
    expect(validate(m)).toEqual([]);

    const itemPayload = copyItems(m, src2, [s2Id, s2Code, s2ClUq], { source: SRC });
    const pItems = planPaste(m, itemPayload, { targetTable: tbl });
    runMutator(m, 'paste', { ops: pItems.ops });
    expect(validate(m)).toEqual([]);
    const pIdx = planPaste(m, copyItems(m, src3, [s2ClIx], { source: SRC }), { targetTable: tbl });
    expect(pIdx.ops).toEqual([]);

    expect(pItems.report.skipped).toContainEqual(
      expect.objectContaining({ kind: 'column', name: 'ExtraId', reason: 'unsupported' }),
    );
    expect(pItems.report.skipped).toContainEqual(
      expect.objectContaining({ kind: 'unique', reason: 'unsupported' }),
    );
    expect(pIdx.report.skipped).toContainEqual(
      expect.objectContaining({ kind: 'index', reason: 'unsupported' }),
    );
    expect(columnsOf(m, tbl).map((c) => c.name)).toContain('Tag');
  });

  test('renameTable / 显式与推导约束在各场景后保持 validate 为空', () => {
    const m = emptyModel('pg');
    const pub = createSchema(m, 'public');
    const t = createTable(m, pub, 'a');
    const c = addColumn(m, t, { name: 'x', type: 'integer', notNull: true });
    addPrimaryKey(m, t, [c]);
    renameTable(m, t, 'a_copy');
    const plan = planPaste(m, copyTables(m, [t], { source: SRC }));
    runMutator(m, 'paste', { ops: plan.ops });
    expect(validate(m)).toEqual([]);
    expect(
      all(m, 'table')
        .map((x) => x.name)
        .sort(),
    ).toEqual(['a_copy', 'a_copy2']);
  });
});
