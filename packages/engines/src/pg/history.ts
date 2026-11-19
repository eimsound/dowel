// 目标库里的 Dowel 迁移历史（ADR 0003）：固定放在 `dowel` schema，存每个版本的完整模型和冻结脚本，
// 丢了平台库也能接手。这是纯库代码：只依赖 engines 的 Db 接口，不依赖服务端。
//
// 只追加：模块本身只提供“插入版本行”和“把 running 改成 done / failed”，其余改写由 history 表上的触发器
// 禁止（见 ensureHistory 里的 history_guard）。
import { createHash } from 'node:crypto';
import { type Model, stableJson } from '@dowel/core';
import { canonicalSteps, type ScriptStep, stepsChecksum } from '../steps.ts';
import type { Db } from './db.ts';
import { DOWEL_SCHEMA, normalize, type Snapshot } from './snapshot.ts';

/**
 * 当前代码写的格式版本。**只有破坏性变更**（旧版 Dowel 照旧读写会出错）才 +1，加列之类的兼容变更不动它，
 * 靠建表语句的 `if not exists` / 幂等的 `add column if not exists` 处理。
 * 读的一方（readHistoryFormat / ensureHistory / historyWriteProblem）从第一个发布版起就检查：库里的值比这个新、
 * 或者不是整数，就拒绝执行和读历史（format_too_new）——这个检查事后补不上。目前还没有任何升级路径（发版之前不写）。
 */
export const HISTORY_FORMAT = 1;

export type HistoryErrorCode =
  | 'no_schema_privilege'
  | 'format_too_new'
  | 'checksum_mismatch'
  | 'number_conflict'
  | 'lock_timeout'
  | 'run_not_running'
  | 'invalid_steps'
  | 'claim_conflict';

export class HistoryError extends Error {
  code: HistoryErrorCode;
  constructor(code: HistoryErrorCode, message: string) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
  }
}

const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;

export interface HistoryVersionRow {
  projectId: string;
  versionId: string;
  /** 链上的序号：第一个版本是 0（v0 基线），之后 1、2… */
  number: number;
  parentId: string | null;
  name: string;
  /**
   * 冻结这个版本时项目的 schema 范围（null = 全部；dowel 永远排除）。接手时直接取它恢复范围：读结构、判断空库都要按范围。
   */
  scope: string[] | null;
  upSteps: ScriptStep[];
  downSteps: ScriptStep[];
  /** stepsChecksum(upSteps, downSteps) */
  checksum: string;
  /** 发布时的完整模型（含对象 ID），接手时用它恢复改名识别和名字锁定 */
  model: Model;
  /** 结构指纹（fingerprint()），漂移检测用 */
  fingerprint: string;
  publishedAt: string;
  publishedBy: string | null;
}

/**
 * 一次执行的方向：baseline 写入基线；up / down 执行升级 / 回滚脚本；
 * mark **标记为已执行**：不执行任何 SQL，只记“这个环境已经到达 to 版本”（线上结构经核对等于 to 的模型），from 是标记前的版本。
 */
export type RunDirection = 'baseline' | 'up' | 'down' | 'mark';
export type RunStatus = 'running' | 'done' | 'failed';
export type RunVia = 'web' | 'ci';

