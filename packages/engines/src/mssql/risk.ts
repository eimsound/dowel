// MSSQL 步骤风险分析：利用事务内 DDL 能力在影子库实测 sys.dm_tran_locks 对象锁（Sch-M / Sch-S / X）
// 与 sys.partitions.hobt_id 数据页重写检测。
import {
  createAll,
  isNontransactionalSql,
  type Model,
  mssqlTokenize,
  splitMssqlBatches,
  type Step,
} from '@dowel/core';

import { type Db, EngineStepError, NON_TRANSACTIONAL_NOTE, type StepRisk } from '../types.ts';
import { mssqlErrorNumber, pinMssqlSession, runMssqlTransaction } from './db.ts';

const METADATA_PROCS = new Set([
  'sp_addextendedproperty',
  'sp_updateextendedproperty',
  'sp_dropextendedproperty',
]);

/**
 * 词法级判断一步 MSSQL SQL 是否仅包含纯元数据操作（扩展属性注释或删除默认约束），
 * 不依赖 Step.kind（兼容冻结脚本 kind === 'frozen'）。
 */
export const isMetadataOnlyMssqlSql = (sql: string): boolean => {
  const batches = splitMssqlBatches(sql, { expandRepeat: false });
  if (batches.length === 0) return true;
  for (const batch of batches) {
    const toks = mssqlTokenize(batch).filter(
      (t) => !/^\s+$/.test(t.text) && !t.text.startsWith('--') && !t.text.startsWith('/*') && t.text !== ';',
    );
    if (toks.length === 0) continue;
    // 1. EXEC [sys.]sp_{add,update,drop}extendedproperty ...
    if (toks[0]?.kind === 'ident' && (toks[0].text === 'exec' || toks[0].text === 'execute')) {
      let idx = 1;
      if (toks[idx + 1]?.text === '.') idx += 2;
      const proc = toks[idx]?.text.toLowerCase();
      if (proc && METADATA_PROCS.has(proc)) continue;
      return false;
    }
    // 2. ALTER TABLE <tbl> DROP CONSTRAINT [DF_...]
    if (
      toks[0]?.kind === 'ident' &&
      toks[0].text === 'alter' &&
      toks[1]?.kind === 'ident' &&
      toks[1].text === 'table'
    ) {
      const dropIdx = toks.findIndex(
        (t, k) =>
          k >= 3 &&
          t.kind === 'ident' &&
          t.text === 'drop' &&
          toks[k + 1]?.kind === 'ident' &&
          toks[k + 1]!.text === 'constraint',
      );
      if (dropIdx >= 3) {
        const nameTok = toks[dropIdx + 2];
        const afterName = toks[dropIdx + 3];
        if (
          nameTok &&
          (nameTok.kind === 'ident' || nameTok.kind === 'qident') &&
          /^df_/i.test(nameTok.text) &&
          !afterName
        ) {
          continue;
        }
      }
    }
    return false;
  }
  return true;
};

/** SQL Server 错误号：当前语句不允许在用户事务内执行（226 / 574 / 15002） */
const NON_TX_ERROR_NUMBERS = new Set([226, 574, 15002]);

const cannotRunInMssqlTx = (err: EngineStepError): boolean => {
  const num = mssqlErrorNumber(err.cause);
  if (num !== null && NON_TX_ERROR_NUMBERS.has(num)) return true;
  return /not allowed within multi-statement transaction|cannot be used inside a user transaction|cannot be executed inside a transaction/i.test(
    err.reason,
  );
};

interface HobtEntry {
  objectId: number;
  name: string;
  hobtId: string;
}

const readExistingTables = async (db: Db): Promise<Map<number, HobtEntry>> => {
  const rows = await db.query<{ objectId: number; name: string; hobtId: string }>(
    `SELECT t.object_id AS objectId,
            s.name + N'.' + t.name AS name,
            CAST(p.hobt_id AS nvarchar(64)) AS hobtId
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) AND p.partition_number = 1
      WHERE t.is_ms_shipped = 0
        AND s.schema_id < 16384
        AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc', N'dowel')
        AND s.name NOT LIKE N'db[_]%'`,
  );
  const map = new Map<number, HobtEntry>();
  for (const r of rows) {
    map.set(Number(r.objectId), {
      objectId: Number(r.objectId),
      name: r.name,
      hobtId: String(r.hobtId),
    });
  }
  return map;
};

