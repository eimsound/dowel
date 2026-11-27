// 黄金基线规范化的属性不变量（Issue #125，ADR 0016）：纯函数层面，不需要 Docker / PG。
//
// 用一个假引擎代替影子库：规范形式只取决于对象自身文本和 derive-pending.ts 声明会影响它的上下文
// （表达式：同表被引用列的 type / typeRef / collation——按列名解析，分区子表沿 partitionOf 用根父表的列——，
// 列自身的默认值 / 生成列再加上自己的类型；不透明对象：父对象与依赖的完整限定名、依赖列的类型，
// 依赖的不透明对象再递归带上它自己的这份签名，模拟视图叠视图）。真实 canonicalize（apps/server/src/shadow.ts:442）会读回并比较全部对象，
// 判定正确时变化的也只会是待规范化对象；假引擎刻意更严格，只改写 pendingRefreshIds(prev, next) 里的对象——这样判定漏掉的对象不会被顺手改好，
// 会在 I1 / I2 里暴露出来（规范形式本身用不依赖判定的 canonObj 独立计算）。
//
// 随机生成一串操作（画布编辑、flush、normalize、runWithReset / runWithoutReset 整体替换、新建 refresher、故障注入），
// 操作按它调用的 OpaqueRefresher API 命名，不断言“哪个路由用哪种模式”。每步之后断言：
// - I1：基线不为空时，基线里每个对象都是假引擎下的不动点；
// - I2：不在 pendingRefreshIds(baseline, cur) 里的对象，再规范化一次不变；
// - I3：失败或写回全被拒绝的 flush / normalize / runWithReset（期间没有任何一次写回被接受，saves === accepted）前后基线 deepEqual，
//   且被拒绝 / 失败的写回绝不持久化基线；
// - I4：影子库可用且没有并发写入 / 写回拒绝时，一次 flush 之后 needsRefresh(baseline, cur) === false。
//
// 前置条件（生成器保证）：无条件 runWithReset 与“带基线新建 refresher”只喂假引擎下的不动点模型（canonModel）。
// 生产里这由外部保证：引擎刚读出的模型（拉取 / 导入），或执行器读回校验（packages/executor execute.ts verifyAndRecord）
// 挡住的非规范 head 模型；OpaqueRefresher 本身不检查。违反它会直接破坏 I1，见文件末尾的“前置条件依赖”示例。
// runWithReset({ onlyIfClean: true }) 与 runWithoutReset 则可以喂任意（过期、未规范化的）模型。
//
// 已知局限：验证不到“哪个路由用了哪种 canonical 模式”（由路由级示例测试兜底；接入领先 / 接手用哪种模式待 #123 决定）；
// 假引擎只证明规则自洽，不能证明对真实引擎（PG / MySQL / MSSQL）完备。
//
// 运行次数 DERIVE_RUNS（默认 200）、种子 DERIVE_SEED（默认固定）；失败时 fast-check 打印种子、路径和缩小后的操作序列。
// 深挖：DERIVE_RUNS=5000 DERIVE_SEED=<n>；DERIVE_STATS=1 加 --silent=false 打印各类操作 / 结果的命中次数。
import { deepEqual, EditError, emptyModel, type Model, type Obj, rootTableId, runMutator } from '@dowel/core';
import { StepError } from '@dowel/verifier';
import fc from 'fast-check';
import { describe, expect, test, vi } from 'vitest';

import { exprsOf, fullName, needsRefresh, OpaqueRefresher, pendingRefreshIds } from '../src/derive.ts';
import type { Rooms } from '../src/rooms.ts';
import { type Shadow, ShadowError } from '../src/shadow.ts';

const RUNS = Number(process.env.DERIVE_RUNS ?? 200);
const SEED = Number(process.env.DERIVE_SEED ?? 20261127);
const BRANCH = 'b';

type Column = Extract<Obj, { kind: 'column' }>;
type Check = Extract<Obj, { kind: 'check' }>;
type Opaque = Extract<Obj, { kind: 'opaque' }>;
type Table = Extract<Obj, { kind: 'table' }>;

// ───── 假引擎 ─────

const COLUMN_NAMES = ['qty', 'price', 'note', 'flag', 'score', 'total', 'rate'] as const;
const TABLE_NAMES = ['orders', 'items', 'users2', 'ledger'] as const;
const ENUM_NAMES = ['mood', 'tone', 'phase'] as const;
const SCHEMA_NAMES = ['public', 'app'] as const;
const TYPES = ['integer', 'bigint', 'text', 'numeric'] as const;
const COLLATIONS = [null, 'C', 'POSIX'] as const;
const OPS = ['>', '<', '<>', '>='] as const;

/** 类型注解：`::` 之后的单个标识符（PG 列引用分析会跳过它，renameInExpr / exprReferences 不受影响） */
const annot = (c: Column): string =>
  `${c.type}${c.typeRef ? `_r_${c.typeRef}` : ''}${c.collation ? `_c_${c.collation}` : ''}`;

