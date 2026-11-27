// 影子库操作里“用户的脚本 / 模型问题”和“影子库的基础设施问题”要分开：
// - 连接类（08、53、57P、55P03、58030 io_error、驱动的连接错误、ShadowError）：出现在任何地方都是基础设施故障；
// - 执行步骤（建 from、建 to、执行被验证的 up / down）时抛出的 StepError：58 类里 58030 以外的（58P01、58P02）、
//   以及原因是“语句超时”的 57014，算用户自己的 DDL 造成的（C 函数、很慢的物化视图、死循环），按验证失败处理；
//   其他 57014（管理员 pg_cancel_backend）和步骤之外的操作（读结构、重置、pinSession）里的 57014 / 58 类是基础设施故障；
// - 风险分析（analyze）不能影响验证结论，也不能掩盖失败：影子库的问题抛出，其余原样写进 riskError。
// 基础设施故障抛 ShadowError（带“影子库不可用：”前缀），调用方据此保持原有的验证状态。
// 用假的 Db：不需要真实的 PG，也不用真的把连接弄断。
import { addColumn, createSchema, createTable, emptyModel, type Model } from '@dowel/core';
import type { Db } from '@dowel/engines';
import { StepError } from '@dowel/verifier';
import { describe, expect, test, vi } from 'vitest';

import {
  assertImportable,
  isInfraFailure,
  ShadowError,
  shadowOps,
  ShadowUnavailableError,
} from '../src/shadow.ts';

// 假 Db 读回的结构永远是空的：读回核对（ADR 0017 决定 2）在这里必然“不一致”，与本文件关心的基础设施 / 风险分析分类无关。
// 这里把读回核对替换成“一致”，读回核对本身由 verified-readback.test.ts 与真实数据库测试覆盖
vi.mock('@dowel/executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dowel/executor')>()),
  readbackDiff: () => ({ total: 0, items: [], details: [] }),
}));

const modelWith = (schema: string): Model => {
  const m = emptyModel();
  const s = createSchema(m, schema);
  const t = createTable(m, s, 'orders');
  addColumn(m, t, { name: 'id', type: 'bigint' });
  return m;
};
/** from 有 schema src，to 有 schema app：建 from / 建 to / 迁移里各有可以单独挑出来的语句 */
const FROM = modelWith('src');
const TO = modelWith('app');

/** 假 Db：每条语句执行时问一次 hook（语句文本 + 这条语句第几次出现），hook 返回错误就抛 */
const fakeDb = (hook: (sql: string, nth: number) => unknown): Db => {
  const seen = new Map<string, number>();
  const check = (sql: string) => {
    const n = (seen.get(sql) ?? 0) + 1;
    seen.set(sql, n);
    const err = hook(sql, n);
    if (err) throw err;
  };
  return {
    query: async (q) => {
      check(q);
      return (q.includes('server_version_num') ? [{ v: 180000 }] : []) as never;
    },
    exec: async (q) => {
      check(q);
    },
  };
};

/** PG 的语句超时（statement_timeout）和“被取消”（管理员 pg_cancel_backend）的消息 */
const TIMEOUT = 'canceling statement due to statement timeout';
const CANCELLED = 'canceling statement due to user request';
const pgError = (code: string, message = '出错了') => Object.assign(new Error(message), { code });
const step = { kind: 'x', target: 'y', sql: 'CREATE SCHEMA a' };

