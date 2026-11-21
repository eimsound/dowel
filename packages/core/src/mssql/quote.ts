// MSSQL（T-SQL）标识符引用、关键字、词法分析与表达式列引用扫描。
import type { Token } from '../plan-types.ts';

/** T-SQL 保留关键字与常见内置常量关键字（小写） */
export const MSSQL_KEYWORDS: ReadonlySet<string> = new Set(
  (
    'add all alter and any as asc authorization backup begin between break browse bulk by cascade case check checkpoint close clustered coalesce collate column commit compute constraint contains containstable continue convert create cross current current_date current_time current_timestamp current_user cursor database dbcc deallocate declare default delete deny desc disk distinct distributed double drop dump else end errlvl escape except exec execute exists exit external fetch file fillfactor for foreign freetext freetexttable from full function goto grant group having holdlock identity identity_insert identitycol if in index inner insert intersect into is join key kill left like lineno load merge national nocheck nonclustered not null nullif of off offsets on open opendatasource openquery openrowset openxml option or order outer over percent pivot plan precision primary print proc procedure public raiserror read readtext reconfigure references replication restore restrict return revert revoke right rollback rowcount rowguidcol rule save schema securityaudit select semantickeyphrasetable semanticsimilaritydetailstable semanticsimilaritytable session_user set setuser shutdown some statistics system_user table tablesample textsize then to top tran transaction trigger truncate try_convert tsequal union unique unpivot update updatetext use user values varying view waitfor when where while with within group writetext ' +
    'true false persisted sparse next value cast try_cast try_parse parse getdate getutcdate sysdatetime sysutcdatetime sysdatetimeoffset newid newsequentialid'
  ).split(' '),
);

/** MSSQL 方括号标识符引用：内部 `]` 转义为 `]]` */
export const mssqlIdent = (name: string): string => `[${name.replaceAll(']', ']]')}]`;

/** MSSQL 限定对象名：`[schema].[name]` */
export const mssqlQualified = (schema: string, name: string): string =>
  `${mssqlIdent(schema)}.${mssqlIdent(name)}`;

/** MSSQL Unicode 字符串字面量：`N'...'`（内部 `'` 转义为 `''`） */
export const mssqlLiteral = (s: string): string => `N'${s.replaceAll("'", "''")}'`;

/** MSSQL ASCII 字符串字面量：`'...'` */
export const mssqlAsciiLiteral = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/**
 * 单遍扫 T-SQL：剥离 `'...'` / `N'...'` 字符串、`[...]` 与 `"..."` 标识符、`--` 行注释与支持嵌套的 `/* ... *\/` 块注释，
 * 替换为安全占位符并保留换行与分号，用于语句分类与高危语句扫描。
 */
