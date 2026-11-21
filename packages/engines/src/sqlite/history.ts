// SQLite 目标库里的 Dowel 迁移历史：同库 `dowel_` 前缀表（dowel_meta / dowel_projects / dowel_versions / dowel_history / dowel_claims），
// 与 PG `dowel.*` 字段语义 1:1 对齐；历史与认领表用 BEFORE UPDATE / BEFORE DELETE 触发器（RAISE(ABORT, ...)）保护只追加语义。
import { type Model } from '@dowel/core';

import { HISTORY_FORMAT, readSteps } from '../history-common.ts';
import { canonicalSteps, stepsChecksum } from '../steps.ts';
import {
  type ClaimInput,
  type ClaimRow,
  type Db,
  HistoryError,
  type HistoryProjectSummary,
  type HistoryState,
  type HistoryStore,
  type HistoryVersionRow,
  type ProjectRow,
  type RunDirection,
  type RunRow,
  type RunStatus,
  type RunVia,
  type StartRunInput,
} from '../types.ts';
import { acquireSqliteMutex, sqliteDbKey } from './db.ts';

const REQUIRED_TABLES = ['dowel_versions', 'dowel_history', 'dowel_projects'] as const;

const parseJson = <T>(raw: unknown): T => (typeof raw === 'string' ? (JSON.parse(raw) as T) : (raw as T));
const asStr = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : '';
const asOptStr = (v: unknown): string | null => (v === null || v === undefined ? null : asStr(v));

const toVersionRow = (r: Record<string, unknown>): HistoryVersionRow => {
  const scope = r.scope ? parseJson<string[] | null>(r.scope) : null;
  return {
    projectId: asStr(r.project_id),
    versionId: asStr(r.version_id),
    number: Number(r.number),
    parentId: asOptStr(r.parent_id),
    name: asStr(r.name),
    scope: Array.isArray(scope) && scope.length ? scope : null,
    upSteps: readSteps(parseJson(r.up_steps)),
    downSteps: readSteps(parseJson(r.down_steps)),
    checksum: asStr(r.checksum),
    model: parseJson<Model>(r.model),
    fingerprint: asStr(r.fingerprint),
    publishedAt: asStr(r.published_at),
    publishedBy: asOptStr(r.published_by),
  };
};

const toRunRow = (r: Record<string, unknown>): RunRow => ({
  id: Number(r.id),
  projectId: asStr(r.project_id),
  fromVersion: asOptStr(r.from_version),
  toVersion: asStr(r.to_version),
  direction: asStr(r.direction) as RunDirection,
  status: asStr(r.status) as RunStatus,
  stepIndex: r.step_index === null || r.step_index === undefined ? null : Number(r.step_index),
  error: asOptStr(r.error),
  executedBy: asOptStr(r.executed_by),
  via: asStr(r.via) as RunVia,
  instanceId: asStr(r.instance_id),
  startedAt: asStr(r.started_at),
  finishedAt: asOptStr(r.finished_at),
});

const toProjectRow = (r: Record<string, unknown>): ProjectRow => ({
  projectId: asStr(r.project_id),
  name: asOptStr(r.name),
  instanceId: asStr(r.instance_id),
  claimedAt: asOptStr(r.claimed_at),
  claimedBy: asOptStr(r.claimed_by),
  previousInstanceId: asOptStr(r.previous_instance_id),
});

const historyExists = async (db: Db): Promise<boolean> => {
  const rows = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('dowel_versions', 'dowel_history', 'dowel_projects')`,
  );
  const set = new Set(rows.map((r) => r.name));
  return REQUIRED_TABLES.every((t) => set.has(t));
};

const readHistoryFormat = async (db: Db): Promise<number | null> => {
  if (!(await historyExists(db))) return null;
  const [metaTable] = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dowel_meta'`,
  );
  if (!metaTable) return 1;
  const [meta] = await db.query<{ value: unknown }>(
    `SELECT value FROM dowel_meta WHERE key = 'format_version'`,
  );
  const stored = meta ? Number(parseJson(meta.value)) : 1;
  if (!Number.isInteger(stored) || stored > HISTORY_FORMAT) {
    throw new HistoryError(
      'format_too_new',
      `目标库里的迁移历史是格式 ${JSON.stringify(meta?.value)}，当前 Dowel 只支持到 ${HISTORY_FORMAT}。请升级 Dowel`,
    );
  }
  return stored;
};

