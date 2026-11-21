// PostgreSQL EngineAdapter 实现：封装既有 PG 快照/导入/历史/锁与重写分析/非事务续跑钩子。
import {
  all,
  createAll,
  find,
  isNontransactionalSql,
  type Model,
  pgMajorOf,
  type PlanOptions,
  type Step,
} from '@dowel/core';

import {
  type AppliedTimeouts,
  type Db,
  type EngineAdapter,
  EngineStepError,
  type HistoryStore,
  NON_TRANSACTIONAL_NOTE,
  type StepRisk,
  type TimeoutInfo,
  type TxHooks,
} from '../types.ts';
import { pinSession, SESSION_SETTINGS } from './db.ts';
import {
  claimProject,
  ensureHistory,
  fingerprint,
  finishRun,
  historyExists,
  historyWriteProblem,
  listHistoryProjects,
  markStep,
  readClaims,
  readHistory,
  readHistoryFormat,
  readProject,
  recordVersion,
  startRun,
  withProjectLock,
  writeProject,
} from './history.ts';
import { importSnapshot } from './import.ts';
import { diffSnapshots, normalize, readSnapshot, type Snapshot } from './snapshot.ts';

const PG_DEFAULT_PUBLIC_COMMENT = 'standard public schema';

const BLOCKS_READS = new Set(['AccessExclusiveLock']);
const BLOCKS_WRITES = new Set(['ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock']);

/** 全新 PG 库 public 自带默认注释；目标模型未设注释时忽略之 */
export const ignoreDefaultPublicCommentSnap = (snapshot: Snapshot, model: Model): Snapshot => {
  const pub = snapshot.schemas.public;
  if (pub?.comment !== PG_DEFAULT_PUBLIC_COMMENT) return snapshot;
  const inModel = Object.values(model.objects).find((o) => o.kind === 'schema' && o.name === 'public');
  if (inModel?.comment) return snapshot;
  return { ...snapshot, schemas: { ...snapshot.schemas, public: { ...pub, comment: null } } };
};

/** 对齐 PG 15–17 与 PG 18+ 非显式 NOT NULL 约束名（验证比对用） */
const normalizeDerivedNotNullNames = (snap: Snapshot, model: Model): Snapshot => {
  const explicitCols = new Set<string>();
  for (const col of all(model, 'column')) {
    if (!col.notNull || col.notNullName === null || col.notNullNameMode !== 'explicit') continue;
    const table = find(model, col.parent);
    if (table?.kind !== 'table') continue;
    const schema = find(model, table.parent);
    if (schema?.kind !== 'schema') continue;
    explicitCols.add(`${schema.name}.${table.name}\0${col.name}`);
  }
  const tables: Snapshot['tables'] = {};
  for (const [tableKey, table] of Object.entries(snap.tables)) {
    const columns: Snapshot['tables'][string]['columns'] = {};
    for (const [colName, col] of Object.entries(table.columns)) {
      columns[colName] =
        col.notNullName !== null && !explicitCols.has(`${tableKey}\0${colName}`)
          ? { ...col, notNullName: null }
          : col;
    }
    tables[tableKey] = { ...table, columns };
  }
  return { ...snap, tables };
};

/** 对齐线上导入模型的非显式 NOT NULL 约束名 */
const alignDerivedNotNullNames = (live: Model, target: Model): Model => {
  let objects: Model['objects'] | null = null;
  for (const tObj of Object.values(target.objects)) {
    if (tObj.kind !== 'column' || !tObj.notNull) continue;
    if (tObj.notNullNameMode === 'explicit' && tObj.notNullName !== null) continue;
    const lObj = live.objects[tObj.id];
    if (lObj?.kind !== 'column' || !lObj.notNull) continue;
    if (lObj.notNullName === tObj.notNullName && lObj.notNullNameMode === tObj.notNullNameMode) continue;
    objects ??= { ...live.objects };
    objects[tObj.id] = { ...lObj, notNullName: tObj.notNullName, notNullNameMode: tObj.notNullNameMode };
  }
  return objects ? { ...live, objects } : live;
};

