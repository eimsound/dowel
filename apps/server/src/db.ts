// 平台自己的数据库（项目、成员、操作日志、版本……）。默认 SQLite（Node 内置的 node:sqlite），也可以用 PostgreSQL。
// 不用 ORM：表少、查询简单，原生 SQL 加一个小迁移器即可（2026-11-18 决定，见 02-consensus.md）。
//
// 业务代码里的 SQL 是 PG 写法的一个子集，SQLite 适配器负责抹平差异：
// - 参数占位符 $n → ?n；写 JSON 列时的 `$n::text::jsonb` 去掉类型转换（SQLite 里 JSON 列就是 text）；
// - 读出时按“表.列”把 JSON 列解析成对象、布尔列转成 true/false（与 PG 读出的结果一致）；
// - 写入时 Date → ISO 字符串、布尔 → 0/1（ISO 字符串可以直接比较大小）。
//
// JSON / 布尔列的识别规则：不能只看列名（不同表可能有同名列而类型不同）。SQLite 的
// StatementSync.columns() 会给出结果列来自哪张表、哪个原始列，适配器用“表.列”去
// COLUMN_KINDS 里查；新增表 / 列时在下面的表里登记（测试表也用 registerColumnKind 登记）。
// 旧的列名和 SQL 都不需要改。

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementColumnMetadata } from 'node:sqlite';

import { BASELINE_VERSION_NAME } from '@dowel/api';
import type { Model } from '@dowel/core';
import { newId } from '@dowel/core';
import { type Db, stepsChecksum } from '@dowel/engines';
import postgres from 'postgres';

import { emptyBase, type FrozenScripts, freezeBaseline, freezeScripts } from './chain.ts';
import { scrubSecrets } from './secrets.ts';
import { uniqueSlug, uniqueUsername } from './usernames.ts';

export type Dialect = 'sqlite' | 'pg';

/**
 * `in (…)` 列表的占位符：`inList(['a', 'b'])` → `$1, $2`；前面已经用了几个参数时给起始序号（`inList(ids, 3)` → `$3, $4, …`）。
 * 参数数组本身由调用方传（`[...前面的参数, ...ids]`）。**ids 不能为空**（`in ()` 不合法），调用方先判断。
 */
export const inList = (ids: readonly unknown[], startIndex = 1): string =>
  ids.map((_, i) => `$${startIndex + i}`).join(', ');

export interface AdvisoryLockOptions {
  /** 等待拿锁的超时时间（毫秒）；默认 0（不等待，等同 tryOnly） */
  timeoutMs?: number;
  /** 仅尝试一次，拿不到立刻返回 { acquired: false } */
  tryOnly?: boolean;
}

export type AdvisoryLockResult<T> = { acquired: true; value: T } | { acquired: false };

export interface OpenPlatformDbOptions {
  /** PG advisory lock 专用连接池最大连接数（默认 16，与主业务连接池隔离） */
  advisoryLockPoolMax?: number;
  /** PG 模式下启动迁移等待 `platform:migrate` advisory lock 的超时时间（毫秒，默认 60_000） */
  migrateLockTimeoutMs?: number;
  /** PG 连接池建连超时（秒，默认 10；作用于主池、锁池与 LISTEN 重连握手，不影响已建立的 LISTEN 长连接） */
  connectTimeoutSec?: number;
  /** PG 连接 TCP keep-alive 探测间隔（秒，默认 15；加速识别半开连接且不影响 LISTEN 长连接） */
  keepAliveSec?: number;
  /** 仅用于测试：替换 PG advisory lock 解锁执行逻辑，用于模拟解锁抛错或返回非 true 时销毁连接防锁泄漏 */
  advisoryUnlock?: (conn: postgres.ReservedSql, k1: number, k2: number) => Promise<boolean>;
}

export interface TransactionOptions {
  /** 事务隔离级别（PG 生效，SQLite 忽略；默认 read_committed） */
  isolationLevel?: 'read_committed' | 'repeatable_read';
  /** 只读快照事务（PG 加 READ ONLY；SQLite 用 BEGIN 避免抢写锁） */
  readOnly?: boolean;
}

export interface PlatformDb extends Db {
  dialect: Dialect;
  /** SQLite 平台库的物理文件路径（内存库或 PG 为 undefined），用于防止被配置为 SQLite 目标库 */
  readonly filePath?: string;
  transaction<T>(fn: (tx: Db) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** 订阅跨副本通知通道（PG 用 LISTEN，重连时触发 onReconnect；SQLite 为空操作） */
  listen(
    channel: string,
    onPayload: (payload: string) => void,
    onReconnect?: () => void,
  ): Promise<() => Promise<void>>;
  /** 发布跨副本通知（PG 用 NOTIFY 并做 < 7500 字节保护；SQLite 为空操作） */
  notify(channel: string, payload: string): Promise<void>;
  /** 获取跨副本会话级互斥锁（PG 用独占连接 + 双 32 位哈希 advisory lock；SQLite 用进程内互斥锁） */
  withAdvisoryLock<T>(
    key: string,
    fn: () => Promise<T>,
    options?: AdvisoryLockOptions,
  ): Promise<AdvisoryLockResult<T>>;
  close(): Promise<void>;
}

/** 方言相关的列类型 */
const types = (d: Dialect) =>
  d === 'pg'
    ? { ts: 'timestamptz', now: 'now()', json: 'jsonb', bool: 'boolean', t: 'true', f: 'false' }
    : {
        ts: 'text',
        now: "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        json: 'text',
        bool: 'integer',
        t: '1',
        f: '0',
      };

type ColumnKind = 'json' | 'bool';

/** SQLite 读出时需要转换的列，键是“表.列”（不是全局列名） */
const COLUMN_KINDS = new Map<string, ColumnKind>([
  ['branches.layout', 'json'],
  ['branches.sections', 'json'],
  ['branches.baseline', 'json'],
  ['room_commits.op_args', 'json'],
  ['room_commits.changes', 'json'],
  ['room_snapshots.model', 'json'],
  ['room_snapshots.versions', 'json'],
  ['versions.model', 'json'],
  ['versions.up_steps', 'json'],
  ['versions.down_steps', 'json'],
  ['versions.verify_report', 'json'],
  ['versions.scope', 'json'],
  ['versions.edited', 'bool'],
  ['environments.production', 'bool'],
  ['environments.allow_same_instance', 'bool'],
  ['environments.drift_summary', 'json'],
  ['audit_events.data', 'json'],
  ['invites.group_ids', 'json'],
  ['instance_settings.value', 'json'],
  ['oidc_providers.enabled', 'bool'],
  ['oidc_providers.auto_provision', 'bool'],
  ['projects.schemas', 'json'],
  ['exec_policies.policy', 'json'],
  ['grants.by_instance_admin', 'bool'],
  ['exec_requests.migrations', 'json'],
  ['exec_requests.dry_run', 'json'],
  ['exec_requests.flow', 'json'],
  ['exec_requests.production', 'bool'],
  ['exec_requests.emergency', 'bool'],
  ['exec_requests.result', 'json'],
  ['inbox_items.data', 'json'],
  ['webhooks.events', 'json'],
  ['webhooks.enabled', 'bool'],
  ['webhook_deliveries.ok', 'bool'],
  ['webhook_deliveries.test', 'bool'],
  ['webhook_jobs.payload', 'json'],
  ['token_policies.rule', 'json'],
  ['users.must_change_password', 'bool'],
]);

/** 登记新增表 / 列的转换规则（测试里也用这个造同名列不同表） */
export const registerColumnKind = (table: string, column: string, kind: ColumnKind) => {
  COLUMN_KINDS.set(`${table}.${column}`, kind);
};

/**
 * 唯一约束冲突（用户名重复）：两种方言抛出的错误形状不同，统一在这里识别，
 * 路由据此返回 409 而不是 500。
 * - PG（postgres.js）：`code = '23505'`（unique_violation）；
 * - SQLite（node:sqlite）：`errcode = 2067`（SQLITE_CONSTRAINT_UNIQUE），message 形如
 *   `UNIQUE constraint failed: users.username`；主键冲突是 1555。
 */
export const isUniqueViolation = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown; cause?: unknown };
  if (e.code === '23505' || e.errcode === 2067 || e.errcode === 1555) return true;
  if (typeof e.message === 'string' && e.message.includes('UNIQUE constraint failed')) return true;
  // 有的客户端会把底层错误包一层
  return e.cause === undefined ? false : isUniqueViolation(e.cause);
};

/** 外键冲突（PG 23503；SQLite errcode 787 / “FOREIGN KEY constraint failed”）：删除被引用的行时转成 409 */
export const isForeignKeyViolation = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown; cause?: unknown };
  if (e.code === '23503' || e.errcode === 787) return true;
  if (typeof e.message === 'string' && e.message.includes('FOREIGN KEY constraint failed')) return true;
  return e.cause === undefined ? false : isForeignKeyViolation(e.cause);
};

/**
 * 一条迁移：SQL 和 / 或一段用参数化 SQL 的数据迁移，在同一个事务里执行。
 * 早期迁移只写了 SQL（直接写函数），新增迁移用 sqlMigration() 包一层。
 */
