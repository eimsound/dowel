// 派生数据的“待规范化”判定（纯函数，0 影子库 I/O）：derive.ts 的 flush / status、shadow.ts 的 canonicalize 共用。
// 基线（branches.baseline）是一份“确定已在影子库里规范化过”的模型；当前模型相对基线有下列变化的对象才需要回影子库：
// - 带表达式的普通对象（CHECK、默认值、生成列、表达式索引、分区键表达式 / 分区边界）：表达式变了；
//   或所在表的列上下文变了（引擎读回的规范形式可能跟着变，如加上的类型转换）。表达式按列名引用列，
//   所以按列名对齐基线与当前模型的列：某个两边都有的列名，对应列的类型 / 枚举引用 / 排序规则不同就算变了
//   （同表列改类型，也包括列名对调、删列后新建同名列，#133）；只在一边出现的列名（新增 / 删除 / 改名到新名字）不算。
//   分区子表没有自己的列，沿 partitionOf 用根父表的列（两个模型各自解析根表，覆盖多级分区与 attach / detach，#134）。
//   列自己的默认值 / 生成列另外按 ID 比较列自身的类型（列改名的同时改类型时，按名字对不上）。
//   列签名含枚举的完整限定名（两个枚举对调名字时 typeRef 不变、表达式里的类型名却换了绑定）；
//   只有分区边界、没有表达式分区键的表不看列上下文：边界只取决于分区键列的类型，而分区键引用的列不能改类型 / 删除；
//   但子分区改挂到另一个分区父表下时算变化。
// - 不透明对象：依赖或所在父对象改了名；deps 集合变了；依赖的列（按 ID，及按它在表里的列名对齐）或依赖 / 父对象表的
//   列上下文变了；DDL 文本变了；或依赖的不透明对象本身待规范化（视图叠视图，沿依赖传递，带环保护，#136）。
import { deepEqual, type Model, type Obj, rootTableId } from '@dowel/core';

type Column = Extract<Obj, { kind: 'column' }>;
type Table = Extract<Obj, { kind: 'table' }>;

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

/** 表是否有表达式分区键（与 exprsOf 的判断一致） */
const hasPartitionExprs = (o: Table): boolean =>
  !!o.partitionBy && typeof o.partitionBy !== 'string' && o.partitionBy.keys.some((k) => k.expr);

/**
 * 列的类型上下文：类型、枚举引用（ID 与完整限定名：枚举 / 所在 schema 改名时规范形式里的类型名跟着变）、排序规则；
 * withName 时再带上列名原文（大小写不敏感的方言按折叠后的名字对齐，只改大小写时读回的引用写法可能跟着变）。
 */
const colSig = (m: Model, c: Column, withName = false): string =>
  JSON.stringify([
    c.type,
    c.typeRef,
    c.typeRef ? fullName(m, c.typeRef) : null,
    c.collation,
    withName ? c.name : null,
  ]);

/** 新旧两边都存在的同一列（按 ID）：类型、枚举引用或排序规则变了（不看列名：只改名不影响列自身的默认值） */
const columnTypeChanged = (base: Model, cur: Model, id: string): boolean => {
  const a = base.objects[id];
  const b = cur.objects[id];
  if (a?.kind !== 'column' || b?.kind !== 'column') return false;
  return colSig(base, a) !== colSig(cur, b);
};

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/** 一份“空基线”：没有任何对象，相当于从零规范化整个模型 */
export const emptyBaseline = (cur: Model): Model => ({ ...cur, objects: {} });

/** 方言里列名是否大小写不敏感（与 checkExprColumns 一致） */
const caseInsensitive = (m: Model) =>
  m.dialect === 'sqlite' || m.dialect === 'mysql' || m.dialect === 'mssql';

/**
 * 一个模型里“表 → 列名 → 列类型上下文”的惰性索引：表沿 partitionOf 解析到根父表；
 * 同一个（折叠大小写后的）列名对应多列时把它们的签名排序拼起来（只会更容易判为变化）。
 */
