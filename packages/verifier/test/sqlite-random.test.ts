import * as E from '@dowel/core';
import { emptyBase, emptyModel, type Model, plan, validate } from '@dowel/core';
import { openSqliteDb, stepsChecksum, toScriptSteps } from '@dowel/engines';
import { type ChainVersion, checkDrift, execute, markApplied } from '@dowel/executor';
// SQLite fast-check 随机闭环验证（300+ 轮，内存库毫秒级执行）：
// 覆盖建删改表/列、类型/NOT NULL/DEFAULT/COLLATE/GENERATED/AUTOINCREMENT 触发 12 步表重建、
// PK/UNIQUE/FK/CHECK、普通/唯一/表达式/部分索引、STRICT/WITHOUT ROWID、冻结脚本 verifyScripts 及执行器+历史表闭环。
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { analyze, verify, verifyScripts } from '../src/index.ts';

const SQLITE_TYPES = ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'ANY'] as const;
const STRICT_TYPES = ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'ANY'] as const;

const DEFAULTS_BY_TYPE: Record<string, string[]> = {
  INTEGER: ['0', '1', '-5', '42'],
  TEXT: ["''", "'hello'", "'a''b'"],
  REAL: ['0.0', '1.5', '-3.25'],
  BLOB: ["X'0102'"],
  ANY: ['0', "'x'"],
};

const FK_ACTIONS: E.FkAction[] = ['noAction', 'restrict', 'cascade', 'setNull', 'setDefault'];

const pick = <T>(xs: readonly T[], r: () => number): T | undefined =>
  xs.length ? xs[Math.floor(r() * xs.length)] : undefined;

const identArb = (prefix: string, r: () => number) => {
  const pool = ['a', 'b', 'c', 'order', 'select', 'User_1', 'x9', 'group', 'k', 'val'];
  return `${prefix}_${pick(pool, r)}_${Math.floor(r() * 50)}`;
};