export interface RunRow {
  id: number;
  projectId: string;
  fromVersion: string | null;
  toVersion: string;
  direction: RunDirection;
  status: RunStatus;
  /** 已完成的最后一步（断点续跑用） */
  stepIndex: number | null;
  error: string | null;
  executedBy: string | null;
  via: RunVia;
  instanceId: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface HistoryState {
  /** 当前版本：最后一条 done 的 to_version（down 方向也一样看 to_version） */
  currentVersion: string | null;
  versions: HistoryVersionRow[];
  history: RunRow[];
}

/**
 * 项目认领：这个项目现在由哪个 Dowel 实例拥有。instanceId 是**当前认领它的实例**（执行时据此拒绝别的实例，见执行器的
 * foreign_instance）；换手时 previousInstanceId 记下上一个实例，完整的换手事件在 dowel.claims（只追加）里。
 */
export interface ProjectRow {
  projectId: string;
  name: string | null;
  instanceId: string;
  claimedAt: string | null;
  claimedBy: string | null;
  previousInstanceId: string | null;
}

/** 一次“认领”事件（dowel.claims，只追加）：哪个实例、什么时候、谁确认的、从哪个实例手里接过来的 */
export interface ClaimRow {
  id: number;
  projectId: string;
  instanceId: string;
  previousInstanceId: string | null;
  claimedBy: string | null;
  claimedByName: string | null;
  claimedAt: string;
  note: string | null;
}

// ───── 建表 ─────

/** 给 DBA 预先执行的语句：schema 不存在时建好并交给 Dowel 的账号；已存在但权限不够时补授权 */
export const schemaGrantHint = (role: string, exists: boolean) =>
  exists
    ? `GRANT USAGE, CREATE ON SCHEMA ${DOWEL_SCHEMA} TO ${ident(role)};`
    : `CREATE SCHEMA ${DOWEL_SCHEMA} AUTHORIZATION ${ident(role)};`;

/**
 * history 只追加，用触发器而不是只靠调用方自觉：历史是“谁在什么时候把库改成了什么样”的证据，
 * 平台库丢了以后也要靠它接手，被改写比缺失更糟。触发器只拦“应用层的误改”（别的版本的 Dowel、手写的
 * SQL、以后加的功能里的 bug），不是安全边界——表的所有者和超级用户可以 drop 触发器，这一点接受。
 * 规则：
 * - 不允许 DELETE；
 * - 只允许改 status = 'running' 的行，且标识字段（项目、版本、方向、执行者、来源、实例、开始时间）不能变，
 *   能变的只有 status / step_index / error / finished_at；
 * - 已经结束（done / failed）的行不能再改。
 * 函数和触发器只在不存在时创建，避免每次启动都对 history 表拿 AccessExclusive 锁；
 * 以后改规则时随 format_version 升级处理。
 */
const GUARD_SQL = `do $do$ begin
     if to_regprocedure('${DOWEL_SCHEMA}.history_guard()') is null then
       create function ${DOWEL_SCHEMA}.history_guard() returns trigger language plpgsql as $fn$
       begin
         if tg_op = 'DELETE' then
           raise exception 'dowel.history 只追加，不允许删除';
         end if;
         if old.status <> 'running' then
           raise exception 'dowel.history 只追加：第 % 条记录已经结束（%），不能再改', old.id, old.status;
         end if;
         if new.id is distinct from old.id or new.project_id is distinct from old.project_id
            or new.from_version is distinct from old.from_version
            or new.to_version is distinct from old.to_version
            or new.direction is distinct from old.direction
            or new.executed_by is distinct from old.executed_by
            or new.via is distinct from old.via
            or new.instance_id is distinct from old.instance_id
            or new.started_at is distinct from old.started_at then
           raise exception 'dowel.history 只追加：第 % 条记录的标识字段不能改', old.id;
         end if;
         return new;
       end $fn$;
     end if;
     if not exists (select 1 from pg_trigger
                     where tgrelid = '${DOWEL_SCHEMA}.history'::regclass and tgname = 'history_guard') then
       create trigger history_guard before update or delete on ${DOWEL_SCHEMA}.history
         for each row execute function ${DOWEL_SCHEMA}.history_guard();
     end if;
   end $do$;`;

/** claims 也是只追加的（认领事件是“谁在什么时候把这个库的项目接过去了”的证据）：不允许改、不允许删 */
const CLAIMS_GUARD_SQL = `do $do$ begin
     if to_regprocedure('${DOWEL_SCHEMA}.claims_guard()') is null then
       create function ${DOWEL_SCHEMA}.claims_guard() returns trigger language plpgsql as $fn$
       begin
         raise exception 'dowel.claims 只追加，不允许修改或删除';
       end $fn$;
     end if;
     if not exists (select 1 from pg_trigger
                     where tgrelid = '${DOWEL_SCHEMA}.claims'::regclass and tgname = 'claims_guard') then
       create trigger claims_guard before update or delete on ${DOWEL_SCHEMA}.claims
         for each row execute function ${DOWEL_SCHEMA}.claims_guard();
     end if;
   end $do$;`;

interface Priv {
  role: string;
  database: string;
  exists: boolean;
  canCreateSchema: boolean;
  usage: boolean;
  create: boolean;
}

const readPriv = async (db: Db): Promise<Priv> => {
  const [priv] = await db.query<{
    role: string;
    database: string;
    exists: boolean;
    canCreateSchema: boolean;
    usage: boolean;
    create: boolean;
  }>(
    // has_schema_privilege 对不存在的 schema 会报错，所以先 to_regnamespace 换成 oid（不存在得到 null）
    `select current_user::text as role, current_database()::text as database,
            to_regnamespace($1) is not null as "exists",
            has_database_privilege(current_database(), 'CREATE') as "canCreateSchema",
            coalesce(has_schema_privilege(current_user, to_regnamespace($1)::oid, 'USAGE'), false) as usage,
            coalesce(has_schema_privilege(current_user, to_regnamespace($1)::oid, 'CREATE'), false) as "create"`,
    [DOWEL_SCHEMA],
  );
  return priv!;
};

/** 账号能不能在目标库里写迁移历史：只读检查，不建任何东西（预演用）；不能时返回 HistoryError，可以返回 null */
const privProblem = (p: Priv): HistoryError | null => {
  if (!p.exists && !p.canCreateSchema)
    return new HistoryError(
      'no_schema_privilege',
      `需要在目标库里建 \`${DOWEL_SCHEMA}\` schema 来存迁移历史（固定名字，不会退回到业务 schema），` +
        `但账号 ${p.role} 没有在库 ${p.database} 里建 schema 的权限。需要其一：` +
        `让 DBA 预先执行 \`${schemaGrantHint(p.role, false)}\`，` +
        `或授予 \`GRANT CREATE ON DATABASE ${ident(p.database)} TO ${ident(p.role)};\` 后由 Dowel 自己建。`,
    );
  if (p.exists && !(p.usage && p.create))
    return new HistoryError(
      'no_schema_privilege',
      `\`${DOWEL_SCHEMA}\` schema 已存在，但账号 ${p.role} 没有在里面建表和读写的权限。` +
        `需要 USAGE 和 CREATE：让 DBA 执行 \`${schemaGrantHint(p.role, true)}\``,
    );
  return null;
};

/**
 * 预演用：目标库里的迁移历史**能不能写**（有没有权限建 schema / 建表、格式是不是比当前代码新）。
 * 只读，不建任何东西；有问题返回说明，没问题返回 null。
 */
export const historyWriteProblem = async (db: Db): Promise<HistoryError | null> => {
  const p = await readPriv(db);
  const priv = privProblem(p);
  if (priv) return priv;
  if (!p.exists || !(await historyExists(db))) return null;
  const [meta] = await db.query<{ value: unknown }>(
    `select value from ${DOWEL_SCHEMA}.meta where key = 'format_version'`,
  );
  const stored = meta ? Number(meta.value) : 1;
  if (!Number.isInteger(stored) || stored > HISTORY_FORMAT)
    return new HistoryError(
      'format_too_new',
      `目标库里的迁移历史是格式 ${JSON.stringify(meta?.value)}，当前 Dowel 只支持到 ${HISTORY_FORMAT}。请升级 Dowel`,
    );
  return null;
};

/**
 * 读目标库里历史的格式版本（只读）：没有历史表返回 null。比当前代码新的格式抛 format_too_new——
 * 读也不行（认得的表结构可能已经变了）。读历史、检查漂移、接手前先调用它。
 */
export const readHistoryFormat = async (db: Db): Promise<number | null> => {
  if (!(await historyExists(db))) return null;
  const [meta] = await db.query<{ value: unknown }>(
    `select value from ${DOWEL_SCHEMA}.meta where key = 'format_version'`,
  );
  const stored = meta ? Number(meta.value) : 1;
  if (!Number.isInteger(stored) || stored > HISTORY_FORMAT)
    throw new HistoryError(
      'format_too_new',
      `目标库里的迁移历史是格式 ${JSON.stringify(meta?.value)}，当前 Dowel 只支持到 ${HISTORY_FORMAT}。请升级 Dowel`,
    );
  return stored;
};

export const ensureHistory = async (db: Db): Promise<void> => {
  const p = await readPriv(db);
  const priv = privProblem(p);
  if (priv) throw priv;

  try {
    // schema 已经存在时不能再写 create schema（哪怕带 if not exists）：PG 会先检查库级 CREATE 权限，
    // 而 DBA 预先建好 schema 的账号恰恰没有这个权限
    // 一条多语句的简单查询在一个隐式事务里执行，事务级 advisory lock 保证两个实例同时初始化时不会撞在
    // “create table if not exists”的目录唯一约束上
    await db.exec(`select pg_advisory_xact_lock(hashtext('dowel:ensure_history'));
   ${p.exists ? '' : `create schema if not exists ${DOWEL_SCHEMA};`}
   create table if not exists ${DOWEL_SCHEMA}.meta (
     key text primary key,
     value jsonb not null
   );
   create table if not exists ${DOWEL_SCHEMA}.projects (
     project_id text primary key,
     name text,
     instance_id text not null,
     claimed_at timestamptz,
     claimed_by text,
     previous_instance_id text
   );
   create table if not exists ${DOWEL_SCHEMA}.versions (
     project_id text not null,
     version_id text not null,
     number int not null,
     parent_id text,
     name text not null,
     scope jsonb,
     up_steps jsonb not null,
     down_steps jsonb not null,
     checksum text not null,
     model jsonb not null,
     fingerprint text not null,
     published_at timestamptz not null default now(),
     published_by text,
     primary key (project_id, version_id),
     unique (project_id, number)
   );
   create table if not exists ${DOWEL_SCHEMA}.history (
     id bigserial primary key,
     project_id text not null,
     from_version text,
     to_version text not null,
     direction text not null check (direction in ('baseline', 'up', 'down', 'mark')),
     status text not null check (status in ('running', 'done', 'failed')),
     step_index int,
     error text,
     executed_by text,
     via text not null check (via in ('web', 'ci')),
     instance_id text not null,
     started_at timestamptz not null default now(),
     finished_at timestamptz
   );
   create index if not exists history_project_id on ${DOWEL_SCHEMA}.history (project_id, id);
   create table if not exists ${DOWEL_SCHEMA}.claims (
     id bigserial primary key,
     project_id text not null,
     instance_id text not null,
     previous_instance_id text,
     claimed_by text,
     claimed_by_name text,
     claimed_at timestamptz not null default now(),
     note text
   );
   create index if not exists claims_project_id on ${DOWEL_SCHEMA}.claims (project_id, id);
   ${GUARD_SQL}
   ${CLAIMS_GUARD_SQL}`);
  } catch (e) {
    if ((e as { code?: unknown })?.code === '42501')
      // insufficient_privilege
      throw new HistoryError(
        'no_schema_privilege',
        `在 \`${DOWEL_SCHEMA}\` schema 里建表被拒绝（账号 ${p.role}）：${(e as Error).message}。` +
          `需要 USAGE 和 CREATE：让 DBA 执行 \`${schemaGrantHint(p.role, true)}\``,
      );
    throw e;
  }

  const [meta] = await db.query<{ value: unknown }>(
    `select value from ${DOWEL_SCHEMA}.meta where key = 'format_version'`,
  );
  if (!meta) {
    await db.query(
      `insert into ${DOWEL_SCHEMA}.meta (key, value) values ('format_version', $1::text::jsonb)
       on conflict (key) do nothing`,
      [JSON.stringify(HISTORY_FORMAT)],
    );
    return;
  }
  const stored = Number(meta.value);
  if (!Number.isInteger(stored) || stored > HISTORY_FORMAT)
    throw new HistoryError(
      'format_too_new',
      `目标库里的迁移历史是格式 ${JSON.stringify(meta.value)}，当前 Dowel 只支持到 ${HISTORY_FORMAT}。请升级 Dowel`,
    );
};

// ───── 读写 ─────

const EMPTY_STEPS: ScriptStep[] = [];

const readSteps = (value: unknown): ScriptStep[] => {
  if (value === null || value === undefined) return EMPTY_STEPS;
  if (!Array.isArray(value)) throw new HistoryError('invalid_steps', '冻结脚本不是数组');
  return canonicalSteps(value as ScriptStep[]);
};

/** postgres.js 把 timestamptz 读成 Date；统一成 ISO 字符串 */
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

/** 时间戳统一成 ISO（to_jsonb 给的是 PG 的文本格式，和 postgres.js 读出的 Date 要一致） */
const isoText = (v: unknown): string => new Date(String(v)).toISOString();

/**
 * 版本行：用 to_jsonb(v) 整行读出，**不点名列**；
 * 读历史、检查漂移、接手都是只读的，整行读出来再按字段取（以后兼容地加列时，旧代码照样读得了）。
 */
const toVersionRow = (j: Record<string, unknown>): HistoryVersionRow => ({
  projectId: j.project_id as string,
  versionId: j.version_id as string,
  number: Number(j.number),
  parentId: (j.parent_id as string | null) ?? null,
  name: j.name as string,
  scope: Array.isArray(j.scope) && j.scope.length ? (j.scope as string[]) : null,
  upSteps: readSteps(j.up_steps),
  downSteps: readSteps(j.down_steps),
  checksum: j.checksum as string,
  model: j.model as Model,
  fingerprint: j.fingerprint as string,
  publishedAt: isoText(j.published_at),
  publishedBy: (j.published_by as string | null) ?? null,
});

const toRunRow = (r: Record<string, unknown>): RunRow => ({
  id: Number(r.id),
  projectId: r.projectId as string,
  fromVersion: (r.fromVersion as string | null) ?? null,
  toVersion: r.toVersion as string,
  direction: r.direction as RunDirection,
  status: r.status as RunStatus,
  stepIndex: r.stepIndex === null || r.stepIndex === undefined ? null : Number(r.stepIndex),
  error: (r.error as string | null) ?? null,
  executedBy: (r.executedBy as string | null) ?? null,
  via: r.via as RunVia,
  instanceId: r.instanceId as string,
  startedAt: iso(r.startedAt),
  finishedAt: isoOrNull(r.finishedAt),
});

/**
 * 目标库里有没有 Dowel 的历史表。没有说明这个库从没被 Dowel 执行过——**只读，不建任何东西**
 * （读历史、检查漂移的入口先用它，避免为了“看一眼”就在用户的库里建 schema）。
 */
export const historyExists = async (db: Db): Promise<boolean> => {
  const [r] = await db.query<{ ok: boolean }>(
    `select to_regclass($1) is not null and to_regclass($2) is not null and to_regclass($3) is not null as ok`,
    [`${DOWEL_SCHEMA}.versions`, `${DOWEL_SCHEMA}.history`, `${DOWEL_SCHEMA}.projects`],
  );
  return r?.ok === true;
};

/** 当前版本 + 全部版本行 + 全部执行记录 */
export const readHistory = async (db: Db, projectId: string): Promise<HistoryState> => {
  const versions = await db.query<{ r: Record<string, unknown> }>(
    `select to_jsonb(v) as r from ${DOWEL_SCHEMA}.versions v where v.project_id = $1 order by v.number`,
    [projectId],
  );
  const history = await db.query(
    `select id::int as id, project_id as "projectId", from_version as "fromVersion",
            to_version as "toVersion", direction, status, step_index as "stepIndex", error,
            executed_by as "executedBy", via, instance_id as "instanceId",
            started_at as "startedAt", finished_at as "finishedAt"
       from ${DOWEL_SCHEMA}.history where project_id = $1 order by id`,
    [projectId],
  );
  const runs = history.map(toRunRow);
  const done = runs.filter((r) => r.status === 'done');
  return {
    currentVersion: done.length ? done[done.length - 1]!.toVersion : null,
    versions: versions.map((v) => toVersionRow(v.r)),
    history: runs,
  };
};

/**
 * 写版本行，幂等：同一个 version_id 再写一次时 checksum 必须相同，否则抛 checksum_mismatch。
 * 传入的 checksum 必须等于由 steps 重新算出来的值，否则写进去的行一开始就是坏的。
 */
export const recordVersion = async (db: Db, row: HistoryVersionRow): Promise<void> => {
  const expected = stepsChecksum(row.upSteps, row.downSteps);
  if (row.checksum !== expected)
    throw new HistoryError(
      'checksum_mismatch',
      `版本 ${row.versionId} 的 checksum 与脚本内容不符（传入 ${row.checksum.slice(0, 12)}…，重算 ${expected.slice(0, 12)}…）`,
    );
  let inserted: { versionId: string }[];
  try {
    inserted = await db.query<{ versionId: string }>(
      `insert into ${DOWEL_SCHEMA}.versions
         (project_id, version_id, number, parent_id, name, scope, up_steps, down_steps, checksum, model,
          fingerprint, published_at, published_by)
       values ($1, $2, $3, $4, $5, $6::text::jsonb, $7::text::jsonb, $8::text::jsonb, $9, $10::text::jsonb,
               $11, $12, $13)
       on conflict (project_id, version_id) do nothing
       returning version_id as "versionId"`,
      [
        row.projectId,
        row.versionId,
        row.number,
        row.parentId,
        row.name,
        row.scope?.length ? JSON.stringify(row.scope) : null,
        JSON.stringify(canonicalSteps(row.upSteps)),
        JSON.stringify(canonicalSteps(row.downSteps)),
        row.checksum,
        JSON.stringify(row.model),
        row.fingerprint,
        row.publishedAt,
        row.publishedBy,
      ],
    );
  } catch (e) {
    // (project_id, number) 唯一约束：另一个版本已经占了这个序号
    if ((e as { code?: unknown })?.code === '23505')
      throw new HistoryError('number_conflict', `项目 ${row.projectId} 的 v${row.number} 已被另一个版本占用`);
    throw e;
  }
  if (inserted.length) return;
  const [cur] = await db.query<{ checksum: string }>(
    `select checksum from ${DOWEL_SCHEMA}.versions where project_id = $1 and version_id = $2`,
    [row.projectId, row.versionId],
  );
  if (cur && cur.checksum !== row.checksum)
    throw new HistoryError(
      'checksum_mismatch',
      `版本 ${row.versionId} 已经以不同的内容写入过（已有 ${cur.checksum.slice(0, 12)}…，本次 ${row.checksum.slice(0, 12)}…）`,
    );
};

export interface StartRunInput {
  projectId: string;
  fromVersion: string | null;
  toVersion: string;
  direction: RunDirection;
  executedBy: string | null;
  via: RunVia;
  instanceId: string;
}

/** 开始一次执行；返回记录 ID（断点续跑和 finishRun 用） */
export const startRun = async (db: Db, run: StartRunInput): Promise<number> => {
  const [row] = await db.query<{ id: number }>(
    `insert into ${DOWEL_SCHEMA}.history
       (project_id, from_version, to_version, direction, status, executed_by, via, instance_id)
     values ($1, $2, $3, $4, 'running', $5, $6, $7)
     returning id::int as id`,
    [run.projectId, run.fromVersion, run.toVersion, run.direction, run.executedBy, run.via, run.instanceId],
  );
  return Number(row!.id);
};

/** 结束一次执行；只有 running 的记录能结束（触发器也保证） */
export const finishRun = async (
  db: Db,
  id: number,
  status: Exclude<RunStatus, 'running'>,
  error?: string | null,
): Promise<void> => {
  const rows = await db.query<{ id: number }>(
    `update ${DOWEL_SCHEMA}.history
        set status = $2, error = $3, finished_at = now()
      where id = $1 and status = 'running'
      returning id::int as id`,
    [id, status, error ?? null],
  );
  if (!rows.length) throw new HistoryError('run_not_running', `执行记录 ${id} 不存在或已经结束`);
};

/** 记录断点：已经执行完的步骤序号（只能改 running 的记录） */
export const markStep = async (db: Db, id: number, stepIndex: number): Promise<void> => {
  const rows = await db.query<{ id: number }>(
    `update ${DOWEL_SCHEMA}.history set step_index = $2 where id = $1 and status = 'running'
     returning id::int as id`,
    [id, stepIndex],
  );
  if (!rows.length) throw new HistoryError('run_not_running', `执行记录 ${id} 不存在或已经结束`);
};

// ───── 项目锁 ─────

const lockKey = (projectId: string) => `dowel:${projectId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 同一个项目的执行互斥（advisory lock）。拿到锁后执行 fn，**一定**释放锁；等不到就抛 lock_timeout。
 *
 * **加锁和解锁必须在同一个连接上。** advisory lock 是会话级的：在连接 A 上加的锁，在连接 B 上
 * `pg_advisory_unlock` 只会返回 false，锁一直挂到 A 断开。而 Db 的 query / exec 是连接池的抽象
 * （postgres.js 的 `sql.unsafe` 每次从池里取一个空闲连接），连续两次调用可能落在不同连接上。
 * 所以这里先用 `db.reserve()`（postgres.js 的 `sql.reserve()`，由 fromPostgres 适配）独占一个连接，
 * 加锁、fn、解锁都在它上面，最后 `release()` 归还；fn 拿到的也是这个独占的 Db，
 * 里面的 SET、事务、断点记录都在持锁的那个会话里。驱动没有实现 reserve（单连接适配器）时直接用 db 本身。
 *
 * 用 pg_try_advisory_lock + 200ms 轮询，而不是阻塞的 pg_advisory_lock：阻塞版本的等待没法设截止时间。
 * 锁的键是 hashtext('dowel:<projectId>')：32 位哈希，不同项目偶尔共用一把锁只会多等，不会出错。
 */
export const withProjectLock = async <T>(
  db: Db,
  projectId: string,
  timeoutMs: number,
  fn: (db: Db) => Promise<T>,
): Promise<T> => {
  const reserved = db.reserve ? await db.reserve() : null;
  const conn = reserved ?? db;
  let locked = false;
  try {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const [r] = await conn.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [
        lockKey(projectId),
      ]);
      if (r!.ok) {
        locked = true;
        break;
      }
      const left = deadline - Date.now();
      if (left <= 0)
        throw new HistoryError(
          'lock_timeout',
          `等待项目锁超时（${timeoutMs}ms）：这个项目正在被另一个执行占用`,
        );
      await sleep(Math.min(200, left));
    }
    return await fn(conn);
  } finally {
    if (locked) {
      // fn 可能在事务中途抛错，连接停在“事务已中止”状态，此时 unlock 也会失败、锁随连接回到池里继续挂着。
      // 独占的连接上先 rollback 一次（没有事务时只是个警告）；共用的 db 不能这样做，那是调用方自己的事务
      if (reserved) await conn.exec('ROLLBACK').catch(() => {});
      const unlocked = await conn
        .query<{ ok: boolean }>('select pg_advisory_unlock(hashtext($1)) as ok', [lockKey(projectId)])
        .then((rows) => rows[0]?.ok === true)
        .catch(() => false);
      if (!unlocked) console.error(`释放项目锁失败：${projectId}（连接异常，锁会在该连接断开时释放）`);
    }
    reserved?.release?.();
  }
};

// ───── 结构指纹 ─────

/**
 * 结构指纹：对 readSnapshot 的结果算 sha256，供漂移检测比较。
 *
 * 先用 engines 的 normalize() 规范化（与 diffSnapshots 比较时是同一套规则）：递归按键排序，并剔除
 * 不稳定的字段——
 * - `version`：快照顶层的 server_version_num，换 PG 小版本就变，跟结构无关；
 * - `attnum`：列的物理序号，删过列的表和新建的表不同；Dowel 不把列的物理顺序当作结构；
 * - `order`：只用于展示顺序的字段（目前快照里没有，规范化时一并剔除，防止以后加了再引入不稳定）。
 * 快照本身不含 OID（按限定名索引），所以不需要另外处理；数组（枚举值、约束列、索引元素）保持原顺序，
 * 因为它们的顺序是结构的一部分。名字、类型、表达式的规范形式、NOT NULL、注释都参与指纹。
 * `dowel` schema 在 readSnapshot 里已被排除，不会让“Dowel 自己写了历史表”造成漂移。
 */
export const fingerprint = (snapshot: Snapshot): string =>
  createHash('sha256')
    .update(stableJson(normalize(snapshot)))
    .digest('hex');

// ───── 链完整性 ─────

export type ChainProblemCode = 'number_gap' | 'parent_broken' | 'checksum_mismatch';

export interface ChainProblem {
  code: ChainProblemCode;
  /** 出问题的版本 */
  versionId: string;
  message: string;
}

/**
 * 校验版本链：number 连续、parent 指向上一个版本（第一个版本为空）、
 * 每行重新算的 checksum 与存储值一致。返回问题列表（空数组表示链是完整的）。
 * 链的起点：导入出来的项目从 v0 基线开始（number 0），空白项目从 v1 开始（number 1，parent 为空，
 * 它的迁移是从空库建出来的），所以第一个版本的 number 只能是 0 或 1，之后逐个加 1。
 */
export const verifyChain = (rows: HistoryVersionRow[]): ChainProblem[] => {
  const sorted = [...rows].sort((a, b) => a.number - b.number);
  const out: ChainProblem[] = [];
  const start = sorted[0]?.number === 1 ? 1 : 0;
  for (const [i, r] of sorted.entries()) {
    if (r.number !== start + i)
      out.push({
        code: 'number_gap',
        versionId: r.versionId,
        message: `版本 ${r.name} 的 number 是 ${r.number}，链上这个位置应该是 ${start + i}`,
      });
    const expectedParent = i === 0 ? null : sorted[i - 1]!.versionId;
    if (r.parentId !== expectedParent)
      out.push({
        code: 'parent_broken',
        versionId: r.versionId,
        message:
          i === 0
            ? `链上第一个版本 ${r.name} 不应该有 parent（现在是 ${r.parentId ?? '空'}）`
            : `版本 ${r.name} 的 parent 是 ${r.parentId ?? '空'}，应该指向上一个版本 ${expectedParent}`,
      });
    const checksum = stepsChecksum(r.upSteps, r.downSteps);
    if (checksum !== r.checksum)
      out.push({
        code: 'checksum_mismatch',
        versionId: r.versionId,
        message: `版本 ${r.name} 的冻结脚本和校验和不符（存储 ${r.checksum.slice(0, 12)}…，重算 ${checksum.slice(0, 12)}…）`,
      });
  }
  return out;
};

// ───── 项目认领 ─────

const toProjectRow = (j: Record<string, unknown>): ProjectRow => ({
  projectId: j.project_id as string,
  name: (j.name as string | null) ?? null,
  instanceId: j.instance_id as string,
  claimedAt: j.claimed_at ? isoText(j.claimed_at) : null,
  claimedBy: (j.claimed_by as string | null) ?? null,
  previousInstanceId: (j.previous_instance_id as string | null) ?? null,
});

/** 读项目的认领信息（整行读，兼容格式 1 没有 previous_instance_id 的表） */
export const readProject = async (db: Db, projectId: string): Promise<ProjectRow | null> => {
  const [r] = await db.query<{ r: Record<string, unknown> }>(
    `select to_jsonb(p) as r from ${DOWEL_SCHEMA}.projects p where p.project_id = $1`,
    [projectId],
  );
  return r ? toProjectRow(r.r) : null;
};

/** 第一次执行到这个库时登记项目（instanceId 就是登记它的实例）；已经登记过的更新名字、认领信息 */
export const writeProject = async (
  db: Db,
  row: Omit<ProjectRow, 'previousInstanceId'> & { previousInstanceId?: string | null },
): Promise<void> => {
  await db.query(
    `insert into ${DOWEL_SCHEMA}.projects (project_id, name, instance_id, claimed_at, claimed_by, previous_instance_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (project_id) do update
       set name = excluded.name, instance_id = excluded.instance_id,
           claimed_at = excluded.claimed_at, claimed_by = excluded.claimed_by,
           previous_instance_id = excluded.previous_instance_id`,
    [row.projectId, row.name, row.instanceId, row.claimedAt, row.claimedBy, row.previousInstanceId ?? null],
  );
};

export interface ClaimInput {
  projectId: string;
  /** 认领的实例（本实例） */
  instanceId: string;
  /** 在平台上确认认领的用户（ID 和显示名；显示名只为了在目标库里留下可读的痕迹） */
  claimedBy: string | null;
  claimedByName: string | null;
  /** 项目名（平台上的名字，更新 projects.name） */
  name: string | null;
  note?: string | null;
}

/**
 * 认领：把这个库里项目的“当前认领实例”换成 `instanceId`。**必须在调用方的事务和项目锁里执行**（执行器的 claimInstance）。
 * - 项目行：instance_id = 新实例，claimed_at / claimed_by 更新，previous_instance_id = 换手前的实例；
 * - **同时在 dowel.claims 里追加一条事件**（history 表的方向 / 外键结构是给“执行”设计的，触发器也只允许改 running 的行，
 *   事件另放一张只追加的表，见 04-ir-design.md 第 7 节）；
 * - 已经是这个实例认领的：什么都不写，返回 changed = false（幂等）。
 * 没有项目行（只有版本，行被手工删了）也能认领：当作上一个实例未知。
 */
export const claimProject = async (
  db: Db,
  input: ClaimInput,
): Promise<{ changed: boolean; previousInstanceId: string | null }> => {
  const [cur] = await db.query<{ r: Record<string, unknown> }>(
    `select to_jsonb(p) as r from ${DOWEL_SCHEMA}.projects p where p.project_id = $1 for update`,
    [input.projectId],
  );
  const prev = cur ? toProjectRow(cur.r) : null;
  if (prev?.instanceId === input.instanceId)
    return { changed: false, previousInstanceId: prev.previousInstanceId };
  await writeProject(db, {
    projectId: input.projectId,
    name: input.name ?? prev?.name ?? null,
    instanceId: input.instanceId,
    claimedAt: new Date().toISOString(),
    claimedBy: input.claimedBy,
    previousInstanceId: prev?.instanceId ?? null,
  });
  await db.query(
    `insert into ${DOWEL_SCHEMA}.claims
       (project_id, instance_id, previous_instance_id, claimed_by, claimed_by_name, note)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      input.projectId,
      input.instanceId,
      prev?.instanceId ?? null,
      input.claimedBy,
      input.claimedByName,
      input.note ?? null,
    ],
  );
  return { changed: true, previousInstanceId: prev?.instanceId ?? null };
};

