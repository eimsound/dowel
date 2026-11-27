// 推导名所在的命名空间：把各方言"名字是否已被占用"的判定拆成若干个命名空间里的 (名字 → 占用者) 条目，
// 供模型索引分桶维护（O(1) 判重）与推导名引擎使用。条目语义与各方言原有的全模型扫描判定逐条一致：
// PG 见 pg/dialect.ts 的 pgRelTaken / pgConTaken / pgTypeTaken，其他方言见各自 dialect.ts 的 is*Taken。
import type { Dialect, Obj, Table } from './ir.ts';
import { mssqlDerivedNames } from './mssql/naming.ts';

/** 命名空间里的一个占用条目：name 已按方言规则归一化（PG 区分大小写，其他方言转小写） */
export interface NsEntry {
  ns: string;
  name: string;
  owner: string;
}

/** 解析表（条目依赖父表的 schema / 表名时使用）；返回 undefined 表示表不存在 */
export type TableLookup = (id: string) => Pick<Table, 'name' | 'parent'> | undefined;

/** 归一化名字：PG 标识符区分大小写，MySQL / SQLite / MSSQL 默认不区分 */
export const nsNorm = (dialect: Dialect, name: string): string =>
  dialect === 'pg' ? name : name.toLowerCase();

// 命名空间键：种类 + \0 + 容器 ID
/** PG：schema 级关系命名空间（表、序列、索引、PK / UNIQUE 背后的索引、IDENTITY 序列） */
export const pgRelNs = (schema: string) => `r\0${schema}`;
/** PG：schema 级类型命名空间（枚举、表的行类型） */
export const pgTypeNs = (schema: string) => `t\0${schema}`;
/** PG：表级全部约束（PK / UNIQUE / CHECK / FK / NOT NULL） */
export const pgAllConNs = (table: string) => `a\0${table}`;
/** PG：表级会向下继承到子分区的约束（CHECK / FK / NOT NULL） */
export const pgPropConNs = (table: string) => `p\0${table}`;
/** MySQL：全库 CHECK / FK 约束名 */
export const MYSQL_CON_NS = 'mc';
/** MySQL：表级索引名（UNIQUE / INDEX / FK 背后的索引） */
export const mysqlIdxNs = (table: string) => `mi\0${table}`;
/** MySQL：全库表 / 视图名 */
export const MYSQL_REL_NS = 'mr';
/** SQLite：全库表 / 索引 / 其他 schema 对象名 */
export const SQLITE_REL_NS = 'sr';
/** SQLite：表级约束名 */
export const sqliteConNs = (table: string) => `sc\0${table}`;
/** MSSQL：schema 级 sys.objects（表、序列、约束、带名 DEFAULT、其他对象） */
export const mssqlObjNs = (schema: string) => `mo\0${schema}`;
/** MSSQL：表级 sys.indexes（索引、PK、UNIQUE） */
export const mssqlIdxNs = (table: string) => `mx\0${table}`;
/** 各方言：表级列名（推导名引擎按名字找列，不参与任何"名字是否已占用"判定） */
export const colNs = (table: string) => `cn\0${table}`;

/**
 * 对象依赖父表属性的条目：父表换 schema（PG / MSSQL）或改名（MSSQL 推导 DEFAULT 名）时，
 * 子对象的条目都会变，增量维护需要整体重建。
 */
export const nsDependsOnTable = (dialect: Dialect, prev: Table, next: Table): boolean => {
  if (dialect === 'pg') return prev.parent !== next.parent;
  if (dialect === 'mssql') return prev.parent !== next.parent || prev.name !== next.name;
  return false;
};

