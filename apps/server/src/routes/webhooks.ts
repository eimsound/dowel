// 组级 Webhook 的配置接口（P5b，E8）：组管理员（实例管理员也行）增删改查、看投递记录、发送测试。
// URL 和签名密钥加密存储，任何响应、审计里都不回显：响应只有 urlMasked（协议 + 主机）和 hasSecret。
import {
  type Ok,
  type WebhookDelivery,
  type WebhookFormat,
  type WebhookInfo,
  webhookCreateSchema,
  webhookPatchSchema,
} from '@dowel/api';
import { newId } from '@dowel/core';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { audit, auditIn } from '../audit.ts';
import { decrypt, encrypt } from '../secrets.ts';
import { readSettings } from '../settings.ts';
import { atOf } from '../time.ts';
import {
  DELIVERY_COLUMNS,
  type DeliveryRow,
  deliveryOf,
  KEEP_DELIVERIES,
  maskWebhookUrl,
  webhookUrlProblem,
} from '../webhooks.ts';
import { type AppContext, body, connectionLimit, type Env, groupAccess } from './context.ts';

interface Row {
  id: string;
  groupId: string;
  name: string;
  format: WebhookFormat;
  urlEnc: string;
  secretEnc: string | null;
  events: WebhookInfo['events'];
  enabled: boolean;
  createdAt: unknown;
  updatedAt: unknown;
}

const COLUMNS = `id, group_id as "groupId", name, format, url_enc as "urlEnc", secret_enc as "secretEnc",
  events, enabled, created_at as "createdAt", updated_at as "updatedAt"`;

