// PG 表达式词法分析与列/限定名引用改写。
import type { Token } from '../plan-types.ts';
import { ident } from './quote.ts';

export type { Token };

/** 简单的 PG 表达式词法分析：识别字符串、带引号标识符、普通标识符，其余字符原样保留 */
export const tokenize = (s: string): Token[] => {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    const start = i;
    if (ch === "'" || ((ch === 'E' || ch === 'e') && s[i + 1] === "'")) {
      if (ch !== "'") i++;
      i++;
      while (i < s.length) {
        if (s[i] === '\\' && ch !== "'") i += 2;
        else if (s[i] === "'" && s[i + 1] === "'") i += 2;
        else if (s[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (ch === '$' && /^\$([A-Za-z_]\w*)?\$/.test(s.slice(i))) {
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(s.slice(i))![0];
      const close = s.indexOf(tag, i + tag.length);
      i = close < 0 ? s.length : close + tag.length;
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (ch === '"') {
      i++;
      while (i < s.length) {
        if (s[i] === '"' && s[i + 1] === '"') i += 2;
        else if (s[i] === '"') {
          i++;
          break;
        } else i++;
      }
      out.push({ text: s.slice(start + 1, i - 1).replaceAll('""', '"'), kind: 'qident', start, end: i });
    } else if (/[A-Za-z_\u0080-\uFFFD]/.test(ch)) {
      while (i < s.length && /[A-Za-z0-9_$\u0080-\uFFFD]/.test(s[i]!)) i++;
      out.push({ text: s.slice(start, i).toLowerCase(), kind: 'ident', start, end: i });
    } else {
      i++;
      out.push({ text: ch, kind: 'other', start, end: i });
    }
  }
  return out;
};

/**
 * 表达式里作为列引用出现的名字。跳过：函数名（后面跟括号）、类型名（`::` 之后的整个限定名，如 `::public."user"`）、
 * 限定名中前面的部分（`t.col` 的 `t`）。
 */
export const columnRefs = (expr: string): Token[] => {
  const sig = tokenize(expr).filter((x) => !/^\s$/.test(x.text));
  const out: Token[] = [];
  for (let i = 0; i < sig.length; i++) {
    const x = sig[i]!;
    if (x.text === ':' && sig[i + 1]?.text === ':') {
      // 跳过类型名：ident ( . ident )*
      i += 2;
      while (sig[i + 1]?.text === '.' && sig[i + 2] && sig[i + 2]!.kind !== 'other') i += 2;
      continue;
    }
    if (x.kind === 'other') continue;
    const next = sig[i + 1]?.text;
    if (next === '(' || next === '.') continue;
    out.push(x);
  }
  return out;
};

export const exprReferences = (expr: string, name: string): boolean =>
  columnRefs(expr).some((x) => x.text === name);

/** 改写表达式里的限定名 `schema.name`（类型改名、schema 改名时用） */
export const renameQualifiedInExpr = (
  expr: string,
  schema: string,
  name: string | null,
  to: { schema: string; name: string | null },
): string => {
  const t = tokenize(expr);
  let out = expr;
  const match = (x: Token | undefined, n: string) =>
    !!x && ((x.kind === 'ident' && x.text === n) || (x.kind === 'qident' && x.text === n));
  for (let i = t.length - 1; i >= 0; i--) {
    if (!match(t[i], schema) || t[i + 1]?.text !== '.') continue;
    if (name === null) {
      out = out.slice(0, t[i]!.start) + ident(to.schema) + out.slice(t[i]!.end);
    } else if (match(t[i + 2], name)) {
      out = `${out.slice(0, t[i]!.start)}${ident(to.schema)}.${ident(to.name!)}${out.slice(t[i + 2]!.end)}`;
    }
  }
  return out;
};

/** 表达式里出现的两段限定名 `a.b`（`a`、`b` 是普通或带引号的标识符），按出现顺序 */
export const qualifiedRefs = (expr: string): { schema: Token; name: Token }[] => {
  const t = tokenize(expr);
  const out: { schema: Token; name: Token }[] = [];
  for (let i = 0; i + 2 < t.length; i++) {
    const a = t[i]!;
    const b = t[i + 2]!;
    if (a.kind !== 'other' && t[i + 1]!.text === '.' && b.kind !== 'other') out.push({ schema: a, name: b });
  }
  return out;
};

/** 同时改名用的映射：schema 旧名 → 新名；(schema 旧名, 类型旧名) → 新的限定名 */
export interface QualifiedRemap {
  schemas: ReadonlyMap<string, string>;
  types: ReadonlyMap<string, ReadonlyMap<string, { schema: string; name: string }>>;
}

/**
 * 按映射**一趟**改写表达式里的限定名：每处引用只按旧名查一次表、直接换成新名，
 * 不会被后面的改名再改一次，所以两个名字对调、多个名字轮换都正确（相当于两阶段占位改名）。
 * `schema.类型` 命中类型映射时整体替换；否则只要 schema 改了名就替换 schema 部分（其他对象如函数跟着 schema 走）。
 */
export const remapQualifiedInExpr = (expr: string, remap: QualifiedRemap): string => {
  if (remap.schemas.size === 0 && remap.types.size === 0) return expr;
  const lower = expr.toLowerCase();
  // 快速路径：表达式里根本没出现任何旧 schema 名时不必分词
  const keys = [...remap.schemas.keys(), ...remap.types.keys()];
  const mentions = (k: string) => {
    const l = k.toLowerCase();
    return lower.includes(l) || lower.includes(l.replaceAll('"', '""'));
  };
  if (!keys.some(mentions)) return expr;
  let out = '';
  let last = 0;
  const t = tokenize(expr);
  for (let i = 0; i + 2 < t.length; i++) {
    const a = t[i]!;
    const b = t[i + 2]!;
    if (a.kind === 'other' || t[i + 1]!.text !== '.' || b.kind === 'other') continue;
    const ty = remap.types.get(a.text)?.get(b.text);
    if (ty) {
      out += `${expr.slice(last, a.start)}${ident(ty.schema)}.${ident(ty.name)}`;
      last = b.end;
      i += 2;
      continue;
    }
    const sch = remap.schemas.get(a.text);
    if (sch !== undefined) {
      out += `${expr.slice(last, a.start)}${ident(sch)}`;
      last = a.end;
    }
  }
  return out + expr.slice(last);
};

export const renameInExpr = (expr: string, from: string, to: string): string => {
  let out = expr;
  for (const x of columnRefs(expr).reverse())
    if (x.text === from) out = out.slice(0, x.start) + ident(to) + out.slice(x.end);
  return out;
};
