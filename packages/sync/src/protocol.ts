// 同步协议的消息和公共函数（04-ir-design.md 第 2 节）。客户端和服务器共用。
import {
  clonePlain,
  COMPOSITE_MUTATORS,
  deepEqual,
  type Model,
  MutableModelIndex,
  type Obj,
  OverlayModelIndex,
  readsOf,
  runMutator,
  withModelIndex,
} from '@dowel/core';

/** 系统提交（replace / patch）保留的客户端标识，普通连接禁止使用 */
export const SYSTEM_CLIENT = 'system';
export const MAX_CLIENT_ID_LENGTH = 128;

const hasInvalidClientChar = (client: string): boolean => {
  for (let i = 0; i < client.length; i++) {
    const code = client.charCodeAt(i);
    // 禁止 ASCII 控制字符、空格、DEL 与分隔符冒号（0x3a）
    if (code <= 0x20 || code === 0x7f || code === 0x3a) return true;
  }
  return /\s/.test(client);
};

/** 校验客户端上报的 client 标识：非空、不过长、不含控制字符/空白/冒号，且不能使用保留值 system */
export const isValidClientId = (client: unknown): client is string =>
  typeof client === 'string' &&
  client.length > 0 &&
  client.length <= MAX_CLIENT_ID_LENGTH &&
  client.toLowerCase() !== SYSTEM_CLIENT &&
  !hasInvalidClientChar(client);

/** 对象版本：已确认的是服务器序号（导入时已存在的对象为 0）；本地待确认修改写过的是 `p:{客户端}:{n}` */
export type Ver = number | string;
export type Versions = Record<string, Ver>;

/** 只取自有属性：ID 可能是 constructor、toString 等 Object.prototype 上的名字 */
export const ownObj = (m: Model, id: string): Obj | undefined =>
  Object.hasOwn(m.objects, id) ? m.objects[id] : undefined;

/** 对象的已知版本；没有记录（含 Object.prototype 上的名字）时为 0 */
export const verOf = (versions: Versions, id: string): Ver =>
  Object.hasOwn(versions, id) ? (versions[id] ?? 0) : 0;

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

export interface ExecuteResult {
  next: Model;
  changes: Change[];
  overlay: Map<string, Obj | undefined>;
}

