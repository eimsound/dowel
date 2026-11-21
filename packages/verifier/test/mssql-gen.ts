// MSSQL fast-check 随机模型生成器：生成合法且可在 SQL Server 2019 / 2022 / 2025 上闭环验证的模型对。
import * as E from '@dowel/core';
import { emptyModel, type Model, validate } from '@dowel/core';

const MSSQL_INDEXABLE_TYPES = [
  'int',
  'bigint',
  'smallint',
  'bit',
  'decimal(10,2)',
  'nvarchar(64)',
  'varchar(40)',
  'datetime2(3)',
  'uniqueidentifier',
] as const;
const MSSQL_EXTRA_TYPES = ['nvarchar(max)', 'varbinary(64)', 'float', 'date'] as const;
const ALL_TYPES = [...MSSQL_INDEXABLE_TYPES, ...MSSQL_EXTRA_TYPES] as const;

const DEFAULTS_BY_TYPE: Record<string, string[]> = {
  int: ['0', '1', '-5', '42'],
  bigint: ['0', '100', '99999'],
  smallint: ['0', '7'],
  bit: ['0', '1'],
  'decimal(10,2)': ['0.00', '12.50'],
  'nvarchar(64)': ["N''", "N'hello'", "N'a''b'"],
  'varchar(40)': ["''", "'abc'"],
  'datetime2(3)': ["'2025-01-01T00:00:00'"],
  uniqueidentifier: ["'00000000-0000-0000-0000-000000000000'"],
  'nvarchar(max)': ["N''", "N'long'"],
  'varbinary(64)': ['0x0102'],
  float: ['0', '1.5'],
  date: ["'2025-01-01'"],
};

const isIndexable = (ty: string): boolean =>
  (MSSQL_INDEXABLE_TYPES as readonly string[]).includes(ty.toLowerCase());

const pick = <T>(xs: readonly T[], r: () => number): T | undefined =>
  xs.length ? xs[Math.floor(r() * xs.length)] : undefined;

const identArb = (prefix: string, r: () => number) => {
  const pool = ['a', 'b', 'c', 'order', 'user', 'item', 'group', 'k', 'val', 'x9'];
  return `${prefix}_${pick(pool, r)}_${Math.floor(r() * 50)}`;
};

export const makeMssqlPrng = (seed: number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 避免在 MSSQL 中出现循环/多路径 CASCADE 外键（SQL Server 1785 限制） */
const wouldCreateFkCycle = (m: Model, fromTable: string, toTable: string): boolean => {
  if (fromTable === toTable) return true;
  const seen = new Set<string>([toTable]);
  const stack = [toTable];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const fk of E.all(m, 'foreignKey')) {
      if (fk.parent !== cur) continue;
      if (fk.refTable === fromTable) return true;
      if (!seen.has(fk.refTable)) {
        seen.add(fk.refTable);
        stack.push(fk.refTable);
      }
    }
  }
  return false;
};

