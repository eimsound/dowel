// 审计日志：记录谁在什么时候、从哪里对什么对象做了什么。
// 写失败不阻断业务（只打印错误）：审计是旁路，不能因为审计表的问题让用户的正常操作失败。

import { newId } from '@dowel/core';
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

export const audit = async (
  db: PlatformDb,
  c: Context,
  entry: AuditEntry,
  security: SecurityConfig = securityConfigFromEnv(),
): Promise<void> => {
  try {
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
        clientIp(c, security),
        entry.data === undefined ? null : JSON.stringify(entry.data),
      ],
    );
  } catch (e) {
    console.error('写审计日志失败', e);
  }
};
