// 版本树（ADR 0013）：版本号唯一递增、parent 指向更早的版本；从根到最大编号版本的唯一路径是活跃主链，
// 其余岔路（已作废的链尾）自动识别为已作废。平台库、目标库历史、接手合并共用这一套纯函数。
// 只依赖 { id, number, parentId }，不读任何库。

export interface TreeNode {
  id: string;
  number: number;
  parentId: string | null;
}

/** 按 id 建索引 */
export const indexTree = <T extends TreeNode>(nodes: readonly T[]): Map<string, T> =>
  new Map(nodes.map((n) => [n.id, n]));

/** 编号最大的版本（全局最大编号；空返回 null） */
export const maxNumberNode = <T extends TreeNode>(nodes: readonly T[]): T | null => {
  let best: T | null = null;
  for (const n of nodes) if (!best || n.number > best.number) best = n;
  return best;
};

/**
 * 从根到 id 的路径（含两端，根在前）。parent 缺失或成环时返回 null（调用方应先过 verifyChain）。
 */
export const pathFromRoot = <T extends TreeNode>(byId: ReadonlyMap<string, T>, id: string): T[] | null => {
  const out: T[] = [];
  const seen = new Set<string>();
  let cur: T | undefined = byId.get(id);
  while (cur) {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    out.push(cur);
    if (cur.parentId === null) return out.reverse();
    cur = byId.get(cur.parentId);
  }
  return null;
};

/**
 * 活跃主链：从根到全局最大编号版本的唯一路径（按 number 升序）。没有版本时为空数组。
 * 只适用于“根到最大编号即活跃主链”的场景（目标库历史、接手合并）；平台库以 retired_at 为准
 * （两者在平台库上是一致的：作废只摘链尾，取消作废只接回到达全局最大编号的整段）。
 */
export const activePath = <T extends TreeNode>(nodes: readonly T[]): T[] => {
  const head = maxNumberNode(nodes);
  if (!head) return [];
  return pathFromRoot(indexTree(nodes), head.id) ?? [];
};

/** 不在活跃主链上的版本 id（自动识别为已作废） */
export const offPathIds = <T extends TreeNode>(nodes: readonly T[]): Set<string> => {
  const active = new Set(activePath(nodes).map((n) => n.id));
  return new Set(nodes.filter((n) => !active.has(n.id)).map((n) => n.id));
};

/** a 是不是 b 的祖先（含 a === b） */
export const isAncestor = <T extends TreeNode>(
  byId: ReadonlyMap<string, T>,
  a: string,
  b: string,
): boolean => {
  const p = pathFromRoot(byId, b);
  return p !== null && p.some((n) => n.id === a);
};

export interface TreeRoute<T extends TreeNode> {
  /** 最近公共祖先；from 为空（还没有执行过任何版本）时为 null */
  lca: T | null;
  /** 回滚段：从 from 往回到 lca（不含 lca），按执行顺序（编号从大到小）；每一项执行它自己的回滚脚本 */
  down: T[];
  /** 升级段：从 lca 之后到 to（含 to），按执行顺序（编号从小到大）；每一项执行它自己的升级脚本 */
  up: T[];
}

/**
 * 从 from 到 to 的路线（沿 parent_id 经最近公共祖先）：先 down 再 up。
 * from 为 null 表示空库 / 还没有历史：路线是从根到 to 的全部 up。
 * 任一端不在树上（或 parent 缺失）返回 null。
 */
export const routeBetween = <T extends TreeNode>(
  byId: ReadonlyMap<string, T>,
  from: string | null,
  to: string,
): TreeRoute<T> | null => {
  const toPath = pathFromRoot(byId, to);
  if (!toPath) return null;
  if (from === null) return { lca: null, down: [], up: toPath };
  const fromPath = pathFromRoot(byId, from);
  if (!fromPath) return null;
  let i = 0;
  while (i < fromPath.length && i < toPath.length && fromPath[i]!.id === toPath[i]!.id) i++;
  if (i === 0) return null; // 不同的根：不是同一棵树
  return {
    lca: fromPath[i - 1]!,
    down: fromPath.slice(i).reverse(),
    up: toPath.slice(i),
  };
};

/** 路线的形状：none = 不用动；up / down = 单向；switch = 先回滚再升级（经最近公共祖先切换岔路） */
export type RouteShape = 'none' | 'up' | 'down' | 'switch';

export const routeShape = (r: { down: readonly unknown[]; up: readonly unknown[] }): RouteShape =>
  r.down.length && r.up.length ? 'switch' : r.down.length ? 'down' : r.up.length ? 'up' : 'none';
