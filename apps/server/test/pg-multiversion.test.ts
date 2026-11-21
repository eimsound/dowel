// PG 多版本服务端集成测试：
// - 环境 PG 版本记录与更新（engineVersion / engineVersionNum / engineMajor）
// - 项目目标最低版本推导（targetPgMajor / envPgMajors）
// - 跨版本不兼容特性拦截（VIRTUAL 生成列 / 显式命名 NOT NULL）
// - 按 targetPgMajor 冻结脚本与导出 DDL / 迁移
// - Shadows.forProjectVersions 选影优先级与去重升序分组
// - 多版本影子库验证编排：全通过（仅首版本跑风险分析）、某版本失败拒发布、缺失最低目标版本影子库拒标已验证
import type {
  EnvInfo,
  ProjectInfo,
  PublishRejected,
  StoredVerifyReport,
  VersionCreated,
  VersionDetail,
  VersionVerifyResponse,
} from '@dowel/api';
import { addColumn, all, type Column, setNotNull } from '@dowel/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { LoginLimiter } from '../src/rate-limit.ts';
import { encrypt } from '../src/secrets.ts';
import { type Shadow, ShadowError } from '../src/shadow.ts';
import { Shadows } from '../src/shadows.ts';
import { addTable, editModel, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'pg-multiversion-test-secret-0123456789';

describe('PG 多版本（15–19）服务端全链路', () => {
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  let adminCookie = '';
  let groupId = '';

  const call = async <T = Record<string, unknown>>(
    method: string,
    path: string,
    json?: unknown,
    cookie = adminCookie,
  ) => {
    const headers: Record<string, string> = {};
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await created.app.request(path, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data: data as T, text };
  };

  const newProject = async (name: string) => {
    const r = await call<{ id: string }>('POST', '/api/projects', { name, groupId });
    expect(r.status).toBe(201);
    return r.data.id;
  };

  const insertEnvRow = async (o: {
    id: string;
    pid: string;
    name: string;
    url?: string;
    production?: boolean;
    allowSameInstance?: boolean;
    shadowUrl?: string | null;
    engineVersion?: string | null;
    engineVersionNum?: number | null;
  }) => {
    await db.query(
      `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc,
                                 engine_version, engine_version_num)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        o.id,
        o.pid,
        o.name,
        encrypt(o.url ?? 'postgres://postgres:secret@127.0.0.1:5432/app'),
        o.production ?? false,
        o.allowSameInstance ?? false,
        o.shadowUrl ? encrypt(o.shadowUrl) : null,
        o.engineVersion ?? null,
        o.engineVersionNum ?? null,
      ],
    );
  };

  const okVerifyReport = (withRisk = false) => ({
    ok: true,
    up: [],
    down: [],
    upDiff: [],
    downDiff: [],
    risks: withRisk ? [{ locks: [], rewrites: [], scans: [], level: 'low' as const }] : [],
    error: null,
  });

  const stubShadow = (verifyScripts: Shadow['verifyScripts']): Shadow =>
    ({
      verifyScripts,
      importSql: async () => {
        throw new Error('unused');
      },
      verify: async () => {
        throw new Error('unused');
      },
      canonicalize: async () => [],
      close: async () => {},
    }) as Shadow;

  beforeAll(async () => {
    db = await openPlatformDb(':memory:');
    created = createApp(db, { loginLimiter: new LoginLimiter({ limit: 1000, windowMs: 60_000 }) });
    await makeUser(db, 'mv-admin', { name: 'MV Admin', role: 'admin' });
    const loginRes = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'mv-admin', password: PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    adminCookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;
    const g = await call<{ id: string }>('POST', '/api/groups', { slug: 'mv-team', name: 'MV Team' });
    expect(g.status).toBe(201);
    groupId = g.data.id;
  });

  afterAll(async () => {
    created.drift.stop();
    created.requests.stop();
    await created.webhooks.close();
    await created.refresher.drain();
    await created.shadows.close();
    created.rooms.close();
    await created.bus.close();
    await created.ha.stop();
    await db.close();
  });

  test('项目目标版本推导（targetPgMajor / envPgMajors）与环境版本字段返回', async () => {
    const pid = await newProject('target-derive');

    // 无环境时 targetPgMajor = null, envPgMajors = []
    const p0 = await call<ProjectInfo>('GET', `/api/projects/${pid}`);
    expect(p0.status).toBe(200);
    expect(p0.data.targetPgMajor).toBeNull();
    expect(p0.data.envPgMajors).toEqual([]);

    // 插入 PG 18 dev 和 PG 15 prod 以及一个同版本 PG 18 staging
    await insertEnvRow({
      id: 'env-dev-18',
      pid,
      name: 'dev',
      engineVersion: '18.2',
      engineVersionNum: 180002,
    });
    await insertEnvRow({
      id: 'env-stg-18',
      pid,
      name: 'staging',
      engineVersion: '18.1',
      engineVersionNum: 180001,
    });
    await insertEnvRow({
      id: 'env-prod-15',
      pid,
      name: 'prod',
      production: true,
      engineVersion: '15.9',
      engineVersionNum: 150009,
    });

    const p1 = await call<ProjectInfo>('GET', `/api/projects/${pid}`);
    expect(p1.status).toBe(200);
    expect(p1.data.targetPgMajor).toBe(15);
    expect(p1.data.envPgMajors).toEqual([15, 18]);

    const envs = await call<EnvInfo[]>('GET', `/api/projects/${pid}/environments`);
    expect(envs.status).toBe(200);
    expect(envs.data.find((e) => e.name === 'prod')).toMatchObject({
      engineVersion: '15.9',
      engineVersionNum: 150009,
      engineMajor: 15,
    });
    expect(envs.data.find((e) => e.name === 'dev')).toMatchObject({
      engineVersion: '18.2',
      engineVersionNum: 180002,
      engineMajor: 18,
    });
  });

  test('跨版本不兼容特性在发布 / migration / ddl 均被 422 清晰拦截，且 PG < 18 按目标版本冻结脚本', async () => {
    const pid = await newProject('compat-gate');
    await insertEnvRow({
      id: 'env-pg16',
      pid,
      name: 'prod16',
      production: true,
      engineVersion: '16.4',
      engineVersionNum: 160004,
    });

    // 先建一张普通表并发布（无可用影子库 → 未验证但成功冻结）
    await addTable(created.rooms, db, pid, 'orders');
    const pub1 = await call<VersionCreated>('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
    expect(pub1.status).toBe(201);
    const v1 = await call<VersionDetail>('GET', `/api/projects/${pid}/versions/${pub1.data.id}`);
    expect(v1.status).toBe(200);
    // 目标 PG 16：建表语句不得含 PG 18 语法 CONSTRAINT ... NOT NULL
    expect(v1.data.upSteps.some((s) => /CONSTRAINT .* NOT NULL/i.test(s.sql))).toBe(false);

    // 往表里加一个 PG 18 专属的 VIRTUAL 生成列
    await editModel(created.rooms, db, pid, (m) => {
      const t = all(m, 'table').find((x) => x.name === 'orders')!;
      addColumn(m, t.id, { name: 'total', type: 'int', notNull: true });
      addColumn(m, t.id, {
        name: 'total_doubled',
        type: 'int',
        generated: { expr: 'total * 2', stored: false },
      });
    });

    // /migration、/ddl 与发布版本全部返回 422 且说明需要 PostgreSQL 18+
    const mig = await call<{ error: string }>('GET', `/api/projects/${pid}/migration`);
    expect(mig.status).toBe(422);
    expect(mig.data.error).toContain('VIRTUAL');
    expect(mig.data.error).toContain('18');

    const ddl = await call<{ error: string }>('GET', `/api/projects/${pid}/ddl`);
    expect(ddl.status).toBe(422);
    expect(ddl.data.error).toContain('VIRTUAL');

    const pubBad = await call<{ error: string }>('POST', `/api/projects/${pid}/versions`, { name: 'v2-bad' });
    expect(pubBad.status).toBe(422);
    expect(pubBad.data.error).toContain('VIRTUAL');

    // 另外测试显式命名 NOT NULL 也被目标 PG 16 拦截
    const pid2 = await newProject('compat-named-nn');
    await insertEnvRow({
      id: 'env-pg16-2',
      pid: pid2,
      name: 'prod16',
      production: true,
      engineVersion: '16.4',
      engineVersionNum: 160004,
    });
    await addTable(created.rooms, db, pid2, 'items');
    await editModel(created.rooms, db, pid2, (m) => {
      const t = all(m, 'table').find((x) => x.name === 'items')!;
      const colId = addColumn(m, t.id, { name: 'sku', type: 'text', notNull: false });
      setNotNull(m, colId, true);
      const col = m.objects[colId] as Column;
      col.notNullName = 'items_sku_custom_nn';
      col.notNullNameMode = 'explicit';
    });
    const pubNn = await call<{ error: string }>('POST', `/api/projects/${pid2}/versions`, { name: 'v1' });
    expect(pubNn.status).toBe(422);
    expect(pubNn.data.error).toContain('NOT NULL');
    expect(pubNn.data.error).toContain('18');
  });

  test('多版本影子库验证：按大版本升序全跑且仅首版本跑风险分析，全部通过后标为已验证', async () => {
    const pid = await newProject('multi-shadow-ok');
    await addTable(created.rooms, db, pid, 'orders');

    const calls: { major: number; skipRisk: boolean }[] = [];
    const orig = created.shadows.forProjectVersions.bind(created.shadows);
    created.shadows.forProjectVersions = async () => ({
      targetPgMajor: 15,
      envPgMajors: [15, 18],
      skippedMajors: [],
      entries: [
        {
          major: 15,
          envId: 'e15',
          label: 'prod15：shadow15',
          shadow: stubShadow(async (_f, _t, _u, _d, opts) => {
            calls.push({ major: 15, skipRisk: Boolean(opts?.skipRisk) });
            return okVerifyReport(true);
          }),
        },
        {
          major: 18,
          envId: 'e18',
          label: 'dev18：shadow18',
          shadow: stubShadow(async (_f, _t, _u, _d, opts) => {
            calls.push({ major: 18, skipRisk: Boolean(opts?.skipRisk) });
            return okVerifyReport(false);
          }),
        },
      ],
    });
    try {
      const r = await call<VersionCreated>('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
      expect(r.status).toBe(201);
      expect(r.data.verified).toBe(true);
      expect(r.data.unverifiedReason).toBeNull();
      expect(calls).toEqual([
        { major: 15, skipRisk: false },
        { major: 18, skipRisk: true },
      ]);

      const d = await call<VersionDetail>('GET', `/api/projects/${pid}/versions/${r.data.id}`);
      expect(d.status).toBe(200);
      expect(d.data.verifiedAt).not.toBeNull();
      expect(d.data.verifyReport?.targets).toEqual([
        { major: 15, shadow: 'prod15：shadow15', ok: true, error: null, upDiffCount: 0, downDiffCount: 0 },
        { major: 18, shadow: 'dev18：shadow18', ok: true, error: null, upDiffCount: 0, downDiffCount: 0 },
      ]);
      expect(d.data.verifyReport?.risks).toHaveLength(1);
    } finally {
      created.shadows.forProjectVersions = orig;
    }
  });

  test('任一大版本影子库验证失败：整体验证失败并指明具体失败的 PG 版本', async () => {
    const pid = await newProject('multi-shadow-fail');
    await addTable(created.rooms, db, pid, 'orders');

    const orig = created.shadows.forProjectVersions.bind(created.shadows);
    created.shadows.forProjectVersions = async () => ({
      targetPgMajor: 15,
      envPgMajors: [15, 18],
      skippedMajors: [],
      entries: [
        {
          major: 15,
          envId: 'e15',
          label: 'prod15：shadow15',
          shadow: stubShadow(async () => ({
            ok: false,
            up: [],
            down: [],
            upDiff: [],
            downDiff: [],
            risks: [],
            error: { step: null, message: 'syntax error at or near "VIRTUAL"' },
          })),
        },
        {
          major: 18,
          envId: 'e18',
          label: 'dev18：shadow18',
          shadow: stubShadow(async () => okVerifyReport()),
        },
      ],
    });
    try {
      const r = await call<PublishRejected>('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
      expect(r.status).toBe(422);
      expect(r.data.error).toContain('PG 15');
      expect(r.data.report?.ok).toBe(false);
      expect(r.data.report?.targets).toEqual([
        {
          major: 15,
          shadow: 'prod15：shadow15',
          ok: false,
          error: 'syntax error at or near "VIRTUAL"',
          upDiffCount: 0,
          downDiffCount: 0,
        },
      ]);
    } finally {
      created.shadows.forProjectVersions = orig;
    }
  });

  test('严格安全规则：多版本项目缺少最低目标版本影子库时，不得仅凭高版本通过标记已验证', async () => {
    const pid = await newProject('missing-lowest-shadow');
    await addTable(created.rooms, db, pid, 'orders');

    // 真实走 Shadows.forProjectVersions 的选择逻辑：
    // prod15 是生产环境且不允许同实例也无 shadowUrl → 记入 skippedMajors
    // dev18 是非生产环境 → 在 entries 中（stub forProject 返回 mock shadow）
    await insertEnvRow({
      id: 'e-prod-15',
      pid,
      name: 'prod15',
      production: true,
      allowSameInstance: false,
      shadowUrl: null,
      engineVersion: '15.8',
      engineVersionNum: 150008,
    });
    await insertEnvRow({
      id: 'e-dev-18',
      pid,
      name: 'dev18',
      production: false,
      allowSameInstance: true,
      engineVersion: '18.1',
      engineVersionNum: 180001,
    });

    const orig = created.shadows.forProjectVersions.bind(created.shadows);
    created.shadows.forProjectVersions = async () => ({
      targetPgMajor: 15,
      envPgMajors: [15, 18],
      skippedMajors: [{ major: 15, reason: '环境“prod15”是生产环境，默认不在同一实例上建影子库' }],
      entries: [
        {
          major: 18,
          envId: 'e-dev-18',
          label: 'dev18：app_dowel',
          shadow: stubShadow(async () => okVerifyReport(true)),
        },
      ],
    });
    try {
      // 1) 发布版本：允许发布，但 verified 必须为 false，unverifiedReason 与 verifyReport 明确指出缺少 PG 15 影子库
      const pub = await call<VersionCreated>('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
      expect(pub.status).toBe(201);
      expect(pub.data.verified).toBe(false);
      expect(pub.data.unverifiedReason).toContain('PG 15');

      const d = await call<VersionDetail>('GET', `/api/projects/${pid}/versions/${pub.data.id}`);
      expect(d.status).toBe(200);
      expect(d.data.verifiedAt).toBeNull();
      const rep = d.data.verifyReport as StoredVerifyReport;
      expect(rep.ok).toBe(false);
      expect(rep.missingTargetMajor).toBe(15);
      expect(rep.targets).toEqual([
        { major: 18, shadow: 'dev18：app_dowel', ok: true, error: null, upDiffCount: 0, downDiffCount: 0 },
      ]);

      // 2) 重新验证：依然缺少 PG 15 影子库 → verifiedAt 必须继续为 null
      const rev = await call<VersionVerifyResponse>(
        'POST',
        `/api/projects/${pid}/versions/${pub.data.id}/verify`,
      );
      expect(rev.status).toBe(200);
      expect(rev.data.verifiedAt).toBeNull();
      expect(rev.data.report.ok).toBe(false);
      expect(rev.data.report.missingTargetMajor).toBe(15);
    } finally {
      created.shadows.forProjectVersions = orig;
    }
  });

  test('Shadows.forProjectVersions 按显式 shadowUrl > 非生产 > 允许同实例生产优先级分组选影', async () => {
    const pid = await newProject('shadow-priority');
    await insertEnvRow({
      id: 'e-16-prod-no',
      pid,
      name: 'prod16-no',
      production: true,
      allowSameInstance: false,
      engineVersion: '16.4',
      engineVersionNum: 160004,
    });
    await insertEnvRow({
      id: 'e-16-prod-same',
      pid,
      name: 'prod16-same',
      production: true,
      allowSameInstance: true,
      engineVersion: '16.4',
      engineVersionNum: 160004,
    });
    await insertEnvRow({
      id: 'e-16-dev',
      pid,
      name: 'dev16',
      production: false,
      engineVersion: '16.4',
      engineVersionNum: 160004,
    });
    await insertEnvRow({
      id: 'e-16-explicit',
      pid,
      name: 'prod16-explicit',
      url: 'postgres://postgres:secret@127.0.0.1:5432/app16_explicit',
      production: true,
      shadowUrl: 'postgres://postgres:secret@127.0.0.1:5432/shadow16',
      engineVersion: '16.4',
      engineVersionNum: 160004,
    });
    await insertEnvRow({
      id: 'e-15-prod-blocked',
      pid,
      name: 'prod15',
      production: true,
      allowSameInstance: false,
      engineVersion: '15.7',
      engineVersionNum: 150007,
    });

    const shadowsTest = new Shadows(db, async (url) => {
      if (url.endsWith('/app16_explicit') || url.endsWith('/shadow16')) return;
      throw new ShadowError(`blocked:${url}`);
    });
    try {
      const res = await shadowsTest.forProjectVersions(pid);
      expect(res.targetPgMajor).toBe(15);
      expect(res.envPgMajors).toEqual([15, 16]);
      // PG 15 组仅有一个生产禁同实例环境 → 记入 skippedMajors
      expect(res.skippedMajors).toHaveLength(1);
      expect(res.skippedMajors[0]?.major).toBe(15);
      // PG 16 组命中优先级最高的显式 shadowUrl 环境 e-16-explicit
      expect(res.entries).toHaveLength(1);
      expect(res.entries[0]?.major).toBe(16);
      expect(res.entries[0]?.envId).toBe('e-16-explicit');
    } finally {
      await shadowsTest.close();
    }
  });

  test.skipIf(!PG_URL)('真实目标库添加环境与测试连接自动记录 engineVersion 与 targetPgMajor', async () => {
    const target = await createTestDb('mv_real_target');
    try {
      const pid = await newProject('real-env-version');
      const add = await call<{ id: string; version: string; versionNum: number }>(
        'POST',
        `/api/projects/${pid}/environments`,
        { name: 'dev', url: target.url, production: false, allowSameInstance: true, shadowUrl: null },
      );
      expect(add.status).toBe(201);
      expect(add.data.versionNum).toBeGreaterThanOrEqual(150000);
      expect(add.data.version).toMatch(/^\d+/);

      const envs = await call<EnvInfo[]>('GET', `/api/projects/${pid}/environments`);
      expect(envs.status).toBe(200);
      expect(envs.data[0]?.engineVersion).toBe(add.data.version);
      expect(envs.data[0]?.engineVersionNum).toBe(add.data.versionNum);
      expect(envs.data[0]?.engineMajor).toBe(Math.floor(add.data.versionNum / 10000));

      const proj = await call<ProjectInfo>('GET', `/api/projects/${pid}`);
      expect(proj.status).toBe(200);
      expect(proj.data.targetPgMajor).toBe(Math.floor(add.data.versionNum / 10000));
      expect(proj.data.envPgMajors).toEqual([Math.floor(add.data.versionNum / 10000)]);

      // 手动清空 DB 中的版本字段后，调用 POST .../test 必须自动回写
      await db.query(
        'update environments set engine_version = null, engine_version_num = null where id = $1',
        [add.data.id],
      );
      const tested = await call<{ version: string; versionNum: number }>(
        'POST',
        `/api/projects/${pid}/environments/${add.data.id}/test`,
      );
      expect(tested.status).toBe(200);
      const envsAfter = await call<EnvInfo[]>('GET', `/api/projects/${pid}/environments`);
      expect(envsAfter.data[0]?.engineVersionNum).toBe(tested.data.versionNum);
    } finally {
      await target.close();
    }
  });
});