const historyWriteProblem = async (db: Db): Promise<HistoryError | null> => {
  try {
    await readHistoryFormat(db);
  } catch (e) {
    if (e instanceof HistoryError) return e;
    throw e;
  }
  // 检查 SQLite 数据库是否只读
  try {
    const [ro] = await db.query<{ query_only?: number }>('PRAGMA query_only');
    if (ro?.query_only === 1) {
      return new HistoryError(
        'no_schema_privilege',
        '目标 SQLite 数据库处于只读模式（query_only=1），无法写入迁移历史',
      );
    }
  } catch {
    // 忽略不支持的 PRAGMA
  }
  return null;
};

const ensureHistory = async (db: Db): Promise<void> => {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS dowel_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dowel_projects (
        project_id TEXT PRIMARY KEY,
        name TEXT,
        instance_id TEXT NOT NULL,
        claimed_at TEXT,
        claimed_by TEXT,
        previous_instance_id TEXT
      );
      CREATE TABLE IF NOT EXISTS dowel_versions (
        project_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        scope TEXT,
        up_steps TEXT NOT NULL,
        down_steps TEXT NOT NULL,
        checksum TEXT NOT NULL,
        model TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        published_at TEXT NOT NULL,
        published_by TEXT,
        PRIMARY KEY (project_id, version_id),
        UNIQUE (project_id, number)
      );
      CREATE TABLE IF NOT EXISTS dowel_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        from_version TEXT,
        to_version TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('baseline', 'up', 'down', 'mark')),
        status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
        step_index INTEGER,
        error TEXT,
        executed_by TEXT,
        via TEXT NOT NULL CHECK (via IN ('web', 'ci')),
        instance_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS dowel_history_project_id ON dowel_history (project_id, id);
      CREATE TABLE IF NOT EXISTS dowel_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        previous_instance_id TEXT,
        claimed_by TEXT,
        claimed_by_name TEXT,
        claimed_at TEXT NOT NULL,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS dowel_claims_project_id ON dowel_claims (project_id, id);

      CREATE TRIGGER IF NOT EXISTS dowel_history_no_delete
      BEFORE DELETE ON dowel_history
      BEGIN
        SELECT RAISE(ABORT, 'dowel_history 只追加，不允许删除');
      END;

      CREATE TRIGGER IF NOT EXISTS dowel_history_guard_update
      BEFORE UPDATE ON dowel_history
      BEGIN
        SELECT CASE
          WHEN OLD.status <> 'running' THEN
            RAISE(ABORT, 'dowel_history 只追加：已结束的执行记录不能再改')
          WHEN NEW.id IS NOT OLD.id
            OR NEW.project_id IS NOT OLD.project_id
            OR NEW.from_version IS NOT OLD.from_version
            OR NEW.to_version IS NOT OLD.to_version
            OR NEW.direction IS NOT OLD.direction
            OR NEW.executed_by IS NOT OLD.executed_by
            OR NEW.via IS NOT OLD.via
            OR NEW.instance_id IS NOT OLD.instance_id
            OR NEW.started_at IS NOT OLD.started_at THEN
            RAISE(ABORT, 'dowel_history 只追加：执行记录的标识字段不能改')
        END;
      END;

      CREATE TRIGGER IF NOT EXISTS dowel_claims_no_update
      BEFORE UPDATE ON dowel_claims
      BEGIN
        SELECT RAISE(ABORT, 'dowel_claims 只追加，不允许修改');
      END;

      CREATE TRIGGER IF NOT EXISTS dowel_claims_no_delete
      BEFORE DELETE ON dowel_claims
      BEGIN
        SELECT RAISE(ABORT, 'dowel_claims 只追加，不允许删除');
      END;
    `);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/readonly/i.test(msg)) {
      throw new HistoryError('no_schema_privilege', `无法在只读 SQLite 数据库中创建迁移历史表：${msg}`);
    }
    throw e;
  }

  const [meta] = await db.query<{ value: unknown }>(
    `SELECT value FROM dowel_meta WHERE key = 'format_version'`,
  );
  if (!meta) {
    await db.query(`INSERT OR IGNORE INTO dowel_meta (key, value) VALUES ('format_version', ?)`, [
      JSON.stringify(HISTORY_FORMAT),
    ]);
    return;
  }
  const stored = Number(parseJson(meta.value));
  if (!Number.isInteger(stored) || stored > HISTORY_FORMAT) {
    throw new HistoryError(
      'format_too_new',
      `目标库里的迁移历史是格式 ${JSON.stringify(meta.value)}，当前 Dowel 只支持到 ${HISTORY_FORMAT}。请升级 Dowel`,
    );
  }
};

const readHistory = async (db: Db, projectId: string): Promise<HistoryState> => {
  const versionRows = await db.query<Record<string, unknown>>(
    `SELECT * FROM dowel_versions WHERE project_id = ? ORDER BY number`,
    [projectId],
  );
  const runRows = await db.query<Record<string, unknown>>(
    `SELECT * FROM dowel_history WHERE project_id = ? ORDER BY id`,
    [projectId],
  );
  const runs = runRows.map(toRunRow);
  const done = runs.filter((r) => r.status === 'done');
  return {
    currentVersion: done.length ? done[done.length - 1]!.toVersion : null,
    versions: versionRows.map(toVersionRow),
    history: runs,
  };
};

const recordVersion = async (db: Db, row: HistoryVersionRow): Promise<void> => {
  const expected = stepsChecksum(row.upSteps, row.downSteps);
  if (row.checksum !== expected) {
    throw new HistoryError(
      'checksum_mismatch',
      `版本 ${row.versionId} 的 checksum 与脚本内容不符（传入 ${row.checksum.slice(0, 12)}…，重算 ${expected.slice(0, 12)}…）`,
    );
  }
  const [existing] = await db.query<{ checksum: string }>(
    `SELECT checksum FROM dowel_versions WHERE project_id = ? AND version_id = ?`,
    [row.projectId, row.versionId],
  );
  if (existing) {
    if (existing.checksum !== row.checksum) {
      throw new HistoryError(
        'checksum_mismatch',
        `版本 ${row.versionId} 已经以不同的内容写入过（已有 ${existing.checksum.slice(0, 12)}…，本次 ${row.checksum.slice(0, 12)}…）`,
      );
    }
    return;
  }
  try {
    await db.query(
      `INSERT INTO dowel_versions
         (project_id, version_id, number, parent_id, name, scope, up_steps, down_steps, checksum, model,
          fingerprint, published_at, published_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.projectId,
        row.versionId,
        row.number,
        row.parentId,
        row.name,
        row.scope?.length ? JSON.stringify(row.scope) : null,
        JSON.stringify(canonicalSteps(row.upSteps)),
        JSON.stringify(canonicalSteps(row.downSteps)),
        row.checksum,
        JSON.stringify(row.model),
        row.fingerprint,
        row.publishedAt,
        row.publishedBy,
      ],
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed.*dowel_versions\.project_id, dowel_versions\.number/i.test(msg)) {
      throw new HistoryError('number_conflict', `项目 ${row.projectId} 的 v${row.number} 已被另一个版本占用`);
    }
    throw e;
  }
};

