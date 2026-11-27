// 派生数据的“待规范化”判定（纯函数，0 影子库 I/O）：derive.ts 的 flush / status、shadow.ts 的 canonicalize 共用。
// 基线（branches.baseline）是一份“确定已在影子库里规范化过”的模型；当前模型相对基线有下列变化的对象才需要回影子库：
// - 带表达式的普通对象（CHECK、默认值、生成列、表达式索引、分区键表达式 / 分区边界）：表达式变了；
//   或所在表的列上下文变了（引擎读回的规范形式可能跟着变，如加上的类型转换）。表达式按列名引用列，
//   所以按列名对齐基线与当前模型的列：某个两边都有的列名，对应列的类型 / 枚举引用 / 排序规则不同就算变了
//   （同表列改类型，也包括列名对调、删列后新建同名列，#133）；只在一边出现的列名（新增 / 删除 / 改名到新名字）不算。
//   分区子表没有自己的列，沿 partitionOf 用根父表的列（两个模型各自解析根表，覆盖多级分区与 attach / detach，#134）。
//   列自己的默认值 / 生成列另外按 ID 比较列自身的类型（列改名的同时改类型时，按名字对不上）。
//   列签名含枚举的完整限定名（两个枚举对调名字时 typeRef 不变、表达式里的类型名却换了绑定）；
//   只有分区边界、没有表达式分区键的表不看自身列上下文，而是比较直接父表的分区键签名（策略、每个键的列签名或表达式、
//   opclass、collation；父表含表达式键或是解析不出来的存量字符串时再看父表的列上下文），并检查是否改挂到另一个分区父表：
//   有子分区时仍可通过 setPartitionBy 换键列，也可 detach → 取消分区 → 改列类型 → 重新分区 → attach（#134）。
// - 表达式（含不透明对象 DDL、直接父表的表达式分区键）里直接写了枚举名（如 `'ok'::mood`，所在表不一定有列引用这个枚举）：
//   相对基线有枚举的名字绑定变了（改名、对调、换 schema、删除 / 新建），且表达式文本里出现了其中某个枚举两边的名字（#146）。
//   PG 按 OID 存表达式，影子库从基线增量迁移后读回的类型名跟着 OID 走（实测：两个枚举对调名字后 public.mood 读回成
//   public.tone）；按词法粗匹配（忽略大小写，字符串字面量里的也算），只会多报。PG 只拒绝在索引 / 生成列 / 分区键
//   表达式里做运行期 enum_in / enum_out 转换（如 status::public.mood），解析期折叠的枚举常量（如 'ok'::public.mood）
//   可以出现在部分索引 WHERE、表达式索引、生成列与分区键表达式里且读回同样随 OID 变化；这些载体虽较罕见，同样会扫描。
// - MSSQL 持久化计算列：引擎按表达式与被引用列的可空性推断 is_nullable，canonicalize 会写回 notNull（shadow.ts）；
//   列自己的 notNull 变了，或所在表按列名对齐的列 notNull 变了（#145）。其他方言、非持久化计算列不看 notNull。
// - 不透明对象：依赖或所在父对象改了名；deps 集合变了；依赖的列（按 ID，及按它在表里的列名对齐）或依赖 / 父对象表的
//   列上下文变了；DDL 文本变了；或依赖的不透明对象本身待规范化（视图叠视图，沿依赖传递，带环保护，#136）。
import { deepEqual, type Model, type Obj, resolvePartitionBy, rootTableId } from '@dowel/core';

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

/** MSSQL 持久化计算列：引擎推断出的可空性会被 canonicalize 写回 notNull（shadow.ts），其他情况 notNull 不是规范形式的一部分 */
const isMssqlPersisted = (m: Model, o: Obj): o is Column =>
  m.dialect === 'mssql' && o.kind === 'column' && !!o.generated?.stored;

/**
 * 一个模型里“表 → 列名 → 列签名”的惰性索引：表沿 partitionOf 解析到根父表；
 * 同一个（折叠大小写后的）列名对应多列时把它们的签名排序拼起来（只会更容易判为变化）。
 * sigs 是类型上下文（colSig）；nulls 是普通列的可空性（只给 MSSQL 持久化计算列用，按需才建）。
 */
