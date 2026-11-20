// 执行器（H3）：真实 PG。覆盖链式执行 / 回滚、并发、中途失败后重试、非事务步骤断点续跑、
// 完整性（篡改校验和）、漂移、首次执行（基线 / 空库 / 结构不符）、读回校验、脱敏。
import {
  addColumn,
  addForeignKey,
  addIndex,
  addPrimaryKey,
  addUnique,
  createSchema,
  createTable,
  emptyBase,
  emptyModel,
  type Model,
  plan,
} from '@dowel/core';
import {
  type Db,
  importSnapshot,
  readHistory,
  readSnapshot,
  reconcileIds,
  ScopeError,
  type ScriptStep,
  stepsChecksum,
  toScriptSteps,
} from '@dowel/engines';
import { expect, test } from 'vitest';
import { connect, createTestDb, PG_URL, useTestDb } from '../../../test/pg.ts';
import { build } from '../../verifier/src/index.ts';
import {
  type ChainVersion,
  checkDrift,
  diffAgainst,
  ExecutorError,
  type ExecutorEvent,
  execute,
  isReadbackFailure,
  parseCreateIndexConcurrently,
  parseDetachConcurrently,
  readState,
} from '../src/index.ts';

const scratch = useTestDb('exec_scratch');

// ───── 模型与版本链 ─────

const m0 = (): Model => {
  const m = emptyModel();
  const pub = createSchema(m, 'public', 'p');
  const t = createTable(m, pub, 'users', 't-users');
  const id = addColumn(m, t, { name: 'id', type: 'bigint', notNull: true, id: 'c-id' });
  addPrimaryKey(m, t, [id], 'pk-users');
  return m;
};
const withEmail = (m: Model): Model => {
  const c = structuredClone(m);
  addColumn(c, 't-users', { name: 'email', type: 'text', id: 'c-email' });
  return c;
};
const withOrders = (m: Model): Model => {
  const c = structuredClone(m);
  createTable(c, 'p', 'orders', 't-orders');
  const id = addColumn(c, 't-orders', { name: 'id', type: 'bigint', notNull: true, id: 'c-oid' });
  addPrimaryKey(c, 't-orders', [id], 'pk-orders');
  return c;
};

/** 发布时模型是规范化过的（表达式、默认值是引擎的规范形式）：在影子库里建一遍再读回，沿用原来的 ID */
const canon = async (m: Model): Promise<Model> => {
  await build(scratch(), m);
  return reconcileIds(m, importSnapshot(await readSnapshot(scratch())));
};

const version = (
  models: Model[],
  i: number,
  start: 0 | 1,
  patch: Partial<ChainVersion> = {},
): ChainVersion => {
  const model = models[i]!;
  const from = i === 0 ? emptyBase(model, patch.scope ?? null) : models[i - 1]!;
  const up = toScriptSteps(plan(from, model));
  const down = i === 0 && start === 0 ? [] : toScriptSteps(plan(model, from));
  return {
    id: `v-${start + i}`,
    number: start + i,
    parentId: i === 0 ? null : `v-${start + i - 1}`,
    name: `版本 ${start + i}`,
    model,
    upSteps: up,
    downSteps: down,
    checksum: stepsChecksum(up, down),
    verified: true,
    publishedAt: new Date().toISOString(),
    publishedBy: null,
    scope: null,
    ...patch,
  };
};

/** 一条版本链：start = 1 是空白项目（v1 从空库建出），start = 0 是导入项目（v0 基线） */
const chainOf = (models: Model[], start: 0 | 1 = 1, scope: string[] | null = null): ChainVersion[] =>
  models.map((_, i) => version(models, i, start, { scope }));

/** 改某个版本的脚本（像人工编辑冻结脚本那样），校验和重算 */
const withSteps = (
  chain: ChainVersion[],
  number: number,
  up?: ScriptStep[],
  down?: ScriptStep[],
): ChainVersion[] =>
  chain.map((v) => {
    if (v.number !== number) return v;
    const u = up ?? v.upSteps;
    const d = down ?? v.downSteps;
    return { ...v, upSteps: u, downSteps: d, checksum: stepsChecksum(u, d) };
  });

const tx = (sql: string): ScriptStep => ({ sql, transactional: true });
const nontx = (sql: string): ScriptStep => ({ sql, transactional: false });

const idOf = (chain: ChainVersion[], n: number) => chain.find((v) => v.number === n)!.id;

const run = (db: Db, chain: ChainVersion[], to: number, extra: Partial<Parameters<typeof execute>[0]> = {}) =>
  execute({
    db,
    projectId: 'p1',
    projectName: '演示',
    instanceId: 'inst-A',
    chain,
    to: idOf(chain, to),
    executedBy: 'u1',
    ...extra,
  });

const fails = async (p: Promise<unknown>): Promise<ExecutorError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e, '应该抛 ExecutorError').toBeInstanceOf(ExecutorError);
  return e as ExecutorError;
};

const withTarget = async (fn: (t: Awaited<ReturnType<typeof createTestDb>>) => Promise<void>) => {
  const t = await createTestDb('exec_t');
  try {
    await fn(t);
  } finally {
    await t.close();
  }
};

const structureIs = async (db: Db, m: Model) => {
  const d = diffAgainst(await readSnapshot(db), m);
  expect(d.items, '结构应该等于模型').toEqual([]);
};
const hasDowelSchema = async (db: Db) =>
  (await db.query<{ n: string | null }>(`select to_regnamespace('dowel')::text as n`))[0]!.n !== null;

const DUP = `insert into public.users (id, email) values (1, 'a@x.com'), (2, 'a@x.com')`;

// ───── 测试 ─────

test.skipIf(!PG_URL)('链式执行 v1→v3、回滚 v3→v1、再执行、重复执行是空操作', async () => {
  const models = [await canon(m0()), await canon(withEmail(m0())), await canon(withOrders(withEmail(m0())))];
  const chain = chainOf(models);
  await withTarget(async (t) => {
    const events: ExecutorEvent[] = [];
    const r = await run(t.db, chain, 3, { onEvent: (e) => void events.push(e) });
    expect(r).toMatchObject({ direction: 'up', baseline: false, current: idOf(chain, 3) });
    expect(r.ran.map((x) => [x.number, x.direction])).toEqual([
      [1, 'up'],
      [2, 'up'],
      [3, 'up'],
    ]);
    await structureIs(t.db, models[2]!);

    // 进度事件：先拿锁、检查，再给出计划，然后每个迁移 start → step… → done
    expect(events[0]).toEqual({ type: 'phase', phase: 'lock' });
    expect(events.find((e) => e.type === 'plan')).toMatchObject({
      baseline: false,
      migrations: [{ number: 1 }, { number: 2 }, { number: 3 }],
    });
    const starts = events.filter((e) => e.type === 'migration' && e.status === 'start');
    const dones = events.filter((e) => e.type === 'migration' && e.status === 'done');
    expect(starts.length).toBe(3);
    expect(dones.length).toBe(3);

    let h = await readHistory(t.db, 'p1');
    expect(h.currentVersion).toBe(idOf(chain, 3));
    expect(h.history.map((x) => [x.direction, x.status, x.executedBy, x.via, x.instanceId])).toEqual([
      ['up', 'done', 'u1', 'web', 'inst-A'],
      ['up', 'done', 'u1', 'web', 'inst-A'],
      ['up', 'done', 'u1', 'web', 'inst-A'],
    ]);
    expect(h.versions.map((v) => v.number)).toEqual([1, 2, 3]);
    expect(h.versions.every((v) => /^[0-9a-f]{64}$/.test(v.fingerprint))).toBe(true);

    // 再执行到同一个版本：什么都不做
    const noop = await run(t.db, chain, 3);
    expect(noop).toMatchObject({ direction: 'none', ran: [] });

    // 回滚 v3 → v1：沿 down 链逐个执行
    const back = await run(t.db, chain, 1);
    expect(back).toMatchObject({ direction: 'down', current: idOf(chain, 1) });
    expect(back.ran.map((x) => [x.number, x.direction])).toEqual([
      [3, 'down'],
      [2, 'down'],
    ]);
    await structureIs(t.db, models[0]!);
    h = await readHistory(t.db, 'p1');
    expect(h.currentVersion).toBe(idOf(chain, 1));
    expect(h.history.slice(3).map((x) => [x.fromVersion, x.toVersion, x.direction])).toEqual([
      [idOf(chain, 3), idOf(chain, 2), 'down'],
      [idOf(chain, 2), idOf(chain, 1), 'down'],
    ]);

    // 回滚之后没有漂移；再前进到 v3
    expect((await checkDrift({ db: t.db, projectId: 'p1', chain })).status).toBe('ok');
    await run(t.db, chain, 3);
    await structureIs(t.db, models[2]!);
  });
});

