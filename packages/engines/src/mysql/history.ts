// MySQL 目标库里的 Dowel 迁移历史：同库 `dowel_` 前缀表（dowel_meta / dowel_projects / dowel_versions / dowel_history / dowel_claims）。
// 使用 BEFORE UPDATE / BEFORE DELETE 触发器强制 dowel_history 与 dowel_claims 只追加语义；
// 使用独占连接上的 GET_LOCK / RELEASE_LOCK 实现跨实例项目互斥锁（释放失败时销毁连接防锁泄漏）。
import { createHash } from 'node:crypto';

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
import { destroyMysqlConn } from './db.ts';

const REQUIRED_TABLES = ['dowel_versions', 'dowel_history', 'dowel_projects'] as const;

const parseJson = <T>(raw: unknown): T => (typeof raw === 'string' ? (JSON.parse(raw) as T) : (raw as T));
const asStr = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : '';
const asOptStr = (v: unknown): string | null => (v === null || v === undefined ? null : asStr(v));

const mysqlErrno = (e: unknown): number | null => {
  const n = (e as { errno?: unknown } | null)?.errno;
  return typeof n === 'number' ? n : null;
};

const mysqlCode = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : null;
};

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

const withSingleConn = async <T>(db: Db, fn: (conn: Db) => Promise<T>): Promise<T> => {
  if (!db.reserve) return fn(db);
  const conn = await db.reserve();
  try {
    return await fn(conn);
  } finally {
    conn.release?.();
  }
};

const historyExists = async (db: Db): Promise<boolean> => {
  const rows = await db.query<{ name: string }>(
    `SELECT TABLE_NAME AS name
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_NAME IN ('dowel_versions', 'dowel_history', 'dowel_projects')`,
  );
  const set = new Set(rows.map((r) => r.name.toLowerCase()));
  return REQUIRED_TABLES.every((t) => set.has(t));
};

const tableExists = async (db: Db, tableName: string): Promise<boolean> => {
  const rows = await db.query<{ name: string }>(
    `SELECT TABLE_NAME AS name
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_NAME = ?`,
    [tableName],
  );
  return rows.length > 0;
};

const triggerExists = async (db: Db, triggerName: string): Promise<boolean> => {
  const rows = await db.query<{ name: string }>(
    `SELECT TRIGGER_NAME AS name
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
        AND TRIGGER_NAME = ?`,
    [triggerName],
  );
  return rows.length > 0;
};

const readHistoryFormat = async (db: Db): Promise<number | null> => {
  if (!(await historyExists(db))) return null;
  if (!(await tableExists(db, 'dowel_meta'))) return 1;
  const [meta] = await db.query<{ value: unknown }>('SELECT `value` FROM `dowel_meta` WHERE `key` = ?', [
    'format_version',
  ]);
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
  try {
    const [ro] = await db.query<{ ro: number | string; sro: number | string; dbName: string | null }>(
      'SELECT @@read_only AS ro, @@super_read_only AS sro, DATABASE() AS dbName',
    );
    if (Number(ro?.ro) === 1 || Number(ro?.sro) === 1) {
      return new HistoryError(
        'no_schema_privilege',
        '目标 MySQL 实例处于只读模式（read_only / super_read_only），无法写入迁移历史',
      );
    }
    const dbName = ro?.dbName ?? '';
    const grants = await db.query<Record<string, unknown>>('SHOW GRANTS FOR CURRENT_USER()');
    const grantLines = grants.map((r) => asStr(Object.values(r)[0]));
    const relevant = grantLines.filter((line) => {
      if (/ON \*\.\*/i.test(line)) return true;
      if (!dbName) return false;
      const escaped = dbName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`ON\\s+\`?${escaped}\`?\\.\\*`, 'i').test(line);
    });
    if (relevant.length > 0) {
      const hasAll = relevant.some((l) => /GRANT\s+ALL\s+PRIVILEGES\b/i.test(l));
      if (!hasAll) {
        const needed = ['CREATE', 'INSERT', 'UPDATE', 'TRIGGER'] as const;
        const missing = needed.filter(
          (priv) => !relevant.some((l) => new RegExp(`\\b${priv}\\b`, 'i').test(l)),
        );
        if (missing.length > 0 && !(await historyExists(db))) {
          return new HistoryError(
            'no_schema_privilege',
            `当前 MySQL 账号缺少在库 \`${dbName}\` 初始化迁移历史所需的权限（缺少 ${missing.join('、')}）`,
          );
        }
      }
    }
  } catch {
    // 某些受限托管 MySQL 不允许 SHOW GRANTS 或系统变量检查，交由真实建表阶段捕获
  }
  return null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mysqlLockKey = (prefix: string, raw: string): string =>
  `${prefix}${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`;

