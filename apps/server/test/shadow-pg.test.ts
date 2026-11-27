// 真实 PG 上的影子库行为：analyze 出错后连接要恢复干净、非事务步骤不挡住风险分析、
// 影子库常驻连接出问题时要丢掉（锁随连接释放）、建 / 认领影子库时的错误分类。
// 需要测试 PG（Testcontainers 或 DOWEL_TEST_PG），没有 Docker 时跳过。
import {
  addCheck,
  addColumn,
  attachPartition,
  createPartition,
  createSchema,
  createTable,
  detachPartition,
  emptyModel,
  ident,
  literal,
  type Model,
  runMutator,
  setColumnType,
  setPartitionBy,
  type Table,
} from '@dowel/core';
import type { Db } from '@dowel/engines';
import { analyze, InstanceLevelStatementError, NON_TRANSACTIONAL_NOTE, StepError } from '@dowel/verifier';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { connect, createTestDb, dbUrl, PG_URL } from '../../../test/pg.ts';
import { createApp } from '../src/app.ts';
import { type ClusterEvent, EventBus } from '../src/bus.ts';
import { openPlatformDb } from '../src/db.ts';
import { OpaqueRefresher, pendingRefreshIds } from '../src/derive.ts';
import { Rooms } from '../src/rooms.ts';
import { encrypt, scrubSecrets } from '../src/secrets.ts';
import {
  assertImportable,
  ShadowConfigChangedError,
  ShadowError,
  ShadowUnavailableError,
  toShadowError,
} from '../src/shadow.ts';
import { Shadows } from '../src/shadows.ts';
import {
  appendPgPoolerHint,
  claimShadow,
  dropSameInstanceShadow,
  ensureSameInstanceShadow,
  inspectPgTargetOn,
  isLikelyPgTransactionPoolerUrl,
  isPgPoolerError,
  pgShadow,
  SHADOW_MARK,
  shadowSetupError,
} from '../src/targets.ts';
import { makeUser, PASSWORD } from './support.ts';

const ordersModel = (extra = false): Model => {
  const m = emptyModel();
  const pub = createSchema(m, 'public', 'schema-public');
  const t = createTable(m, pub, 'orders', 'table-orders');
  addColumn(m, t, { name: 'id', type: 'bigint', id: 'col-id' });
  if (extra) addColumn(m, t, { name: 'note', type: 'text', id: 'col-note' });
  return m;
};
const FROM = ordersModel();
const TO = ordersModel(true);
const step = (sql: string, transactional = true) => ({ sql, transactional });

/** 只在显式事务里（BEGIN 之后的语句）才报“语句超时”的步骤：执行脚本时（自动提交）什么都不做，analyze 重放时（包在 BEGIN 里）出错 */
const FAILS_ONLY_INSIDE_TRANSACTION = step(`DO $$ BEGIN
  IF transaction_timestamp() < statement_timestamp() THEN
    RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = 'query_canceled';
  END IF;
END $$`);