export const registerWebhooks = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  const masked = (enc: string) => {
    try {
      return maskWebhookUrl(decrypt(enc));
    } catch {
      return '（无法解密：DOWEL_SECRET 可能被修改过）';
    }
  };

  const lastDelivery = async (id: string): Promise<WebhookDelivery | null> => {
    const [r] = await db.query<DeliveryRow>(
      `select ${DELIVERY_COLUMNS} from webhook_deliveries where webhook_id = $1 order by at desc, id desc limit 1`,
      [id],
    );
    return r ? deliveryOf(r) : null;
  };

  const info = async (r: Row): Promise<WebhookInfo> => ({
    id: r.id,
    name: r.name,
    format: r.format,
    urlMasked: masked(r.urlEnc),
    hasSecret: Boolean(r.secretEnc),
    events: r.events,
    enabled: Boolean(r.enabled),
    createdAt: atOf(r.createdAt),
    updatedAt: atOf(r.updatedAt),
    lastDelivery: await lastDelivery(r.id),
  });

  /** 这个组里的 Webhook；不属于这个组（或不存在）→ 404 */
  const hookOf = async (groupId: string, id: string): Promise<Row> => {
    const [r] = await db.query<Row>(`select ${COLUMNS} from webhooks where id = $1 and group_id = $2`, [
      id,
      groupId,
    ]);
    if (!r) throw new HTTPException(404, { message: 'Webhook 不存在' });
    return r;
  };

  /** 保存前检查 URL：只允许 http / https，主机要通过出站限制（默认只允许公网，webhookAllowlist 额外放行） */
  const checkUrl = async (url: string) => {
    const problem = await webhookUrlProblem(url, (await readSettings(db)).webhookAllowlist);
    if (problem) throw new HTTPException(422, { message: problem });
  };

  const auditEntry = (c: Context<Env>, action: string, id: string, data: Record<string, unknown>) => ({
    action,
    actorKind: 'user' as const,
    actorId: c.get('user').id,
    targetKind: 'webhook',
    targetId: id,
    data,
  });

  app.get('/api/groups/:slug/webhooks', async (c) => {
    const g = await groupAccess(c, ctx, 'group.manage_webhooks');
    const rows = await db.query<Row>(
      `select ${COLUMNS} from webhooks where group_id = $1 order by created_at, id`,
      [g.id],
    );
    return c.json<WebhookInfo[]>(await Promise.all(rows.map(info)));
  });

  app.post('/api/groups/:slug/webhooks', async (c) => {
    const g = await groupAccess(c, ctx, 'group.manage_webhooks');
    const b = await body(c, webhookCreateSchema);
    await checkUrl(b.url);
    const id = newId();
    const now = new Date().toISOString();
    const secret = b.secret ? b.secret : null;
    await db.transaction(async (tx) => {
      await tx.query(
        `insert into webhooks (id, group_id, name, format, url_enc, secret_enc, events, enabled, created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10, $10)`,
        [
          id,
          g.id,
          b.name,
          b.format,
          encrypt(b.url),
          secret === null ? null : encrypt(secret),
          JSON.stringify(b.events),
          b.enabled,
          c.get('user').id,
          now,
        ],
      );
      await auditIn(
        tx,
        c,
        auditEntry(c, 'webhook.create', id, {
          groupId: g.id,
          name: b.name,
          format: b.format,
          events: b.events,
          enabled: b.enabled,
          hasSecret: secret !== null,
        }),
        ctx.security,
      );
    });
    return c.json<WebhookInfo>(await info(await hookOf(g.id, id)), 201);
  });

  app.patch('/api/groups/:slug/webhooks/:id', async (c) => {
    const g = await groupAccess(c, ctx, 'group.manage_webhooks');
    const b = await body(c, webhookPatchSchema);
    const before = await hookOf(g.id, c.req.param('id'));
    if (b.url !== undefined) await checkUrl(b.url);
    const sets: string[] = [];
    const params: unknown[] = [before.id];
    const set = (column: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (b.name !== undefined) set('name', b.name);
    if (b.format !== undefined) set('format', b.format);
    if (b.url !== undefined) set('url_enc', encrypt(b.url));
    // secret：字符串 = 换新（空字符串当作清除），null = 清除，不给 = 不变
    if (b.secret !== undefined) set('secret_enc', b.secret ? encrypt(b.secret) : null);
    if (b.events !== undefined) set('events', JSON.stringify(b.events), '::text::jsonb');
    if (b.enabled !== undefined) set('enabled', b.enabled);
    set('updated_at', new Date().toISOString());
    await db.transaction(async (tx) => {
      await tx.query(`update webhooks set ${sets.join(', ')} where id = $1`, params);
      await auditIn(
        tx,
        c,
        auditEntry(c, 'webhook.update', before.id, {
          groupId: g.id,
          name: b.name ?? before.name,
          format: b.format ?? before.format,
          events: b.events ?? before.events,
          enabled: b.enabled ?? Boolean(before.enabled),
          // 只记“改没改”，不记 URL 和密钥本身
          urlChanged: b.url !== undefined,
          secretChanged: b.secret !== undefined,
          ...(b.secret !== undefined ? { hasSecret: Boolean(b.secret) } : {}),
        }),
        ctx.security,
      );
    });
    return c.json<WebhookInfo>(await info(await hookOf(g.id, before.id)));
  });

  app.delete('/api/groups/:slug/webhooks/:id', async (c) => {
    const g = await groupAccess(c, ctx, 'group.manage_webhooks');
    const before = await hookOf(g.id, c.req.param('id'));
    await db.transaction(async (tx) => {
      await tx.query('delete from webhooks where id = $1', [before.id]);
      await auditIn(
        tx,
        c,
        auditEntry(c, 'webhook.delete', before.id, {
          groupId: g.id,
          name: before.name,
          format: before.format,
          events: before.events,
        }),
        ctx.security,
      );
    });
    return c.json<Ok>({ ok: true });
  });

  app.get('/api/groups/:slug/webhooks/:id/deliveries', async (c) => {
    const g = await groupAccess(c, ctx, 'group.manage_webhooks');
    const hook = await hookOf(g.id, c.req.param('id'));
    const rows = await db.query<DeliveryRow>(
      `select ${DELIVERY_COLUMNS} from webhook_deliveries where webhook_id = $1
       order by at desc, id desc limit ${KEEP_DELIVERIES}`,
      [hook.id],
    );
    return c.json<WebhookDelivery[]>(rows.map(deliveryOf));
  });

  app.post('/api/groups/:slug/webhooks/:id/test', async (c) => {
    const g = await groupAccess(c, ctx, 'group.manage_webhooks');
    const hook = await hookOf(g.id, c.req.param('id'));
    // 服务端替用户发出站请求：和连接检查共用限速（每个用户每分钟 10 次）
    connectionLimit(c, ctx);
    const delivery = await ctx.webhooks.test(hook.id, g.name);
    await audit(
      db,
      c,
      auditEntry(c, 'webhook.test', hook.id, {
        groupId: g.id,
        name: hook.name,
        format: hook.format,
        ok: delivery.ok,
        status: delivery.status,
      }),
      ctx.security,
    );
    return c.json<WebhookDelivery>(delivery);
  });
};
