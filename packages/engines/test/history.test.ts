// 目标库历史模块（H2）：建表、权限、版本行、当前版本、项目锁、结构指纹、链完整性。
// 需要 PG 的部分用 Testcontainers（或 DOWEL_TEST_PG），没有 Docker 时跳过；纯函数部分照常运行。
import { createSchema, emptyModel, type Model, plan } from '@dowel/core';
import postgres from 'postgres';
import { afterAll, describe, expect, test } from 'vitest';

import { connect, createTestDb, dbUrl, PG_URL, useTestDb } from '../../../test/pg.ts';
import { build, resetShadow } from '../../verifier/src/index.ts';
import {
  claimProject,
  type Db,
  ensureHistory,
  fingerprint,
  finishRun,
  fromPostgres,
  HISTORY_FORMAT,
  HistoryError,
  type HistoryVersionRow,
  historyWriteProblem,
  isNontransactionalSql,
  listHistoryProjects,
  markStep,
  readClaims,
  readHistory,
  readHistoryFormat,
  readProject,
  readSnapshot,
  recordVersion,
  type ScriptStep,
  startRun,
  stepsChecksum,
  toScriptSteps,
  verifyChain,
  withProjectLock,
  writeProject,
} from '../src/index.ts';

// ───── 纯函数：不需要数据库 ─────

describe('冻结步骤与 checksum', () => {
  test('checksum 只取决于步骤内容：键顺序、多余字段不影响，SQL 或标记变了就变', () => {
    const up: ScriptStep[] = [{ sql: 'CREATE TABLE a (id int)', transactional: true }];
    const down: ScriptStep[] = [{ sql: 'DROP TABLE a', transactional: true }];
    const base = stepsChecksum(up, down);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    // 键顺序不同、带了多余字段（kind / target）
    const noisy = [
      { transactional: true, sql: 'CREATE TABLE a (id int)', kind: 'createTable' },
    ] as unknown as ScriptStep[];
    expect(stepsChecksum(noisy, down)).toBe(base);
    expect(stepsChecksum(up, [{ sql: 'DROP TABLE a ', transactional: true }])).not.toBe(base);
    expect(stepsChecksum(up, [{ sql: 'DROP TABLE a', transactional: false }])).not.toBe(base);
    // up 和 down 对调是不同的内容
    expect(stepsChecksum(down, up)).not.toBe(base);
  });

  test('非事务语句的判断不被字符串、标识符、函数体里的词误导', () => {
    expect(isNontransactionalSql('CREATE INDEX CONCURRENTLY i ON t (a)')).toBe(true);
    expect(isNontransactionalSql('DROP INDEX concurrently i')).toBe(true);
    expect(isNontransactionalSql('VACUUM t')).toBe(true);
    expect(isNontransactionalSql("COMMENT ON TABLE t IS 'create index concurrently'")).toBe(false);
    expect(isNontransactionalSql('CREATE TABLE "concurrently" (a int)')).toBe(false);
    expect(isNontransactionalSql('CREATE FUNCTION f() RETURNS void AS $$ VACUUM t $$ LANGUAGE sql')).toBe(
      false,
    );
    expect(isNontransactionalSql('CREATE TABLE t (a int) -- concurrently')).toBe(false);
  });

  test('toScriptSteps 只保留 sql 和 transactional，plan 目前输出的全是事务内可执行的', () => {
    const m = emptyModel();
    createSchema(m, 'public');
    const steps = toScriptSteps(plan(emptyModel(), m));
    expect(steps).toEqual([{ sql: 'CREATE SCHEMA public', transactional: true }]);
  });
});

const row = (
  n: number,
  parent: string | null,
  up: string,
  down: string,
  project = 'p1',
): HistoryVersionRow => {
  const upSteps: ScriptStep[] = [{ sql: up, transactional: true }];
  const downSteps: ScriptStep[] = [{ sql: down, transactional: true }];
  return {
    projectId: project,
    versionId: `${project}-v${n}`,
    number: n,
    parentId: parent,
    name: `v${n}`,
    scope: null,
    upSteps,
    downSteps,
    checksum: stepsChecksum(upSteps, downSteps),
    model: emptyModel(),
    fingerprint: 'f'.repeat(64),
    publishedAt: new Date(Date.UTC(2026, 10, 19, 0, n)).toISOString(),
    publishedBy: 'u1',
  };
};

