// 空库模型：表示“项目 schema 范围内的一个全新数据库”。冻结 v0 基线（服务端）、第一次执行时判断
// “这个库是不是空库”（执行器）都用同一份。纯函数。
import { createSchema } from './edit.ts';
import { emptyModel, type Model } from './ir.ts';

/** 项目的 schema 范围是否覆盖 public（null / 空表示全部） */
export const scopeCoversPublic = (scope: string[] | null | undefined): boolean =>
  !scope?.length || scope.includes('public');

/** 目标模型里没有 public 时，空库模型里 public 的 ID：固定值，不随机（只出现在内存里的空库模型，不入库） */
const EMPTY_PUBLIC_ID = 'dowel:empty-database:public';

/**
 * 空库的模型：表示“范围内的一个全新数据库”。全新的 PG 库本来就有 public，所以**由项目的 schema 范围决定**：
 * - 范围覆盖 public（scope 为 null，或包含 'public'）：空库模型带 public——目标模型里有 public 就沿用它的 ID
 *   （两边是同一个对象，迁移不建也不删），没有就用固定的 ID（用户把 public 删了，迁移要 DROP SCHEMA public；
 *   ID 固定，回填、重新验证、预览每次算出来的结果都一样）；
 * - 范围不含 public（例如 ['app']）：public 在范围之外，Dowel 不碰，空库模型里不放它，
 *   冻结的迁移里不会出现 CREATE / DROP SCHEMA public。
 */
export const emptyBase = (like: Model, scope: string[] | null | undefined): Model => {
  const m = emptyModel();
  if (!scopeCoversPublic(scope)) return m;
  const pub = Object.values(like.objects).find((o) => o.kind === 'schema' && o.name === 'public');
  createSchema(m, 'public', pub?.id ?? EMPTY_PUBLIC_ID);
  return m;
};