describe.skipIf(!PG_URL)('pgShadow（真实 PG）', () => {
  let shadowDb: Awaited<ReturnType<typeof createTestDb>>;
  /** 另一个连接：检查影子库上有没有残留的 advisory lock */
  let probe: ReturnType<typeof connect>;

  beforeAll(async () => {
    shadowDb = await createTestDb('shadow_pg');
    await claimShadow(shadowDb.url); // 打上 Dowel 影子库标记
    probe = connect(shadowDb.url);
  });
  afterAll(async () => {
    await probe?.close();
    await shadowDb?.close();
  });

  /** 能在另一个连接上拿到影子库的检查锁 = 没有残留（拿到后立刻释放） */
  const lockIsFree = async () => {
    const [r] = await probe.db.query<{ ok: boolean }>(
      "select pg_try_advisory_lock(hashtext('dowel_shadow')) as ok",
    );
    if (r!.ok) await probe.db.exec("select pg_advisory_unlock(hashtext('dowel_shadow'))");
    return r!.ok;
  };

  test('analyze 的 BEGIN 之后出错：连接被 ROLLBACK，同一个影子库的下一次检查能正常拿锁并通过', async () => {
    const shadow = pgShadow(shadowDb.url);
    try {
      const up = [step('ALTER TABLE public.orders ADD COLUMN note text'), FAILS_ONLY_INSIDE_TRANSACTION];
      // 脚本本身没问题（自动提交时那一步什么都不做）；风险分析在 BEGIN 里重放时出错：
      // 验证结论不变（ok:true），原因如实写进 riskError，不是“没有风险”
      const r = await shadow.verifyScripts(FROM, TO, up, [
        step('ALTER TABLE public.orders DROP COLUMN note'),
      ]);
      expect(r.ok).toBe(true);
      expect(r.error).toBeNull();
      expect(r.risks).toEqual([]);
      // riskError 只存原因本身：不带“风险分析没有完成：”前缀（由界面的标题 / 模板提供）
      expect(r.riskError).toContain('执行超时');
      expect(r.riskError).not.toContain('风险分析没有完成');
      // 连接没有停在“事务已中止”状态：检查锁已经释放，下一次检查正常
      expect(await lockIsFree()).toBe(true);
      const next = await shadow.verify(FROM, TO);
      expect(next.ok).toBe(true);
      expect(next.riskError).toBeUndefined();
      expect(next.risks.length).toBeGreaterThan(0);
      expect(await lockIsFree()).toBe(true);
    } finally {
      await shadow.close();
    }
  });

  test('句柄关闭（#154）：客户端断连后在途操作以“配置已变更”结束；之后的操作不再连影子库', async () => {
    const shadow = pgShadow(shadowDb.url);
    const marker = `dowel_close_${Math.random().toString(36).slice(2, 8)}`;
    const sessions = async () =>
      (
        await probe.db.query<{ pid: number }>(
          'select pid from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()',
        )
      ).map((r) => r.pid);
    try {
      // 先正常用一次，常驻连接建好
      expect((await shadow.verify(FROM, TO)).ok).toBe(true);
      const up = [
        step('ALTER TABLE public.orders ADD COLUMN note text'),
        step(`SELECT pg_sleep(20) /* ${marker} */`),
      ];
      const inFlight = shadow.verifyScripts(FROM, TO, up, []).then(
        (r) => r,
        (e: unknown) => e,
      );
      await vi.waitFor(
        async () => {
          const [r] = await probe.db.query<{ n: number }>(
            "select count(*)::int as n from pg_stat_activity where query like '%' || $1 || '%' and pid <> pg_backend_pid()",
            [marker],
          );
          expect(r!.n).toBe(1);
        },
        { timeout: 10_000, interval: 50 },
      );
      const before = await sessions();

      await shadow.close();
      expect(await inFlight).toBeInstanceOf(ShadowConfigChangedError);
      await expect(shadow.verify(FROM, TO)).rejects.toBeInstanceOf(ShadowConfigChangedError);
      await expect(shadow.importSql(assertImportable('select 1'))).rejects.toBeInstanceOf(
        ShadowConfigChangedError,
      );
      // 没有新会话出现（被打断的那条服务端会话可能还在睡，不算新的）
      expect((await sessions()).filter((pid) => !before.includes(pid))).toEqual([]);
    } finally {
      await shadow.close();
      // 服务端那条还在 pg_sleep 的会话：结束掉，放开检查锁
      await probe.db.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where query like '%' || $1 || '%' and pid <> pg_backend_pid()",
        [marker],
      );
    }
  });

  test('常驻连接被脚本弄坏（留下中止的事务）：丢掉这条连接，锁随连接释放，下一次检查用新连接', async () => {
    const shadow = pgShadow(shadowDb.url);
    try {
      // up 里的 BEGIN 开了事务，后面一步出错 → 这条连接停在“事务已中止”，解锁也会失败
      const broken = await shadow.verifyScripts(FROM, TO, [step('BEGIN'), step('SELECT 1/0')], []);
      expect(broken.ok).toBe(false);
      expect(broken.error?.message).toContain('division by zero');
      // 旧连接已经被关掉，锁没有挂在上面
      expect(await lockIsFree()).toBe(true);
      const t0 = Date.now();
      const next = await shadow.verify(FROM, TO);
      expect(next.ok).toBe(true);
      expect(Date.now() - t0).toBeLessThan(20_000); // 没有为“被占用”等上 60 秒
    } finally {
      await shadow.close();
    }
  });

  test('非事务步骤不包进 BEGIN：直接执行，后面的步骤照常分析；这一步给一条说明，不是 riskError', async () => {
    const shadow = pgShadow(shadowDb.url);
    try {
      const up = [
        step('ALTER TABLE public.orders ADD COLUMN note text'),
        step('CREATE INDEX CONCURRENTLY tmp_orders_id ON public.orders (id)', false),
        step('DROP INDEX public.tmp_orders_id'),
      ];
      const r = await shadow.verifyScripts(FROM, TO, up, [
        step('ALTER TABLE public.orders DROP COLUMN note'),
      ]);
      expect(r.ok).toBe(true);
      expect(r.error).toBeNull();
      expect(r.riskError).toBeUndefined();
      expect(r.risks).toHaveLength(3);
      // 第 1 步照常分析（ALTER TABLE 对已有的 orders 拿了锁）
      expect(r.risks[0]!.note).toBeUndefined();
      expect(r.risks[0]!.locks.length).toBeGreaterThan(0);
      // 第 2 步是非事务步骤：没有锁和重写分析，给一条说明
      expect(r.risks[1]).toEqual({
        locks: [],
        rewrites: [],
        scans: [],
        level: 'low',
        note: NON_TRANSACTIONAL_NOTE,
      });
      // 第 3 步在它后面，照常分析
      expect(r.risks[2]!.note).toBeUndefined();
      expect(r.risks[2]!.locks.length).toBeGreaterThan(0);
      expect(await lockIsFree()).toBe(true);
    } finally {
      await shadow.close();
    }
  });

  test('analyze 本身：BEGIN 之后某一步出错，连接不能停在“事务已中止”（必须 ROLLBACK）', async () => {
    const c = connect(shadowDb.url);
    try {
      await expect(
        analyze(c.db, FROM, [{ kind: 'x', target: 'y', sql: FAILS_ONLY_INSIDE_TRANSACTION.sql }]),
      ).rejects.toBeInstanceOf(StepError);
      // 同一个连接上接着执行：不在中止的事务里，也没有开着的事务
      expect(await c.db.query('select 1 as x')).toEqual([{ x: 1 }]);
      const [tx] = await c.db.query<{ open: boolean }>(
        'select transaction_timestamp() = statement_timestamp() as open',
      );
      expect(tx!.open).toBe(true); // 自动提交：事务时间 = 语句时间（没有遗留的显式事务）
    } finally {
      await c.close();
    }
  });

  test('analyze 只看语句文本，不看 transactional 标记：CONCURRENTLY（即使标成 true）不进 BEGIN，给说明，没有 riskError', async () => {
    const c = connect(shadowDb.url);
    try {
      const risks = await analyze(c.db, FROM, [
        { kind: 'x', target: 'y', sql: 'CREATE INDEX CONCURRENTLY tmp3 ON public.orders (id)' },
        { kind: 'x', target: 'y', sql: 'DROP INDEX public.tmp3' },
      ]);
      expect(risks).toHaveLength(2);
      expect(risks[0]!.note).toBe(NON_TRANSACTIONAL_NOTE);
      expect(risks[1]!.note).toBeUndefined();
    } finally {
      await c.close();
    }
    const shadow = pgShadow(shadowDb.url);
    try {
      const up = [
        step('ALTER TABLE public.orders ADD COLUMN note text'),
        step('CREATE INDEX CONCURRENTLY tmp4 ON public.orders (id)', true), // 标记写成 true，语句本身不能进事务
        step('DROP INDEX public.tmp4'),
      ];
      const r = await shadow.verifyScripts(FROM, TO, up, [
        step('ALTER TABLE public.orders DROP COLUMN note'),
      ]);
      expect(r.ok).toBe(true);
      expect(r.riskError).toBeUndefined();
      expect(r.risks[1]!.note).toBe(NON_TRANSACTIONAL_NOTE);
      expect(await lockIsFree()).toBe(true);
    } finally {
      await shadow.close();
    }
  });

  test('用户手动标成 transactional:false 的 ALTER COLUMN TYPE 照样放进事务测量：重写整表的风险藏不住', async () => {
    const intModel = ordersModel();
    (intModel.objects['col-id'] as { type: string }).type = 'integer';
    const shadow = pgShadow(shadowDb.url);
    try {
      const r = await shadow.verifyScripts(
        FROM,
        intModel,
        [step('ALTER TABLE public.orders ALTER COLUMN id TYPE integer', false)],
        [step('ALTER TABLE public.orders ALTER COLUMN id TYPE bigint')],
      );
      expect(r.ok).toBe(true);
      expect(r.riskError).toBeUndefined();
      expect(r.risks).toHaveLength(1);
      expect(r.risks[0]!.note).toBeUndefined(); // 没有被当成非事务步骤跳过
      expect(r.risks[0]!.rewrites).toEqual(['public.orders']);
      expect(r.risks[0]!.level).toBe('high');
    } finally {
      await shadow.close();
    }
  });

  test('用户标了非事务、但文本看不出来的步骤（CLUSTER 不带表名）：先放进 BEGIN 测量，因为“不能在事务里执行”失败就回滚、改在事务外执行并给 note，后面的步骤继续分析', async () => {
    const shadow = pgShadow(shadowDb.url);
    try {
      const up = [
        step('ALTER TABLE public.orders ADD COLUMN note text'),
        step('CLUSTER', false), // PG：CLUSTER cannot run inside a transaction block；文本里没有我们识别的关键字
        step("ALTER TABLE public.orders ALTER COLUMN note SET DEFAULT 'x'"),
      ];
      const to = ordersModel(true);
      (to.objects['col-note'] as { default: unknown }).default = { expr: "'x'::text" };
      const r = await shadow.verifyScripts(FROM, to, up, [
        step('ALTER TABLE public.orders DROP COLUMN note'),
      ]);
      expect(r.ok).toBe(true);
      expect(r.riskError).toBeUndefined();
      expect(r.risks).toHaveLength(3);
      expect(r.risks[0]!.note).toBeUndefined();
      expect(r.risks[0]!.locks.length).toBeGreaterThan(0);
      expect(r.risks[1]).toEqual({
        locks: [],
        rewrites: [],
        scans: [],
        level: 'low',
        note: NON_TRANSACTIONAL_NOTE,
      });
      // 后面的步骤继续分析，连接干净
      expect(r.risks[2]!.note).toBeUndefined();
      expect(r.risks[2]!.locks.length).toBeGreaterThan(0);
      expect(await lockIsFree()).toBe(true);
    } finally {
      await shadow.close();
    }
  });

  test('CLUSTER 不带表名：文本就能判断是非事务，即使标记写成 transactional:true 也在事务外执行', async () => {
    const shadow = pgShadow(shadowDb.url);
    try {
      const r = await shadow.verifyScripts(
        FROM,
        TO,
        [step('ALTER TABLE public.orders ADD COLUMN note text'), step('CLUSTER', true)],
        [step('ALTER TABLE public.orders DROP COLUMN note')],
      );
      expect(r.ok).toBe(true);
      // 看语句文本，不看标记：CLUSTER 不带表名不能进事务，所以没有 riskError，只是这一步没有分析锁
      expect(r.riskError).toBeUndefined();
      expect(r.risks[1]).toMatchObject({
        locks: [],
        rewrites: [],
        scans: [],
        level: 'low',
        note: 'nontransactional',
      });
      expect(await lockIsFree()).toBe(true);
    } finally {
      await shadow.close();
    }
  });

  test('实例级语句：验证之前就拒绝，绝不执行（影子库和线上库可能在同一个实例上）', async () => {
    const admin = connect(PG_URL);
    const exists = async (name: string) =>
      (
        await admin.db.query<{ n: number }>('select count(*)::int as n from pg_database where datname = $1', [
          name,
        ])
      )[0]!.n;
    const shadow = pgShadow(shadowDb.url);
    const dbName = `dowel_must_not_exist_${Math.random().toString(36).slice(2, 8)}`;
    try {
      for (const [up, down, where] of [
        [
          [step('ALTER TABLE public.orders ADD COLUMN note text'), step(`CREATE DATABASE ${dbName}`)],
          [],
          'up#2',
        ],
        [
          [step('ALTER TABLE public.orders ADD COLUMN note text')],
          [step(`CREATE DATABASE ${dbName}`)],
          'down#1',
        ],
      ] as const) {
        const r = await shadow.verifyScripts(FROM, TO, [...up], [...down]);
        expect(r.ok).toBe(false);
        expect(r.error?.message).toContain('实例级语句不能放进迁移');
        expect(r.error?.step?.target).toBe(where);
        expect(r.error?.step?.sql).toContain(dbName);
        expect(await exists(dbName)).toBe(0); // 库没有被建出来
        expect(await lockIsFree()).toBe(true);
      }
      // analyze 直接调用：同样在执行任何一步之前拒绝
      const c = connect(shadowDb.url);
      try {
        await expect(
          analyze(c.db, FROM, [{ kind: 'x', target: 'y', sql: `CREATE DATABASE ${dbName}` }]),
        ).rejects.toBeInstanceOf(InstanceLevelStatementError);
        expect(await exists(dbName)).toBe(0);
      } finally {
        await c.close();
      }
    } finally {
      await shadow.close();
      await admin.db.exec(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.close();
    }
  });

  test('canonicalize：规范化分区边界字面量与表达式分区键', async () => {
    const shadow = pgShadow(shadowDb.url);
    try {
      const m = emptyModel();
      const pub = createSchema(m, 'public', 's-pub');
      const events = createTable(m, pub, 'events', 't-events');
      const atCol = addColumn(m, events, {
        name: 'created_at',
        type: 'timestamp with time zone',
        notNull: true,
        id: 'c-at',
      });
      setPartitionBy(m, events, {
        strategy: 'range',
        keys: [{ column: atCol, expr: null, opclass: null, collation: null }],
      });
      const child = createPartition(
        m,
        events,
        'events_2025',
        "FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')",
        't-events-2025',
      );
      const tags = createTable(m, pub, 'tags', 't-tags');
      addColumn(m, tags, { name: 'code', type: 'text', notNull: true, id: 'c-code' });
      setPartitionBy(m, tags, {
        strategy: 'list',
        keys: [{ column: null, expr: 'LOWER(code)', opclass: null, collation: null }],
      });
      createPartition(m, tags, 'tags_a', "FOR VALUES IN ('a')", 't-tags-a');

      const changed = await shadow.canonicalize(emptyModel(), m);
      const canonChild = changed.find((o): o is Table => o.kind === 'table' && o.id === child);
      expect(canonChild?.partitionOf?.bound).toBe(
        "FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2026-01-01 00:00:00+00')",
      );
      const canonTags = changed.find((o): o is Table => o.kind === 'table' && o.id === tags);
      expect(
        canonTags?.partitionBy && typeof canonTags.partitionBy !== 'string'
          ? canonTags.partitionBy.keys[0]?.expr
          : null,
      ).toBe('lower(code)');
      expect(await lockIsFree()).toBe(true);
    } finally {
      await shadow.close();
    }
  });

  test('High #1: canonicalize 与 OpaqueRefresher 遇未发布表切换分区策略抛 PlanError 时自动回退重建并推进基线', async () => {
    const shadow = pgShadow(shadowDb.url);
    const platform = await createTestDb('derive_part_fallback');
    const db = await openPlatformDb(platform.url);
    const rooms = new Rooms(db, async () => 'editor');
    const baselines = new Map<string, Model>();
    const refresher = new OpaqueRefresher(rooms, async () => shadow, {
      load: async (b) => baselines.get(b) ?? null,
      save: async (b, m) => {
        baselines.set(b, structuredClone(m));
      },
    });
    try {
      // 1. 直接验证 shadow.canonicalize(prev, next) 在普通表→表达式分区表转换时回退 build(next)
      const prev = emptyModel();
      const pub = createSchema(prev, 'public', 's-pub');
      const tags = createTable(prev, pub, 'tags', 't-tags');
      addColumn(prev, tags, { name: 'code', type: 'text', notNull: true, id: 'c-code' });

      const next = structuredClone(prev);
      setPartitionBy(next, tags, {
        strategy: 'list',
        keys: [{ column: null, expr: 'LOWER(code)', opclass: null, collation: null }],
      });
      createPartition(next, tags, 'tags_a', "FOR VALUES IN ('a')", 't-tags-a');

      const changed = await shadow.canonicalize(prev, next);
      const canonTags = changed.find((o): o is Table => o.kind === 'table' && o.id === tags);
      expect(
        canonTags?.partitionBy && typeof canonTags.partitionBy !== 'string'
          ? canonTags.partitionBy.keys[0]?.expr
          : null,
      ).toBe('lower(code)');

      // 2. 端到端验证 OpaqueRefresher：表先进入 good 基线，再配置表达式分区键与后续 CHECK 表达式
      await db.query("insert into groups (id, slug, name) values ('g1', 'g1', 'g1')");
      await db.query("insert into projects (id, name, group_id, slug) values ('p1', 'p1', 'g1', 'p1')");
      await db.query("insert into branches (id, project_id, name) values ('b1', 'p1', 'main')");
      await db.query(
        'insert into room_snapshots (branch_id, seq, model, versions) values ($1, 0, $2::text::jsonb, $3::text::jsonb)',
        ['b1', JSON.stringify(prev), '{}'],
      );

      // 首次 flush：plain table 无表达式，没有待规范化对象 → 0 影子库 I/O，且不把未验证的模型写成黄金基线（ADR 0016）
      await expect(refresher.flush('b1')).resolves.toMatchObject({ kind: 'clean' });
      expect(baselines.has('b1')).toBe(false);
      // 模拟导入：引擎读回的模型直接作为黄金基线
      await refresher.reset('b1', prev);
      expect((baselines.get('b1')?.objects[tags] as Table | undefined)?.partitionBy).toBeNull();

      // 未发布态将普通表配置为表达式分区表并添加子分区
      await rooms.replace('b1', 'tester', next, 'setPartitionBy');
      await refresher.flush('b1');

      const afterPart = (await rooms.model('b1')).model;
      const tAfter = afterPart.objects[tags] as Table;
      expect(
        tAfter.partitionBy && typeof tAfter.partitionBy !== 'string'
          ? tAfter.partitionBy.keys[0]?.expr
          : null,
      ).toBe('lower(code)');
      // good 基线已成功推进，不再卡在旧普通表
      expect((baselines.get('b1')?.objects[tags] as Table | undefined)?.partitionBy).toEqual(
        tAfter.partitionBy,
      );

      // 后续新增 CHECK 表达式也能正常规范化
      const nextWithCheck = structuredClone(afterPart);
      const ckId = addCheck(nextWithCheck, tags, "code <> ''", 'ck-code');
      await rooms.replace('b1', 'tester', nextWithCheck, 'addCheck');
      await refresher.flush('b1');
      const afterCheck = (await rooms.model('b1')).model;
      expect((afterCheck.objects[ckId] as { expr: string }).expr).toContain('::text');
      expect(await lockIsFree()).toBe(true);
    } finally {
      await refresher.drain();
      rooms.close();
      await db.close();
      await platform.close();
      await shadow.close();
    }
  });
});