const makePrng = (seed: number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 在一个合法的 SQLite 模型上随机执行一步合规编辑（保持 validate(m) === []） */
const mutateSqlite = (m: Model, r: () => number): boolean => {
  const mainSchema = E.all(m, 'schema')[0]!;
  const tables = E.all(m, 'table');
  const op = Math.floor(r() * 18);

  try {
    switch (op) {
      case 0:
      case 1: {
        // 新建表（含 1-3 列、可选 PK/AUTOINCREMENT/STRICT/WITHOUT ROWID）
        if (tables.length >= 6) return false;
        const tName = identArb('tbl', r);
        const strict = r() < 0.45;
        const tid = E.createTable(
          m,
          mainSchema.id,
          tName,
          undefined,
          null,
          strict ? { sqlite: { strict: true } } : undefined,
        );
        const idCol = E.addColumn(m, tid, { name: 'id', type: 'INTEGER', notNull: true });
        if (r() < 0.85) {
          E.addPrimaryKey(m, tid, [idCol]);
          if (r() < 0.35) E.setColumnExt(m, idCol, { sqlite: { autoincrement: true } });
          else if (r() < 0.25)
            E.setTableExt(m, tid, { sqlite: { ...(strict ? { strict: true } : {}), withoutRowid: true } });
        }
        const extra = 1 + Math.floor(r() * 2);
        for (let i = 0; i < extra; i++) {
          const ty = pick(strict ? STRICT_TYPES : SQLITE_TYPES, r)!;
          const notNull = r() < 0.4;
          const defVal = r() < 0.5 ? { expr: pick(DEFAULTS_BY_TYPE[ty]!, r)! } : null;
          E.addColumn(m, tid, {
            name: identArb('c', r),
            type: ty,
            notNull,
            default: defVal,
            collation: ty === 'TEXT' && r() < 0.25 ? 'NOCASE' : null,
          });
        }
        return true;
      }
      case 2: {
        // 删表
        if (tables.length <= 1) return false;
        const t = pick(tables, r)!;
        E.dropTable(m, t.id);
        return true;
      }
      case 3: {
        // 表改名
        const t = pick(tables, r);
        if (!t) return false;
        E.renameTable(m, t.id, identArb('tbl', r));
        return true;
      }
      case 4:
      case 5: {
        // 添加列（含安全追加、触发重建的 NOT NULL 无默认、表达式默认、GENERATED VIRTUAL/STORED）
        const t = pick(tables, r);
        if (!t) return false;
        const cols = E.columnsOf(m, t.id);
        if (cols.length >= 8) return false;
        const ty = pick(t.ext?.sqlite?.strict ? STRICT_TYPES : SQLITE_TYPES, r)!;
        const kindRoll = r();
        if (kindRoll < 0.15) {
          const base = cols.find((c) => !c.generated && (c.type === 'INTEGER' || c.type === 'TEXT'));
          if (!base) return false;
          const expr =
            base.type === 'TEXT' ? `length(${E.sqliteIdent(base.name)})` : `${E.sqliteIdent(base.name)} + 1`;
          E.addColumn(m, t.id, {
            name: identArb('g', r),
            type: 'INTEGER',
            generated: { expr, stored: r() < 0.5 },
          });
        } else if (kindRoll < 0.4) {
          E.addColumn(m, t.id, {
            name: identArb('c', r),
            type: ty,
            notNull: true,
            default: r() < 0.5 ? null : { expr: pick(DEFAULTS_BY_TYPE[ty]!, r)! },
          });
        } else {
          E.addColumn(m, t.id, {
            name: identArb('c', r),
            type: ty,
            notNull: false,
            default: r() < 0.5 ? { expr: pick(DEFAULTS_BY_TYPE[ty]!, r)! } : null,
            collation: ty === 'TEXT' && r() < 0.25 ? 'NOCASE' : null,
          });
        }
        return true;
      }
      case 6: {
        // 列改名
        const t = pick(tables, r);
        if (!t) return false;
        const c = pick(E.columnsOf(m, t.id), r);
        if (!c) return false;
        E.renameColumn(m, c.id, identArb('c', r));
        return true;
      }
      case 7: {
        // 删列（保留至少一列，且不删 WITHOUT ROWID 表的主键列）
        const t = pick(tables, r);
        if (!t) return false;
        const cols = E.columnsOf(m, t.id);
        if (cols.length <= 1) return false;
        const pkCols = new Set(E.childrenOf(m, t.id, 'primaryKey').flatMap((p) => p.columns));
        const candidates = cols.filter((c) => !(t.ext?.sqlite?.withoutRowid && pkCols.has(c.id)));
        const c = pick(candidates, r);
        if (!c) return false;
        // 若删除后表会变成无列（例如所有剩余列都是依赖它的生成列），放弃
        const copy = structuredClone(m);
        E.dropColumn(copy, c.id);
        if (E.columnsOf(copy, t.id).length === 0) return false;
        E.dropColumn(m, c.id);
        return true;
      }
      case 8: {
        // 改列类型（触发 12 步重建）
        const t = pick(tables, r);
        if (!t) return false;
        const candidates = E.columnsOf(m, t.id).filter((c) => !c.generated);
        const c = pick(candidates, r);
        if (!c) return false;
        const ty = pick(t.ext?.sqlite?.strict ? STRICT_TYPES : SQLITE_TYPES, r)!;
        E.setColumnType(m, c.id, ty);
        if (c.default) E.setDefault(m, c.id, { expr: pick(DEFAULTS_BY_TYPE[ty]!, r)! });
        return true;
      }
      case 9: {
        // 切换 NOT NULL 或 DEFAULT（触发 12 步重建）
        const t = pick(tables, r);
        if (!t) return false;
        const candidates = E.columnsOf(m, t.id).filter((c) => !c.generated);
        const c = pick(candidates, r);
        if (!c) return false;
        if (r() < 0.5) {
          E.setNotNull(m, c.id, !c.notNull);
        } else {
          const defVal = c.default ? null : { expr: pick(DEFAULTS_BY_TYPE[c.type] ?? ['0'], r)! };
          E.setDefault(m, c.id, defVal);
        }
        return true;
      }
      case 10: {
        // 切换 STRICT / WITHOUT ROWID / AUTOINCREMENT
        const t = pick(tables, r);
        if (!t) return false;
        if (r() < 0.5) {
          const nextStrict = !t.ext?.sqlite?.strict;
          E.setTableExt(m, t.id, {
            sqlite: {
              ...(t.ext?.sqlite ?? {}),
              strict: nextStrict || undefined,
            },
          });
        } else {
          const nextWithout = !t.ext?.sqlite?.withoutRowid;
          E.setTableExt(m, t.id, {
            sqlite: {
              ...(t.ext?.sqlite ?? {}),
              withoutRowid: nextWithout || undefined,
            },
          });
        }
        return true;
      }
      case 11: {
        // 增/删 PRIMARY KEY
        const t = pick(tables, r);
        if (!t) return false;
        const pks = E.childrenOf(m, t.id, 'primaryKey');
        if (pks.length > 0 && r() < 0.4) {
          E.dropKey(m, pks[0]!.id);
          return true;
        }
        if (pks.length === 0) {
          const c = pick(
            E.columnsOf(m, t.id).filter((x) => !x.generated),
            r,
          );
          if (!c) return false;
          E.addPrimaryKey(m, t.id, [c.id]);
          return true;
        }
        return false;
      }
      case 12: {
        // 添加 UNIQUE 约束
        const t = pick(tables, r);
        if (!t) return false;
        const cols = E.columnsOf(m, t.id).filter((x) => !x.generated);
        const c = pick(cols, r);
        if (!c) return false;
        // 避免和已有同列 UNIQUE 重复
        if (E.childrenOf(m, t.id, 'unique').some((u) => u.columns.length === 1 && u.columns[0] === c.id)) {
          return false;
        }
        E.addUnique(m, t.id, [c.id]);
        return true;
      }
      case 13: {
        // 添加 CHECK 约束
        const t = pick(tables, r);
        if (!t) return false;
        const c = pick(
          E.columnsOf(m, t.id).filter((x) => !x.generated),
          r,
        );
        if (!c) return false;
        const expr =
          c.type === 'TEXT'
            ? `length(${E.sqliteIdent(c.name)}) >= 0`
            : `${E.sqliteIdent(c.name)} IS NOT NULL OR ${E.sqliteIdent(c.name)} IS NULL`;
        E.addCheck(m, t.id, expr);
        return true;
      }
      case 14: {
        // 添加 FOREIGN KEY（指向另一个表或自引用的主键/唯一列）
        const t = pick(tables, r);
        const ref = pick(tables, r);
        if (!t || !ref) return false;
        const refPk = E.childrenOf(m, ref.id, 'primaryKey')[0];
        if (!refPk || refPk.columns.length !== 1) return false;
        const refCol = E.get(m, refPk.columns[0]!, 'column');
        const col = E.columnsOf(m, t.id).find((c) => !c.generated && c.type === refCol.type);
        if (!col) return false;
        const onDelete = pick(FK_ACTIONS, r)!;
        const onUpdate = pick(FK_ACTIONS, r)!;
        // SET NULL / SET DEFAULT 需要列允许 NULL 或有默认
        if (onDelete === 'setNull' && col.notNull) return false;
        if (onUpdate === 'setNull' && col.notNull) return false;
        E.addForeignKey(m, t.id, [col.id], ref.id, [refCol.id], {
          onDelete,
          onUpdate,
          deferrable: r() < 0.3,
          initiallyDeferred: r() < 0.5,
        });
        return true;
      }
      case 15: {
        // 添加索引（普通/唯一/DESC/表达式/部分 WHERE）
        const t = pick(tables, r);
        if (!t) return false;
        const c = pick(
          E.columnsOf(m, t.id).filter((x) => !x.generated),
          r,
        );
        if (!c) return false;
        const isExpr = c.type === 'TEXT' && r() < 0.3;
        E.addIndex(
          m,
          t.id,
          isExpr
            ? [{ expr: `lower(${E.sqliteIdent(c.name)})`, desc: r() < 0.4 }]
            : [{ column: c.id, desc: r() < 0.4 }],
          {
            unique: r() < 0.3,
            where: r() < 0.3 ? `${E.sqliteIdent(c.name)} IS NOT NULL` : null,
          },
        );
        return true;
      }
      case 16: {
        // 删约束或索引
        const keys = [
          ...E.all(m, 'unique'),
          ...E.all(m, 'check'),
          ...E.all(m, 'foreignKey'),
          ...E.all(m, 'index'),
        ];
        const k = pick(keys, r);
        if (!k) return false;
        E.dropKey(m, k.id);
        return true;
      }
      case 17: {
        // 显式重命名约束或索引
        const keys = [
          ...E.all(m, 'primaryKey'),
          ...E.all(m, 'unique'),
          ...E.all(m, 'check'),
          ...E.all(m, 'foreignKey'),
          ...E.all(m, 'index'),
        ];
        const k = pick(keys, r);
        if (!k) return false;
        E.renameKey(m, k.id, identArb('k', r));
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
};

const buildPair = (seed: number, initOps: number, diffOps: number): { from: Model; to: Model } => {
  const r = makePrng(seed);
  const from = emptyModel('sqlite');
  E.createSchema(from, 'main');
  for (let i = 0; i < initOps; i++) {
    const snap = structuredClone(from);
    if (!mutateSqlite(from, r) || validate(from).length > 0) {
      from.objects = snap.objects;
    }
  }
  const to = structuredClone(from);
  for (let i = 0; i < diffOps; i++) {
    const snap = structuredClone(to);
    if (!mutateSqlite(to, r) || validate(to).length > 0) {
      to.objects = snap.objects;
    }
  }
  return { from, to };
};

describe('SQLite fast-check random roundtrip (300+ rounds)', () => {
  it('verifies up/down closure and frozen verifyScripts over 320 random schema transitions', async () => {
    const shadow = openSqliteDb(':memory:');
    let rebuildHits = 0;
    let totalSteps = 0;
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.integer({ min: 3, max: 10 }),
          fc.integer({ min: 2, max: 8 }),
          async (seed, initOps, diffOps) => {
            const { from, to } = buildPair(seed, initOps, diffOps);
            expect(validate(from)).toEqual([]);
            expect(validate(to)).toEqual([]);

            const res = await verify(shadow.db, from, to);
            expect(res.upDiff).toEqual([]);
            expect(res.downDiff).toEqual([]);

            totalSteps += res.up.length;
            if (res.up.some((s) => s.kind === 'rebuildTable')) rebuildHits++;

            // 冻结脚本闭环验证（verifyScripts）
            const upFrozen = toScriptSteps(res.up, 'sqlite');
            const downFrozen = toScriptSteps(res.down, 'sqlite');
            const frozenRes = await verifyScripts(shadow.db, from, to, upFrozen, downFrozen);
            expect(frozenRes.upDiff).toEqual([]);
            expect(frozenRes.downDiff).toEqual([]);
          },
        ),
        { numRuns: 320, seed: 20261121 },
      );
      expect(totalSteps).toBeGreaterThan(200);
      expect(rebuildHits).toBeGreaterThan(30);
    } finally {
      shadow.close();
    }
  }, 60_000);

  it('executes, rolls back, re-executes, detects drift, and marks versions end-to-end on SQLite', async () => {
    const { from: m1, to: m2 } = buildPair(424242, 8, 6);
    const m0 = emptyBase(m1, null);

    const up1 = toScriptSteps(plan(m0, m1), 'sqlite');
    const down1 = toScriptSteps(plan(m1, m0), 'sqlite');
    const up2 = toScriptSteps(plan(m1, m2), 'sqlite');
    const down2 = toScriptSteps(plan(m2, m1), 'sqlite');

    const chain: ChainVersion[] = [
      {
        id: 'ver-1',
        number: 1,
        parentId: null,
        name: 'initial',
        model: m1,
        upSteps: up1,
        downSteps: down1,
        checksum: stepsChecksum(up1, down1),
        verified: true,
        publishedAt: new Date().toISOString(),
        publishedBy: 'tester',
        scope: null,
      },
      {
        id: 'ver-2',
        number: 2,
        parentId: 'ver-1',
        name: 'evolve',
        model: m2,
        upSteps: up2,
        downSteps: down2,
        checksum: stepsChecksum(up2, down2),
        verified: true,
        publishedAt: new Date().toISOString(),
        publishedBy: 'tester',
        scope: null,
      },
    ];

    // 风险分析无报错
    const shadow = openSqliteDb(':memory:');
    try {
      const risks = await analyze(shadow.db, m1, plan(m1, m2));
      expect(risks).toHaveLength(up2.length);
    } finally {
      shadow.close();
    }

    // 完整执行器闭环：空库 → v2 → 回滚 v1 → 再次升到 v2 → 人为制造漂移被拦截 → 修复后通过
    const target = openSqliteDb(':memory:');
    try {
      const rUp = await execute({
        db: target.db,
        dialect: 'sqlite',
        projectId: 'proj-sqlite',
        projectName: 'SQLite App',
        instanceId: 'inst-1',
        chain,
        to: 'ver-2',
        executedBy: 'u1',
      });
      expect(rUp.current).toBe('ver-2');
      expect(rUp.ran).toHaveLength(2);

      expect(await checkDrift({ db: target.db, dialect: 'sqlite', projectId: 'proj-sqlite', chain })).toEqual(
        {
          status: 'ok',
          version: 'ver-2',
        },
      );

      const rDown = await execute({
        db: target.db,
        dialect: 'sqlite',
        projectId: 'proj-sqlite',
        projectName: 'SQLite App',
        instanceId: 'inst-1',
        chain,
        to: 'ver-1',
        direction: 'down',
        executedBy: 'u1',
      });
      expect(rDown.current).toBe('ver-1');

      const rUpAgain = await execute({
        db: target.db,
        dialect: 'sqlite',
        projectId: 'proj-sqlite',
        projectName: 'SQLite App',
        instanceId: 'inst-1',
        chain,
        to: 'ver-2',
        executedBy: 'u1',
      });
      expect(rUpAgain.current).toBe('ver-2');

      // 人为破坏结构触发漂移
      await target.db.exec('CREATE TABLE rogue_table (x INTEGER PRIMARY KEY)');
      const drifted = await checkDrift({ db: target.db, dialect: 'sqlite', projectId: 'proj-sqlite', chain });
      expect(drifted.status).toBe('drifted');

      // 恢复后可以 markApplied（先模拟回退到 v1 结构）
      await target.db.exec('DROP TABLE rogue_table');
      for (const s of down2) {
        await target.db.exec(s.sql);
      }
      const marked = await markApplied({
        db: target.db,
        dialect: 'sqlite',
        projectId: 'proj-sqlite',
        projectName: 'SQLite App',
        instanceId: 'inst-1',
        chain,
        to: 'ver-1',
        executedBy: 'u1',
      });
      expect(marked.plan.direction).toBe('backward');
      expect(marked.runId).not.toBeNull();
    } finally {
      target.close();
    }
  });
});