/** 一个对象贡献的全部占用条目（追加到 out） */
export const nameEntriesOf = (dialect: Dialect, o: Obj, tableOf: TableLookup, out: NsEntry[]): void => {
  const push = (ns: string, name: string | null | undefined, owner: string) => {
    if (typeof name === 'string' && name !== '') out.push({ ns, name: nsNorm(dialect, name), owner });
  };
  if (o.kind === 'column') push(colNs(o.parent), o.name, o.id);
  switch (dialect) {
    case 'pg':
      switch (o.kind) {
        case 'table':
          push(pgRelNs(o.parent), o.name, o.id);
          push(pgTypeNs(o.parent), o.name, o.id);
          return;
        case 'enum':
          push(pgTypeNs(o.parent), o.name, o.id);
          return;
        case 'sequence':
          push(pgRelNs(o.parent), o.name, o.id);
          return;
        case 'index': {
          const t = tableOf(o.parent);
          if (t) push(pgRelNs(t.parent), o.name, o.id);
          return;
        }
        case 'primaryKey':
        case 'unique': {
          const t = tableOf(o.parent);
          if (t) push(pgRelNs(t.parent), o.name, o.id);
          push(pgAllConNs(o.parent), o.name, o.id);
          return;
        }
        case 'check':
        case 'foreignKey':
          push(pgAllConNs(o.parent), o.name, o.id);
          push(pgPropConNs(o.parent), o.name, o.id);
          return;
        case 'column':
          if (o.identity) {
            const t = tableOf(o.parent);
            if (t) push(pgRelNs(t.parent), o.identity.sequenceName, `${o.id}#seq`);
          }
          if (o.notNull && o.notNullName) {
            push(pgAllConNs(o.parent), o.notNullName, `${o.id}#nn`);
            push(pgPropConNs(o.parent), o.notNullName, `${o.id}#nn`);
          }
          return;
        default:
          return;
      }
    case 'mysql':
      switch (o.kind) {
        case 'table':
          push(MYSQL_REL_NS, o.name, o.id);
          return;
        case 'opaque':
          if (o.objType === 'view') push(MYSQL_REL_NS, o.name, o.id);
          return;
        case 'unique':
        case 'index':
          push(mysqlIdxNs(o.parent), o.name, o.id);
          return;
        case 'foreignKey':
          push(mysqlIdxNs(o.parent), o.name, o.id);
          push(MYSQL_CON_NS, o.name, o.id);
          return;
        case 'check':
          push(MYSQL_CON_NS, o.name, o.id);
          return;
        default:
          return;
      }
    case 'sqlite':
      switch (o.kind) {
        case 'table':
        case 'index':
        case 'opaque':
          push(SQLITE_REL_NS, o.name, o.id);
          return;
        case 'primaryKey':
        case 'unique':
        case 'check':
        case 'foreignKey':
          push(sqliteConNs(o.parent), o.name, o.id);
          return;
        default:
          return;
      }
    case 'mssql':
      switch (o.kind) {
        case 'table':
        case 'sequence':
          push(mssqlObjNs(o.parent), o.name, o.id);
          return;
        case 'primaryKey':
        case 'unique': {
          const t = tableOf(o.parent);
          if (t) push(mssqlObjNs(t.parent), o.name, o.id);
          push(mssqlIdxNs(o.parent), o.name, o.id);
          return;
        }
        case 'foreignKey':
        case 'check': {
          const t = tableOf(o.parent);
          if (t) push(mssqlObjNs(t.parent), o.name, o.id);
          return;
        }
        case 'index':
          push(mssqlIdxNs(o.parent), o.name, o.id);
          return;
        case 'column': {
          if (!o.default) return;
          const t = tableOf(o.parent);
          if (t)
            push(
              mssqlObjNs(t.parent),
              o.ext?.mssql?.defaultName ?? mssqlDerivedNames.default(t.name, o.name),
              `${o.id}#df`,
            );
          return;
        }
        case 'opaque': {
          // 父对象是 schema 时直接归属它；父对象是表时归属表所在 schema（tableOf 只解析表）
          const t = tableOf(o.parent);
          if (t) push(mssqlObjNs(t.parent), o.name, o.id);
          else push(mssqlObjNs(o.parent), o.name, o.id);
          return;
        }
        default:
          return;
      }
  }
};
