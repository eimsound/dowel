/** 与键顺序无关的 JSON 序列化：PG 的 jsonb 会重排键，比较模型时不能依赖原始顺序 */
export const stableJson = (x: unknown): string =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );

/**
 * 与 stableJson 语义一致的结构等价判断，避免每次比较分配全量 JSON 字符串与排序数组。
 * - 数组按位置比较，undefined 元素视同 JSON.stringify 的 null；
 * - 普通对象跳过值为 undefined 的自有可枚举键（与 JSON.stringify 省略 undefined 键一致）。
 */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;
  if (ta === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (ta !== 'object') return false;

  const isArrA = Array.isArray(a);
  if (isArrA !== Array.isArray(b)) return false;
  if (isArrA) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      const va = arrA[i] === undefined ? null : arrA[i];
      const vb = arrB[i] === undefined ? null : arrB[i];
      if (!deepEqual(va, vb)) return false;
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  let countA = 0;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i]!;
    const va = objA[k];
    if (va === undefined) continue;
    countA++;
    if (!Object.hasOwn(objB, k)) return false;
    const vb = objB[k];
    if (vb === undefined || !deepEqual(va, vb)) return false;
  }
  let countB = 0;
  for (let i = 0; i < keysB.length; i++) {
    if (objB[keysB[i]!] !== undefined) countB++;
  }
  return countA === countB;
};

/** 浅-深平铺克隆纯 JSON/IR 数据结构（兼容 ES Proxy，且在大模型上比 structuredClone 快得多） */
export const clonePlain = <T>(x: T): T => {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) {
    const out = new Array<unknown>(x.length);
    for (let i = 0; i < x.length; i++) out[i] = clonePlain(x[i]);
    return out as unknown as T;
  }
  const src = x as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    out[k] = clonePlain(src[k]);
  }
  return out as T;
};