/** 去掉规范化加上的注解和括号，得到用户原文的词序列（规范化因此幂等） */
const coreTokens = (s: string): string[] =>
  s
    .replace(/::[A-Za-z0-9_]+/g, '')
    .replace(/[()]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** 表的有效列（按名字）：分区子表没有自己的列，沿 partitionOf 用根父表的列 */
const columnsByName = (m: Model, tableId: string): Map<string, Column> => {
  const root = rootTableId(m, tableId);
  const out = new Map<string, Column>();
  for (const o of Object.values(m.objects)) if (o.kind === 'column' && o.parent === root) out.set(o.name, o);
  return out;
};

/** 表达式的规范形式：加括号，给每个同表列引用标上该列的类型；列自己的默认值 / 生成列再标上自己的类型 */
const canonExpr = (text: string, cols: Map<string, Column>, own?: Column): string => {
  const body = `(${coreTokens(text)
    .map((t) => {
      const c = cols.get(t);
      return c ? `${t}::${annot(c)}` : t;
    })
    .join(' ')})`;
  return own ? `${body}::${annot(own)}` : body;
};

/** 不透明对象依赖的签名：依赖的完整限定名、依赖列类型；依赖的不透明对象递归带上它自己的签名（带环保护） */
const depsSig = (m: Model, o: Opaque, seen: Set<string>): string =>
  o.deps
    .map((d) => {
      const dep = m.objects[d];
      if (dep?.kind === 'column') return `${fullName(m, d)}:${annot(dep)}`;
      if (dep?.kind === 'opaque' && !seen.has(d))
        return `${fullName(m, d)}{${depsSig(m, dep, new Set([...seen, d]))}}`;
      return fullName(m, d);
    })
    .join(', ');

/** 不透明对象 DDL 的规范形式：原文第一句 + 父对象的完整限定名与依赖签名 */
const canonDdl = (m: Model, o: Opaque): string[] => [
  o.ddl[0]!,
  `-- canonical in ${fullName(m, o.parent)} deps ${depsSig(m, o, new Set([o.id]))}`,
];

/** 假引擎对单个对象的规范形式（与它在模型 m 里的上下文有关） */
const canonObj = (m: Model, o: Obj): Obj => {
  switch (o.kind) {
    case 'check':
      return { ...o, expr: canonExpr(o.expr, columnsByName(m, o.parent)) };
    case 'index': {
      const cols = columnsByName(m, o.parent);
      return {
        ...o,
        elements: o.elements.map((e) => (e.expr ? { ...e, expr: canonExpr(e.expr, cols) } : e)),
        where: o.where ? canonExpr(o.where, cols) : o.where,
      };
    }
    case 'column': {
      if (!o.generated && !(o.default && 'expr' in o.default)) return o;
      const cols = columnsByName(m, o.parent);
      return {
        ...o,
        generated: o.generated ? { ...o.generated, expr: canonExpr(o.generated.expr, cols, o) } : o.generated,
        default: o.default && 'expr' in o.default ? { expr: canonExpr(o.default.expr, cols, o) } : o.default,
      };
    }
    case 'opaque':
      return { ...o, ddl: canonDdl(m, o) };
    default:
      return o;
  }
};

/** 整个模型的规范形式（相当于引擎刚读出来的模型；无条件 runWithReset / 带基线新建 refresher 的前置条件） */
const canonModel = (m: Model): Model => {
  const out = structuredClone(m);
  for (const o of Object.values(m.objects)) out.objects[o.id] = structuredClone(canonObj(m, o));
  return out;
};

/** 不是不动点的对象（I1 / I2 的反例描述） */
const nonFixed = (m: Model, ids: Iterable<string>) => {
  const out: { id: string; have: unknown; want: unknown }[] = [];
  for (const id of ids) {
    const o = m.objects[id]!;
    const c = canonObj(m, o);
    if (!deepEqual(c, o)) out.push({ id, have: o, want: c });
  }
  return out;
};

type Fault =
  | { kind: 'none' }
  | { kind: 'nullShadow' | 'shadowError' | 'stepError' | 'otherError' }
  | { kind: 'reject'; times: number }
  | { kind: 'concurrent'; edit: Edit };

const failureOf = (kind: Fault['kind']): Error | null => {
  if (kind === 'shadowError') return new ShadowError('影子库不可用：假引擎');
  if (kind === 'stepError')
    return new StepError({ sql: 'ALTER TABLE x ADD CHECK (?)' } as never, new Error('syntax error'));
  if (kind === 'otherError') return new Error('unexpected');
  return null;
};

// ───── 内存房间（带对象版本检查的 patch，语义同 Room.patch）与基线存储 ─────

class MemRoom {
  m: Model;
  seq = 0;
  ver: Record<string, number> = {};
  rejectNext = 0;
  patchRejected = 0;
  constructor(m: Model) {
    this.m = structuredClone(m);
  }
  /** 整体换成 next（编辑 / replace）：变了的对象版本推进到新 seq */
  commit(next: Model) {
    const ids = new Set([...Object.keys(this.m.objects), ...Object.keys(next.objects)]);
    const changed = [...ids].filter((id) => !deepEqual(this.m.objects[id], next.objects[id]));
    if (!changed.length && deepEqual(this.m, next)) return;
    this.seq++;
    for (const id of changed) {
      if (next.objects[id]) this.ver[id] = this.seq;
      else delete this.ver[id];
    }
    this.m = structuredClone(next);
  }
  rooms(): Rooms {
    return {
      state: async () => ({ model: structuredClone(this.m), versions: { ...this.ver }, seq: this.seq }),
      model: async () => ({ model: structuredClone(this.m), seq: this.seq }),
      patch: async (_b: string, _u: string, objects: Obj[], expect: Record<string, number>) => {
        // 故障注入：整批都按版本冲突处理（相当于每个对象都被别人改过）
        if (this.rejectNext > 0) {
          this.rejectNext--;
          this.patchRejected++;
          return { committed: false, rejected: true, seq: this.seq };
        }
        const ok = objects.filter(
          (o) => Object.hasOwn(this.m.objects, o.id) && (this.ver[o.id] ?? 0) === (expect[o.id] ?? 0),
        );
        // 与 Room.patch 一致：版本对得上的对象照写，对不上的跳过并报 rejected
        const rejected = ok.length !== objects.length;
        if (rejected) this.patchRejected++;
        const next = structuredClone(this.m);
        for (const o of ok) next.objects[o.id] = structuredClone(o);
        const seq0 = this.seq;
        this.commit(next);
        return { committed: this.seq !== seq0, rejected, seq: this.seq };
      },
    } as unknown as Rooms;
  }
}

const memStore = () => {
  const saved: Model[] = [];
  return {
    saved,
    store: {
      load: async () => structuredClone(saved.at(-1) ?? null),
      save: async (_b: string, m: Model) => void saved.push(structuredClone(m)),
    },
  };
};

// ───── 画布编辑 ─────

interface ExprSpec {
  refs: number[];
  op: number;
  lit: number;
}

type Edit =
  | { k: 'addCheck'; t: number; e: ExprSpec }
  | { k: 'setCheckExpr'; o: number; e: ExprSpec }
  | { k: 'setDefault'; c: number; lit: number }
  | { k: 'addGenerated'; t: number; name: number; type: number; e: ExprSpec }
  | { k: 'addIndexExpr'; t: number; e: ExprSpec }
  | { k: 'addColumn'; t: number; name: number; type: number; coll: number }
  | { k: 'setColumnType'; c: number; type: number; enumRef: number | null }
  | { k: 'setCollation'; c: number; coll: number }
  | { k: 'renameColumn'; c: number; name: number }
  | { k: 'renameTable'; t: number; name: number }
  | { k: 'renameEnum'; e: number; name: number }
  | { k: 'renameSchema'; name: number }
  | { k: 'dropColumn'; c: number }
  | {
      k: 'addView';
      t: number;
      cols: number[];
      tableDep: boolean;
      enumRef: number | null;
      viewDep?: number | null;
    }
  | { k: 'editViewDdl'; v: number; rev: number }
  | { k: 'detachPartition'; t: number }
  | { k: 'attachPartition'; t: number; p: number; lo: number };

const idsOf = (m: Model, kind: Obj['kind'], f: (o: Obj) => boolean = () => true) =>
  Object.values(m.objects)
    .filter((o) => o.kind === kind && f(o))
    .map((o) => o.id)
    .sort();

const pick = <T>(xs: readonly T[], i: number): T | undefined => (xs.length ? xs[i % xs.length] : undefined);

const exprText = (m: Model, tableId: string, e: ExprSpec): string | null => {
  const root = rootTableId(m, tableId);
  const cols = idsOf(m, 'column', (o) => (o as Column).parent === root).map(
    (id) => (m.objects[id] as Column).name,
  );
  if (!cols.length) return null;
  const refs = e.refs.map((r) => pick(cols, r)!);
  return `${refs.join(' + ')} ${OPS[e.op % OPS.length]} ${e.lit}`;
};

let fresh = 0;
// 新对象 ID 带下划线，绝不与 initialModel 里的固定 ID（s、t1、c1……）撞车
const newId = (p: string) => `${p}_${++fresh}`;

/** 在模型草稿上执行一次编辑；不合法（EditError / 无对象可选）返回 false，草稿作废 */
const applyEdit = (m: Model, e: Edit): boolean => {
  const tables = idsOf(m, 'table');
  const columns = idsOf(m, 'column');
  const enums = idsOf(m, 'enum');
  try {
    switch (e.k) {
      case 'addCheck': {
        const t = pick(tables, e.t);
        const expr = t && exprText(m, t, e.e);
        if (!t || !expr) return false;
        runMutator(m, 'addCheck', { id: newId('k'), table: t, expr });
        return true;
      }
      case 'setCheckExpr': {
        const id = pick(idsOf(m, 'check'), e.o);
        const expr = id && exprText(m, (m.objects[id] as Check).parent, e.e);
        if (!id || !expr) return false;
        runMutator(m, 'setCheckExpr', { id, expr });
        return true;
      }
      case 'setDefault': {
        const id = pick(columns, e.c);
        if (!id) return false;
        runMutator(m, 'setDefault', { id, default: { expr: String(e.lit) } });
        return true;
      }
      case 'addGenerated': {
        const t = pick(tables, e.t);
        const expr = t && exprText(m, t, e.e);
        if (!t || !expr) return false;
        runMutator(m, 'addColumn', {
          table: t,
          column: {
            id: newId('g'),
            name: `${pick(COLUMN_NAMES, e.name)}_g`,
            type: pick(TYPES, e.type)!,
            generated: { expr, stored: true },
          },
        });
        return true;
      }
      case 'addIndexExpr': {
        const t = pick(tables, e.t);
        const expr = t && exprText(m, t, e.e);
        if (!t || !expr) return false;
        runMutator(m, 'addIndex', { id: newId('i'), table: t, elements: [{ expr }] });
        return true;
      }
      case 'addColumn': {
        const t = pick(tables, e.t);
        if (!t) return false;
        runMutator(m, 'addColumn', {
          table: t,
          column: {
            id: newId('c'),
            name: pick(COLUMN_NAMES, e.name)!,
            type: pick(TYPES, e.type)!,
            collation: pick(COLLATIONS, e.coll)!,
          },
        });
        return true;
      }
      case 'setColumnType': {
        const id = pick(columns, e.c);
        if (!id) return false;
        const typeRef = e.enumRef === null ? null : (pick(enums, e.enumRef) ?? null);
        runMutator(m, 'setColumnType', { id, type: pick(TYPES, e.type)!, typeRef });
        return true;
      }
      case 'setCollation': {
        // 没有专门的 mutator：模拟导入 / 拉取带来的排序规则变化
        const id = pick(columns, e.c);
        if (!id) return false;
        (m.objects[id] as Column).collation = pick(COLLATIONS, e.coll)!;
        return true;
      }
      case 'renameColumn': {
        const id = pick(columns, e.c);
        if (!id) return false;
        runMutator(m, 'renameColumn', { id, name: pick(COLUMN_NAMES, e.name)! });
        return true;
      }
      case 'renameTable': {
        const id = pick(tables, e.t);
        if (!id) return false;
        runMutator(m, 'renameTable', { id, name: pick(TABLE_NAMES, e.name)! });
        return true;
      }
      case 'renameEnum': {
        const id = pick(enums, e.e);
        if (!id) return false;
        runMutator(m, 'renameEnum', { id, name: pick(ENUM_NAMES, e.name)! });
        return true;
      }
      case 'renameSchema':
        runMutator(m, 'renameSchema', { id: 's', name: pick(SCHEMA_NAMES, e.name)! });
        return true;
      case 'dropColumn': {
        const id = pick(columns, e.c);
        if (!id) return false;
        runMutator(m, 'dropColumn', { id });
        return true;
      }
      case 'addView': {
        // 没有建视图的 mutator：模拟粘贴 / 导入带来的依赖某表的视图
        const t = pick(tables, e.t);
        if (!t) return false;
        const root = rootTableId(m, t);
        const tableCols = idsOf(m, 'column', (o) => (o as Column).parent === root);
        const cols = [...new Set(e.cols.map((i) => pick(tableCols, i)).filter((x) => x !== undefined))];
        // tableDep = false：只依赖列（否则表级判定会兜住列级判定，后者的缺陷就测不出来）
        const deps = e.tableDep || !cols.length ? [t, ...cols] : cols;
        const en = e.enumRef === null ? undefined : pick(enums, e.enumRef);
        if (en) deps.push(en);
        // 视图叠视图：再依赖一个已有的不透明对象（下游视图的 deps 里只有上游视图，没有底层表 / 列）
        const up =
          e.viewDep === null || e.viewDep === undefined ? undefined : pick(idsOf(m, 'opaque'), e.viewDep);
        if (up) deps.push(up);
        const id = newId('v');
        m.objects[id] = {
          id,
          kind: 'opaque',
          objType: 'view',
          parent: 's',
          name: `view_${id}`,
          ddl: [`CREATE VIEW view_${id} AS SELECT * FROM ${m.objects[t]!.name}`],
          drop: `DROP VIEW view_${id}`,
          deps,
          order: fresh,
          comment: null,
        } as Opaque;
        return true;
      }
      case 'editViewDdl': {
        const id = pick(idsOf(m, 'opaque'), e.v);
        if (!id) return false;
        const o = m.objects[id] as Opaque;
        o.ddl = [`${o.ddl[0]!.replace(/ \/\* rev \d+ \*\/$/, '')} /* rev ${e.rev} */`];
        return true;
      }
      case 'detachPartition': {
        // 脱离后子表物化出根父表的列（新 ID）；基线与当前模型的根表因此不同
        const id = pick(
          idsOf(m, 'table', (o) => (o as Table).partitionOf !== null),
          e.t,
        );
        if (!id) return false;
        runMutator(m, 'detachPartition', { id });
        return true;
      }
      case 'attachPartition': {
        // 只挑列名与分区父表一致的独立表（通常是先前脱离出来的子分区，可以自己也是分区表），否则挂载几乎总是被拒绝
        const parent = pick(
          idsOf(m, 'table', (o) => (o as Table).partitionBy !== null),
          e.p,
        );
        const colNames = (t: string) => [...columnsByName(m, t).keys()].sort().join(',');
        const child =
          parent &&
          pick(
            idsOf(
              m,
              'table',
              (o) =>
                (o as Table).partitionOf === null &&
                o.id !== rootTableId(m, parent) &&
                colNames(o.id) === colNames(parent),
            ),
            e.t,
          );
        if (!child || !parent) return false;
        const bound = `FOR VALUES FROM (${e.lo * 10}) TO (${e.lo * 10 + 10})`;
        runMutator(m, 'attachPartition', { parent, child, bound });
        return true;
      }
    }
  } catch (err) {
    if (err instanceof EditError) return false;
    throw err;
  }
};

const initialModel = (): Model => {
  const m = emptyModel();
  runMutator(m, 'createSchema', { id: 's', name: 'public' });
  runMutator(m, 'createEnum', { id: 'e1', schema: 's', name: 'mood', values: ['ok', 'bad'] });
  runMutator(m, 'createEnum', { id: 'e2', schema: 's', name: 'tone', values: ['hi', 'lo'] });
  runMutator(m, 'createTable', { id: 't1', schema: 's', name: 'orders' });
  runMutator(m, 'addColumn', { table: 't1', column: { id: 'c1', name: 'qty', type: 'integer' } });
  runMutator(m, 'addColumn', { table: 't1', column: { id: 'c2', name: 'price', type: 'numeric' } });
  runMutator(m, 'addColumn', { table: 't1', column: { id: 'c3', name: 'note', type: 'text' } });
  runMutator(m, 'createTable', { id: 't2', schema: 's', name: 'items' });
  runMutator(m, 'addColumn', { table: 't2', column: { id: 'c4', name: 'score', type: 'integer' } });
  runMutator(m, 'addColumn', { table: 't2', column: { id: 'c5', name: 'flag', type: 'text' } });
  // PG 分区家族 events(day 分区键, amount) → events_a（二级分区父表）→ events_a1：子分区没有自己的列
  // （ID 排在上面的表 / 列之后，不改变已有固定序列里按下标挑中的对象）
  runMutator(m, 'createTable', { id: 't3', schema: 's', name: 'events' });
  runMutator(m, 'addColumn', {
    table: 't3',
    column: { id: 'c6', name: 'day', type: 'integer', notNull: true },
  });
  runMutator(m, 'addColumn', { table: 't3', column: { id: 'c7', name: 'amount', type: 'integer' } });
  const byDay = {
    strategy: 'range' as const,
    keys: [{ column: 'c6', expr: null, opclass: null, collation: null }],
  };
  runMutator(m, 'setPartitionBy', { id: 't3', partitionBy: byDay });
  runMutator(m, 'createPartition', {
    id: 't31',
    parent: 't3',
    name: 'events_a',
    bound: 'FOR VALUES FROM (0) TO (100)',
  });
  runMutator(m, 'setPartitionBy', { id: 't31', partitionBy: byDay });
  runMutator(m, 'createPartition', {
    id: 't311',
    parent: 't31',
    name: 'events_a1',
    bound: 'FOR VALUES FROM (0) TO (10)',
  });
  return m;
};

// ───── 操作与生成器 ─────

type Op =
  | { op: 'edit'; edit: Edit }
  | { op: 'flush'; fault: Fault }
  | { op: 'normalize'; fault: Fault }
  // 下面的调用方举例只是背景（ADR 0016），映射本身以路由级测试为准
  /** runWithoutReset 换入任意历史模型（例：恢复画布历史、未验证版本） */
  | { op: 'runWithoutReset'; h: number }
  /** runWithReset({ onlyIfClean: true }) 换入任意模型，可能没规范化过（例：已验证版本） */
  | { op: 'runWithResetIfClean'; h: number; canonical: boolean }
  /** 无条件 runWithReset，只喂不动点模型（前置条件；例：拉取、导入） */
  | { op: 'runWithResetFixedPoint'; h: number }
  /** runWithReset 的 fn 本身抛错（例：working_changed） */
  | { op: 'runWithResetThrows'; h: number; onlyIfClean: boolean }
  /**
   * 换一个新的 OpaqueRefresher（例：接手；用哪种起点待 #123 决定，两种都覆盖）：
   * seeded = false 时基线为 null；seeded = true 时房间与基线都是同一份不动点模型（前置条件）。
   * h 为 null 表示不换房间（只在 seeded = false 时有意义）。
   */
  | { op: 'freshRefresher'; h: number | null; seeded: boolean }
  /** 只用于“前置条件依赖”示例，不进生成器：把未规范化模型直接写成基线 */
  | { op: 'violatePrecondition'; h: number; via: 'runWithReset' | 'seed' };

const nat = fc.nat({ max: 50 });
const exprArb: fc.Arbitrary<ExprSpec> = fc.record({
  refs: fc.array(nat, { minLength: 1, maxLength: 2 }),
  op: nat,
  lit: fc.integer({ min: 0, max: 9 }),
});
const editArb: fc.Arbitrary<Edit> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant('addCheck' as const), t: nat, e: exprArb }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('setCheckExpr' as const), o: nat, e: exprArb }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('setDefault' as const), c: nat, lit: nat }) },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('addGenerated' as const),
      t: nat,
      name: nat,
      type: nat,
      e: exprArb,
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('addIndexExpr' as const), t: nat, e: exprArb }) },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant('addColumn' as const), t: nat, name: nat, type: nat, coll: nat }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('setColumnType' as const),
      c: nat,
      type: nat,
      enumRef: fc.option(nat, { freq: 3 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('setCollation' as const), c: nat, coll: nat }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('renameColumn' as const), c: nat, name: nat }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('renameTable' as const), t: nat, name: nat }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('renameEnum' as const), e: nat, name: nat }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('renameSchema' as const), name: nat }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('dropColumn' as const), c: nat }) },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant('addView' as const),
      t: nat,
      cols: fc.array(nat, { maxLength: 2 }),
      tableDep: fc.boolean(),
      enumRef: fc.option(nat),
      viewDep: fc.option(nat),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('editViewDdl' as const), v: nat, rev: nat }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('detachPartition' as const), t: nat }) },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('attachPartition' as const),
      t: nat,
      p: nat,
      lo: fc.integer({ min: 0, max: 30 }),
    }),
  },
);
const faultArb: fc.Arbitrary<Fault> = fc.oneof(
  { weight: 6, arbitrary: fc.constant({ kind: 'none' as const }) },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom('nullShadow', 'shadowError', 'stepError', 'otherError')
      .map((kind) => ({ kind })),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('reject' as const), times: fc.integer({ min: 1, max: 5 }) }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('concurrent' as const), edit: editArb }) },
);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 8, arbitrary: editArb.map((edit) => ({ op: 'edit' as const, edit })) },
  { weight: 4, arbitrary: faultArb.map((fault) => ({ op: 'flush' as const, fault })) },
  { weight: 2, arbitrary: faultArb.map((fault) => ({ op: 'normalize' as const, fault })) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('runWithoutReset' as const), h: nat }) },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('runWithResetIfClean' as const),
      h: nat,
      canonical: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('runWithResetFixedPoint' as const), h: nat }) },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('runWithResetThrows' as const),
      h: nat,
      onlyIfClean: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('freshRefresher' as const),
      h: fc.option(nat),
      seeded: fc.boolean(),
    }),
  },
);

