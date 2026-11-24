import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  addCheck,
  addColumn,
  addForeignKey,
  addIndex,
  addPrimaryKey,
  addUnique,
  copyTables,
  createEnum,
  createSchema,
  createSequence,
  createTable,
  deepEqual,
  type Dialect,
  emptyModel,
  getDialect,
  type Model,
  type Obj,
  parseClipboard,
  planPaste,
  renameKey,
  runMutator,
  serializeClipboard,
  setComment,
  setSequenceOwnedBy,
  validate,
} from '../src/index.ts';

const SRC = { projectId: 'prop', projectName: 'Prop', origin: 'canvas' as const, seq: null };

interface TableSpec {
  name: string;
  colNames: string[];
  hasPk: boolean;
  hasUnique: boolean;
  hasCheck: boolean;
  hasIndex: boolean;
  explicitNames: boolean;
  fkTargetIdx: number | null;
  comment: string | null;
}

const identArb = fc.oneof(
  fc.constantFrom('users', 'orders', 'items', 'orders_copy', 'logs_copy2', 'Account', 'Events'),
  fc
    .stringMatching(/^[a-z][a-z0-9_]{1,12}$/)
    .filter((s) => !s.startsWith('sqlite_') && !s.startsWith('dowel_')),
);

const tableSpecArb = fc.record<TableSpec>({
  name: identArb,
  colNames: fc.uniqueArray(
    fc.oneof(
      fc.constantFrom('id', 'code', 'amount', 'Name', 'status_id', 'ref_col'),
      fc.stringMatching(/^[a-z][a-z0-9_]{1,10}$/),
    ),
    { minLength: 2, maxLength: 5, selector: (s) => s.toLowerCase() },
  ),
  hasPk: fc.boolean(),
  hasUnique: fc.boolean(),
  hasCheck: fc.boolean(),
  hasIndex: fc.boolean(),
  explicitNames: fc.boolean(),
  fkTargetIdx: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
  comment: fc.option(fc.constantFrom('表备注', 'note'), { nil: null }),
});

const scenarioArb = fc.record({
  dialect: fc.constantFrom<Dialect>('pg', 'sqlite', 'mysql', 'mssql'),
  tables: fc.uniqueArray(tableSpecArb, {
    minLength: 2,
    maxLength: 4,
    selector: (t) => t.name.toLowerCase(),
  }),
  copyMask: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
  pasteCountSame: fc.integer({ min: 1, max: 3 }),
  pasteCountFresh: fc.integer({ min: 1, max: 3 }),
  extraSchema: fc.boolean(),
  withCollisions: fc.boolean(),
});

const buildModelFromSpec = (
  dialect: Dialect,
  specs: readonly TableSpec[],
  withExtraSchema: boolean,
): { model: Model; tableIds: string[] } => {
  const m = emptyModel(dialect);
  const d = getDialect(dialect);
  const defSchema = createSchema(m, d.capabilities.defaultSchema);
  const altSchema = d.capabilities.schemas && withExtraSchema ? createSchema(m, 'alt_app') : defSchema;

  const intType = dialect === 'sqlite' ? 'INTEGER' : dialect === 'pg' ? 'integer' : 'int';
  const textType = dialect === 'sqlite' ? 'TEXT' : dialect === 'pg' ? 'text' : 'varchar(64)';

  const enumId = dialect === 'pg' ? createEnum(m, defSchema, 'status_kind', ['open', 'closed']) : null;
  const seqId = d.capabilities.sequences ? createSequence(m, defSchema, 'shared_seq') : null;

  const tableIds: string[] = [];
  const pkColByTable = new Map<string, string>();
  const usedGlobalNames = new Set<string>();
  const claimGlobal = (raw: string): string => {
    let cur = raw;
    for (let i = 1; usedGlobalNames.has(cur.toLowerCase()); i++) cur = `${raw}_${i}`;
    usedGlobalNames.add(cur.toLowerCase());
    return cur;
  };

  for (let i = 0; i < specs.length; i++) {
    const sp = specs[i]!;
    const sch = i % 2 === 1 ? altSchema : defSchema;
    const tName = claimGlobal(sp.name);
    const tid = createTable(m, sch, tName);
    tableIds.push(tid);
    if (sp.comment) setComment(m, tid, sp.comment);

    const colIds: string[] = [];
    for (let ci = 0; ci < sp.colNames.length; ci++) {
      const cname = sp.colNames[ci]!;
      let cid: string;
      if (ci === 0 && dialect === 'pg' && i === 0) {
        const ownedSeq = createSequence(m, sch, claimGlobal(`${tName}_id_seq`));
        cid = addColumn(m, tid, {
          name: cname,
          type: intType,
          notNull: true,
          default: { nextval: ownedSeq },
        });
        setSequenceOwnedBy(m, ownedSeq, cid);
      } else if (ci === 1 && enumId && i === 0) {
        cid = addColumn(m, tid, { name: cname, type: '', typeRef: enumId, notNull: true });
      } else if (ci === 1 && seqId && i === 1 && sch === defSchema) {
        cid = addColumn(m, tid, {
          name: cname,
          type: intType,
          notNull: true,
          default: { nextval: seqId },
        });
      } else {
        cid = addColumn(m, tid, {
          name: cname,
          type: ci === 0 ? intType : textType,
          notNull: ci === 0 && sp.hasPk,
        });
      }
      colIds.push(cid);
    }

    if (sp.hasPk) {
      const pkId = addPrimaryKey(m, tid, [colIds[0]!]);
      pkColByTable.set(tid, colIds[0]!);
      if (sp.explicitNames && dialect !== 'mysql') {
        renameKey(m, pkId, claimGlobal(`pk_${tName}_custom`));
      }
    }
    if (sp.hasUnique && colIds.length >= 2) {
      const uqId = addUnique(m, tid, [colIds[1]!]);
      if (sp.explicitNames) renameKey(m, uqId, claimGlobal(`uq_${tName}_custom`));
    }
    if (sp.hasCheck) {
      const ckId = addCheck(m, tid, `${d.quoteIdent(sp.colNames[0]!)} IS NOT NULL`);
      if (sp.explicitNames) renameKey(m, ckId, claimGlobal(`ck_${tName}_custom`));
    }
    if (sp.hasIndex && colIds.length >= 2) {
      const ixId = addIndex(m, tid, [{ column: colIds[1]! }]);
      if (sp.explicitNames) renameKey(m, ixId, claimGlobal(`ix_${tName}_custom`));
    }
  }

  for (let i = 0; i < specs.length; i++) {
    const sp = specs[i]!;
    if (sp.fkTargetIdx === null) continue;
    const refTid = tableIds[sp.fkTargetIdx % tableIds.length]!;
    const refPkCol = pkColByTable.get(refTid);
    if (!refPkCol) continue;
    const srcTid = tableIds[i]!;
    const fkCol = addColumn(m, srcTid, { name: 'fk_ref_col', type: intType });
    const fkId = addForeignKey(m, srcTid, [fkCol], refTid, [refPkCol]);
    if (sp.explicitNames) renameKey(m, fkId, claimGlobal(`fk_${specs[i]!.name}_custom`));
  }

  return { model: m, tableIds };
};