test.skipIf(!PG_URL)('并发：同一个库两次执行只有一次真正执行；等不到锁就超时失败', async () => {
  const models = [await canon(m0()), await canon(withEmail(m0())), await canon(withOrders(withEmail(m0())))];
  // v2 里加一个 pg_sleep 步骤，让第一次执行持锁足够久
  const chain = withSteps(chainOf(models), 2, [...chainOf(models)[1]!.upSteps, tx('SELECT pg_sleep(1.5)')]);
  await withTarget(async (t) => {
    const other = connect(t.url);
    try {
      const [a, b] = await Promise.all([run(t.db, chain, 3), run(other.db, chain, 3)]);
      // 一个执行了 3 个迁移，另一个等到锁之后发现已经到位，什么都没做
      expect([a.ran.length, b.ran.length].sort()).toEqual([0, 3]);
      const h = await readHistory(t.db, 'p1');
      expect(h.history.filter((x) => x.status === 'done').length).toBe(3);
      expect(h.history.length).toBe(3);
    } finally {
      await other.close();
    }
  });
  await withTarget(async (t) => {
    const other = connect(t.url);
    try {
      const slow = run(t.db, chain, 3);
      await new Promise((r) => setTimeout(r, 600));
      const e = await fails(run(other.db, chain, 3, { lockTimeoutMs: 200 }));
      expect(e.code).toBe('lock_timeout');
      // 同时做漂移检查：正在执行，库是半途状态，跳过
      expect(await checkDrift({ db: other.db, projectId: 'p1', chain })).toEqual({
        status: 'skipped',
        reason: 'busy',
      });
      await slow;
      expect((await readHistory(t.db, 'p1')).currentVersion).toBe(idOf(chain, 3));
    } finally {
      await other.close();
    }
  });
});

test.skipIf(!PG_URL)('中途失败：停在上一个版本，失败的迁移回滚；修好之后重试成功', async () => {
  const models = [await canon(m0()), await canon(withEmail(m0()))];
  const uniq = structuredClone(models[1]!);
  addUnique(uniq, 't-users', ['c-email'], false, 'uq-email');
  models.push(await canon(uniq));
  const chain = chainOf(models);
  await withTarget(async (t) => {
    await run(t.db, chain, 2);
    await t.db.exec(DUP); // 重复的邮箱：v3 加唯一约束会失败
    const e = await fails(run(t.db, chain, 3));
    expect(e.code).toBe('step_failed');
    expect(e.details).toMatchObject({ number: 3, direction: 'up', partial: false, reached: idOf(chain, 2) });
    expect(e.details.step).toBeGreaterThanOrEqual(1);

    // 停在 v2：结构没变（事务回滚），历史里有一条失败记录，当前版本还是 v2
    await structureIs(t.db, models[1]!);
    const h = await readHistory(t.db, 'p1');
    expect(h.currentVersion).toBe(idOf(chain, 2));
    const last = h.history.at(-1)!;
    expect([last.status, last.direction, last.toVersion, last.stepIndex]).toEqual([
      'failed',
      'up',
      idOf(chain, 3),
      null,
    ]);
    expect(last.error).toContain('步执行失败');
    expect(h.versions.map((v) => v.number)).toEqual([1, 2]); // v3 的版本行随事务回滚

    // 修好数据，重试成功（漂移检查通过：结构没被半个迁移弄脏）
    await t.db.exec(`delete from public.users where id = 2`);
    const r = await run(t.db, chain, 3);
    expect(r.ran.map((x) => x.number)).toEqual([3]);
    await structureIs(t.db, models[2]!);
    expect((await readHistory(t.db, 'p1')).currentVersion).toBe(idOf(chain, 3));
  });
});

