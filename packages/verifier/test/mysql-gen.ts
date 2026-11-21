// MySQL fast-check 随机模型生成器：覆盖建删改表/列、类型、UNSIGNED、NOT NULL、DEFAULT（含表达式/TEXT 括号默认）、
// AUTO_INCREMENT、生成列（VIRTUAL/STORED）、PK/UNIQUE/FK/CHECK、普通/唯一/前缀/降序/函数索引与注释。
import * as E from '@dowel/core';
import { emptyModel, type Model, validate } from '@dowel/core';

const MYSQL_TYPES = [
  'int',
  'bigint',
  'smallint',
  'tinyint(1)',
  'varchar(64)',
  'char(8)',
  'text',
  'decimal(10,2)',
  'double',
  'datetime',
  'timestamp',
  'json',
] as const;

const DEFAULTS_BY_TYPE: Record<string, string[]> = {
  int: ['0', '1', '-5', '42'],
  bigint: ['0', '100'],
  smallint: ['0', '7'],
  'tinyint(1)': ['0', '1'],
  'varchar(64)': ["''", "'hello'", "'a''b'"],
  'char(8)': ["'abc'", "'0000'"],
  text: ["('empty')", "('note')"],
  'decimal(10,2)': ['0.00', '12.50'],
  double: ['0', '1.5'],
  datetime: ['CURRENT_TIMESTAMP'],
  timestamp: ['CURRENT_TIMESTAMP'],
  json: ['(json_object())'],
};

const FK_ACTIONS: E.FkAction[] = ['noAction', 'restrict', 'cascade', 'setNull'];

const pick = <T>(xs: readonly T[], r: () => number): T | undefined =>
  xs.length ? xs[Math.floor(r() * xs.length)] : undefined;

const identArb = (prefix: string, r: () => number) => {
  const pool = ['a', 'b', 'c', 'order', 'group', 'status', 'rank', 'val', 'k', 'item'];
  return `${prefix}_${pick(pool, r)}_${Math.floor(r() * 50)}`;
};

