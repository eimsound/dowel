// H6 基础执行权限：谁能执行三档——项目编辑者 / 项目管理员 / 仅限执行者；
// 默认非生产为编辑者、生产为项目管理员；档位存在环境上（P5a 起是执行策略的环境层，存在 exec_policies）。
// 这里的用户都不是执行者，所以“仅限执行者”只有实例管理员能过；执行者授权的场景见 policy.test.ts。
// 特权操作：执行 / 回滚 / 写基线、改连接串和影子库、删除环境、取消“生产”标记（以及改档位本身）。
// 模型的编辑和发布不受约束。不需要真实 PG：环境直接写库，授权检查在连接目标库之前。
import { type EnvInfo, type ExecPolicy, POLICY_DEFAULTS, type Role, resolvePolicy } from '@dowel/api';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  type Actor,
  can,
  ENV_ACTIONS,
  type EnvAction,
  isEnvConfigAction,
  type Resource,
} from '../src/authz.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { LoginLimiter } from '../src/rate-limit.ts';
import { encrypt } from '../src/secrets.ts';
import { makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'policy-test-secret-0123456789';

const ROLES: (Role | null)[] = ['viewer', 'editor', 'admin', null];
const POLICIES: (ExecPolicy | null)[] = [null, 'editor', 'admin', 'executor'];
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
/** 只有环境层设置时的生效档位（和服务端同一个 resolvePolicy） */
const effective = (production: boolean, policy: ExecPolicy | null): ExecPolicy =>
  resolvePolicy({ environment: policy ? { whoCanExecute: policy } : {} }, production).whoCanExecute.value;

describe('can()：环境上的特权操作按执行档位', () => {
  const user: Actor = { kind: 'user', id: 'u', instanceAdmin: false };
  const instanceAdmin: Actor = { kind: 'user', id: 'a', instanceAdmin: true };
  const res = (role: Role | null, production: boolean, execPolicy: ExecPolicy | null): Resource => ({
    kind: 'environment',
    role,
    production,
    execPolicy,
  });

  test('默认值：非生产为项目编辑者，生产为项目管理员', () => {
    // 默认值只有一处来源：@dowel/api 的 POLICY_DEFAULTS / resolvePolicy（审查后删掉了 authz.ts 里 H6 的那一份）
    expect(POLICY_DEFAULTS(false).whoCanExecute).toBe('editor');
    expect(POLICY_DEFAULTS(true).whoCanExecute).toBe('admin');
    expect(effective(false, null)).toBe('editor');
    expect(effective(true, null)).toBe('admin');
    expect(effective(true, 'editor')).toBe('editor');
    // can() 里没给生效档位、也不知道是不是生产时按严的算（项目编辑者被拒）
    expect(can(user, 'environment.execute', { kind: 'environment', role: 'editor' })).toBe(false);
    expect(can(user, 'environment.execute', { kind: 'environment', role: 'admin' })).toBe(true);
  });

  test.each(
    ENV_ACTIONS.flatMap((action) =>
      [false, true].flatMap((production) =>
        POLICIES.flatMap((policy) => ROLES.map((role) => ({ action, production, policy, role }))),
      ),
    ),
  )('$action · 生产=$production · 档位=$policy · 角色=$role', ({ action, production, policy, role }) => {
    const eff = effective(production, policy);
    // 实例管理员永远可以
    expect(can(instanceAdmin, action, res(role, production, policy))).toBe(true);
    // 档位：editor / admin 看角色；executor（P5 之前没有执行者）普通用户一律不行
    const tier = eff === 'executor' ? false : role !== null && RANK[role] >= RANK[eff];
    // 配置类操作（改连接串、删环境、取消生产、改档位）另外至少要项目管理员：档位只收紧、不放宽
    const config = isEnvConfigAction(action as EnvAction);
    const want = tier && (!config || role === 'admin');
    expect(can(user, action, res(role, production, policy))).toBe(want);
  });

  test('执行者（P5a）：isExecutor 为真就能执行（执行者授权自带查看者可见性，不需要编辑者）', () => {
    const r = (role: Role | null, isExecutor: boolean): Resource => ({
      ...res(role, true, 'executor'),
      isExecutor,
    });
    const user: Actor = { kind: 'user', id: 'u', instanceAdmin: false };
    expect(can(user, 'environment.execute', r('editor', true))).toBe(true);
    // P5a 改了这一条：执行者不需要模型编辑权限（02-consensus 11.2 / 执行者不自动获得编辑权限）
    expect(can(user, 'environment.execute', r('viewer', true))).toBe(true);
    // 看不见项目（没有角色）一律不行
    expect(can(user, 'environment.execute', r(null, true))).toBe(false);
    expect(can(user, 'environment.execute', r('admin', false))).toBe(false);
    // 配置类操作仍然要项目管理员
    expect(can(user, 'environment.delete', r('editor', true))).toBe(false);
    expect(can(user, 'environment.delete', r('admin', true))).toBe(true);
  });

  test('模型的编辑和发布不受档位约束（项目动作按项目角色）', () => {
    for (const policy of POLICIES) {
      const r: Resource = { ...res('editor', true, policy), kind: 'project' };
      expect(can(user, 'version.publish', r)).toBe(true);
      expect(can(user, 'sync.edit', r)).toBe(true);
    }
  });

  test('不是环境资源时特权操作一律拒绝；系统身份不受限', () => {
    expect(can(user, 'environment.execute', { kind: 'project', role: 'admin' })).toBe(false);
    expect(can({ kind: 'system', id: null }, 'environment.execute', { kind: 'project' })).toBe(true);
  });
});

describe('接口：档位存在环境上，默认值、修改、特权操作', () => {
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  const cookies: Record<string, string> = {};
  let pid = '';
  const ids: Record<string, string> = {};

  const call = async (method: string, path: string, json?: unknown, who = 'admin') => {
    const headers: Record<string, string> = { cookie: cookies[who]! };
    if (json !== undefined) headers['content-type'] = 'application/json';
    const r = await created.app.request(path, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await r.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: r.status, data };
  };

  // P5a：档位存在执行策略的环境层（exec_policies），不再是 environments.exec_policy 列
  const addEnv = async (id: string, production: boolean, policy: ExecPolicy | null = null) => {
    await db.query(
      `insert into environments (id, project_id, name, url_enc, production)
       values ($1, $2, $1, $3, $4)`,
      [id, pid, encrypt('postgres://u:p@127.0.0.1:1/x'), production],
    );
    if (policy)
      await db.query(
        "insert into exec_policies (scope_kind, scope_id, policy) values ('environment', $1, $2::text::jsonb)",
        [id, JSON.stringify({ whoCanExecute: policy })],
      );
    return id;
  };
  const env = (id: string) => `/api/projects/${pid}/environments/${id}`;
  /** 能不能通过鉴权：执行接口带一个不存在的版本，通过鉴权是 404（版本不存在），不通过是 403 */
  const tryExecute = async (id: string, who: string, action = 'execute') =>
    (await call('POST', `${env(id)}/${action}`, { to: 'nope' }, who)).status;

  beforeAll(async () => {
    db = await openPlatformDb(':memory:');
    created = createApp(db, { loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }) });
    await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    const users: Record<string, string> = {};
    for (const n of ['pa', 'editor', 'viewer']) users[n] = (await makeUser(db, n, { name: n })).id;
    for (const n of ['admin', 'pa', 'editor', 'viewer']) {
      const r = await created.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: n, password: PASSWORD }),
      });
      cookies[n] = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    }
    const g = await call('POST', '/api/groups', { slug: 'g', name: '组' });
    const p = await call('POST', '/api/projects', { name: 'policy', groupId: g.data.id });
    pid = p.data.id as string;
    for (const [n, role] of [
      ['pa', 'admin'],
      ['editor', 'editor'],
      ['viewer', 'viewer'],
    ] as const)
      await call('POST', `/api/projects/${pid}/grants`, { subjectKind: 'user', subjectId: users[n], role });
    ids.dev = await addEnv('dev', false);
    ids.prod = await addEnv('prod', true);
  });
  afterAll(async () => {
    await created.rooms.flush();
    await created.shadows.close();
    await db.close();
  });

  test('默认值：非生产项目编辑者能执行，生产要项目管理员；查看者都不行', async () => {
    // 执行 / 回滚：带一个不存在的版本，通过鉴权是 404（版本不存在），没通过是 403
    for (const action of ['execute', 'rollback']) {
      expect(await tryExecute('dev', 'viewer', action), `${action} dev viewer`).toBe(403);
      expect(await tryExecute('dev', 'editor', action), `${action} dev editor`).toBe(404);
      expect(await tryExecute('dev', 'pa', action), `${action} dev pa`).toBe(404);
      expect(await tryExecute('prod', 'viewer', action), `${action} prod viewer`).toBe(403);
      expect(await tryExecute('prod', 'editor', action), `${action} prod editor`).toBe(403);
      expect(await tryExecute('prod', 'pa', action), `${action} prod pa`).toBe(404);
      expect(await tryExecute('prod', 'admin', action), `${action} prod admin`).toBe(404);
    }
    // 写基线（不带版本）：通过鉴权后，非生产环境直接开始（SSE，连不上目标库以 error 事件结束，HTTP 200）；
    // 生产环境先要求输入环境名确认（422）
    const baseline = async (id: string, who: string) =>
      (await call('POST', `${env(id)}/baseline`, {}, who)).status;
    expect(await baseline('dev', 'viewer')).toBe(403);
    expect(await baseline('dev', 'editor')).toBe(200);
    expect(await baseline('prod', 'editor')).toBe(403);
    expect(await baseline('prod', 'pa')).toBe(422);
    expect(await baseline('prod', 'admin')).toBe(422);

    const dev = (await call('GET', `${env('dev')}/status`, undefined, 'editor')).data as {
      permissions: unknown;
      effectiveExecPolicy: string;
    };
    expect(dev.effectiveExecPolicy).toBe('editor');
    expect(dev.permissions).toEqual({
      execute: true,
      configure: false,
      unmarkProduction: false,
      approvalRequired: false,
      request: true,
      emergency: false,
    });
    const prod = (await call('GET', `${env('prod')}/status`, undefined, 'editor')).data as {
      effectiveExecPolicy: string;
    };
    expect(prod.effectiveExecPolicy).toBe('admin');
  });

  test('改档位：存在环境上；档位改了，谁能执行跟着变', async () => {
    const e1 = await addEnv('e1', true);
    expect(await tryExecute(e1, 'editor')).toBe(403);
    // 编辑者改不了档位（配置类操作要项目管理员）
    expect((await call('PATCH', env(e1), { execPolicy: 'editor' }, 'editor')).status).toBe(403);
    // 项目管理员把生产环境放宽到编辑者
    const r = await call('PATCH', env(e1), { execPolicy: 'editor' }, 'pa');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ execPolicy: 'editor', effectiveExecPolicy: 'editor' });
    expect(await tryExecute(e1, 'editor')).toBe(404);
    const [row] = await db.query<{ policy: { whoCanExecute?: string } }>(
      "select policy from exec_policies where scope_kind = 'environment' and scope_id = $1",
      [e1],
    );
    expect(row!.policy.whoCanExecute).toBe('editor');
    // 改回默认（null）
    expect((await call('PATCH', env(e1), { execPolicy: null }, 'pa')).data).toMatchObject({
      execPolicy: null,
      effectiveExecPolicy: 'admin',
    });
    expect(await tryExecute(e1, 'editor')).toBe(403);
  });

  test('仅限执行者：P5 之前只有实例管理员能执行；项目管理员也不行，连改档位都不行', async () => {
    const e2 = await addEnv('e2', false, 'executor');
    expect(await tryExecute(e2, 'editor')).toBe(403);
    const denied = await call('POST', `${env(e2)}/execute`, { to: 'nope' }, 'pa');
    expect(denied.status).toBe(403);
    expect(denied.data.error).toContain('仅限执行者');
    expect(await tryExecute(e2, 'admin')).toBe(404); // 实例管理员通过鉴权
    expect((await call('PATCH', env(e2), { execPolicy: 'admin' }, 'pa')).status).toBe(403);
    expect((await call('PATCH', env(e2), { allowSameInstance: true }, 'pa')).status).toBe(403);
    expect((await call('DELETE', env(e2), undefined, 'pa')).status).toBe(403);
    // 实例管理员可以
    expect((await call('PATCH', env(e2), { execPolicy: 'admin' }, 'admin')).status).toBe(200);
    expect((await call('DELETE', env(e2), undefined, 'admin')).status).toBe(200);
  });

  test('改连接串 / 影子库设置、取消生产标记、删除环境：配置类，要项目管理员并满足档位', async () => {
    const e3 = await addEnv('e3', false); // 非生产：档位是编辑者，但配置类操作仍然要管理员
    for (const body of [{ allowSameInstance: true }, { production: true }]) {
      expect((await call('PATCH', env(e3), body, 'editor')).status).toBe(403);
    }
    expect((await call('PATCH', env(e3), {}, 'pa')).status).toBe(400); // 没有要改的
    expect((await call('PATCH', env(e3), { allowSameInstance: true }, 'pa')).status).toBe(200);
    expect((await call('DELETE', env(e3), undefined, 'editor')).status).toBe(403);
    expect((await call('DELETE', env(e3), undefined, 'viewer')).status).toBe(403);
    expect((await call('DELETE', env(e3), undefined, 'pa')).status).toBe(200);

    // 取消生产标记：没有显式设置过档位的环境，把当前生效的档位（项目管理员）固定下来，不会悄悄放宽成编辑者
    const e4 = await addEnv('e4', true);
    expect((await call('PATCH', env(e4), { production: false }, 'editor')).status).toBe(403);
    const r = await call('PATCH', env(e4), { production: false }, 'pa');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ production: false, execPolicy: 'admin', effectiveExecPolicy: 'admin' });
    expect(await tryExecute(e4, 'editor')).toBe(403);
    // 标成生产（收紧）项目管理员就能做
    const e5 = await addEnv('e5', false);
    expect((await call('PATCH', env(e5), { production: true }, 'pa')).status).toBe(200);
    // 档位为 executor 的生产环境：项目管理员不能取消生产标记
    const e6 = await addEnv('e6', true, 'executor');
    expect((await call('PATCH', env(e6), { production: false }, 'pa')).status).toBe(403);
    expect((await call('PATCH', env(e6), { production: false }, 'admin')).status).toBe(200);
  });

  test('模型的编辑和发布不受档位约束；环境列表给出每个人的权限', async () => {
    // 生产环境默认档位是项目管理员，但编辑者照样能发布版本（这里只验证没有被档位挡住：空工作副本是 422，不是 403）
    const r = await call('POST', `/api/projects/${pid}/versions`, { name: 'x' }, 'editor');
    expect(r.status).toBe(422);
    const envs = (await call('GET', `/api/projects/${pid}/environments`, undefined, 'editor'))
      .data as unknown as EnvInfo[];
    const prod = envs.find((e) => e.id === 'prod')!;
    expect(prod).toMatchObject({ production: true, execPolicy: null, effectiveExecPolicy: 'admin' });
    expect(prod.permissions).toEqual({
      execute: false,
      configure: false,
      unmarkProduction: false,
      approvalRequired: false,
      request: true,
      emergency: false,
    });
    expect(envs.find((e) => e.id === 'dev')!.permissions).toEqual({
      execute: true,
      configure: false,
      unmarkProduction: false,
      approvalRequired: false,
      request: true,
      emergency: false,
    });
    const asPa = (await call('GET', `/api/projects/${pid}/environments`, undefined, 'pa'))
      .data as unknown as EnvInfo[];
    expect(asPa.find((e) => e.id === 'prod')!.permissions).toEqual({
      execute: true,
      configure: true,
      unmarkProduction: true,
      approvalRequired: false,
      request: true,
      emergency: false,
    });
  });

  test('switch 接口同步受环境执行档位约束（含默认生产、放宽与仅限执行者）', async () => {
    expect(await tryExecute('dev', 'viewer', 'switch')).toBe(403);
    expect(await tryExecute('dev', 'editor', 'switch')).toBe(404);
    expect(await tryExecute('prod', 'editor', 'switch')).toBe(403);
    expect(await tryExecute('prod', 'pa', 'switch')).toBe(404);

    // 生产环境放宽到 editor 后，editor 可通过 switch 鉴权；收紧回默认后再次 403
    expect((await call('PATCH', env('prod'), { execPolicy: 'editor' }, 'pa')).status).toBe(200);
    expect(await tryExecute('prod', 'editor', 'switch')).toBe(404);
    expect((await call('PATCH', env('prod'), { execPolicy: null }, 'pa')).status).toBe(200);
    expect(await tryExecute('prod', 'editor', 'switch')).toBe(403);

    // 仅限执行者环境：项目管理员也 403，只有实例管理员通过 switch 鉴权
    const swExec = await addEnv('sw-exec', false, 'executor');
    expect(await tryExecute(swExec, 'editor', 'switch')).toBe(403);
    expect(await tryExecute(swExec, 'pa', 'switch')).toBe(403);
    expect(await tryExecute(swExec, 'admin', 'switch')).toBe(404);
  });
});
