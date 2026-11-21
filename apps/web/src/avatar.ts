// 组头像：首字母 / 第一个汉字 + 按 slug 哈希挑一个协作者颜色做背景。
// 背景色用 peer 色和 surface 混合：亮 / 暗两种配色下都保持与 text-2 足够对比，同时不同组能区分开。
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const groupInitial = (name: string): string => {
  const first = segmenter.segment(name.trim())[Symbol.iterator]().next().value?.segment ?? '?';
  return CJK.test(first) ? first : first.toUpperCase();
};

const hash = (slug: string): number => {
  let h = 0;
  for (const ch of slug) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h;
};

/** 背景色从 DESIGN.md 的 peer-1…peer-8 里选，混合面板底色保证对比度 */
export const groupColor = (slug: string): string =>
  `color-mix(in oklab, var(--peer-${(hash(slug) % 8) + 1}) 45%, var(--surface))`;