/** 认领事件（新的在后）；格式 1 的库没有这张表，返回空数组 */
export const readClaims = async (db: Db, projectId: string): Promise<ClaimRow[]> => {
  const [t] = await db.query<{ ok: boolean }>('select to_regclass($1) is not null as ok', [
    `${DOWEL_SCHEMA}.claims`,
  ]);
  if (!t?.ok) return [];
  const rows = await db.query<Record<string, unknown>>(
    `select id::int as id, project_id as "projectId", instance_id as "instanceId",
            previous_instance_id as "previousInstanceId", claimed_by as "claimedBy",
            claimed_by_name as "claimedByName", claimed_at as "claimedAt", note
       from ${DOWEL_SCHEMA}.claims where project_id = $1 order by id`,
    [projectId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    projectId: r.projectId as string,
    instanceId: r.instanceId as string,
    previousInstanceId: (r.previousInstanceId as string | null) ?? null,
    claimedBy: (r.claimedBy as string | null) ?? null,
    claimedByName: (r.claimedByName as string | null) ?? null,
    claimedAt: iso(r.claimedAt),
    note: (r.note as string | null) ?? null,
  }));
};

/** 接手向导里“这个库登记过哪些项目”的一行 */
export interface HistoryProjectSummary {
  projectId: string;
  name: string | null;
  instanceId: string;
  claimedAt: string | null;
  /** 库里记着的版本数、最新版本的序号 */
  versions: number;
  headNumber: number | null;
  /** 这个库当前的版本序号（最后一条 done 的记录的目标版本）；没有执行过为 null */
  currentNumber: number | null;
  lastRunAt: string | null;
}

