// PG 多版本服务端集成测试：
// - 环境 PG 版本记录与更新（engineVersion / engineVersionNum / engineMajor）
// - 项目目标最低版本推导（targetPgMajor / envPgMajors）
// - 跨版本不兼容特性拦截（VIRTUAL 生成列 / 显式命名 NOT NULL）
// - 按 targetPgMajor 冻结脚本与导出 DDL / 迁移
// - Shadows.forProjectVersions / forProjectEngineVersions 选影优先级与分组（大版本组 / 数据库完整版本号）
// - 多版本影子库验证编排（ADR 0017 决定 5）：按完整版本号逐条记录（仅首个跑风险分析）、任一失败拒发布、
//   没有与环境版本一致的通过记录拒发布、未覆盖的环境列出但不阻止发布
import type {
  EnvInfo,
  ProjectInfo,
  PublishRejected,
  VersionCreated,
  VersionDetail,
  VersionVerifyResponse,
} from '@dowel/api';
import { addColumn, all, type Column, setNotNull } from '@dowel/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { projectPgVersionSummary } from '../src/envs.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { LoginLimiter } from '../src/rate-limit.ts';
import { encrypt } from '../src/secrets.ts';
import { type Shadow, ShadowError } from '../src/shadow.ts';
import { Shadows } from '../src/shadows.ts';
import { addTable, editModel, makeUser, PASSWORD, stubPassingShadow } from './support.ts';

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

    // 先建一张普通表并发布：生产环境没有可用影子库 → 拒绝发布（ADR 0017 决定 1）；换成 16.4 的影子库替身后冻结
    await addTable(created.rooms, db, pid, 'orders');
    const noShadow = await call<PublishRejected>('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
    expect(noShadow.status).toBe(422);
    expect(noShadow.data.code).toBe('shadow_unavailable');
    const restoreShadow = stubPassingShadow(created.shadows, { pids: [pid], engineVersion: '16.4' });
    const pub1 = await call<VersionCreated>('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
    restoreShadow();
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

  /** 把 Shadows.forProjectEngineVersions 换成固定的选影结果（环境列表 + 各完整版本号的代表影子库）；返回还原函数 */
  const stubEngineShadows = (o: {
    environments: { id: string; name: string; engineVersion: string | null }[];
    entries: { engineVersion: string | null; envId: string; label: string; shadow: Shadow }[];
    skipped?: { engineVersion: string | null; reason: string }[];
  }) => {
    const orig = created.shadows.forProjectEngineVersions.bind(created.shadows);
    created.shadows.forProjectEngineVersions = async () => ({
      entries: o.entries,
      skipped: o.skipped ?? [],
      environments: o.environments,
      identical: false,
    });
    return () => {
      created.shadows.forProjectEngineVersions = orig;
    };
  };

  test('多版本影子库验证（ADR 0017 决定 5）：按环境的数据库完整版本号逐个验证，仅首个跑风险分析，每个版本记一条通过记录', async () => {
    const pid = await newProject('multi-shadow-ok');
    await addTable(created.rooms, db, pid, 'orders');

    const calls: { version: string; skipRisk: boolean }[] = [];
    const restore = stubEngineShadows({
      environments: [
        { id: 'e15', name: 'prod15', engineVersion: '15.8' },
        { id: 'e18', name: 'dev18', engineVersion: '18.1' },
      ],
      entries: [
        {
          engineVersion: '15.8',
          envId: 'e15',
          label: 'prod15：shadow15',
          shadow: stubShadow(async (_f, _t, _u, _d, opts) => {
            calls.push({ version: '15.8', skipRisk: Boolean(opts?.skipRisk) });
            return { ...okVerifyReport(true), engineVersion: '15.8' };
          }),
        },
        {
          engineVersion: '18.1',
          envId: 'e18',
          label: 'dev18：shadow18',
          shadow: stubShadow(async (_f, _t, _u, _d, opts) => {
            calls.push({ version: '18.1', skipRisk: Boolean(opts?.skipRisk) });
            return { ...okVerifyReport(false), engineVersion: '18.1' };
          }),
        },
      ],
    });
    try {
      const r = await call<VersionCreated>('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
      expect(r.status).toBe(201);
      expect(r.data).toMatchObject({ verified: true, verifiedOn: ['15.8', '18.1'], uncovered: [] });
      expect(calls).toEqual([
        { version: '15.8', skipRisk: false },
        { version: '18.1', skipRisk: true },
      ]);

      const d = await call<VersionDetail>('GET', `/api/projects/${pid}/versions/${r.data.id}`);
      expect(d.status).toBe(200);
      expect(d.data.verifiedAt).not.toBeNull();
      expect(d.data.verifiedOn).toEqual(['15.8', '18.1']);
      expect(d.data.verifyReport?.records).toEqual([
        expect.objectContaining({ engineVersion: '15.8', ok: true, shadow: 'prod15：shadow15', error: null }),
        expect.objectContaining({ engineVersion: '18.1', ok: true, shadow: 'dev18：shadow18', error: null }),
      ]);
      expect(d.data.verifyReport?.risks).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test('任一可用影子库验证失败：整体拒绝发布（verify_failed）并指明失败的数据库完整版本号', async () => {
    const pid = await newProject('multi-shadow-fail');
    await addTable(created.rooms, db, pid, 'orders');

    const restore = stubEngineShadows({
      environments: [
        { id: 'e15', name: 'prod15', engineVersion: '15.8' },
        { id: 'e18', name: 'dev18', engineVersion: '18.1' },
      ],
      entries: [
        {
          engineVersion: '15.8',
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
            engineVersion: '15.8',
          })),
        },
        {
          engineVersion: '18.1',
          envId: 'e18',
          label: 'dev18：shadow18',
          shadow: stubShadow(async () => ({ ...okVerifyReport(), engineVersion: '18.1' })),
        },
      ],
    });
    try {
      const r = await call<PublishRejected>('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
      expect(r.status).toBe(422);
      expect(r.data.code).toBe('verify_failed');
      expect(r.data.error).toContain('15.8');
      expect(r.data.report?.ok).toBe(false);
      expect(r.data.report?.error?.message).toContain('15.8 验证失败');
      expect(r.data.report?.records).toEqual([
        expect.objectContaining({
          engineVersion: '15.8',
          ok: false,
          error: expect.stringContaining('VIRTUAL'),
        }),
      ]);
      expect((await call<unknown[]>('GET', `/api/projects/${pid}/versions`)).data).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test('某个环境版本没有可用影子库：凭与其他环境一致的通过记录发布，未覆盖的环境列在 uncovered（最低目标版本门禁已删除）', async () => {
    const pid = await newProject('missing-lowest-shadow');
    await addTable(created.rooms, db, pid, 'orders');

    const restore = stubEngineShadows({
      environments: [
        { id: 'e-prod-15', name: 'prod15', engineVersion: '15.8' },
        { id: 'e-dev-18', name: 'dev18', engineVersion: '18.1' },
      ],
      skipped: [{ engineVersion: '15.8', reason: '环境“prod15”是生产环境，默认不在同一实例上建影子库' }],
      entries: [
        {
          engineVersion: '18.1',
          envId: 'e-dev-18',
          label: 'dev18：app_dowel',
          shadow: stubShadow(async () => ({ ...okVerifyReport(true), engineVersion: '18.1' })),
        },
      ],
    });
    try {
      const pub = await call<VersionCreated>('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
      expect(pub.status).toBe(201);
      expect(pub.data).toMatchObject({
        verified: true,
        verifiedOn: ['18.1'],
        uncovered: [{ id: 'e-prod-15', name: 'prod15', engineVersion: '15.8' }],
      });
      const d = await call<VersionDetail>('GET', `/api/projects/${pid}/versions/${pub.data.id}`);
      expect(d.data.verifiedAt).not.toBeNull();
      expect(d.data.verifyReport?.records).toEqual([
        expect.objectContaining({ engineVersion: '18.1', ok: true }),
      ]);

      // 重新验证：仍然只覆盖 18.1；记录按完整版本号合并，不重复
      const rev = await call<VersionVerifyResponse>(
        'POST',
        `/api/projects/${pid}/versions/${pub.data.id}/verify`,
      );
      expect(rev.status).toBe(200);
      expect(rev.data.verifiedAt).not.toBeNull();
      expect(rev.data.verifiedOn).toEqual(['18.1']);
      expect(rev.data.uncovered).toEqual([{ id: 'e-prod-15', name: 'prod15', engineVersion: '15.8' }]);
      expect(rev.data.report.records).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test('严格安全规则：通过验证的影子库版本与任何环境都不一致（含未探测版本的环境）时拒绝发布（no_matching_shadow）', async () => {
    const pid = await newProject('missing-lowest-with-null-env');
    await addTable(created.rooms, db, pid, 'orders');

    const restore = stubEngineShadows({
      environments: [
        { id: 'e-prod-15', name: 'prod15', engineVersion: '15.8' },
        { id: 'e-dev-null', name: 'dev', engineVersion: null },
      ],
      skipped: [{ engineVersion: '15.8', reason: '环境“prod15”是生产环境，默认不在同一实例上建影子库' }],
      entries: [
        {
          engineVersion: null,
          envId: 'e-dev-null',
          label: 'dev：app_dowel',
          shadow: stubShadow(async () => ({
            ...okVerifyReport(true),
            shadowMajor: 18,
            shadowVersionNum: 180000,
            engineVersion: '18.0',
          })),
        },
      ],
    });
    try {
      const pub = await call<PublishRejected>('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
      expect(pub.status).toBe(422);
      expect(pub.data.code).toBe('no_matching_shadow');
      expect(pub.data.error).toContain('18.0');
      expect(pub.data.error).toContain('15.8');
      expect(pub.data.environments).toEqual([
        { id: 'e-prod-15', name: 'prod15', engineVersion: '15.8' },
        { id: 'e-dev-null', name: 'dev', engineVersion: null },
      ]);
      expect((await call<unknown[]>('GET', `/api/projects/${pid}/versions`)).data).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test('严格安全规则：prod=PG 15 配了 PG 18 的独立影子库（版本错配）时，按影子库实测版本记录，不误记为 15 通过', async () => {
    const pid = await newProject('shadow-version-mismatch');
    await addTable(created.rooms, db, pid, 'orders');

    const restore = stubEngineShadows({
      environments: [{ id: 'e-prod-15', name: 'prod15', engineVersion: '15.8' }],
      entries: [
        {
          engineVersion: '15.8',
          envId: 'e-prod-15',
          label: 'prod15：wrong_pg18_shadow',
          // 实测影子库是 18.0，与环境记录的 15.8 不一致
          shadow: stubShadow(async () => ({
            ...okVerifyReport(true),
            shadowMajor: 18,
            shadowVersionNum: 180000,
            engineVersion: '18.0',
          })),
        },
      ],
    });
    try {
      const pub = await call<PublishRejected>('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
      expect(pub.status).toBe(422);
      expect(pub.data.code).toBe('no_matching_shadow');
      expect(pub.data.error).toContain('18.0');
      expect(pub.data.error).toContain('15.8');
      expect(pub.data.report?.records).toEqual([
        expect.objectContaining({ engineVersion: '18.0', ok: true }),
      ]);
    } finally {
      restore();
    }
  });

  test('POST /api/projects/:pid/verify 透传项目 targetPgMajor，拦截不兼容特性', async () => {
    const pid = await newProject('verify-endpoint-target-major');
    await insertEnvRow({
      id: 'e-verify-16',
      pid,
      name: 'prod16',
      engineVersion: '16.4',
      engineVersionNum: 160004,
    });
    await addTable(created.rooms, db, pid, 'orders');

    let seenMajor: number | null | undefined;
    const origForProject = created.shadows.forProject.bind(created.shadows);
    created.shadows.forProject = async () => ({
      label: 'prod16：shadow',
      shadow: {
        importSql: async () => {
          throw new Error('unused');
        },
        verify: async (_from, _to, opts) => {
          seenMajor = opts?.pgMajor;
          return okVerifyReport(true);
        },
        verifyScripts: async () => okVerifyReport(true),
        canonicalize: async () => [],
        close: async () => {},
      } as Shadow,
    });
    try {
      const res = await call('POST', `/api/projects/${pid}/verify`, { from: 'empty', to: 'head' });
      expect(res.status).toBe(200);
      expect(seenMajor).toBe(16);
    } finally {
      created.shadows.forProject = origForProject;
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
      expect(res.targetGroupKey).toBe(15);
      expect(await projectPgVersionSummary(db, pid)).toEqual({ targetPgMajor: 15, envPgMajors: [15, 16] });
      // PG 15 组仅有一个生产禁同实例环境 → 记入 skippedGroups
      expect(res.skippedGroups).toHaveLength(1);
      expect(res.skippedGroups[0]?.groupKey).toBe(15);
      // PG 16 组命中优先级最高的显式 shadowUrl 环境 e-16-explicit
      expect(res.entries).toHaveLength(1);
      expect(res.entries[0]?.groupKey).toBe(16);
      expect(res.entries[0]?.envId).toBe('e-16-explicit');

      // 闭环验证按数据库完整版本号分组（ADR 0017 决定 5）：同一个大版本里不同的小版本各自成组
      await insertEnvRow({
        id: 'e-16-6-dev',
        pid,
        name: 'dev16-6',
        url: 'postgres://postgres:secret@127.0.0.1:5432/app16_explicit',
        production: false,
        shadowUrl: 'postgres://postgres:secret@127.0.0.1:5432/shadow16',
        engineVersion: '16.6',
        engineVersionNum: 160006,
      });
      const byVersion = await shadowsTest.forProjectEngineVersions(pid);
      expect(byVersion.identical).toBe(false);
      expect(
        byVersion.environments
          .map((e) => [e.id, e.engineVersion])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual([
        ['e-15-prod-blocked', '15.7'],
        ['e-16-6-dev', '16.6'],
        ['e-16-dev', '16.4'],
        ['e-16-explicit', '16.4'],
        ['e-16-prod-no', '16.4'],
        ['e-16-prod-same', '16.4'],
      ]);
      expect(byVersion.skipped.map((x) => x.engineVersion)).toEqual(['15.7']);
      expect(byVersion.entries.map((e) => [e.engineVersion, e.envId])).toEqual([
        ['16.4', 'e-16-explicit'],
        ['16.6', 'e-16-6-dev'],
      ]);
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