export const analyzeMssqlStepRisk = async (
  db: Db,
  from: Model,
  steps: Step[],
  resetShadow: (db: Db) => Promise<void>,
): Promise<StepRisk[]> => {
  await resetShadow(db);
  await pinMssqlSession(db);
  for (const s of createAll(from)) {
    const t0 = performance.now();
    try {
      await db.exec(s.sql);
    } catch (e) {
      throw new EngineStepError(s, e, performance.now() - t0);
    }
  }

  const initialTables = await readExistingTables(db);
  const existingIds = new Set(initialTables.keys());

  const runOutsideTx = async (s: Step): Promise<StepRisk> => {
    const t0 = performance.now();
    try {
      await db.exec(s.sql);
    } catch (e) {
      throw new EngineStepError(s, e, performance.now() - t0);
    }
    return { locks: [], rewrites: [], scans: [], level: 'low', note: NON_TRANSACTIONAL_NOTE };
  };

  const measureInTx = async (s: Step): Promise<StepRisk> => {
    const before = await readExistingTables(db);
    let locks: { objectId: number; relation: string; mode: string }[] = [];
    let after: Map<number, HobtEntry> = before;

    await runMssqlTransaction(db, async () => {
      const t0 = performance.now();
      try {
        await db.exec(s.sql);
      } catch (e) {
        throw new EngineStepError(s, e, performance.now() - t0);
      }
      locks = await db
        .query<{ objectId: number; relation: string; mode: string }>(
          `SELECT DISTINCT l.resource_associated_entity_id AS objectId,
                  s.name + N'.' + o.name AS relation,
                  l.request_mode AS mode
             FROM sys.dm_tran_locks l
             JOIN sys.objects o ON o.object_id = l.resource_associated_entity_id
             JOIN sys.schemas s ON s.schema_id = o.schema_id
            WHERE l.request_session_id = @@SPID
              AND l.resource_type = N'OBJECT'
              AND l.request_status = N'GRANT'`,
        )
        .catch(() => []);
      after = await readExistingTables(db);
    });

    const filteredLocks = locks
      .filter((l) => existingIds.has(Number(l.objectId)))
      .map(({ relation, mode }) => ({ relation, mode }));

    const rewrites: string[] = [];
    for (const [oid, prev] of before) {
      if (!existingIds.has(oid)) continue;
      const cur = after.get(oid);
      if (cur && cur.hobtId !== prev.hobtId) rewrites.push(prev.name);
    }

    const modes = new Set(filteredLocks.map((l) => l.mode));
    const hasSchM = modes.has('Sch-M');
    const hasX = modes.has('X');
    let level: StepRisk['level'] = 'low';
    if (rewrites.length > 0) {
      level = 'high';
    } else if (hasSchM || hasX) {
      // 基于 SQL 词法分类而非 Step.kind（兼容冻结脚本 kind === 'frozen'）：纯元数据操作保持 low，其余已有表强锁标 medium
      level = isMetadataOnlyMssqlSql(s.sql) ? 'low' : 'medium';
    }

    return {
      locks: filteredLocks,
      rewrites,
      scans: [],
      level,
    };
  };

  const out: StepRisk[] = [];
  for (const s of steps) {
    if (isNontransactionalSql(s.sql, 'mssql')) {
      out.push(await runOutsideTx(s));
      continue;
    }
    try {
      out.push(await measureInTx(s));
    } catch (e) {
      if (s.transactional === false && e instanceof EngineStepError && cannotRunInMssqlTx(e)) {
        out.push(await runOutsideTx(s));
        continue;
      }
      throw e;
    }
  }
  return out;
};
