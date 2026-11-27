// 测试辅助：公开注册接口已经删除（只接受邀请注册），测试里直接写库建用户，再走登录接口拿会话。
import {
  addColumn,
  all,
  createSchema,
  createTable,
  type Dialect,
  engineFullVersion,
  type Model,
} from '@dowel/core';

import type { PlatformDb } from '../src/db.ts';
import type { Rooms } from '../src/rooms.ts';
import type { Shadow } from '../src/shadow.ts';
import type { Shadows } from '../src/shadows.ts';
import { createUser, type NewUser } from '../src/users.ts';

export const PASSWORD = 'password1';

/** 直接在平台库里建一个用户；默认密码 PASSWORD、显示名与用户名相同 */
export const makeUser = (db: PlatformDb, username: string, options: Partial<NewUser> = {}) =>
  createUser(db, { username, name: username, password: PASSWORD, ...options });

/** 直接改项目的工作副本（替换房间里的模型，不走 WebSocket）；fn 就地修改传入的模型副本 */
export const editModel = async (
  rooms: Pick<Rooms, 'model' | 'replace'>,
  db: PlatformDb,
  pid: string,
  fn: (m: Model) => void,
) => {
  const [b] = await db.query<{ id: string }>(
    "select id from branches where project_id = $1 and name = 'main'",
    [pid],
  );
  const m = structuredClone((await rooms.model(b!.id)).model);
  fn(m);
  await rooms.replace(b!.id, 'test', m, 'seed');
};

/**
 * 给项目的工作副本加一张表。空的工作副本发布会得到 422“没有变更”，需要发布版本的测试先调用它。
 */
export const addTable = (
  rooms: Pick<Rooms, 'model' | 'replace'>,
  db: PlatformDb,
  pid: string,
  name = 'orders',
) =>
  editModel(rooms, db, pid, (m) => {
    const schema = all(m, 'schema').find((s) => s.name === 'public')?.id ?? createSchema(m, 'public');
    const t = createTable(m, schema, name);
    addColumn(m, t, { name: 'id', type: 'bigint', notNull: true });
  });

/**
 * 发布必须经影子库闭环验证（ADR 0017 决定 1）。不需要真实数据库、只是要一个已发布版本的测试，用它给外部影子库方言（PG 等）的项目
 * 装一个“总是通过”的影子库替身：返回的报告带 engineVersion（默认 '16.4'），并把这个版本当作项目唯一环境的数据库版本（覆盖判断用）。
 * 只影响 pids 里的项目（不给 = 全部）；返回还原函数。
 */
export const stubPassingShadow = (
  shadows: Shadows,
  options: { pids?: string[]; engineVersion?: string } = {},
): (() => void) => {
  const engineVersion = options.engineVersion ?? '16.4';
  const orig = shadows.forProjectEngineVersions.bind(shadows);
  const shadow: Shadow = {
    importSql: () => Promise.reject(new Error('stub shadow: importSql')),
    canonicalize: () => Promise.resolve([]),
    verify: () => Promise.reject(new Error('stub shadow: verify')),
    verifyScripts: (_from, _to, up, down) =>
      Promise.resolve({
        ok: true,
        up: up.map((s, i) => ({
          kind: 'frozen',
          target: `up#${i + 1}`,
          sql: s.sql,
          transactional: s.transactional,
        })),
        down: down.map((s, i) => ({
          kind: 'frozen',
          target: `down#${i + 1}`,
          sql: s.sql,
          transactional: s.transactional,
        })),
        upDiff: [],
        downDiff: [],
        risks: [],
        error: null,
        engineVersion,
      }),
    close: () => Promise.resolve(),
  };
  shadows.forProjectEngineVersions = async function (this: Shadows, pid: string) {
    if (options.pids && !options.pids.includes(pid)) return orig.call(this, pid);
    return {
      entries: [{ engineVersion, envId: '', shadow, label: 'stub shadow' }],
      skipped: [],
      environments: [{ id: 'stub-env', name: 'stub', engineVersion }],
      identical: false,
    };
  };
  return () => {
    shadows.forProjectEngineVersions = orig;
  };
};

/**
 * 直接写库得到的“已验证”版本（插入 verified_at、或 PATCH 之后再手工标已验证）没有验证记录：执行器按目标库的数据库完整版本号
 * 把关（ADR 0017 决定 5），会拒绝执行。按项目各环境当前的数据库完整版本号给这些版本补上通过的记录（并标为已验证）。
 */
export const recordVerifiedOnEnvs = async (db: PlatformDb, pid: string, versionIds: string[]) => {
  const [p] = await db.query<{ dialect: Dialect }>('select dialect from projects where id = $1', [pid]);
  const envs = await db.query<{ engine_version: string | null; engine_version_num: number | null }>(
    'select engine_version, engine_version_num from environments where project_id = $1',
    [pid],
  );
  const at = new Date().toISOString();
  const versions = [
    ...new Set(
      envs
        .map((e) =>
          engineFullVersion(p!.dialect, { version: e.engine_version, versionNum: e.engine_version_num }),
        )
        .filter((v): v is string => v !== null),
    ),
  ];
  const records = versions.map((engineVersion) => ({ engineVersion, ok: true, shadow: 'test', at }));
  for (const id of versionIds) {
    const [row] = await db.query<{ verifyReport: Record<string, unknown> | null }>(
      'select verify_report as "verifyReport" from versions where id = $1',
      [id],
    );
    const report = row?.verifyReport ?? {
      ok: true,
      upDiff: [],
      downDiff: [],
      risks: [],
      error: null,
      shadow: 'test',
      at,
    };
    await db.query('update versions set verified_at = $2, verify_report = $3::text::jsonb where id = $1', [
      id,
      at,
      JSON.stringify({ ...report, records }),
    ]);
  }
};