const chain = (from: number, count: number): HistoryVersionRow[] => {
  const out: HistoryVersionRow[] = [];
  for (let n = from; n < from + count; n++)
    out.push(
      row(
        n,
        out.length ? out[out.length - 1]!.versionId : null,
        `CREATE TABLE t${n} (a int)`,
        `DROP TABLE t${n}`,
      ),
    );
  return out;
};

describe('verifyChain', () => {
  test('完整的链没有问题（从 v0 或 v1 开始都可以）', () => {
    expect(verifyChain(chain(0, 4))).toEqual([]);
    expect(verifyChain(chain(1, 3))).toEqual([]);
    expect(verifyChain([])).toEqual([]);
    // 顺序不影响
    expect(verifyChain([...chain(0, 3)].reverse())).toEqual([]);
  });

  test('断链：parent 指错', () => {
    const rows = chain(0, 4);
    rows[2] = { ...rows[2]!, parentId: rows[0]!.versionId };
    const problems = verifyChain(rows);
    expect(problems.map((p) => [p.code, p.versionId])).toEqual([['parent_broken', 'p1-v2']]);
  });

  test('断链：缺了中间一个版本；第一个版本不应有 parent', () => {
    const rows = chain(0, 4);
    const missing = rows.filter((r) => r.number !== 1);
    expect(verifyChain(missing).map((p) => p.code)).toEqual(['number_gap', 'parent_broken', 'number_gap']);
    const headless = chain(0, 2);
    headless[0] = { ...headless[0]!, parentId: 'ghost' };
    expect(verifyChain(headless).map((p) => p.code)).toEqual(['parent_broken']);
    // 起点只能是 0 或 1
    expect(verifyChain(chain(3, 2)).map((p) => p.code)).toContain('number_gap');
  });

  test('篡改：脚本被改了但 checksum 没变', () => {
    const rows = chain(0, 3);
    rows[1] = { ...rows[1]!, upSteps: [{ sql: 'DROP TABLE users', transactional: true }] };
    expect(verifyChain(rows).map((p) => [p.code, p.versionId])).toEqual([['checksum_mismatch', 'p1-v1']]);
    // 只改“事务内执行”标记也算篡改
    const flag = chain(0, 2);
    flag[1] = { ...flag[1]!, downSteps: flag[1]!.downSteps.map((s) => ({ ...s, transactional: false })) };
    expect(verifyChain(flag).map((p) => p.code)).toEqual(['checksum_mismatch']);
  });
});

// ───── 需要 PG ─────

/** 另一个账号连同一个库（用来验证权限不足的路径） */
const asRole = (url: string, role: string, password: string) => {
  const u = new URL(url);
  u.username = role;
  u.password = password;
  return connect(u.toString());
};