describe('建 / 认领 / 检查影子库时的错误分类', () => {
  test('shadowSetupError：影子库的问题 → 带“影子库不可用：”前缀；其他按做的事分文案，不带前缀', () => {
    const conn = shadowSetupError(
      Object.assign(new Error('sorry, too many clients already'), { code: '53300' }),
      'create',
    );
    expect(conn).toBeInstanceOf(ShadowUnavailableError);
    expect(conn.message).toBe('影子库不可用：sorry, too many clients already');
    // 被管理员取消的 57014 也是影子库的问题（isMarked 检查时）
    const cancelled = shadowSetupError(
      Object.assign(new Error('canceling statement due to user request'), { code: '57014' }),
      'check',
    );
    expect(cancelled).toBeInstanceOf(ShadowUnavailableError);

    for (const code of ['42501', '42P04', '55006']) {
      const create = shadowSetupError(Object.assign(new Error('出事了'), { code }), 'create');
      expect(create, code).toBeInstanceOf(ShadowError);
      expect(create, code).not.toBeInstanceOf(ShadowUnavailableError);
      expect(create.message).toBe('建影子库失败：出事了');
      const check = shadowSetupError(Object.assign(new Error('出事了'), { code }), 'check');
      expect(check.message).toBe('检查影子库失败：出事了');
      expect(check).not.toBeInstanceOf(ShadowUnavailableError);
    }
    // 认领已有的库：文案是“认领影子库失败”，42501（COMMENT ON DATABASE 要求是所有者）特别说明
    const notOwner = shadowSetupError(
      Object.assign(new Error('must be owner of database x'), { code: '42501' }),
      'claim',
    );
    expect(notOwner.message).toContain('认领影子库失败：当前账号不是该库的所有者');
    expect(notOwner.message).toContain('must be owner of database x');
    expect(shadowSetupError(Object.assign(new Error('出事了'), { code: '42P01' }), 'claim').message).toBe(
      '认领影子库失败：出事了',
    );
    // 认领时读目录（核对标记、统计 pg_class）缺权限，和 COMMENT ON DATABASE 不是所有者，提示不一样
    const noRead = shadowSetupError(
      Object.assign(new Error('permission denied for table pg_class'), { code: '42501' }),
      'claim-read',
    );
    expect(noRead.message).toContain('认领影子库失败：当前账号缺少读取目录的权限');
    expect(noRead.message).not.toContain('不是该库的所有者');
    expect(
      shadowSetupError(Object.assign(new Error('出事了'), { code: '42P01' }), 'claim-read').message,
    ).toBe('认领影子库失败：出事了');
    // 已经是 ShadowError 的原样用
    const given = new ShadowError('拒绝使用这个库作影子库');
    expect(shadowSetupError(given, 'claim')).toBe(given);
  });

  test('错误消息里的连接串密码不会出现在 ShadowError 里（会原样发给客户端）', () => {
    const leaky = (code: string) =>
      Object.assign(
        new Error('connection to postgres://dowel:secret@db.internal:5432/shop failed password=hunter2'),
        {
          code,
        },
      );
    for (const step of ['create', 'claim', 'check'] as const) {
      for (const code of ['ECONNREFUSED', '42501']) {
        const e = shadowSetupError(leaky(code), step);
        expect(e.message, `${step} ${code}`).not.toContain('secret');
        expect(e.message).not.toContain('hunter2');
        expect(e.message).toContain('postgres://dowel:***@db.internal:5432/shop');
      }
    }
    // 验证过程里的基础设施故障（toShadowError）同样遮掉
    expect(toShadowError(leaky('CONNECTION_CLOSED')).message).not.toContain('secret');
    expect(scrubSecrets('postgresql://u:p%40ss@h/db 和 password = "x"')).not.toContain('p%40ss');
  });

  test.skipIf(!PG_URL)(
    'claimShadow：连不上 → 带前缀；不是库的所有者 → “认领影子库失败：当前账号不是该库的所有者”（没有前缀）',
    async () => {
      const dead = await claimShadow('postgres://u:p@127.0.0.1:1/nodb').then(
        () => null,
        (e: unknown) => e,
      );
      expect(dead).toBeInstanceOf(ShadowUnavailableError);
      expect((dead as Error).message).toMatch(/^影子库不可用：/);

      const t = await createTestDb('claim_perm');
      const role = `dowel_claim_${Math.random().toString(36).slice(2, 8)}`;
      const admin = connect(PG_URL);
      try {
        await admin.db.exec(`CREATE ROLE ${role} LOGIN PASSWORD 'pw-claim'`);
        const u = new URL(dbUrl(new URL(t.url).pathname.slice(1)));
        u.username = role;
        u.password = 'pw-claim';
        const denied = await claimShadow(u.toString()).then(
          () => null,
          (e: unknown) => e,
        );
        expect(denied).toBeInstanceOf(ShadowError);
        expect(denied).not.toBeInstanceOf(ShadowUnavailableError);
        expect((denied as Error).message).toMatch(/^认领影子库失败：当前账号不是该库的所有者/);
        expect((denied as Error).message).not.toContain('影子库不可用');
        expect((denied as Error).message).not.toContain('pw-claim');
      } finally {
        await t.close();
        await admin.db.exec(`DROP ROLE IF EXISTS ${role}`);
        await admin.close();
      }
    },
  );
});

