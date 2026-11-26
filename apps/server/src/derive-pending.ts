// 派生数据的“待规范化”判定（纯函数，0 影子库 I/O）：derive.ts 的 flush / status、shadow.ts 的 canonicalize 共用。
// 基线（branches.baseline）是一份“确定已在影子库里规范化过”的模型；当前模型相对基线有下列变化的对象才需要回影子库：
// - 不透明对象：依赖或所在父对象改了名；引用列（直接依赖的列，或依赖表里的列）的类型 / 枚举引用 / 排序规则变了；DDL 文本变了；
// - 带表达式的普通对象（CHECK、默认值、生成列、表达式索引、分区键 / 分区边界）：表达式变了，
//   或同一张表里已有列的类型 / 枚举引用 / 排序规则变了（引擎读回的规范形式可能跟着变，如加上的类型转换）。
import { deepEqual, type Model, type Obj } from '@dowel/core';

/** 对象的完整限定名（沿 parent 链拼接），用于判断是否改了名 */
export const fullName = (m: Model, id: string): string | null => {
  const parts: string[] = [];
  for (let o: Obj | undefined = m.objects[id], i = 0; o && i < 5; i++) {
    parts.unshift(o.name);
    o = 'parent' in o ? m.objects[o.parent] : undefined;
  }
  return parts.length ? parts.join('.') : null;
};

/** 对象里需要规范化的表达式（没有则为 null） */
export const exprsOf = (o: Obj | undefined): unknown => {
  if (!o) return null;
  switch (o.kind) {
    case 'table': {
      const partExprs =
        o.partitionBy && typeof o.partitionBy !== 'string' && o.partitionBy.keys.some((k) => k.expr)
          ? o.partitionBy.keys.map((k) => k.expr)
          : null;
      const bound = o.partitionOf?.bound ?? null;
      return partExprs || bound !== null ? [partExprs, bound] : null;
    }
    case 'check':
      return o.expr;
    case 'index':
      return o.elements.some((e) => e.expr) || o.where ? [o.elements.map((e) => e.expr), o.where] : null;
    case 'column':
      return o.generated || (o.default && 'expr' in o.default) ? [o.generated, o.default] : null;
    case 'opaque':
      return o.ddl;
    default:
      return null;
  }
};

/** 新旧两边都存在的列：类型、枚举引用或排序规则变了 */
const columnTypeChanged = (base: Model, cur: Model, id: string): boolean => {
  const a = base.objects[id];
  const b = cur.objects[id];
  if (a?.kind !== 'column' || b?.kind !== 'column') return false;
  return a.type !== b.type || a.typeRef !== b.typeRef || a.collation !== b.collation;
};

/** 一份“空基线”：没有任何对象，相当于从零规范化整个模型 */
export const emptyBaseline = (cur: Model): Model => ({ ...cur, objects: {} });

/**
 * 当前模型相对基线需要回影子库规范化的对象 ID（按模型里的顺序）。
 * base 为 null 表示还没有基线：按空基线计算（所有带表达式的对象都待规范化）。
 */
export const pendingRefreshIds = (baseline: Model | null, cur: Model): string[] => {
  const base = baseline ?? emptyBaseline(cur);
  const renamed = (id: string) => {
    const x = fullName(base, id);
    const y = fullName(cur, id);
    return x !== null && y !== null && x !== y;
  };
  // 表 → 当前模型中它的列（只在需要时建一次）
  let columnsByTable: Map<string, string[]> | null = null;
  const columnsOf = (tableId: string): string[] => {
    if (!columnsByTable) {
      columnsByTable = new Map();
      for (const o of Object.values(cur.objects)) {
        if (o.kind !== 'column') continue;
        const list = columnsByTable.get(o.parent);
        if (list) list.push(o.id);
        else columnsByTable.set(o.parent, [o.id]);
      }
    }
    return columnsByTable.get(tableId) ?? [];
  };
  const tableColsChanged = new Map<string, boolean>();
  const anyColumnChanged = (tableId: string): boolean => {
    let v = tableColsChanged.get(tableId);
    if (v === undefined) {
      v = columnsOf(tableId).some((c) => columnTypeChanged(base, cur, c));
      tableColsChanged.set(tableId, v);
    }
    return v;
  };
  /** 表达式所在的表：列 / CHECK / 索引是 parent，表就是自己 */
  const tableOf = (o: Obj): string | null => {
    if (o.kind === 'table') return o.id;
    if (o.kind === 'column' || o.kind === 'check' || o.kind === 'index') return o.parent;
    return null;
  };

  const out: string[] = [];
  for (const o of Object.values(cur.objects)) {
    if (o.kind === 'opaque') {
      const deps = [...o.deps, o.parent];
      const pending =
        deps.some(renamed) ||
        o.deps.some((d) => {
          const dep = cur.objects[d];
          if (dep?.kind === 'column') return columnTypeChanged(base, cur, d);
          if (dep?.kind === 'table') return anyColumnChanged(d);
          return false;
        }) ||
        !deepEqual(exprsOf(o), exprsOf(base.objects[o.id]));
      if (pending) out.push(o.id);
      continue;
    }
    const e = exprsOf(o);
    if (e === null) continue;
    if (!deepEqual(e, exprsOf(base.objects[o.id]))) {
      out.push(o.id);
      continue;
    }
    const t = tableOf(o);
    if (t !== null && anyColumnChanged(t)) out.push(o.id);
  }
  return out;
};

/** 当前模型相对基线是否存在待规范化的表达式或依赖变化的不透明对象 */
export const needsRefresh = (baseline: Model | null, cur: Model): boolean =>
  pendingRefreshIds(baseline, cur).length > 0;

/**
 * next 中是否有不透明对象的依赖 / 父对象相对 prev 改了名：这种情况必须从 prev 增量迁移（让引擎改写 DDL 里的引用），
 * 不能直接从空库建出 next（next 里的不透明对象 DDL 还引用着旧名字）。
 */
export const hasRenamedOpaqueDeps = (prev: Model, next: Model): boolean => {
  const renamed = (id: string) => {
    const x = fullName(prev, id);
    const y = fullName(next, id);
    return x !== null && y !== null && x !== y;
  };
  return Object.values(next.objects).some((o) => o.kind === 'opaque' && [...o.deps, o.parent].some(renamed));
};