/** 在模型的副本上执行一个修改，返回改动了哪些对象（写时复制，绝不修改传入的模型） */
export const execute = (
  m: Model,
  name: string,
  args: unknown,
  baseIndex?: MutableModelIndex,
): ExecuteResult => {
  const overlay = new Map<string, Obj | undefined>();
  const proxyCache = new Map<string, Obj>();

  const ensureCloned = (rootId: string): Obj | undefined => {
    if (overlay.has(rootId)) return overlay.get(rootId);
    const orig = m.objects[rootId];
    if (!orig) return undefined;
    const cloned = clonePlain(orig);
    overlay.set(rootId, cloned);
    return cloned;
  };

  const wrapSub = (rootId: string, path: (string | symbol)[], initialTarget: object): object => {
    const getCurrent = (): unknown => {
      let cur: unknown = overlay.has(rootId) ? overlay.get(rootId) : m.objects[rootId];
      for (let i = 0; i < path.length; i++) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<PropertyKey, unknown>)[path[i]!];
      }
      return cur;
    };
    const getMutableParent = (): object | undefined => {
      let cur: unknown = ensureCloned(rootId);
      for (let i = 0; i < path.length; i++) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<PropertyKey, unknown>)[path[i]!];
      }
      return cur !== null && typeof cur === 'object' ? (cur as object) : undefined;
    };

    return new Proxy(initialTarget, {
      get(_t, prop) {
        const cur = getCurrent();
        if (cur === null || typeof cur !== 'object') return undefined;
        const val = Reflect.get(cur, prop);
        if (val !== null && typeof val === 'object') {
          return wrapSub(rootId, [...path, prop], val as object);
        }
        return val;
      },
      has(_t, prop) {
        const cur = getCurrent();
        return cur !== null && typeof cur === 'object' ? prop in (cur as object) : false;
      },
      set(_t, prop, value) {
        const mut = getMutableParent();
        if (!mut) return false;
        const clean = value !== null && typeof value === 'object' ? clonePlain(value) : value;
        return Reflect.set(mut, prop, clean);
      },
      deleteProperty(_t, prop) {
        const mut = getMutableParent();
        if (!mut) return false;
        return Reflect.deleteProperty(mut, prop);
      },
      defineProperty(_t, prop, desc) {
        const mut = getMutableParent();
        if (!mut) return false;
        const cleanDesc =
          'value' in desc && desc.value !== null && typeof desc.value === 'object'
            ? { ...desc, value: clonePlain(desc.value) }
            : desc;
        return Reflect.defineProperty(mut, prop, cleanDesc);
      },
      ownKeys() {
        const cur = getCurrent();
        return cur !== null && typeof cur === 'object' ? Reflect.ownKeys(cur as object) : [];
      },
      getOwnPropertyDescriptor(_t, prop) {
        const cur = getCurrent();
        if (cur === null || typeof cur !== 'object') return undefined;
        const d = Reflect.getOwnPropertyDescriptor(cur as object, prop);
        if (!d) return undefined;
        if ('value' in d && d.value !== null && typeof d.value === 'object') {
          return { ...d, value: wrapSub(rootId, [...path, prop], d.value as object) };
        }
        return d;
      },
    });
  };

  const wrapRoot = <T extends Obj>(o: T): T => {
    let p = proxyCache.get(o.id);
    if (!p) {
      p = wrapSub(o.id, [], o) as Obj;
      proxyCache.set(o.id, p);
    }
    return p as T;
  };

  const objectsTarget: Record<string, Obj> = {};
  const objectsProxy = new Proxy(objectsTarget, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (overlay.has(prop)) {
        const v = overlay.get(prop);
        return v ? wrapRoot(v) : undefined;
      }
      const orig = ownObj(m, prop);
      return orig ? wrapRoot(orig) : undefined;
    },
    has(_t, prop) {
      if (typeof prop !== 'string') return false;
      if (overlay.has(prop)) return overlay.get(prop) !== undefined;
      return Object.hasOwn(m.objects, prop);
    },
    set(_t, prop, value) {
      if (typeof prop !== 'string') return false;
      overlay.set(prop, clonePlain(value as Obj));
      return true;
    },
    deleteProperty(_t, prop) {
      if (typeof prop !== 'string') return true;
      if (Object.hasOwn(m.objects, prop) || overlay.has(prop)) {
        overlay.set(prop, undefined);
      }
      return true;
    },
    ownKeys() {
      const keys: string[] = [];
      for (const id of Object.keys(m.objects)) {
        if (!overlay.has(id) || overlay.get(id) !== undefined) keys.push(id);
      }
      for (const [id, val] of overlay) {
        if (val !== undefined && !Object.hasOwn(m.objects, id)) keys.push(id);
      }
      return keys;
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      let val: Obj | undefined;
      if (overlay.has(prop)) val = overlay.get(prop);
      else if (Object.hasOwn(m.objects, prop)) val = m.objects[prop];
      if (!val) return undefined;
      return { configurable: true, enumerable: true, writable: true, value: wrapRoot(val) };
    },
  });

  const draft: Model = { ...m, objects: objectsProxy };
  // 粘贴 / batch 一次展开成成百上千个子操作，每个都要做重名判定：没有现成索引时（例如还有待确认修改）临时建一个，
  // 一次 O(n) 建索引远比每个子操作 O(n) 枚举写时复制代理便宜
  if (!baseIndex && COMPOSITE_MUTATORS.has(name)) baseIndex = new MutableModelIndex(m);
  if (baseIndex) {
    const overlayIndex = new OverlayModelIndex(baseIndex, overlay, draft, wrapRoot);
    withModelIndex(draft, () => runMutator(draft, name, args), overlayIndex);
  } else {
    runMutator(draft, name, args);
  }

  const changes: Change[] = [];
  for (const [id, o] of overlay) {
    const before = ownObj(m, id);
    if (o === undefined) {
      if (before) changes.push({ id, obj: null });
    } else if (!before || !deepEqual(before, o)) {
      changes.push({ id, obj: o });
    }
  }
  if (changes.length === 0) {
    return { next: m, changes: [], overlay };
  }
  const nextObjects: Record<string, Obj> = { ...m.objects };
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]!;
    if (c.obj) nextObjects[c.id] = c.obj;
    else delete nextObjects[c.id];
  }
  return { next: { ...m, objects: nextObjects }, changes, overlay };
};

export const applyChanges = (m: Model, versions: Versions, changes: Change[], ver: Ver) => {
  for (const c of changes) {
    if (c.obj) {
      m.objects[c.id] = clonePlain(c.obj);
      versions[c.id] = ver;
    } else {
      delete m.objects[c.id];
      delete versions[c.id];
    }
  }
};

/** 依据：参数里涉及的对象 + 实际写到的对象（name 为 batch 时按子操作逐步计算，见 readsOf） */
export const opReads = (
  m: Model,
  versions: Versions,
  args: unknown,
  changes: Change[],
  name?: string,
): [string, Ver | null][] => {
  const ids = new Set([...readsOf(m, args, name), ...changes.map((c) => c.id)]);
  return [...ids].sort().map((id) => [id, Object.hasOwn(m.objects, id) ? verOf(versions, id) : null]);
};