interface Migration {
  sql?: (d: Dialect) => string;
  /** 数据迁移：与 DDL 在同一个事务里，需要逐行算值时用（例如由邮箱生成用户名） */
  run?: (tx: Db, d: Dialect) => Promise<void>;
  /**
   * SQLite 上需要“重建表”（改 NOT NULL / UNIQUE 等约束只能这么做）。
   * 迁移器会在事务外临时关闭外键，见 migrate() 的注释。
   */
  sqliteRebuild?: boolean;
}

type MigrationStep = ((d: Dialect) => string) | Migration;

const sqlMigration = (sql: (d: Dialect) => string): Migration => ({ sql });

/** 旧数据里的用户：迁移时用它生成用户名 */
interface OldUserRow {
  id: string;
  email: string | null;
  name: string;
  password_hash: string | null;
  created_at: string;
}

/**
 * 数据迁移：用户名由邮箱 @ 前面那一段生成，重名时加 -2、-3……；
 * 按创建时间排第一的用户升为实例管理员。
 */
const planUsers = (rows: OldUserRow[]): { username: string; role: 'admin' | 'member' }[] => {
  const taken = new Set<string>();
  return rows.map((row, i) => {
    const username = uniqueUsername(row.email?.split('@')[0] ?? row.name, taken);
    taken.add(username);
    return { username, role: i === 0 ? 'admin' : 'member' };
  });
};

/**
 * 审计日志新增 project_id 时回填旧记录：项目事件直接用 target_id，版本事件查 versions，
 * 环境事件优先查 environments（行还在时），否则用 data.projectId（环境删除后仍然能归类）。
 * 导出给测试用。
 */
export const backfillAuditProjectIds = async (tx: Db, d: Dialect) => {
  const fromData = d === 'pg' ? "data->>'projectId'" : "json_extract(data, '$.projectId')";
  await tx.exec(
    `update audit_events set project_id = target_id
      where project_id is null and target_kind = 'project' and target_id is not null`,
  );
  await tx.exec(
    `update audit_events set project_id =
       (select v.project_id from versions v where v.id = audit_events.target_id)
     where project_id is null and target_kind = 'version'`,
  );
  await tx.exec(
    `update audit_events set project_id = coalesce(
       (select e.project_id from environments e where e.id = audit_events.target_id),
       ${fromData})
     where project_id is null and target_kind = 'environment'`,
  );
  await tx.exec(
    `update audit_events set project_id = ${fromData}
      where project_id is null and ${fromData} is not null`,
  );
};

/**
 * 版本链回填（P4a）：给升级前已有的版本补上 number、parent_id 和冻结脚本。
 * - 每个项目的版本按 created_at 排序（同一时刻再按 seq、id，保证结果确定）；
 * - 第一个版本如果是向导生成的 v0 基线（名字是 BASELINE_VERSION_NAME 且 seq 为 0），number 为 0，
 *   脚本是在空库上建库；否则第一个版本是 v1，parent 为空，从空库迁移（目标模型有 public 才放 public）；
 * - 之后每个版本的脚本由相邻两个版本的模型重新生成（plan），checksum 重新计算；
 * - scope 记下冻结时项目的 schema 范围（JSON 数组，null 表示全部）：第一个版本的 from 是“范围内的空库”，
 *   重新验证要用冻结时的范围，不能用项目当前的（范围可以改）。旧版本回填成项目行当前的范围——
 *   下面冻结脚本时用的就是它。P4a 还没有发布过，所以这一列直接并进链迁移，没有单独的迁移；
 * - verified_at 一律留空：升级时不在影子库里跑验证，需要时在界面上“重新验证”；
 * - 规划器对某个旧模型报错时：脚本留空、number / parent 照常补上，错误原因写进 verify_report，
 *   界面显示为未验证，执行器也不会放行。
 * 导出给测试用。
 */
export const backfillVersionChain = async (tx: Db, _d?: Dialect) => {
  const projects = await tx.query<{ project_id: string }>(
    'select distinct project_id from versions order by project_id',
  );
  for (const { project_id } of projects) {
    // 空库模型要看项目的 schema 范围（null 表示全部）
    const [proj] = await tx.query<{ schemas: string[] | null }>(
      'select schemas from projects where id = $1',
      [project_id],
    );
    const scope = proj?.schemas?.length ? proj.schemas : null;
    const rows = await tx.query<{ id: string; seq: number; name: string; model: Model }>(
      'select id, seq, name, model from versions where project_id = $1 order by created_at, seq, id',
      [project_id],
    );
    let prev: { id: string; number: number; model: Model } | null = null;
    for (const [i, v] of rows.entries()) {
      const baseline = i === 0 && v.seq === 0 && v.name === BASELINE_VERSION_NAME;
      const number: number = prev ? prev.number + 1 : baseline ? 0 : 1;
      let frozen: FrozenScripts;
      let report: unknown = null;
      try {
        frozen = baseline
          ? freezeBaseline(v.model, scope)
          : freezeScripts(prev ? prev.model : emptyBase(v.model, scope), v.model);
      } catch (e) {
        frozen = { up: [], down: [], checksum: stepsChecksum([], []) };
        report = {
          ok: false,
          upDiff: [],
          downDiff: [],
          risks: [],
          error: {
            step: null,
            message: `升级时无法生成迁移脚本：${scrubSecrets(e instanceof Error ? e.message : String(e))}`,
          },
          shadow: '',
          at: new Date().toISOString(),
        };
      }
      await tx.query(
        `update versions set number = $2, parent_id = $3, up_steps = $4::text::jsonb, down_steps = $5::text::jsonb,
                checksum = $6, verified_at = null, verify_report = $7::text::jsonb, scope = $8::text::jsonb
          where id = $1`,
        [
          v.id,
          number,
          prev?.id ?? null,
          JSON.stringify(frozen.up),
          JSON.stringify(frozen.down),
          frozen.checksum,
          report ? JSON.stringify(report) : null,
          scope ? JSON.stringify(scope) : null,
        ],
      );
      prev = { id: v.id, number, model: v.model };
    }
  }
};