const startRun = async (db: Db, run: StartRunInput): Promise<number> => {
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO dowel_history
       (project_id, from_version, to_version, direction, status, executed_by, via, instance_id, started_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)
     RETURNING id`,
    [
      run.projectId,
      run.fromVersion,
      run.toVersion,
      run.direction,
      run.executedBy,
      run.via,
      run.instanceId,
      new Date().toISOString(),
    ],
  );
  return Number(row!.id);
};

const markStep = async (db: Db, id: number, stepIndex: number): Promise<void> => {
  const rows = await db.query<{ id: number }>(
    `UPDATE dowel_history SET step_index = ? WHERE id = ? AND status = 'running' RETURNING id`,
    [stepIndex, id],
  );
  if (!rows.length) throw new HistoryError('run_not_running', `执行记录 ${id} 不存在或已经结束`);
};

const finishRun = async (
  db: Db,
  id: number,
  status: Exclude<RunStatus, 'running'>,
  error?: string | null,
): Promise<void> => {
  const rows = await db.query<{ id: number }>(
    `UPDATE dowel_history SET status = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running' RETURNING id`,
    [status, error ?? null, new Date().toISOString(), id],
  );
  if (!rows.length) throw new HistoryError('run_not_running', `执行记录 ${id} 不存在或已经结束`);
};

const readProject = async (db: Db, projectId: string): Promise<ProjectRow | null> => {
  const [r] = await db.query<Record<string, unknown>>(`SELECT * FROM dowel_projects WHERE project_id = ?`, [
    projectId,
  ]);
  return r ? toProjectRow(r) : null;
};

