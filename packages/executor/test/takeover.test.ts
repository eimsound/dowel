// 执行器的接手与认领（P4c）：多环境合并（纯函数）、预演（dry run）、认领。预演和认领用真实 PG。
import {
  addColumn,
  addIndex,
  addPrimaryKey,
  addUnique,
  createEnum,
  createSchema,
  createTable,
  emptyBase,
  emptyModel,
  type Model,
  plan,
} from '@dowel/core';
import {
  type Db,
  finishRun,
  type HistoryVersionRow,
  type RunRow,
  readClaims,
  readHistory,
  readProject,
  readSnapshot,
  type ScriptStep,
  startRun,
  stepsChecksum,
  toScriptSteps,
  withProjectLock,
} from '@dowel/engines';
import { describe, expect, test } from 'vitest';
import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import {
  type ChainVersion,
  checkDrift,
  claimInstance,
  diffAgainst,
  ExecutorError,
  execute,
  expectOf,
  importLive,
  inspectAttach,
  markApplied,
  markReadbackError,
  mergeHistories,
  planDiff,
  readState,
  repairRisks,
  type TargetState,
} from '../src/index.ts';

// ───── 模型与版本链（和 execute.test.ts 同一套造法，这里不需要影子库规范化） ─────

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
const withNote = (m: Model): Model => {
  const c = structuredClone(m);
  addColumn(c, 't-users', { name: 'note', type: 'text', id: 'c-note' });
  return c;
};

const version = (models: Model[], i: number, patch: Partial<ChainVersion> = {}): ChainVersion => {
  const model = models[i]!;
  const from = i === 0 ? emptyBase(model, null) : models[i - 1]!;
  const up = toScriptSteps(plan(from, model));
  const down = i === 0 ? [] : toScriptSteps(plan(model, from));
  return {
    id: `v-${1 + i}`,
    number: 1 + i,
    parentId: i === 0 ? null : `v-${i}`,
    name: `版本 ${1 + i}`,
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
const chainOf = (models: Model[]) => models.map((_, i) => version(models, i));

const toRow = (v: ChainVersion, project = 'p1'): HistoryVersionRow => ({
  projectId: project,
  versionId: v.id,
  number: v.number,
  parentId: v.parentId,
  name: v.name,
  scope: v.scope,
  upSteps: v.upSteps,
  downSteps: v.downSteps,
  checksum: v.checksum,
  model: v.model,
  fingerprint: 'f',
  publishedAt: v.publishedAt,
  publishedBy: null,
});

const stateOf = (
  versions: ChainVersion[],
  current: string | null,
  over: Partial<TargetState> = {},
): TargetState => ({
  historyExists: true,
  current,
  versions: versions.map((v) => toRow(v)),
  runs: [] as RunRow[],
  project: null,
  claims: [],
  unfinished: null,
  readbackFailure: null,
  ...over,
});

const fails = (f: () => unknown): ExecutorError => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ExecutorError);
    return e as ExecutorError;
  }
  throw new Error('应该抛 ExecutorError');
};

describe('多环境合并（mergeHistories，纯函数）', () => {
  const models = [m0(), withEmail(m0()), withNote(withEmail(m0()))];
  const chain = chainOf(models);

  test('一个环境落后、另一个领先：链取最长的，各自记录当前版本', () => {
    const m = mergeHistories([
      { name: 'dev', state: stateOf(chain, 'v-3') },
      { name: 'prod', state: stateOf(chain.slice(0, 2), 'v-2') },
    ]);
    expect(m.versions.map((v) => v.number)).toEqual([1, 2, 3]);
    expect(m.envs).toEqual([
      { name: 'dev', current: 'v-3', behind: 0 },
      { name: 'prod', current: 'v-2', behind: 1 },
    ]);
  });

  test('顺序无关；单个环境直接就是它的链；没有 done 的记录时 current 为 null', () => {
    const a = mergeHistories([
      { name: 'prod', state: stateOf(chain.slice(0, 2), 'v-2') },
      { name: 'dev', state: stateOf(chain, 'v-3') },
    ]);
    expect(a.versions.map((v) => v.versionId)).toEqual(['v-1', 'v-2', 'v-3']);
    const one = mergeHistories([{ name: 'x', state: stateOf(chain.slice(0, 1), null) }]);
    expect(one.envs).toEqual([{ name: 'x', current: null, behind: 1 }]);
  });

  test('分叉：两个环境在同一个父版本下有不同的子版本 → history_fork，说明在哪个版本之后分叉', () => {
    const alt = withNote(models[0]!);
    const altChain = chainOf([models[0]!, withEmail(models[0]!), alt]);
    const forked = [chain[0]!, chain[1]!, { ...version([...models.slice(0, 2), alt], 2), id: 'v-3-alt' }];
    expect(altChain).toHaveLength(3);
    const e = fails(() =>
      mergeHistories([
        { name: 'dev', state: stateOf(chain, 'v-3') },
        { name: 'prod', state: stateOf(forked, 'v-3-alt') },
      ]),
    );
    expect(e.code).toBe('history_fork');
    expect(e.message).toContain('分叉');
    expect(e.message).toContain('dev');
    expect(e.message).toContain('prod');
  });

  test('不同的起点 → history_fork', () => {
    const other = chainOf([withEmail(m0())]).map((v) => ({ ...v, id: 'other-1' }));
    expect(
      fails(() =>
        mergeHistories([
          { name: 'a', state: stateOf(chain, 'v-3') },
          { name: 'b', state: stateOf(other, 'other-1') },
        ]),
      ).code,
    ).toBe('history_fork');
  });

  test('同一个版本 ID 的内容不一致 → history_conflict（模型、名字、范围各自被发现）', () => {
    const cases: [string, Partial<ChainVersion>][] = [
      ['模型', { model: withNote(chain[1]!.model) }],
      ['名字', { name: '被改名了' }],
      ['schema 范围', { scope: ['app'] }],
    ];
    for (const [what, patch] of cases) {
      const changed = chain.map((v) => (v.id === 'v-2' ? { ...v, ...patch } : v));
      const e = fails(() =>
        mergeHistories([
          { name: 'dev', state: stateOf(chain, 'v-3') },
          { name: 'prod', state: stateOf(changed.slice(0, 2), 'v-2') },
        ]),
      );
      expect(e.code, what).toBe('history_conflict');
      expect(e.message, what).toContain(what);
    }
  });

  test('checksum 与脚本内容对不上（篡改）→ history_broken；没有历史 → history_missing', () => {
    const tampered = chain.map((v) => (v.id === 'v-1' ? { ...v, checksum: '0'.repeat(64) } : v));
    expect(fails(() => mergeHistories([{ name: 'dev', state: stateOf(tampered, 'v-3') }])).code).toBe(
      'history_broken',
    );
    expect(
      fails(() => mergeHistories([{ name: 'dev', state: { ...stateOf([], null), historyExists: false } }]))
        .code,
    ).toBe('history_missing');
    // 当前版本不在自己的版本记录里
    expect(
      fails(() => mergeHistories([{ name: 'dev', state: stateOf(chain.slice(0, 2), 'v-3') }])).code,
    ).toBe('history_broken');
  });
});