test.skipIf(!PG_URL)('非事务步骤（CREATE INDEX CONCURRENTLY）失败后从断点续跑', async () => {
  const m2 = await canon(withEmail(m0()));
  const m3src = structuredClone(m2);
  addColumn(m3src, 't-users', { name: 'note', type: 'text', id: 'c-note' });
  addIndex(m3src, 't-users', [{ column: 'c-email' }], { unique: true }, 'ix-email');
  const models = [await canon(m0()), m2, await canon(m3src)];
  let chain = chainOf(models);
  // 手工改成：事务步骤（加列）+ 非事务的 CREATE UNIQUE INDEX CONCURRENTLY
  const planned = chain[2]!.upSteps;
  expect(planned.some((s) => /CREATE UNIQUE INDEX/.test(s.sql))).toBe(true);
  chain = withSteps(
    chain,
    3,
    planned.map((s) =>
      /^CREATE UNIQUE INDEX/.test(s.sql)
        ? nontx(s.sql.replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX CONCURRENTLY'))
        : s,
    ),
  );
  expect(chain[2]!.upSteps.some((s) => !s.transactional)).toBe(true);

  await withTarget(async (t) => {
    await run(t.db, chain, 2);
    await t.db.exec(DUP);
    const events: ExecutorEvent[] = [];
    const e = await fails(run(t.db, chain, 3, { onEvent: (x) => void events.push(x) }));
    expect(e.code).toBe('step_failed');
    expect(e.details).toMatchObject({ number: 3, partial: true, reached: idOf(chain, 2) });
    // 加列那一段已经提交了：库处于半途状态，历史里有断点
    let h = await readHistory(t.db, 'p1');
    expect(h.currentVersion).toBe(idOf(chain, 2));
    const failed = h.history.at(-1)!;
    expect(failed.status).toBe('failed');
    expect(failed.stepIndex).not.toBeNull();
    const has = (n: string) =>
      t.db.query<{ n: number }>(
        `select count(*)::int as n from information_schema.columns where table_name = 'users' and column_name = '${n}'`,
      );
    expect((await has('note'))[0]!.n).toBe(1);
    // 失败的 CREATE INDEX CONCURRENTLY 留下了无效索引
    const invalid = async () =>
      (
        await t.db.query<{ n: number }>(
          `select count(*)::int as n from pg_index i join pg_class c on c.oid = i.indexrelid
            where not i.indisvalid and c.relname ilike '%email%'`,
        )
      )[0]!.n;
    expect(await invalid()).toBe(1);

    // 半途状态下：漂移检查跳过；改做别的（回滚）被拒绝，必须先把它跑完
    expect(await checkDrift({ db: t.db, projectId: 'p1', chain })).toEqual({
      status: 'skipped',
      reason: 'unfinished',
    });
    expect((await fails(run(t.db, chain, 1))).code).toBe('unfinished_run');

    // 修好数据，重试：从断点续跑（加列不会再执行一遍），自己留下的无效索引先被清掉
    await t.db.exec(`delete from public.users where id = 2`);
    events.length = 0;
    const r = await run(t.db, chain, 3, { onEvent: (x) => void events.push(x) });
    expect(r.ran.map((x) => [x.number, x.direction])).toEqual([[3, 'up']]);
    expect(events.some((x) => x.type === 'migration' && x.resumed === true)).toBe(true);
    await structureIs(t.db, models[2]!);
    expect(await invalid()).toBe(0);
    h = await readHistory(t.db, 'p1');
    expect(h.currentVersion).toBe(idOf(chain, 3));
    expect(h.history.at(-1)).toMatchObject({ status: 'done' });
    expect(h.history.map((x) => x.status)).toEqual(['done', 'done', 'failed', 'done']);
    // 续跑成功后恢复正常：漂移检查通过，可以回滚
    expect((await checkDrift({ db: t.db, projectId: 'p1', chain })).status).toBe('ok');
    await run(t.db, chain, 2);
  });
});

test.skipIf(!PG_URL)(
  '完整性：目标库历史里的校验和 / 脚本被篡改 → 拒绝；平台库的链被篡改 → 拒绝',
  async () => {
    const models = [
      await canon(m0()),
      await canon(withEmail(m0())),
      await canon(withOrders(withEmail(m0()))),
    ];
    const chain = chainOf(models);
    await withTarget(async (t) => {
      await run(t.db, chain, 2);
      // 改校验和
      await t.db.exec(`update dowel.versions set checksum = repeat('0', 64) where version_id = 'v-1'`);
      let e = await fails(run(t.db, chain, 3));
      expect(e.code).toBe('history_broken');
      expect(e.message).toContain('不完整或被改动过');
      // 还原校验和，改脚本内容（校验和按内容重算，对不上）
      const good = chain[0]!.checksum;
      await t.db.exec(`update dowel.versions set checksum = '${good}' where version_id = 'v-1'`);
      await t.db.exec(
        `update dowel.versions set up_steps = '[{"sql":"DROP TABLE public.users","transactional":true}]'::jsonb where version_id = 'v-2'`,
      );
      e = await fails(run(t.db, chain, 3));
      expect(e.code).toBe('history_broken');
      // 什么都没有执行
      expect((await readHistory(t.db, 'p1')).history.length).toBe(2);
    });
    await withTarget(async (t) => {
      // 平台库的链：脚本被改了，校验和没跟着变
      const bad = chain.map((v) => (v.number === 2 ? { ...v, upSteps: [tx('DROP TABLE public.users')] } : v));
      const e = await fails(run(t.db, bad, 3));
      expect(e.code).toBe('chain_broken');
      expect(await hasDowelSchema(t.db)).toBe(false);
    });
    await withTarget(async (t) => {
      // 两边都自洽，但互相对不上（平台库里 v2 的脚本换了，校验和也重算了）
      await run(t.db, chain, 2);
      const swapped = withSteps(chain, 2, [tx("COMMENT ON TABLE public.users IS 'x'")]);
      const e = await fails(run(t.db, swapped, 3));
      expect(e.code).toBe('history_mismatch');
    });
  },
);

test.skipIf(!PG_URL)('漂移：手工 ALTER TABLE 被识别并拦住执行和回滚；还原后恢复', async () => {
  const models = [await canon(m0()), await canon(withEmail(m0())), await canon(withOrders(withEmail(m0())))];
  const chain = chainOf(models);
  await withTarget(async (t) => {
    await run(t.db, chain, 2);
    expect((await checkDrift({ db: t.db, projectId: 'p1', chain })).status).toBe('ok');
    await t.db.exec('ALTER TABLE public.users ADD COLUMN sneaky int');

    const e = await fails(run(t.db, chain, 3));
    expect(e.code).toBe('drift');
    expect(e.details.diffTotal).toBeGreaterThan(0);
    expect(e.details.diff?.some((d) => d.sql.includes('sneaky'))).toBe(true);
    expect((await fails(run(t.db, chain, 1))).code).toBe('drift');
    expect((await readHistory(t.db, 'p1')).history.length).toBe(2); // 没有执行任何东西

    const d = await checkDrift({ db: t.db, projectId: 'p1', chain });
    expect(d.status).toBe('drifted');
    if (d.status === 'drifted') {
      expect(d.version).toBe(idOf(chain, 2));
      expect(d.diff.items.some((x) => x.sql.includes('sneaky'))).toBe(true);
    }
    await t.db.exec('ALTER TABLE public.users DROP COLUMN sneaky');
    expect((await checkDrift({ db: t.db, projectId: 'p1', chain })).status).toBe('ok');
    await run(t.db, chain, 3);
  });
});

test.skipIf(!PG_URL)('首次执行：库的结构等于基线 → 只写基线，不执行 SQL；之后正常执行', async () => {
  const models = [await canon(m0()), await canon(withEmail(m0())), await canon(withOrders(withEmail(m0())))];
  const chain = chainOf(models, 0);
  await withTarget(async (t) => {
    await build(t.db, models[0]!); // 导入来源库：已经有 v0 的结构
    await t.db.exec('insert into public.users (id) values (42)');
    // 没有历史时的状态预览：结构等于基线
    expect(await checkDrift({ db: t.db, projectId: 'p1', chain })).toEqual({
      status: 'ok',
      version: idOf(chain, 0),
      firstRun: 'baseline',
    });
    const r = await run(t.db, chain, 0);
    expect(r).toMatchObject({ baseline: true, current: idOf(chain, 0) });
    expect(r.ran.map((x) => x.direction)).toEqual(['baseline']);
    const h = await readHistory(t.db, 'p1');
    expect(h.history.map((x) => [x.direction, x.fromVersion, x.toVersion, x.status])).toEqual([
      ['baseline', null, idOf(chain, 0), 'done'],
    ]);
    expect(h.versions.map((v) => v.number)).toEqual([0]);
    // v0 的建表语句没有执行（否则会因为表已存在而失败，数据也会丢）
    expect((await t.db.query<{ id: number }>('select id::int from public.users'))[0]!.id).toBe(42);

    // 之后正常执行
    const next = await run(t.db, chain, 2);
    expect(next.ran.map((x) => x.number)).toEqual([1, 2]);
    expect((await t.db.query<{ id: number }>('select id::int from public.users'))[0]!.id).toBe(42);
    await structureIs(t.db, models[2]!);
  });
  // 一路执行到 v2：基线之后接着执行，一次完成
  await withTarget(async (t) => {
    await build(t.db, models[0]!);
    const r = await run(t.db, chain, 2);
    expect(r.baseline).toBe(true);
    expect(r.ran.map((x) => [x.number, x.direction])).toEqual([
      [0, 'baseline'],
      [1, 'up'],
      [2, 'up'],
    ]);
  });
  // 显式只写基线；写过之后再写 → 拒绝
  await withTarget(async (t) => {
    await build(t.db, models[0]!);
    const r = await execute({
      db: t.db,
      projectId: 'p1',
      projectName: '演示',
      instanceId: 'inst-A',
      chain,
      mode: 'baseline',
      executedBy: 'u1',
    });
    expect(r).toMatchObject({ baseline: true, direction: 'none' });
    expect((await readHistory(t.db, 'p1')).currentVersion).toBe(idOf(chain, 0));
    const e = await fails(
      execute({
        db: t.db,
        projectId: 'p1',
        projectName: '演示',
        instanceId: 'inst-A',
        chain,
        mode: 'baseline',
        executedBy: 'u1',
      }),
    );
    expect(e.code).toBe('baseline_not_applicable');
  });
});

test.skipIf(!PG_URL)('首次执行：空库 → 执行 v0 的 up 完整建库', async () => {
  const models = [await canon(m0()), await canon(withEmail(m0()))];
  const chain = chainOf(models, 0);
  await withTarget(async (t) => {
    expect(await checkDrift({ db: t.db, projectId: 'p1', chain })).toMatchObject({
      status: 'ok',
      firstRun: 'empty',
    });
    const r = await run(t.db, chain, 1);
    expect(r.baseline).toBe(false);
    expect(r.ran.map((x) => [x.number, x.direction])).toEqual([
      [0, 'up'],
      [1, 'up'],
    ]);
    await structureIs(t.db, models[1]!);
    const h = await readHistory(t.db, 'p1');
    expect(h.history[0]).toMatchObject({ fromVersion: null, toVersion: idOf(chain, 0), direction: 'up' });
    // 空库上写基线没有意义
    const e = await fails(
      execute({
        db: (await createTestDb('exec_e')).db,
        projectId: 'p1',
        projectName: null,
        instanceId: 'inst-A',
        chain,
        mode: 'baseline',
        executedBy: null,
      }),
    );
    expect(e.code).toBe('baseline_not_applicable');
  });
});

test.skipIf(!PG_URL)('首次执行：结构既不是基线也不是空库 → 报漂移，目标库里什么都不建', async () => {
  const models = [await canon(m0()), await canon(withEmail(m0()))];
  const chain = chainOf(models, 0);
  await withTarget(async (t) => {
    await t.db.exec('create table public.legacy (id int)');
    const e = await fails(run(t.db, chain, 1));
    expect(e.code).toBe('first_run_drift');
    expect(e.details.diffTotal).toBeGreaterThan(0);
    expect(await hasDowelSchema(t.db)).toBe(false);
    expect(await checkDrift({ db: t.db, projectId: 'p1', chain })).toMatchObject({
      status: 'drifted',
      firstRun: true,
    });
    // 基线版本的结构多了一张表也不行
    await build(t.db, models[0]!);
    await t.db.exec('alter table public.users add column extra int');
    expect((await fails(run(t.db, chain, 1))).code).toBe('first_run_drift');
    expect(await hasDowelSchema(t.db)).toBe(false);
  });
});

test.skipIf(!PG_URL)('未验证的迁移、含实例级语句的迁移都拒绝，且一条都不执行', async () => {
  const models = [await canon(m0()), await canon(withEmail(m0())), await canon(withOrders(withEmail(m0())))];
  await withTarget(async (t) => {
    const chain = chainOf(models).map((v) => (v.number === 2 ? { ...v, verified: false } : v));
    const e = await fails(run(t.db, chain, 3));
    expect(e.code).toBe('unverified');
    expect(e.message).toContain('重新验证');
    expect(await hasDowelSchema(t.db)).toBe(false); // v1 也没有被执行
  });
  await withTarget(async (t) => {
    const base = chainOf(models);
    const chain = withSteps(base, 2, [...base[1]!.upSteps, tx('CREATE ROLE dowel_exec_evil LOGIN')]);
    const e = await fails(run(t.db, chain, 2));
    expect(e.code).toBe('instance_level');
    expect(e.details.step).toBe(2);
    expect(await hasDowelSchema(t.db)).toBe(false);
    expect(
      (
        await t.db.query<{ n: number }>(
          `select count(*)::int as n from pg_roles where rolname = 'dowel_exec_evil'`,
        )
      )[0]!.n,
    ).toBe(0);
  });
});

test.skipIf(!PG_URL)('读回的结构与目标版本不一致 → 回滚、记失败、停在原版本', async () => {
  const models = [await canon(m0()), await canon(withEmail(m0())), await canon(withOrders(withEmail(m0())))];
  const base = chainOf(models);
  // v3 的回滚脚本是空的：执行完结构并没有回到 v2
  const chain = withSteps(base, 3, undefined, []);
  await withTarget(async (t) => {
    await run(t.db, chain, 3);
    const e = await fails(run(t.db, chain, 2));
    expect(e.code).toBe('readback_mismatch');
    expect(e.details.diffTotal).toBeGreaterThan(0);
    const h = await readHistory(t.db, 'p1');
    expect(h.currentVersion).toBe(idOf(chain, 3));
    expect(h.history.at(-1)).toMatchObject({ status: 'failed', direction: 'down' });
    await structureIs(t.db, models[2]!);
  });
  await withTarget(async (t) => {
    // 升级脚本做得不对：读回不等于模型，事务回滚，连 v2 的版本行都不留
    const wrongUp = withSteps(base, 2, [tx('SELECT 1')]);
    await run(t.db, wrongUp, 1);
    const e = await fails(run(t.db, wrongUp, 2));
    expect(e.code).toBe('readback_mismatch');
    const h = await readHistory(t.db, 'p1');
    expect(h.versions.map((v) => v.number)).toEqual([1]);
    await structureIs(t.db, models[0]!);
  });
});

test.skipIf(!PG_URL)('错误文本脱敏：返回的错误和写进目标库历史的错误都不含密码', async () => {
  const models = [await canon(m0()), await canon(withEmail(m0()))];
  const base = chainOf(models);
  const chain = withSteps(base, 2, [
    tx(`DO $$ BEGIN RAISE EXCEPTION 'cannot reach postgres://app:s3cretpw@db.internal/prod'; END $$`),
  ]);
  await withTarget(async (t) => {
    await run(t.db, chain, 1);
    const e = await fails(run(t.db, chain, 2));
    expect(e.code).toBe('step_failed');
    expect(e.message).not.toContain('s3cretpw');
    expect(e.message).toContain('postgres://app:***@');
    const last = (await readHistory(t.db, 'p1')).history.at(-1)!;
    expect(last.error).not.toContain('s3cretpw');
    expect(last.error).toContain('***');
  });
});

test.skipIf(!PG_URL)('历史属于另一个实例 → 拒绝（认领流程之后提供）', async () => {
  const models = [await canon(m0()), await canon(withEmail(m0()))];
  const chain = chainOf(models);
  await withTarget(async (t) => {
    await run(t.db, chain, 1);
    const e = await fails(run(t.db, chain, 2, { instanceId: 'inst-B' }));
    expect(e.code).toBe('foreign_instance');
  });
});

test.skipIf(!PG_URL)('回滚到链上第一个版本之前不行；不存在的版本报 unknown_version', async () => {
  const models = [await canon(m0()), await canon(withEmail(m0()))];
  const chain = chainOf(models);
  await withTarget(async (t) => {
    const e = await fails(execute({ ...base(t.db, chain), to: 'nope' }));
    expect(e.code).toBe('unknown_version');
  });
});

// ───── 审查后补充 ─────

/** 包一层 Db：armed 之后，读结构的第一条目录查询抛出指定错误（模拟读回阶段的意外错误） */
const flaky = (inner: Db, armOn: RegExp, err: () => Error) => {
  let armed = false;
  const db: Db = {
    query: async (q, params) => {
      if (armed && /pg_namespace/.test(q)) {
        armed = false;
        throw err();
      }
      return inner.query(q, params);
    },
    exec: async (q) => {
      if (armOn.test(q)) armed = true;
      return inner.exec(q);
    },
  };
  return db;
};

test.skipIf(!PG_URL)(
  '读回阶段的意外错误（普通 Error）：失败记录照样写下来（脱敏、不留 running），原错误包成 unexpected 抛出',
  async () => {
    const models = [await canon(m0()), await canon(withEmail(m0()))];
    const chain = chainOf(models);
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      const bad = flaky(
        t.db,
        /ADD COLUMN/,
        () => new Error('boom: could not connect to postgres://u:s3cretpw@h/db'),
      );
      const e = await fails(run(bad, chain, 2));
      expect(e.code).toBe('unexpected');
      expect(e.message).not.toContain('s3cretpw');
      expect(e.cause).toBeInstanceOf(Error);
      expect(e.details).toMatchObject({ number: 2, partial: false, reached: idOf(chain, 1) });
      const h = await readHistory(t.db, 'p1');
      expect(h.currentVersion).toBe(idOf(chain, 1));
      const last = h.history.at(-1)!;
      expect(last.status).toBe('failed'); // 不会一直停在 running
      expect(last.error).toContain('boom');
      expect(last.error).not.toContain('s3cretpw');
      await structureIs(t.db, models[0]!); // 事务回滚了
      // 修好之后重试成功
      await run(t.db, chain, 2);
      await structureIs(t.db, models[1]!);
    });
  },
);

