// MSSQL 目标库里的 Dowel 迁移历史：固定放在 [dowel] schema 下，
// 包含 [dowel].[meta] / [dowel].[projects] / [dowel].[versions] / [dowel].[history] / [dowel].[claims]；
// 用 AFTER UPDATE, DELETE 触发器保护只追加语义，用独占单连接上的 Session 级 sp_getapplock 实现项目互斥锁。
import { type Model, mssqlIdent } from '@dowel/core';

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
import { mssqlErrorNumber } from './db.ts';
import { MSSQL_DOWEL_SCHEMA } from './snapshot.ts';

const S = mssqlIdent(MSSQL_DOWEL_SCHEMA);

const parseJson = <T>(raw: unknown): T => (typeof raw === 'string' ? (JSON.parse(raw) as T) : (raw as T));
const asStr = (v: unknown): string =>
  v instanceof Date
    ? v.toISOString()
    : typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'bigint'
        ? String(v)
        : '';
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

interface MssqlPriv {
  role: string;
  database: string;
  schemaExists: boolean;
  canCreateSchema: boolean;
  canCreateTable: boolean;
  canAlterSchema: boolean;
}

const readPriv = async (db: Db): Promise<MssqlPriv> => {
  const [r] = await db.query<{
    role: string;
    database: string;
    schemaExists: number;
    canCreateSchema: number;
    canCreateTable: number;
    canAlterSchema: number;
  }>(
    `SELECT USER_NAME() AS role,
            DB_NAME() AS [database],
            CASE WHEN SCHEMA_ID(@p1) IS NOT NULL THEN 1 ELSE 0 END AS schemaExists,
            ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE SCHEMA'), 0) AS canCreateSchema,
            ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE'), 0) AS canCreateTable,
            CASE WHEN SCHEMA_ID(@p1) IS NOT NULL
                 THEN ISNULL(HAS_PERMS_BY_NAME(@p1, 'SCHEMA', 'ALTER'), 0)
                 ELSE 0 END AS canAlterSchema`,
    [MSSQL_DOWEL_SCHEMA],
  );
  return {
    role: r?.role ?? 'unknown',
    database: r?.database ?? '',
    schemaExists: Number(r?.schemaExists ?? 0) === 1,
    canCreateSchema: Number(r?.canCreateSchema ?? 0) === 1,
    canCreateTable: Number(r?.canCreateTable ?? 0) === 1,
    canAlterSchema: Number(r?.canAlterSchema ?? 0) === 1,
  };
};

const privProblem = (p: MssqlPriv): HistoryError | null => {
  if (!p.schemaExists && !p.canCreateSchema) {
    return new HistoryError(
      'no_schema_privilege',
      `需要在目标库里建 \`${MSSQL_DOWEL_SCHEMA}\` schema 来存迁移历史，但账号 ${p.role} 没有在库 ${p.database} 里建 schema 的权限。` +
        `请让 DBA 预先执行 \`CREATE SCHEMA ${S} AUTHORIZATION ${mssqlIdent(p.role)};\` 或授予 \`GRANT CREATE SCHEMA TO ${mssqlIdent(p.role)};\``,
    );
  }
  if (!p.canCreateTable) {
    return new HistoryError(
      'no_schema_privilege',
      `账号 ${p.role} 缺少在库 ${p.database} 中建表的权限（CREATE TABLE），无法初始化 \`${MSSQL_DOWEL_SCHEMA}\` 迁移历史表。`,
    );
  }
  if (p.schemaExists && !p.canAlterSchema) {
    return new HistoryError(
      'no_schema_privilege',
      `\`${MSSQL_DOWEL_SCHEMA}\` schema 已存在，但账号 ${p.role} 缺少该 schema 的 ALTER 权限。请让 DBA 执行 \`GRANT ALTER, SELECT, INSERT, UPDATE ON SCHEMA::${S} TO ${mssqlIdent(p.role)};\``,
    );
  }
  return null;
};

const historyExists = async (db: Db): Promise<boolean> => {
  const rows = await db.query<{ name: string }>(
    `SELECT t.name
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = @p1 AND t.name IN (N'versions', N'history', N'projects')`,
    [MSSQL_DOWEL_SCHEMA],
  );
  const set = new Set(rows.map((r) => r.name.toLowerCase()));
  return set.has('versions') && set.has('history') && set.has('projects');
};