// ───── 预演与认领（真实 PG） ─────

const tx = (sql: string): ScriptStep => ({ sql, transactional: true });
const nontx = (sql: string): ScriptStep => ({ sql, transactional: false });
const hasDowel = async (db: Db) =>
  (await db.query<{ n: string | null }>(`select to_regnamespace('dowel')::text as n`))[0]!.n !== null;

const withTarget = async (fn: (t: Awaited<ReturnType<typeof createTestDb>>) => Promise<void>) => {
  const t = await createTestDb('exec_tk');
  try {
    await fn(t);
  } finally {
    await t.close();
  }
};

const run = (db: Db, chain: ChainVersion[], to: number, extra: Partial<Parameters<typeof execute>[0]> = {}) =>
  execute({
    db,
    projectId: 'p1',
    projectName: '演示',
    instanceId: 'inst-A',
    chain,
    to: chain.find((v) => v.number === to)!.id,
    executedBy: 'u1',
    ...extra,
  });

describe.skipIf(!PG_URL)('预演（dryRun）', () => {
  // v3 的脚本：加列（事务）+ 非事务的 CREATE INDEX CONCURRENTLY
  const models = [m0(), withEmail(m0())];
  const m3 = withNote(models[1]!);
  addIndex(m3, 't-users', [{ column: 'c-email' }], {}, 'ix-email');
  const base = chainOf([...models, m3]);
  const chain = base.map((v) =>
    v.number === 3
      ? (() => {
          const up = v.upSteps.map((s) =>
            /^CREATE INDEX/.test(s.sql)
              ? nontx(s.sql.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY'))
              : s,
          );
          return { ...v, upSteps: up, checksum: stepsChecksum(up, v.downSteps) };
        })()
      : v,
  );

  test('全新的库：列出迁移和步骤、非事务步骤数；不写目标库（连 dowel schema 都不建）', async () => {
    await withTarget(async (t) => {
      const r = await run(t.db, chain, 3, { dryRun: true });
      expect(r.ran).toEqual([]);
      expect(r.dryRun).toMatchObject({ firstRun: 'empty', createsHistory: true, baseline: false });
      expect(r.dryRun!.migrations.map((m) => [m.number, m.nonTransactional])).toEqual([
        [1, 0],
        [2, 0],
        [3, 1],
      ]);
      const last = r.dryRun!.migrations[2]!;
      expect(last.steps.some((s) => !s.transactional && /CONCURRENTLY/.test(s.sql))).toBe(true);
      expect(await hasDowel(t.db)).toBe(false);
      expect(await t.db.query("select 1 from pg_tables where schemaname = 'public'")).toEqual([]);
    });
  });

  test('检查全部在场：未验证、实例级语句、漂移、认领、锁都和真正的执行一样被拒绝；拒绝之后目标库没变', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 2);
      const snapshot = async () => ({
        history: await t.db.query('select * from dowel.history'),
        versions: await t.db.query('select version_id from dowel.versions'),
        project: await t.db.query('select * from dowel.projects'),
      });
      const before = await snapshot();
      // 未验证
      const unver = chain.map((v) => (v.number === 3 ? { ...v, verified: false } : v));
      await expect(run(t.db, unver, 3, { dryRun: true })).rejects.toMatchObject({ code: 'unverified' });
      // 实例级语句
      const bad = chain.map((v) => {
        if (v.number !== 3) return v;
        const up = [...v.upSteps, tx('CREATE ROLE dowel_should_not_exist')];
        return { ...v, upSteps: up, checksum: stepsChecksum(up, v.downSteps) };
      });
      await expect(run(t.db, bad, 3, { dryRun: true })).rejects.toMatchObject({ code: 'instance_level' });
      // 漂移
      await t.db.exec('alter table public.users add column sneaky int');
      await expect(run(t.db, chain, 3, { dryRun: true })).rejects.toMatchObject({ code: 'drift' });
      await t.db.exec('alter table public.users drop column sneaky');
      // 认领：别的实例
      await expect(run(t.db, chain, 3, { dryRun: true, instanceId: 'inst-B' })).rejects.toMatchObject({
        code: 'foreign_instance',
      });
      // 锁
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const other = connect(t.url); // 持锁的必须是另一个连接（connect() 是 max:1 的单连接）
      const locked = withProjectLock(other.db, 'p1', 1000, async () => held);
      await new Promise((r) => setTimeout(r, 300));
      await expect(run(t.db, chain, 3, { dryRun: true, lockTimeoutMs: 400 })).rejects.toMatchObject({
        code: 'lock_timeout',
      });
      release();
      await locked;
      await other.close();
      expect(await snapshot()).toEqual(before);
      // 回滚预演也不写
      const down = await run(t.db, chain, 1, { dryRun: true, direction: 'down' });
      expect(down.dryRun!.migrations.map((m) => [m.number, m.direction])).toEqual([[2, 'down']]);
      expect(await snapshot()).toEqual(before);
    });
  });

  test('上一次停在中途：预演说明会从哪一步续跑；预演自己不改动半途状态', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 2);
      // 让 v3 的非事务 CREATE INDEX CONCURRENTLY 失败：建唯一索引撞上重复数据
      const dupChain = chain.map((v) => {
        if (v.number !== 3) return v;
        const up = v.upSteps.map((s) =>
          /CREATE INDEX CONCURRENTLY/.test(s.sql)
            ? nontx(s.sql.replace('CREATE INDEX', 'CREATE UNIQUE INDEX'))
            : s,
        );
        return { ...v, upSteps: up, checksum: stepsChecksum(up, v.downSteps) };
      });
      await t.db.exec("insert into public.users (id, email) values (1, 'a'), (2, 'a')");
      await expect(run(t.db, dupChain, 3)).rejects.toMatchObject({ code: 'step_failed' });
      const hBefore = await readHistory(t.db, 'p1');
      const r = await run(t.db, dupChain, 3, { dryRun: true });
      expect(r.dryRun!.resume).toMatchObject({ versionId: 'v-3', direction: 'up' });
      expect(r.dryRun!.resume!.afterStep).toBeGreaterThanOrEqual(-1);
      expect((await readHistory(t.db, 'p1')).history).toEqual(hBefore.history);
    });
  });

  test('已经在目标版本：空操作也带预演结果', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 2);
      const r = await run(t.db, chain, 2, { dryRun: true });
      expect(r).toMatchObject({ direction: 'none', ran: [] });
      expect(r.dryRun).toMatchObject({ migrations: [], from: { number: 2 }, to: { number: 2 } });
    });
  });
});