const assertPasteInvariants = (target: Model, payload: ReturnType<typeof copyTables>, pasteTimes: number) => {
  for (let round = 0; round < pasteTimes; round++) {
    const beforeObjs: Record<string, Obj> = structuredClone(target.objects);
    const beforeIds = new Set(Object.keys(beforeObjs));
    const targetSnapshotBeforePlan = JSON.stringify(target);

    const plan = planPaste(target, payload);
    expect(JSON.stringify(target)).toBe(targetSnapshotBeforePlan);
    expect(plan.newTables).toHaveLength(payload.tables.length);

    if (plan.ops.length > 0) {
      runMutator(target, 'paste', { ops: plan.ops });
    }
    expect(validate(target)).toEqual([]);

    for (const oldId of beforeIds) {
      expect(deepEqual(target.objects[oldId], beforeObjs[oldId])).toBe(true);
    }

    const newIds = Object.keys(target.objects).filter((id) => !beforeIds.has(id));
    expect(new Set(newIds).size).toBe(newIds.length);
    for (const nid of newIds) {
      expect(nid in payload.fragment).toBe(false);
    }
  }
};

describe('剪贴板复制粘贴属性测试（fast-check，覆盖四方言）', () => {
  test('随机模型复制粘贴 1–3 次保持 validate()==[]、ID 全新且既有对象零修改', () => {
    fc.assert(
      fc.property(scenarioArb, (sc) => {
        const { model, tableIds } = buildModelFromSpec(sc.dialect, sc.tables, sc.extraSchema);
        expect(validate(model)).toEqual([]);

        const selected = tableIds.filter((_, i) => sc.copyMask[i]);
        const picked = selected.length > 0 ? selected : [tableIds[0]!];

        const payload = parseClipboard(serializeClipboard(copyTables(model, picked, { source: SRC })));
        expect(payload).not.toBeNull();

        // 1. 粘贴到同模型 1–3 次
        assertPasteInvariants(model, payload!, sc.pasteCountSame);

        // 2. 粘贴到带随机碰撞的全新目标模型 1–3 次
        const freshTarget = emptyModel(sc.dialect);
        const defSch = createSchema(freshTarget, getDialect(sc.dialect).capabilities.defaultSchema);
        if (sc.withCollisions) {
          for (const tid of picked) {
            const name = model.objects[tid]!.name;
            const c = createTable(freshTarget, defSch, name);
            addColumn(freshTarget, c, {
              name: 'id',
              type: sc.dialect === 'sqlite' ? 'INTEGER' : sc.dialect === 'pg' ? 'integer' : 'int',
            });
          }
          if (sc.dialect === 'pg') {
            createEnum(freshTarget, defSch, 'status_kind', ['open']);
            createSequence(freshTarget, defSch, 'shared_seq');
          }
        }
        assertPasteInvariants(freshTarget, payload!, sc.pasteCountFresh);
      }),
      { numRuns: 120, seed: 20261124 },
    );
  });
});