const readHistoryFormat = async (db: Db): Promise<number | null> => {
  if (!(await historyExists(db))) return null;
  const [metaTable] = await db.query<{ ok: number }>(
    `SELECT CASE WHEN OBJECT_ID(N'${S}.[meta]', N'U') IS NOT NULL THEN 1 ELSE 0 END AS ok`,
  );
  if (!metaTable?.ok) return 1;
  const [meta] = await db.query<{ value: string }>(
    `SELECT [value] FROM ${S}.[meta] WHERE [key] = N'format_version'`,
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
  const p = await readPriv(db);
  const prob = privProblem(p);
  if (prob) return prob;
  try {
    await readHistoryFormat(db);
  } catch (e) {
    if (e instanceof HistoryError) return e;
    throw e;
  }
  return null;
};

const HISTORY_GUARD_TRIGGER_DDL = `CREATE TRIGGER ${S}.[tr_history_guard]
ON ${S}.[history]
AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted)
  BEGIN
    THROW 50001, N'dowel.history 只追加，不允许修改已完成记录或删除', 1;
  END
  IF EXISTS (SELECT 1 FROM deleted WHERE [status] <> N'running')
  BEGIN
    THROW 50001, N'dowel.history 只追加，不允许修改已完成记录或删除', 1;
  END
  IF EXISTS (
    SELECT 1
      FROM deleted d
      LEFT JOIN inserted i ON i.[id] = d.[id]
     WHERE i.[id] IS NULL
        OR d.[project_id] <> i.[project_id]
        OR ISNULL(d.[from_version], N'') <> ISNULL(i.[from_version], N'')
        OR CASE WHEN d.[from_version] IS NULL THEN 1 ELSE 0 END <> CASE WHEN i.[from_version] IS NULL THEN 1 ELSE 0 END
        OR d.[to_version] <> i.[to_version]
        OR d.[direction] <> i.[direction]
        OR ISNULL(d.[executed_by], N'') <> ISNULL(i.[executed_by], N'')
        OR CASE WHEN d.[executed_by] IS NULL THEN 1 ELSE 0 END <> CASE WHEN i.[executed_by] IS NULL THEN 1 ELSE 0 END
        OR d.[via] <> i.[via]
        OR d.[instance_id] <> i.[instance_id]
        OR d.[started_at] <> i.[started_at]
  )
  BEGIN
    THROW 50001, N'dowel.history 只追加，不允许修改已完成记录或删除', 1;
  END
END`;

const CLAIMS_GUARD_TRIGGER_DDL = `CREATE TRIGGER ${S}.[tr_claims_guard]
ON ${S}.[claims]
AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 50002, N'dowel.claims 只追加，不允许修改或删除', 1;
END`;

const ensureHistory = async (db: Db): Promise<void> => {
  const p = await readPriv(db);
  const prob = privProblem(p);
  if (prob) throw prob;

  try {
    if (!p.schemaExists) {
      await db.exec(`IF SCHEMA_ID(N'${MSSQL_DOWEL_SCHEMA}') IS NULL EXEC(N'CREATE SCHEMA ${S}');`);
    }
    await db.exec(`
      IF OBJECT_ID(N'${S}.[meta]', N'U') IS NULL
      BEGIN
        CREATE TABLE ${S}.[meta] (
          [key] NVARCHAR(128) NOT NULL PRIMARY KEY,
          [value] NVARCHAR(MAX) NOT NULL
        );
      END

      IF OBJECT_ID(N'${S}.[projects]', N'U') IS NULL
      BEGIN
        CREATE TABLE ${S}.[projects] (
          [project_id] NVARCHAR(128) NOT NULL PRIMARY KEY,
          [name] NVARCHAR(256) NULL,
          [instance_id] NVARCHAR(128) NOT NULL,
          [claimed_at] NVARCHAR(64) NULL,
          [claimed_by] NVARCHAR(128) NULL,
          [previous_instance_id] NVARCHAR(128) NULL
        );
      END

      IF OBJECT_ID(N'${S}.[versions]', N'U') IS NULL
      BEGIN
        CREATE TABLE ${S}.[versions] (
          [project_id] NVARCHAR(128) NOT NULL,
          [version_id] NVARCHAR(128) NOT NULL,
          [number] INT NOT NULL,
          [parent_id] NVARCHAR(128) NULL,
          [name] NVARCHAR(256) NOT NULL,
          [scope] NVARCHAR(MAX) NULL,
          [up_steps] NVARCHAR(MAX) NOT NULL,
          [down_steps] NVARCHAR(MAX) NOT NULL,
          [checksum] NVARCHAR(128) NOT NULL,
          [model] NVARCHAR(MAX) NOT NULL,
          [fingerprint] NVARCHAR(128) NOT NULL,
          [published_at] NVARCHAR(64) NOT NULL,
          [published_by] NVARCHAR(128) NULL,
          CONSTRAINT [PK_dowel_versions] PRIMARY KEY ([project_id], [version_id]),
          CONSTRAINT [UQ_dowel_versions_number] UNIQUE ([project_id], [number])
        );
      END

      IF OBJECT_ID(N'${S}.[history]', N'U') IS NULL
      BEGIN
        CREATE TABLE ${S}.[history] (
          [id] BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          [project_id] NVARCHAR(128) NOT NULL,
          [from_version] NVARCHAR(128) NULL,
          [to_version] NVARCHAR(128) NOT NULL,
          [direction] NVARCHAR(32) NOT NULL CONSTRAINT [CK_dowel_history_dir] CHECK ([direction] IN (N'baseline', N'up', N'down', N'mark')),
          [status] NVARCHAR(32) NOT NULL CONSTRAINT [CK_dowel_history_status] CHECK ([status] IN (N'running', N'done', N'failed')),
          [step_index] INT NULL,
          [error] NVARCHAR(MAX) NULL,
          [executed_by] NVARCHAR(128) NULL,
          [via] NVARCHAR(16) NOT NULL CONSTRAINT [CK_dowel_history_via] CHECK ([via] IN (N'web', N'ci')),
          [instance_id] NVARCHAR(128) NOT NULL,
          [started_at] NVARCHAR(64) NOT NULL,
          [finished_at] NVARCHAR(64) NULL
        );
      END

      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'${S}.[history]') AND name = N'IX_dowel_history_project_id')
      BEGIN
        CREATE INDEX [IX_dowel_history_project_id] ON ${S}.[history] ([project_id], [id]);
      END

      IF OBJECT_ID(N'${S}.[claims]', N'U') IS NULL
      BEGIN
        CREATE TABLE ${S}.[claims] (
          [id] BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          [project_id] NVARCHAR(128) NOT NULL,
          [instance_id] NVARCHAR(128) NOT NULL,
          [previous_instance_id] NVARCHAR(128) NULL,
          [claimed_by] NVARCHAR(128) NULL,
          [claimed_by_name] NVARCHAR(256) NULL,
          [claimed_at] NVARCHAR(64) NOT NULL,
          [note] NVARCHAR(MAX) NULL
        );
      END

      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'${S}.[claims]') AND name = N'IX_dowel_claims_project_id')
      BEGIN
        CREATE INDEX [IX_dowel_claims_project_id] ON ${S}.[claims] ([project_id], [id]);
      END
    `);

    const [hasHistTrig] = await db.query<{ ok: number }>(
      `SELECT CASE WHEN OBJECT_ID(N'${S}.[tr_history_guard]', N'TR') IS NOT NULL THEN 1 ELSE 0 END AS ok`,
    );
    if (!hasHistTrig?.ok) await db.exec(HISTORY_GUARD_TRIGGER_DDL);

    const [hasClaimsTrig] = await db.query<{ ok: number }>(
      `SELECT CASE WHEN OBJECT_ID(N'${S}.[tr_claims_guard]', N'TR') IS NOT NULL THEN 1 ELSE 0 END AS ok`,
    );
    if (!hasClaimsTrig?.ok) await db.exec(CLAIMS_GUARD_TRIGGER_DDL);
  } catch (e) {
    const num = mssqlErrorNumber(e);
    if (num === 229 || num === 262 || num === 2760) {
      throw new HistoryError(
        'no_schema_privilege',
        `在 \`${MSSQL_DOWEL_SCHEMA}\` schema 里建表被拒绝（账号 ${p.role}）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    throw e;
  }

  const [meta] = await db.query<{ value: string }>(
    `SELECT [value] FROM ${S}.[meta] WHERE [key] = N'format_version'`,
  );
  if (!meta) {
    await db.query(
      `IF NOT EXISTS (SELECT 1 FROM ${S}.[meta] WHERE [key] = N'format_version')
         INSERT INTO ${S}.[meta] ([key], [value]) VALUES (N'format_version', @p1)`,
      [JSON.stringify(HISTORY_FORMAT)],
    );
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
    `SELECT * FROM ${S}.[versions] WHERE [project_id] = @p1 ORDER BY [number]`,
    [projectId],
  );
  const runRows = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${S}.[history] WHERE [project_id] = @p1 ORDER BY [id]`,
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
    `SELECT [checksum] FROM ${S}.[versions] WHERE [project_id] = @p1 AND [version_id] = @p2`,
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
      `INSERT INTO ${S}.[versions]
         ([project_id], [version_id], [number], [parent_id], [name], [scope], [up_steps], [down_steps],
          [checksum], [model], [fingerprint], [published_at], [published_by])
       VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8, @p9, @p10, @p11, @p12, @p13)`,
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
    const num = mssqlErrorNumber(e);
    if (num === 2627 || num === 2601) {
      const [cur] = await db.query<{ checksum: string }>(
        `SELECT [checksum] FROM ${S}.[versions] WHERE [project_id] = @p1 AND [version_id] = @p2`,
        [row.projectId, row.versionId],
      );
      if (cur) {
        if (cur.checksum !== row.checksum) {
          throw new HistoryError(
            'checksum_mismatch',
            `版本 ${row.versionId} 已经以不同的内容写入过（已有 ${cur.checksum.slice(0, 12)}…，本次 ${row.checksum.slice(0, 12)}…）`,
          );
        }
        return;
      }
      throw new HistoryError('number_conflict', `项目 ${row.projectId} 的 v${row.number} 已被另一个版本占用`);
    }
    throw e;
  }
};

const startRun = async (db: Db, run: StartRunInput): Promise<number> => {
  // 注意：[dowel].[history] 上挂载了 AFTER UPDATE, DELETE 触发器，使用 SCOPE_IDENTITY() 避开 SQL Server 334 限制
  const [row] = await db.query<{ id: string | number }>(
    `INSERT INTO ${S}.[history]
       ([project_id], [from_version], [to_version], [direction], [status], [executed_by], [via], [instance_id], [started_at])
     VALUES (@p1, @p2, @p3, @p4, N'running', @p5, @p6, @p7, @p8);
     SELECT CAST(SCOPE_IDENTITY() AS bigint) AS id;`,
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
  const [res] = await db.query<{ affected: number }>(
    `UPDATE ${S}.[history] SET [step_index] = @p2 WHERE [id] = @p1 AND [status] = N'running';
     SELECT @@ROWCOUNT AS affected;`,
    [id, stepIndex],
  );
  if (!res || Number(res.affected) === 0) {
    throw new HistoryError('run_not_running', `执行记录 ${id} 不存在或已经结束`);
  }
};

const finishRun = async (
  db: Db,
  id: number,
  status: Exclude<RunStatus, 'running'>,
  error?: string | null,
): Promise<void> => {
  const [res] = await db.query<{ affected: number }>(
    `UPDATE ${S}.[history]
        SET [status] = @p2, [error] = @p3, [finished_at] = @p4
      WHERE [id] = @p1 AND [status] = N'running';
     SELECT @@ROWCOUNT AS affected;`,
    [id, status, error ?? null, new Date().toISOString()],
  );
  if (!res || Number(res.affected) === 0) {
    throw new HistoryError('run_not_running', `执行记录 ${id} 不存在或已经结束`);
  }
};

const readProject = async (db: Db, projectId: string): Promise<ProjectRow | null> => {
  const [r] = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${S}.[projects] WHERE [project_id] = @p1`,
    [projectId],
  );
  return r ? toProjectRow(r) : null;
};

const writeProject = async (
  db: Db,
  row: Omit<ProjectRow, 'previousInstanceId'> & { previousInstanceId?: string | null },
): Promise<void> => {
  await db.query(
    `MERGE ${S}.[projects] WITH (HOLDLOCK) AS target
     USING (SELECT @p1 AS [project_id]) AS src
        ON target.[project_id] = src.[project_id]
      WHEN MATCHED THEN
        UPDATE SET [name] = @p2, [instance_id] = @p3, [claimed_at] = @p4,
                   [claimed_by] = @p5, [previous_instance_id] = @p6
      WHEN NOT MATCHED THEN
        INSERT ([project_id], [name], [instance_id], [claimed_at], [claimed_by], [previous_instance_id])
        VALUES (@p1, @p2, @p3, @p4, @p5, @p6);`,
    [row.projectId, row.name, row.instanceId, row.claimedAt, row.claimedBy, row.previousInstanceId ?? null],
  );
};

const claimProject = async (
  db: Db,
  input: ClaimInput,
): Promise<{ changed: boolean; previousInstanceId: string | null }> => {
  const [cur] = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${S}.[projects] WITH (UPDLOCK, HOLDLOCK) WHERE [project_id] = @p1`,
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
    `INSERT INTO ${S}.[claims]
       ([project_id], [instance_id], [previous_instance_id], [claimed_by], [claimed_by_name], [claimed_at], [note])
     VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7)`,
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
  const [tbl] = await db.query<{ ok: number }>(
    `SELECT CASE WHEN OBJECT_ID(N'${S}.[claims]', N'U') IS NOT NULL THEN 1 ELSE 0 END AS ok`,
  );
  if (!tbl?.ok) return [];
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${S}.[claims] WHERE [project_id] = @p1 ORDER BY [id]`,
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
    `SELECT p.[project_id] AS projectId, p.[name], p.[instance_id] AS instanceId, p.[claimed_at] AS claimedAt,
            (SELECT COUNT(*) FROM ${S}.[versions] v WHERE v.[project_id] = p.[project_id]) AS versions,
            (SELECT MAX(v.[number]) FROM ${S}.[versions] v WHERE v.[project_id] = p.[project_id]) AS headNumber,
            (SELECT TOP 1 v.[number]
               FROM ${S}.[history] h
               JOIN ${S}.[versions] v ON v.[project_id] = h.[project_id] AND v.[version_id] = h.[to_version]
              WHERE h.[project_id] = p.[project_id] AND h.[status] = N'done'
              ORDER BY h.[id] DESC) AS currentNumber,
            (SELECT MAX(COALESCE(h.[finished_at], h.[started_at]))
               FROM ${S}.[history] h
              WHERE h.[project_id] = p.[project_id]) AS lastRunAt
       FROM ${S}.[projects] p
      ORDER BY CASE WHEN p.[name] IS NULL THEN 1 ELSE 0 END, p.[name], p.[project_id]`,
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
  const reserved = db.reserve ? await db.reserve() : null;
  const conn = reserved ?? db;
  const resource = `dowel:${projectId}`.slice(0, 255);
  let locked = false;
  try {
    const [res] = await conn.query<{ rc: number }>(
      `DECLARE @rc int;
       EXEC @rc = sys.sp_getapplock
         @Resource = @p1,
         @LockMode = 'Exclusive',
         @LockOwner = 'Session',
         @LockTimeout = @p2;
       SELECT @rc AS rc;`,
      [resource, Math.max(0, Math.trunc(timeoutMs))],
    );
    const rc = Number(res?.rc ?? -999);
    if (rc < 0) {
      throw new HistoryError(
        'lock_timeout',
        `等待项目锁超时（${timeoutMs}ms）：这个项目正在被另一个执行占用（sp_getapplock=${rc}）`,
      );
    }
    locked = true;
    return await fn(conn);
  } finally {
    if (locked) {
      await conn
        .query(
          `DECLARE @rc int;
           EXEC @rc = sys.sp_releaseapplock @Resource = @p1, @LockOwner = 'Session';
           SELECT @rc AS rc;`,
          [resource],
        )
        .catch(() => {});
    }
    reserved?.release?.();
  }
};

export const mssqlHistory: HistoryStore = {
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