/** 在一个合法的 MSSQL 模型上执行一步合规变更（始终维持 validate(m) === [] 且不违反 MSSQL 限制） */
export const mutateMssql = (m: Model, r: () => number, allowSchemaOps = true): boolean => {
  const schemas = E.all(m, 'schema');
  const tables = E.all(m, 'table');
  const op = Math.floor(r() * 20);

  try {
    switch (op) {
      case 0: {
        // 新建用户 schema
        if (!allowSchemaOps || schemas.length >= 3) return false;
        E.createSchema(m, identArb('sch', r));
        return true;
      }
      case 1:
      case 2: {
        // 新建表（带可选 IDENTITY 主键 + 1~3 普通列 + 可选带名 DEFAULT）
        if (tables.length >= 5) return false;
        const sch = pick(schemas, r)!;
        const tid = E.createTable(m, sch.id, identArb('tbl', r));
        const useIdentity = r() < 0.45;
        const idCol = E.addColumn(m, tid, {
          name: 'id',
          type: r() < 0.5 ? 'bigint' : 'int',
          notNull: true,
          ...(useIdentity ? { ext: { mssql: { identity: { seed: '1', increment: '1' } } } } : {}),
        });
        if (r() < 0.85) {
          E.addPrimaryKey(
            m,
            tid,
            [idCol],
            undefined,
            r() < 0.25 ? { mssql: { clustered: false } } : undefined,
          );
        }
        const extra = 1 + Math.floor(r() * 2);
        for (let i = 0; i < extra; i++) {
          const ty = pick(ALL_TYPES, r)!;
          const notNull = r() < 0.45;
          const defVal = r() < 0.5 ? { expr: pick(DEFAULTS_BY_TYPE[ty]!, r)! } : null;
          E.addColumn(m, tid, {
            name: identArb('c', r),
            type: ty,
            notNull,
            default: defVal,
          });
        }
        return true;
      }
      case 3: {
        // 删表
        if (tables.length <= 1) return false;
        const t = pick(tables, r)!;
        E.dropTable(m, t.id);
        return true;
      }
      case 4: {
        // 表改名
        const t = pick(tables, r);
        if (!t) return false;
        E.renameTable(m, t.id, identArb('tbl', r));
        return true;
      }
      case 5:
      case 6: {
        // 加列（普通列 / 带 DEFAULT / 计算列 PERSISTED 或虚拟）
        const t = pick(tables, r);
        if (!t) return false;
        const cols = E.columnsOf(m, t.id);
        if (cols.length >= 7) return false;
        if (r() < 0.2) {
          const base = cols.find((c) => !c.generated && (c.type === 'int' || c.type === 'bigint'));
          if (!base) return false;
          const persisted = r() < 0.5;
          E.addColumn(m, t.id, {
            name: identArb('g', r),
            type: base.type,
            notNull: persisted && r() < 0.5,
            generated: { expr: `${E.mssqlIdent(base.name)} + 1`, stored: persisted },
          });
        } else {
          const ty = pick(ALL_TYPES, r)!;
          const notNull = r() < 0.35;
          const defExpr = pick(DEFAULTS_BY_TYPE[ty]!, r)!;
          E.addColumn(m, t.id, {
            name: identArb('c', r),
            type: ty,
            notNull,
            default: notNull || r() < 0.5 ? { expr: defExpr } : null,
          });
        }
        return true;
      }
      case 7: {
        // 列改名
        const t = pick(tables, r);
        if (!t) return false;
        const c = pick(E.columnsOf(m, t.id), r);
        if (!c) return false;
        E.renameColumn(m, c.id, identArb('c', r));
        return true;
      }
      case 8: {
        // 删列（保留至少 1 列）
        const t = pick(tables, r);
        if (!t) return false;
        const cols = E.columnsOf(m, t.id);
        if (cols.length <= 1) return false;
        const c = pick(cols, r);
        if (!c) return false;
        const copy = structuredClone(m);
        E.dropColumn(copy, c.id);
        if (E.columnsOf(copy, t.id).length === 0) return false;
        E.dropColumn(m, c.id);
        return true;
      }
      case 9: {
        // 改列类型（非计算列、非 IDENTITY 列、且不被外键引用/作为外键列以免两边类型失配）
        const t = pick(tables, r);
        if (!t) return false;
        const fkCols = new Set(E.all(m, 'foreignKey').flatMap((f) => [...f.columns, ...f.refColumns]));
        const keyCols = new Set([
          ...E.childrenOf(m, t.id, 'primaryKey').flatMap((k) => k.columns),
          ...E.childrenOf(m, t.id, 'unique').flatMap((k) => k.columns),
          ...E.childrenOf(m, t.id, 'index').flatMap((x) =>
            x.elements.flatMap((e) => (e.column ? [e.column] : [])),
          ),
        ]);
        const candidates = E.columnsOf(m, t.id).filter(
          (c) => !c.generated && !c.ext?.mssql?.identity && !fkCols.has(c.id),
        );
        const c = pick(candidates, r);
        if (!c) return false;
        // 若被 CHECK 或计算列引用，只做安全数值/字符串互转避免表达式类型不兼容
        const inExpr =
          E.childrenOf(m, t.id, 'check').some((ck) => E.mssqlExprReferences(ck.expr, c.name)) ||
          E.columnsOf(m, t.id).some(
            (col) => col.generated && E.mssqlExprReferences(col.generated.expr, c.name),
          );
        if (inExpr) return false;
        const pool = keyCols.has(c.id) ? MSSQL_INDEXABLE_TYPES : ALL_TYPES;
        const ty = pick(pool, r)!;
        E.setColumnType(m, c.id, ty);
        if (c.default) E.setDefault(m, c.id, { expr: pick(DEFAULTS_BY_TYPE[ty]!, r)! });
        return true;
      }
      case 10: {
        // 切换 NOT NULL 或 DEFAULT（并刷新派生默认约束名）
        const t = pick(tables, r);
        if (!t) return false;
        const candidates = E.columnsOf(m, t.id).filter((c) => !c.generated && !c.ext?.mssql?.identity);
        const c = pick(candidates, r);
        if (!c) return false;
        if (r() < 0.5) {
          E.setNotNull(m, c.id, !c.notNull);
        } else {
          const defVal = c.default ? null : { expr: pick(DEFAULTS_BY_TYPE[c.type] ?? ['0'], r)! };
          E.setDefault(m, c.id, defVal);
          E.refreshDerivedNames(m, t.id);
        }
        return true;
      }
      case 11: {
        // 添加 UNIQUE 约束
        const t = pick(tables, r);
        if (!t) return false;
        const c = pick(
          E.columnsOf(m, t.id).filter((x) => !x.generated && isIndexable(x.type)),
          r,
        );
        if (!c) return false;
        if (E.childrenOf(m, t.id, 'unique').some((u) => u.columns.length === 1 && u.columns[0] === c.id)) {
          return false;
        }
        E.addUnique(m, t.id, [c.id]);
        return true;
      }
      case 12: {
        // 添加 CHECK 约束
        const t = pick(tables, r);
        if (!t) return false;
        const c = pick(
          E.columnsOf(m, t.id).filter(
            (x) => !x.generated && (x.type === 'int' || x.type === 'bigint' || x.type.startsWith('nvarchar')),
          ),
          r,
        );
        if (!c) return false;
        const expr = c.type.startsWith('nvarchar')
          ? `LEN(${E.mssqlIdent(c.name)}) >= 0`
          : `${E.mssqlIdent(c.name)} >= -1000000`;
        E.addCheck(m, t.id, expr);
        return true;
      }
      case 13: {
        // 添加外键（同类型指向目标表主键，无环防多路径 CASCADE 报错）
        const t = pick(tables, r);
        const ref = pick(tables, r);
        if (!t || !ref || wouldCreateFkCycle(m, t.id, ref.id)) return false;
        const refPk = E.childrenOf(m, ref.id, 'primaryKey')[0];
        if (!refPk || refPk.columns.length !== 1) return false;
        const refCol = E.get(m, refPk.columns[0]!, 'column');
        const col = E.columnsOf(m, t.id).find(
          (c) => !c.generated && c.type === refCol.type && !c.ext?.mssql?.identity,
        );
        if (!col) return false;
        const onDelete: E.FkAction = r() < 0.7 ? 'noAction' : col.notNull ? 'noAction' : 'setNull';
        E.addForeignKey(m, t.id, [col.id], ref.id, [refCol.id], { onDelete, onUpdate: 'noAction' });
        return true;
      }
      case 14: {
        // 添加索引（含 DESC / INCLUDE / WHERE 过滤索引 / FILLFACTOR / 可选 CLUSTERED）
        const t = pick(tables, r);
        if (!t) return false;
        const cols = E.columnsOf(m, t.id);
        const c = pick(
          cols.filter((x) => !x.generated && isIndexable(x.type)),
          r,
        );
        if (!c) return false;
        const inc = cols.find((x) => x.id !== c.id && !x.generated);
        const hasClustered =
          E.childrenOf(m, t.id, 'primaryKey').some((pk) => E.isMssqlPkClustered(m, pk)) ||
          E.childrenOf(m, t.id, 'unique').some((u) => u.ext?.mssql?.clustered) ||
          E.childrenOf(m, t.id, 'index').some((ix) => ix.ext?.mssql?.clustered);
        const makeClustered = !hasClustered && r() < 0.3;
        const useFilter = !makeClustered && r() < 0.35;
        const ext: E.IndexExt | undefined =
          makeClustered || r() < 0.3
            ? {
                mssql: {
                  ...(makeClustered ? { clustered: true } : {}),
                  ...(r() < 0.4 ? { fillFactor: 80 } : {}),
                },
              }
            : undefined;
        E.addIndex(m, t.id, [{ column: c.id, desc: r() < 0.4 }], {
          unique: r() < 0.3,
          include: !makeClustered && inc && r() < 0.4 ? [inc.id] : [],
          where: useFilter ? `${E.mssqlIdent(c.name)} IS NOT NULL` : null,
          ...(ext ? { ext } : {}),
        });
        return true;
      }
      case 15: {
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
      case 16: {
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
        E.renameKey(m, k.id, identArb('K', r));
        return true;
      }
      case 17: {
        // 新建/修改/删除序列
        const seqs = E.all(m, 'sequence');
        if (seqs.length === 0 || (seqs.length < 2 && r() < 0.6)) {
          const sch = pick(schemas, r)!;
          E.createSequence(m, sch.id, identArb('seq', r), {
            type: r() < 0.5 ? 'bigint' : 'integer',
            increment: r() < 0.5 ? '1' : '5',
            cache: r() < 0.5 ? '1' : '10',
            cycle: r() < 0.3,
          });
          return true;
        }
        const s = pick(seqs, r)!;
        if (r() < 0.5) {
          E.renameSequence(m, s.id, identArb('seq', r));
        } else {
          E.dropSequence(m, s.id);
        }
        return true;
      }
      case 18: {
        // 设置或清除表/列注释（MS_Description）
        const t = pick(tables, r);
        if (!t) return false;
        if (r() < 0.5) {
          E.setComment(m, t.id, t.comment ? null : `表注释 ${Math.floor(r() * 100)}`);
        } else {
          const c = pick(E.columnsOf(m, t.id), r);
          if (!c) return false;
          E.setComment(m, c.id, c.comment ? null : `列注释 ${Math.floor(r() * 100)}`);
        }
        return true;
      }
      case 19: {
        // 修改非 dbo 的用户 schema 名（触发 CREATE SCHEMA + TRANSFER + DROP SCHEMA）
        if (!allowSchemaOps) return false;
        const userSchemas = schemas.filter((s) => s.name.toLowerCase() !== 'dbo');
        const s = pick(userSchemas, r);
        if (!s) return false;
        E.renameSchema(m, s.id, identArb('sch', r));
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
};

export const buildMssqlPair = (
  seed: number,
  initOps: number,
  diffOps: number,
): { from: Model; to: Model } => {
  const r = makeMssqlPrng(seed);
  const from = emptyModel('mssql');
  E.createSchema(from, 'dbo');
  for (let i = 0; i < initOps; i++) {
    const snap = structuredClone(from);
    if (!mutateMssql(from, r) || validate(from).length > 0) {
      from.objects = snap.objects;
    }
  }
  const to = structuredClone(from);
  for (let i = 0; i < diffOps; i++) {
    const snap = structuredClone(to);
    if (!mutateMssql(to, r) || validate(to).length > 0) {
      to.objects = snap.objects;
    }
  }
  return { from, to };
};