// ───── 执行器 ─────

class World {
  room = new MemRoom(initialModel());
  /** 房间历次模型（画布历史 / 版本 / 目标库快照的来源） */
  history: Model[] = [structuredClone(this.room.m)];
  fault: Fault = { kind: 'none' };
  canonReturned = 0;
  shadowAsked = 0;
  base = memStore();
  refresher = this.newRefresher();
  /** 覆盖率统计：每次运行独立持有，避免全局状态依赖测试执行顺序 */
  private stats?: Map<string, number>;

  constructor(stats?: Map<string, number>) {
    this.stats = stats;
  }

  private hit(k: string) {
    if (!this.stats) return;
    this.stats.set(k, (this.stats.get(k) ?? 0) + 1);
  }

  newRefresher(seed?: Model): OpaqueRefresher {
    this.base = memStore();
    if (seed) this.base.saved.push(structuredClone(seed));
    const shadow = {
      canonicalize: (prev: Model, next: Model) => this.canonicalize(prev, next),
    } as unknown as Shadow;
    return new OpaqueRefresher(
      this.room.rooms(),
      async () => {
        this.shadowAsked++;
        return this.fault.kind === 'nullShadow' ? null : shadow;
      },
      this.base.store,
    );
  }

  baseline(): Model | null {
    return structuredClone(this.base.saved.at(-1) ?? null);
  }