/** 迁移列表。导出给迁移测试用：测试先按旧版本建库、造旧数据，再走升级。 */
export const MIGRATIONS: MigrationStep[] = [
  (d) => {
    const { ts, now, json } = types(d);
    return `create table users (
     id text primary key,
     email text not null unique,
     name text not null,
     password_hash text not null,
     created_at ${ts} not null default ${now}
   );
   create table sessions (
     token_hash text primary key,
     user_id text not null references users on delete cascade,
     expires_at ${ts} not null
   );
   create table projects (
     id text primary key,
     name text not null,
     dialect text not null default 'pg',
     created_by text references users on delete set null,
     created_at ${ts} not null default ${now}
   );
   create table project_members (
     project_id text not null references projects on delete cascade,
     user_id text not null references users on delete cascade,
     role text not null check (role in ('owner', 'editor', 'viewer')),
     primary key (project_id, user_id)
   );
   create table branches (
     id text primary key,
     project_id text not null references projects on delete cascade,
     name text not null,
     layout ${json} not null default '{}',
     created_at ${ts} not null default ${now},
     unique (project_id, name)
   );
   create table room_commits (
     branch_id text not null references branches on delete cascade,
     seq bigint not null,
     client text not null,
     n int not null,
     user_name text not null,
     op_name text,
     op_args ${json},
     changes ${json} not null,
     created_at ${ts} not null default ${now},
     primary key (branch_id, seq)
   );
   create table room_snapshots (
     branch_id text not null references branches on delete cascade,
     seq bigint not null,
     model ${json} not null,
     versions ${json} not null,
     primary key (branch_id, seq)
   );
   create table room_rejections (
     branch_id text not null references branches on delete cascade,
     client text not null,
     n int not null,
     code text not null,
     message text not null,
     primary key (branch_id, client, n)
   );
   create table versions (
     id text primary key,
     project_id text not null references projects on delete cascade,
     branch_id text not null references branches on delete cascade,
     seq bigint not null,
     name text not null,
     model ${json} not null,
     created_by text references users on delete set null,
     created_at ${ts} not null default ${now}
   );`;
  },
  // 环境：项目要部署到的数据库实例（连接信息加密存储）
  (d) => {
    const { ts, now, bool, t, f } = types(d);
    return `create table environments (
     id text primary key,
     project_id text not null references projects on delete cascade,
     name text not null,
     url_enc text not null,
     production ${bool} not null default ${t},
     allow_same_instance ${bool} not null default ${f},
     shadow_url_enc text,
     created_at ${ts} not null default ${now},
     unique (project_id, name)
   );`;
  },
  // 派生数据的基线：最近一份已规范化（表达式、不透明对象 DDL 与引擎一致）的模型
  (d) => `alter table branches add column baseline ${types(d).json};`,
  // 审计日志：谁、什么时候、从哪里、对什么对象做了什么
  (d) => {
    const { ts, now, json } = types(d);
    return `create table audit_events (
     id text primary key,
     at ${ts} not null default ${now},
     actor_kind text not null check (actor_kind in ('user', 'token', 'system')),
     actor_id text,
     action text not null,
     target_kind text,
     target_id text,
     ip text,
     data ${json}
   );
   create index audit_events_at on audit_events (at);`;
  },
  // 账户：用户名 + 密码登录，角色 / 状态 / last_login_at；邮箱改成选填、不唯一、不验证；密码可空（以后的 OIDC 用户）。
  // SQLite 改不了 NOT NULL / UNIQUE，只能重建 users 表；sessions 也一起重建（新增 id、时间与客户端信息，旧会话不保留）。
  {
    sqliteRebuild: true,
    run: async (tx, d) => {
      const { ts, now } = types(d);
      const rows = await tx.query<OldUserRow>(
        'select id, email, name, password_hash, created_at from users order by created_at, id',
      );
      const plan = planUsers(rows);
      if (d === 'sqlite') {
        await tx.exec(`create table users_new (
     id text primary key,
     username text not null,
     email text,
     name text not null,
     password_hash text,
     role text not null default 'member' check (role in ('admin', 'member')),
     status text not null default 'active' check (status in ('active', 'disabled')),
     last_login_at ${ts},
     created_at ${ts} not null default ${now}
   )`);
        for (const [i, row] of rows.entries()) {
          await tx.query(
            `insert into users_new (id, username, email, name, password_hash, role, status, created_at)
             values ($1, $2, $3, $4, $5, $6, 'active', $7)`,
            [
              row.id,
              plan[i]!.username,
              row.email,
              row.name,
              row.password_hash,
              plan[i]!.role,
              row.created_at,
            ],
          );
        }
        // 官方推荐的顺序：删旧表 → 把新表改成旧名字（legacy_alter_table 保证不改写其他表的外键）
        await tx.exec('drop table users; alter table users_new rename to users;');
      } else {
        await tx.exec(`alter table users add column username text;
     alter table users add column role text not null default 'member' check (role in ('admin', 'member'));
     alter table users add column status text not null default 'active' check (status in ('active', 'disabled'));
     alter table users add column last_login_at ${ts};
     alter table users alter column email drop not null;
     alter table users alter column password_hash drop not null;
     alter table users drop constraint if exists users_email_key;`);
        for (const [i, row] of rows.entries())
          await tx.query('update users set username = $2, role = $3 where id = $1', [
            row.id,
            plan[i]!.username,
            plan[i]!.role,
          ]);
        await tx.exec('alter table users alter column username set not null;');
      }
      await tx.exec('create unique index users_username_key on users (username);');
      await tx.exec(`drop table sessions;
   create table sessions (
     id text primary key,
     token_hash text not null unique,
     user_id text not null references users on delete cascade,
     expires_at ${ts} not null,
     created_at ${ts} not null default ${now},
     last_seen_at ${ts} not null default ${now},
     user_agent text,
     ip text
   );`);
    },
  },
  // 邀请与重置密码：公用一张表（kind 区分），令牌只存哈希；group_ids 留给 P1b。
  sqlMigration((d) => {
    const { ts, now, json } = types(d);
    return `create table invites (
     id text primary key,
     kind text not null check (kind in ('invite', 'reset')),
     token_hash text not null unique,
     user_id text references users on delete cascade,
     created_by text references users on delete set null,
     group_ids ${json} not null default '[]',
     created_at ${ts} not null default ${now},
     expires_at ${ts} not null,
     used_by text references users on delete set null,
     used_at ${ts},
     revoked_at ${ts}
   );`;
  }),
  // 实例设置：键值表，value 是 JSON（字符串、布尔都一样存）
  sqlMigration((d) => {
    const { json } = types(d);
    return `create table instance_settings (
     key text primary key,
     value ${json} not null
   );`;
  }),
  // 产品化 P1b：组、授权、项目的组归属与 slug（02-consensus.md 11.2）。
  // SQLite 改不了 NOT NULL，projects 要重建；旧数据迁移要求升级后每个人的生效权限与升级前完全一致：
  // - 每个项目按 created_by 归属，每个创建者一个组（slug / 名字都是用户名），组的 default_role 是 none；
  // - 创建者只有在旧 project_members 里是他**名下所有**项目的 owner 时才设为组管理员，否则只是组成员；
  //   他在各项目上的权限完全由迁移过来的授权决定（被降级 / 移出项目的人在升级后也一样）；
  // - created_by 为空的项目归到 default 组，组管理员只取 status = active 的实例管理员；
  // - 项目 slug 由项目名清洗生成，组内冲突时加后缀；
  // - project_members 变成 scope=project 的授权（owner → admin），然后删掉旧表。
  {
    sqliteRebuild: true,
    sql: (d) => {
      const { ts, now } = types(d);
      const defaultRole = `check (default_role in ('none', 'viewer', 'editor', 'admin'))`;
      const shared = `create table groups (
     id text primary key,
     slug text not null unique,
     name text not null,
     description text not null default '',
     default_role text not null default 'editor' ${defaultRole},
     project_creation text not null default 'members' check (project_creation in ('members', 'admins')),
     created_at ${ts} not null default ${now}
   );
   create table group_members (
     group_id text not null references groups on delete cascade,
     user_id text not null references users on delete cascade,
     role text not null default 'member' check (role in ('admin', 'member')),
     created_at ${ts} not null default ${now},
     primary key (group_id, user_id)
   );
   create table grants (
     id text primary key,
     subject_kind text not null check (subject_kind in ('user', 'group')),
     subject_id text not null,
     role text not null check (role in ('viewer', 'editor', 'admin')),
     scope_kind text not null check (scope_kind in ('instance', 'group', 'project', 'environment')),
     scope_id text not null,
     created_by text references users on delete set null,
     created_at ${ts} not null default ${now},
     unique (subject_kind, subject_id, scope_kind, scope_id)
   );
   create table project_redirects (
     owner_slug text not null,
     project_slug text not null,
     project_id text not null references projects on delete cascade,
     created_at ${ts} not null default ${now},
     primary key (owner_slug, project_slug)
   );`;
      // 新 projects 的列；SQLite 走重建，PG 先加可空列，填完数据再收紧
      const columns = `group_id text not null references groups,
     slug text not null,
     default_role text ${defaultRole}`;
      return (
        shared +
        (d === 'sqlite'
          ? `create table projects_new (
     id text primary key,
     name text not null,
     dialect text not null default 'pg',
     created_by text references users on delete set null,
     ${columns},
     created_at ${ts} not null default ${now},
     unique (group_id, slug)
   );`
          : `alter table projects add column group_id text;
   alter table projects add column slug text;
   alter table projects add column default_role text ${defaultRole};`)
      );
    },
    run: async (tx, d) => {
      const projects = await tx.query<{
        id: string;
        name: string;
        dialect: string;
        created_by: string | null;
        created_at: string;
      }>('select id, name, dialect, created_by, created_at from projects order by created_at, id');
      const users = new Map(
        (await tx.query<{ id: string; username: string }>('select id, username from users')).map((u) => [
          u.id,
          u,
        ]),
      );
      // default 组的组管理员只取还启用的实例管理员
      const admins = (
        await tx.query<{ id: string }>(
          "select id from users where role = 'admin' and status = 'active' order by created_at, id",
        )
      ).map((a) => a.id);
      // 旧的成员关系只读一次：既用来判断“创建者是不是所有项目的 owner”，也用来生成授权
      const memberships = await tx.query<{ project_id: string; user_id: string; role: string }>(
        'select project_id, user_id, role from project_members',
      );
      const owners = new Map<string, Set<string>>();
      for (const m of memberships) {
        if (m.role !== 'owner') continue;
        if (!owners.has(m.project_id)) owners.set(m.project_id, new Set());
        owners.get(m.project_id)!.add(m.user_id);
      }

      // 按归属分组，保持项目出现的顺序（测试里结果稳定）
      const plans = new Map<string, { ownerId: string | null; projects: typeof projects }>();
      for (const p of projects) {
        const ownerId = p.created_by && users.has(p.created_by) ? p.created_by : null;
        const key = ownerId ?? '';
        if (!plans.has(key)) plans.set(key, { ownerId, projects: [] });
        plans.get(key)!.projects.push(p);
      }

      const groupSlugs = new Set<string>();
      for (const { ownerId, projects: own } of plans.values()) {
        const owner = ownerId ? users.get(ownerId) : null;
        const groupId = newId();
        const slug = uniqueSlug(owner?.username ?? 'default', groupSlugs, 'default');
        groupSlugs.add(slug);
        // 组的默认权限是 none：升级不额外提权，权限只来自迁移过来的授权
        await tx.query("insert into groups (id, slug, name, default_role) values ($1, $2, $3, 'none')", [
          groupId,
          slug,
          owner?.username ?? 'default',
        ]);

        // 创建者：在所有自己名下的项目里都是 owner 时才是组管理员，否则只是组成员
        if (!owner) {
          for (const userId of admins)
            await tx.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'admin')", [
              groupId,
              userId,
            ]);
        } else {
          const ownsAll = own.every((p) => owners.get(p.id)?.has(owner.id));
          await tx.query('insert into group_members (group_id, user_id, role) values ($1, $2, $3)', [
            groupId,
            owner.id,
            ownsAll ? 'admin' : 'member',
          ]);
        }

        const projectSlugs = new Set<string>();
        for (const p of own) {
          const pslug = uniqueSlug(p.name, projectSlugs, 'project');
          projectSlugs.add(pslug);
          if (d === 'sqlite')
            await tx.query(
              `insert into projects_new (id, name, dialect, created_by, group_id, slug, created_at)
               values ($1, $2, $3, $4, $5, $6, $7)`,
              [p.id, p.name, p.dialect, p.created_by, groupId, pslug, p.created_at],
            );
          else
            await tx.query('update projects set group_id = $2, slug = $3 where id = $1', [
              p.id,
              groupId,
              pslug,
            ]);
        }
      }

      if (d === 'sqlite')
        // 同 users 的重建：删旧表 → 新表改名（legacy_alter_table 保证不改写其他表里的外键）
        await tx.exec('drop table projects; alter table projects_new rename to projects;');
      else
        await tx.exec(`alter table projects alter column group_id set not null;
   alter table projects alter column slug set not null;
   alter table projects add constraint projects_group_id_fkey foreign key (group_id) references groups;
   create unique index projects_group_slug_key on projects (group_id, slug);`);

      // 旧的成员关系变成项目级授权（owner 即项目管理员）：这是升级后各项目权限的唯一来源
      for (const m of memberships)
        await tx.query(
          `insert into grants (id, subject_kind, subject_id, role, scope_kind, scope_id)
           values ($1, 'user', $2, $3, 'project', $4)`,
          [newId(), m.user_id, m.role === 'owner' ? 'admin' : m.role, m.project_id],
        );
      await tx.exec('drop table project_members;');
    },
  },
  // 产品化 P1c：通用 OIDC（A7）。提供方的 client_secret 用 secrets.ts 加密存储（依赖 DOWEL_SECRET）；
  // 身份按（提供方 + subject）唯一，绝不按邮箱自动关联。短时登录状态也放在平台库里，10 分钟过期。
  sqlMigration((d) => {
    const { ts, now } = types(d);
    return `create table oidc_providers (
     id text primary key,
     slug text not null unique,
     name text not null,
     issuer text not null,
     client_id text not null,
     client_secret_enc text not null,
     scopes text not null default 'openid profile email',
     enabled ${types(d).bool} not null default ${types(d).t},
     auto_provision ${types(d).bool} not null default ${types(d).f},
     created_at ${ts} not null default ${now},
     updated_at ${ts} not null default ${now}
   );
   create table user_identities (
     provider_id text not null references oidc_providers on delete cascade,
     subject text not null,
     user_id text not null references users on delete cascade,
     created_at ${ts} not null default ${now},
     last_login_at ${ts} not null default ${now},
     primary key (provider_id, subject),
     unique (provider_id, user_id)
   );
   create table oidc_states (
     token_hash text primary key,
     provider_id text not null references oidc_providers on delete cascade,
     state text not null,
     nonce text not null,
     code_verifier text not null,
     mode text not null check (mode in ('login', 'link')),
     user_id text references users on delete cascade,
     invite_token text,
     next text,
     expires_at ${ts} not null,
     created_at ${ts} not null default ${now}
   );
   create index oidc_states_expires on oidc_states (expires_at);
   create table oidc_pending (
     token_hash text primary key,
     provider_id text not null references oidc_providers on delete cascade,
     subject text not null,
     username text not null,
     name text not null,
     email text,
     invite_token text,
     expires_at ${ts} not null,
     created_at ${ts} not null default ${now}
   );
   create index oidc_pending_expires on oidc_pending (expires_at);`;
  }),
  // P2：项目动态按 project_id 过滤。可空列 + (project_id, at) 索引，旧记录用 target / data.projectId 回填。
  {
    sql: () => `alter table audit_events add column project_id text;
   create index audit_events_project_at on audit_events (project_id, at);`,
    run: backfillAuditProjectIds,
  },
  // 产品化 P3：项目的 schema 范围（JSON 数组，可空表示全部）。导入、从环境拉取、规范化只读这些 schema，
  // `dowel` 永远跳过（引擎层写死，见 packages/engines/src/pg/snapshot.ts 的 userNs）。
  sqlMigration((d) => `alter table projects add column schemas ${types(d).json};`),
  // 产品化 P4a：版本 = 冻结迁移（ADR 0002）。number 是版本在链上的序号（v0 基线为 0，之后 1、2…），
  // 和房间操作序号 seq 不是一回事；parent_id 指向上一个版本；up / down_steps 是 [{ sql, transactional }]；
  // checksum 是两份步骤规范化 JSON 的 sha256；verified_at / verify_report 是影子库闭环验证的结果；
  // edited 表示脚本被人工改过。旧列全部是可空的（SQLite 加列不能带非空约束），回填后每一行都有值。
  {
    sql: (d) => {
      const { ts, json, bool, f } = types(d);
      return `alter table versions add column number int;
   alter table versions add column parent_id text;
   alter table versions add column up_steps ${json};
   alter table versions add column down_steps ${json};
   alter table versions add column checksum text;
   alter table versions add column verified_at ${ts};
   alter table versions add column verify_report ${json};
   alter table versions add column edited ${bool} not null default ${f};
   alter table versions add column scope ${json};
   create unique index versions_project_number on versions (project_id, number);`;
    },
    run: backfillVersionChain,
  },
  // 产品化 P4a：实例唯一标识，首次启动（升级）时生成，之后不变；写进目标库历史，标明是哪个实例执行的
  {
    run: async (tx) => {
      await tx.query(
        'insert into instance_settings (key, value) values ($1, $2::text::jsonb) on conflict (key) do nothing',
        ['instance_id', JSON.stringify(randomUUID())],
      );
    },
  },
  // 产品化 P4b：环境上的执行状态缓存（读目标库的结果；目标库里的 dowel 历史才是事实来源）和“谁能执行”档位。
  // - exec_policy：editor / admin / executor，null = 用默认（非生产 editor，生产 admin）；
  // - current_version_id：环境当前版本（最近一次执行 / 读历史的结果），null = 目标库里还没有这个项目的历史；
  // - last_drift_check / drift_status / drift_summary：漂移检测的结果（手动检查和定时检查都写这里）；
  // - environment_versions：这个环境上执行过哪些版本。编辑冻结脚本前据此判断“这个版本是否在任一环境执行过”，
  //   不用每次都连目标库（versionExecutedAnywhere）。执行前登记，所以执行到一半失败的版本也算。
  {
    sql: (d) => {
      const { ts, json, now } = types(d);
      return `alter table environments add column exec_policy text;
   alter table environments add column current_version_id text;
   alter table environments add column last_drift_check ${ts};
   alter table environments add column drift_status text not null default 'unknown';
   alter table environments add column drift_summary ${json};
   create table environment_versions (
     environment_id text not null references environments on delete cascade,
     version_id text not null references versions on delete cascade,
     first_executed_at ${ts} not null default ${now},
     primary key (environment_id, version_id)
   );
   create index environment_versions_version on environment_versions (version_id);`;
    },
  },
  // 产品化 P4b 审查后：“这个版本执行过”是永久的事实，记在版本自己身上（executed_at，第一次确认执行时写入，只写一次、永不清除），
  // 不再靠会被同步删掉、会随环境一起级联删除的 environment_versions（那张表只留作“这个环境上执行过哪些版本”和执行前的登记）。
  // 旧数据：环境上登记过的版本都算执行过（保守：宁可多冻结）。
  {
    sql: (d) => `alter table versions add column executed_at ${types(d).ts};`,
    run: async (tx) => {
      await tx.exec(
        `update versions set executed_at = (select min(ev.first_executed_at) from environment_versions ev where ev.version_id = versions.id)
          where exists (select 1 from environment_versions ev where ev.version_id = versions.id)`,
      );
    },
  },
  // 产品化 P4b 第二轮审查：重新划分两张表的职责。`versions.executed_at` 是唯一的永久事实；
  // environment_versions 是“目标库历史的镜像 + 进行中的登记”：state = claimed（执行开始前登记，还没确认）/ confirmed（目标库历史里有）。
  // 旧行都是已回填进 executed_at 的，按 confirmed 处理；之后在目标库项目锁里的同步会把它对齐到目标库历史。
  () => `alter table environment_versions add column state text not null default 'confirmed';`,
  // 产品化 P4c：接手时从目标库历史恢复出来的版本记下恢复时间（null = 在本实例发布的）。恢复的版本一律未验证
  (d) => `alter table versions add column restored_at ${types(d).ts};`,
  // 产品化 P5a：执行策略四层（实例 → 组 → 项目 → 环境）、执行者授权、前置环境（ADR 0005）。
  // - exec_policies：每个范围一行，policy 是 JSON。实例 / 组 / 项目层是 { production, nonProduction }，环境层是它自己的那一套；
  //   字段不出现 = 继承。实例层的 scope_id 是空串（和 grants 一致）。范围是多态的，没有外键：删组 / 项目 / 环境时手动清理；
  // - 原来 environments.exec_policy（H6 的档位）搬进环境层的 whoCanExecute，然后删掉这一列（只留一个事实来源）；
  // - environments.prerequisite_id：前置环境（同项目的另一个环境）。不加外键：删除被引用的环境时由接口拒绝（409）；
  // - grants：role 加 executor；同一个对象在同一个范围上可以同时有一个项目角色和一个执行者授权，所以唯一约束改成
  //   (对象, 范围, 是不是执行者)；by_instance_admin 记下授权时授予者是不是实例管理员（“仅限执行者”的生产环境只认这种）。
  //   SQLite 改不了 CHECK / UNIQUE，重建 grants；PG 原地改约束。
  {
    sqliteRebuild: true,
    sql: (d) => {
      const { ts, now, json, bool, f } = types(d);
      const common = `create table if not exists exec_policies (
     scope_kind text not null check (scope_kind in ('instance', 'group', 'project', 'environment')),
     scope_id text not null,
     policy ${json} not null,
     updated_by text references users on delete set null,
     updated_at ${ts} not null default ${now},
     primary key (scope_kind, scope_id)
   );
   alter table environments add column prerequisite_id text;`;
      const index = `create unique index if not exists grants_subject_scope
     on grants (subject_kind, subject_id, scope_kind, scope_id, (role = 'executor'));`;
      if (d === 'sqlite')
        return `${common}
   create table grants_new (
     id text primary key,
     subject_kind text not null check (subject_kind in ('user', 'group')),
     subject_id text not null,
     role text not null check (role in ('viewer', 'editor', 'admin', 'executor')),
     scope_kind text not null check (scope_kind in ('instance', 'group', 'project', 'environment')),
     scope_id text not null,
     created_by text references users on delete set null,
     created_at ${ts} not null default ${now},
     by_instance_admin ${bool} not null default ${f}
   );
   insert into grants_new (id, subject_kind, subject_id, role, scope_kind, scope_id, created_by, created_at)
     select id, subject_kind, subject_id, role, scope_kind, scope_id, created_by, created_at from grants;
   drop table grants;
   alter table grants_new rename to grants;
   ${index}`;
      // PG：自动生成的约束名不保证（截断规则），按定义找出 grants 上的唯一约束和 role 的 CHECK 再删
      return `${common}
   alter table grants add column if not exists by_instance_admin ${bool} not null default ${f};
   do $$
   declare r record;
   begin
     for r in select conname from pg_constraint
               where conrelid = 'grants'::regclass
                 and (contype = 'u' or (contype = 'c' and pg_get_constraintdef(oid) like '%(role %'))
     loop
       execute format('alter table grants drop constraint %I', r.conname);
     end loop;
   end $$;
   alter table grants add constraint grants_role_check check (role in ('viewer', 'editor', 'admin', 'executor'));
   ${index}`;
    },
    run: async (tx) => {
      const rows = await tx.query<{ id: string; exec_policy: string }>(
        'select id, exec_policy from environments where exec_policy is not null',
      );
      for (const r of rows)
        if (r.exec_policy === 'editor' || r.exec_policy === 'admin' || r.exec_policy === 'executor')
          await tx.query(
            "insert into exec_policies (scope_kind, scope_id, policy) values ('environment', $1, $2::text::jsonb)",
            [r.id, JSON.stringify({ whoCanExecute: r.exec_policy })],
          );
      await tx.exec('alter table environments drop column exec_policy');
    },
  },
  // 产品化 P5a 审查后：前置环境不能悬空（悬空时执行一律拒绝，见 checkPrerequisite；这里从数据库层面杜绝）。
  // - PG：同表自引用外键（默认 NO ACTION，语句结束时检查：删整个项目的环境的那一条 delete 不受影响）；
  // - SQLite：不能给已有列加约束（只能重建整张 environments 表），而且带外键 / 触发器的列以后也不能 drop；
  //   用两个触发器实现同样的约束：删除被引用的环境、或者把前置环境设成不存在的环境，都 abort。删项目时先清掉前置环境再删环境。
  // 已有的悬空值（只可能来自 P5a 第一版里删除和设置并发的窗口，开发期数据）清成 null 才能建约束。
  {
    run: async (tx, d) => {
      await tx.exec(
        `update environments set prerequisite_id = null
          where prerequisite_id is not null
            and not exists (select 1 from environments p where p.id = environments.prerequisite_id)`,
      );
      if (d === 'pg') {
        await tx.exec(
          `alter table environments add constraint environments_prerequisite_fk
             foreign key (prerequisite_id) references environments (id)`,
        );
        return;
      }
      await tx.exec(`create trigger environments_prerequisite_delete before delete on environments
         when exists (select 1 from environments e where e.prerequisite_id = old.id and e.id <> old.id)
         begin select raise(abort, 'FOREIGN KEY constraint failed: environments.prerequisite_id'); end;
       create trigger environments_prerequisite_insert before insert on environments
         when new.prerequisite_id is not null
          and not exists (select 1 from environments e where e.id = new.prerequisite_id)
         begin select raise(abort, 'FOREIGN KEY constraint failed: environments.prerequisite_id'); end;
       create trigger environments_prerequisite_update before update of prerequisite_id on environments
         when new.prerequisite_id is not null
          and not exists (select 1 from environments e where e.id = new.prerequisite_id)
         begin select raise(abort, 'FOREIGN KEY constraint failed: environments.prerequisite_id'); end;`);
    },
  },
  // 产品化 P5b：执行申请与审批、收件箱、组级 Webhook（ADR 0006、0007）。
  // - exec_requests：一次执行申请。绑定“起止版本 + 各迁移校验和”（migrations 是快照：版本、方向、校验和、步数），
  //   flow 是提交时生效审批流程的快照（审批按快照走，审批人资格按审批时的成员关系判断），conn_hash 是提交时连接设置的指纹
  //   （DOWEL_SECRET 派生密钥的 HMAC，不是普通哈希——连接串里有密码，见 requests.ts 的 connHash）；
  //   status：pending → approved → executing → executed / failed；rejected / withdrawn / invalid / expired 是终态。
  //   stage 是当前环节（0 起；全部通过后等于环节数）。环境 / 项目删除时级联删除（审计里有完整记录）；
  // - exec_approvals：每个环节每个人的一次决定（通过 / 驳回 + 意见），同一个人在同一个环节只能决定一次；
  // - inbox_items：站内收件箱（待我审批、我的申请结果、紧急执行、P6 的令牌执行），data 是显示用的快照；
  // - webhooks / webhook_deliveries：组级 Webhook 与最近的投递记录（URL 和签名密钥用 DOWEL_SECRET 加密）。
  (d) => {
    const { ts, now, json, bool, t, f } = types(d);
    return `create table exec_requests (
     id text primary key,
     project_id text not null references projects on delete cascade,
     environment_id text not null references environments on delete cascade,
     requested_by text references users on delete set null,
     direction text not null check (direction in ('up', 'down')),
     from_version_id text,
     to_version_id text not null,
     migrations ${json} not null,
     dry_run ${json},
     reason text not null default '',
     flow ${json} not null,
     conn_hash text not null,
     production ${bool} not null,
     status text not null check (status in
       ('pending', 'approved', 'executing', 'executed', 'failed', 'rejected', 'withdrawn', 'invalid', 'expired')),
     stage integer not null default 0,
     status_reason text,
     expires_at ${ts} not null,
     created_at ${ts} not null default ${now},
     updated_at ${ts} not null default ${now},
     executed_by text references users on delete set null,
     executed_at ${ts},
     emergency ${bool} not null default ${f},
     result ${json}
   );
   create index exec_requests_env on exec_requests (environment_id, status);
   create index exec_requests_status on exec_requests (status);
   create table exec_approvals (
     id text primary key,
     request_id text not null references exec_requests on delete cascade,
     stage integer not null,
     user_id text references users on delete set null,
     decision text not null check (decision in ('approve', 'reject')),
     comment text not null default '',
     at ${ts} not null default ${now},
     unique (request_id, stage, user_id)
   );
   create table inbox_items (
     id text primary key,
     user_id text not null references users on delete cascade,
     kind text not null check (kind in
       ('approval_needed', 'request_result', 'emergency_execution', 'token_execution')),
     project_id text references projects on delete cascade,
     environment_id text references environments on delete cascade,
     request_id text references exec_requests on delete cascade,
     data ${json} not null,
     created_at ${ts} not null default ${now},
     read_at ${ts}
   );
   create index inbox_items_user on inbox_items (user_id, created_at);
   create table webhooks (
     id text primary key,
     group_id text not null references groups on delete cascade,
     name text not null,
     format text not null check (format in ('json', 'dingtalk', 'feishu', 'wecom', 'slack')),
     url_enc text not null,
     secret_enc text,
     events ${json} not null,
     enabled ${bool} not null default ${t},
     created_by text references users on delete set null,
     created_at ${ts} not null default ${now},
     updated_at ${ts} not null default ${now}
   );
   create index webhooks_group on webhooks (group_id);
   create table webhook_deliveries (
     id text primary key,
     webhook_id text not null references webhooks on delete cascade,
     delivery_id text not null,
     event text not null,
     attempt integer not null,
     ok ${bool} not null,
     status integer,
     error text,
     duration_ms integer,
     test ${bool} not null default ${f},
     at ${ts} not null default ${now}
   );
   create index webhook_deliveries_hook on webhook_deliveries (webhook_id, at);`;
  },
  // P6：CI 令牌与“谁能创建令牌”的三层规则（ADR 0009 / 0010）。
  // - ci_tokens：属于项目（创建者离职 / 停用不影响令牌），只存明文的 SHA-256（token_hash 唯一，按它查找）；
  //   prefix 是明文的前 12 个字符（dwl_ + 8 位），只用来在列表里辨认；吊销写 revoked_at / revoked_by（行保留，列表和审计看得到）；
  //   last_used_at / last_used_ip 最多 60 秒写一次。项目删除时级联删除（项目删除的事务里也显式删）；
  // - token_policies：实例 / 组 / 项目每个范围一行（实例层 scope_id 为空串），rule 是 { roles, groups }；不设置 = 没有这一行。
  (d) => {
    const { ts, now, json } = types(d);
    return `create table ci_tokens (
     id text primary key,
     project_id text not null references projects on delete cascade,
     name text not null,
     description text not null default '',
     prefix text not null,
     token_hash text not null unique,
     created_by text references users on delete set null,
     created_at ${ts} not null default ${now},
     expires_at ${ts} not null,
     revoked_at ${ts},
     revoked_by text references users on delete set null,
     last_used_at ${ts},
     last_used_ip text
   );
   create index ci_tokens_project on ci_tokens (project_id);
   create table token_policies (
     scope_kind text not null check (scope_kind in ('instance', 'group', 'project')),
     scope_id text not null,
     rule ${json} not null,
     updated_by text references users on delete set null,
     updated_at ${ts} not null default ${now},
     primary key (scope_kind, scope_id)
   );`;
  },
  // P6.5：移除「前置环境」功能（2026-11-21 修订，ADR 0005）：删除 environments.prerequisite_id 列及对应约束 / 触发器。
  {
    run: async (tx, d) => {
      if (d === 'pg') {
        await tx.exec(
          `alter table environments drop constraint if exists environments_prerequisite_fk;
           alter table environments drop column if exists prerequisite_id;`,
        );
        return;
      }
      await tx.exec(
        `drop trigger if exists environments_prerequisite_delete;
         drop trigger if exists environments_prerequisite_insert;
         drop trigger if exists environments_prerequisite_update;
         alter table environments drop column prerequisite_id;`,
      );
    },
  },
  // P7 HA（ADR 0011）：纯平台 PG 多活底座。
  // - webhook_jobs：持久化 Webhook 投递与重试队列（HA3，FOR UPDATE SKIP LOCKED）；
  // - ha_leases：副本活跃心跳（key = 'node:<replicaId>'）与分布式任务租约（key = 'job:<name>'）；
  // - exec_requests.worker_id：记录正在执行该申请的副本 ID，用于按副本存活状态恢复真正中断的 executing 申请。
  (d) => {
    const { ts, now, json } = types(d);
    return `create table webhook_jobs (
     id text primary key,
     webhook_id text not null references webhooks on delete cascade,
     delivery_id text not null,
     event_type text not null,
     payload ${json} not null,
     attempts int not null default 0,
     max_retries int not null default 3,
     next_run_at ${ts} not null default ${now},
     locked_by text,
     locked_until ${ts},
     created_at ${ts} not null default ${now}
   );
   create index webhook_jobs_due_idx on webhook_jobs (next_run_at);
   create table ha_leases (
     key text primary key,
     owner text not null,
     expires_at ${ts} not null,
     updated_at ${ts} not null default ${now}
   );
   alter table exec_requests add column worker_id text;`;
  },
  // P7 审查（#40）：为 room_rejections 增加单调递增游标列 id 与 (branch_id, id) 索引，
  // 消除 catchUpFrom 每次全表扫描该分支全部历史拒绝记录；同时保持 (branch_id, client, n) 唯一约束与重复写入语义不变。
  {
    sqliteRebuild: true,
    run: async (tx, d) => {
      if (d === 'pg') {
        await tx.exec(`alter table room_rejections add column if not exists id bigint generated by default as identity;
   create index if not exists room_rejections_branch_id_idx on room_rejections (branch_id, id);`);
        return;
      }
      const cols = await tx.query<{ name: string }>('pragma table_info(room_rejections)');
      if (!cols.some((c) => c.name === 'id')) {
        await tx.exec(`create table room_rejections_new (
     id integer primary key autoincrement,
     branch_id text not null references branches on delete cascade,
     client text not null,
     n int not null,
     code text not null,
     message text not null,
     unique (branch_id, client, n)
   );
   insert into room_rejections_new (branch_id, client, n, code, message)
     select branch_id, client, n, code, message from room_rejections order by rowid;
   drop table room_rejections;
   alter table room_rejections_new rename to room_rejections;`);
      }
      await tx.exec(
        'create index if not exists room_rejections_branch_id_idx on room_rejections (branch_id, id);',
      );
    },
  },
  // PG 多版本支持：按环境持久化目标库 PostgreSQL 版本串（如 "16.4"）与 server_version_num（如 160004）
  {
    run: async (tx, d) => {
      if (d === 'pg') {
        await tx.exec(`alter table environments add column if not exists engine_version text;
   alter table environments add column if not exists engine_version_num integer;`);
        return;
      }
      const cols = await tx.query<{ name: string }>('pragma table_info(environments)');
      if (!cols.some((c) => c.name === 'engine_version')) {
        await tx.exec('alter table environments add column engine_version text;');
      }
      if (!cols.some((c) => c.name === 'engine_version_num')) {
        await tx.exec('alter table environments add column engine_version_num integer;');
      }
    },
  },
  // Q17 Phase 1：画布板块（Section）纯布局层持久化（绝不进入 IR / 版本快照）
  {
    run: async (tx, d) => {
      const { json } = types(d);
      if (d === 'pg') {
        await tx.exec(
          `alter table branches add column if not exists sections ${json} not null default '[]';`,
        );
        return;
      }
      const cols = await tx.query<{ name: string }>('pragma table_info(branches)');
      if (!cols.some((c) => c.name === 'sections')) {
        await tx.exec(`alter table branches add column sections ${json} not null default '[]';`);
      }
    },
  },
  // 持久化房间级 layout / sections Lamport 逻辑时钟，防止冷启动或空闲卸载重载副本时钟归零导致首批 LWW 更新被热副本静默丢弃
  {
    run: async (tx, d) => {
      if (d === 'pg') {
        await tx.exec(
          `alter table branches add column if not exists layout_ver bigint not null default 0;
           alter table branches add column if not exists sections_ver bigint not null default 0;`,
        );
        return;
      }
      const cols = await tx.query<{ name: string }>('pragma table_info(branches)');
      if (!cols.some((c) => c.name === 'layout_ver')) {
        await tx.exec('alter table branches add column layout_ver integer not null default 0;');
      }
      if (!cols.some((c) => c.name === 'sections_ver')) {
        await tx.exec('alter table branches add column sections_ver integer not null default 0;');
      }
    },
  },
  // 废除 /setup + setup_token：新增 users.must_change_password（首次启动临时密码或管理员创建/重置密码后强制改密），
  // 并清理历史遗留的 instance_settings('setup_token')。
  {
    run: async (tx, d) => {
      if (d === 'pg') {
        await tx.exec(
          'alter table users add column if not exists must_change_password boolean not null default false;',
        );
      } else {
        const cols = await tx.query<{ name: string }>('pragma table_info(users)');
        if (!cols.some((c) => c.name === 'must_change_password')) {
          await tx.exec('alter table users add column must_change_password integer not null default 0;');
        }
      }
      await tx.query('delete from instance_settings where key = $1', ['setup_token']);
    },
  },
];