const columnContext = (m: Model) => {
  let byTable: Map<string, Column[]> | null = null;
  const ci = caseInsensitive(m);
  const fold = ci ? (n: string) => n.toLowerCase() : (n: string) => n;
  const index = (sig: (c: Column) => string) => {
    const byRoot = new Map<string, Map<string, string>>();
    return (tableId: string): Map<string, string> => {
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
        const s = sig(c);
        if (list) list.push(s);
        else grouped.set(k, [s]);
      }
      out = new Map([...grouped].map(([k, v]) => [k, v.sort().join('|')]));
      byRoot.set(root, out);
      return out;
    };
  };
  const sigs = index((c) => colSig(m, c, ci));
  // 计算列不能引用计算列（SQL Server 拒绝），所以生成列自己的 notNull 不算进同表其他计算列的上下文
  const nulls = index((c) => (c.generated ? '-' : c.notNull ? '1' : '0'));
  return { sigs, nulls, fold };
};

/** 两份“列名 → 签名”里，两边都有的某个列名签名不同（只在一边出现的列名不算） */
const alignedChanged = (a: Map<string, string>, b: Map<string, string>): boolean => {
  for (const [name, sig] of b) {
    const old = a.get(name);
    if (old !== undefined && old !== sig) return true;
  }
  return false;
};

/**
 * 相对基线名字绑定变了的枚举的非限定名（小写；基线与当前两侧的名字都收）：改名、对调、换 schema（完整限定名变了），
 * 以及只在一边存在的枚举（删除 / 新建，同名枚举换了 ID）。收当前侧既保持 (base, cur) 对称，也覆盖“基线里原本没有该枚举
 * （如原本是同名的 domain / 复合类型等非枚举对象，或此前被删除），当前模型新建或改名出同名枚举”的场景。稳态下为空。
 */
const changedEnumNames = (base: Model, cur: Model): Set<string> => {
  const out = new Set<string>();
  for (const [m, other] of [
    [base, cur],
    [cur, base],
  ] as const) {
    for (const o of Object.values(m.objects)) {
      if (o.kind !== 'enum') continue;
      if (other.objects[o.id]?.kind !== 'enum' || fullName(m, o.id) !== fullName(other, o.id))
        out.add(o.name.toLowerCase());
    }
  }
  return out;
};

/** 带引号标识符（"..."，"" 转义）或普通标识符；字符串字面量里的词也会被扫到（只会多报） */
const IDENT_RE = /"((?:[^"]|"")*)"|[\p{L}_][\p{L}\p{N}_$]*/gu;

/**
 * 表达式（exprsOf 的返回值：字符串 / 数组 / 普通对象）里是否出现了 names 里的某个名字（忽略大小写，按词匹配）。
 * 小写折叠是有意的过近似：覆盖手写基线或 PG 原样保留的 $$...$$ 函数体里非引号大写拼写（如 public.MOOD）与目录小写名（mood）
 * 的大小写差异；若存在带引号且仅大小写不同的同名枚举，至多引起一次瞬态多报、flush 后即归零。
 */
const mentionsAny = (e: unknown, names: ReadonlySet<string>): boolean => {
  if (typeof e === 'string') {
    for (const x of e.matchAll(IDENT_RE)) {
      const n = x[1] !== undefined ? x[1].replaceAll('""', '"') : x[0];
      if (names.has(n.toLowerCase())) return true;
    }
    return false;
  }
  if (Array.isArray(e)) return e.some((x) => mentionsAny(x, names));
  if (e && typeof e === 'object') return Object.values(e).some((x) => mentionsAny(x, names));
  return false;
};

/** 分区父表的分区键表达式原文（列键为 null；存量字符串整段都算） */
const partitionKeyText = (o: Obj | undefined): unknown => {
  if (o?.kind !== 'table' || !o.partitionBy) return null;
  return typeof o.partitionBy === 'string' ? o.partitionBy : o.partitionBy.keys.map((k) => k.expr);
};

interface PartitionKeyInfo {
  sig: string;
  hasExpr: boolean;
}

/**
 * 分区父表的分区键签名（按父表 ID 缓存）：
 * - strategy + 每个键的 [列签名 colSig | 键表达式, opclass, collation]；
 *   opclass / collation / strategy 是有意的过近似：PG 反解析边界常量时不打印 COLLATE，opclass 也不改变字面量文本，
 *   有非 DEFAULT 子分区时换策略会被拒绝——多报一次、flush 后即归零，不值得为它们单独建模；
 * - hasExpr 表示是否含表达式分区键（或无法解析的存量字符串），调用方据此决定是否再检查父表的列上下文。
 * 父表不存在或不是分区父表时返回 null。
 */