  async canonicalize(prev: Model, next: Model): Promise<Obj[]> {
    const err = failureOf(this.fault.kind);
    if (err) throw err;
    if (this.fault.kind === 'concurrent') {
      // canonicalize 期间别人提交了一次编辑（只发生一次）
      const edit = this.fault.edit;
      this.fault = { kind: 'none' };
      if (this.edit(edit)) this.hit('concurrent:applied');
    }
    this.canonReturned++;
    const out: Obj[] = [];
    for (const id of pendingRefreshIds(prev, next)) {
      const o = next.objects[id]!;
      const c = canonObj(next, o);
      if (!deepEqual(c, o)) {
        this.hit(`rewrite:${o.kind}`);
        if ((o.kind === 'check' || o.kind === 'index') && rootTableId(next, o.parent) !== o.parent)
          this.hit('rewrite:onPartitionChild');
        if (o.kind === 'opaque' && o.deps.some((d) => next.objects[d]?.kind === 'opaque'))
          this.hit('rewrite:opaque:onOpaque');
        out.push(structuredClone(c));
      }
    }
    return out;
  }

  edit(e: Edit): boolean {
    const draft = structuredClone(this.room.m);
    if (!applyEdit(draft, e)) return false;
    this.hit(`edit:${e.k}`);
    const seq0 = this.room.seq;
    this.room.commit(draft);
    return this.room.seq !== seq0;
  }

