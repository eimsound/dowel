// MySQL 影子库迁移风险分析：
// 利用 MySQL 8.4 / 9.7 的 ALGORITHM=INSTANT → ALGORITHM=INPLACE, LOCK=NONE → ALGORITHM=INPLACE, LOCK=SHARED → COPY
// 渐进试跑，在不额外重置影子库的前提下获取每步 DDL 的真实锁与重写风险。
import {
  createAll,
  type Model,
  MYSQL_SHADOW_MARK_TABLE,
  mysqlIdent,
  type MysqlPlanOptions,
  mysqlTokenize,
  splitMysqlStatements,
  type Step,
  stripMysqlSql,
} from '@dowel/core';

import { type Db, EngineStepError, type StepRisk } from '../types.ts';
import { pinMysqlSession } from './db.ts';

const mysqlErrno = (e: unknown): number | null => {
  const n = (e as { errno?: unknown } | null)?.errno;
  return typeof n === 'number' ? n : null;
};

/** 1845 = ER_ALTER_OPERATION_NOT_SUPPORTED, 1846 = ER_ALTER_OPERATION_NOT_SUPPORTED_REASON */
const isUnsupportedAlterAlgo = (e: unknown): boolean => {
  const errno = mysqlErrno(e);
  return errno === 1845 || errno === 1846;
};

const isSyntaxError = (e: unknown): boolean => mysqlErrno(e) === 1064;