test.skipIf(!PG_URL)(
  '读回阶段的 ScopeError（迁移造出了跨范围的引用）：事务回滚，失败记录写下来，错误的 cause 是 ScopeError',
  async () => {
    const mk = (extra: boolean): Model => {
      const m = emptyModel();
      const app = createSchema(m, 'app', 's-app');
      const t = createTable(m, app, 'a', 't-a');
      addColumn(m, t, { name: 'id', type: 'bigint', notNull: true, id: 'c-aid' });
      if (extra) addColumn(m, t, { name: 'bid', type: 'integer', id: 'c-bid' });
      return m;
    };
    const models = [await canon(mk(false)), await canon(mk(true))];
    let chain = chainOf(models, 1, ['app']);
    // v2 在范围内的 app.a 上加了一个指向范围外 public.b 的外键
    chain = withSteps(chain, 2, [
      tx('CREATE TABLE public.b (id integer PRIMARY KEY)'),
      tx('ALTER TABLE app.a ADD COLUMN bid integer REFERENCES public.b (id)'),
    ]);
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      const e = await fails(run(t.db, chain, 2));
      expect(e.code).toBe('unexpected');
      expect(e.cause).toBeInstanceOf(ScopeError);
      const h = await readHistory(t.db, 'p1');
      expect(h.history.at(-1)).toMatchObject({ status: 'failed', direction: 'up' });
      expect(h.currentVersion).toBe(idOf(chain, 1));
      // 事务回滚了：public.b 没有建出来
      expect(
        (
          await t.db.query<{ n: number }>(`select count(*)::int as n from pg_tables where tablename = 'b'`)
        )[0]!.n,
      ).toBe(0);
    });
  },
);

