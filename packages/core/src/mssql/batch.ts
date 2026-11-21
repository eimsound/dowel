// T-SQL `GO [count]` 批处理切分器与脚本文本格式化。
// `GO` 不是 T-SQL 语法而是客户端批分隔符（tedious 不识别 `GO`），且 CREATE SCHEMA / VIEW / TRIGGER /
// PROCEDURE / FUNCTION 要求必须是批处理中的第一条语句，因此必须按词法精确切分与格式化。
import { PlanError } from '../plan-types.ts';
import { mssqlTokenize } from './quote.ts';

/** 单个 `GO <count>` 允许的最大重复执行次数，防止恶意大数字导致 OOM 或长时间阻塞 */
export const MAX_GO_REPEAT = 100;

/**
 * 解析整行是否为合法的 `GO [count]` 批分隔符行（调用前已确保行首处于顶层词法态，不在字符串/标识符/注释内）。
 * 规则与 sqlcmd / SSMS 对齐：
 * - 行首允许空白；
 * - 紧跟完整词 `GO`（大小写不敏感）；
 * - 后跟可选正整数重复次数（如 `GO 2`）；
 * - 尾部只允许空白、可选分号或 `--` 单行注释（不允许跟随其他 SQL 语句）。
 * 返回重复次数（0 表示跳过该批），非 GO 行返回 null。
 */
const parseGoLine = (line: string): number | null => {
  const m = /^[ \t]*GO(?:[ \t]+(\d+))?[ \t]*(?:--.*)?$/i.exec(line);
  if (!m) return null;
  if (m[1] === undefined) return 1;
  const count = Number.parseInt(m[1], 10);
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_GO_REPEAT) {
    throw new PlanError(`GO 批重复次数超出允许范围（0–${MAX_GO_REPEAT}）：${m[1]}`);
  }
  return count;
};

/**
 * 词法级精确切分 T-SQL 中的独占行 `GO [count]` 批分隔符：
 * - 绝不误切字符串（`'...'` / `N'...'`）、方括号标识符（`[...]`）、双引号标识符（`"..."`）、
 *   单行注释（`--`）以及支持嵌套的块注释（`/* ... *\/`）内部的 `GO`；
 * - 支持 `GO 2` 重复输出前一批次（上限 MAX_GO_REPEAT）；
 * - 忽略空批次。
 */
export const splitMssqlBatches = (sql: string): string[] => {
  const batches: string[] = [];
  const n = sql.length;
  let batchStart = 0;
  let lineStart = 0;

  let inSingle = false;
  let inBracket = false;
  let inDouble = false;
  let blockDepth = 0;

  const isTopLevel = () => !inSingle && !inBracket && !inDouble && blockDepth === 0;

  const pushBatch = (end: number, repeat: number) => {
    const piece = sql.slice(batchStart, end).trim();
    if (!piece || repeat === 0) return;
    for (let r = 0; r < repeat; r++) batches.push(piece);
  };

  while (lineStart <= n) {
    let lineEnd = sql.indexOf('\n', lineStart);
    const hasNewline = lineEnd >= 0;
    if (!hasNewline) lineEnd = n;
    const rawLine = sql.slice(lineStart, lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (isTopLevel()) {
      const goCount = parseGoLine(line);
      if (goCount !== null) {
        pushBatch(lineStart, goCount);
        batchStart = hasNewline ? lineEnd + 1 : n;
        lineStart = hasNewline ? lineEnd + 1 : n + 1;
        continue;
      }
    }

    // 沿本行推进词法状态，更新下一行行首所处的词法上下文
    let i = 0;
    const len = line.length;
    while (i < len) {
      const ch = line[i]!;
      if (inSingle) {
        if (ch === "'" && line[i + 1] === "'") i += 2;
        else if (ch === "'") {
          inSingle = false;
          i++;
        } else i++;
      } else if (inBracket) {
        if (ch === ']' && line[i + 1] === ']') i += 2;
        else if (ch === ']') {
          inBracket = false;
          i++;
        } else i++;
      } else if (inDouble) {
        if (ch === '"' && line[i + 1] === '"') i += 2;
        else if (ch === '"') {
          inDouble = false;
          i++;
        } else i++;
      } else if (blockDepth > 0) {
        if (ch === '/' && line[i + 1] === '*') {
          blockDepth++;
          i += 2;
        } else if (ch === '*' && line[i + 1] === '/') {
          blockDepth--;
          i += 2;
        } else i++;
      } else {
        if ((ch === 'N' || ch === 'n') && line[i + 1] === "'") {
          inSingle = true;
          i += 2;
        } else if (ch === "'") {
          inSingle = true;
          i++;
        } else if (ch === '[') {
          inBracket = true;
          i++;
        } else if (ch === '"') {
          inDouble = true;
          i++;
        } else if (ch === '-' && line[i + 1] === '-') {
          break; // 行注释延续到行尾
        } else if (ch === '/' && line[i + 1] === '*') {
          blockDepth = 1;
          i += 2;
        } else {
          i++;
        }
      }
    }

    lineStart = hasNewline ? lineEnd + 1 : n + 1;
  }

  pushBatch(n, 1);
  return batches;
};

const OWN_BATCH_TARGETS = new Set(['schema', 'view', 'trigger', 'procedure', 'proc', 'function']);

/** 判断一条 T-SQL 语句是否要求必须是批处理中的第一条语句（需要在前后用 `GO` 隔离） */
export const needsOwnMssqlBatch = (sql: string): boolean => {
  const sig = mssqlTokenize(sql).filter(
    (t) => !/^\s+$/.test(t.text) && !t.text.startsWith('--') && !t.text.startsWith('/*'),
  );
  const w0 = sig[0];
  if (!w0 || w0.kind !== 'ident') return false;
  if (w0.text !== 'create' && w0.text !== 'alter') return false;
  let idx = 1;
  // CREATE OR ALTER VIEW / TRIGGER / PROCEDURE / FUNCTION
  if (
    w0.text === 'create' &&
    sig[idx]?.kind === 'ident' &&
    sig[idx]!.text === 'or' &&
    sig[idx + 1]?.kind === 'ident' &&
    sig[idx + 1]!.text === 'alter'
  ) {
    idx += 2;
  }
  const target = sig[idx];
  return !!target && target.kind === 'ident' && OWN_BATCH_TARGETS.has(target.text);
};

/**
 * 将 MSSQL 迁移步骤格式化为可直接交给 SSMS / sqlcmd 执行的完整脚本：
 * 在需要独占批次的步骤（CREATE/ALTER SCHEMA、VIEW、TRIGGER、PROCEDURE、FUNCTION）前后自动插入 `GO`。
 */
export const formatMssqlScript = (steps: readonly { sql: string }[]): string => {
  if (steps.length === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i]!.sql.trim();
    const withSemi = raw.endsWith(';') ? raw : `${raw};`;
    const currNeeds = needsOwnMssqlBatch(raw);
    if (i > 0) {
      const prevNeeds = needsOwnMssqlBatch(steps[i - 1]!.sql.trim());
      if (prevNeeds || currNeeds) {
        parts.push('\nGO\n\n');
      } else {
        parts.push('\n\n');
      }
    }
    parts.push(withSemi);
  }
  return parts.join('');
};