/** PG 启动迁移使用的跨副本 advisory lock 键 */
export const MIGRATE_LOCK_KEY = 'platform:migrate';
/** PG 启动迁移等待锁的默认超时时间（毫秒） */
export const DEFAULT_MIGRATE_LOCK_TIMEOUT_MS = 60_000;

const runMigrations = async (db: PlatformDb) => {
  const { ts, now } = types(db.dialect);
  await db.exec(
    `create table if not exists dowel_migrations (version int primary key, applied_at ${ts} not null default ${now})`,
  );
  const [row] = await db.query<{ v: number | null }>('select max(version) as v from dowel_migrations');
  const done = row?.v ?? 0;
  for (let i = done; i < MIGRATIONS.length; i++) {
    const step = MIGRATIONS[i]!;
    const m: Migration = typeof step === 'function' ? { sql: step } : step;
    // SQLite 改不了 NOT NULL / UNIQUE 等约束，要用“建新表 → 拷数据 → 删旧表 → 改名”重建。
    // 官方步骤要求：事务外关掉 foreign_keys（事务里这个 PRAGMA 不生效），重建完检查外键再打开。
    // legacy_alter_table 让 RENAME 不去改写其他表里指向 users 的外键（它们本来就是对的）。
    const rebuild = db.dialect === 'sqlite' && m.sqliteRebuild === true;
    if (rebuild) await db.exec('pragma foreign_keys = off; pragma legacy_alter_table = on');
    try {
      await db.transaction(async (tx) => {
        if (m.sql) await tx.exec(m.sql(db.dialect));
        await m.run?.(tx, db.dialect);
        if (rebuild) {
          // 重建后引用必须仍然完整；有问题就把整个迁移回滚
          const broken = await tx.query<Record<string, unknown>>('pragma foreign_key_check');
          if (broken.length) throw new Error(`迁移 ${i + 1} 后外键不一致：${JSON.stringify(broken[0])}`);
        }
        await tx.query('insert into dowel_migrations (version) values ($1)', [i + 1]);
      });
    } finally {
      if (rebuild) await db.exec('pragma legacy_alter_table = off; pragma foreign_keys = on');
    }
  }
};