const writeProject = async (
  db: Db,
  row: Omit<ProjectRow, 'previousInstanceId'> & { previousInstanceId?: string | null },
): Promise<void> => {
  await db.query(
    `INSERT INTO dowel_projects (project_id, name, instance_id, claimed_at, claimed_by, previous_instance_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE
       SET name = excluded.name,
           instance_id = excluded.instance_id,
           claimed_at = excluded.claimed_at,
           claimed_by = excluded.claimed_by,
           previous_instance_id = excluded.previous_instance_id`,
    [row.projectId, row.name, row.instanceId, row.claimedAt, row.claimedBy, row.previousInstanceId ?? null],
  );
};

const claimProject = async (
  db: Db,
  input: ClaimInput,
): Promise<{ changed: boolean; previousInstanceId: string | null }> => {
  const prev = await readProject(db, input.projectId);
  if (prev?.instanceId === input.instanceId) {
    return { changed: false, previousInstanceId: prev.previousInstanceId };
  }
  const now = new Date().toISOString();
  await writeProject(db, {
    projectId: input.projectId,
    name: input.name ?? prev?.name ?? null,
    instanceId: input.instanceId,
    claimedAt: now,
    claimedBy: input.claimedBy,
    previousInstanceId: prev?.instanceId ?? null,
  });
  await db.query(
    `INSERT INTO dowel_claims
       (project_id, instance_id, previous_instance_id, claimed_by, claimed_by_name, claimed_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.projectId,
      input.instanceId,
      prev?.instanceId ?? null,
      input.claimedBy,
      input.claimedByName,
      now,
      input.note ?? null,
    ],
  );
  return { changed: true, previousInstanceId: prev?.instanceId ?? null };
};

const readClaims = async (db: Db, projectId: string): Promise<ClaimRow[]> => {
  const [tbl] = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dowel_claims'`,
  );
  if (!tbl) return [];
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM dowel_claims WHERE project_id = ? ORDER BY id`,
    [projectId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    projectId: asStr(r.project_id),
    instanceId: asStr(r.instance_id),
    previousInstanceId: asOptStr(r.previous_instance_id),
    claimedBy: asOptStr(r.claimed_by),
    claimedByName: asOptStr(r.claimed_by_name),
    claimedAt: asStr(r.claimed_at),
    note: asOptStr(r.note),
  }));
};

const listHistoryProjects = async (db: Db): Promise<HistoryProjectSummary[]> => {
  if (!(await historyExists(db))) return [];
  const rows = await db.query<Record<string, unknown>>(
    `SELECT p.project_id AS projectId, p.name, p.instance_id AS instanceId, p.claimed_at AS claimedAt,
            (SELECT count(*) FROM dowel_versions v WHERE v.project_id = p.project_id) AS versions,
            (SELECT max(v.number) FROM dowel_versions v WHERE v.project_id = p.project_id) AS headNumber,
            (SELECT v.number FROM dowel_history h
               JOIN dowel_versions v ON v.project_id = h.project_id AND v.version_id = h.to_version
              WHERE h.project_id = p.project_id AND h.status = 'done' ORDER BY h.id DESC LIMIT 1) AS currentNumber,
            (SELECT max(coalesce(h.finished_at, h.started_at)) FROM dowel_history h
              WHERE h.project_id = p.project_id) AS lastRunAt
       FROM dowel_projects p
      ORDER BY (p.name IS NULL), p.name, p.project_id`,
  );
  return rows.map((r) => ({
    projectId: asStr(r.projectId),
    name: asOptStr(r.name),
    instanceId: asStr(r.instanceId),
    claimedAt: asOptStr(r.claimedAt),
    versions: Number(r.versions),
    headNumber: r.headNumber === null || r.headNumber === undefined ? null : Number(r.headNumber),
    currentNumber: r.currentNumber === null || r.currentNumber === undefined ? null : Number(r.currentNumber),
    lastRunAt: asOptStr(r.lastRunAt),
  }));
};

const withProjectLock = async <T>(
  db: Db,
  projectId: string,
  timeoutMs: number,
  fn: (conn: Db) => Promise<T>,
): Promise<T> => {
  const lockKey = `${sqliteDbKey(db)}::${projectId}`;
  let release: (() => void) | null = null;
  try {
    release = await acquireSqliteMutex(lockKey, timeoutMs);
  } catch {
    throw new HistoryError('lock_timeout', `等待项目锁超时（${timeoutMs}ms）：这个项目正在被另一个执行占用`);
  }
  try {
    return await fn(db);
  } finally {
    release();
  }
};

export const sqliteHistory: HistoryStore = {
  storage: 'prefix',
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