describe.skipIf(!PG_URL)('同实例影子库并发创建与安全清理（真实 PG）', () => {
  const admin = PG_URL ? connect(PG_URL) : (null as never);
  const createdDbs: string[] = [];

  const createBareDb = async (prefix: string) => {
    const name = `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
    await admin.db.exec(`CREATE DATABASE "${name}"`);
    createdDbs.push(name, `${name}_dowel`);
    return { name, url: dbUrl(name), shadowName: `${name}_dowel` };
  };

  const dbExists = async (name: string) =>
    (
      await admin.db.query<{ n: number }>('select count(*)::int as n from pg_database where datname = $1', [
        name,
      ])
    )[0]!.n > 0;

  afterAll(async () => {
    if (!PG_URL) return;
    for (const name of createdDbs) {
      await admin.db.exec(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    }
    await admin.close();
  });

  test('并发多次 ensureSameInstanceShadow 创建同名影子库：全部成功且仅一方 created === true', async () => {
    const target = await createBareDb('shadow_race');
    const results = await Promise.all([
      ensureSameInstanceShadow(target.url),
      ensureSameInstanceShadow(target.url),
      ensureSameInstanceShadow(target.url),
    ]);

    expect(results.map((r) => r.shadow)).toEqual([target.shadowName, target.shadowName, target.shadowName]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(2);
    expect(await dbExists(target.shadowName)).toBe(true);
    const [mark] = await admin.db.query<{ c: string | null }>(
      "select shobj_description(oid, 'pg_database') as c from pg_database where datname = $1",
      [target.shadowName],
    );
    expect(mark?.c).toBe(SHADOW_MARK);
  });

  test('并发验证正在使用影子库时，dropSameInstanceShadow 绝不强杀连接，验证顺利完成', async () => {
    const target = await createBareDb('shadow_busy_verify');
    const prepared = await ensureSameInstanceShadow(target.url);
    expect(prepared.created).toBe(true);

    const shadow = pgShadow(prepared.url);
    try {
      // 在验证步骤中短暂停顿，制造真实的并发验证持锁窗口
      const verifyPromise = shadow.verifyScripts(
        FROM,
        TO,
        [step('SELECT pg_sleep(0.4)'), step('ALTER TABLE public.orders ADD COLUMN note text')],
        [step('ALTER TABLE public.orders DROP COLUMN note')],
      );

      // 等到并发验证确实拿到 dowel_shadow 验证锁
      const probe = connect(prepared.url);
      try {
        const deadline = Date.now() + 5_000;
        let busy = false;
        while (Date.now() < deadline) {
          const [r] = await probe.db.query<{ ok: boolean }>(
            "select pg_try_advisory_lock(hashtext('dowel_shadow')) as ok",
          );
          if (r!.ok) {
            await probe.db.exec("select pg_advisory_unlock(hashtext('dowel_shadow'))");
            await new Promise((res) => setTimeout(res, 20));
          } else {
            busy = true;
            break;
          }
        }
        expect(busy).toBe(true);
      } finally {
        await probe.close();
      }

      // 并发验证持锁期间触发清理：应快速安静跳过，不强杀连接
      const t0 = Date.now();
      await dropSameInstanceShadow(target.url, target.shadowName);
      expect(Date.now() - t0).toBeLessThan(3_000);

      // 并发验证必须顺利通过，不出现 57P01 等中断错误
      const report = await verifyPromise;
      expect(report.ok).toBe(true);
      expect(report.error).toBeNull();
      expect(await dbExists(target.shadowName)).toBe(true);
    } finally {
      await shadow.close();
    }
  });

  test('有活跃连接（未持验证锁）时，dropSameInstanceShadow 遇到 55006 安静跳过，不强杀连接；断开后可正常清理', async () => {
    const target = await createBareDb('shadow_active_conn');
    const prepared = await ensureSameInstanceShadow(target.url);
    expect(prepared.created).toBe(true);

    // 模拟另一请求 / 缓存持有影子库上的活跃连接（未拿 dowel_shadow 验证锁）
    const active = connect(prepared.url);
    try {
      expect(await active.db.query<{ x: number }>('select 1 as x')).toEqual([{ x: 1 }]);

      await dropSameInstanceShadow(target.url, target.shadowName);

      // 原活跃连接仍然可用，影子库未被删除
      expect(await active.db.query<{ x: number }>('select 2 as x')).toEqual([{ x: 2 }]);
      expect(await dbExists(target.shadowName)).toBe(true);
    } finally {
      await active.close();
    }

    // 无人使用后，dropSameInstanceShadow 能正常清理新建的同实例影子库
    await dropSameInstanceShadow(target.url, target.shadowName);
    expect(await dbExists(target.shadowName)).toBe(false);
  });

  test('没有 SHADOW_MARK 的数据库，dropSameInstanceShadow 绝不误删', async () => {
    const target = await createBareDb('shadow_unmarked');
    await admin.db.exec(`CREATE DATABASE "${target.shadowName}"`);
    await dropSameInstanceShadow(target.url, target.shadowName);
    expect(await dbExists(target.shadowName)).toBe(true);
  });
});

describe('Shadows 跨副本事件退化与订阅生命周期（单机 SQLite）', () => {
  test('forget / forgetProject 广播 shadows.forget、忽略本副本回环并在 close 时取消订阅', async () => {
    const db = await openPlatformDb(':memory:');
    const bus = new EventBus(db, { replicaId: 'solo-1' });
    const received: ClusterEvent[] = [];
    const off = bus.onEvent((e) => {
      received.push(e);
    });
    const shadows = new Shadows(db, undefined, bus);
    try {
      await bus.start();
      await shadows.forget('env-x');
      await shadows.forgetProject('proj-x');
      expect(received).toEqual([
        { t: 'shadows.forget', origin: 'solo-1', envIds: ['env-x'] },
        { t: 'shadows.forget', origin: 'solo-1', projectId: 'proj-x' },
      ]);

      // close 后释放 bus 订阅（onEvent / onReconnect 不再保留监听器）
      await shadows.close();
      const before = received.length;
      await bus.publish({ t: 'shadows.forget', envIds: ['env-y'] });
      expect(received.length).toBe(before + 1);
    } finally {
      off();
      await shadows.close();
      await bus.close();
      await db.close();
    }
  });
});

describe.skipIf(!PG_URL)('Shadows 配置指纹校验、跨副本事件失效与重连清理（真实 PG）', () => {
  const admin = PG_URL ? connect(PG_URL) : (null as never);
  const createdDbs: string[] = [];
  const closers: (() => Promise<void>)[] = [];

  const waitForAsync = async (
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 8_000,
    stepMs = 25,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() >= deadline) throw new Error(`等待条件超时（${timeoutMs}ms）`);
      await new Promise((r) => setTimeout(r, stepMs));
    }
  };

  const createBareDb = async (prefix: string) => {
    const name = `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
    await admin.db.exec(`CREATE DATABASE "${name}"`);
    createdDbs.push(name, `${name}_dowel`);
    return { name, url: dbUrl(name), shadowName: `${name}_dowel` };
  };

  const countDbConns = async (dbName: string) => {
    const [r] = await admin.db.query<{ n: number }>(
      'select count(*)::int as n from pg_stat_activity where datname = $1',
      [dbName],
    );
    return r!.n;
  };

  const callJson = async (
    app: ReturnType<typeof createApp>['app'],
    method: string,
    path: string,
    json?: unknown,
    cookie = '',
  ) => {
    const headers: Record<string, string> = {};
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await app.request(path, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return {
      status: res.status,
      data: data as Record<string, unknown>,
      cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '',
    };
  };

  afterAll(async () => {
    if (!PG_URL) return;
    for (const c of closers) await c();
    for (const name of createdDbs) {
      await admin.db.exec(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    }
    await admin.close();
  });

  test('配置指纹强校验：标生产禁止同实例、修改 url/shadowUrl、删除环境后绝不复用旧影子库且关闭旧连接', async () => {
    const prevSecret = process.env.DOWEL_SECRET;
    process.env.DOWEL_SECRET = 'shadows-fingerprint-secret-16chars';
    const platform = await createTestDb('shadows_fp_platform');
    closers.push(platform.close);
    const dbA = await openPlatformDb(platform.url);
    const dbB = await openPlatformDb(platform.url);

    // 不传 bus，模拟事件丢失或尚未送达时，纯靠配置指纹强校验与删库清理兜底
    const shadowsB = new Shadows(dbB);

    try {
      const target1 = await createBareDb('sh_fp_t1');
      const target2 = await createBareDb('sh_fp_t2');
      const dedicated = await createBareDb('sh_fp_ded');
      await claimShadow(dedicated.url);

      await dbA.query("insert into groups (id, slug, name) values ('g-fp', 'g-fp', '组')");
      await dbA.query(
        "insert into projects (id, name, group_id, slug) values ('p-fp', '项目', 'g-fp', 'p-fp')",
      );
      await dbA.query(
        `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc)
         values ('e-fp-1', 'p-fp', 'staging', $1, false, false, null)`,
        [encrypt(target1.url)],
      );
      await dbA.query(
        `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc)
         values ('e-fp-2', 'p-fp', 'extra', $1, false, false, null)`,
        [encrypt(target2.url)],
      );

      // 1. 副本 B 缓存 e-fp-1 的同实例影子库，并执行一次 verify 建立真实 PG 常驻连接
      const s1 = await shadowsB.forProject('p-fp', 'e-fp-1');
      expect(s1.label).toBe(`staging：${target1.shadowName}`);
      expect((await s1.shadow.verify(FROM, TO)).ok).toBe(true);
      expect(await countDbConns(target1.shadowName)).toBeGreaterThanOrEqual(1);
      const closeS1 = vi.spyOn(s1.shadow, 'close');

      // 副本 A 将 e-fp-1 标为生产环境且不允许同实例（无独立 shadowUrl）
      await dbA.query(
        'update environments set production = true, allow_same_instance = false where id = $1',
        ['e-fp-1'],
      );

      // 副本 B 再次 forProject：不得复用旧同实例影子库，应关闭旧连接并抛出 ShadowError（上层可 catch 返回 null）
      await expect(shadowsB.forProject('p-fp', 'e-fp-1')).rejects.toThrow(ShadowError);
      expect(await shadowsB.forProject('p-fp', 'e-fp-1').catch(() => null)).toBeNull();
      expect(closeS1).toHaveBeenCalledTimes(1);
      expect(shadowsB.has('e-fp-1')).toBe(false);
      await waitForAsync(async () => (await countDbConns(target1.shadowName)) === 0);

      // 2. 副本 A 为该生产环境配置独立 shadowUrl：副本 B 建立并缓存新独立影子库连接
      await dbA.query('update environments set shadow_url_enc = $2 where id = $1', [
        'e-fp-1',
        encrypt(dedicated.url),
      ]);
      const s2 = await shadowsB.forProject('p-fp', 'e-fp-1');
      expect(s2.shadow).not.toBe(s1.shadow);
      expect(s2.label).toBe(`staging：${dedicated.name}`);
      expect((await s2.shadow.verify(FROM, TO)).ok).toBe(true);
      expect(await countDbConns(dedicated.name)).toBeGreaterThanOrEqual(1);
      const closeS2 = vi.spyOn(s2.shadow, 'close');

      // 副本 A 取消生产标记、清空独立 shadowUrl 并切换到 target2：副本 B 自动关闭旧独立影子库连接并切到 target2_dowel
      await dbA.query(
        'update environments set production = false, shadow_url_enc = null, url_enc = $2 where id = $1',
        ['e-fp-1', encrypt(target2.url)],
      );
      const s3 = await shadowsB.forProject('p-fp', 'e-fp-1');
      expect(s3.shadow).not.toBe(s2.shadow);
      expect(s3.label).toBe(`staging：${target2.shadowName}`);
      expect(closeS2).toHaveBeenCalledTimes(1);
      expect((await s3.shadow.verify(FROM, TO)).ok).toBe(true);
      await waitForAsync(async () => (await countDbConns(dedicated.name)) === 0);

      // 3. 缓存另一个环境 e-fp-2 后，副本 A 从 DB 删除 e-fp-2；副本 B 调用 forProject('p-fp') 时顺带清理已删环境缓存
      const sExtra = await shadowsB.forProject('p-fp', 'e-fp-2');
      expect((await sExtra.shadow.verify(FROM, TO)).ok).toBe(true);
      const closeExtra = vi.spyOn(sExtra.shadow, 'close');
      expect(shadowsB.size).toBe(2);

      await dbA.query("delete from environments where id = 'e-fp-2'");
      const stillFirst = await shadowsB.forProject('p-fp');
      expect(stillFirst.shadow).toBe(s3.shadow);
      expect(closeExtra).toHaveBeenCalledTimes(1);
      expect(shadowsB.has('e-fp-2')).toBe(false);
      expect(shadowsB.size).toBe(1);

      // 删除最后一个环境后，forProject('p-fp') 顺带关闭并移除残留条目再抛 ShadowError
      const closeS3 = vi.spyOn(s3.shadow, 'close');
      await dbA.query("delete from environments where id = 'e-fp-1'");
      await expect(shadowsB.forProject('p-fp')).rejects.toThrow(ShadowError);
      expect(closeS3).toHaveBeenCalledTimes(1);
      expect(shadowsB.size).toBe(0);
      await waitForAsync(async () => (await countDbConns(target2.shadowName)) === 0);
    } finally {
      await shadowsB.close();
      await dbA.close();
      await dbB.close();
      if (prevSecret === undefined) delete process.env.DOWEL_SECRET;
      else process.env.DOWEL_SECRET = prevSecret;
    }
  });

  test('双副本真实 PG EventBus：改配置、删环境、删项目跨副本广播主动关闭缓存，且 onReconnect 清空全部旧连接', async () => {
    const prevSecret = process.env.DOWEL_SECRET;
    process.env.DOWEL_SECRET = 'shadows-ha-bus-secret-16chars';
    const platform = await createTestDb('shadows_ha_bus');
    closers.push(platform.close);
    const dbA = await openPlatformDb(platform.url);
    const dbB = await openPlatformDb(platform.url);

    const appA = createApp(dbA, { bus: { replicaId: 'shadow-rep-a' } });
    const appB = createApp(dbB, { bus: { replicaId: 'shadow-rep-b' } });

    try {
      await appA.bus.start();
      await appB.bus.start();

      const target1 = await createBareDb('sh_ha_t1');
      const target2 = await createBareDb('sh_ha_t2');
      const dedicated = await createBareDb('sh_ha_ded');
      await claimShadow(dedicated.url);

      // 用真实 HTTP 路由准备用户、组、项目和两个环境
      await makeUser(dbA, 'admin', { role: 'admin' });
      const login = await callJson(appA.app, 'POST', '/api/auth/login', {
        username: 'admin',
        password: PASSWORD,
      });
      expect(login.status).toBe(200);
      const cookie = login.cookie;

      const grp = await callJson(appA.app, 'POST', '/api/groups', { name: 'g', slug: 'g-ha' }, cookie);
      expect(grp.status).toBe(201);
      const proj = await callJson(
        appA.app,
        'POST',
        '/api/projects',
        { name: 'p-ha', groupId: grp.data.id },
        cookie,
      );
      expect(proj.status).toBe(201);
      const pid = proj.data.id as string;
      const slug = proj.data.slug as string;

      const env1Res = await callJson(
        appA.app,
        'POST',
        `/api/projects/${pid}/environments`,
        { name: 'dev1', url: target1.url, production: false, allowSameInstance: false },
        cookie,
      );
      expect(env1Res.status).toBe(201);
      const eid1 = env1Res.data.id as string;

      const env2Res = await callJson(
        appA.app,
        'POST',
        `/api/projects/${pid}/environments`,
        { name: 'dev2', url: target2.url, production: false, allowSameInstance: false },
        cookie,
      );
      expect(env2Res.status).toBe(201);
      const eid2 = env2Res.data.id as string;

      // 1. 副本 B 缓存 env1 并建连；副本 A 通过 HTTP PATCH 将 env1 标为生产环境
      const s1 = await appB.shadows.forProject(pid, eid1);
      expect((await s1.shadow.verify(FROM, TO)).ok).toBe(true);
      expect(await countDbConns(target1.shadowName)).toBeGreaterThanOrEqual(1);
      const closeS1 = vi.spyOn(s1.shadow, 'close');

      const markProd = await callJson(
        appA.app,
        'PATCH',
        `/api/projects/${pid}/environments/${eid1}`,
        { production: true },
        cookie,
      );
      expect(markProd.status).toBe(200);

      // 副本 B 收到 shadows.forget 广播，主动关闭并移除缓存，且再次 forProject 拒绝复用同实例影子库
      await waitForAsync(() => !appB.shadows.has(eid1));
      expect(closeS1).toHaveBeenCalledTimes(1);
      await waitForAsync(async () => (await countDbConns(target1.shadowName)) === 0);
      await expect(appB.shadows.forProject(pid, eid1)).rejects.toThrow(ShadowError);

      // 2. 副本 A 为 env1 配置独立 shadowUrl，副本 B 缓存之；随后副本 A 删除 env1，副本 B 自动关闭并清零缓存
      const setDed = await callJson(
        appA.app,
        'PATCH',
        `/api/projects/${pid}/environments/${eid1}`,
        { shadowUrl: dedicated.url },
        cookie,
      );
      expect(setDed.status).toBe(200);

      const sDed = await appB.shadows.forProject(pid, eid1);
      expect(sDed.label).toBe(`dev1：${dedicated.name}`);
      expect((await sDed.shadow.verify(FROM, TO)).ok).toBe(true);
      expect(await countDbConns(dedicated.name)).toBeGreaterThanOrEqual(1);
      const closeDed = vi.spyOn(sDed.shadow, 'close');

      const delEnv1 = await callJson(
        appA.app,
        'DELETE',
        `/api/projects/${pid}/environments/${eid1}`,
        undefined,
        cookie,
      );
      expect(delEnv1.status).toBe(200);

      await waitForAsync(() => appB.shadows.size === 0);
      expect(closeDed).toHaveBeenCalledTimes(1);
      await waitForAsync(async () => (await countDbConns(dedicated.name)) === 0);

      // 3. 副本 B 缓存 env2 并建连；踢掉 LISTEN 连接触发 busB.onReconnect，副本 B 清理并关闭全部旧连接
      const s2BeforeReconnect = await appB.shadows.forProject(pid, eid2);
      expect((await s2BeforeReconnect.shadow.verify(FROM, TO)).ok).toBe(true);
      expect(await countDbConns(target2.shadowName)).toBeGreaterThanOrEqual(1);
      const closeBeforeReconnect = vi.spyOn(s2BeforeReconnect.shadow, 'close');

      let reconnected = false;
      const offReconnect = appB.bus.onReconnect(() => {
        reconnected = true;
      });
      try {
        await dbA.query(
          `select pg_terminate_backend(pid)
           from pg_stat_activity
           where datname = current_database()
             and pid <> pg_backend_pid()
             and query ilike 'listen%'`,
        );
        await waitForAsync(() => reconnected && appB.shadows.size === 0, 10_000);
        expect(closeBeforeReconnect).toHaveBeenCalledTimes(1);
        await waitForAsync(async () => (await countDbConns(target2.shadowName)) === 0);
      } finally {
        offReconnect();
      }

      // 4. 重连恢复后：副本 B 重新缓存 env2 并建连；副本 A 删除整个项目，副本 B 收到广播主动关闭并清零缓存
      const s2AfterReconnect = await appB.shadows.forProject(pid, eid2);
      expect((await s2AfterReconnect.shadow.verify(FROM, TO)).ok).toBe(true);
      expect(await countDbConns(target2.shadowName)).toBeGreaterThanOrEqual(1);
      const closeAfterReconnect = vi.spyOn(s2AfterReconnect.shadow, 'close');

      const delProj = await callJson(appA.app, 'DELETE', `/api/projects/${pid}`, { confirm: slug }, cookie);
      expect(delProj.status).toBe(200);

      await waitForAsync(() => appB.shadows.size === 0);
      expect(closeAfterReconnect).toHaveBeenCalledTimes(1);
      await waitForAsync(async () => (await countDbConns(target2.shadowName)) === 0);
    } finally {
      await appA.rooms.flush();
      await appB.rooms.flush();
      appA.rooms.close();
      appB.rooms.close();
      await appA.shadows.close();
      await appB.shadows.close();
      await appA.bus.close();
      await appB.bus.close();
      await dbA.close();
      await dbB.close();
      if (prevSecret === undefined) delete process.env.DOWEL_SECRET;
      else process.env.DOWEL_SECRET = prevSecret;
    }
  });
});

describe('PG Transaction Pooler 诊断与权限 SQL 提示（纯单元测试）', () => {
  test('isLikelyPgTransactionPoolerUrl：准确区分事务池化端点与普通直连 / Supabase Session Mode', () => {
    expect(
      isLikelyPgTransactionPoolerUrl('postgres://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/app'),
    ).toBe(true);
    expect(
      isLikelyPgTransactionPoolerUrl('postgresql://u:p@EP-COOL-123-POOLER.us-east-2.aws.neon.tech:5432/app'),
    ).toBe(true);
    expect(
      isLikelyPgTransactionPoolerUrl('postgres://u:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres'),
    ).toBe(true);
    expect(isLikelyPgTransactionPoolerUrl('postgres://u:p@pgbouncer.internal:6543/app')).toBe(true);
    expect(isLikelyPgTransactionPoolerUrl('postgres://u:p@db.internal:5432/app?pgbouncer=true')).toBe(true);
    expect(isLikelyPgTransactionPoolerUrl('postgresql://u:p@db.internal:5432/app?PgBouncer=TRUE')).toBe(true);
    expect(isLikelyPgTransactionPoolerUrl('postgres://u:p@db.internal:5432/app?pool_mode=transaction')).toBe(
      true,
    );
    expect(isLikelyPgTransactionPoolerUrl('postgres://u:p@db.internal:5432/app?POOL_MODE=Transaction')).toBe(
      true,
    );

    // 直连 5432、Supabase Session Mode（5432 / 默认端口）、非法 URL 不应误报
    expect(isLikelyPgTransactionPoolerUrl('postgres://u:p@db.internal:5432/app')).toBe(false);
    expect(isLikelyPgTransactionPoolerUrl('postgres://u:p@db.internal/app')).toBe(false);
    expect(
      isLikelyPgTransactionPoolerUrl('postgres://u:p@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres'),
    ).toBe(false);
    expect(
      isLikelyPgTransactionPoolerUrl('postgres://u:p@aws-0-ap-southeast-1.pooler.supabase.com/postgres'),
    ).toBe(false);
    expect(isLikelyPgTransactionPoolerUrl('postgres://u:p@db.internal:5432/app?pgbouncer=false')).toBe(false);
    expect(isLikelyPgTransactionPoolerUrl('postgres://u:p@db.internal:5432/app?pool_mode=session')).toBe(
      false,
    );
    expect(isLikelyPgTransactionPoolerUrl('mysql://u:p@pgbouncer.internal:6543/app')).toBe(false);
    expect(isLikelyPgTransactionPoolerUrl('not-a-url')).toBe(false);
    expect(isLikelyPgTransactionPoolerUrl('')).toBe(false);
  });

  test('isPgPoolerError 与 appendPgPoolerHint：识别池化器典型错误并幂等追加提示', () => {
    for (const msg of [
      'PgBouncer error: server closed the connection unexpectedly',
      'Supavisor: Tenant or user not found',
      'advisory locks are not supported in transaction mode',
      'invalid pool_mode configuration',
      'ERROR: unsupported startup parameter: extra_float_digits',
      'ERROR: prepared statement "s1" already exists',
      'ERROR: prepared statement "s1" does not exist',
    ]) {
      expect(isPgPoolerError(new Error(msg)), msg).toBe(true);
      expect(isPgPoolerError({ message: msg }), msg).toBe(true);
    }

    expect(isPgPoolerError(new Error('permission denied for schema public'))).toBe(false);
    expect(
      isPgPoolerError(
        Object.assign(new Error('CREATE DATABASE cannot run inside a transaction block'), { code: '25001' }),
      ),
    ).toBe(false);

    const once = appendPgPoolerHint('连接失败：超时', {
      url: 'postgres://u:p@db.internal:6543/app',
    });
    expect(once).toContain('Transaction Pooler');
    expect(once).toContain('Session Mode');
    expect(once).not.toContain('。。');
    // 幂等：重复调用不再追加第二遍提示
    expect(appendPgPoolerHint(once, { url: 'postgres://u:p@db.internal:6543/app' })).toBe(once);
  });

  test('shadowSetupError(..., ctx) 与 inspectPgTargetOn：池化器提示、25001 create 提示、特殊密码脱敏与 claim SQL', async () => {
    // 1. create 阶段 25001 或 cannot run inside a transaction block 附带事务池化器提示；非 create 不误附带
    const err25001 = Object.assign(new Error('CREATE DATABASE cannot run inside a transaction block'), {
      code: '25001',
    });
    const createTx = shadowSetupError(err25001, 'create');
    expect(createTx).toBeInstanceOf(ShadowError);
    expect(createTx).not.toBeInstanceOf(ShadowUnavailableError);
    expect(createTx.message).toContain('建影子库失败');
    expect(createTx.message).toContain('Transaction Pooler');

    const check25001 = shadowSetupError(err25001, 'check');
    expect(check25001.message).not.toContain('Transaction Pooler');

    // 2. 带特殊字符 URL 编码密码的 pooler URL：不泄露编码后和解码后的明文密码
    const encodedPw = 'p%40ss%23sec%251';
    const decodedPw = decodeURIComponent(encodedPw);
    const poolerUrl = `postgres://dowel:${encodedPw}@ep-demo-pooler.us-east-2.aws.neon.tech:5432/app`;
    const leakyErr = Object.assign(
      new Error(
        `failed connecting ${poolerUrl} password=${decodedPw} prepared statement "q1" does not exist`,
      ),
      { code: '08006' },
    );
    const setupErr = shadowSetupError(leakyErr, 'create', { url: poolerUrl });
    expect(setupErr).toBeInstanceOf(ShadowUnavailableError);
    expect(setupErr.message).toContain('Transaction Pooler');
    expect(setupErr.message).not.toContain(encodedPw);
    expect(setupErr.message).not.toContain(decodedPw);

    const failingDb: Db = {
      query: async () => {
        throw new Error(`connect failed for ${poolerUrl} (${decodedPw})`);
      },
      exec: async () => {},
    };
    const inspectErr = await inspectPgTargetOn(failingDb, poolerUrl).then(
      () => null,
      (e: unknown) => e,
    );
    expect(inspectErr).toBeInstanceOf(ShadowError);
    expect((inspectErr as Error).message).toContain('Transaction Pooler');
    expect((inspectErr as Error).message).not.toContain(encodedPw);
    expect((inspectErr as Error).message).not.toContain(decodedPw);

    // 3. claim 阶段 42501 且传入 dbName / currentUser：保留原前缀并输出精确可执行 SQL
    const err42501 = Object.assign(new Error('must be owner of database shop_dowel'), { code: '42501' });
    const claimPlain = shadowSetupError(err42501, 'claim', {
      dbName: 'shop_dowel',
      currentUser: 'dowel_user',
    });
    expect(claimPlain.message).toMatch(/^认领影子库失败：当前账号不是该库的所有者/);
    expect(claimPlain.message).toContain('ALTER DATABASE shop_dowel OWNER TO dowel_user;');
    expect(claimPlain.message).toContain(`COMMENT ON DATABASE shop_dowel IS ${literal(SHADOW_MARK)};`);

    const claimQuoted = shadowSetupError(err42501, 'claim', {
      dbName: 'Shop-DB',
      currentUser: 'app-user',
    });
    expect(claimQuoted.message).toMatch(/^认领影子库失败：当前账号不是该库的所有者/);
    expect(claimQuoted.message).toContain('ALTER DATABASE "Shop-DB" OWNER TO "app-user";');
    expect(claimQuoted.message).toContain(`COMMENT ON DATABASE "Shop-DB" IS ${literal(SHADOW_MARK)};`);
  });
});

describe.skipIf(!PG_URL)('受限权限账号与影子库生命周期测试（真实 PG）', () => {
  const admin = PG_URL ? connect(PG_URL) : (null as never);

  const randomTag = () => Math.random().toString(36).slice(2, 8);

  const roleUrlFor = (role: string, password: string, dbName: string) => {
    const u = new URL(dbUrl(dbName));
    u.username = role;
    u.password = password;
    return u.toString();
  };

  const shadowLockIsFree = async (url: string) => {
    const c = connect(url);
    try {
      const [r] = await c.db.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext('dowel_shadow')) as ok",
      );
      if (r?.ok) await c.db.exec("select pg_advisory_unlock(hashtext('dowel_shadow'))");
      return r?.ok === true;
    } finally {
      await c.close();
    }
  };

  afterAll(async () => {
    if (!PG_URL) return;
    await admin.close();
  });

  test('Case A：NOSUPERUSER + CREATEDB 自动建 {db}_dowel 并跑通 importSql / verify / canonicalize 且无残留锁', async () => {
    const tag = randomTag();
    const role = `dowel_a_${tag}`;
    const pw = `pw-a-${tag}`;
    const targetDb = `q7_a_${tag}`;
    const shadowDb = `${targetDb}_dowel`;
    let shadow: ReturnType<typeof pgShadow> | null = null;

    await admin.db.exec(`CREATE ROLE ${ident(role)} NOSUPERUSER CREATEDB LOGIN PASSWORD ${literal(pw)}`);
    await admin.db.exec(`CREATE DATABASE ${ident(targetDb)} OWNER ${ident(role)}`);
    try {
      const prepared = await ensureSameInstanceShadow(roleUrlFor(role, pw, targetDb));
      expect(prepared.created).toBe(true);
      expect(prepared.shadow).toBe(shadowDb);

      const [mark] = await admin.db.query<{ c: string | null }>(
        "select shobj_description(oid, 'pg_database') as c from pg_database where datname = $1",
        [shadowDb],
      );
      expect(mark?.c).toBe(SHADOW_MARK);

      shadow = pgShadow(prepared.url);
      const imported = await shadow.importSql(
        assertImportable('CREATE TABLE public.accounts (id bigint primary key, email text not null)'),
      );
      expect(Object.values(imported.objects).some((o) => o.kind === 'table' && o.name === 'accounts')).toBe(
        true,
      );
      expect(await shadowLockIsFree(prepared.url)).toBe(true);

      const vRep = await shadow.verify(FROM, TO);
      expect(vRep.ok).toBe(true);
      expect(vRep.error).toBeNull();
      expect(await shadowLockIsFree(prepared.url)).toBe(true);

      const withCheck = ordersModel();
      const tblId = Object.values(withCheck.objects).find((o) => o.kind === 'table')!.id;
      const ckId = addCheck(withCheck, tblId, 'id > 0', 'ck-id-pos');
      const changed = await shadow.canonicalize(FROM, withCheck);
      expect(changed.some((o) => o.kind === 'check' && o.id === ckId)).toBe(true);
      expect(await shadowLockIsFree(prepared.url)).toBe(true);
    } finally {
      await shadow?.close();
      await admin.db.exec(`DROP DATABASE IF EXISTS ${ident(shadowDb)} WITH (FORCE)`).catch(() => {});
      await admin.db.exec(`DROP DATABASE IF EXISTS ${ident(targetDb)} WITH (FORCE)`).catch(() => {});
      await admin.db.exec(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => {});
    }
  });

  test('Case B：NOSUPERUSER + NOCREATEDB 报错给出精确 CREATE DATABASE ... OWNER SQL；DBA 执行后可认领并完成验证', async () => {
    const tag = randomTag();
    const role = `dowel_b_${tag}`;
    const pw = `pw-b-${tag}`;
    const targetDb = `q7_b_${tag}`;
    const shadowDb = `${targetDb}_dowel`;
    let shadow: ReturnType<typeof pgShadow> | null = null;

    await admin.db.exec(`CREATE ROLE ${ident(role)} NOSUPERUSER NOCREATEDB LOGIN PASSWORD ${literal(pw)}`);
    await admin.db.exec(`CREATE DATABASE ${ident(targetDb)} OWNER ${ident(role)}`);
    try {
      const targetRoleUrl = roleUrlFor(role, pw, targetDb);
      const err = await ensureSameInstanceShadow(targetRoleUrl).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ShadowError);
      expect(err).not.toBeInstanceOf(ShadowUnavailableError);
      const msg = (err as Error).message;
      expect(msg).not.toContain(pw);
      const expectedSql = `CREATE DATABASE ${ident(shadowDb)} OWNER ${ident(role)};`;
      expect(msg).toContain(expectedSql);
      expect(msg).toContain('独立');

      // 管理员直接执行报错中给出的 SQL
      await admin.db.exec(expectedSql);

      const prepared = await ensureSameInstanceShadow(targetRoleUrl);
      expect(prepared.created).toBe(false);
      expect(prepared.shadow).toBe(shadowDb);

      shadow = pgShadow(prepared.url);
      const imported = await shadow.importSql(
        assertImportable('CREATE TABLE public.invoices (id bigint primary key)'),
      );
      expect(Object.values(imported.objects).some((o) => o.kind === 'table' && o.name === 'invoices')).toBe(
        true,
      );
      const rep = await shadow.verify(FROM, TO);
      expect(rep.ok).toBe(true);
      expect(await shadowLockIsFree(prepared.url)).toBe(true);
    } finally {
      await shadow?.close();
      await admin.db.exec(`DROP DATABASE IF EXISTS ${ident(shadowDb)} WITH (FORCE)`).catch(() => {});
      await admin.db.exec(`DROP DATABASE IF EXISTS ${ident(targetDb)} WITH (FORCE)`).catch(() => {});
      await admin.db.exec(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => {});
    }
  });

  test('Case C：NOSUPERUSER 非库所有者认领未打标空库给出精确 ALTER DATABASE ... OWNER TO SQL；移交后认领与验证成功', async () => {
    const tag = randomTag();
    const role = `dowel_c_${tag}`;
    const pw = `pw-c-${tag}`;
    const dbName = `q7_c_${tag}`;
    let shadow: ReturnType<typeof pgShadow> | null = null;

    await admin.db.exec(`CREATE ROLE ${ident(role)} NOSUPERUSER NOCREATEDB LOGIN PASSWORD ${literal(pw)}`);
    await admin.db.exec(`CREATE DATABASE ${ident(dbName)}`);
    try {
      const roleDbUrl = roleUrlFor(role, pw, dbName);
      const err = await claimShadow(roleDbUrl).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ShadowError);
      expect(err).not.toBeInstanceOf(ShadowUnavailableError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/^认领影子库失败：当前账号不是该库的所有者/);
      expect(msg).not.toContain(pw);
      const expectedAlter = `ALTER DATABASE ${ident(dbName)} OWNER TO ${ident(role)};`;
      expect(msg).toContain(expectedAlter);
      expect(msg).toContain(`COMMENT ON DATABASE ${ident(dbName)} IS ${literal(SHADOW_MARK)};`);

      await admin.db.exec(expectedAlter);
      await claimShadow(roleDbUrl);

      shadow = pgShadow(roleDbUrl);
      const rep = await shadow.verify(FROM, TO);
      expect(rep.ok).toBe(true);
      expect(await shadowLockIsFree(roleDbUrl)).toBe(true);
    } finally {
      await shadow?.close();
      await admin.db.exec(`DROP DATABASE IF EXISTS ${ident(dbName)} WITH (FORCE)`).catch(() => {});
      await admin.db.exec(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => {});
    }
  });

  test('Case D：DBA 预打标但未移交所有权时 resetShadow 42501 不误判为基础设施故障且释放锁；补交所有权后立即恢复', async () => {
    const tag = randomTag();
    const role = `dowel_d_${tag}`;
    const pw = `pw-d-${tag}`;
    const dbName = `q7_d_${tag}`;
    const roleDbUrl = roleUrlFor(role, pw, dbName);
    let shadow: ReturnType<typeof pgShadow> | null = null;

    await admin.db.exec(`CREATE ROLE ${ident(role)} NOSUPERUSER NOCREATEDB LOGIN PASSWORD ${literal(pw)}`);
    await admin.db.exec(`CREATE DATABASE ${ident(dbName)}`);
    await admin.db.exec(`COMMENT ON DATABASE ${ident(dbName)} IS ${literal(SHADOW_MARK)}`);
    try {
      shadow = pgShadow(roleDbUrl);
      const expectedAlter = `ALTER DATABASE ${ident(dbName)} OWNER TO ${ident(role)};`;

      const verifyErr = await shadow.verify(FROM, TO).then(
        () => null,
        (e: unknown) => e,
      );
      expect(verifyErr).toBeInstanceOf(ShadowError);
      expect(verifyErr).not.toBeInstanceOf(ShadowUnavailableError);
      expect((verifyErr as Error).message).not.toContain('影子库不可用');
      expect((verifyErr as Error).message).not.toContain(pw);
      expect((verifyErr as Error).message).toContain(expectedAlter);
      expect(await shadowLockIsFree(roleDbUrl)).toBe(true);

      const importErr = await shadow
        .importSql(assertImportable('CREATE TABLE public.tmp_check (id int)'))
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(importErr).toBeInstanceOf(ShadowError);
      expect(importErr).not.toBeInstanceOf(ShadowUnavailableError);
      expect((importErr as Error).message).not.toContain('影子库不可用');
      expect((importErr as Error).message).not.toContain(pw);
      expect((importErr as Error).message).toContain(expectedAlter);
      expect(await shadowLockIsFree(roleDbUrl)).toBe(true);

      // 管理员补交所有权后，同一 pgShadow 实例立即恢复正常
      await admin.db.exec(expectedAlter);

      const rep = await shadow.verify(FROM, TO);
      expect(rep.ok).toBe(true);
      expect(rep.error).toBeNull();
      const imported = await shadow.importSql(
        assertImportable('CREATE TABLE public.restored_ok (id bigint primary key)'),
      );
      expect(
        Object.values(imported.objects).some((o) => o.kind === 'table' && o.name === 'restored_ok'),
      ).toBe(true);
      expect(await shadowLockIsFree(roleDbUrl)).toBe(true);
    } finally {
      await shadow?.close();
      await admin.db.exec(`DROP DATABASE IF EXISTS ${ident(dbName)} WITH (FORCE)`).catch(() => {});
      await admin.db.exec(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => {});
    }
  });
});