  snapshot(h: number): Model {
    return structuredClone(this.history[h % this.history.length]!);
  }

  async run(op: Op): Promise<void> {
    const before = this.baseline();
    const r = this.refresher;
    switch (op.op) {
      case 'edit':
        this.edit(op.edit);
        break;
      case 'flush':
      case 'normalize': {
        this.fault = op.fault.kind === 'reject' ? { kind: 'none' } : op.fault;
        this.room.rejectNext = op.fault.kind === 'reject' ? op.fault.times : 0;
        const faulty = op.fault.kind !== 'none';
        const canon0 = this.canonReturned;
        const rej0 = this.room.patchRejected;
        const asked0 = this.shadowAsked;
        const saves0 = this.base.saved.length;
        let failed: boolean;
        let flushKind: 'clean' | 'normalized' | 'skipped' | null = null;
        if (op.op === 'flush') {
          const out = await r.flush(BRANCH);
          failed = out.kind === 'skipped';
          flushKind = out.kind;
          this.hit(`flush:${out.kind}`);
          if (out.kind === 'clean') {
            // 出口 0 I/O：没有待规范化对象时不连影子库、不写基线
            expect(this.shadowAsked, 'clean flush 不应解析影子库').toBe(asked0);
            expect(this.base.saved.length, 'clean flush 不应写基线').toBe(saves0);
          }
        } else {
          const handle = async () => {
            this.shadowAsked++;
            if (this.fault.kind === 'nullShadow') throw new ShadowError('没有可用的影子库');
            return {
              shadow: { canonicalize: (p: Model, n: Model) => this.canonicalize(p, n) } as unknown as Shadow,
              label: 'fake',
            };
          };
          failed = await r.normalize(BRANCH, handle).then(
            () => false,
            () => true,
          );
          if (!faulty) expect(failed, 'normalize 无故障时应成功').toBe(false);
          this.hit(`normalize:${failed ? 'failed' : 'ok'}`);
        }
        if (op.op === 'flush' && this.canonReturned - canon0 > 1) {
          this.hit('flush:retried');
          if (op.fault.kind === 'concurrent') this.hit('flush:retried:concurrent');
        }
        const accepted = this.canonReturned - canon0 - (this.room.patchRejected - rej0);
        const saves = this.base.saved.length - saves0;
        this.fault = { kind: 'none' };
        this.room.rejectNext = 0;
        // I3：每次基线持久化都必须对应一次被接受的写回；被拒绝 / 失败的写回绝不能推进基线
        expect(saves, `I3：${op.op} 写回被拒或失败时不应写入基线`).toBe(accepted);
        // 期间没有任何一次写回被接受（失败、写回全被拒绝或未连影子库）→ 基线不变
        if (accepted === 0) {
          if (failed) this.hit(`I3:${op.op}:${op.fault.kind}`);
          expect(this.baseline(), `I3：${op.op} 无有效写回却改写了基线`).toEqual(before);
        }
        // I4：影子库可用且无并发写入时，一次出口之后不再有待规范化对象
        if (!faulty) {
          this.hit(`I4:${op.op}`);
          if (flushKind === 'normalized') this.hit('I4:flush:normalized');
          expect(needsRefresh(this.baseline(), this.room.m), `I4：${op.op} 之后仍有待规范化对象`).toBe(false);
          // 只读状态与之一致（状态栏显示“表达式已规范化”）
          await expect(r.status(BRANCH)).resolves.toMatchObject({
            pendingCount: 0,
            baseline: this.baseline() !== null,
          });
        }
        break;
      }
      case 'runWithoutReset': {
        const m = this.snapshot(op.h);
        await r.runWithoutReset(BRANCH, async () => this.room.commit(m));
        this.hit(`runWithoutReset:${needsRefresh(before, m) ? 'dirty' : 'clean'}`);
        expect(this.baseline(), 'runWithoutReset 不应改写基线').toEqual(before);
        break;
      }
      case 'runWithResetIfClean': {
        const m = op.canonical ? canonModel(this.snapshot(op.h)) : this.snapshot(op.h);
        const dirty = needsRefresh(before, m);
        this.hit(`runWithResetIfClean:${dirty ? 'kept' : 'advanced'}`);
        await r.runWithReset(BRANCH, m, async () => this.room.commit(m), { onlyIfClean: true });
        expect(this.baseline(), 'onlyIfClean：基线只能不变或推进到传入模型').toEqual(dirty ? before : m);
        break;
      }
      case 'runWithResetFixedPoint': {
        const m = canonModel(this.snapshot(op.h));
        await r.runWithReset(BRANCH, m, async () => this.room.commit(m));
        this.hit('runWithResetFixedPoint');
        expect(this.baseline()).toEqual(m);
        break;
      }
      case 'runWithResetThrows': {
        // fn 抛错时基线不变，与传入模型是否规范无关；无条件模式仍按前置条件只喂不动点
        const m = op.onlyIfClean ? this.snapshot(op.h) : canonModel(this.snapshot(op.h));
        await expect(
          r.runWithReset(
            BRANCH,
            m,
            async () => {
              throw new Error('working changed');
            },
            { onlyIfClean: op.onlyIfClean },
          ),
        ).rejects.toThrow('working changed');
        this.hit('I3:runWithResetThrows');
        expect(this.baseline(), 'I3：runWithReset 失败后基线被改写').toEqual(before);
        break;
      }
      case 'freshRefresher': {
        await r.drain();
        if (op.seeded) {
          const m = canonModel(this.snapshot(op.h ?? 0));
          this.room.commit(m);
          this.refresher = this.newRefresher(m);
        } else {
          if (op.h !== null) this.room.commit(canonModel(this.snapshot(op.h)));
          this.refresher = this.newRefresher();
        }
        this.hit(`freshRefresher:${op.seeded ? 'seeded' : 'null'}`);
        break;
      }
      case 'violatePrecondition': {
        const m = this.snapshot(op.h);
        if (op.via === 'runWithReset') {
          await r.runWithReset(BRANCH, m, async () => this.room.commit(m));
        } else {
          await r.drain();
          this.room.commit(m);
          this.refresher = this.newRefresher(m);
        }
        break;
      }
    }
    this.history.push(structuredClone(this.room.m));
    if (this.history.length > 30) this.history.shift();
  }

