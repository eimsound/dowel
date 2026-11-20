// 审计日志：记录谁在什么时候、从哪里对什么对象做了什么。
// 写失败不阻断业务（只打印错误）：审计是旁路，不能因为审计表的问题让用户的正常操作失败。

import { newId } from '@dowel/core';
import type { Db } from '@dowel/engines';
import type { Context } from 'hono';
import type { PlatformDb } from './db.ts';
import { clientIp, type SecurityConfig, securityConfigFromEnv } from './security.ts';

export type ActorKind = 'user' | 'token' | 'system';

export interface AuditEntry {
  action: string;
  actorKind?: ActorKind;
  actorId?: string | null;
  targetKind?: string | null;
  targetId?: string | null;
  /** 与项目相关的操作用它归类，项目动态只按这一列过滤 */
  projectId?: string | null;
  data?: unknown;
}

/**
 * 严格版：在调用方的事务里写审计，**失败就抛出**（不吞）——审计和被审计的写入同生共死。
 * 事务里不能用吞错的 audit()：PG 的事务里一条语句失败后整个事务已中止，吞掉错误只会让后面的语句和提交莫名其妙地失败。
 * c 为 null：不是由请求触发的（定时清理过期 / 失效的执行申请等系统动作），没有来源 IP。
 */
export const auditIn = async (
  db: Db,
  c: Context | null,
  entry: AuditEntry,
  security: SecurityConfig = securityConfigFromEnv(),
): Promise<void> => {
  await db.query(
    `insert into audit_events (id, actor_kind, actor_id, action, target_kind, target_id, project_id, ip, data)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb)`,
    [
      newId(),
      entry.actorKind ?? 'system',
      entry.actorId ?? null,
      entry.action,
      entry.targetKind ?? null,
      entry.targetId ?? null,
      entry.projectId ?? null,
      c ? clientIp(c, security) : null,
      entry.data === undefined ? null : JSON.stringify(entry.data),
    ],
  );
};

export const audit = async (
  db: PlatformDb,
  c: Context,
  entry: AuditEntry,
  security: SecurityConfig = securityConfigFromEnv(),
): Promise<void> => {
  try {
    await auditIn(db, c, entry, security);
  } catch (e) {
    console.error('写审计日志失败', e);
  }
};