// ───── PG CONCURRENTLY / DETACH CONCURRENTLY 续跑清理钩子 ─────

const CIC_HEAD = /^\s*create\s+(?:unique\s+)?index\s+concurrently\b/i;

const identAt = (s: string, from: number): { name: string; end: number } | null => {
  let i = from;
  while (/\s/.test(s[i] ?? '')) i++;
  if (s[i] === '"') {
    let out = '';
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] !== '"') out += s[j];
      else if (s[j + 1] === '"') {
        out += '"';
        j++;
      } else return { name: out, end: j + 1 };
    }
    return null;
  }
  const m = /^[A-Za-z_\u0080-][\w$\u0080-]*/.exec(s.slice(i));
  return m ? { name: m[0].toLowerCase(), end: i + m[0].length } : null;
};

export const parsePgCreateIndexConcurrently = (
  sql: string,
): { index: string; schema: string; table: string } | 'unparsed' | null => {
  const head = CIC_HEAD.exec(sql);
  if (!head) return null;
  let pos = head[0].length;
  const ine = /^\s+if\s+not\s+exists\b/i.exec(sql.slice(pos));
  if (ine) pos += ine[0].length;
  const index = identAt(sql, pos);
  if (!index) return 'unparsed';
  const on = /^\s+on\s+(?:only\s+)?/i.exec(sql.slice(index.end));
  if (!on) return 'unparsed';
  const first = identAt(sql, index.end + on[0].length);
  if (!first) return 'unparsed';
  if (sql[first.end] !== '.') return 'unparsed';
  const second = identAt(sql, first.end + 1);
  if (!second) return 'unparsed';
  return { index: index.name, schema: first.name, table: second.name };
};

const CIC_HINT =
  '（如果这条语句失败后在库里留下了无效索引，而 Dowel 没能识别出它，请先手工 DROP INDEX CONCURRENTLY 再重试）';

const qualifiedAt = (s: string, from: number): { schema: string; name: string; end: number } | null => {
  const first = identAt(s, from);
  if (!first || s[first.end] !== '.') return null;
  const second = identAt(s, first.end + 1);
  return second ? { schema: first.name, name: second.name, end: second.end } : null;
};

const DETACH_HEAD = /^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?/i;

export const parsePgDetachConcurrently = (
  sql: string,
): { parentSchema: string; parent: string; schema: string; partition: string } | 'unparsed' | null => {
  if (!/\bdetach\s+partition\b[\s\S]*\bconcurrently\b/i.test(sql)) return null;
  const head = DETACH_HEAD.exec(sql);
  if (!head) return 'unparsed';
  const parent = qualifiedAt(sql, head[0].length);
  if (!parent) return 'unparsed';
  const mid = /^(?:\s*\*)?\s+detach\s+partition\s+/i.exec(sql.slice(parent.end));
  if (!mid) return 'unparsed';
  const part = qualifiedAt(sql, parent.end + mid[0].length);
  if (!part) return 'unparsed';
  if (!/^\s+concurrently\s*;?\s*$/i.test(sql.slice(part.end))) return 'unparsed';
  return { parentSchema: parent.schema, parent: parent.name, schema: part.schema, partition: part.name };
};

const DETACH_HINT =
  '（如果分区停在了 detach pending 状态，而 Dowel 没能识别这条语句，请先手工执行 ALTER TABLE … DETACH PARTITION … FINALIZE 再处理）';