  /** I1 / I2：每一步之后都成立 */
  checkInvariants(step: number) {
    const b = this.baseline();
    if (b) {
      if (Object.values(b.objects).some((o) => exprsOf(o) !== null)) this.hit('I1:withExprs');
      const bad = nonFixed(b, Object.keys(b.objects));
      if (bad.length) expect(bad, `I1：第 ${step} 步后基线里有非不动点：${JSON.stringify(bad)}`).toEqual([]);
    }
    const cur = this.room.m;
    const pending = new Set(pendingRefreshIds(b, cur));
    const rest = Object.keys(cur.objects).filter((id) => !pending.has(id));
    if (rest.some((id) => exprsOf(cur.objects[id]) !== null)) this.hit('I2:withExprs');
    const bad = nonFixed(cur, rest);
    if (bad.length)
      expect(
        bad,
        `I2：第 ${step} 步后有未判为待规范化、却会被规范化改写的对象：${JSON.stringify(bad)}`,
      ).toEqual([]);
  }
}

const runOps = async (ops: Op[], stats?: Map<string, number>) => {
  fresh = 0;
  const w = new World(stats);
  w.checkInvariants(0);
  for (const [i, op] of ops.entries()) {
    await w.run(op);
    w.checkInvariants(i + 1);
  }
  await w.refresher.drain();
};

