// 审计查询（G7）：只有实例管理员能用。按 at、id 倒序做游标分页，返回 actor 的用户名。
// 过滤条件：action 前缀、actor（用户 ID 或用户名）、target_kind / target_id、时间范围。
import type { AuditEvent, AuditPage } from '@dowel/api';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { atOf } from '../time.ts';
import type { AppContext, Env } from './context.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface Cursor {
  at: string;
  id: string;
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');

const decodeCursor = (raw: string): Cursor => {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof v.at !== 'string' || typeof v.id !== 'string') throw new Error('bad cursor');
    return { at: v.at, id: v.id };
  } catch {
    throw new HTTPException(400, { message: 'cursor 不合法' });
  }
};

/**
 * 时间参数：PG 保留原始字符串（可能带微秒），比较时显式转 timestamptz；
 * SQLite 存的是 ISO 文本，统一转成 ISO 再比较。
 */
const timeParam = (dialect: 'sqlite' | 'pg', name: string, raw: string | undefined): string | null => {
  if (!raw) return null;
  if (Number.isNaN(Date.parse(raw))) throw new HTTPException(400, { message: `${name} 不是合法的时间` });
  return dialect === 'pg' ? raw : new Date(raw).toISOString();
};

export const registerAudit = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.get('/api/admin/audit', async (c) => {
    const q = c.req.query();
    const limitRaw = Number(q.limit ?? DEFAULT_LIMIT);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: (n: number) => string, value: unknown) => {
      params.push(value);
      conditions.push(sql(params.length));
    };

    if (q.action) add((n) => `substr(a.action, 1, length($${n})) = $${n}`, q.action);
    if (q.actor)
      add(
        (n) =>
          `(a.actor_id = $${n} or lower(u.username) = lower($${n}) or (a.actor_kind = 'token' and (lower(ct.name) = lower($${n}) or ct.prefix = $${n})))`,
        q.actor.trim(),
      );
    if (q.targetKind) add((n) => `a.target_kind = $${n}`, q.targetKind);
    if (q.targetId) add((n) => `a.target_id = $${n}`, q.targetId);
    const cast = db.dialect === 'pg' ? '::timestamptz' : '';
    const from = timeParam(db.dialect, 'from', q.from);
    if (from) add((n) => `a.at >= $${n}${cast}`, from);
    const to = timeParam(db.dialect, 'to', q.to);
    if (to) add((n) => `a.at <= $${n}${cast}`, to);
    if (q.cursor) {
      const cursor = decodeCursor(q.cursor);
      params.push(cursor.at);
      const atN = params.length;
      params.push(cursor.id);
      conditions.push(`(a.at < $${atN}${cast} or (a.at = $${atN}${cast} and a.id < $${params.length}))`);
    }

    const rows = await db.query<Omit<AuditEvent, 'at'> & { at: unknown; atRaw: unknown }>(
      `select a.id, a.at, cast(a.at as text) as "atRaw",
              a.actor_kind as "actorKind", a.actor_id as "actorId",
              coalesce(u.username, case when a.actor_kind = 'token' and ct.id is not null then ct.name || ' (' || ct.prefix || '…)' end) as "actorUsername",
              a.action, a.target_kind as "targetKind",
              a.target_id as "targetId", a.ip, a.data
         from audit_events a
         left join users u on a.actor_kind = 'user' and u.id = a.actor_id
         left join ci_tokens ct on a.actor_kind = 'token' and ct.id = a.actor_id
        ${conditions.length ? `where ${conditions.join(' and ')}` : ''}
        order by a.at desc, a.id desc
        limit ${limit + 1}`,
      params,
    );
    const page = rows.slice(0, limit).map(({ atRaw: _raw, ...r }) => ({ ...r, at: atOf(r.at) }));
    // 游标存数据库原样读出的 at 文本（PG 保留微秒），下一轮比较时再转 timestamptz
    const last = rows[limit - 1];
    const nextCursor =
      rows.length > limit && last ? encodeCursor({ at: String(last.atRaw), id: last.id }) : null;
    return c.json<AuditPage>({ events: page as AuditEvent[], nextCursor });
  });
};