const dropLeftoverInvalidIndex = async (conn: Db, sql: string): Promise<boolean> => {
  const p = parsePgCreateIndexConcurrently(sql);
  if (p === null) return true;
  if (p === 'unparsed') return false;
  const rows = await conn.query<{ index: string }>(
    `select format('%I.%I', ni.nspname, ci.relname) as index
       from pg_index i
       join pg_class ci on ci.oid = i.indexrelid join pg_namespace ni on ni.oid = ci.relnamespace
       join pg_class ct on ct.oid = i.indrelid join pg_namespace nt on nt.oid = ct.relnamespace
      where not i.indisvalid and ci.relname = $1 and ct.relname = $2 and nt.nspname = $3`,
    [p.index, p.table, p.schema],
  );
  for (const r of rows) await conn.exec(`DROP INDEX CONCURRENTLY IF EXISTS ${r.index}`);
  return true;
};

const detachFinalizeFor = async (conn: Db, sql: string): Promise<{ sql: string | null; hint: string }> => {
  const p = parsePgDetachConcurrently(sql);
  if (p === null) return { sql: null, hint: '' };
  if (p === 'unparsed') return { sql: null, hint: DETACH_HINT };
  const [row] = await conn.query<{ parent: string; partition: string }>(
    `select format('%I.%I', pn.nspname, pc.relname) as parent, format('%I.%I', cn.nspname, cc.relname) as partition
       from pg_inherits i
       join pg_class cc on cc.oid = i.inhrelid join pg_namespace cn on cn.oid = cc.relnamespace
       join pg_class pc on pc.oid = i.inhparent join pg_namespace pn on pn.oid = pc.relnamespace
      where i.inhdetachpending and cc.relname = $1 and cn.nspname = $2 and pc.relname = $3 and pn.nspname = $4`,
    [p.partition, p.schema, p.parent, p.parentSchema],
  );
  return {
    sql: row ? `ALTER TABLE ${row.parent} DETACH PARTITION ${row.partition} FINALIZE` : null,
    hint: '',
  };
};

// ───── PG 影子库清理与风险分析 ─────

const resetPgShadow = async (db: Db): Promise<void> => {
  await pinSession(db);
  const schemas = await db.query<{ n: string }>(
    `select quote_ident(nspname) as n from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'`,
  );
  for (const { n } of schemas) await db.exec(`DROP SCHEMA ${n} CASCADE`);
};

const readPgVersionNum = async (db: Db): Promise<number | null> => {
  const rows = await db.query<{ v?: unknown; server_version_num?: unknown }>('SHOW server_version_num');
  const raw = rows[0]?.server_version_num ?? rows[0]?.v;
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(num) ? num : null;
};

const cannotRunInTransaction = (e: EngineStepError): boolean =>
  (e.cause as { code?: unknown } | null)?.code === '25001' ||
  /cannot run inside a transaction block|cannot be executed from a function|cannot be executed within a transaction|cannot run inside a subtransaction/i.test(
    e.reason,
  );