/** v1 = users(id, email)，v2 = v1 + email 上的唯一索引，v2 的升级脚本手工改成 CREATE UNIQUE INDEX CONCURRENTLY */
const cicChain = async () => {
  const m1 = await canon(withEmail(m0()));
  const m2src = structuredClone(m1);
  addIndex(m2src, 't-users', [{ column: 'c-email' }], { unique: true }, 'ix-email');
  const models = [m1, await canon(m2src)];
  const chain = chainOf(models);
  const planned = chain[1]!.upSteps;
  expect(planned).toHaveLength(1);
  expect(planned[0]!.sql).toMatch(/^CREATE UNIQUE INDEX/);
  return {
    models,
    chain: withSteps(chain, 2, [
      nontx(planned[0]!.sql.replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX CONCURRENTLY')),
    ]),
  };
};

test.skipIf(!PG_URL)(
  '第一个非事务步骤就失败（留下 INVALID 索引）：记为“已开始”，可以续跑，不会被判成漂移',
  async () => {
    const { models, chain } = await cicChain();
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      await t.db.exec(DUP);
      const e = await fails(run(t.db, chain, 2));
      expect(e.code).toBe('step_failed');
      expect(e.details).toMatchObject({ number: 2, partial: true, step: 1, reached: idOf(chain, 1) });
      // 库里留下了无效索引；历史里断点是 -1（已开始、没完成任何一步）
      const invalid = async () =>
        (await t.db.query<{ n: number }>('select count(*)::int as n from pg_index where not indisvalid'))[0]!
          .n;
      expect(await invalid()).toBe(1);
      const st = await readState(t.db, 'p1');
      expect(st.unfinished).toMatchObject({ status: 'failed', stepIndex: -1 });
      expect(st.readbackFailure).toBeNull();
      // 漂移检查跳过（半途状态），不是漂移；改做别的被拒绝
      expect(await checkDrift({ db: t.db, projectId: 'p1', chain })).toEqual({
        status: 'skipped',
        reason: 'unfinished',
      });
      expect((await fails(run(t.db, chain, 1))).code).toBe('unfinished_run');
      // 修好数据，续跑：先清掉遗留的无效索引再重跑第 0 步
      await t.db.exec('delete from public.users where id = 2');
      const events: ExecutorEvent[] = [];
      const r = await run(t.db, chain, 2, { onEvent: (x) => void events.push(x) });
      expect(r.ran.map((x) => x.number)).toEqual([2]);
      expect(events.some((x) => x.type === 'migration' && x.resumed === true)).toBe(true);
      expect(await invalid()).toBe(0);
      await structureIs(t.db, models[1]!);
      expect((await readHistory(t.db, 'p1')).history.map((x) => x.status)).toEqual([
        'done',
        'failed',
        'done',
      ]);
      expect((await checkDrift({ db: t.db, projectId: 'p1', chain })).status).toBe('ok');
    });
  },
);

test.skipIf(!PG_URL)(
  '最后一步是非事务步骤、读回校验失败：不能续跑，报成漂移（附差异、说明需要人工修正），不会无限重复',
  async () => {
    const models = [await canon(m0()), await canon(m0())];
    // v2 的模型和 v1 一样（没有索引），升级脚本却建了一个索引：所有步骤都做完了，读回的结构对不上
    const chain = withSteps(
      chainOf(models),
      2,
      [nontx('CREATE INDEX CONCURRENTLY "ix_extra" ON "public"."users" ("id")')],
      [nontx('DROP INDEX CONCURRENTLY "public"."ix_extra"')],
    );
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      const e = await fails(run(t.db, chain, 2));
      expect(e.code).toBe('readback_mismatch');
      expect(e.details).toMatchObject({ number: 2, partial: true, reached: idOf(chain, 1) });
      const h = await readHistory(t.db, 'p1');
      expect(h.currentVersion).toBe(idOf(chain, 1));
      const last = h.history.at(-1)!;
      expect(last.status).toBe('failed');
      expect(isReadbackFailure(last.error)).toBe(true);
      const runs = h.history.length;
      // 不算“停在中途”，而是需要人工处理：漂移检查报漂移（附差异），不报 unfinished
      const st = await readState(t.db, 'p1');
      expect(st.unfinished).toBeNull();
      expect(st.readbackFailure?.id).toBe(last.id);
      const d = await checkDrift({ db: t.db, projectId: 'p1', chain });
      expect(d.status).toBe('drifted');
      if (d.status === 'drifted') {
        expect(d.needsManual).toMatchObject({ direction: 'up', versionId: idOf(chain, 2) });
        expect(d.diff.items.some((i) => i.sql.includes('ix_extra'))).toBe(true);
      }
      // 再执行：在漂移检查处被拒绝（说明原因），不会再跑一遍同样的步骤和读回
      for (const to of [2]) {
        const again = await fails(run(t.db, chain, to));
        expect(again.code).toBe('drift');
        expect(again.details.needsManual).toEqual({ direction: 'up', versionId: idOf(chain, 2) });
        expect(again.message).toContain('上一次执行');
        expect(again.message).toContain('手工修正');
      }
      expect((await readHistory(t.db, 'p1')).history.length).toBe(runs);
      // 人工修正（删掉多出来的索引，回到当前版本 v1 的样子）之后漂移消失，漂移检查返回 ok。
      // 历史里那条读回失败的记录还在（历史只追加），readState 仍然标着它，但它只在“有漂移”时才有意义：
      // 之后的执行会从头重新执行 v2（新开一条记录），不会假装已经到了 v2
      await t.db.exec('DROP INDEX public.ix_extra');
      expect((await checkDrift({ db: t.db, projectId: 'p1', chain })).status).toBe('ok');
      expect((await readState(t.db, 'p1')).current).toBe(idOf(chain, 1));
    });
  },
);