describe('假引擎自检', () => {
  test('规范形式幂等：canonModel 之后每个对象都是不动点', () => {
    fc.assert(
      fc.property(fc.array(editArb, { maxLength: 30, size: 'max' }), (edits) => {
        fresh = 0;
        const m = initialModel();
        for (const e of edits) {
          const draft = structuredClone(m);
          if (applyEdit(draft, e)) Object.assign(m, draft);
        }
        const c = canonModel(m);
        expect(nonFixed(c, Object.keys(c.objects))).toEqual([]);
        expect(canonModel(c)).toEqual(c);
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  test('判定与假引擎一致：规范模型上只改上下文，凡是规范形式变了的对象都被判为待规范化', () => {
    fc.assert(
      fc.property(
        fc.array(editArb, { maxLength: 20, size: 'max' }),
        fc.array(editArb, { maxLength: 8, size: 'max' }),
        (pre, post) => {
          fresh = 0;
          let m = initialModel();
          for (const e of pre) {
            const draft = structuredClone(m);
            if (applyEdit(draft, e)) m = draft;
          }
          const good = canonModel(m);
          let cur = structuredClone(good);
          for (const e of post) {
            const draft = structuredClone(cur);
            if (applyEdit(draft, e)) cur = draft;
          }
          const pending = new Set(pendingRefreshIds(good, cur));
          const missed = nonFixed(
            cur,
            Object.keys(cur.objects).filter((id) => !pending.has(id)),
          );
          expect(missed).toEqual([]);
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });
});

describe('OpaqueRefresher 黄金基线不变量（I1–I4）', () => {
  let cachedStats: Map<string, number> | null = null;
  const runRandomSuite = async (): Promise<Map<string, number>> => {
    const s = new Map<string, number>();
    // 非 ShadowError 的规范化失败会 console.warn（预期内的故障注入），这里静音
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 50, size: 'max' }), (ops) =>
          runOps(ops, s),
        ),
        {
          numRuns: RUNS,
          seed: SEED,
        },
      );
    } finally {
      warn.mockRestore();
    }
    return s;
  };

  test('随机操作序列', async () => {
    cachedStats = await runRandomSuite();
  }, 120_000);

  // 自包含：单独用 `-t 覆盖率` 或乱序执行时若尚未跑过随机用例，会自动补跑同一批随机序列再校验覆盖率；
  // 只在默认及以上的运行次数下检查（DERIVE_RUNS 调小做冒烟时不强求每类都出现）。
  test.skipIf(RUNS < 200)(
    '覆盖率：每类操作、故障与结果都真实发生过',
    async () => {
      const stats = cachedStats ?? (await runRandomSuite());
      const want = [
        ...[
          'addCheck',
          'setCheckExpr',
          'setDefault',
          'addGenerated',
          'addIndexExpr',
          'addColumn',
          'setColumnType',
          'setCollation',
          'renameColumn',
          'renameTable',
          'renameEnum',
          'renameSchema',
          'dropColumn',
          'addView',
          'editViewDdl',
          'detachPartition',
          'attachPartition',
        ].map((k) => `edit:${k}`),
        'flush:clean',
        'flush:normalized',
        'flush:skipped',
        'normalize:ok',
        'normalize:failed',
        'rewrite:check',
        'rewrite:column',
        'rewrite:index',
        'rewrite:opaque',
        'rewrite:onPartitionChild',
        'rewrite:opaque:onOpaque',
        ...['nullShadow', 'shadowError', 'stepError', 'otherError', 'reject'].flatMap((k) => [
          `I3:flush:${k}`,
          `I3:normalize:${k}`,
        ]),
        'I3:runWithResetThrows',
        'concurrent:applied',
        'flush:retried',
        'flush:retried:concurrent',
        'I4:flush',
        'I4:flush:normalized',
        'I4:normalize',
        'runWithoutReset:dirty',
        'runWithResetIfClean:kept',
        'runWithResetIfClean:advanced',
        'runWithResetFixedPoint',
        'freshRefresher:null',
        'freshRefresher:seeded',
        'I1:withExprs',
        'I2:withExprs',
      ];
      const missing = want.filter((k) => !stats.get(k));
      if (process.env.DERIVE_STATS)
        console.log(Object.fromEntries([...stats].sort(([a], [b]) => a.localeCompare(b))));
      expect(missing).toEqual([]);
    },
    120_000,
  );
});

// ───── 回归：同表列名绑定变化后过期表达式漏判（#133，最初由本文件的随机序列发现） ─────
//
// 表达式按“列名”引用列；判定曾只按“列 ID”比较同表列的 type / typeRef / collation，不把“名字 → 列”的绑定变化
// 当作上下文变化。当 runWithoutReset / runWithResetIfClean 换入一份过期模型（例：画布历史），其中表达式原文与基线逐字相同、
// 但同名列换成了另一列时，判定会漏掉：
// 1. 列 c3(note) 改成 integer，加 CHECK note > 0，flush → 基线里 "(note::integer > 0)"；
// 2. 再把 c3 改回 text（此刻的房间模型 H 进了历史：表达式原文过期，note 指向 c3:text）；
// 3. c3 改名 rate、c1(qty, integer) 改名 note，把 CHECK 改成 note > 0，flush → 新基线 B："(note::integer > 0)"，note 指向 c1；
// 4. runWithoutReset 换回 H：CHECK 原文与 B 相同，c1 / c3 的类型按 ID 都没变，但 note 现在是 c3:text，
//    规范形式应为 "(note::text > 0)"。漏判时出口 flush 0 I/O 返回 clean（违反 I2）；
//    若改走 runWithReset({ onlyIfClean: true })，这份模型还会被写成黄金基线（违反 I1）。
// DROP_RECREATE 是同一缺陷的另一条路径：第 3 步改为先让 CHECK 脱钩、删掉 c3、新建同名异 ID 的 integer 列再改回，
// 基线里根本没有 c3 这个 ID。现在判定按（分区根）表内列名对齐基线与当前模型，两条路径都不再漏判。
const COLUMN_SWAP: Op[] = [
  { op: 'edit', edit: { k: 'setColumnType', c: 2, type: 0, enumRef: null } },
  { op: 'edit', edit: { k: 'addCheck', t: 0, e: { refs: [2], op: 0, lit: 0 } } },
  { op: 'flush', fault: { kind: 'none' } },
  { op: 'edit', edit: { k: 'setColumnType', c: 2, type: 2, enumRef: null } },
  { op: 'edit', edit: { k: 'renameColumn', c: 2, name: 6 } },
  { op: 'edit', edit: { k: 'renameColumn', c: 0, name: 2 } },
  { op: 'edit', edit: { k: 'setCheckExpr', o: 0, e: { refs: [0], op: 0, lit: 0 } } },
  { op: 'flush', fault: { kind: 'none' } },
];
const DROP_RECREATE: Op[] = [
  ...COLUMN_SWAP.slice(0, 4),
  { op: 'edit', edit: { k: 'setCheckExpr', o: 0, e: { refs: [0], op: 0, lit: 0 } } },
  { op: 'edit', edit: { k: 'dropColumn', c: 2 } },
  { op: 'edit', edit: { k: 'addColumn', t: 0, name: 2, type: 0, coll: 0 } },
  { op: 'edit', edit: { k: 'setCheckExpr', o: 0, e: { refs: [2], op: 0, lit: 0 } } },
  { op: 'flush', fault: { kind: 'none' } },
];

describe('回归：同表列名绑定变化后过期表达式不漏判（#133）', () => {
  // history[4] 是第 4 步之后的房间模型 H
  test.each([
    ['列名对调', COLUMN_SWAP],
    ['删列后新建同名异 ID 列', DROP_RECREATE],
  ] as const)('%s：runWithoutReset 换入过期模型（I2）', (_, ops) =>
    runOps([...ops, { op: 'runWithoutReset', h: 4 }]),
  );
  test.each([
    ['列名对调', COLUMN_SWAP],
    ['删列后新建同名异 ID 列', DROP_RECREATE],
  ] as const)('%s：runWithReset({ onlyIfClean: true }) 不把未规范化模型写成基线（I1）', (_, ops) =>
    runOps([...ops, { op: 'runWithResetIfClean', h: 4, canonical: false }]),
  );
  // 严格差分对照：只去掉两次 renameColumn，保留其余全部步骤（含 setCheckExpr 与第二次 flush）
  test('对照：不对调列名时同一序列满足全部不变量', async () => {
    const noSwap = COLUMN_SWAP.filter((op) => op.op !== 'edit' || op.edit.k !== 'renameColumn');
    await runOps([...noSwap, { op: 'runWithoutReset', h: 4 }]);
    await runOps([...noSwap, { op: 'runWithResetIfClean', h: 4, canonical: false }]);
  });
});

// ───── 前置条件依赖（文档性示例，不是生产缺陷） ─────
// 无条件 runWithReset / 带基线新建 refresher 会把传入模型原样当成黄金基线：I1 成立依赖“传入的是不动点”这一外部保证。
// 一旦喂进未规范化的模型（这里：加了 CHECK 之后、还没规范化的房间模型），I1 立刻被破坏。
describe('前置条件依赖：无条件写基线的入口只能喂不动点模型', () => {
  const dirty: Op[] = [{ op: 'edit', edit: { k: 'addCheck', t: 0, e: { refs: [0], op: 0, lit: 0 } } }];
  test.each(['runWithReset', 'seed'] as const)('%s 喂未规范化模型 → I1 被破坏', async (via) => {
    await expect(runOps([...dirty, { op: 'violatePrecondition', h: 1, via }])).rejects.toThrow(
      /^I1：第 2 步后/,
    );
  });
  test.each(['runWithResetFixedPoint', 'freshRefresher'] as const)(
    '%s 喂同一模型的不动点 → 不变量成立',
    (op) =>
      runOps([
        ...dirty,
        op === 'freshRefresher' ? { op, h: 1, seeded: true } : { op, h: 1 },
        { op: 'flush', fault: { kind: 'none' } },
      ]),
  );
});