describe.skipIf(!PG_URL)('待规范化判定与真实 PG 读回一致（#134）', () => {
  test('分区子表本地 CHECK：根父表列改类型后判为待规范化，影子库读回的规范形式也确实变了', async () => {
    const shadowDb = await createTestDb('derive_pending_part');
    await claimShadow(shadowDb.url);
    const shadow = pgShadow(shadowDb.url);
    try {
      const m = emptyModel();
      const pub = createSchema(m, 'public', 's-pub');
      const events = createTable(m, pub, 'events', 't-events');
      const day = addColumn(m, events, { name: 'day', type: 'integer', notNull: true, id: 'c-day' });
      addColumn(m, events, { name: 'amount', type: 'integer', id: 'c-amount' });
      setPartitionBy(m, events, {
        strategy: 'range',
        keys: [{ column: day, expr: null, opclass: null, collation: null }],
      });
      const child = createPartition(m, events, 'events_a', 'FOR VALUES FROM (0) TO (100)', 't-events-a');
      const ck = addCheck(m, child, 'amount >= 0', 'ck-amount');
      // 黄金基线：影子库规范化之后的模型
      const good = structuredClone(m);
      for (const o of await shadow.canonicalize(emptyModel(), m)) good.objects[o.id] = o;
      const before = (good.objects[ck] as { expr: string }).expr;

      const cur = structuredClone(good);
      setColumnType(cur, 'c-amount', 'numeric');
      expect(pendingRefreshIds(good, cur)).toContain(ck);
      const changed = await shadow.canonicalize(good, cur);
      const after = changed.find((o) => o.id === ck) as { expr: string } | undefined;
      // 例：(amount >= 0) → (amount >= (0)::numeric)；漏判时这份过期原文会留在模型里
      expect(after?.expr).toBeDefined();
      expect(after?.expr).not.toBe(before);
      expect(after?.expr).toContain('numeric');
    } finally {
      await shadow.close();
      await shadowDb.close();
    }
  });

  test('分区子表边界：父表分区键从 date 切换/改类型为 timestamp 后判为待规范化，PG 读回边界变为 timestamp 格式', async () => {
    const shadowDb = await createTestDb('derive_pending_part_bound');
    await claimShadow(shadowDb.url);
    const shadow = pgShadow(shadowDb.url);
    try {
      const m = emptyModel();
      const pub = createSchema(m, 'public', 's-pub');
      const events = createTable(m, pub, 'events', 't-events');
      const day = addColumn(m, events, { name: 'day', type: 'date', notNull: true, id: 'c-day' });
      const ts = addColumn(m, events, { name: 'ts', type: 'timestamp', notNull: true, id: 'c-ts' });
      setPartitionBy(m, events, {
        strategy: 'range',
        keys: [{ column: day, expr: null, opclass: null, collation: null }],
      });
      const child = createPartition(
        m,
        events,
        'events_2020',
        "FOR VALUES FROM ('2020-01-01') TO ('2021-01-01')",
        't-events-2020',
      );
      const good = structuredClone(m);
      for (const o of await shadow.canonicalize(emptyModel(), m)) good.objects[o.id] = o;
      const before = (good.objects[child] as Table).partitionOf!.bound;

      // 路径 A：有子分区时直接 setPartitionBy 切换到 timestamp 列
      const curA = structuredClone(good);
      setPartitionBy(curA, events, {
        strategy: 'range',
        keys: [{ column: ts, expr: null, opclass: null, collation: null }],
      });
      expect(pendingRefreshIds(good, curA)).toContain(child);
      const changedA = await shadow.canonicalize(good, curA);
      const afterA = changedA.find((o): o is Table => o.kind === 'table' && o.id === child);
      expect(afterA?.partitionOf?.bound).toBeDefined();
      expect(afterA?.partitionOf?.bound).not.toBe(before);
      expect(afterA?.partitionOf?.bound).toBe(
        "FOR VALUES FROM ('2020-01-01 00:00:00') TO ('2021-01-01 00:00:00')",
      );
      const goodA = structuredClone(curA);
      for (const o of changedA) goodA.objects[o.id] = o;
      expect(pendingRefreshIds(goodA, structuredClone(goodA))).toEqual([]);

      // 路径 A2：detach → 取消分区 → 改键列为 timestamp → 重新分区 → 用原边界原文 attach
      const curA2 = structuredClone(good);
      detachPartition(curA2, child);
      setPartitionBy(curA2, events, null);
      setColumnType(curA2, day, 'timestamp');
      setPartitionBy(curA2, events, {
        strategy: 'range',
        keys: [{ column: day, expr: null, opclass: null, collation: null }],
      });
      const childDay = Object.values(curA2.objects).find(
        (o) => o.kind === 'column' && o.parent === child && o.name === 'day',
      )!;
      setColumnType(curA2, childDay.id, 'timestamp');
      attachPartition(curA2, events, child, before);
      expect(pendingRefreshIds(good, curA2)).toContain(child);
      const changedA2 = await shadow.canonicalize(good, curA2);
      const afterA2 = changedA2.find((o): o is Table => o.kind === 'table' && o.id === child);
      expect(afterA2?.partitionOf?.bound).toBe(
        "FOR VALUES FROM ('2020-01-01 00:00:00') TO ('2021-01-01 00:00:00')",
      );
    } finally {
      await shadow.close();
      await shadowDb.close();
    }
  });
});