describe.skipIf(!PG_URL)('认领（claimInstance）与接入检查（inspectAttach）', () => {
  const chain = chainOf([m0(), withEmail(m0())]);

  test('认领：换手、追加事件；之后原实例执行被拒绝（先于版本链检查），新实例可以执行；只读的 readState 不受影响', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      expect((await readProject(t.db, 'p1'))!.instanceId).toBe('inst-A');
      const r = await claimInstance({
        chain,
        db: t.db,
        projectId: 'p1',
        projectName: '演示 B',
        instanceId: 'inst-B',
        claimedBy: 'u-b',
        claimedByName: '李四',
      });
      expect(r).toEqual({ changed: true, previousInstanceId: 'inst-A' });
      const p = (await readProject(t.db, 'p1'))!;
      expect(p).toMatchObject({
        instanceId: 'inst-B',
        previousInstanceId: 'inst-A',
        claimedBy: 'u-b',
        name: '演示 B',
      });
      expect(await readClaims(t.db, 'p1')).toHaveLength(1);
      // A 被拒绝；用一条 A 不认识的链也一样（认领检查在最前面）
      const e = await run(t.db, chain, 2).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: 'foreign_instance', details: { claim: { instanceId: 'inst-B' } } });
      expect(
        await run(t.db, chain.slice(0, 1), 1, { instanceId: 'inst-A' }).catch((x: unknown) => x),
      ).toMatchObject({
        code: 'foreign_instance',
      });
      // 只读：读历史没问题，历史里 A 的执行记录原样还在
      const st = await readState(t.db, 'p1');
      expect(st.current).toBe('v-1');
      expect(st.runs.map((x) => x.instanceId)).toEqual(['inst-A']);
      expect(st.claims).toHaveLength(1);
      // B 可以继续执行
      const ok = await run(t.db, chain, 2, { instanceId: 'inst-B' });
      expect(ok.ran.map((x) => x.number)).toEqual([2]);
      // 再认领一次是空操作
      expect(
        (
          await claimInstance({
            chain,
            db: t.db,
            projectId: 'p1',
            projectName: null,
            instanceId: 'inst-B',
            claimedBy: null,
            claimedByName: null,
          })
        ).changed,
      ).toBe(false);
      expect(await readClaims(t.db, 'p1')).toHaveLength(1);
    });
  });

  test('历史不完整就不认领；没有历史的库没有什么可认领的；执行中（锁被占用）不能认领', async () => {
    await withTarget(async (t) => {
      const input = {
        chain,
        db: t.db,
        projectId: 'p1',
        projectName: null,
        instanceId: 'inst-B',
        claimedBy: null,
        claimedByName: null,
      };
      await expect(claimInstance(input)).rejects.toMatchObject({ code: 'history_missing' });
      expect(await hasDowel(t.db)).toBe(false);
      await run(t.db, chain, 2);
      // 锁被占用：原实例正在执行时不能换手
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const other = connect(t.url); // 持锁的必须是另一个连接（connect() 是 max:1 的单连接）
      const locked = withProjectLock(other.db, 'p1', 1000, async () => held);
      await new Promise((r) => setTimeout(r, 300));
      await expect(claimInstance({ ...input, lockTimeoutMs: 400 })).rejects.toMatchObject({
        code: 'lock_timeout',
      });
      release();
      await locked;
      await other.close();
      // 篡改校验和：不认领一个被改坏的历史
      await t.db.exec("update dowel.versions set checksum = repeat('0', 64) where version_id = 'v-1'");
      await expect(claimInstance(input)).rejects.toMatchObject({ code: 'history_broken' });
      expect((await readProject(t.db, 'p1'))!.instanceId).toBe('inst-A');
      expect(await readClaims(t.db, 'p1')).toEqual([]);
    });
  });

  test('认领在锁里重新比对链：读到历史之后原实例又执行了 v3 → 认领被拒绝，原实例仍可执行；用新的链重新认领成功', async () => {
    const models = [m0(), withEmail(m0()), withNote(withEmail(m0()))];
    const long = chainOf(models);
    const short = long.slice(0, 2);
    await withTarget(async (t) => {
      await run(t.db, short, 2); // inst-A 执行到 v2；B（平台上只有 v1~v2 的链）此时读到了这份历史
      await run(t.db, long, 3); // 读完之后 A 又执行了 v3
      const input = {
        db: t.db,
        projectId: 'p1',
        projectName: null,
        instanceId: 'inst-B',
        claimedBy: null,
        claimedByName: null,
      };
      const e = await claimInstance({ ...input, chain: short }).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: 'history_mismatch' });
      expect((e as Error).message).toContain('重新读取');
      // 什么都没写：认领还是 A，没有认领事件，A 之后仍然可以执行（回滚一个版本再执行回来）
      expect((await readProject(t.db, 'p1'))!.instanceId).toBe('inst-A');
      expect(await readClaims(t.db, 'p1')).toEqual([]);
      expect((await run(t.db, long, 2)).ran.map((x) => x.number)).toEqual([3]);
      expect((await run(t.db, long, 3)).ran.map((x) => x.number)).toEqual([3]);
      // 内容对不上（同 ID 不同模型）同样拒绝
      const alien = long.map((v) => (v.number === 2 ? { ...v, model: withNote(v.model) } : v));
      await expect(claimInstance({ ...input, chain: alien })).rejects.toMatchObject({
        code: 'history_conflict',
      });
      // 用最新的链重新认领：成功
      expect(await claimInstance({ ...input, chain: long })).toEqual({
        changed: true,
        previousInstanceId: 'inst-A',
      });
    });
  });

  test('inspectAttach：没有历史 → hasHistory false；对得上 → 当前版本和认领情况；对不上（模型不同）→ history_conflict', async () => {
    await withTarget(async (t) => {
      expect(await inspectAttach(t.db, 'p1', chain, 'inst-B')).toEqual({ hasHistory: false });
      await run(t.db, chain, 2);
      const ok = await inspectAttach(t.db, 'p1', chain, 'inst-B');
      expect(ok).toMatchObject({
        hasHistory: true,
        current: { id: 'v-2' },
        claim: { mine: false, instanceId: 'inst-A' },
      });
      expect(await inspectAttach(t.db, 'p1', chain, 'inst-A')).toMatchObject({ claim: { mine: true } });
      // 平台的链里 v2 的模型不同（历史来自另一份项目副本）：checksum 相同但模型不同
      const other = chain.map((v) => (v.number === 2 ? { ...v, model: withNote(v.model) } : v));
      await expect(inspectAttach(t.db, 'p1', other, 'inst-B')).rejects.toMatchObject({
        code: 'history_conflict',
      });
      // 平台的链比库里的历史短（库里领先）：库里的版本不在平台的链上
      await expect(inspectAttach(t.db, 'p1', chain.slice(0, 1), 'inst-B')).rejects.toMatchObject({
        code: 'history_mismatch',
      });
    });
  });
});