/** 目标库里登记过的项目（接手向导用）。只读，兼容格式 1。没有历史表返回空数组 */
export const listHistoryProjects = async (db: Db): Promise<HistoryProjectSummary[]> => {
  if (!(await historyExists(db))) return [];
  const rows = await db.query<Record<string, unknown>>(
    `select p.project_id as "projectId", p.name, p.instance_id as "instanceId", p.claimed_at as "claimedAt",
            (select count(*)::int from ${DOWEL_SCHEMA}.versions v where v.project_id = p.project_id) as versions,
            (select max(v.number) from ${DOWEL_SCHEMA}.versions v where v.project_id = p.project_id) as "headNumber",
            (select v.number from ${DOWEL_SCHEMA}.history h
               join ${DOWEL_SCHEMA}.versions v on v.project_id = h.project_id and v.version_id = h.to_version
              where h.project_id = p.project_id and h.status = 'done' order by h.id desc limit 1) as "currentNumber",
            (select max(coalesce(h.finished_at, h.started_at)) from ${DOWEL_SCHEMA}.history h
              where h.project_id = p.project_id) as "lastRunAt"
       from ${DOWEL_SCHEMA}.projects p order by p.name nulls last, p.project_id`,
  );
  return rows.map((r) => ({
    projectId: r.projectId as string,
    name: (r.name as string | null) ?? null,
    instanceId: r.instanceId as string,
    claimedAt: isoOrNull(r.claimedAt),
    versions: Number(r.versions),
    headNumber: r.headNumber === null || r.headNumber === undefined ? null : Number(r.headNumber),
    currentNumber: r.currentNumber === null || r.currentNumber === undefined ? null : Number(r.currentNumber),
    lastRunAt: isoOrNull(r.lastRunAt),
  }));
};