const analyzePgStepRisk = async (
  db: Db,
  from: Model,
  steps: Step[],
  opts?: PlanOptions,
): Promise<StepRisk[]> => {
  await resetPgShadow(db);
  const vNum = opts?.pgMajor !== undefined ? null : await readPgVersionNum(db);
  const pgMajor = opts?.pgMajor !== undefined ? opts.pgMajor : vNum !== null ? pgMajorOf(vNum) : null;
  await pinSession(db);
  for (const s of createAll(from, pgMajor !== null ? { pgMajor } : undefined)) {
    const t0 = performance.now();
    try {
      await db.exec(s.sql);
    } catch (e) {
      throw new EngineStepError(s, e, performance.now() - t0);
    }
  }

  const existing = new Set(
    (
      await db.query<{ oid: number }>(
        `select c.oid::int as oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p', 'i', 'm') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`,
      )
    ).map((r) => r.oid),
  );
  const nodes = async () =>
    new Map(
      (
        await db.query<{ oid: number; node: number; name: string }>(
          `select c.oid::int as oid, c.relfilenode::int as node, c.oid::regclass::text as name from pg_class c
            where c.relkind in ('r', 'm') and c.relnamespace not in (select oid from pg_namespace where nspname ~ '^pg_' or nspname = 'information_schema')`,
        )
      ).map((r) => [r.oid, r]),
    );
  const seqScans = async () =>
    new Map(
      (
        await db.query<{ oid: number; name: string; n: number }>(
          `select relid::int as oid, relid::regclass::text as name, seq_scan::int as n from pg_stat_xact_user_tables`,
        )
      ).map((r) => [r.oid, r]),
    );

  const runOutsideTransaction = async (s: Step): Promise<StepRisk> => {
    const t0 = performance.now();
    try {
      await db.exec(s.sql);
    } catch (e) {
      throw new EngineStepError(s, e, performance.now() - t0);
    }
    return { locks: [], rewrites: [], scans: [], level: 'low', note: NON_TRANSACTIONAL_NOTE };
  };

  const measureInTransaction = async (s: Step): Promise<StepRisk> => {
    const before = await nodes();
    await db.exec('BEGIN');
    let finished = false;
    let locks: { oid: number; relation: string; mode: string }[];
    let scans: { oid: number; name: string; n: number }[];
    let after: Awaited<ReturnType<typeof nodes>>;
    try {
      const scansBefore = await seqScans();
      const t0 = performance.now();
      try {
        await db.exec(s.sql);
      } catch (e) {
        throw new EngineStepError(s, e, performance.now() - t0);
      }
      locks = await db.query<{ oid: number; relation: string; mode: string }>(
        `select l.relation::int as oid, l.relation::regclass::text as relation, l.mode
           from pg_locks l where l.pid = pg_backend_pid() and l.locktype = 'relation' and l.granted`,
      );
      scans = [...(await seqScans()).values()].filter((r) => r.n > (scansBefore.get(r.oid)?.n ?? 0));
      after = await nodes();
      await db.exec('COMMIT');
      finished = true;
    } finally {
      if (!finished) await db.exec('ROLLBACK').catch(() => {});
    }
    const risk: StepRisk = {
      locks: locks.filter((l) => existing.has(l.oid)).map(({ relation, mode }) => ({ relation, mode })),
      rewrites: [...before]
        .filter(([oid, b]) => existing.has(oid) && after.get(oid) && after.get(oid)!.node !== b.node)
        .map(([, b]) => b.name),
      scans: scans.filter((x) => existing.has(x.oid)).map((x) => x.name),
      level: 'low',
    };
    const strongest = risk.locks.map((l) => l.mode);
    if (risk.rewrites.length || (risk.scans.length && strongest.some((m) => BLOCKS_READS.has(m))))
      risk.level = 'high';
    else if (risk.scans.length || strongest.some((m) => BLOCKS_WRITES.has(m) && m !== 'AccessExclusiveLock'))
      risk.level = 'medium';
    return risk;
  };

  const out: StepRisk[] = [];
  for (const s of steps) {
    if (isNontransactionalSql(s.sql, 'pg')) {
      out.push(await runOutsideTransaction(s));
      continue;
    }
    try {
      out.push(await measureInTransaction(s));
    } catch (e) {
      if (s.transactional === false && e instanceof EngineStepError && cannotRunInTransaction(e)) {
        out.push(await runOutsideTransaction(s));
        continue;
      }
      throw e;
    }
  }
  return out;
};

export const pgHistory: HistoryStore = {
  storage: 'schema',
  historyExists,
  readHistoryFormat,
  historyWriteProblem,
  ensureHistory,
  readHistory,
  recordVersion,
  startRun,
  markStep,
  finishRun,
  readProject,
  writeProject,
  claimProject,
  readClaims,
  listHistoryProjects,
  withProjectLock,
};