const partitionKeyInfo = (m: Model) => {
  const cache = new Map<string, PartitionKeyInfo | null>();
  return (parentId: string): PartitionKeyInfo | null => {
    if (cache.has(parentId)) return cache.get(parentId)!;
    const p = m.objects[parentId];
    let info: PartitionKeyInfo | null = null;
    if (p?.kind === 'table' && p.partitionBy) {
      const spec = resolvePartitionBy(m, p);
      if (spec) {
        let hasExpr = false;
        const keys = spec.keys.map((k) => {
          if (k.column !== null) {
            const col = m.objects[k.column];
            return col?.kind === 'column'
              ? ['col', colSig(m, col), k.opclass, k.collation]
              : ['missing', k.column, k.opclass, k.collation];
          }
          hasExpr = true;
          return ['expr', k.expr, k.opclass, k.collation];
        });
        info = { sig: JSON.stringify([spec.strategy, keys]), hasExpr };
      } else if (typeof p.partitionBy === 'string') {
        info = { sig: JSON.stringify(['raw', p.partitionBy]), hasExpr: true };
      }
    }
    cache.set(parentId, info);
    return info;
  };
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
  // 表（各自解析到根父表）的列上下文是否变了：按（基线根表，当前根表）缓存，同家族多个子分区只比一次
  const tableChanged = new Map<string, boolean>();
  const tableCtxChanged = (tableId: string): boolean => {
    const baseRoot = rootTableId(base, tableId);
    const curRoot = rootTableId(cur, tableId);
    const key = `${baseRoot}\0${curRoot}`;
    let v = tableChanged.get(key);
    if (v === undefined) {
      v = alignedChanged(baseCtx.sigs(baseRoot), curCtx.sigs(curRoot));
      tableChanged.set(key, v);
    }
    return v;
  };
  // MSSQL 持久化计算列的可空性上下文：列自己的 notNull（按 ID）或所在表按列名对齐的列 notNull 变了（#145）
  const nullChanged = new Map<string, boolean>();
  const mssqlNullabilityChanged = (c: Column): boolean => {
    const was = base.objects[c.id];
    if (was?.kind === 'column' && was.notNull !== c.notNull) return true;
    const baseRoot = rootTableId(base, c.parent);
    const curRoot = rootTableId(cur, c.parent);
    const key = `${baseRoot}\0${curRoot}`;
    let v = nullChanged.get(key);
    if (v === undefined) {
      v = alignedChanged(baseCtx.nulls(baseRoot), curCtx.nulls(curRoot));
      nullChanged.set(key, v);
    }
    return v;
  };
  // 名字绑定变了的枚举（#146）：稳态下为空，此时下面的文本扫描一次都不做
  const enumNames = changedEnumNames(base, cur);
  const mentionsChangedEnum = (e: unknown): boolean => enumNames.size > 0 && mentionsAny(e, enumNames);
  // 不透明对象依赖的某一列：按 ID 变了类型，或按它现在的列名在所在（根）表里对应的列换了类型上下文
  const depColumnChanged = (col: Column): boolean => {
    if (columnTypeChanged(base, cur, col.id)) return true;
    const k = curCtx.fold(col.name);
    const old = baseCtx.sigs(col.parent).get(k);
    return old !== undefined && old !== curCtx.sigs(col.parent).get(k);
  };
  const basePartKey = partitionKeyInfo(base);
  const curPartKey = partitionKeyInfo(cur);
  /**
   * 子分区的边界解释上下文变了：换了直接父表、直接父表的分区键签名变了，
   * 或父表含表达式分区键（或是解析不出来的存量字符串）且父表列上下文变了 / 键表达式里写的枚举换了绑定
   */
  const partitionBoundContextChanged = (o: Table): boolean => {
    if (!o.partitionOf) return false;
    const was = base.objects[o.id];
    if (was?.kind !== 'table' || !was.partitionOf) return false;
    if (was.partitionOf.parent !== o.partitionOf.parent) return true;
    const parentId = o.partitionOf.parent;
    const a = basePartKey(parentId);
    const b = curPartKey(parentId);
    if (a?.sig !== b?.sig) return true;
    if (!a?.hasExpr && !b?.hasExpr) return false;
    // a.sig === b.sig 保证两边的键表达式一致，但不保证 partitionKeyText 逐字相同：若基线是可解析的存量字符串、
    // 当前已结构化，基线侧多出的策略关键字、键列名、collation、opclass 都不是枚举引用，键列的枚举类型已由 colSig 覆盖，
    // 因此只扫当前一侧即可
    return tableCtxChanged(parentId) || mentionsChangedEnum(partitionKeyText(cur.objects[parentId]));
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
        !deepEqual(exprsOf(o), exprsOf(base.objects[o.id])) ||
        mentionsChangedEnum(o.ddl);
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
      (o.kind === 'table' && partitionBoundContextChanged(o)) ||
      (isMssqlPersisted(cur, o) && mssqlNullabilityChanged(o)) ||
      mentionsChangedEnum(e)
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
