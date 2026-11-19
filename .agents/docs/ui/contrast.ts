// 检查 mockups/theme.css 里关键颜色组合的 WCAG 对比度（亮、暗两种配色都查）：node .agents/docs/ui/contrast.ts
// 文字 4.5:1，控件边界、图标 3:1。带透明度的颜色先叠加到它所在的背景上再算。
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./mockups/theme.css', import.meta.url), 'utf8');
const vars = new Map<string, string>();
for (const m of css.matchAll(/--([\w-]+):\s*([^;]+);/g)) vars.set(m[1]!, m[2]!.trim());

type Rgba = [number, number, number, number];

/** 取某个配色下 token 的值：展开 var() 和 light-dark() */
const resolve = (v: string, mode: 0 | 1): string => {
  v = v.trim();
  const ld = /^light-dark\((.*)\)$/s.exec(v);
  if (ld) {
    let depth = 0;
    for (let i = 0; i < ld[1]!.length; i++) {
      const c = ld[1]![i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0)
        return resolve([ld[1]!.slice(0, i), ld[1]!.slice(i + 1)][mode]!, mode);
    }
  }
  const ref = /^var\(--([\w-]+)\)$/.exec(v);
  if (ref) return resolve(vars.get(ref[1]!) ?? 'white', mode);
  return v;
};

const oklchToRgba = (v: string): Rgba => {
  if (v === 'white') return [1, 1, 1, 1];
  const m = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(v);
  if (!m) throw new Error(`无法解析颜色：${v}`);
  const [L, C, H] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
    m[4] ? Number(m[4]) : 1,
  ];
};

/** 线性 sRGB 下叠加，再算相对亮度 */
const over = (fg: Rgba, bg: Rgba): Rgba =>
  [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3])).concat(1) as Rgba;
const luminance = ([r, g, b]: Rgba) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const ratio = (x: Rgba, y: Rgba) => {
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (a! + 0.05) / (b! + 0.05);
};
const color = (name: string, mode: 0 | 1) => oklchToRgba(resolve(`var(--${name})`, mode));

// [前景, 背景（可以是“叠加色 over 底色”）, 最低对比度, 说明]
const pairs: [string, string, number, string][] = [
  ['text', 'bg', 4.5, '正文'],
  ['text-2', 'panel', 4.5, '次要文字'],
  ['text-3', 'panel', 4.5, '辅助文字（小字）'],
  ['text-3', 'surface', 4.5, '占位符、类型名'],
  ['on-primary', 'primary', 4.5, '主按钮文字'],
  ['on-primary', 'primary-hover', 4.5, '主按钮悬停'],
  ['primary-text', 'primary-soft>panel', 4.5, '选中的树节点'],
  ['danger', 'surface', 4.5, '危险按钮、错误提示'],
  ['white', 'danger-solid', 4.5, '实心危险按钮'],
  ['danger', 'danger-soft>surface', 4.5, '高风险标记'],
  ['warn', 'warn-soft>surface', 4.5, '中风险标记'],
  ['ok', 'ok-soft>panel', 3, '成功图标'],
  ['pk', 'node-bg', 4.5, 'PK 标记'],
  ['fk', 'node-bg', 4.5, 'FK 标记'],
  ['enum', 'node-bg', 4.5, '枚举类型名'],
  ['tooltip-fg', 'tooltip-bg', 4.5, '悬停提示'],
  ['syn-kw', 'code-bg', 4.5, 'SQL 关键字'],
  ['syn-str', 'code-bg', 4.5, 'SQL 字符串'],
  ['syn-ty', 'code-bg', 4.5, 'SQL 类型'],
  ['syn-num', 'code-bg', 4.5, 'SQL 数字'],
  ['border-strong', 'surface', 3, '输入框边框'],
  ['focus', 'bg', 3, '焦点环'],
  ['edge', 'canvas', 3, '画布连线'],
];

let failed = 0;
for (const [mode, label] of [
  [0, '亮色'],
  [1, '暗色'],
] as const) {
  console.log(`\n${label}`);
  for (const [fg, bgSpec, min, desc] of pairs) {
    const [top, base] = bgSpec.split('>');
    const bg = base ? over(color(top!, mode), color(base, mode)) : color(top!, mode);
    const f = fg === 'white' ? oklchToRgba('white') : over(color(fg, mode), bg);
    const r = ratio(f, bg);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✗'} ${r.toFixed(2).padStart(5)} ≥ ${min}  ${desc}（${fg} / ${bgSpec}）`);
  }
}
if (failed) {
  console.log(`\n${failed} 组不达标`);
  process.exit(1);
}
