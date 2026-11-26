// 站内收件箱的持久化读写（inbox_items）：未读数、全部已读、列表，以及“这条通知现在看得到”的可见性过滤。
// 写入通知在申请状态变化的同一个事务里做（service.ts 的 notify），这里只有按用户的读取与标记已读。
import type { InboxItem, InboxKind } from '@dowel/api';
import type { Db } from '@dowel/engines';

import { inList } from '../db.ts';
import { iso } from '../envs.ts';
import { loadRoleContext, type RoleContext, visibleProjects } from '../roles.ts';

const roleContextOf = async (db: Db, userId: string): Promise<RoleContext | null> => {
  const [u] = await db.query<{ id: string; role: string; status: string }>(
    'select id, role, status from users where id = $1',
    [userId],
  );
  return u && u.status === 'active' ? loadRoleContext(db, u) : null;
};

/**
 * “这条通知现在看得到”的 SQL 条件：没有项目的（以后的实例级通知）总是可见，有项目的要在这个用户现在看得到的项目里
 * （生效角色非空，和其他地方同一个规则：roles.ts 的 visibleProjects）。prefix 是表别名（带点），start 是第一个参数的序号。
 */
const visibleFilter = async (db: Db, rc: RoleContext, prefix: string, start: number) => {
  // 实例管理员看得到全部项目，不需要过滤（也避免把全实例的项目 id 展开成超长的 IN 列表）
  if (rc.instanceAdmin) return { sql: 'true', params: [] as string[] };
  // 只取这个用户的通知里出现过的项目，再与可见项目求交：IN 列表的长度受通知涉及的项目数约束，而不是可见项目总数
  const mine = new Set(
    (
      await db.query<{ project_id: string }>(
        'select distinct project_id from inbox_items where user_id = $1 and project_id is not null',
        [rc.userId],
      )
    ).map((r) => r.project_id),
  );
  const ids = mine.size ? (await visibleProjects(db, rc)).map((p) => p.id).filter((id) => mine.has(id)) : [];
  return {
    sql: ids.length
      ? `(${prefix}project_id is null or ${prefix}project_id in (${inList(ids, start)}))`
      : `${prefix}project_id is null`,
    params: ids,
  };
};

/**
 * 未读数：和收件箱列表同一条可见性规则（第一轮审查：直接数全部未读会泄露“看不到的项目里有动静”）。
 * 过滤在 SQL 里做（第二轮审查）：先算出这个用户现在看得到的项目，再 count。rc 不给就按这个用户现在的角色读一次；
 * 账号不存在 / 停用时是 0。
 */
export const unread = async (db: Db, userId: string, rc?: RoleContext): Promise<number> => {
  const ctx = rc ?? (await roleContextOf(db, userId));
  if (!ctx) return 0;
  const v = await visibleFilter(db, ctx, '', 2);
  const [r] = await db.query<{ n: number | string }>(
    `select count(*) as n from inbox_items where user_id = $1 and read_at is null and ${v.sql}`,
    [userId, ...v.params],
  );
  return Number(r?.n ?? 0);
};

/** 全部标为已读：只作用于现在看得到的通知（看不到的项目的通知保持原样，重新看得到时仍是未读） */
export const readAll = async (db: Db, userId: string, rc: RoleContext): Promise<void> => {
  const v = await visibleFilter(db, rc, '', 3);
  await db.query(`update inbox_items set read_at = $2 where user_id = $1 and read_at is null and ${v.sql}`, [
    userId,
    new Date().toISOString(),
    ...v.params,
  ]);
};

/** 收件箱列表（新的在前）：可见性过滤和条数限制都在 SQL 里（第二轮审查） */
export const listInbox = async (
  db: Db,
  user: { id: string; role: string },
  rc: RoleContext,
  limit = 100,
): Promise<InboxItem[]> => {
  const v = await visibleFilter(db, rc, 'i.', 2);
  const rows = await db.query<{
    id: string;
    kind: InboxKind;
    created_at: unknown;
    read_at: unknown;
    project_id: string | null;
    environment_id: string | null;
    request_id: string | null;
    data: InboxItem['data'];
    pname: string | null;
    pslug: string | null;
    gslug: string | null;
    ename: string | null;
  }>(
    `select i.id, i.kind, i.created_at, i.read_at, i.project_id, i.environment_id, i.request_id, i.data,
            p.name as pname, p.slug as pslug, g.slug as gslug, e.name as ename
       from inbox_items i
       left join projects p on p.id = i.project_id
       left join groups g on g.id = p.group_id
       left join environments e on e.id = i.environment_id
      where i.user_id = $1 and ${v.sql}
      order by i.created_at desc, i.id desc
      limit ${Math.max(1, Math.floor(limit))}`,
    [user.id, ...v.params],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    createdAt: iso(r.created_at)!,
    readAt: iso(r.read_at),
    project:
      r.project_id && r.pname
        ? { id: r.project_id, name: r.pname, slug: r.pslug ?? '', groupSlug: r.gslug ?? '' }
        : null,
    environment: r.environment_id && r.ename ? { id: r.environment_id, name: r.ename } : null,
    requestId: r.request_id,
    data: r.data,
  }));
};