describe.skipIf(!PG_URL)('ensureHistory', () => {
  const roles: string[] = [];
  afterAll(async () => {
    const admin = connect(PG_URL);
    for (const r of roles) await admin.db.exec(`DROP ROLE IF EXISTS ${r}`);
    await admin.close();
  });

  const newRole = async (): Promise<{ role: string; password: string }> => {
    const role = `dowel_h_${Math.random().toString(36).slice(2, 10)}`;
    const password = 'pw-history';
    const admin = connect(PG_URL);
    await admin.db.exec(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    await admin.close();
    roles.push(role);
    return { role, password };
  };

  test('建 schema 和表，幂等（含并发）；format_version 记在 meta 里', async () => {
    const t = await createTestDb('hist_ensure');
    try {
      await ensureHistory(t.db);
      await ensureHistory(t.db);
      // 两个连接同时初始化也不能撞上目录唯一约束
      const other = connect(t.url);
      try {
        await Promise.all([ensureHistory(t.db), ensureHistory(other.db), ensureHistory(t.db)]);
      } finally {
        await other.close();
      }
      const tables = await t.db.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'dowel' order by table_name`,
      );
      expect(tables.map((x) => x.table_name)).toEqual(['claims', 'history', 'meta', 'projects', 'versions']);
      const [meta] = await t.db.query<{ value: number }>(
        "select value from dowel.meta where key = 'format_version'",
      );
      expect(meta!.value).toBe(HISTORY_FORMAT);
      expect(HISTORY_FORMAT).toBe(1);
      // 触发器只有一个（重复调用不会重复建）
      const triggers = await t.db.query("select 1 from pg_trigger where tgname = 'history_guard'");
      expect(triggers).toHaveLength(1);
      // 没有在业务 schema 里留下任何东西
      expect(await t.db.query("select 1 from pg_tables where schemaname = 'public'")).toEqual([]);
    } finally {
      await t.close();
    }
  });

  test('格式比代码新（或不是整数）：执行和读历史都拒绝（format_too_new），不动里面的数据；当前格式是 1', async () => {
    const t = await createTestDb('hist_format');
    try {
      expect(HISTORY_FORMAT).toBe(1);
      await ensureHistory(t.db);
      // 当前格式：一切正常，ensureHistory 幂等
      expect(await readHistoryFormat(t.db)).toBe(1);
      await ensureHistory(t.db);
      for (const bad of ['2', '3', '"x"', '1.5']) {
        await t.db.exec(`update dowel.meta set value = '${bad}'::jsonb where key = 'format_version'`);
        await expect(ensureHistory(t.db), bad).rejects.toMatchObject({ code: 'format_too_new' });
        // 读也不行（认得的表结构可能已经变了）；预演的写权限检查也提前报
        await expect(readHistoryFormat(t.db), bad).rejects.toMatchObject({ code: 'format_too_new' });
        await expect(
          readHistory(t.db, 'p').then(() => readHistoryFormat(t.db)),
          bad,
        ).rejects.toMatchObject({
          code: 'format_too_new',
        });
        expect(await historyWriteProblem(t.db), bad).toMatchObject({ code: 'format_too_new' });
        expect(await t.db.query("select value from dowel.meta where key = 'format_version'"), bad).toEqual([
          { value: JSON.parse(bad) },
        ]);
      }
    } finally {
      await t.close();
    }
  });

  test('没有建 schema 的权限：抛 no_schema_privilege，说明需要什么权限并给出 DBA 语句，不退回其他 schema', async () => {
    const t = await createTestDb('hist_priv');
    const { role, password } = await newRole();
    const limited = asRole(t.url, role, password);
    try {
      const err = await ensureHistory(limited.db).then(
        () => null,
        (e) => e as HistoryError,
      );
      expect(err).toBeInstanceOf(HistoryError);
      expect(err!.code).toBe('no_schema_privilege');
      expect(err!.message).toContain(`CREATE SCHEMA dowel AUTHORIZATION "${role}"`);
      expect(err!.message).toContain('GRANT CREATE ON DATABASE');
      // 没有在任何 schema 里留下表
      expect(
        await t.db.query("select 1 from pg_tables where tablename in ('versions', 'history', 'meta')"),
      ).toEqual([]);
      expect(await t.db.query("select 1 from pg_namespace where nspname = 'dowel'")).toEqual([]);

      // schema 已经存在、但账号没有权限
      await t.db.exec('CREATE SCHEMA dowel');
      const err2 = await ensureHistory(limited.db).then(
        () => null,
        (e) => e as HistoryError,
      );
      expect(err2!.code).toBe('no_schema_privilege');
      expect(err2!.message).toContain(`GRANT USAGE, CREATE ON SCHEMA dowel TO "${role}"`);

      // DBA 按提示授权后可以用
      await t.db.exec(`GRANT USAGE, CREATE ON SCHEMA dowel TO ${role}`);
      await ensureHistory(limited.db);
      expect((await readHistory(limited.db, 'p1')).versions).toEqual([]);
    } finally {
      await limited.close();
      await t.close();
    }
  });

  test('DBA 预先建好 schema（AUTHORIZATION 给 Dowel 的账号）：账号没有建库级权限也能用', async () => {
    const t = await createTestDb('hist_pre');
    const { role, password } = await newRole();
    const limited = asRole(t.url, role, password);
    try {
      await t.db.exec(`CREATE SCHEMA dowel AUTHORIZATION ${role}`);
      await ensureHistory(limited.db);
      await ensureHistory(limited.db);
    } finally {
      await limited.close();
      await t.close();
    }
  });
});

describe.skipIf(!PG_URL)('版本行与执行记录', () => {
  const conn = useTestDb('hist_rows');
  const ready = async () => {
    await ensureHistory(conn());
    return conn();
  };

  test('recordVersion 幂等；同一 version_id 不同内容抛 checksum_mismatch', async () => {
    const db = await ready();
    const [v0, v1] = chain(0, 2).map((r) => ({ ...r, projectId: 'idem', versionId: `idem-${r.number}` }));
    v1!.parentId = v0!.versionId;
    await recordVersion(db, v0!);
    await recordVersion(db, v1!);
    await recordVersion(db, v1!); // 再写一次：什么也不发生
    const h = await readHistory(db, 'idem');
    expect(h.versions.map((v) => [v.number, v.versionId, v.parentId])).toEqual([
      [0, 'idem-0', null],
      [1, 'idem-1', 'idem-0'],
    ]);
    expect(h.versions[1]!.upSteps).toEqual(v1!.upSteps);
    expect(h.versions[1]!.publishedAt).toBe(v1!.publishedAt);

    // 同一个 version_id、脚本不同（checksum 也跟着变）
    const other = row(1, v0!.versionId, 'CREATE TABLE other (a int)', 'DROP TABLE other', 'idem');
    await expect(recordVersion(db, { ...other, versionId: 'idem-1' })).rejects.toMatchObject({
      code: 'checksum_mismatch',
    });
    // checksum 与脚本内容对不上的行一开始就拒绝
    await expect(
      recordVersion(db, { ...v1!, versionId: 'idem-x', number: 9, checksum: '0'.repeat(64) }),
    ).rejects.toMatchObject({
      code: 'checksum_mismatch',
    });
    // 序号被另一个版本占了
    await expect(recordVersion(db, { ...other, versionId: 'idem-other', number: 1 })).rejects.toMatchObject({
      code: 'number_conflict',
    });
    // 失败的写入没有留下任何东西
    expect((await readHistory(db, 'idem')).versions).toHaveLength(2);
    // 链是完整的
    expect(verifyChain((await readHistory(db, 'idem')).versions)).toEqual([]);
  });

  test('当前版本：最后一条 done 的 to_version（up、up、down 之后；失败和进行中不算）', async () => {
    const db = await ready();
    const p = 'cur';
    const base = { projectId: p, executedBy: 'u1', via: 'web' as const, instanceId: 'inst-1' };
    expect((await readHistory(db, p)).currentVersion).toBeNull();

    const r0 = await startRun(db, { ...base, fromVersion: null, toVersion: 'v0', direction: 'baseline' });
    await finishRun(db, r0, 'done');
    expect((await readHistory(db, p)).currentVersion).toBe('v0');
    const r1 = await startRun(db, { ...base, fromVersion: 'v0', toVersion: 'v1', direction: 'up' });
    await markStep(db, r1, 0);
    await markStep(db, r1, 3);
    await finishRun(db, r1, 'done');
    const r2 = await startRun(db, { ...base, fromVersion: 'v1', toVersion: 'v2', direction: 'up' });
    // 进行中的不算
    expect((await readHistory(db, p)).currentVersion).toBe('v1');
    await finishRun(db, r2, 'done');
    expect((await readHistory(db, p)).currentVersion).toBe('v2');
    // down 方向也取 to_version
    const r3 = await startRun(db, { ...base, fromVersion: 'v2', toVersion: 'v1', direction: 'down' });
    await finishRun(db, r3, 'done');
    expect((await readHistory(db, p)).currentVersion).toBe('v1');
    // 失败的不改变当前版本，错误信息留下
    const r4 = await startRun(db, {
      ...base,
      via: 'ci',
      fromVersion: 'v1',
      toVersion: 'v2',
      direction: 'up',
    });
    await finishRun(db, r4, 'failed', 'relation "x" already exists');

    const h = await readHistory(db, p);
    expect(h.currentVersion).toBe('v1');
    expect(h.history.map((r) => [r.direction, r.toVersion, r.status])).toEqual([
      ['baseline', 'v0', 'done'],
      ['up', 'v1', 'done'],
      ['up', 'v2', 'done'],
      ['down', 'v1', 'done'],
      ['up', 'v2', 'failed'],
    ]);
    expect(h.history[1]).toMatchObject({ stepIndex: 3, executedBy: 'u1', via: 'web', instanceId: 'inst-1' });
    expect(h.history[4]).toMatchObject({ via: 'ci', error: 'relation "x" already exists' });
    expect(h.history[4]!.finishedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    // 别的项目互不影响
    expect((await readHistory(db, 'cur-other')).currentVersion).toBeNull();
  });

  test('history 只追加：结束的记录不能再改，也不能删；标识字段不能改', async () => {
    const db = await ready();
    const base = { projectId: 'guard', executedBy: null, via: 'web' as const, instanceId: 'i' };
    const id = await startRun(db, { ...base, fromVersion: null, toVersion: 'v0', direction: 'baseline' });
    // 模块自己的函数：running 才能改
    await finishRun(db, id, 'failed', 'boom');
    await expect(finishRun(db, id, 'done')).rejects.toMatchObject({ code: 'run_not_running' });
    await expect(markStep(db, id, 1)).rejects.toMatchObject({ code: 'run_not_running' });
    // 绕过模块直接写 SQL 也被触发器拦住
    await expect(db.exec(`update dowel.history set status = 'done' where id = ${id}`)).rejects.toThrow(
      '只追加',
    );
    await expect(db.exec(`delete from dowel.history where id = ${id}`)).rejects.toThrow('只追加');
    const running = await startRun(db, {
      ...base,
      fromVersion: null,
      toVersion: 'v1',
      direction: 'baseline',
    });
    await expect(db.exec(`update dowel.history set to_version = 'vX' where id = ${running}`)).rejects.toThrow(
      '标识字段',
    );
    await expect(db.exec(`delete from dowel.history where id = ${running}`)).rejects.toThrow('只追加');
    // check 约束
    await expect(
      db.exec(`update dowel.history set status = 'weird' where id = ${running}`),
    ).rejects.toThrow();
    await finishRun(db, running, 'done');
    expect((await readHistory(db, 'guard')).history.map((r) => r.status)).toEqual(['failed', 'done']);
  });

  test('项目认领行的读写', async () => {
    const db = await ready();
    expect(await readProject(db, 'claim')).toBeNull();
    await writeProject(db, {
      projectId: 'claim',
      name: '商城',
      instanceId: 'inst-a',
      claimedAt: null,
      claimedBy: null,
    });
    expect(await readProject(db, 'claim')).toEqual({
      projectId: 'claim',
      name: '商城',
      instanceId: 'inst-a',
      claimedAt: null,
      claimedBy: null,
      previousInstanceId: null,
    });
    await writeProject(db, {
      projectId: 'claim',
      name: '商城',
      instanceId: 'inst-b',
      claimedAt: '2026-11-19T01:02:03.000Z',
      claimedBy: 'zhang',
    });
    expect(await readProject(db, 'claim')).toMatchObject({
      instanceId: 'inst-b',
      claimedAt: '2026-11-19T01:02:03.000Z',
      claimedBy: 'zhang',
    });
  });
});

describe.skipIf(!PG_URL)('withProjectLock', () => {
  const conn = useTestDb('hist_lock');
  const lockCount = async (db: Db) =>
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())",
      )
    )[0]!.n;

  const dbName = async () => (await conn().query<{ n: string }>('select current_database() as n'))[0]!.n;
  /** 与 useTestDb 同一个库的另一个独立连接 */
  const another = async () => connect(dbUrl(await dbName()));
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    return { promise, release };
  };

  test('两个连接同时加锁：第二个等待超时（lock_timeout）；第一个结束后可以拿到', async () => {
    const a = await another();
    const b = await another();
    try {
      const held = gate();
      const entered = gate();
      const first = withProjectLock(a.db, 'proj-1', 1000, async () => {
        entered.release();
        await held.promise;
        return 'first';
      });
      await entered.promise;
      const t0 = Date.now();
      await expect(withProjectLock(b.db, 'proj-1', 400, async () => 'second')).rejects.toMatchObject({
        name: 'HistoryError',
        code: 'lock_timeout',
      });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
      // 不同项目互不阻塞
      expect(await withProjectLock(b.db, 'proj-2', 0, async () => 'other')).toBe('other');
      held.release();
      expect(await first).toBe('first');
      // 释放之后立刻可以拿到
      expect(await withProjectLock(b.db, 'proj-1', 0, async () => 'after')).toBe('after');
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('第二个连接在超时之前等到第一个释放，就拿到锁并执行', async () => {
    const a = await another();
    const b = await another();
    try {
      const order: string[] = [];
      const entered = gate();
      const first = withProjectLock(a.db, 'proj-wait', 1000, async () => {
        order.push('a-start');
        entered.release();
        await new Promise((r) => setTimeout(r, 500));
        order.push('a-end');
      });
      await entered.promise;
      await withProjectLock(b.db, 'proj-wait', 5000, async () => {
        order.push('b');
      });
      await first;
      expect(order).toEqual(['a-start', 'a-end', 'b']);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('fn 抛错后锁一定释放（包括事务中途出错的情况），连接归还后没有残留的锁', async () => {
    const a = await another();
    const b = await another();
    try {
      await expect(
        withProjectLock(a.db, 'proj-err', 1000, async () => {
          throw new Error('执行失败');
        }),
      ).rejects.toThrow('执行失败');
      expect(await withProjectLock(b.db, 'proj-err', 0, async () => 'ok')).toBe('ok');

      // 事务里出错没有回滚就抛出：连接停在“事务已中止”状态，也不能把锁带回连接池
      await expect(
        withProjectLock(a.db, 'proj-err', 1000, async (c) => {
          await c.exec('BEGIN');
          await c.exec('select 1/0');
        }),
      ).rejects.toThrow('division by zero');
      expect(await withProjectLock(b.db, 'proj-err', 0, async () => 'ok2')).toBe('ok2');
      expect(await lockCount(b.db)).toBe(0);
      // a 的连接池还能正常用
      expect(await a.db.query('select 1 as x')).toEqual([{ x: 1 }]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('加锁、fn、解锁用同一个连接，即使连接池有多个连接', async () => {
    const url = dbUrl(await dbName());
    const pool = postgres(url, { max: 5, onnotice: () => {}, prepare: false });
    const db = fromPostgres(pool);
    const probe = connect(url);
    try {
      // 先把池里的连接都用起来：普通 query 会落在不同连接上
      await Promise.all(Array.from({ length: 5 }, () => db.query('select pg_sleep(0.05)')));
      let pidInside: number[] = [];
      await withProjectLock(db, 'proj-pool', 1000, async (c) => {
        for (let i = 0; i < 6; i++)
          pidInside.push((await c.query<{ pid: number }>('select pg_backend_pid() as pid'))[0]!.pid);
        // 锁在持有期间对别的连接可见：别人拿不到
        expect(await lockCount(probe.db)).toBe(1);
        await expect(withProjectLock(probe.db, 'proj-pool', 100, async () => 1)).rejects.toMatchObject({
          code: 'lock_timeout',
        });
      });
      expect(new Set(pidInside).size).toBe(1);
      // 解锁成功（在同一个连接上），没有任何会话残留 advisory lock
      expect(await lockCount(probe.db)).toBe(0);
      pidInside = [];
      // 连续多次加锁、解锁，池里不留残留
      for (let i = 0; i < 8; i++) await withProjectLock(db, 'proj-pool', 1000, async () => {});
      expect(await lockCount(probe.db)).toBe(0);
    } finally {
      await probe.close();
      await pool.end({ timeout: 5 });
    }
  });
});

describe.skipIf(!PG_URL)('fingerprint', () => {
  const conn = useTestDb('hist_fp');

  const snap = async (ddl: string) => {
    await resetShadow(conn());
    await conn().exec('CREATE SCHEMA public');
    await conn().exec(`SET search_path = public; ${ddl}`);
    return readSnapshot(conn());
  };

  test('同一结构得到同一指纹：建表顺序、物理列号、server 版本号都不影响', async () => {
    const a = await snap(`
      create table users (id int primary key, email text not null unique);
      create table posts (id int primary key, uid int references users, title text);
      create index posts_title on posts (title);`);
    // 换一个顺序建（OID 不同）
    const b = await snap(`
      create table posts (id int primary key, uid int, title text);
      create table users (id int primary key, email text not null unique);
      alter table posts add foreign key (uid) references users;
      create index posts_title on posts (title);`);
    expect(b.tables['public.posts']).toBeDefined();
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{64}$/);

    // 删列再加回：attnum 不同，结构相同
    const c = await snap(
      'create table t (a int, b int, c text); alter table t drop column c; alter table t add column c text;',
    );
    const d = await snap('create table t (a int, b int, c text);');
    expect(c.tables['public.t']!.columns.c!.attnum).not.toBe(d.tables['public.t']!.columns.c!.attnum);
    expect(fingerprint(c)).toBe(fingerprint(d));

    // 快照里的 server_version_num 不参与
    expect(fingerprint({ ...a, version: a.version + 1 })).toBe(fingerprint(a));
    // 同一份快照反复算是确定的
    expect(fingerprint(a)).toBe(fingerprint(structuredClone(a)));
  });

  test('结构改动后指纹变化：加列、改类型、改约束、改注释、加索引', async () => {
    const base = 'create table t (a int, b text);';
    const f0 = fingerprint(await snap(base));
    const variants = [
      `${base} alter table t add column c int;`,
      'create table t (a bigint, b text);',
      `${base} alter table t add constraint t_b_ck check (b <> '');`,
      `${base} comment on column t.b is 'x';`,
      `${base} create index t_a on t (a);`,
      `${base} alter table t alter column a set not null;`,
      'create table t (a int, b varchar(10));',
      'create table u (a int, b text);',
    ];
    const seen = new Set([f0]);
    for (const ddl of variants) seen.add(fingerprint(await snap(ddl)));
    expect(seen.size).toBe(variants.length + 1);
  });

  test('目标库里多了 dowel schema 不影响指纹', async () => {
    const before = fingerprint(await snap('create table t (a int);'));
    await ensureHistory(conn());
    await recordVersion(conn(), row(0, null, 'CREATE TABLE t (a int)', 'DROP TABLE t', 'fp'));
    expect(fingerprint(await readSnapshot(conn()))).toBe(before);
  });

  test('从模型建出来再读回，指纹与导入时一致（可用于接手后的漂移比较）', async () => {
    const m: Model = emptyModel();
    createSchema(m, 'public');
    const one = fingerprint(await build(conn(), m));
    const two = fingerprint(await build(conn(), m));
    expect(one).toBe(two);
  });
});

// ───── P4c：scope、previous_instance_id、claims 与认领 ─────

describe.skipIf(!PG_URL)('scope、认领与预演检查', () => {
  test('direction 约束包含 mark（标记为已执行）；当前版本取最后一条 done 的 to_version，mark 也一样；其他方向仍被拒绝', async () => {
    const t = await createTestDb('hist_mark');
    try {
      await ensureHistory(t.db);
      const base = { projectId: 'pm', executedBy: 'u1', via: 'web' as const, instanceId: 'i1' };
      const a = await startRun(t.db, { ...base, fromVersion: null, toVersion: 'v1', direction: 'up' });
      await finishRun(t.db, a, 'done');
      const m = await startRun(t.db, { ...base, fromVersion: 'v1', toVersion: 'v3', direction: 'mark' });
      await finishRun(t.db, m, 'done');
      const h = await readHistory(t.db, 'pm');
      expect(h.currentVersion).toBe('v3');
      expect(h.history.map((x) => x.direction)).toEqual(['up', 'mark']);
      await expect(
        t.db.query(
          "insert into dowel.history (project_id, to_version, direction, status, via, instance_id) values ('pm', 'v', 'adopt', 'running', 'web', 'i')",
        ),
      ).rejects.toThrow();
    } finally {
      await t.close();
    }
  });

  test('scope 随版本行存取：null 表示全部，列表原样返回', async () => {
    const t = await createTestDb('hist_scope');
    try {
      await ensureHistory(t.db);
      const a = { ...row(1, null, 'CREATE TABLE a (id int)', 'DROP TABLE a', 's'), scope: ['app'] };
      const b = {
        ...row(2, a.versionId, 'ALTER TABLE a ADD b int', 'ALTER TABLE a DROP b', 's'),
        scope: null,
      };
      await recordVersion(t.db, a);
      await recordVersion(t.db, b);
      const h = await readHistory(t.db, 's');
      expect(h.versions.map((v) => v.scope)).toEqual([['app'], null]);
      // 往返之后 checksum / 链仍然完整
      expect(verifyChain(h.versions)).toEqual([]);
    } finally {
      await t.close();
    }
  });

  test('认领：换手写项目行 + 追加认领事件；本实例重复认领什么都不写；claims 只追加', async () => {
    const t = await createTestDb('hist_claim');
    try {
      await ensureHistory(t.db);
      await writeProject(t.db, {
        projectId: 'c1',
        name: '商城',
        instanceId: 'inst-a',
        claimedAt: null,
        claimedBy: 'u-a',
      });
      const r1 = await claimProject(t.db, {
        projectId: 'c1',
        instanceId: 'inst-b',
        claimedBy: 'u-b',
        claimedByName: '李四',
        name: '商城 B',
      });
      expect(r1).toEqual({ changed: true, previousInstanceId: 'inst-a' });
      expect(await readProject(t.db, 'c1')).toMatchObject({
        instanceId: 'inst-b',
        previousInstanceId: 'inst-a',
        claimedBy: 'u-b',
        name: '商城 B',
      });
      expect((await readProject(t.db, 'c1'))!.claimedAt).not.toBeNull();
      const again = await claimProject(t.db, {
        projectId: 'c1',
        instanceId: 'inst-b',
        claimedBy: 'u-b',
        claimedByName: '李四',
        name: null,
      });
      expect(again.changed).toBe(false);
      const claims = await readClaims(t.db, 'c1');
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({
        instanceId: 'inst-b',
        previousInstanceId: 'inst-a',
        claimedByName: '李四',
      });
      // 只追加：改和删都被触发器拒绝
      await expect(t.db.exec("update dowel.claims set instance_id = 'x'")).rejects.toThrow(/只追加/);
      await expect(t.db.exec('delete from dowel.claims')).rejects.toThrow(/只追加/);
      // 没有项目行（被手工删了）也能认领，上一个实例未知
      await t.db.exec("delete from dowel.projects where project_id = 'c1'");
      const lost = await claimProject(t.db, {
        projectId: 'c1',
        instanceId: 'inst-c',
        claimedBy: null,
        claimedByName: null,
        name: null,
      });
      expect(lost).toEqual({ changed: true, previousInstanceId: null });
    } finally {
      await t.close();
    }
  });

  test('listHistoryProjects：登记过的项目、版本数、当前版本序号；没有历史表返回空', async () => {
    const t = await createTestDb('hist_list');
    try {
      expect(await listHistoryProjects(t.db)).toEqual([]);
      expect(await readHistoryFormat(t.db)).toBeNull();
      await ensureHistory(t.db);
      const v1 = row(1, null, 'CREATE TABLE a (id int)', 'DROP TABLE a', 'pa');
      const v2 = row(2, v1.versionId, 'ALTER TABLE a ADD b int', 'ALTER TABLE a DROP b', 'pa');
      await recordVersion(t.db, v1);
      await recordVersion(t.db, v2);
      await writeProject(t.db, {
        projectId: 'pa',
        name: 'A 项目',
        instanceId: 'inst-a',
        claimedAt: null,
        claimedBy: null,
      });
      await writeProject(t.db, {
        projectId: 'pb',
        name: 'B 项目',
        instanceId: 'inst-b',
        claimedAt: null,
        claimedBy: null,
      });
      const run = await startRun(t.db, {
        projectId: 'pa',
        fromVersion: null,
        toVersion: v1.versionId,
        direction: 'up',
        executedBy: null,
        via: 'web',
        instanceId: 'inst-a',
      });
      await finishRun(t.db, run, 'done');
      const list = await listHistoryProjects(t.db);
      expect(list.map((x) => [x.projectId, x.versions, x.headNumber, x.currentNumber])).toEqual([
        ['pa', 2, 2, 1],
        ['pb', 0, null, null],
      ]);
    } finally {
      await t.close();
    }
  });

  test('historyWriteProblem（预演）：没有 schema 且不能建时说明缺什么；不建任何东西', async () => {
    const t = await createTestDb('hist_wp');
    const admin = connect(PG_URL);
    const role = `hist_w_${Math.random().toString(36).slice(2, 8)}`;
    try {
      await admin.db.exec(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`);
      await t.db.exec(
        `revoke create on database ${(await t.db.query<{ n: string }>('select current_database() as n'))[0]!.n} from public`,
      );
      const u = new URL(t.url);
      u.username = role;
      u.password = 'pw';
      const limited = connect(u.toString());
      try {
        expect(await historyWriteProblem(limited.db)).toMatchObject({ code: 'no_schema_privilege' });
      } finally {
        await limited.close();
      }
      expect(await t.db.query("select 1 from pg_namespace where nspname = 'dowel'")).toEqual([]);
      // 有权限、没有历史：没有问题，仍然什么都没建
      expect(await historyWriteProblem(t.db)).toBeNull();
      expect(await t.db.query("select 1 from pg_namespace where nspname = 'dowel'")).toEqual([]);
    } finally {
      await t.close();
      await admin.db.exec(`DROP ROLE IF EXISTS ${role}`);
      await admin.close();
    }
  });
});
