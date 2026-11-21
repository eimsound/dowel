// 跨方言共享的规划步骤、规划错误与词法 Token 类型（无方言依赖，浏览器安全）。

export interface Step {
  /** 步骤种类，用于界面展示和测试 */
  kind: string;
  /** 主要涉及的对象 */
  target: string;
  sql: string;
  /**
   * 是否允许放进事务块执行：
   * - 规划器可显式给出（如 SQLite 12 步表重建含 PRAGMA foreign_keys = OFF + 显式 BEGIN/COMMIT，或 MySQL DDL）；
   * - 省略时由 isNontransactionalSql(sql, dialect) 推断。
   */
  transactional?: boolean;
}

export class PlanError extends Error {}

export type Token = { text: string; kind: 'ident' | 'qident' | 'other'; start: number; end: number };
