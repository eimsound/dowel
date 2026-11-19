// 真实 PG 上的影子库行为：analyze 出错后连接要恢复干净、非事务步骤不挡住风险分析、
// 影子库常驻连接出问题时要丢掉（锁随连接释放）、建 / 认领影子库时的错误分类。
// 需要测试 PG（Testcontainers 或 DOWEL_TEST_PG），没有 Docker 时跳过。
import { addColumn, createSchema, createTable, emptyModel, type Model } from '@dowel/core';
import { analyze, InstanceLevelStatementError, NON_TRANSACTIONAL_NOTE, StepError } from '@dowel/verifier';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { connect, createTestDb, dbUrl, PG_URL } from '../../../test/pg.ts';
import { scrubSecrets } from '../src/secrets.ts';
import { ShadowError, ShadowUnavailableError, toShadowError } from '../src/shadow.ts';
import { claimShadow, pgShadow, shadowSetupError } from '../src/targets.ts';

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