export const stripMssqlSql = (sql: string): string => {
  let out = '';
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    if ((c === 'N' || c === 'n') && sql[i + 1] === "'") {
      i += 2;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      out += "N''";
    } else if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      out += "''";
    } else if (c === '[') {
      i++;
      while (i < n) {
        if (sql[i] === ']') {
          if (sql[i + 1] === ']') i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      out += '[]';
    } else if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      out += '""';
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
};

/**
 * 完整 T-SQL 词法器：
 * - 识别 `'...'` / `N'...'` 字符串字面量（`''` 转义）
 * - 识别 `[...]` 方括号标识符（`]]` 转义）与 `"..."` 双引号标识符（`""` 转义）
 * - 识别 `--` 行注释与支持任意深度嵌套的 `/* ... *\/` 块注释
 * - 识别普通标识符（`ident` 转为小写；`qident` 保留去转义后的原名）
 */
export const mssqlTokenize = (s: string): Token[] => {
  const out: Token[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const ch = s[i]!;
    const start = i;
    if ((ch === 'N' || ch === 'n') && s[i + 1] === "'") {
      i += 2;
      while (i < n) {
        if (s[i] === "'" && s[i + 1] === "'") i += 2;
        else if (s[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (ch === "'") {
      i++;
      while (i < n) {
        if (s[i] === "'" && s[i + 1] === "'") i += 2;
        else if (s[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (ch === '[') {
      i++;
      let inner = '';
      while (i < n) {
        if (s[i] === ']' && s[i + 1] === ']') {
          inner += ']';
          i += 2;
        } else if (s[i] === ']') {
          i++;
          break;
        } else {
          inner += s[i]!;
          i++;
        }
      }
      out.push({ text: inner, kind: 'qident', start, end: i });
    } else if (ch === '"') {
      i++;
      let inner = '';
      while (i < n) {
        if (s[i] === '"' && s[i + 1] === '"') {
          inner += '"';
          i += 2;
        } else if (s[i] === '"') {
          i++;
          break;
        } else {
          inner += s[i]!;
          i++;
        }
      }
      out.push({ text: inner, kind: 'qident', start, end: i });
    } else if (ch === '-' && s[i + 1] === '-') {
      while (i < n && s[i] !== '\n') i++;
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (ch === '/' && s[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (s[i] === '/' && s[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (s[i] === '*' && s[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (/[A-Za-z_@#\u0080-\uFFFD]/.test(ch)) {
      while (i < n && /[A-Za-z0-9_@$#\u0080-\uFFFD]/.test(s[i]!)) i++;
      const word = s.slice(start, i);
      // @var / @@spid 属于 T-SQL 变量或系统变量，不是列引用
      if (word.startsWith('@')) {
        out.push({ text: word, kind: 'other', start, end: i });
      } else {
        out.push({ text: word.toLowerCase(), kind: 'ident', start, end: i });
      }
    } else {
      i++;
      out.push({ text: ch, kind: 'other', start, end: i });
    }
  }
  return out;
};

/** 表达式中出现的列引用（跳过函数名、限定名前缀、CAST/TRY_CAST(... AS <type>)、CONVERT/TRY_CONVERT(<type>, ...)、COLLATE <name>） */
export const mssqlColumnRefs = (expr: string): Token[] => {
  const sig = mssqlTokenize(expr).filter(
    (x) => !/^\s+$/.test(x.text) && !x.text.startsWith('--') && !x.text.startsWith('/*'),
  );
  const out: Token[] = [];
  let inCastAs = 0;
  for (let i = 0; i < sig.length; i++) {
    const x = sig[i]!;
    if (x.kind === 'ident' && x.text === 'collate') {
      i++;
      continue;
    }
    if (x.kind === 'ident' && (x.text === 'cast' || x.text === 'try_cast') && sig[i + 1]?.text === '(') {
      inCastAs++;
      continue;
    }
    if (
      x.kind === 'ident' &&
      (x.text === 'convert' || x.text === 'try_convert') &&
      sig[i + 1]?.text === '('
    ) {
      // 跳过 CONVERT(<type>[(...)], ...) 的第一个类型参数直到顶层逗号
      i += 2; // 跳过 convert 与 '('
      let depth = 0;
      while (i < sig.length) {
        const cur = sig[i]!;
        if (cur.text === '(') depth++;
        else if (cur.text === ')') {
          if (depth === 0) break;
          depth--;
        } else if (cur.text === ',' && depth === 0) {
          break;
        }
        i++;
      }
      continue;
    }
    if (inCastAs > 0 && x.kind === 'ident' && x.text === 'as') {
      let depth = 0;
      while (i + 1 < sig.length) {
        const nxt = sig[i + 1]!;
        if (nxt.text === '(') depth++;
        else if (nxt.text === ')') {
          if (depth === 0) break;
          depth--;
        }
        i++;
      }
      inCastAs = Math.max(0, inCastAs - 1);
      continue;
    }
    if (x.kind === 'other') continue;
    const prev = sig[i - 1]?.text;
    const next = sig[i + 1]?.text;
    // 跳过函数名、schema/table 限定前缀、以及被限定成员（如 NEXT VALUE FOR [s].[seq] 的后半段）
    if (next === '(' || next === '.') continue;
    if (prev === '.') continue;
    out.push(x);
  }
  return out;
};

export const mssqlExprReferences = (expr: string, name: string): boolean => {
  const low = name.toLowerCase();
  return mssqlColumnRefs(expr).some((x) => x.text.toLowerCase() === low);
};

export const mssqlRenameInExpr = (expr: string, from: string, to: string): string => {
  const low = from.toLowerCase();
  let out = expr;
  for (const x of mssqlColumnRefs(expr).reverse()) {
    if (x.text.toLowerCase() === low) {
      out = out.slice(0, x.start) + mssqlIdent(to) + out.slice(x.end);
    }
  }
  return out;
};

export const mssqlRenameQualifiedInExpr = (
  expr: string,
  schema: string,
  name: string | null,
  to: { schema: string; name: string | null },
): string => {
  const t = mssqlTokenize(expr).filter((x) => !/^\s+$/.test(x.text));
  let out = expr;
  const match = (x: Token | undefined, n: string) =>
    !!x && (x.kind === 'ident' || x.kind === 'qident') && x.text.toLowerCase() === n.toLowerCase();
  for (let i = t.length - 1; i >= 0; i--) {
    if (!match(t[i], schema) || t[i + 1]?.text !== '.') continue;
    if (name === null) {
      out = out.slice(0, t[i]!.start) + mssqlIdent(to.schema) + out.slice(t[i]!.end);
    } else if (match(t[i + 2], name)) {
      out = `${out.slice(0, t[i]!.start)}${mssqlIdent(to.schema)}.${mssqlIdent(to.name!)}${out.slice(t[i + 2]!.end)}`;
    }
  }
  return out;
};