describe.skipIf(!PG_URL)('待规范化判定与真实 PG 读回一致：表达式直接引用枚举（#146）', () => {
  /** orders(status text)：默认值与 CHECK 直接写枚举转换，没有列的 typeRef 指向枚举 */
  const enumModel = (ty: string): Model => {
    const m = emptyModel();
    runMutator(m, 'createSchema', { id: 's', name: 'public' });
    runMutator(m, 'createEnum', { id: 'e1', schema: 's', name: 'mood', values: ['ok', 'bad'] });
    runMutator(m, 'createEnum', { id: 'e2', schema: 's', name: 'tone', values: ['ok', 'lo'] });
    runMutator(m, 'createTable', { id: 't', schema: 's', name: 'orders' });
    runMutator(m, 'addColumn', {
      table: 't',
      column: { id: 'st', name: 'status', type: 'text', default: { expr: `('ok'::${ty})::text` } },
    });
    runMutator(m, 'addCheck', { id: 'k', table: 't', expr: `((status)::${ty} IS NOT NULL)` });
    return m;
  };
  const textOf = (m: Model) => [
    (m.objects.st as { default: { expr: string } }).default.expr,
    (m.objects.k as { expr: string }).expr,
    (m.objects.ix as { where: string }).where,
  ];

  test('两个枚举对调名字后换回旧快照：表达式原文与基线逐字相同，判为待规范化；影子库迁移重建了依赖对象，读回与模型一致', async () => {
    const shadowDb = await createTestDb('derive_pending_enum');
    await claimShadow(shadowDb.url);
    const shadow = pgShadow(shadowDb.url);
    try {
      const m = enumModel('public.mood');
      runMutator(m, 'addIndex', {
        id: 'ix',
        table: 't',
        elements: [{ column: 'st' }],
        where: "('ok'::public.mood IS NOT NULL)",
      });
      const good = structuredClone(m);
      for (const o of await shadow.canonicalize(emptyModel(), m)) good.objects[o.id] = o;
      expect(textOf(good)).toEqual([
        "('ok'::public.mood)::text",
        '((status)::public.mood IS NOT NULL)',
        "('ok'::public.mood IS NOT NULL)",
      ]);

      // 换入另一条历史上两个枚举对调过名字的快照：表达式原文不变，名字换了绑定
      const cur = structuredClone(good);
      (cur.objects.e1 as { name: string }).name = 'tone';
      (cur.objects.e2 as { name: string }).name = 'mood';
      expect(pendingRefreshIds(good, cur)).toEqual(['st', 'k', 'ix']);
      const changed = await shadow.canonicalize(good, cur);
      const after = structuredClone(cur);
      for (const o of changed) after.objects[o.id] = o;
      // 影子库从基线增量迁移：PG 按 OID 存表达式，规划器检出绑定变了（#160），改名之外还重建默认值、CHECK、部分索引，
      // 让它们按模型里的名字绑定到现在叫 mood 的 e2，所以读回与模型原文一致、没有要写回的。
      // 判为待规范化仍然必要（宁多勿漏）：漏判时出口 0 I/O，不会经过影子库确认
      expect(changed.map((o) => o.id)).toEqual([]);
      expect(textOf(after)).toEqual([
        "('ok'::public.mood)::text",
        '((status)::public.mood IS NOT NULL)',
        "('ok'::public.mood IS NOT NULL)",
      ]);
      expect(pendingRefreshIds(after, structuredClone(after))).toEqual([]);
    } finally {
      await shadow.close();
      await shadowDb.close();
    }
  });

  test('非限定写法 ::mood 在影子库（search_path 为空）里建不出来：黄金基线里只会有带 schema 的枚举转换', async () => {
    const shadowDb = await createTestDb('derive_pending_enum_unq');
    await claimShadow(shadowDb.url);
    const shadow = pgShadow(shadowDb.url);
    try {
      await expect(shadow.canonicalize(emptyModel(), enumModel('mood'))).rejects.toThrow(
        /type "mood" does not exist/,
      );
    } finally {
      await shadow.close();
      await shadowDb.close();
    }
  });
});