describe('isInfraFailure', () => {
  test.each([
    ['08006', '连接失败'],
    ['08P01', '协议错误'],
    ['53300', '连接数用尽'],
    ['57P01', '管理员终止了连接'],
    ['55P03', '拿不到锁（lock_timeout）'],
    ['58030', 'io_error：磁盘 I/O 错误，任何地方出现都是影子库的问题'],
    ['CONNECTION_CLOSED', 'postgres.js：连接已关闭'],
    ['CONNECT_TIMEOUT', 'postgres.js：连接超时'],
    ['ECONNRESET', 'Node：连接被重置'],
    ['ETIMEDOUT', 'Node：超时'],
  ])('%s → 连接类故障：执行步骤时、步骤之外都是基础设施故障（%s）', (code) => {
    expect(isInfraFailure(new StepError(step, pgError(code)))).toBe(true);
    expect(isInfraFailure(pgError(code))).toBe(true);
  });

  test.each(['58P01', '58P02'])(
    'SQLSTATE %s（58 类里 58030 以外的，例如 LANGUAGE C 引用不存在的库）：执行步骤时是用户的问题，步骤之外才是基础设施故障',
    (code) => {
      expect(isInfraFailure(new StepError(step, pgError(code)))).toBe(false);
      expect(isInfraFailure(pgError(code))).toBe(true);
    },
  );

  test('57014：执行步骤时且原因是语句超时才是用户的问题；其他 57014（管理员取消）和步骤之外的都是基础设施故障', () => {
    expect(isInfraFailure(new StepError(step, pgError('57014', TIMEOUT)))).toBe(false);
    expect(isInfraFailure(new StepError(step, pgError('57014', CANCELLED)))).toBe(true);
    expect(isInfraFailure(new StepError(step, pgError('57014', '出错了')))).toBe(true);
    expect(isInfraFailure(pgError('57014', TIMEOUT))).toBe(true);
    expect(isInfraFailure(pgError('57014', CANCELLED))).toBe(true);
  });

  test.each(['42704', '42601', '42P07', '23505', '22P02'])(
    'SQLSTATE %s（SQL 本身的错）→ 不是基础设施故障',
    (code) => {
      expect(isInfraFailure(new StepError(step, pgError(code)))).toBe(false);
      expect(isInfraFailure(pgError(code))).toBe(false);
    },
  );

  test('ShadowError（含被 StepError 包着的）一律算；没有 code 的普通错误不算', () => {
    expect(isInfraFailure(new ShadowError('被占用'))).toBe(true);
    expect(isInfraFailure(new StepError(step, new ShadowError('被占用')))).toBe(true);
    expect(isInfraFailure(new Error('boom'))).toBe(false);
  });

  test('42501（权限不足）无论在步骤内还是步骤外都不是基础设施故障', () => {
    expect(isInfraFailure(pgError('42501', 'must be owner of schema public'))).toBe(false);
    expect(isInfraFailure(new StepError(step, pgError('42501', 'permission denied for schema public')))).toBe(
      false,
    );
  });
});

const FROZEN_UP = [{ sql: 'CREATE SCHEMA frozen_up', transactional: true }];
const FROZEN_DOWN = [{ sql: 'CREATE SCHEMA frozen_down', transactional: true }];