/** 清空 MySQL 影子库中的全部用户对象（严格保留 `__dowel_shadow_mark` 哨兵表） */
export const resetMysqlShadow = async (db: Db): Promise<void> => {
  await db.exec('SET FOREIGN_KEY_CHECKS = 0');
  try {
    const triggers = await db.query<{ name: string }>(
      `SELECT TRIGGER_NAME AS name
         FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE()`,
    );
    for (const tr of triggers) {
      await db.exec(`DROP TRIGGER IF EXISTS ${mysqlIdent(tr.name)}`);
    }

    const views = await db.query<{ name: string }>(
      `SELECT TABLE_NAME AS name
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_TYPE = 'VIEW'`,
    );
    for (const v of views) {
      await db.exec(`DROP VIEW IF EXISTS ${mysqlIdent(v.name)}`);
    }

    const tables = await db.query<{ name: string }>(
      `SELECT TABLE_NAME AS name
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_TYPE = 'BASE TABLE'
          AND TABLE_NAME <> ?`,
      [MYSQL_SHADOW_MARK_TABLE],
    );
    for (const t of tables) {
      await db.exec(`DROP TABLE IF EXISTS ${mysqlIdent(t.name)}`);
    }

    const routines = await db.query<{ name: string; kind: string }>(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS kind
         FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA = DATABASE()`,
    );
    for (const r of routines) {
      const kw = r.kind.toUpperCase() === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
      await db.exec(`DROP ${kw} IF EXISTS ${mysqlIdent(r.name)}`);
    }

    const events = await db.query<{ name: string }>(
      `SELECT EVENT_NAME AS name
         FROM information_schema.EVENTS
        WHERE EVENT_SCHEMA = DATABASE()`,
    );
    for (const ev of events) {
      await db.exec(`DROP EVENT IF EXISTS ${mysqlIdent(ev.name)}`);
    }
  } finally {
    await db.exec('SET FOREIGN_KEY_CHECKS = 1');
    await pinMysqlSession(db);
  }
};

const sigTokens = (sql: string) =>
  mysqlTokenize(sql).filter(
    (t) =>
      !/^\s+$/.test(t.text) &&
      !t.text.startsWith('--') &&
      !t.text.startsWith('#') &&
      !t.text.startsWith('/*') &&
      t.text !== '*/',
  );

const isIdentTok = (t: { kind: string; text: string } | undefined): t is { kind: string; text: string } =>
  !!t && (t.kind === 'ident' || t.kind === 'qident');

const readTableIdent = (
  toks: { kind: string; text: string }[],
  start: number,
): { name: string; next: number } | null => {
  const first = toks[start];
  if (!isIdentTok(first)) return null;
  if (toks[start + 1]?.text === '.' && isIdentTok(toks[start + 2])) {
    return { name: toks[start + 2]!.text.toLowerCase(), next: start + 3 };
  }
  return { name: first.text.toLowerCase(), next: start + 1 };
};

/** 跟随已执行的 DROP TABLE / RENAME TABLE / ALTER TABLE ... RENAME 动态同步既有表集合 */
const updateExistingTablesAfterStep = (sql: string, existingTables: Set<string>): void => {
  for (const stmt of splitMysqlStatements(sql)) {
    const toks = sigTokens(stmt);
    if (toks.length < 3) continue;
    const isWord = (idx: number, w: string) => toks[idx]?.kind === 'ident' && toks[idx]!.text === w;

    // DROP [TEMPORARY] TABLE [IF EXISTS] t1, t2, ...
    if (isWord(0, 'drop')) {
      let pos = 1;
      if (isWord(pos, 'temporary')) pos++;
      if (!isWord(pos, 'table')) continue;
      pos++;
      if (isWord(pos, 'if') && isWord(pos + 1, 'exists')) pos += 2;
      for (;;) {
        const tbl = readTableIdent(toks, pos);
        if (!tbl) break;
        existingTables.delete(tbl.name);
        pos = tbl.next;
        if (toks[pos]?.text === ',') {
          pos++;
          continue;
        }
        break;
      }
      continue;
    }

    // RENAME TABLE old1 TO new1, old2 TO new2, ...
    if (isWord(0, 'rename') && isWord(1, 'table')) {
      const pairs: [string, string][] = [];
      let pos = 2;
      while (pos < toks.length) {
        const src = readTableIdent(toks, pos);
        if (!src || !isWord(src.next, 'to')) break;
        const dst = readTableIdent(toks, src.next + 1);
        if (!dst) break;
        pairs.push([src.name, dst.name]);
        pos = dst.next;
        if (toks[pos]?.text === ',') pos++;
        else break;
      }
      const had = pairs.map(([src]) => existingTables.has(src));
      for (const [src] of pairs) existingTables.delete(src);
      pairs.forEach(([, dst], idx) => {
        if (had[idx]) existingTables.add(dst);
      });
      continue;
    }

    // ALTER TABLE old RENAME [TO|AS] new
    if (isWord(0, 'alter') && isWord(1, 'table')) {
      const src = readTableIdent(toks, 2);
      if (!src) continue;
      for (let k = src.next; k < toks.length; k++) {
        if (
          isWord(k, 'rename') &&
          (isWord(k + 1, 'to') || isWord(k + 1, 'as')) &&
          !isWord(k - 1, 'column') &&
          !isWord(k - 1, 'index')
        ) {
          const dst = readTableIdent(toks, k + 2);
          if (dst && existingTables.has(src.name)) {
            existingTables.delete(src.name);
            existingTables.add(dst.name);
          }
          break;
        }
      }
    }
  }
};

const extractSingleAlterTable = (sql: string): { table: string; baseSql: string } | null => {
  const stmts = splitMysqlStatements(sql);
  if (stmts.length !== 1) return null;
  const single = stmts[0]!.trim().replace(/;\s*$/, '');
  const stripped = stripMysqlSql(single);
  if (/\b(?:algorithm|lock)\s*=/i.test(stripped)) return null;

  const toks = mysqlTokenize(single).filter(
    (t) =>
      !/^\s+$/.test(t.text) &&
      !t.text.startsWith('--') &&
      !t.text.startsWith('#') &&
      !t.text.startsWith('/*'),
  );
  if (toks[0]?.kind !== 'ident' || toks[0].text !== 'alter') return null;
  if (toks[1]?.kind !== 'ident' || toks[1].text !== 'table') return null;
  const tTok = toks[2];
  if (!tTok || (tTok.kind !== 'ident' && tTok.kind !== 'qident')) return null;
  // 若带 db.table，取表名
  const table =
    toks[3]?.text === '.' && toks[4] && (toks[4].kind === 'ident' || toks[4].kind === 'qident')
      ? toks[4].text
      : tTok.text;
  return { table, baseSql: single };
};

const extractCreateIndexTable = (sql: string): string | null => {
  const toks = mysqlTokenize(sql).filter(
    (t) =>
      !/^\s+$/.test(t.text) &&
      !t.text.startsWith('--') &&
      !t.text.startsWith('#') &&
      !t.text.startsWith('/*'),
  );
  if (toks[0]?.kind !== 'ident' || toks[0].text !== 'create') return null;
  const onIdx = toks.findIndex((t, idx) => idx > 0 && t.kind === 'ident' && t.text === 'on');
  if (onIdx < 0) return null;
  const tTok = toks[onIdx + 1];
  if (!tTok || (tTok.kind !== 'ident' && tTok.kind !== 'qident')) return null;
  if (
    toks[onIdx + 2]?.text === '.' &&
    toks[onIdx + 3] &&
    (toks[onIdx + 3]!.kind === 'ident' || toks[onIdx + 3]!.kind === 'qident')
  ) {
    return toks[onIdx + 3]!.text;
  }
  return tTok.text;
};

/** 在影子库建出 from 后，逐条探测每步 MySQL DDL 的实际算法、锁与重写风险 */
export const analyzeMysqlStepRisk = async (
  db: Db,
  from: Model,
  steps: Step[],
  opts?: MysqlPlanOptions,
): Promise<StepRisk[]> => {
  await resetMysqlShadow(db);
  for (const s of createAll(from, opts)) {
    const t0 = performance.now();
    try {
      await db.exec(s.sql);
    } catch (e) {
      throw new EngineStepError(s, e, performance.now() - t0);
    }
  }

  const existingTables = new Set(
    (
      await db.query<{ name: string }>(
        `SELECT TABLE_NAME AS name
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_TYPE = 'BASE TABLE'
            AND TABLE_NAME NOT LIKE 'dowel!_%' ESCAPE '!'
            AND TABLE_NAME <> ?`,
        [MYSQL_SHADOW_MARK_TABLE],
      )
    ).map((r) => r.name.toLowerCase()),
  );

  const out: StepRisk[] = [];
  for (const s of steps) {
    const alter = extractSingleAlterTable(s.sql);
    if (alter && existingTables.has(alter.table.toLowerCase())) {
      const t0 = performance.now();
      let fellBackByAlgo = false;
      let applied = false;

      // 1) ALGORITHM=INSTANT
      try {
        await db.exec(`${alter.baseSql}, ALGORITHM=INSTANT`);
        out.push({
          locks: [{ relation: alter.table, mode: 'METADATA_LOCK (INSTANT)' }],
          rewrites: [],
          scans: [],
          level: 'low',
        });
        applied = true;
      } catch (e) {
        if (isUnsupportedAlterAlgo(e)) {
          fellBackByAlgo = true;
        } else if (!isSyntaxError(e)) {
          throw new EngineStepError(s, e, performance.now() - t0);
        }
      }

      // 2) ALGORITHM=INPLACE, LOCK=NONE
      if (!applied && fellBackByAlgo) {
        try {
          await db.exec(`${alter.baseSql}, ALGORITHM=INPLACE, LOCK=NONE`);
          out.push({
            locks: [{ relation: alter.table, mode: 'INPLACE (LOCK=NONE)' }],
            rewrites: [],
            scans: [alter.table],
            level: 'medium',
          });
          applied = true;
        } catch (e) {
          if (!isUnsupportedAlterAlgo(e)) {
            throw new EngineStepError(s, e, performance.now() - t0);
          }
        }
      }

      // 3) ALGORITHM=INPLACE, LOCK=SHARED
      if (!applied && fellBackByAlgo) {
        try {
          await db.exec(`${alter.baseSql}, ALGORITHM=INPLACE, LOCK=SHARED`);
          out.push({
            locks: [{ relation: alter.table, mode: 'INPLACE (LOCK=SHARED)' }],
            rewrites: [],
            scans: [alter.table],
            level: 'medium',
          });
          applied = true;
        } catch (e) {
          if (!isUnsupportedAlterAlgo(e)) {
            throw new EngineStepError(s, e, performance.now() - t0);
          }
        }
      }

      // 4) 原语句（COPY 或不支持追加 ALGORITHM 子句的 ALTER 变体）
      if (!applied) {
        try {
          await db.exec(s.sql);
        } catch (e) {
          throw new EngineStepError(s, e, performance.now() - t0);
        }
        if (fellBackByAlgo) {
          out.push({
            locks: [{ relation: alter.table, mode: 'COPY (SHARED/EXCLUSIVE)' }],
            rewrites: [alter.table],
            scans: [alter.table],
            level: 'high',
          });
        } else {
          out.push({
            locks: [{ relation: alter.table, mode: 'METADATA_LOCK' }],
            rewrites: [],
            scans: [],
            level: 'low',
          });
        }
      }
      updateExistingTablesAfterStep(s.sql, existingTables);
      continue;
    }

    const t0 = performance.now();
    try {
      await db.exec(s.sql);
    } catch (e) {
      throw new EngineStepError(s, e, performance.now() - t0);
    }
    updateExistingTablesAfterStep(s.sql, existingTables);

    const idxTable = extractCreateIndexTable(s.sql);
    if (idxTable && existingTables.has(idxTable.toLowerCase())) {
      out.push({
        locks: [{ relation: idxTable, mode: 'INPLACE' }],
        rewrites: [],
        scans: [idxTable],
        level: 'medium',
      });
      continue;
    }

    const stripped = stripMysqlSql(s.sql);
    if (/^\s*truncate\b/i.test(stripped)) {
      out.push({ locks: [], rewrites: [], scans: [], level: 'medium' });
      continue;
    }

    out.push({ locks: [], rewrites: [], scans: [], level: 'low' });
  }
  return out;
};