test('parseCreateIndexConcurrently：只认写明 schema 的表，解析不了就不动', () => {
  expect(parseCreateIndexConcurrently('CREATE UNIQUE INDEX CONCURRENTLY "ix" ON "a"."t" ("x")')).toEqual({
    index: 'ix',
    schema: 'a',
    table: 't',
  });
  expect(
    parseCreateIndexConcurrently('create index concurrently if not exists Ix on only A.T using btree (x)'),
  ).toEqual({ index: 'ix', schema: 'a', table: 't' });
  expect(parseCreateIndexConcurrently('CREATE INDEX CONCURRENTLY "My ""Ix""" ON "S p"."T 1" (x)')).toEqual({
    index: 'My "Ix"',
    schema: 'S p',
    table: 'T 1',
  });
  expect(parseCreateIndexConcurrently('CREATE INDEX CONCURRENTLY ix ON t (x)')).toBe('unparsed'); // 没写 schema
  expect(parseCreateIndexConcurrently('CREATE INDEX CONCURRENTLY ON a.t (x)')).toBe('unparsed');
  expect(parseCreateIndexConcurrently('CREATE INDEX ix ON a.t (x)')).toBeNull(); // 不是 CIC
  expect(parseCreateIndexConcurrently('DROP INDEX CONCURRENTLY a.ix')).toBeNull();
});

test.skipIf(!PG_URL)(
  '清理遗留的无效索引是精确匹配：别的 schema 里同名表上的同名无效索引不会被删',
  async () => {
    const mk = (withIndex: boolean): Model => {
      const m = emptyModel();
      const a = createSchema(m, 'a', 's-a');
      const t = createTable(m, a, 't', 't-at');
      addColumn(m, t, { name: 'x', type: 'integer', id: 'c-x' });
      if (withIndex) addIndex(m, t, [{ column: 'c-x' }], { unique: true }, 'ix-x');
      return m;
    };
    const models = [await canon(mk(false)), await canon(mk(true))];
    let chain = chainOf(models, 1, ['a']);
    const planned = chain[1]!.upSteps;
    expect(planned).toHaveLength(1);
    const idxName = /INDEX "?([^" ]+)"? ON/.exec(planned[0]!.sql)![1]!;
    chain = withSteps(chain, 2, [
      nontx(planned[0]!.sql.replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX CONCURRENTLY')),
    ]);
    await withTarget(async (t) => {
      // 范围之外的 schema b 里有同名的表，上面有一个同名的无效索引（手工建失败留下的）
      await t.db.exec('create schema b; create table b.t (x integer); insert into b.t values (1), (1)');
      await t.db.exec(`create unique index concurrently "${idxName}" on b.t (x)`).catch(() => {});
      const invalidIn = async (schema: string) =>
        (
          await t.db.query<{ n: number }>(
            `select count(*)::int as n from pg_index i join pg_class c on c.oid = i.indexrelid
               join pg_namespace n on n.oid = c.relnamespace where not i.indisvalid and n.nspname = '${schema}'`,
          )
        )[0]!.n;
      expect(await invalidIn('b')).toBe(1);

      await run(t.db, chain, 1);
      await t.db.exec('insert into a.t values (1), (1)');
      expect((await fails(run(t.db, chain, 2))).code).toBe('step_failed');
      expect(await invalidIn('a')).toBe(1);
      await t.db.exec('delete from a.t');
      await run(t.db, chain, 2);
      expect(await invalidIn('a')).toBe(0); // 自己留下的清掉了
      expect(await invalidIn('b')).toBe(1); // 别的 schema 的没动
    });
  },
);

test.skipIf(!PG_URL)('漂移检查读结构用当前版本冻结时的 schema 范围，不用别的', async () => {
  const mk = (): Model => {
    const m = emptyModel();
    const a = createSchema(m, 'a', 's-a');
    const t = createTable(m, a, 't', 't-at');
    addColumn(m, t, { name: 'x', type: 'integer', id: 'c-x' });
    return m;
  };
  const models = [await canon(mk())];
  const chain = chainOf(models, 1, ['a']);
  await withTarget(async (t) => {
    await run(t.db, chain, 1);
    // 范围之外的 schema 里多了东西：不是漂移
    await t.db.exec('create schema other; create table other.z (i int)');
    expect((await checkDrift({ db: t.db, projectId: 'p1', chain })).status).toBe('ok');
    // 范围之内改了：是漂移
    await t.db.exec('alter table a.t add column sneaky int');
    expect((await checkDrift({ db: t.db, projectId: 'p1', chain })).status).toBe('drifted');
    // 如果版本冻结的范围是全部，范围之外的东西就算差异
    await t.db.exec('alter table a.t drop column sneaky');
    const wide = chain.map((v) => ({ ...v, scope: null }));
    expect((await checkDrift({ db: t.db, projectId: 'p1', chain: wide })).status).toBe('drifted');
  });
});

// ───── 第二轮审查补充 ─────

/** 记录 onTouch 的调用 */
const touches = () => {
  const touched: number[] = [];
  return {
    touched,
    opts: { onTouch: (m: { version: { number: number } }) => void touched.push(m.version.number) },
  };
};

test.skipIf(!PG_URL)(
  'onTouch：事务整体回滚的失败不算动过目标库；成功、非事务步骤失败、写基线都算',
  async () => {
    const models = [await canon(m0()), await canon(withEmail(m0()))];
    const chain = chainOf(models);
    await withTarget(async (t) => {
      const a = touches();
      await run(t.db, chain, 1, a.opts);
      expect(a.touched).toEqual([1]); // 成功：提交之前报告

      // 步骤报错、事务回滚：没有报告
      const bad = withSteps(chain, 2, [tx('SELECT 1/0')]);
      const b = touches();
      expect((await fails(run(t.db, bad, 2, b.opts))).code).toBe('step_failed');
      expect(b.touched).toEqual([]);

      // 写历史记录时出了意外错误（不是 ExecutorError）：事务没提交，同样没有报告
      const c = touches();
      // 包装层只在 startRun 的 insert 时抛错
      const flakyStart: Db = {
        query: async (q, params) => {
          if (/^\s*insert into dowel\.history/i.test(q)) throw new Error('boom: startRun');
          return t.db.query(q, params);
        },
        exec: (q) => t.db.exec(q),
      };
      const e = await fails(run(flakyStart, chain, 2, c.opts));
      expect(e.code).toBe('unexpected');
      expect(c.touched).toEqual([]);
      await structureIs(t.db, models[0]!);
    });
    // 第一个非事务步骤失败：已经动了（会留下无效索引），要报告
    const { chain: cic } = await cicChain();
    await withTarget(async (t) => {
      await run(t.db, cic, 1);
      await t.db.exec(DUP);
      const a = touches();
      expect((await fails(run(t.db, cic, 2, a.opts))).code).toBe('step_failed');
      expect(a.touched).toEqual([2]);
    });
    // 只写基线：提交之前报告
    const baseChain = chainOf([await canon(m0()), await canon(withEmail(m0()))], 0);
    await withTarget(async (t) => {
      await build(t.db, baseChain[0]!.model);
      const a = touches();
      await run(t.db, baseChain, 0, a.opts);
      expect(a.touched).toEqual([0]);
    });
  },
);

