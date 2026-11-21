// 重新导入时沿用已有对象的 ID（04-ir-design.md 3.4）：按名字（限定名）把新对象匹配到旧对象。
// 方言无关，适用于 PG / SQLite / MySQL / MSSQL。
import type { Model, Obj } from '@dowel/core';

const keysOf = (m: Model): Map<string, string> => {
  const memo = new Map<string, string | null>();
  const key = (id: string): string | null => {
    if (memo.has(id)) return memo.get(id)!;
    memo.set(id, null);
    const o = m.objects[id] as Obj | undefined;
    let k: string | null = null;
    if (o) {
      const p = 'parent' in o ? key(o.parent) : '';
      if (p !== null)
        k =
          o.kind === 'schema' || o.kind === 'extension'
            ? `${o.kind}:${o.name}`
            : o.kind === 'opaque'
              ? `opaque:${o.objType}:${p}/${o.name}`
              : `${o.kind}:${p}/${o.name}`;
    }
    memo.set(id, k);
    return k;
  };
  const out = new Map<string, string>();
  for (const id of Object.keys(m.objects)) {
    const k = key(id);
    if (k) out.set(k, id);
  }
  return out;
};

/** 返回 next 的副本：凡是能在 prev 里按名字找到的对象，ID 换成 prev 里的 ID（所有引用一并替换） */
export const reconcileIds = (prev: Model, next: Model): Model => {
  const old = keysOf(prev);
  const map = new Map<string, string>();
  for (const [k, id] of keysOf(next)) {
    const o = old.get(k);
    if (o && o !== id) map.set(id, o);
  }
  if (!map.size) return next;
  const swap = (x: unknown): unknown => {
    if (typeof x === 'string') return map.get(x) ?? x;
    if (Array.isArray(x)) return x.map(swap);
    if (x && typeof x === 'object')
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [map.get(k) ?? k, swap(v)]));
    return x;
  };
  return swap(next) as Model;
};