export const pgEngine: EngineAdapter = {
  dialect: 'pg',
  history: pgHistory,
  sessionSettings: SESSION_SETTINGS,

  sessionHeader: () => `${SESSION_SETTINGS.join(';\n')};\n`,

  pinSession,

  resetSession: async (db) => {
    await db.exec('RESET ALL');
  },

  inTransaction: async <T>(conn: Db, fn: () => Promise<T>, hooks: TxHooks = {}): Promise<T> => {
    await conn.exec('BEGIN');
    try {
      const r = await fn();
      hooks.beforeCommit?.();
      await conn.exec('COMMIT');
      hooks.afterCommit?.();
      return r;
    } catch (e) {
      await conn.exec('ROLLBACK').catch(() => {});
      throw e;
    }
  },

  execStepSql: async (conn, sql) => {
    await conn.exec(sql);
  },

  readSnapshot: async (db, only) => {
    const snap = await readSnapshot(db, only);
    const maj = pgMajorOf(snap.version);
    const minor = snap.version % 100;
    return {
      dialect: 'pg',
      version: maj !== null ? `${maj}.${minor}` : String(snap.version),
      versionNum: snap.version,
      payload: snap,
    };
  },

  importSnapshot: (snap) => importSnapshot(snap.payload as Snapshot),

  normalizeSnapshot: (snap) => normalize(snap.payload as Snapshot),

  normalizeLiveSnapshot: (snap, reference) => ({
    ...snap,
    payload: ignoreDefaultPublicCommentSnap(snap.payload as Snapshot, reference),
  }),

  normalizeForVerify: (snap, model) => ({
    ...snap,
    payload: normalizeDerivedNotNullNames(snap.payload as Snapshot, model),
  }),

  alignImportedLive: alignDerivedNotNullNames,

  diffSnapshots: (a, b) => diffSnapshots(a.payload as Snapshot, b.payload as Snapshot),

  fingerprint: (snap) => fingerprint(snap.payload as Snapshot),

  readVersionNum: readPgVersionNum,

  planOptionsForVersion: (versionNum) => {
    const pgMajor = pgMajorOf(versionNum);
    return pgMajor !== null ? { pgMajor } : undefined;
  },

  resetShadow: resetPgShadow,

  prepareImportShadow: async (db) => {
    await db.exec('CREATE SCHEMA public; SET search_path = public');
  },

  stripImportNoise: (sql) =>
    sql
      .split('\n')
      .filter((l) => !/^\s*(ALTER\s.+\sOWNER TO\s.+;|GRANT\s.+;|REVOKE\s.+;)\s*$/i.test(l))
      .join('\n'),

  analyzeStepRisk: analyzePgStepRisk,

  applyTimeouts: async (conn, timeouts, opts): Promise<AppliedTimeouts> => {
    const ms = (n: number) => Math.max(0, Math.trunc(n));
    const applied = {
      statementMs: timeouts ? ms(timeouts.statementMs) : 0,
      lockMs: timeouts && !opts?.concurrent ? ms(timeouts.lockMs) : 0,
    };
    if (applied.statementMs > 0) await conn.exec(`SET statement_timeout = ${applied.statementMs}`);
    if (applied.lockMs > 0) await conn.exec(`SET lock_timeout = ${applied.lockMs}`);
    return applied;
  },

  restoreTimeouts: async (conn, applied) => {
    if (applied.statementMs > 0) await conn.exec('RESET statement_timeout');
    if (applied.lockMs > 0) await conn.exec('RESET lock_timeout');
  },

  classifyTimeout: (err, applied): TimeoutInfo | undefined => {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === '55P03' && applied.lockMs > 0) return { kind: 'lock', ms: applied.lockMs };
    if (code === '57014' && applied.statementMs > 0) return { kind: 'statement', ms: applied.statementMs };
    return undefined;
  },

  beforeNonTxStep: async (conn, sql) => {
    const cicHint = (await dropLeftoverInvalidIndex(conn, sql)) ? '' : CIC_HINT;
    const detach = await detachFinalizeFor(conn, sql);
    return {
      ...(detach.sql ? { sql: detach.sql } : {}),
      hint: cicHint + detach.hint,
    };
  },
};
