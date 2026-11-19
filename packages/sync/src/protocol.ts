// 同步协议的消息和公共函数（04-ir-design.md 第 2 节）。客户端和服务器共用。
import { deepEqual, type Model, type Obj, readsOf, runMutator } from '@dowel/core';

/** 对象版本：已确认的是服务器序号（导入时已存在的对象为 0）；本地待确认修改写过的是 `p:{客户端}:{n}` */
export type Ver = number | string;
export type Versions = Record<string, Ver>;

export interface Op {
  client: string;
  /** 该客户端的第 n 个修改，从 1 开始严格递增 */
  n: number;
  name: string;
  args: unknown;
  /** 发起时依据的对象及其版本（null 表示当时不存在） */
  reads: [string, Ver | null][];
}

export type Change = { id: string; obj: Obj | null };

export interface Commit {
  t: 'commit';
  seq: number;
  client: string;
  n: number;
  user: string;
  changes: Change[];
}
export interface Rejection {
  n: number;
  code: 'conflict' | 'invalid' | 'dependency';
  message: string;
}

export type ToServer = { t: 'hello'; client: string; lastSeq: number } | { t: 'op'; op: Op };
export type ToClient =
  | { t: 'welcome'; lastProcessed: number; rejected: Rejection[] }
  /** 快照已包含该客户端前 lastProcessed 个修改的结果（原型的随机测试发现必须带上） */
  | { t: 'snapshot'; seq: number; model: Model; versions: Versions; lastProcessed: number }
  | Commit
  | ({ t: 'reject' } & Rejection);

/** 在模型的副本上执行一个修改，返回改动了哪些对象（不修改传入的模型） */
export const execute = (m: Model, name: string, args: unknown): { next: Model; changes: Change[] } => {
  const next = structuredClone(m);
  runMutator(next, name, args);
  const changes: Change[] = [];
  for (const [id, o] of Object.entries(next.objects)) {
    const before = m.objects[id];
    if (!before || !deepEqual(before, o)) changes.push({ id, obj: o });
  }
  for (const id of Object.keys(m.objects)) if (!(id in next.objects)) changes.push({ id, obj: null });
  return { next, changes };
};

export const applyChanges = (m: Model, versions: Versions, changes: Change[], ver: Ver) => {
  for (const c of changes) {
    if (c.obj) {
      m.objects[c.id] = structuredClone(c.obj);
      versions[c.id] = ver;
    } else {
      delete m.objects[c.id];
      delete versions[c.id];
    }
  }
};

/** 依据：参数里涉及的对象 + 实际写到的对象 */
export const opReads = (
  m: Model,
  versions: Versions,
  args: unknown,
  changes: Change[],
): [string, Ver | null][] => {
  const ids = new Set([...readsOf(m, args), ...changes.map((c) => c.id)]);
  return [...ids].sort().map((id) => [id, id in m.objects ? (versions[id] ?? 0) : null]);
};