const acquireMysqlAdvisoryLock = async (conn: Db, lockName: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const [r] = await conn.query<{ ok: number | string | null }>('SELECT GET_LOCK(?, 0) AS ok', [lockName]);
    if (Number(r?.ok) === 1) return;
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new HistoryError(
        'lock_timeout',
        `等待项目锁超时（${timeoutMs}ms）：这个项目正在被另一个执行占用`,
      );
    }
    await sleep(Math.min(100, left));
  }
};

const releaseMysqlAdvisoryLock = async (conn: Db, lockName: string): Promise<boolean> =>
  conn
    .query<{ ok: number | string | null }>('SELECT RELEASE_LOCK(?) AS ok', [lockName])
    .then((rows) => Number(rows[0]?.ok) === 1)
    .catch(() => false);

const ensureHistory = async (db: Db): Promise<void> => {
  const reserved = db.reserve ? await db.reserve() : null;
  const conn = reserved ?? db;
  const [dbRow] = await conn.query<{ dbName: string | null }>('SELECT DATABASE() AS dbName');
  const lockName = mysqlLockKey('dowel:init:', dbRow?.dbName ?? 'default');
  let locked = false;
  let broken = false;

  try {
    await acquireMysqlAdvisoryLock(conn, lockName, 15_000);
    locked = true;

    const ddlStatements = [
      `CREATE TABLE IF NOT EXISTS \`dowel_meta\` (
        \`key\` VARCHAR(128) NOT NULL PRIMARY KEY,
        \`value\` LONGTEXT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE IF NOT EXISTS \`dowel_projects\` (
        \`project_id\` VARCHAR(191) NOT NULL PRIMARY KEY,
        \`name\` VARCHAR(255) NULL,
        \`instance_id\` VARCHAR(191) NOT NULL,
        \`claimed_at\` VARCHAR(64) NULL,
        \`claimed_by\` VARCHAR(191) NULL,
        \`previous_instance_id\` VARCHAR(191) NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE IF NOT EXISTS \`dowel_versions\` (
        \`project_id\` VARCHAR(191) NOT NULL,
        \`version_id\` VARCHAR(191) NOT NULL,
        \`number\` INT NOT NULL,
        \`parent_id\` VARCHAR(191) NULL,
        \`name\` VARCHAR(255) NOT NULL,
        \`scope\` LONGTEXT NULL,
        \`up_steps\` LONGTEXT NOT NULL,
        \`down_steps\` LONGTEXT NOT NULL,
        \`checksum\` VARCHAR(128) NOT NULL,
        \`model\` LONGTEXT NOT NULL,
        \`fingerprint\` VARCHAR(128) NOT NULL,
        \`published_at\` VARCHAR(64) NOT NULL,
        \`published_by\` VARCHAR(191) NULL,
        PRIMARY KEY (\`project_id\`, \`version_id\`),
        UNIQUE KEY \`dowel_versions_project_number\` (\`project_id\`, \`number\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE IF NOT EXISTS \`dowel_history\` (
        \`id\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`project_id\` VARCHAR(191) NOT NULL,
        \`from_version\` VARCHAR(191) NULL,
        \`to_version\` VARCHAR(191) NOT NULL,
        \`direction\` VARCHAR(32) NOT NULL,
        \`status\` VARCHAR(32) NOT NULL,
        \`step_index\` INT NULL,
        \`error\` LONGTEXT NULL,
        \`executed_by\` VARCHAR(191) NULL,
        \`via\` VARCHAR(16) NOT NULL,
        \`instance_id\` VARCHAR(191) NOT NULL,
        \`started_at\` VARCHAR(64) NOT NULL,
        \`finished_at\` VARCHAR(64) NULL,
        CONSTRAINT \`dowel_history_direction_chk\` CHECK (\`direction\` IN ('baseline', 'up', 'down', 'mark')),
        CONSTRAINT \`dowel_history_status_chk\` CHECK (\`status\` IN ('running', 'done', 'failed')),
        CONSTRAINT \`dowel_history_via_chk\` CHECK (\`via\` IN ('web', 'ci')),
        KEY \`dowel_history_project_id\` (\`project_id\`, \`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE IF NOT EXISTS \`dowel_claims\` (
        \`id\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`project_id\` VARCHAR(191) NOT NULL,
        \`instance_id\` VARCHAR(191) NOT NULL,
        \`previous_instance_id\` VARCHAR(191) NULL,
        \`claimed_by\` VARCHAR(191) NULL,
        \`claimed_by_name\` VARCHAR(255) NULL,
        \`claimed_at\` VARCHAR(64) NOT NULL,
        \`note\` LONGTEXT NULL,
        KEY \`dowel_claims_project_id\` (\`project_id\`, \`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    ];

    for (const stmt of ddlStatements) {
      await conn.exec(stmt);
    }

    // 触发器强制 dowel_history 与 dowel_claims 只追加语义
    const triggers: { name: string; sql: string }[] = [
      {
        name: 'dowel_history_no_delete',
        sql: `CREATE TRIGGER \`dowel_history_no_delete\`
              BEFORE DELETE ON \`dowel_history\`
              FOR EACH ROW
              SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dowel_history 只追加，不允许删除'`,
      },
      {
        name: 'dowel_history_guard_update',
        sql: `CREATE TRIGGER \`dowel_history_guard_update\`
              BEFORE UPDATE ON \`dowel_history\`
              FOR EACH ROW
              BEGIN
                IF OLD.status <> 'running' THEN
                  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dowel_history 只追加：已结束的执行记录不能再改';
                END IF;
                IF NOT (
                  NEW.id <=> OLD.id
                  AND NEW.project_id <=> OLD.project_id
                  AND NEW.from_version <=> OLD.from_version
                  AND NEW.to_version <=> OLD.to_version
                  AND NEW.direction <=> OLD.direction
                  AND NEW.executed_by <=> OLD.executed_by
                  AND NEW.via <=> OLD.via
                  AND NEW.instance_id <=> OLD.instance_id
                  AND NEW.started_at <=> OLD.started_at
                ) THEN
                  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dowel_history 只追加：执行记录的标识字段不能改';
                END IF;
              END`,
      },
      {
        name: 'dowel_claims_no_update',
        sql: `CREATE TRIGGER \`dowel_claims_no_update\`
              BEFORE UPDATE ON \`dowel_claims\`
              FOR EACH ROW
              SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dowel_claims 只追加，不允许修改'`,
      },
      {
        name: 'dowel_claims_no_delete',
        sql: `CREATE TRIGGER \`dowel_claims_no_delete\`
              BEFORE DELETE ON \`dowel_claims\`
              FOR EACH ROW
              SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dowel_claims 只追加，不允许删除'`,
      },
    ];

    for (const tr of triggers) {
      if (!(await triggerExists(conn, tr.name))) {
        await conn.exec(tr.sql);
      }
    }

    const [meta] = await conn.query<{ value: unknown }>('SELECT `value` FROM `dowel_meta` WHERE `key` = ?', [
      'format_version',
    ]);
    if (!meta) {
      await conn.query('INSERT IGNORE INTO `dowel_meta` (`key`, `value`) VALUES (?, ?)', [
        'format_version',
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
  } catch (e) {
    if (e instanceof HistoryError) throw e;
    const errno = mysqlErrno(e);
    if (errno === 1044 || errno === 1142 || errno === 1227 || errno === 1290 || errno === 1419) {
      throw new HistoryError(
        'no_schema_privilege',
        `在 MySQL 目标库初始化迁移历史表或触发器被拒绝：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    throw e;
  } finally {
    if (locked) {
      const ok = await releaseMysqlAdvisoryLock(conn, lockName);
      if (!ok) broken = true;
    }
    if (reserved) {
      if (broken) destroyMysqlConn(reserved);
      else reserved.release?.();
    }
  }
};

const readHistory = async (db: Db, projectId: string): Promise<HistoryState> => {
  const versionRows = await db.query<Record<string, unknown>>(
    'SELECT * FROM `dowel_versions` WHERE `project_id` = ? ORDER BY `number`',
    [projectId],
  );
  const runRows = await db.query<Record<string, unknown>>(
    'SELECT * FROM `dowel_history` WHERE `project_id` = ? ORDER BY `id`',
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
    'SELECT `checksum` FROM `dowel_versions` WHERE `project_id` = ? AND `version_id` = ?',
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
      `INSERT INTO \`dowel_versions\`
         (\`project_id\`, \`version_id\`, \`number\`, \`parent_id\`, \`name\`, \`scope\`,
          \`up_steps\`, \`down_steps\`, \`checksum\`, \`model\`, \`fingerprint\`, \`published_at\`, \`published_by\`)
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
    if (mysqlErrno(e) === 1062 || mysqlCode(e) === 'ER_DUP_ENTRY') {
      const [after] = await db.query<{ checksum: string }>(
        'SELECT `checksum` FROM `dowel_versions` WHERE `project_id` = ? AND `version_id` = ?',
        [row.projectId, row.versionId],
      );
      if (after) {
        if (after.checksum !== row.checksum) {
          throw new HistoryError(
            'checksum_mismatch',
            `版本 ${row.versionId} 已经以不同的内容写入过（已有 ${after.checksum.slice(0, 12)}…，本次 ${row.checksum.slice(0, 12)}…）`,
          );
        }
        return;
      }
      throw new HistoryError('number_conflict', `项目 ${row.projectId} 的 v${row.number} 已被另一个版本占用`);
    }
    throw e;
  }
};

const startRun = async (db: Db, run: StartRunInput): Promise<number> =>
  withSingleConn(db, async (conn) => {
    await conn.query(
      `INSERT INTO \`dowel_history\`
         (\`project_id\`, \`from_version\`, \`to_version\`, \`direction\`, \`status\`,
          \`executed_by\`, \`via\`, \`instance_id\`, \`started_at\`)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
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
    const [row] = await conn.query<{ id: number | string }>('SELECT LAST_INSERT_ID() AS id');
    return Number(row!.id);
  });

const markStep = async (db: Db, id: number, stepIndex: number): Promise<void> =>
  withSingleConn(db, async (conn) => {
    await conn.query("UPDATE `dowel_history` SET `step_index` = ? WHERE `id` = ? AND `status` = 'running'", [
      stepIndex,
      id,
    ]);
    const [rc] = await conn.query<{ n: number | string }>('SELECT ROW_COUNT() AS n');
    if (Number(rc?.n) === 0) {
      // MySQL 默认 ROW_COUNT() 在新值与旧值相同时返回 0，复查记录状态以区分幂等写入与非 running
      const [cur] = await conn.query<{ status: string }>(
        'SELECT `status` FROM `dowel_history` WHERE `id` = ?',
        [id],
      );
      if (!cur || cur.status !== 'running') {
        throw new HistoryError('run_not_running', `执行记录 ${id} 不存在或已经结束`);
      }
    }
  });

const finishRun = async (
  db: Db,
  id: number,
  status: Exclude<RunStatus, 'running'>,
  error?: string | null,
): Promise<void> =>
  withSingleConn(db, async (conn) => {
    await conn.query(
      "UPDATE `dowel_history` SET `status` = ?, `error` = ?, `finished_at` = ? WHERE `id` = ? AND `status` = 'running'",
      [status, error ?? null, new Date().toISOString(), id],
    );
    const [rc] = await conn.query<{ n: number | string }>('SELECT ROW_COUNT() AS n');
    if (Number(rc?.n) === 0) {
      throw new HistoryError('run_not_running', `执行记录 ${id} 不存在或已经结束`);
    }
  });

const readProject = async (db: Db, projectId: string): Promise<ProjectRow | null> => {
  const [r] = await db.query<Record<string, unknown>>(
    'SELECT * FROM `dowel_projects` WHERE `project_id` = ?',
    [projectId],
  );
  return r ? toProjectRow(r) : null;
};

const writeProject = async (
  db: Db,
  row: Omit<ProjectRow, 'previousInstanceId'> & { previousInstanceId?: string | null },
): Promise<void> => {
  await db.query(
    `INSERT INTO \`dowel_projects\`
       (\`project_id\`, \`name\`, \`instance_id\`, \`claimed_at\`, \`claimed_by\`, \`previous_instance_id\`)
     VALUES (?, ?, ?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       \`name\` = new_row.\`name\`,
       \`instance_id\` = new_row.\`instance_id\`,
       \`claimed_at\` = new_row.\`claimed_at\`,
       \`claimed_by\` = new_row.\`claimed_by\`,
       \`previous_instance_id\` = new_row.\`previous_instance_id\``,
    [row.projectId, row.name, row.instanceId, row.claimedAt, row.claimedBy, row.previousInstanceId ?? null],
  );
};

const claimProject = async (
  db: Db,
  input: ClaimInput,
): Promise<{ changed: boolean; previousInstanceId: string | null }> => {
  const [cur] = await db.query<Record<string, unknown>>(
    'SELECT * FROM `dowel_projects` WHERE `project_id` = ? FOR UPDATE',
    [input.projectId],
  );
  const prev = cur ? toProjectRow(cur) : null;
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
    `INSERT INTO \`dowel_claims\`
       (\`project_id\`, \`instance_id\`, \`previous_instance_id\`, \`claimed_by\`, \`claimed_by_name\`, \`claimed_at\`, \`note\`)
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
  if (!(await tableExists(db, 'dowel_claims'))) return [];
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM `dowel_claims` WHERE `project_id` = ? ORDER BY `id`',
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
    `SELECT p.\`project_id\` AS projectId,
            p.\`name\`,
            p.\`instance_id\` AS instanceId,
            p.\`claimed_at\` AS claimedAt,
            (SELECT COUNT(*) FROM \`dowel_versions\` v WHERE v.\`project_id\` = p.\`project_id\`) AS versions,
            (SELECT MAX(v.\`number\`) FROM \`dowel_versions\` v WHERE v.\`project_id\` = p.\`project_id\`) AS headNumber,
            (SELECT v.\`number\` FROM \`dowel_history\` h
               JOIN \`dowel_versions\` v ON v.\`project_id\` = h.\`project_id\` AND v.\`version_id\` = h.\`to_version\`
              WHERE h.\`project_id\` = p.\`project_id\` AND h.\`status\` = 'done'
              ORDER BY h.\`id\` DESC LIMIT 1) AS currentNumber,
            (SELECT MAX(COALESCE(h.\`finished_at\`, h.\`started_at\`)) FROM \`dowel_history\` h
              WHERE h.\`project_id\` = p.\`project_id\`) AS lastRunAt
       FROM \`dowel_projects\` p
      ORDER BY (p.\`name\` IS NULL), p.\`name\`, p.\`project_id\``,
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

/**
 * 跨实例项目互斥锁：在独占连接上使用 MySQL `GET_LOCK` / `RELEASE_LOCK`。
 * 释放锁失败时直接销毁连接（防会话级锁泄漏回连接池）。
 */
const withProjectLock = async <T>(
  db: Db,
  projectId: string,
  timeoutMs: number,
  fn: (conn: Db) => Promise<T>,
): Promise<T> => {
  const reserved = db.reserve ? await db.reserve() : null;
  const conn = reserved ?? db;
  const lockName = mysqlLockKey('dowel:proj:', projectId);
  let locked = false;
  let broken = false;

  try {
    await acquireMysqlAdvisoryLock(conn, lockName, timeoutMs);
    locked = true;
    return await fn(conn);
  } finally {
    if (locked) {
      if (reserved) await conn.exec('ROLLBACK').catch(() => {});
      const unlocked = await releaseMysqlAdvisoryLock(conn, lockName);
      if (!unlocked) {
        broken = true;
        console.error(`释放 MySQL 项目锁失败：${projectId}（将销毁连接以确保会话锁释放）`);
      }
    }
    if (reserved) {
      if (broken) destroyMysqlConn(reserved);
      else reserved.release?.();
    }
  }
};

export const mysqlHistory: HistoryStore = {
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