// ───── 标记为已执行（ADR 0004） ─────

describe.skipIf(!PG_URL)('标记为已执行（markApplied）', () => {
  const models = [m0(), withEmail(m0()), withNote(withEmail(m0()))];
  const chain = chainOf(models);
  const base = { projectId: 'p1', projectName: '演示', instanceId: 'inst-A', executedBy: 'u1', chain };
  /** 先预演、再带着预演拿到的计划确认（向前标记的确认必须绑定到预演结果）；预演本身和显式给了 acknowledge / expect 的直接调用 */
  const confirmed = async (o: Parameters<typeof markApplied>[0]) => {
    const d = await markApplied({ ...o, dryRun: true, acknowledge: undefined, expect: undefined });
    return markApplied({ ...o, acknowledge: true, expect: expectOf(d.plan) });
  };
  const mark = (db: Db, to: number, extra: Partial<Parameters<typeof markApplied>[0]> = {}) => {
    const o = { ...base, db, to: chain.find((v) => v.number === to)!.id, ...extra };
    return extra.dryRun || extra.acknowledge !== undefined || extra.expect ? markApplied(o) : confirmed(o);
  };
  const counts = async (db: Db) => ({
    history: (await db.query('select * from dowel.history')).length,
    versions: (await db.query('select version_id from dowel.versions')).length,
  });

  test('向前标记：线上已经手工改成 v2 → 核对通过，不执行 SQL，写 mark 记录和 v2 的版本行；之后能正常执行到 v3', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      await t.db.exec('alter table public.users add column email text'); // 手工热修，结果等于 v2 的模型
      const before = await counts(t.db);
      // 预演：只核对，什么都不写
      const dry = await mark(t.db, 2, { dryRun: true });
      expect(dry.runId).toBeNull();
      expect(dry.plan).toMatchObject({ direction: 'forward', from: { id: 'v-1' }, to: { id: 'v-2' } });
      expect(dry.plan.skipped.map((v) => v.number)).toEqual([2]);
      expect(await counts(t.db)).toEqual(before);

      let touched = 0;
      const r = await mark(t.db, 2, { onTouch: () => void touched++ });
      expect(r.runId).toBeGreaterThan(0);
      expect(touched).toBe(1);
      const h = await readHistory(t.db, 'p1');
      expect(h.currentVersion).toBe('v-2');
      expect(h.history.at(-1)).toMatchObject({
        direction: 'mark',
        status: 'done',
        fromVersion: 'v-1',
        toVersion: 'v-2',
      });
      expect(h.versions.map((v) => v.number)).toEqual([1, 2]);
      // 目标库里 v2 的版本行指纹是读到的线上结构的指纹
      expect(h.versions[1]!.fingerprint).toBe(r.plan.fingerprint);
      // 之后：漂移检查通过，继续执行 v3
      expect((await checkDrift({ db: t.db, projectId: 'p1', chain })).status).toBe('ok');
      expect((await run(t.db, chain, 3)).ran.map((x) => x.number)).toEqual([3]);
    });
  });

  test('向前标记跳过中间版本：给 X 和中间版本都补版本行；回滚脚本之后照常可用', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      await t.db.exec(
        'alter table public.users add column email text; alter table public.users add column note text',
      );
      const r = await mark(t.db, 3);
      expect(r.plan.skipped.map((v) => v.number)).toEqual([2, 3]);
      const h = await readHistory(t.db, 'p1');
      expect(h.versions.map((v) => v.number)).toEqual([1, 2, 3]);
      expect(h.versions.map((v) => v.fingerprint !== '')).toEqual([true, false, true]); // 中间版本没读过结构，指纹留空
      expect(h.currentVersion).toBe('v-3');
      expect((await run(t.db, chain, 2)).ran.map((x) => [x.number, x.direction])).toEqual([[3, 'down']]);
    });
  });

  test('核对：线上结构不等于目标版本的模型 → 拒绝并给出差异，什么都不写', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      const before = await counts(t.db);
      const e = await mark(t.db, 2).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: 'mark_mismatch' });
      expect((e as ExecutorError).details.diffTotal).toBeGreaterThan(0);
      expect((e as ExecutorError).details.diff?.[0]?.sql).toMatch(/email/i);
      // 差一点也不行：多了一列
      await t.db.exec(
        'alter table public.users add column email text; alter table public.users add column extra int',
      );
      await expect(mark(t.db, 2)).rejects.toMatchObject({ code: 'mark_mismatch' });
      expect(await counts(t.db)).toEqual(before);
      // 预演同样拒绝
      await expect(mark(t.db, 2, { dryRun: true })).rejects.toMatchObject({ code: 'mark_mismatch' });
    });
  });

  test('向后标记：手工回退了发布 → 标记到 v1；版本行不动、不算“执行过”', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 2);
      await t.db.exec('alter table public.users drop column email'); // 手工回退
      const r = await mark(t.db, 1);
      expect(r.plan).toMatchObject({ direction: 'backward', skipped: [] });
      const h = await readHistory(t.db, 'p1');
      expect(h.currentVersion).toBe('v-1');
      expect(h.history.at(-1)).toMatchObject({ direction: 'mark', fromVersion: 'v-2', toVersion: 'v-1' });
      expect(h.versions.map((v) => v.number)).toEqual([1, 2]); // v2 的版本行还在
      // mark 记录不算碰过目标库的执行（向后标记不能让目标版本变成“执行过”），done 的 up / down / baseline 才算
      const { runTouched } = await import('../src/index.ts');
      expect(h.history.map((x) => [x.direction, runTouched(x)])).toEqual([
        ['up', true],
        ['up', true],
        ['mark', false],
      ]);
      expect((await checkDrift({ db: t.db, projectId: 'p1', chain })).status).toBe('ok');
    });
  });

  test('已经在目标版本 → mark_noop；别的实例认领的库 → foreign_instance；目标版本不存在', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      await expect(mark(t.db, 1)).rejects.toMatchObject({ code: 'mark_noop' });
      await expect(mark(t.db, 2, { instanceId: 'inst-B' })).rejects.toMatchObject({
        code: 'foreign_instance',
      });
      await expect(markApplied({ ...base, db: t.db, to: 'nope' })).rejects.toMatchObject({
        code: 'unknown_version',
      });
    });
  });

  test('第一次执行到的库（没有历史）：结构已经等于 v1 → 标记写出 dowel 历史、项目行和 v1 的版本行（写入基线的特例）；预演不建任何东西', async () => {
    await withTarget(async (t) => {
      await t.db.exec('create table public.users (id bigint not null primary key)');
      const dry = await mark(t.db, 1, { dryRun: true });
      expect(dry.plan.from).toBeNull();
      expect(await hasDowel(t.db)).toBe(false);
      await mark(t.db, 1);
      const h = await readHistory(t.db, 'p1');
      expect(h.currentVersion).toBe('v-1');
      expect(h.history.map((x) => x.direction)).toEqual(['mark']);
      expect((await readProject(t.db, 'p1'))!.instanceId).toBe('inst-A');
      expect((await run(t.db, chain, 2)).ran.map((x) => x.number)).toEqual([2]);
    });
  });

  test('从 unfinished 状态走出来：非事务步骤半途失败 → 手工补完 → 标记到这个版本，之后不再是半途状态', async () => {
    const m3 = withNote(models[1]!);
    addIndex(m3, 't-users', [{ column: 'c-email' }], { unique: true }, 'ix-email');
    const ch = chainOf([models[0]!, models[1]!, m3]).map((v) => {
      if (v.number !== 3) return v;
      const up = v.upSteps.map((s) =>
        /^CREATE UNIQUE INDEX/.test(s.sql)
          ? nontx(s.sql.replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX CONCURRENTLY'))
          : s,
      );
      return { ...v, upSteps: up, checksum: stepsChecksum(up, v.downSteps) };
    });
    await withTarget(async (t) => {
      await run(t.db, ch, 2);
      await t.db.exec("insert into public.users (id, email) values (1, 'a'), (2, 'a')");
      await expect(run(t.db, ch, 3)).rejects.toMatchObject({ code: 'step_failed' });
      expect((await readState(t.db, 'p1')).unfinished).not.toBeNull();
      // 手工补完：删重复数据、建索引（脚本里的那条 CONCURRENTLY 语句）
      await t.db.exec('delete from public.users where id = 2');
      // 失败的 CREATE INDEX CONCURRENTLY 留下了无效索引：先删掉它（用户手工补完时也得这么做）
      for (const r of await t.db.query<{ n: string }>(
        `select format('%I.%I', n.nspname, c.relname) as n from pg_index i join pg_class c on c.oid = i.indexrelid
           join pg_namespace n on n.oid = c.relnamespace where not i.indisvalid`,
      ))
        await t.db.exec(`drop index concurrently ${r.n}`);
      for (const s of ch[2]!.upSteps.filter((x) => /CONCURRENTLY/.test(x.sql))) await t.db.exec(s.sql);
      // 标记之前：没标记就还是半途状态；标记允许在 unfinished 下做
      const r = await confirmed({ ...base, chain: ch, db: t.db, to: 'v-3' });
      expect(r.plan.skipped.map((v) => v.number)).toEqual([3]);
      const st = await readState(t.db, 'p1');
      expect(st.unfinished).toBeNull();
      expect(st.current).toBe('v-3');
      expect((await checkDrift({ db: t.db, projectId: 'p1', chain: ch })).status).toBe('ok');
    });
  });

  test('从 readbackFailure 状态走出来：读回失败留下的差异手工修好 → 标记到那个版本', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      // 造一条“读回校验失败”的失败记录（所有步骤做完了，结构却不对）：v1 → v2
      const id = await startRun(t.db, {
        projectId: 'p1',
        fromVersion: 'v-1',
        toVersion: 'v-2',
        direction: 'up',
        executedBy: null,
        via: 'web',
        instanceId: 'inst-A',
      });
      await finishRun(t.db, id, 'failed', markReadbackError('读回不一致'));
      const st0 = await readState(t.db, 'p1');
      expect(st0.readbackFailure).not.toBeNull();
      await t.db.exec('alter table public.users add column email text'); // 手工修好：现在等于 v2
      await mark(t.db, 2);
      const st = await readState(t.db, 'p1');
      expect(st.readbackFailure).toBeNull();
      expect(st.current).toBe('v-2');
      expect((await checkDrift({ db: t.db, projectId: 'p1', chain })).status).toBe('ok');
    });
  });

  test('标记到当前版本：非事务步骤执行到一半失败 → 手工改回 v2 → 标记到 v2（current）成功，之后重新执行 v3 从头重跑；没有未完成的运行时才是 mark_noop', async () => {
    const m3 = withNote(models[1]!);
    addIndex(m3, 't-users', [{ column: 'c-email' }], { unique: true }, 'ix-email');
    const ch = chainOf([models[0]!, models[1]!, m3]).map((v) => {
      if (v.number !== 3) return v;
      const up = v.upSteps.map((s) =>
        /^CREATE UNIQUE INDEX/.test(s.sql)
          ? nontx(s.sql.replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX CONCURRENTLY'))
          : s,
      );
      return { ...v, upSteps: up, checksum: stepsChecksum(up, v.downSteps) };
    });
    await withTarget(async (t) => {
      await run(t.db, ch, 2);
      // 没有未完成的运行：标记到当前版本是 mark_noop
      await expect(markApplied({ ...base, chain: ch, db: t.db, to: 'v-2' })).rejects.toMatchObject({
        code: 'mark_noop',
      });
      await t.db.exec("insert into public.users (id, email) values (1, 'a'), (2, 'a')");
      await expect(run(t.db, ch, 3)).rejects.toMatchObject({ code: 'step_failed' });
      expect((await readState(t.db, 'p1')).unfinished).not.toBeNull();
      // 库现在是半途状态（加了 note 列，还有无效索引）：DBA 手工改回 v2 的样子
      await t.db.exec('alter table public.users drop column note');
      for (const r of await t.db.query<{ n: string }>(
        `select format('%I.%I', n.nspname, c.relname) as n from pg_index i join pg_class c on c.oid = i.indexrelid
           join pg_namespace n on n.oid = c.relnamespace where not i.indisvalid`,
      ))
        await t.db.exec(`drop index concurrently ${r.n}`);
      // 还没标记：半途状态里漂移检查跳过
      expect(await checkDrift({ db: t.db, projectId: 'p1', chain: ch })).toEqual({
        status: 'skipped',
        reason: 'unfinished',
      });
      const dry = await markApplied({ ...base, chain: ch, db: t.db, to: 'v-2', dryRun: true });
      expect(dry.plan).toMatchObject({
        direction: 'current',
        skipped: [],
        from: { id: 'v-2' },
        to: { id: 'v-2' },
      });
      const r = await markApplied({ ...base, chain: ch, db: t.db, to: 'v-2' });
      expect(r.plan.direction).toBe('current');
      const h = await readHistory(t.db, 'p1');
      expect(h.history.at(-1)).toMatchObject({
        direction: 'mark',
        status: 'done',
        fromVersion: 'v-2',
        toVersion: 'v-2',
      });
      expect(h.currentVersion).toBe('v-2');
      const st = await readState(t.db, 'p1');
      expect(st.unfinished).toBeNull();
      expect((await checkDrift({ db: t.db, projectId: 'p1', chain: ch })).status).toBe('ok');
      // 刚标记完又标记一次：未完成的运行已经关掉了，回到 mark_noop
      await expect(markApplied({ ...base, chain: ch, db: t.db, to: 'v-2' })).rejects.toMatchObject({
        code: 'mark_noop',
      });
      // 之后执行 v3 从头重跑那个迁移（修好数据）
      await t.db.exec('delete from public.users where id = 2');
      const again = await run(t.db, ch, 3);
      expect(again.ran.map((x) => x.number)).toEqual([3]);
      await t.db.exec('select 1');
    });
  });

  test('标记到当前版本也要核对线上结构：半途状态没改回来 → mark_mismatch，运行仍未完成', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      const id = await startRun(t.db, {
        projectId: 'p1',
        fromVersion: 'v-1',
        toVersion: 'v-2',
        direction: 'up',
        executedBy: null,
        via: 'web',
        instanceId: 'inst-A',
      });
      await finishRun(t.db, id, 'failed', markReadbackError('读回不一致'));
      await t.db.exec('alter table public.users add column email text'); // 半途的结果：不等于 v1
      await expect(mark(t.db, 1)).rejects.toMatchObject({ code: 'mark_mismatch' });
      expect((await readState(t.db, 'p1')).readbackFailure).not.toBeNull();
      await t.db.exec('alter table public.users drop column email'); // 改回 v1
      expect((await mark(t.db, 1)).plan.direction).toBe('current');
      expect((await readState(t.db, 'p1')).readbackFailure).toBeNull();
    });
  });

  test('HistoryError 转成带 code 的 ExecutorError（和 execute 一样）：锁被占用 lock_timeout、格式过新 format_too_new；错误带执行器读到的当前版本', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      // 锁被占用
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const other = connect(t.url);
      const locked = withProjectLock(other.db, 'p1', 1000, async () => held);
      await new Promise((r) => setTimeout(r, 300));
      const e1 = await mark(t.db, 2, { lockTimeoutMs: 400 }).catch((x: unknown) => x);
      expect(e1).toBeInstanceOf(ExecutorError);
      expect(e1).toMatchObject({ code: 'lock_timeout' });
      const e1d = await mark(t.db, 2, { lockTimeoutMs: 400, dryRun: true }).catch((x: unknown) => x);
      expect(e1d).toMatchObject({ code: 'lock_timeout' });
      release();
      await locked;
      await other.close();
      // 核对不通过的错误带 reached = 执行器读到的当前版本
      const e2 = await mark(t.db, 2).catch((x: unknown) => x);
      expect(e2).toMatchObject({ code: 'mark_mismatch', details: { reached: 'v-1' } });
      // 格式过新
      await t.db.exec("update dowel.meta set value = '9'::jsonb where key = 'format_version'");
      const e3 = await mark(t.db, 2).catch((x: unknown) => x);
      expect(e3).toBeInstanceOf(ExecutorError);
      expect(e3).toMatchObject({ code: 'format_too_new' });
    });
  });

  test('向前标记的确认绑定到预演：不带 ack → ack_required；带 ack 不带 expect → expect_required；expect 对不上 → plan_changed（带新计划）；都发生在建 dowel schema 之前', async () => {
    await withTarget(async (t) => {
      // 没有历史的库，结构手工做成了 v1：第一次标记（from = null，向前，跳过 v1）
      await t.db.exec('create table public.users (id bigint not null primary key)');
      const o = { ...base, db: t.db, to: 'v-1' };
      const dry = await markApplied({ ...o, dryRun: true });
      expect(dry.plan.skipped.map((v) => v.id)).toEqual(['v-1']);
      await expect(markApplied(o)).rejects.toMatchObject({ code: 'ack_required' });
      expect(await hasDowel(t.db)).toBe(false);
      await expect(markApplied({ ...o, acknowledge: true })).rejects.toMatchObject({
        code: 'expect_required',
      });
      expect(await hasDowel(t.db)).toBe(false);
      // 预演之后别的环境状态变了：expect 里的任何一项对不上都拒绝，并带着新的计划，什么都不写
      const good = expectOf(dry.plan);
      for (const bad of [
        { ...good, from: 'v-9' },
        { ...good, to: 'v-2' },
        { ...good, skipped: ['v-1', 'v-2'] },
        { ...good, fingerprint: 'x'.repeat(64) },
      ]) {
        const e = await markApplied({ ...o, acknowledge: true, expect: bad }).catch((x: unknown) => x);
        expect(e).toMatchObject({ code: 'plan_changed' });
        expect((e as ExecutorError).details.markPlan?.to.id).toBe('v-1');
        expect(await hasDowel(t.db)).toBe(false);
      }
      // 向后标记和标记到当前版本不需要 ack / expect
      expect((await markApplied({ ...o, acknowledge: true, expect: good })).plan.direction).toBe('forward');
      await t.db.exec('alter table public.users add column email text');
      await markApplied({
        ...base,
        db: t.db,
        to: 'v-2',
        acknowledge: true,
        expect: expectOf((await markApplied({ ...base, db: t.db, to: 'v-2', dryRun: true })).plan),
      });
      await t.db.exec('alter table public.users drop column email');
      const back = await markApplied({ ...base, db: t.db, to: 'v-1' }); // 向后：不带任何确认
      expect(back.plan.direction).toBe('backward');
    });
  });

  test('错误包装：读到历史之后的普通错误（读结构失败）包成 unexpected，带 reached 和 cause；HistoryError 包装带 cause', async () => {
    await withTarget(async (t) => {
      await run(t.db, chain, 1);
      // 读历史（readState）之后读结构时抛错：包 Db，查 pg_attribute 的语句抛
      const flaky = (db: Db): Db => ({
        ...db,
        reserve: db.reserve ? async () => flaky(await db.reserve!()) : undefined,
        query: async <T>(q: string, params?: unknown[]) => {
          if (/pg_attribute/.test(q)) throw new Error('boom: connection reset');
          return db.query<T>(q, params);
        },
      });
      const e = await mark(flaky(t.db), 2, { dryRun: true }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ExecutorError);
      expect(e).toMatchObject({ code: 'unexpected', details: { reached: 'v-1' } });
      expect((e as Error).cause).toBeInstanceOf(Error);
      expect(((e as Error).cause as Error).message).toContain('connection reset');
      // HistoryError（格式过新）：带 code、reached 和 cause
      await t.db.exec("update dowel.meta set value = '9'::jsonb where key = 'format_version'");
      const f = await mark(t.db, 2).catch((x: unknown) => x);
      expect(f).toMatchObject({ code: 'format_too_new' });
    });
  });
});