const columnContext = (m: Model) => {
  let byTable: Map<string, Column[]> | null = null;
  const byRoot = new Map<string, Map<string, string>>();
  const ci = caseInsensitive(m);
  const fold = ci ? (n: string) => n.toLowerCase() : (n: string) => n;
  const sigs = (tableId: string): Map<string, string> => {
    const root = rootTableId(m, tableId);
    let out = byRoot.get(root);
    if (out) return out;
    if (!byTable) {
      byTable = new Map();
      for (const o of Object.values(m.objects)) {
        if (o.kind !== 'column') continue;
        const list = byTable.get(o.parent);
        if (list) list.push(o);
        else byTable.set(o.parent, [o]);
      }
    }
    const grouped = new Map<string, string[]>();
    for (const c of byTable.get(root) ?? []) {
      const k = fold(c.name);
      const list = grouped.get(k);
      const sig = colSig(m, c, ci);
      if (list) list.push(sig);
      else grouped.set(k, [sig]);
    }
    out = new Map([...grouped].map(([k, v]) => [k, v.sort().join('|')]));
    byRoot.set(root, out);
    return out;
  };
  return { sigs, fold };
};

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
  const baseCtx = columnContext(base);
  const curCtx = columnContext(cur);
  // 表（各自解析到根父表）的列上下文是否变了：两边都有的列名，签名不同
  const tableChanged = new Map<string, boolean>();
  const tableCtxChanged = (tableId: string): boolean => {
    let v = tableChanged.get(tableId);
    if (v === undefined) {
      const a = baseCtx.sigs(tableId);
      v = false;
      for (const [name, sig] of curCtx.sigs(tableId)) {
        const old = a.get(name);
        if (old !== undefined && old !== sig) {
          v = true;
          break;
        }
      }
      tableChanged.set(tableId, v);
    }
    return v;
  };
  // 不透明对象依赖的某一列：按 ID 变了类型，或按它现在的列名在所在（根）表里对应的列换了类型上下文
  const depColumnChanged = (col: Column): boolean => {
    if (columnTypeChanged(base, cur, col.id)) return true;
    const k = curCtx.fold(col.name);
    const old = baseCtx.sigs(col.parent).get(k);
    return old !== undefined && old !== curCtx.sigs(col.parent).get(k);
  };
  /** 子分区挂到了另一个分区父表下（边界原文可能不变，但它按新父表的分区键解释） */
  const partitionParentChanged = (o: Table): boolean => {
    const was = base.objects[o.id];
    return (
      was?.kind === 'table' &&
      !!was.partitionOf &&
      !!o.partitionOf &&
      was.partitionOf.parent !== o.partitionOf.parent
    );
  };
  /** 表达式按列名引用的那张表：CHECK / 索引 / 列是 parent；有表达式分区键的表是自己；否则不看列上下文 */
  const tableOf = (o: Obj): string | null => {
    if (o.kind === 'table') return hasPartitionExprs(o) ? o.id : null;
    if (o.kind === 'column' || o.kind === 'check' || o.kind === 'index') return o.parent;
    return null;
  };

  const pending = new Set<string>();
  const opaques: Extract<Obj, { kind: 'opaque' }>[] = [];
  for (const o of Object.values(cur.objects)) {
    if (o.kind === 'opaque') {
      opaques.push(o);
      const deps = [...o.deps, o.parent];
      const was = base.objects[o.id];
      const direct =
        // 依赖换了对象（如 attach / detach 把列依赖改指根父表列 / 物化出的新列）：引用的名字可能跟着变
        (was?.kind === 'opaque' && !sameSet(was.deps, o.deps)) ||
        deps.some(renamed) ||
        deps.some((d) => {
          const dep = cur.objects[d];
          if (dep?.kind === 'column') return depColumnChanged(dep);
          if (dep?.kind === 'table') return tableCtxChanged(d);
          return false;
        }) ||
        !deepEqual(exprsOf(o), exprsOf(base.objects[o.id]));
      if (direct) pending.add(o.id);
      continue;
    }
    const e = exprsOf(o);
    if (e === null) continue;
    if (!deepEqual(e, exprsOf(base.objects[o.id]))) {
      pending.add(o.id);
      continue;
    }
    if (
      (o.kind === 'column' && columnTypeChanged(base, cur, o.id)) ||
      (o.kind === 'table' && partitionParentChanged(o))
    ) {
      pending.add(o.id);
      continue;
    }
    const t = tableOf(o);
    if (t !== null && tableCtxChanged(t)) pending.add(o.id);
  }

  // 依赖传递：上游不透明对象待规范化，依赖它（deps 或 parent）的下游不透明对象也待规范化。
  // 集合只增不减，每个对象最多入队一次，环状依赖自然终止。
  const dependents = new Map<string, string[]>();
  for (const o of opaques) {
    for (const d of new Set([...o.deps, o.parent])) {
      if (cur.objects[d]?.kind !== 'opaque') continue;
      const list = dependents.get(d);
      if (list) list.push(o.id);
      else dependents.set(d, [o.id]);
    }
  }
  const queue = opaques.filter((o) => pending.has(o.id)).map((o) => o.id);
  while (queue.length) {
    for (const id of dependents.get(queue.pop()!) ?? []) {
      if (pending.has(id)) continue;
      pending.add(id);
      queue.push(id);
    }
  }

  return Object.keys(cur.objects).filter((id) => pending.has(id));
};

/** 当前模型相对基线是否存在待规范化的表达式或依赖变化的不透明对象 */
export const needsRefresh = (baseline: Model | null, cur: Model): boolean =>
  pendingRefreshIds(baseline, cur).length > 0;

/**
 * next 中是否有不透明对象的依赖 / 父对象相对 prev 改了名：这种情况必须从 prev 增量迁移（让引擎改写 DDL 里的引用），
 * 不能直接从空库建出 next（next 里的不透明对象 DDL 还引用着旧名字）。
 * 只看直接依赖：每个对象的 DDL 只写着它直接引用的名字，上游改名不会让下游 DDL 里的文本过期。
 */
export const hasRenamedOpaqueDeps = (prev: Model, next: Model): boolean => {
  const renamed = (id: string) => {
    const x = fullName(prev, id);
    const y = fullName(next, id);
    return x !== null && y !== null && x !== y;
  };
  return Object.values(next.objects).some((o) => o.kind === 'opaque' && [...o.deps, o.parent].some(renamed));
};