test.skipIf(!PG_URL)(
  'CIC 的提示只属于它自己那一步：前面的 CIC 没能识别索引名、后面的事务步骤失败时，错误里没有无效索引的提示',
  async () => {
    const models = [await canon(m0()), await canon(m0())];
    // 表名和 schema 之间有空格（PG 允许，Dowel 的解析不认）：这条 CIC 解析不了
    const spaced = 'CREATE INDEX CONCURRENTLY "ix_spaced" ON "public" . "users" ("id")';
    const chain = withSteps(chainOf(models), 2, [nontx(spaced), tx('SELECT 1/0')]);
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      const e = await fails(run(t.db, chain, 2));
      expect(e.code).toBe('step_failed');
      expect(e.details.step).toBe(2);
      expect(e.message).not.toContain('无效索引');
      expect(e.message).not.toContain('DROP INDEX CONCURRENTLY');
    });
    // 解析不了的 CIC 自己失败时才有提示
    const m1 = await canon(withEmail(m0()));
    const chain2 = withSteps(chainOf([m1, m1]), 2, [
      nontx('CREATE UNIQUE INDEX CONCURRENTLY "ix_dup" ON "public" . "users" ("email")'),
    ]);
    await withTarget(async (t) => {
      await run(t.db, chain2, 1);
      await t.db.exec(DUP);
      const e = await fails(run(t.db, chain2, 2));
      expect(e.code).toBe('step_failed');
      expect(e.message).toContain('DROP INDEX CONCURRENTLY');
    });
  },
);

// ───── 第三轮审查补充 ─────

test.skipIf(!PG_URL)(
  'COMMIT 本身失败（DEFERRABLE 外键到提交时才检查）：onTouch 不会被调用，目标库没有任何变化',
  async () => {
    const mk = (): Model => {
      const m = emptyModel();
      const pub = createSchema(m, 'public', 'p');
      const parent = createTable(m, pub, 'parent', 't-parent');
      const pid = addColumn(m, parent, { name: 'id', type: 'bigint', notNull: true, id: 'c-pid' });
      addPrimaryKey(m, parent, [pid], 'pk-parent');
      const child = createTable(m, pub, 'child', 't-child');
      const cid = addColumn(m, child, { name: 'id', type: 'bigint', notNull: true, id: 'c-cid' });
      const ref = addColumn(m, child, { name: 'pid', type: 'bigint', id: 'c-ref' });
      addPrimaryKey(m, child, [cid], 'pk-child');
      addForeignKey(
        m,
        child,
        [ref],
        parent,
        [pid],
        { deferrable: true, initiallyDeferred: true },
        'fk-child',
      );
      return m;
    };
    const models = [await canon(mk()), await canon(mk())];
    // v2 的结构和 v1 一样，升级脚本插一行违反外键的数据：约束是 INITIALLY DEFERRED，要到 COMMIT 才检查
    const chain = withSteps(
      chainOf(models),
      2,
      [tx('INSERT INTO public.child (id, pid) VALUES (1, 999)')],
      [],
    );
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      const a = touches();
      const e = await fails(run(t.db, chain, 2, a.opts));
      expect(e.code).toBe('unexpected');
      expect(String((e.cause as { code?: unknown }).code)).toBe('23503'); // COMMIT 时的外键违反
      expect(a.touched).toEqual([]); // COMMIT 没有成功：不能报告“动过目标库”
      expect((await t.db.query<{ n: number }>('select count(*)::int as n from public.child'))[0]!.n).toBe(0);
      const h = await readHistory(t.db, 'p1');
      expect(h.currentVersion).toBe(idOf(chain, 1));
      expect(h.history.at(-1)).toMatchObject({ status: 'failed', stepIndex: null });
    });
  },
);

const base = (db: Db, chain: ChainVersion[]) => ({
  db,
  projectId: 'p1',
  projectName: null,
  instanceId: 'inst-A',
  chain,
  executedBy: null,
});

// ───── 执行策略的超时（P5a）：非事务步骤也生效，失败可识别，断点续跑语义不变 ─────

test.skipIf(!PG_URL)(
  '超时：CREATE INDEX CONCURRENTLY 等旧事务时不受 lock_timeout 约束（它不堵业务），旧事务结束后照常完成',
  async () => {
    const { models, chain } = await cicChain();
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      // 另一个会话开着一个长事务（持有快照）：CIC 要等它结束。这种等待以前受 lock_timeout 约束，5 秒默认值会让它反复失败
      const holder = connect(t.url);
      const reserved = await holder.db.reserve!();
      const timeouts = { statementMs: 0, lockMs: 300 };
      try {
        await reserved.exec('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await reserved.query('select count(*) from public.users');
        const started = Date.now();
        let settled = false;
        const p = run(t.db, chain, 2, { timeouts }).finally(() => {
          settled = true;
        });
        await new Promise((r) => setTimeout(r, 1500));
        // 远超 lock_timeout（300ms）仍在等，没有失败
        expect(settled).toBe(false);
        await reserved.exec('ROLLBACK');
        const r = await p;
        expect(r.ran.map((x) => x.number)).toEqual([2]);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
      } finally {
        await reserved.exec('ROLLBACK').catch(() => {});
        reserved.release?.();
        await holder.close();
      }
      await structureIs(t.db, models[1]!);
    });
  },
);