describe('repairRisks：修复脚本的风险分类按规划器 step 的 kind，不靠文本里有没有 drop', () => {
  const stepsOf = (from: Model, to: Model) =>
    plan(from, to).map((s) => ({ kind: s.kind, target: s.target, sql: s.sql }));

  test('删列 / 删表算“删除对象或数据”；去掉默认值、非空不算；去掉约束单独一类；改列类型算重写', () => {
    const base = m0();
    // 删列：email 列
    expect(repairRisks(stepsOf(withEmail(base), base))).toEqual({
      drops: 1,
      constraints: 0,
      rewrites: 0,
      rebuilds: 0,
    });
    // 删表
    const withTable = structuredClone(base);
    createTable(withTable, 'p', 'logs', 't-logs');
    addColumn(withTable, 't-logs', { name: 'id', type: 'bigint', id: 'c-lid' });
    expect(repairRisks(stepsOf(withTable, base)).drops).toBe(1);
    // 去掉默认值 / 非空：不算
    const dflt = structuredClone(withEmail(base));
    const col = dflt.objects['c-email'] as { default?: unknown; notNull?: boolean };
    col.notNull = true;
    col.default = { kind: 'expr', expr: "'x'" } as never;
    const steps = stepsOf(dflt, withEmail(base));
    expect(steps.map((s) => s.kind).sort()).toEqual(['dropDefault', 'dropNotNull']);
    expect(repairRisks(steps)).toEqual({ drops: 0, constraints: 0, rewrites: 0, rebuilds: 0 });
    // 去掉约束（唯一键）
    const uq = structuredClone(withEmail(base));
    addUnique(uq, 't-users', ['c-email'], false, 'uq-email');
    const cs = stepsOf(uq, withEmail(base));
    expect(repairRisks(cs)).toEqual({ drops: 0, constraints: 1, rewrites: 0, rebuilds: 0 });
    // 去掉索引：算删除（DROP INDEX）
    const ix = structuredClone(withEmail(base));
    addIndex(ix, 't-users', [{ column: 'c-email' }], {}, 'ix-e');
    expect(repairRisks(stepsOf(ix, withEmail(base))).drops).toBe(1);
    // 改列类型：重写
    const ty = structuredClone(withEmail(base));
    (ty.objects['c-email'] as { type: string }).type = 'varchar(10)';
    expect(repairRisks(stepsOf(ty, withEmail(base)))).toMatchObject({ drops: 0, rewrites: 1 });
  });

  test('重建不算删除：索引定义变了（先 drop 再 create 同一个索引）、枚举少了一个值（临时副本）、约束重建；真正的删除不受影响', () => {
    const mk = (vals: string[], idxCol: string) => {
      const m = emptyModel();
      const pub = createSchema(m, 'public', 'p');
      const t = createTable(m, pub, 'u', 't');
      addColumn(m, t, { name: 'a', type: 'text', id: 'ca' });
      addColumn(m, t, { name: 'b', type: 'text', id: 'cb' });
      addIndex(m, t, [{ column: idxCol }], {}, 'ix');
      createEnum(m, pub, 'color', vals, 'en');
      return m;
    };
    // 索引定义变了（列 a → b）：dropIndex + createIndex 同一个对象
    const idx = stepsOf(mk(['r', 'g'], 'ca'), mk(['r', 'g'], 'cb'));
    expect(idx.map((s) => s.kind)).toEqual(['dropIndex', 'createIndex']);
    expect(repairRisks(idx)).toEqual({ drops: 0, constraints: 0, rewrites: 0, rebuilds: 1 });
    // 枚举少了一个值：规划器重建类型——旧类型改名成 _dowel_tmp_N、建新的、删掉临时副本
    const en = stepsOf(mk(['r', 'g', 'b'], 'ca'), mk(['r', 'g'], 'ca'));
    expect(en.some((s) => s.kind === 'dropEnum' && /_dowel_tmp_/.test(s.sql))).toBe(true);
    expect(repairRisks(en).drops).toBe(0);
    // 两者一起：仍然是 drops 0
    expect(repairRisks(stepsOf(mk(['r', 'g', 'b'], 'ca'), mk(['r', 'g'], 'cb'))).drops).toBe(0);
    // 真正的删除（这个索引在目标里不存在）仍然算
    expect(
      repairRisks(
        stepsOf(
          mk(['r', 'g'], 'ca'),
          (() => {
            const m = mk(['r', 'g'], 'ca');
            delete m.objects.ix;
            return m;
          })(),
        ),
      ).drops,
    ).toBe(1);
    // 约束重建：同一个唯一键先去掉再加（模型里列变了）——不算去掉约束
    const u1 = withEmail(m0());
    addUnique(u1, 't-users', ['c-email'], false, 'uq');
    const u2 = withEmail(m0());
    addColumn(u2, 't-users', { name: 'e2', type: 'text', id: 'c-e2' });
    addUnique(u2, 't-users', ['c-e2'], false, 'uq');
    const rb = stepsOf(u1, u2);
    expect(rb.map((s) => s.kind)).toContain('dropUnique');
    expect(repairRisks(rb).constraints).toBe(0);
    expect(repairRisks(rb).rebuilds).toBe(1);
  });

  test('kind 认不出来时才退回精确的语句模式；列名 / 注释里带 drop 字样不算；unresolvable 不算', () => {
    const it = (kind: string, sql: string) => ({ kind, target: '', sql });
    expect(
      repairRisks([it('x', 'DROP TABLE public.a'), it('x', 'ALTER TABLE public.a DROP COLUMN b')]).drops,
    ).toBe(2);
    expect(repairRisks([it('x', 'ALTER TABLE public.a DROP CONSTRAINT c')]).constraints).toBe(1);
    expect(repairRisks([it('x', 'ALTER TABLE public.a ALTER COLUMN b DROP DEFAULT')])).toEqual({
      drops: 0,
      constraints: 0,
      rewrites: 0,
      rebuilds: 0,
    });
    expect(repairRisks([it('x', 'ALTER TABLE public.a ALTER COLUMN b DROP NOT NULL')]).drops).toBe(0);
    expect(repairRisks([it('comment', "COMMENT ON TABLE public.a IS 'drop table later'")]).drops).toBe(0);
    expect(repairRisks([it('addColumn', 'ALTER TABLE public.a ADD COLUMN "drop" int')]).drops).toBe(0);
    expect(repairRisks([it('unresolvable', 'DROP TABLE boom')]).drops).toBe(0);
  });
});

describe.skipIf(!PG_URL)('importLive / planDiff：导入线上结构和漂移检查是同一套规则', () => {
  test('全新库里 public 自带的默认注释：reference 里 public 没有注释时忽略，写了注释时照常保留；planDiff 给出和 diffAgainst 一样的差异', async () => {
    await withTarget(async (t) => {
      const snap = await readSnapshot(t.db);
      const pubOf = (m: Model) =>
        Object.values(m.objects).find((o) => o.kind === 'schema' && o.name === 'public') as {
          comment: string | null;
        };
      const plain = importLive(snap, m0());
      expect(pubOf(plain).comment).toBeNull();
      const commented = m0();
      (pubOf(commented) as { comment: string | null }).comment = 'mine';
      expect(pubOf(importLive(snap, commented)).comment).toBe('standard public schema');
      // 空库 vs 带表的模型：差异和 diffAgainst 一致
      const d = diffAgainst(snap, m0());
      const live = importLive(snap, m0());
      expect(planDiff(live, m0())).toEqual(d);
      expect(d.total).toBeGreaterThan(0);
      expect(planDiff(m0(), m0())).toEqual({ total: 0, items: [] });
    });
  });
});
