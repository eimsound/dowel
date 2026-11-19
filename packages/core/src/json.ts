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

export const deepEqual = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