test.skipIf(!PG_URL)(
  '超时：策略“不限”时不覆盖库端配置（ALTER ROLE … SET statement_timeout 仍然生效），步骤之后用 RESET 回到库端的值',
  async () => {
    const models = [await canon(m0()), await canon(withEmail(m0()))];
    const chain = withSteps(chainOf(models), 2, [tx('SELECT pg_sleep(1)'), ...chainOf(models)[1]!.upSteps]);
    const role = `exec_role_${Math.random().toString(36).slice(2, 8)}`;
    const admin = connect(PG_URL);
    await withTarget(async (t) => {
      const dbName = new URL(t.url).pathname.slice(1);
      await admin.db.exec(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`);
      await admin.db.exec(`ALTER DATABASE ${dbName} OWNER TO ${role}`);
      await admin.db.exec(`ALTER ROLE ${role} SET statement_timeout = '300ms'`);
      const u = new URL(t.url);
      u.username = role;
      u.password = 'pw';
      const conn = connect(u.toString());
      try {
        await run(conn.db, chain, 1, { timeouts: { statementMs: 0, lockMs: 5000 } });
        // 策略不限：不 SET，角色上的 300ms 生效，慢步骤被库端取消——这不是执行策略的超时，按普通失败报告
        const e = await fails(run(conn.db, chain, 2, { timeouts: { statementMs: 0, lockMs: 5000 } }));
        expect(e.code).toBe('step_failed');
        expect(e.details.timeout).toBeUndefined();
        expect(e.message).toContain('statement timeout');
        // 策略设了更长的语句超时：步骤期间用策略的值，慢步骤能跑完
        const r = await run(conn.db, chain, 2, { timeouts: { statementMs: 3000, lockMs: 0 } });
        expect(r.ran.map((x) => x.number)).toEqual([2]);
        // 之后会话回到角色上的配置（RESET，不是 SET 成 0）
        const [s] = await conn.db.query<{ st: string; lt: string }>(
          "select current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt",
        );
        expect(s).toEqual({ st: '300ms', lt: '0' });
      } finally {
        await conn.close();
      }
    });
    await admin.db.exec(`DROP ROLE IF EXISTS ${role}`);
    await admin.close();
  },
);

test.skipIf(!PG_URL)(
  '超时：事务步骤超过 statement_timeout → step_timeout（整体回滚、不是半途状态）',
  async () => {
    const models = [await canon(m0()), await canon(withEmail(m0()))];
    const chain = withSteps(chainOf(models), 2, [tx('SELECT pg_sleep(1)'), ...chainOf(models)[1]!.upSteps]);
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      const e = await fails(run(t.db, chain, 2, { timeouts: { statementMs: 200, lockMs: 0 } }));
      expect(e.code).toBe('step_timeout');
      expect(e.details).toMatchObject({ timeout: { kind: 'statement', ms: 200 }, step: 1, partial: false });
      expect(e.message).toContain('整体回滚');
      // 没有设超时时，同一个慢步骤照常执行（普通的 57014 不会被当成超时：只有设了语句超时才这么认）
      const r = await run(t.db, chain, 2, { timeouts: { statementMs: 0, lockMs: 5000 } });
      expect(r.ran.map((x) => x.number)).toEqual([2]);
    });
  },
);

test('parseDetachConcurrently：只认写明 schema 的 DETACH PARTITION … CONCURRENTLY', () => {
  expect(
    parseDetachConcurrently('ALTER TABLE "public"."p" DETACH PARTITION "public"."p1" CONCURRENTLY'),
  ).toEqual({
    parentSchema: 'public',
    parent: 'p',
    schema: 'public',
    partition: 'p1',
  });
  expect(
    parseDetachConcurrently('alter table if exists only app."P x" * detach partition app.p_2 concurrently;'),
  ).toEqual({ parentSchema: 'app', parent: 'P x', schema: 'app', partition: 'p_2' });
  expect(parseDetachConcurrently('ALTER TABLE p DETACH PARTITION p1 CONCURRENTLY')).toBe('unparsed'); // 没写 schema
  expect(parseDetachConcurrently('ALTER TABLE public.p DETACH PARTITION public.p1')).toBeNull();
  expect(parseDetachConcurrently('CREATE INDEX CONCURRENTLY ix ON public.t (x)')).toBeNull();
});

test.skipIf(!PG_URL)(
  'DETACH PARTITION … CONCURRENTLY 在等旧事务时超过 lock_timeout：分区停在 detach pending；释放后续跑自动改为 FINALIZE，分区已分离',
  async () => {
    const DDL = `create table public.p (id int not null, k int not null) partition by range (k);
      create table public.p1 partition of public.p for values from (0) to (10);
      create table public.p2 partition of public.p for values from (10) to (20);`;
    const DETACH = 'ALTER TABLE "public"."p" DETACH PARTITION "public"."p1" CONCURRENTLY';
    // v1 / v2 的模型都从真实的库读出来（v2 = 分离之后的样子，含 PG 给分离出来的表加的约束），对象 ID 沿用 v1
    const modelOf = async (sqls: string[]) => {
      const t = await createTestDb('detach_model');
      try {
        for (const s of sqls) await t.db.exec(s);
        return importSnapshot(await readSnapshot(t.db));
      } finally {
        await t.close();
      }
    };
    const m1 = await modelOf([DDL]);
    const m2 = reconcileIds(m1, await modelOf([DDL, DETACH]));
    // 规划器不支持改分区设置：v2 的脚本手写（就像人工编辑的冻结脚本）
    const [v1] = chainOf([m1]);
    const up = [nontx(DETACH)];
    const down = [
      nontx('ALTER TABLE "public"."p" ATTACH PARTITION "public"."p1" FOR VALUES FROM (0) TO (10)'),
    ];
    const chain: ChainVersion[] = [
      v1!,
      {
        ...v1!,
        id: 'v-2',
        number: 2,
        parentId: v1!.id,
        name: '版本 2',
        model: m2,
        upSteps: up,
        downSteps: down,
        checksum: stepsChecksum(up, down),
      },
    ];
    const pending = async (db: Db) =>
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from pg_inherits i join pg_class c on c.oid = i.inhrelid
            where c.relname = 'p1' and i.inhdetachpending`,
        )
      )[0]!.n;
    const attached = async (db: Db) =>
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from pg_inherits i join pg_class c on c.oid = i.inhrelid where c.relname = 'p1'",
        )
      )[0]!.n;
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      const timeouts = { statementMs: 0, lockMs: 300 };
      // 另一个会话开着事务、碰过父表：DETACH … CONCURRENTLY 的第一个事务提交（分区标成 detach pending）之后，
      // 要等这个旧事务结束——这段等待受 lock_timeout 约束，超时
      const holder = connect(t.url);
      const reserved = await holder.db.reserve!();
      try {
        await reserved.exec('BEGIN');
        await reserved.query('select count(*) from public.p');
        const e = await fails(run(t.db, chain, 2, { timeouts }));
        expect(e.code).toBe('step_timeout');
        expect(e.details).toMatchObject({ timeout: { kind: 'lock', ms: 300 }, partial: true, step: 1 });
        expect(await pending(t.db)).toBe(1);
        // 还没释放时续跑：FINALIZE 同样受锁等待超时约束，同样超时、可以再重试
        expect((await fails(run(t.db, chain, 2, { timeouts }))).code).toBe('step_timeout');
        expect(await pending(t.db)).toBe(1);
      } finally {
        await reserved.exec('ROLLBACK').catch(() => {});
        reserved.release?.();
        await holder.close();
      }
      // 释放后续跑：检测到 detach pending，改为 FINALIZE，迁移完成，结构等于 v2
      const r = await run(t.db, chain, 2, { timeouts });
      expect(r.ran.map((x) => x.number)).toEqual([2]);
      expect(await attached(t.db)).toBe(0);
      await structureIs(t.db, m2);
    });
  },
);

test.skipIf(!PG_URL)(
  '执行申请的绑定（P5b）：起始版本、迁移列表或校验和与提交时不同 → request_stale，什么都不写；一致时照常执行',
  async () => {
    const models = [
      await canon(m0()),
      await canon(withEmail(m0())),
      await canon(withOrders(withEmail(m0()))),
    ];
    const chain = chainOf(models);
    const bind = (from: string | null, numbers: number[], c = chain) => ({
      from,
      migrations: numbers.map((n) => ({
        versionId: idOf(c, n),
        direction: 'up' as const,
        checksum: c.find((v) => v.number === n)!.checksum,
      })),
    });
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      // 申请是在 v1 时提交的（执行 v2、v3）；v3 的脚本在提交之后被改过（还没在任何地方执行过，校验和不同）
      const expect13 = bind(idOf(chain, 1), [2, 3]);
      const edited = withSteps(chain, 3, [...chain[2]!.upSteps, tx('SELECT 1')]);
      const e0 = await fails(run(t.db, edited, 3, { expect: expect13 }));
      expect(e0.code).toBe('request_stale');
      expect((await readHistory(t.db, 'p1')).currentVersion).toBe(idOf(chain, 1));
      // 有人先直接执行到了 v2：起点变了
      await run(t.db, chain, 2);
      const e1 = await fails(run(t.db, chain, 3, { expect: expect13 }));
      expect(e1.code).toBe('request_stale');
      expect((await readHistory(t.db, 'p1')).currentVersion).toBe(idOf(chain, 2));
      // 库已经在目标版本：也不能当作执行成功
      await run(t.db, chain, 3);
      const e2 = await fails(run(t.db, chain, 3, { expect: bind(idOf(chain, 2), [3]) }));
      expect(e2.code).toBe('request_stale');
      await run(t.db, chain, 2);
      // 方向不一致（绑定的是回滚）
      const e4 = await fails(
        run(t.db, chain, 3, {
          expect: {
            from: idOf(chain, 2),
            migrations: [{ ...bind(null, [3]).migrations[0]!, direction: 'down' }],
          },
        }),
      );
      expect(e4.code).toBe('request_stale');
      // 一致：照常执行
      const ok = await run(t.db, chain, 3, { expect: bind(idOf(chain, 2), [3]) });
      expect(ok).toMatchObject({ direction: 'up', current: idOf(chain, 3) });
    });
  },
);