const migrate = async (db: PlatformDb, options?: OpenPlatformDbOptions) => {
  if (db.dialect !== 'pg') {
    await runMigrations(db);
    return;
  }
  const rawTimeout = options?.migrateLockTimeoutMs ?? DEFAULT_MIGRATE_LOCK_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.max(0, rawTimeout) : DEFAULT_MIGRATE_LOCK_TIMEOUT_MS;
  const res = await db.withAdvisoryLock(MIGRATE_LOCK_KEY, () => runMigrations(db), { timeoutMs });
  if (!res.acquired) {
    throw new Error(`等待平台库迁移锁（${MIGRATE_LOCK_KEY}）超时（${timeoutMs}ms），未能完成数据库迁移`);
  }
};

/** PG NOTIFY 单条消息硬上限为 8000 字节；留出余量防超限报错 */
const MAX_NOTIFY_BYTES = 7500;
/** PG advisory lock 轮询等待间隔（毫秒） */
const ADVISORY_POLL_MS = 50;
/** PG advisory lock 专用连接池默认上限（独立于主业务池，避免并发持锁占满业务连接引发自死锁） */
export const DEFAULT_ADVISORY_LOCK_POOL_MAX = 16;
/** PG 连接池默认建连超时（秒）；收紧 postgres.js 默认 30s，避免网络黑洞/半开握手长时间挂起 */
export const DEFAULT_PG_CONNECT_TIMEOUT_SEC = 10;
/** PG 连接默认 TCP keep-alive 间隔（秒）；收紧 postgres.js 默认 60s，加快探测半开连接且不断开 LISTEN 长连接 */
export const DEFAULT_PG_KEEP_ALIVE_SEC = 15;
/** PG advisory lock 专用连接空闲回收时间（秒） */
const ADVISORY_LOCK_IDLE_TIMEOUT_SEC = 30;
/** 解锁失败后强制销毁/终止连接时的上限等待时间（毫秒） */
const ADVISORY_DESTROY_TIMEOUT_MS = 2_000;

