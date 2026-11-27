// SQL Server 持久化计算列的可空性：显式声明与引擎推断分开存（ADR 0019）。
// - `notNull`：只表示用户显式写了 `PERSISTED NOT NULL`，生成 DDL 只看它；
// - `ext.mssql.inferredNotNull`：引擎按表达式推断出的非空（影子库规范化写回，用户不可编辑，从不渲染进 DDL）；
// - 有效可空性 = 两者之一为真，规划器与读回比较都按它比较。
// 非持久化计算列在 SQL Server 上不能声明 NOT NULL，读回也按可空处理；普通列只有 `notNull`。
import type { Column, Dialect } from '../ir.ts';

/** 是否为 SQL Server 持久化计算列（只有它区分显式与推断的非空） */
export const isMssqlPersistedComputed = (c: Column): boolean => Boolean(c.generated?.stored);

/** 引擎推断出的非空（只对持久化计算列有意义；其他列上即使带着这个标记也忽略） */
export const mssqlInferredNotNull = (c: Column): boolean =>
  isMssqlPersistedComputed(c) && c.ext?.mssql?.inferredNotNull === true;

/** SQL Server 列的有效非空：持久化计算列 = 显式 || 推断；非持久化计算列恒为可空；普通列 = notNull */
export const mssqlEffectiveNotNull = (c: Column): boolean => {
  if (!c.generated) return c.notNull;
  if (!c.generated.stored) return false;
  return c.notNull || mssqlInferredNotNull(c);
};

/** 按方言取列的有效非空（界面徽标、主键校验等只关心“实际是否可空”的地方用它；DDL 渲染只看显式 notNull） */
export const effectiveNotNull = (dialect: Dialect, c: Column): boolean =>
  dialect === 'mssql' ? mssqlEffectiveNotNull(c) : c.notNull;

/**
 * 原地设置 / 清除 `ext.mssql.inferredNotNull`：为 false 时删掉这个键，并收掉因此变空的 `ext.mssql` / `ext`
 * （没有这个键的列保持原样，避免规范化写回产生无意义的差异）。
 */
export const setMssqlInferredNotNull = (c: Column, inferred: boolean): void => {
  if (inferred) {
    c.ext = { ...c.ext, mssql: { ...c.ext?.mssql, inferredNotNull: true } };
    return;
  }
  const mssql = c.ext?.mssql;
  if (!mssql || !('inferredNotNull' in mssql)) return;
  const { inferredNotNull: _drop, ...rest } = mssql;
  const ext = { ...c.ext };
  if (Object.keys(rest).length > 0) ext.mssql = rest;
  else delete ext.mssql;
  if (Object.keys(ext).length > 0) c.ext = ext;
  else delete c.ext;
};

/** 去掉客户端传入的 `inferredNotNull`（派生字段，只由影子库规范化写回），返回新对象，不改入参 */
export const stripMssqlInferredNotNull = <T extends Column['ext']>(ext: T): T => {
  if (!ext?.mssql || !('inferredNotNull' in ext.mssql)) return ext;
  const { inferredNotNull: _drop, ...rest } = ext.mssql;
  return { ...ext, mssql: rest } as T;
};

/** 给 MCP / AI 调用方的 notNull 语义说明（宏参数描述用） */
export const MSSQL_NOT_NULL_NOTE =
  'Explicit NOT NULL only. SQL Server PERSISTED computed columns: `notNull` is the explicit `PERSISTED NOT NULL` declaration; a column the engine infers as non-null from its expression keeps `notNull: false` and reports read-only `ext.mssql.inferredNotNull: true` (never rendered into DDL). Effective nullability is `notNull || ext.mssql.inferredNotNull`.';
