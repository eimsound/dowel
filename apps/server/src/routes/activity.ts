// 项目动态：从审计日志里取与这个项目有关的记录（项目本身、它的版本、它的环境）。
// 只读，权限是项目查看者；按时间倒序，最多 50 条。配额下不翻页：动态页先看最近发生了什么。
import type { ProjectActivity, ProjectActivityEvent } from '@dowel/api';
import type { Hono } from 'hono';
import { atOf } from '../time.ts';
import { type AppContext, access, type Env } from './context.ts';

const LIMIT = 50;

interface Row {
  id: string;
  at: unknown;
  action: string;
  actorName: string | null;
  actorUsername: string | null;
  data: unknown;
}

export const registerActivity = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.get('/api/projects/:pid/activity', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const rows = await db.query<Row>(
      `select a.id, a.at, a.action,
              coalesce(u.name, case when a.actor_kind = 'token' and ct.id is not null then ct.name || '（' || ct.prefix || '…）' end) as "actorName",
              coalesce(u.username, case when a.actor_kind = 'token' then ct.prefix end) as "actorUsername",
              a.data
         from audit_events a
         left join users u on a.actor_kind = 'user' and u.id = a.actor_id
         left join ci_tokens ct on a.actor_kind = 'token' and ct.id = a.actor_id
        where a.project_id = $1
        order by a.at desc, a.id desc
        limit ${LIMIT}`,
      [a.pid],
    );
    return c.json<ProjectActivity>({
      events: rows.map(
        (r): ProjectActivityEvent => ({
          id: r.id,
          at: atOf(r.at),
          action: r.action,
          actorName: r.actorName,
          actorUsername: r.actorUsername,
          data: r.data,
        }),
      ),
    });
  });
};