/** 把字符串锁键映射为双 32 位有符号整数，供 pg_try_advisory_lock(int4, int4) 使用（兼容所有 PG 版本且与 1-arg 项目锁空间隔离） */
const advisoryKeyPair = (key: string): [number, number] => {
  const h = createHash('sha256').update(`dowel:lock:${key}`).digest();
  return [h.readInt32BE(0), h.readInt32BE(4)];
};

/** 按 UTF-8 字节长度安全截断字符串，不劈开多字节字符 */
const truncateUtf8 = (str: string, maxBytes: number): string => {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const isClosedConnError = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return (
    code === 'CONNECTION_CLOSED' ||
    code === 'CONNECTION_DESTROYED' ||
    code === 'CONNECTION_ENDED' ||
    code === '57P01'
  );
};

/** 在 ms 毫秒内等待 promise 完成；超时后吞掉原 promise 迟到产生的 rejection，避免未处理异常 */
const raceWithTimeout = <T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) {
      promise.then(
        () => {},
        () => {},
      );
      resolve({ timedOut: true });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });

const openPg = (url: string, options?: OpenPlatformDbOptions): PlatformDb => {
  const rawConnectTimeout = options?.connectTimeoutSec ?? DEFAULT_PG_CONNECT_TIMEOUT_SEC;
  const connectTimeoutSec =
    Number.isFinite(rawConnectTimeout) && rawConnectTimeout > 0
      ? rawConnectTimeout
      : DEFAULT_PG_CONNECT_TIMEOUT_SEC;
  const rawKeepAlive = options?.keepAliveSec ?? DEFAULT_PG_KEEP_ALIVE_SEC;
  const keepAliveSec =
    Number.isFinite(rawKeepAlive) && rawKeepAlive > 0 ? rawKeepAlive : DEFAULT_PG_KEEP_ALIVE_SEC;

  // bigint（seq）读成 number，与 SQLite 一致；序号不会超过 2^53。
  // 配置 connect_timeout 与 keep_alive（单位均为秒）：收紧半开连接与建连黑洞探测；
  // postgres@4.1.1 的 sql.listen 内部连接会覆盖 query_timeout=0、idle_timeout=null、max_lifetime=null，
  // 仅继承建连超时与 TCP keep-alive，不会误断开 LISTEN 长连接。
  const sql = postgres(url, {
    connect_timeout: connectTimeoutSec,
    keep_alive: keepAliveSec,
    onnotice: () => {},
    types: {
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
  });
  const lockPoolMax = Math.max(1, Math.floor(options?.advisoryLockPoolMax ?? DEFAULT_ADVISORY_LOCK_POOL_MAX));
  const advisoryUnlock = options?.advisoryUnlock;
  // advisory lock 使用独立专用连接池（按需创建），彻底与主业务查询池/心跳续租池隔离
  let lockSql: postgres.Sql | null = null;
  let closing = false;
  let activeLockSlots = 0;
  type SlotWaiter = { grant: () => void; abort: (err: Error) => void };
  const slotWaiters: SlotWaiter[] = [];

  const getLockSql = () => {
    if (!lockSql) {
      lockSql = postgres(url, {
        max: lockPoolMax,
        connect_timeout: connectTimeoutSec,
        keep_alive: keepAliveSec,
        idle_timeout: ADVISORY_LOCK_IDLE_TIMEOUT_SEC,
        onnotice: () => {},
        fetch_types: false,
      });
    }
    return lockSql;
  };

  const releaseLockSlot = () => {
    const next = slotWaiters.shift();
    if (next) {
      next.grant();
      return;
    }
    activeLockSlots = Math.max(0, activeLockSlots - 1);
  };

  const acquireLockSlot = async (deadline: number, tryOnly: boolean): Promise<boolean> => {
    if (closing) throw new Error('PG 平台库连接池已关闭');
    if (activeLockSlots < lockPoolMax) {
      activeLockSlots++;
      return true;
    }
    if (tryOnly) return false;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const waiter: SlotWaiter = {
        grant: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        },
        abort: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = slotWaiters.indexOf(waiter);
        if (idx !== -1) slotWaiters.splice(idx, 1);
        resolve(false);
      }, left);
      timer.unref?.();
      slotWaiters.push(waiter);
    });
  };

  const reserveLockConn = async (
    deadline: number,
    tryOnly: boolean,
    hasTimeout: boolean,
  ): Promise<postgres.ReservedSql | null> => {
    const gotSlot = await acquireLockSlot(deadline, tryOnly);
    if (!gotSlot) return null;

    if (hasTimeout && deadline - Date.now() <= 0) {
      releaseLockSlot();
      return null;
    }

    let reservePromise: Promise<postgres.ReservedSql>;
    try {
      reservePromise = getLockSql().reserve();
    } catch (e) {
      releaseLockSlot();
      throw e;
    }

    if (!hasTimeout) {
      try {
        return await reservePromise;
      } catch (e) {
        releaseLockSlot();
        throw e;
      }
    }

    const left = deadline - Date.now();
    try {
      const raced = await raceWithTimeout(reservePromise, left);
      if (raced.timedOut) {
        // 防止迟到拿到的 reserved 连接泄漏；等该次 reserve 真正落定后再归还槽位，避免并发数突破 lockPoolMax
        reservePromise.then(
          (lateConn) => {
            lateConn.release();
            releaseLockSlot();
          },
          () => {
            releaseLockSlot();
          },
        );
        return null;
      }
      return raced.value;
    } catch (e) {
      releaseLockSlot();
      throw e;
    }
  };

  /**
   * 销毁异常/未确认解锁的 reserved 连接，防止携带会话级 advisory lock 的空闲连接被放回池中复用。
   * postgres@4.1.1 的 reserved.release() 在连接处于非空闲事务状态（c.status !== 'I'）时会调用 c.close() 关闭底层连接；
   * 先发 BEGIN 置为事务态，再通过主池 pg_terminate_backend 强杀并等待后端退出，最后 release() 彻底淘汰该连接。
   */
  const destroyReserved = async (
    reserved: postgres.ReservedSql,
    backendPid: number | null,
    alreadyClosed: boolean,
  ): Promise<void> => {
    try {
      if (!alreadyClosed) {
        let closedByBegin = false;
        try {
          await raceWithTimeout(reserved.unsafe('begin'), ADVISORY_DESTROY_TIMEOUT_MS);
        } catch (e) {
          if (isClosedConnError(e)) closedByBegin = true;
        }

        if (!closedByBegin && backendPid !== null) {
          try {
            await raceWithTimeout(
              sql.unsafe('select pg_terminate_backend($1::int, $2::bigint)', [
                backendPid,
                ADVISORY_DESTROY_TIMEOUT_MS,
              ]),
              ADVISORY_DESTROY_TIMEOUT_MS + 500,
            );
          } catch (e) {
            // 兼容 PG < 14（无 2 参数重载 pg_terminate_backend(int, bigint)）
            const code = (e as { code?: unknown } | null)?.code;
            if (code === '42883') {
              await raceWithTimeout(
                sql.unsafe('select pg_terminate_backend($1::int)', [backendPid]),
                ADVISORY_DESTROY_TIMEOUT_MS,
              ).catch(() => {});
            }
          }
        }
      }
    } finally {
      reserved.release();
    }
  };

  const wrap = (s: postgres.Sql | postgres.TransactionSql): Db => ({
    query: async <T>(q: string, params?: unknown[]) =>
      (await s.unsafe(q, params as never[])) as unknown as T[],
    exec: async (q: string) => {
      await s.unsafe(q);
    },
  });
  return {
    dialect: 'pg',
    ...wrap(sql),
    transaction: (fn, txOptions) => {
      const parts: string[] = [];
      if (txOptions?.isolationLevel === 'repeatable_read') {
        parts.push('isolation level repeatable read');
      } else if (txOptions?.isolationLevel === 'read_committed') {
        parts.push('isolation level read committed');
      }
      if (txOptions?.readOnly) {
        parts.push('read only');
      }
      const mode = parts.length ? `transaction ${parts.join(' ')}` : '';
      return (mode ? sql.begin(mode, (tx) => fn(wrap(tx))) : sql.begin((tx) => fn(wrap(tx)))) as never;
    },
    listen: async (channel, onPayload, onReconnect) => {
      // postgres.js 的第 3 参数回调在首次 LISTEN 成功与后续断线重连后都会触发；跳过首次，仅在真正重连时通知上层
      let ready = false;
      const handle = await sql.listen(
        channel,
        (payload) => {
          try {
            onPayload(payload);
          } catch (e) {
            console.error(`PG LISTEN 回调失败（${channel}）`, e);
          }
        },
        () => {
          if (!ready) {
            ready = true;
            return;
          }
          try {
            onReconnect?.();
          } catch (e) {
            console.error(`PG LISTEN 重连回调失败（${channel}）`, e);
          }
        },
      );
      return async () => {
        await handle.unlisten();
      };
    },
    notify: async (channel, payload) => {
      let safe = payload;
      const bytes = Buffer.byteLength(payload, 'utf8');
      if (bytes > MAX_NOTIFY_BYTES) {
        console.warn(
          `PG NOTIFY 负载超过 ${MAX_NOTIFY_BYTES} 字节上限（channel=${channel}, bytes=${bytes}），已截断`,
        );
        safe = truncateUtf8(payload, MAX_NOTIFY_BYTES);
      }
      await sql.notify(channel, safe);
    },
    withAdvisoryLock: async <T>(
      key: string,
      fn: () => Promise<T>,
      lockOptions?: AdvisoryLockOptions,
    ): Promise<AdvisoryLockResult<T>> => {
      const [k1, k2] = advisoryKeyPair(key);
      const tryOnly = lockOptions?.tryOnly === true;
      const timeoutMs = tryOnly ? 0 : Math.max(0, lockOptions?.timeoutMs ?? 0);
      const hasTimeout = !tryOnly && timeoutMs > 0;
      const deadline = Date.now() + timeoutMs;
      let reserved: postgres.ReservedSql | null = null;
      let backendPid: number | null = null;
      for (;;) {
        // 每次尝试从独立锁池独占一条连接；拿不到锁立即归还连接与槽位后再 sleep，避免等锁占用锁池容量
        const conn = await reserveLockConn(deadline, tryOnly, hasTimeout);
        if (!conn) return { acquired: false };
        let acquired = false;
        try {
          const rows = await conn.unsafe<{ ok: boolean; pid: number }[]>(
            'select pg_try_advisory_lock($1::int, $2::int) as ok, pg_backend_pid() as pid',
            [k1, k2],
          );
          acquired = rows[0]?.ok === true;
          backendPid = typeof rows[0]?.pid === 'number' ? rows[0].pid : null;
        } catch (e) {
          await destroyReserved(conn, null, isClosedConnError(e));
          releaseLockSlot();
          throw e;
        }
        if (acquired) {
          reserved = conn;
          break;
        }
        conn.release();
        releaseLockSlot();
        if (tryOnly) return { acquired: false };
        const left = deadline - Date.now();
        if (left <= 0) return { acquired: false };
        await sleep(Math.min(ADVISORY_POLL_MS, left));
      }
      try {
        const value = await fn();
        return { acquired: true, value };
      } finally {
        let unlocked = false;
        let unlockClosedConn = false;
        try {
          if (advisoryUnlock) {
            unlocked = (await advisoryUnlock(reserved, k1, k2)) === true;
          } else {
            const rows = await reserved.unsafe<{ ok: boolean }[]>(
              'select pg_advisory_unlock($1::int, $2::int) as ok',
              [k1, k2],
            );
            unlocked = rows[0]?.ok === true;
          }
          if (!unlocked) {
            console.error(`释放 PG advisory lock 返回非 true（${key}），将销毁连接以防会话级锁泄漏`);
          }
        } catch (e) {
          unlockClosedConn = isClosedConnError(e);
          console.error(`释放 PG advisory lock 失败（${key}），将销毁连接以防会话级锁泄漏`, e);
        }
        if (unlocked) {
          reserved.release();
        } else {
          await destroyReserved(reserved, backendPid, unlockClosedConn);
        }
        releaseLockSlot();
      }
    },
    close: async () => {
      closing = true;
      const err = new Error('PG 平台库连接池已关闭');
      for (const w of slotWaiters.splice(0)) w.abort(err);
      const results = await Promise.allSettled([sql.end(), lockSql ? lockSql.end() : Promise.resolve()]);
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (rejected) throw rejected.reason;
    },
  };
};