type Run = (d: Db) => Promise<{ ok: boolean; error: { message: string } | null; risks: unknown[] }>;
describe.each<[string, Run, string, string]>([
  // [名字, 调用, 被验证的 up 里的一条语句, 被验证的 down 里的一条语句]
  [
    'verifyScripts',
    (d) => shadowOps(async () => d).verifyScripts(FROM, TO, FROZEN_UP, FROZEN_DOWN),
    'CREATE SCHEMA frozen_up',
    'CREATE SCHEMA frozen_down',
  ],
  // verify() 自己 plan：up 里有 CREATE SCHEMA app（第 2 次出现，第 1 次是建 to），down 里有 CREATE SCHEMA src
  ['verify', (d) => shadowOps(async () => d).verify(FROM, TO), 'CREATE SCHEMA app', 'CREATE SCHEMA src'],
])('shadowOps.%s', (_name, run, upSql, downSql) => {
  /** 在“被验证的脚本”这一阶段抛错：只匹配最后一次出现（前面几次是建 to / 建 from 时的同一条语句） */
  const inScript = (sql: string, nth: number, err: unknown, target: string, scriptNth: number) =>
    sql === target && nth === scriptNth ? err : undefined;
  // 建 to（1 次）→ 建 from（0 或 1 次）→ 执行 up；verifyScripts 的冻结语句只在 up 里出现一次
  const upNth = _name === 'verify' ? 2 : 1;
  // verify 的 down（DROP / CREATE SCHEMA src 在建 from 时也出现一次）
  const downNth = _name === 'verify' ? 2 : 1;

  test('脚本里某一步 SQL 出错（类型不存在等）→ 验证失败，返回报告', async () => {
    const r = await run(
      fakeDb((s, n) => inScript(s, n, pgError('42704', 'type "x" does not exist'), upSql, upNth)),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('does not exist');
  });

  test('脚本里某一步执行超时（57014）→ 验证失败，报告写明“执行超时”', async () => {
    const r = await run(
      fakeDb((s, n) =>
        inScript(s, n, pgError('57014', 'canceling statement due to statement timeout'), upSql, upNth),
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('执行超时');
    expect(r.error?.message).toContain('statement timeout');
  });

  test('脚本里某一步 58 类错误（例如 LANGUAGE C 引用不存在的库）→ 验证失败，不说“执行超时”', async () => {
    const r = await run(
      fakeDb((s, n) => inScript(s, n, pgError('58P01', 'could not access file "x"'), upSql, upNth)),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('could not access file');
    expect(r.error?.message).not.toContain('执行超时');
  });

  test('回滚脚本里的 57014 同样是验证失败', async () => {
    const r = await run(fakeDb((s, n) => inScript(s, n, pgError('57014', TIMEOUT), downSql, downNth)));
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('执行超时');
  });

  test('脚本里连接断开 → 基础设施故障：抛带前缀的 ShadowError', async () => {
    const e = await run(
      fakeDb((s, n) => inScript(s, n, pgError('CONNECTION_CLOSED', '连接断开了'), upSql, upNth)),
    ).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ShadowError);
    expect((e as ShadowError).message).toBe('影子库不可用：连接断开了');
  });

  // 建 to / 建 from 执行的是用户模型的 DDL（C 函数、很慢的物化视图……），同样可能自己造成 57014 / 58
  test.each([
    ['57014', TIMEOUT],
    ['58P01', 'could not access file "x"'],
    ['58P02', 'could not create file "x"'],
  ])('建 to（目标模型）时 %s → 验证失败（ok:false 带报告），不是基础设施故障', async (code, message) => {
    const r = await run(
      fakeDb((s, n) => (s === 'CREATE SCHEMA app' && n === 1 ? pgError(code, message) : undefined)),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain(message);
    if (code === '57014') expect(r.error?.message).toContain('执行超时');
    else expect(r.error?.message).not.toContain('执行超时');
  });

  test.each([
    ['57014', TIMEOUT],
    ['58P01', 'could not access file "x"'],
  ])('建 from（父版本 / 空库）时 %s → 验证失败（ok:false 带报告）', async (code, message) => {
    const r = await run(fakeDb((s) => (s === 'CREATE SCHEMA src' ? pgError(code, message) : undefined)));
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain(message);
    if (code === '57014') expect(r.error?.message).toContain('执行超时');
  });

  test('执行步骤时的 58030（io_error）和被管理员取消的 57014 → ShadowError：不是用户的 DDL 造成的', async () => {
    for (const [code, message] of [
      ['58030', '磁盘出错了'],
      ['57014', CANCELLED],
    ] as const) {
      for (const target of ['CREATE SCHEMA app', 'CREATE SCHEMA src']) {
        const e = await run(
          fakeDb((s, n) => (s === target && n === 1 ? pgError(code, message) : undefined)),
        ).then(
          () => null,
          (x: unknown) => x,
        );
        expect(e, `${code} ${target}`).toBeInstanceOf(ShadowError);
        expect((e as ShadowError).message).toBe(`影子库不可用：${message}`);
      }
      const inUp = await run(fakeDb((s, n) => inScript(s, n, pgError(code, message), upSql, upNth))).then(
        () => null,
        (x: unknown) => x,
      );
      expect(inUp, `${code} 脚本里`).toBeInstanceOf(ShadowError);
    }
  });

  test.each(['08006', 'CONNECTION_CLOSED', '55P03'])(
    '建 to / 建 from 时连接类错误 %s → ShadowError',
    async (code) => {
      for (const target of ['CREATE SCHEMA app', 'CREATE SCHEMA src']) {
        const e = await run(
          fakeDb((s, n) => (s === target && n === 1 ? pgError(code, '出事了') : undefined)),
        ).then(
          () => null,
          (x: unknown) => x,
        );
        expect(e, `${code} ${target}`).toBeInstanceOf(ShadowError);
        expect((e as ShadowError).message).toBe('影子库不可用：出事了');
      }
    },
  );

  test.each(['57014', '58P01'])(
    '读回结构（readSnapshot）时 %s → ShadowError（步骤之外的操作）',
    async (code) => {
      const e = await run(
        fakeDb((s) => (s.includes('server_version_num') ? pgError(code, '读不出来') : undefined)),
      ).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(ShadowError);
      expect((e as ShadowError).message).toBe('影子库不可用：读不出来');
    },
  );

  test.each(['57014', '58P01'])('重置影子库 / pinSession 时 %s → ShadowError', async (code) => {
    for (const match of ['SET TimeZone', 'select quote_ident']) {
      const e = await run(fakeDb((s) => (s.startsWith(match) ? pgError(code, '重置失败') : undefined))).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e, match).toBeInstanceOf(ShadowError);
      expect((e as ShadowError).message).toBe('影子库不可用：重置失败');
    }
  });

  test('建 to 时普通的 SQL 错误（目标模型本身建不出来）→ 验证失败，返回报告', async () => {
    const r = await run(
      fakeDb((s, n) =>
        s === 'CREATE SCHEMA app' && n === 1
          ? pgError('42704', 'type "nosuchtype" does not exist')
          : undefined,
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('nosuchtype');
  });

  test('ShadowError 原样抛出；执行 SQL 之外的未知错误也不记成验证失败', async () => {
    await expect(
      run(fakeDb((s, n) => inScript(s, n, new ShadowError('影子库不可用：被占用了'), upSql, upNth))),
    ).rejects.toThrow('影子库不可用：被占用了');
    const brokenQuery: Db = {
      query: async () => {
        throw new TypeError('读结构时出错');
      },
      exec: async () => {},
    };
    await expect(run(brokenQuery)).rejects.toThrow(TypeError);
  });
});

describe('57014 不靠英文消息：看耗时是不是到了语句超时', () => {
  const LOCALIZED = '由于语句超时，正在取消语句'; // lc_messages 是本地化的：消息里没有英文 "statement timeout"
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('isInfraFailure：消息本地化时，耗时 ≥ 语句超时的 90% 算用户的问题，很短就被取消算基础设施问题', () => {
    const slow = new StepError(step, pgError('57014', LOCALIZED), 119_000);
    const quick = new StepError(step, pgError('57014', LOCALIZED), 50);
    expect(isInfraFailure(slow)).toBe(false); // 默认 120s：119s ≥ 108s
    expect(isInfraFailure(quick)).toBe(true);
    // 阈值是 90%：恰好边界
    expect(isInfraFailure(new StepError(step, pgError('57014', LOCALIZED), 108_000))).toBe(false);
    expect(isInfraFailure(new StepError(step, pgError('57014', LOCALIZED), 107_999))).toBe(true);
    // 会话超时是 100ms 时，95ms 就算
    expect(isInfraFailure(new StepError(step, pgError('57014', LOCALIZED), 95), 100)).toBe(false);
    // 英文消息里有 statement timeout，耗时再短也算（沿用原来的判断）
    expect(isInfraFailure(new StepError(step, pgError('57014', TIMEOUT), 1))).toBe(false);
  });

  /** 执行到 target 时先睡 delay 毫秒再抛 57014（中文消息）；statement_timeout 调小到 100ms 方便测 */
  const slowDb = (target: string, delay: number): Db => ({
    query: async (q) => (q.includes('server_version_num') ? ([{ v: 180000 }] as never) : ([] as never)),
    exec: async (q) => {
      if (q === target) {
        await sleep(delay);
        throw pgError('57014', LOCALIZED);
      }
    },
  });
  const up = [{ sql: 'CREATE SCHEMA frozen_up', transactional: true }];

  test('执行脚本时：耗时超过会话 statement_timeout 的 90% → 验证失败（ok:false，报告写“执行超时”）', async () => {
    const ops = shadowOps(async () => slowDb('CREATE SCHEMA frozen_up', 150), null, {
      statementTimeoutMs: 100,
    });
    const r = await ops.verifyScripts(FROM, TO, up, []);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('执行超时');
    expect(r.error?.message).toContain(LOCALIZED);
  });

  test('执行脚本时：很快就被取消（管理员 pg_cancel_backend）→ 基础设施问题（ShadowError）', async () => {
    const ops = shadowOps(async () => slowDb('CREATE SCHEMA frozen_up', 0), null, {
      statementTimeoutMs: 100,
    });
    const e = await ops.verifyScripts(FROM, TO, up, []).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ShadowError);
  });
});

describe('实例级语句：执行之前就拒绝，一条都不执行', () => {
  const executed: string[] = [];
  const recordingDb = (): Db => {
    executed.length = 0;
    return {
      query: async (q) => {
        executed.push(q);
        return (q.includes('server_version_num') ? [{ v: 180000 }] : []) as never;
      },
      exec: async (q) => {
        executed.push(q);
      },
    };
  };

  test.each([
    'CREATE DATABASE probe',
    'ALTER SYSTEM SET work_mem = 1',
    'CREATE ROLE probe LOGIN',
    'DROP USER probe',
    "UPDATE t SET a = 1; ALTER DATABASE x SET timezone = 'UTC'",
  ])(
    'verifyScripts：%s → ok:false，说明里指出是哪一步，整份脚本一条都没执行（连建 from / to 都没做）',
    async (sql) => {
      const ops = shadowOps(async () => recordingDb());
      const r = await ops.verifyScripts(
        FROM,
        TO,
        [
          { sql: 'CREATE SCHEMA ok_step', transactional: true },
          { sql, transactional: false },
        ],
        [],
      );
      expect(r.ok).toBe(false);
      expect(r.error?.message).toContain('实例级语句不能放进迁移');
      expect(r.error?.step).toMatchObject({ kind: 'frozen', target: 'up#2', sql });
      expect(executed).toEqual([]); // 一条 SQL 都没发给影子库
    },
  );

  test('回滚脚本里的实例级语句同样在执行之前拒绝', async () => {
    const ops = shadowOps(async () => recordingDb());
    const r = await ops.verifyScripts(
      FROM,
      TO,
      [{ sql: 'CREATE SCHEMA ok_step', transactional: true }],
      [{ sql: 'DROP TABLESPACE probe', transactional: true }],
    );
    expect(r.ok).toBe(false);
    expect(r.error?.step?.target).toBe('down#1');
    expect(executed).toEqual([]);
  });
});

describe('analyze（风险分析）', () => {
  /** 第 3 次执行 CREATE SCHEMA app：1 = 建 to，2 = 被验证的 up，3 = analyze 重放 */
  const inAnalyze = (err: unknown) => (s: string, n: number) =>
    s === 'CREATE SCHEMA app' && n === 3 ? err : undefined;
  const ops = (err: unknown) => shadowOps(async () => fakeDb(inAnalyze(err)));

  test.each([
    ['58030', '分析时磁盘出错了'],
    ['57014', CANCELLED],
  ])('analyze 里 %s（io_error / 被管理员取消）→ ShadowError', async (code, message) => {
    const e = await ops(pgError(code, message))
      .verify(FROM, TO)
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).toBeInstanceOf(ShadowError);
    expect((e as ShadowError).message).toBe(`影子库不可用：${message}`);
  });

  test.each(['08006', 'CONNECTION_CLOSED', '57P01', '55P03'])(
    'analyze 里连接类故障 %s → ShadowError',
    async (code) => {
      for (const run of [
        (o: ReturnType<typeof ops>) => o.verify(FROM, TO),
        (o: ReturnType<typeof ops>) =>
          o.verifyScripts(
            FROM,
            TO,
            [{ sql: 'CREATE SCHEMA app', transactional: true }],
            [{ sql: 'CREATE SCHEMA src', transactional: true }],
          ),
      ]) {
        const e = await run(ops(pgError(code, '分析时断开了'))).then(
          () => null,
          (x: unknown) => x,
        );
        expect(e, code).toBeInstanceOf(ShadowError);
        expect((e as ShadowError).message).toBe('影子库不可用：分析时断开了');
      }
    },
  );

  test.each([
    ['57014', `${TIMEOUT}（分析时）`],
    ['58P01', '分析时系统错误'],
    ['25001', '不能在事务里执行'],
  ])(
    'analyze 里其他错误（%s）：ok 不变，风险为空，如实写进 riskError（不是“没有风险”）',
    async (code, message) => {
      for (const r of [
        await ops(pgError(code, message)).verify(FROM, TO),
        await ops(pgError(code, message)).verifyScripts(
          FROM,
          TO,
          [{ sql: 'CREATE SCHEMA app', transactional: true }],
          [{ sql: 'CREATE SCHEMA src', transactional: true }],
        ),
      ]) {
        expect(r.ok).toBe(true);
        expect(r.error).toBeNull();
        expect(r.risks).toEqual([]);
        // riskError 只存原因本身，不带“风险分析没有完成：”前缀（由界面标题提供）
        expect((r as { riskError?: string }).riskError).not.toContain('风险分析没有完成');
        expect((r as { riskError?: string }).riskError).toContain(message);
      }
    },
  );

  test('analyze 正常完成时没有 riskError', async () => {
    const r = await shadowOps(async () => fakeDb(() => undefined)).verify(FROM, TO);
    expect(r.ok).toBe(true);
    expect((r as { riskError?: string }).riskError).toBeUndefined();
  });
});

describe('importSql：实例级语句在入口（assertImportable）就拒绝', () => {
  const executed: string[] = [];
  const db = (hook?: (sql: string) => unknown): Db => ({
    query: async (q) => {
      executed.push(q);
      return (q.includes('server_version_num') ? [{ v: 180000 }] : []) as never;
    },
    exec: async (q) => {
      executed.push(q);
      const err = hook?.(q);
      if (err) throw err;
    },
  });

  test.each([
    'CREATE DATABASE evil',
    'create table t (a int);\nALTER SYSTEM SET fsync = off;',
    'CREATE ROLE evil SUPERUSER LOGIN',
    "COMMENT ON TABLE t IS 'ok'; DROP TABLESPACE fast",
  ])('%s → assertImportable 在入口拒绝（422 级别的 ShadowError），一条 SQL 都没发给影子库', (sql) => {
    executed.length = 0;
    // 入口检查只做一次：通过才拿得到 ImportableSql，importSql 只接受它（类型层面就没法绕过）
    expect(() => assertImportable(sql)).toThrow(ShadowError);
    expect(() => assertImportable(sql)).toThrow(/^导入的 SQL 含实例级语句（.+）。实例级语句不能放进迁移/);
    expect(executed).toEqual([]);
  });

  test('里面只是提到这些词（字符串、注释）的 SQL 照常导入', async () => {
    executed.length = 0;
    await shadowOps(async () => db()).importSql(
      assertImportable("create table t (a int); COMMENT ON TABLE t IS 'CREATE DATABASE x'; -- ALTER SYSTEM"),
    );
    expect(executed.some((q) => q.includes('create table t'))).toBe(true);
  });
});

describe('报告和 riskError 里的错误消息脱敏', () => {
  const leaky = (code: string) => pgError(code, 'foreign server postgres://u:pw@h/db: 出事了');

  test.each([
    [
      'verifyScripts',
      (ops: ReturnType<typeof shadowOps>) =>
        ops.verifyScripts(FROM, TO, [{ sql: 'CREATE SCHEMA frozen_up', transactional: true }], []),
    ],
    ['verify', (ops: ReturnType<typeof shadowOps>) => ops.verify(FROM, TO)],
  ])('%s：步骤报错的消息里有 postgres://u:pw@h/db → 报告里不出现 pw', async (_name, run) => {
    // 建 to 时报错（两条路径都会走到）
    const r = await run(
      shadowOps(async () =>
        fakeDb((s, n) => (s === 'CREATE SCHEMA app' && n === 1 ? leaky('42704') : undefined)),
      ),
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('pw');
    expect(r.error?.message).toContain('postgres://u:***@h/db');
  });

  test('riskError（analyze 里的错误）同样脱敏', async () => {
    const r = await shadowOps(async () =>
      fakeDb((s, n) => (s === 'CREATE SCHEMA app' && n === 3 ? leaky('25001') : undefined)),
    ).verify(FROM, TO);
    expect(r.ok).toBe(true);
    expect(r.riskError).toContain('postgres://u:***@h/db');
    expect(JSON.stringify(r)).not.toContain('pw');
  });
});

describe('resetShadow 权限不足（PG 42501）归类与 SQL 提示', () => {
  const privDb = (hook: (sql: string) => unknown): Db => ({
    query: async (q) => {
      const err = hook(q);
      if (err) throw err;
      if (q.includes('server_version_num')) return [{ v: 180000 }] as never;
      if (q.includes('pg_namespace')) return [{ n: 'public' }] as never;
      if (q.includes('current_database()')) return [{ d: 'shop_dowel', u: 'dowel_app' }] as never;
      return [] as never;
    },
    exec: async (q) => {
      const err = hook(q);
      if (err) throw err;
    },
  });

  test('verify / verifyScripts / importSql / canonicalize 在 resetShadow 遇 42501 时抛非不可用类 ShadowError 并附精确 SQL', async () => {
    const dropDenied = (sql: string) =>
      sql.startsWith('DROP SCHEMA') ? pgError('42501', 'must be owner of schema public') : undefined;
    const ops = shadowOps(async () => privDb(dropDenied));

    for (const run of [
      () => ops.verify(FROM, TO),
      () => ops.verifyScripts(FROM, TO, FROZEN_UP, FROZEN_DOWN),
      () => ops.importSql(assertImportable('CREATE TABLE public.t (id int)')),
      () => ops.canonicalize(FROM, TO),
    ]) {
      const e = await run().then(
        () => null,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(ShadowError);
      expect(e).not.toBeInstanceOf(ShadowUnavailableError);
      expect((e as Error).message).not.toContain('影子库不可用');
      expect((e as Error).message).toContain('ALTER DATABASE shop_dowel OWNER TO dowel_app;');
    }
  });

  test('importSql 在 resetShadow 遇基础设施连接故障时仍抛 ShadowUnavailableError', async () => {
    const connDropped = (sql: string) =>
      sql.startsWith('DROP SCHEMA') ? pgError('CONNECTION_CLOSED', '连接断开了') : undefined;
    const e = await shadowOps(async () => privDb(connDropped))
      .importSql(assertImportable('CREATE TABLE public.t (id int)'))
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).toBeInstanceOf(ShadowUnavailableError);
    expect((e as Error).message).toBe('影子库不可用：连接断开了');
  });
});

describe('verify / verifyScripts 复用 from 影子库，消除第 3 轮重建', () => {
  const countShadowOps = async (run: (ops: ReturnType<typeof shadowOps>) => Promise<unknown>) => {
    let createSrcCount = 0;
    let resetCount = 0;
    const ops = shadowOps(async () =>
      fakeDb((sql) => {
        if (sql === 'CREATE SCHEMA src') createSrcCount++;
        if (sql.startsWith('select quote_ident(nspname) as n from pg_namespace')) resetCount++;
        return undefined;
      }),
    );
    await run(ops);
    return { createSrcCount, resetCount };
  };

  test('verify() 闭环通过时直接复用当前处于 from 状态的影子库，跳过第 3 轮 reset 与建库', async () => {
    const res = await countShadowOps((ops) => ops.verify(FROM, TO));
    // resetShadow 仅在 buildTarget(to) 与 buildTarget(from) 各发生 1 次；analyze 复用当前影子库不再第 3 次 reset/create
    expect(res.resetCount).toBe(2);
    // verify(FROM, TO) 中 CREATE SCHEMA src 为 buildTarget(from) 1 次 + down 回滚重建 1 次 = 2 次（不再出现 analyze 第 3 次创建）
    expect(res.createSrcCount).toBe(2);
  });

  test('verifyScripts() 默认检查 down 且通过时跳过第 3 轮建库；checkDown=false 时不得跳过重建', async () => {
    const up = [{ sql: 'CREATE SCHEMA app', transactional: true }];
    const down = [{ sql: 'DROP SCHEMA app CASCADE', transactional: true }];
    const withDown = await countShadowOps((ops) => ops.verifyScripts(FROM, TO, up, down));
    const withoutDown = await countShadowOps((ops) =>
      ops.verifyScripts(FROM, TO, up, down, { checkDown: false }),
    );
    expect(withDown).toEqual({ resetCount: 2, createSrcCount: 1 });
    expect(withoutDown).toEqual({ resetCount: 3, createSrcCount: 2 });
  });
});