export const makeMysqlPrng = (seed: number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const isIndexableMysqlType = (t: string): boolean => t !== 'text' && t !== 'json';

const isNumericIntType = (t: string): boolean => t === 'int' || t === 'bigint' || t === 'smallint';

/** 在一个合法 MySQL 模型上执行随机一步编辑，保持 validate(m) === [] */
export const mutateMysql = (m: Model, r: () => number): boolean => {
  const defSchema = E.all(m, 'schema')[0]!;
  const tables = E.all(m, 'table');
  const op = Math.floor(r() * 18);

  try {
    switch (op) {
      case 0:
      case 1: {
        // 建表（含 PK、可选 AUTO_INCREMENT、UNSIGNED、注释与 1-3 个业务列）
        if (tables.length >= 6) return false;
        const tid = E.createTable(m, defSchema.id, identArb('tbl', r));
        if (r() < 0.3) E.setComment(m, tid, `comment_${Math.floor(r() * 100)}`);
        const idType = r() < 0.5 ? 'bigint' : 'int';
        const unsigned = r() < 0.5;
        const idCol = E.addColumn(m, tid, {
          name: 'id',
          type: idType,
          notNull: true,
          ...(unsigned ? { ext: { mysql: { unsigned: true } } } : {}),
        });
        if (r() < 0.9) {
          E.addPrimaryKey(m, tid, [idCol]);
          if (r() < 0.45) {
            E.setColumnExt(m, idCol, {
              mysql: { ...(unsigned ? { unsigned: true } : {}), autoIncrement: true },
            });
          }
        }
        const extra = 1 + Math.floor(r() * 3);
        for (let i = 0; i < extra; i++) {
          const ty = pick(MYSQL_TYPES, r)!;
          const notNull = r() < 0.4;
          const useDef = r() < 0.5;
          const defVal = useDef ? { expr: pick(DEFAULTS_BY_TYPE[ty]!, r)! } : null;
          const cid = E.addColumn(m, tid, {
            name: identArb('c', r),
            type: ty,
            notNull,
            default: defVal,
            ext:
              ty === 'timestamp' && r() < 0.3
                ? { mysql: { onUpdateCurrentTimestamp: true } }
                : isNumericIntType(ty) && r() < 0.25
                  ? { mysql: { unsigned: true } }
                  : undefined,
          });
          if (r() < 0.2) E.setComment(m, cid, `col_note_${i}`);
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
        // 表改名或改表注释
        const t = pick(tables, r);
        if (!t) return false;
        if (r() < 0.7) E.renameTable(m, t.id, identArb('tbl', r));
        else E.setComment(m, t.id, t.comment ? null : `note_${Math.floor(r() * 50)}`);
        return true;
      }
      case 4:
      case 5: {
        // 新增列（普通列或 VIRTUAL/STORED 生成列）
        const t = pick(tables, r);
        if (!t) return false;
        const cols = E.columnsOf(m, t.id);
        if (cols.length >= 8) return false;
        if (r() < 0.2) {
          const base = cols.find((c) => !c.generated && (c.type === 'int' || c.type === 'varchar(64)'));
          if (!base) return false;
          const expr =
            base.type === 'varchar(64)'
              ? `char_length(${E.mysqlIdent(base.name)})`
              : `${E.mysqlIdent(base.name)} + 1`;
          E.addColumn(m, t.id, {
            name: identArb('g', r),
            type: 'int',
            generated: { expr, stored: r() < 0.5 },
          });
          return true;
        }
        const ty = pick(MYSQL_TYPES, r)!;
        const notNull = r() < 0.4;
        const defVal = r() < 0.5 ? { expr: pick(DEFAULTS_BY_TYPE[ty]!, r)! } : null;
        E.addColumn(m, t.id, {
          name: identArb('c', r),
          type: ty,
          notNull,
          default: defVal,
        });
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
        // 删列（保留至少一列）
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
      case 8: {
        // 改列类型（兼容类型，避免修改被 FK 引用的列类型导致两端不一致）
        const t = pick(tables, r);
        if (!t) return false;
        const fkCols = new Set(E.all(m, 'foreignKey').flatMap((fk) => [...fk.columns, ...fk.refColumns]));
        const candidates = E.columnsOf(m, t.id).filter(
          (c) => !c.generated && !c.ext?.mysql?.autoIncrement && !fkCols.has(c.id),
        );
        const c = pick(candidates, r);
        if (!c) return false;
        const keyCols = new Set([
          ...E.childrenOf(m, t.id, 'primaryKey').flatMap((k) => k.columns),
          ...E.childrenOf(m, t.id, 'unique').flatMap((k) => k.columns),
          ...E.childrenOf(m, t.id, 'index').flatMap((x) =>
            x.elements.flatMap((e) => (e.column ? [e.column] : [])),
          ),
        ]);
        const allowed = keyCols.has(c.id) ? MYSQL_TYPES.filter(isIndexableMysqlType) : MYSQL_TYPES;
        const ty = pick(allowed, r)!;
        E.setColumnType(m, c.id, ty);
        if (c.ext?.mysql?.unsigned || c.ext?.mysql?.onUpdateCurrentTimestamp) {
          E.setColumnExt(m, c.id, null);
        }
        if (c.default) E.setDefault(m, c.id, { expr: pick(DEFAULTS_BY_TYPE[ty]!, r)! });
        return true;
      }
      case 9: {
        // 切换 NOT NULL / DEFAULT / 注释
        const t = pick(tables, r);
        if (!t) return false;
        const candidates = E.columnsOf(m, t.id).filter((c) => !c.generated && !c.ext?.mysql?.autoIncrement);
        const c = pick(candidates, r);
        if (!c) return false;
        const roll = r();
        if (roll < 0.35) {
          // 若列被 ON DELETE/UPDATE SET NULL 外键使用则不设 NOT NULL
          const usedSetNull = E.all(m, 'foreignKey').some(
            (fk) => (fk.onDelete === 'setNull' || fk.onUpdate === 'setNull') && fk.columns.includes(c.id),
          );
          if (usedSetNull && !c.notNull) return false;
          E.setNotNull(m, c.id, !c.notNull);
        } else if (roll < 0.7) {
          const defVal = c.default ? null : { expr: pick(DEFAULTS_BY_TYPE[c.type] ?? ['0'], r)! };
          E.setDefault(m, c.id, defVal);
        } else {
          E.setComment(m, c.id, c.comment ? null : `c_${Math.floor(r() * 99)}`);
        }
        return true;
      }
      case 10: {
        // 增/删 PRIMARY KEY（联动处理 AUTO_INCREMENT）
        const t = pick(tables, r);
        if (!t) return false;
        const pks = E.childrenOf(m, t.id, 'primaryKey');
        if (pks.length > 0 && r() < 0.4) {
          for (const col of E.columnsOf(m, t.id)) {
            if (col.ext?.mysql?.autoIncrement) {
              E.setColumnExt(m, col.id, {
                mysql: { ...col.ext.mysql, autoIncrement: undefined },
              });
            }
          }
          E.dropKey(m, pks[0]!.id);
          return true;
        }
        if (pks.length === 0) {
          const c = pick(
            E.columnsOf(m, t.id).filter((x) => !x.generated && isIndexableMysqlType(x.type)),
            r,
          );
          if (!c) return false;
          E.addPrimaryKey(m, t.id, [c.id]);
          return true;
        }
        return false;
      }
      case 11: {
        // 添加 UNIQUE 约束
        const t = pick(tables, r);
        if (!t) return false;
        const c = pick(
          E.columnsOf(m, t.id).filter((x) => !x.generated && isIndexableMysqlType(x.type)),
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
        // 添加 CHECK 约束（使用 MySQL 规范反引号标识符避免漂移）
        const t = pick(tables, r);
        if (!t) return false;
        const c = pick(
          E.columnsOf(m, t.id).filter(
            (x) => !x.generated && (x.type === 'int' || x.type === 'bigint' || x.type === 'varchar(64)'),
          ),
          r,
        );
        if (!c) return false;
        const expr =
          c.type === 'varchar(64)'
            ? `char_length(${E.mysqlIdent(c.name)}) >= 0`
            : `${E.mysqlIdent(c.name)} >= -1000000`;
        E.addCheck(m, t.id, expr);
        return true;
      }
      case 13:
      case 14: {
        // 添加 FOREIGN KEY（类型与 unsigned 严格匹配目标主键列）
        const t = pick(tables, r);
        const ref = pick(tables, r);
        if (!t || !ref) return false;
        const refPk = E.childrenOf(m, ref.id, 'primaryKey')[0];
        if (!refPk || refPk.columns.length !== 1) return false;
        const refCol = E.get(m, refPk.columns[0]!, 'column');
        if (!isIndexableMysqlType(refCol.type)) return false;
        const col = E.columnsOf(m, t.id).find(
          (c) =>
            !c.generated &&
            c.type === refCol.type &&
            Boolean(c.ext?.mysql?.unsigned) === Boolean(refCol.ext?.mysql?.unsigned) &&
            c.id !== refCol.id,
        );
        if (!col) return false;
        const onDelete = pick(FK_ACTIONS, r)!;
        const onUpdate = pick(FK_ACTIONS, r)!;
        if ((onDelete === 'setNull' || onUpdate === 'setNull') && col.notNull) return false;
        E.addForeignKey(m, t.id, [col.id], ref.id, [refCol.id], { onDelete, onUpdate });
        return true;
      }
      case 15: {
        // 添加二级索引（普通/唯一/DESC/前缀长度/函数表达式索引）
        const t = pick(tables, r);
        if (!t) return false;
        const c = pick(
          E.columnsOf(m, t.id).filter((x) => !x.generated && x.type !== 'json'),
          r,
        );
        if (!c) return false;
        if (c.type === 'text') {
          E.addIndex(m, t.id, [{ column: c.id }], {
            ext: { mysql: { lengths: [32] } },
          });
          return true;
        }
        if (c.type === 'varchar(64)' && r() < 0.3) {
          E.addIndex(m, t.id, [{ expr: `lower(${E.mysqlIdent(c.name)})`, desc: r() < 0.4 }]);
          return true;
        }
        if (c.type === 'varchar(64)' && r() < 0.3) {
          E.addIndex(m, t.id, [{ column: c.id, desc: r() < 0.3 }], {
            ext: { mysql: { lengths: [16] } },
          });
          return true;
        }
        E.addIndex(m, t.id, [{ column: c.id, desc: r() < 0.4 }], { unique: r() < 0.25 });
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
        // 显式重命名约束或索引（主键在 MySQL 固定为 PRIMARY，不重命名）
        const keys = [
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

export const buildMysqlPair = (
  seed: number,
  initOps: number,
  diffOps: number,
): { from: Model; to: Model } => {
  const r = makeMysqlPrng(seed);
  const from = emptyModel('mysql');
  E.createSchema(from, 'default');
  for (let i = 0; i < initOps; i++) {
    const snap = structuredClone(from);
    if (!mutateMysql(from, r) || validate(from).length > 0) {
      from.objects = snap.objects;
    }
  }
  const to = structuredClone(from);
  for (let i = 0; i < diffOps; i++) {
    const snap = structuredClone(to);
    if (!mutateMysql(to, r) || validate(to).length > 0) {
      to.objects = snap.objects;
    }
  }
  return { from, to };
};