const toSqlite = (q: string) => q.replaceAll('::text::jsonb', '').replace(/\$(\d+)/g, '?$1');

const toParam = (v: unknown): SQLInputValue => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v as SQLInputValue;
};

/** 根据结果列的来源表解析每一列要做什么转换（一次查询只算一次） */
const resultKinds = (columns: StatementColumnMetadata[]) =>
  columns.map((c) => ({
    key: c.name,
    kind: c.table && c.column ? COLUMN_KINDS.get(`${c.table}.${c.column}`) : undefined,
  }));

const fromRow = (
  row: Record<string, unknown>,
  kinds: ReturnType<typeof resultKinds>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const { key, kind } of kinds) {
    const v = row[key];
    out[key] =
      kind === 'json' && typeof v === 'string'
        ? JSON.parse(v)
        : kind === 'bool' && typeof v === 'number'
          ? v !== 0
          : v;
  }
  return out;
};

const openSqlite = (path: string): PlatformDb => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const conn = new DatabaseSync(path);
  try {
    conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  } catch (e) {
    try {
      conn.close();
    } catch {}
    throw e;
  }
  const raw: Db = {
    query: async <T>(q: string, params: unknown[] = []) => {
      const stmt = conn.prepare(toSqlite(q));
      const kinds = resultKinds(stmt.columns());
      return stmt.all(...params.map(toParam)).map((r) => fromRow(r as Record<string, unknown>, kinds)) as T[];
    },
    exec: async (q: string) => {
      conn.exec(toSqlite(q));
    },
  };
  // 同一个连接：所有操作排成一队，事务回调里还有 await 时别的语句 / 事务不能插进来。
  // 用 promise 链当互斥锁：先同步占住自己那一段（tail 赋值），再等上一段结束。
  // 不能写成“await 检查 busy 再设置 busy”——两次 await 之间两个事务会同时拿到锁，
  // 第二个 BEGIN IMMEDIATE 会报 “cannot start a transaction within a transaction”。
  // 因此 SQLite 上的事务天然串行，最后一个管理员保护之类的“先查再改”不需要 `for update`
  // （SQLite 也不支持）；PG 那边靠 `select … for update`。
  let tail: Promise<void> = Promise.resolve();
  const exclusive = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const prev = tail;
    tail = prev.then(() => mine);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
  const advisoryLocks = new Map<string, Promise<void>>();
  return {
    dialect: 'sqlite',
    ...(path !== ':memory:' ? { filePath: resolvePath(path) } : {}),
    query: (q, params) => exclusive(() => raw.query(q, params)),
    exec: (q) => exclusive(() => raw.exec(q)),
    transaction: (fn, txOptions) =>
      exclusive(async () => {
        conn.exec(txOptions?.readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
        try {
          const r = await fn(raw);
          conn.exec('COMMIT');
          return r;
        } catch (e) {
          conn.exec('ROLLBACK');
          throw e;
        }
      }),
    listen: async () => async () => {},
    notify: async () => {},
    withAdvisoryLock: async <T>(
      key: string,
      fn: () => Promise<T>,
      options?: AdvisoryLockOptions,
    ): Promise<AdvisoryLockResult<T>> => {
      const tryOnly = options?.tryOnly === true;
      const timeoutMs = tryOnly ? 0 : Math.max(0, options?.timeoutMs ?? 0);
      const deadline = Date.now() + timeoutMs;
      while (advisoryLocks.has(key)) {
        if (tryOnly) return { acquired: false };
        const left = deadline - Date.now();
        if (left <= 0) return { acquired: false };
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          advisoryLocks.get(key)!,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, left);
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
      }
      let release!: () => void;
      advisoryLocks.set(
        key,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      try {
        const value = await fn();
        return { acquired: true, value };
      } finally {
        advisoryLocks.delete(key);
        release();
      }
    },
    close: () => exclusive(() => conn.close()),
  };
};

/**
 * url：`postgres://…` / `postgresql://…` 连接 PostgreSQL；`:memory:` 为内存中的 SQLite（重启即丢失）；
 * 其他值视为 SQLite 数据库文件的路径（目录不存在时自动创建）。
 */
export const openPlatformDb = async (url: string, options?: OpenPlatformDbOptions): Promise<PlatformDb> => {
  const db = /^postgres(ql)?:\/\//.test(url) ? openPg(url, options) : openSqlite(url);
  try {
    await migrate(db, options);
    return db;
  } catch (e) {
    await db.close().catch(() => {});
    throw e;
  }
};
