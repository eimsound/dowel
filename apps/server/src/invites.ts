// 邀请链接与重置密码链接：一次性令牌，库里只存哈希（02-consensus.md 11.1）。
// 两者共用 invites 表，用 kind 区分：invite 用来创建用户，reset 用来给已有用户设新密码。

import type { InviteInfo, InviteListItem } from '@dowel/api';
import { newId } from '@dowel/core';
import type { Db } from '@dowel/engines';
import { hashToken, newToken } from './auth.ts';

export type InviteKind = 'invite' | 'reset';

export interface Invite {
  id: string;
  kind: InviteKind;
  userId: string | null;
  createdBy: string | null;
  groupIds: string[];
  createdAt: string;
  expiresAt: string;
  usedBy: string | null;
  usedAt: string | null;
  revokedAt: string | null;
}

export type InviteState = 'ok' | 'used' | 'revoked' | 'expired';

const COLUMNS = `i.id, i.kind, i.user_id as "userId", i.created_by as "createdBy", i.group_ids as "groupIds",
  i.created_at as "createdAt", i.expires_at as "expiresAt", i.used_by as "usedBy", i.used_at as "usedAt",
  i.revoked_at as "revokedAt"`;

export const inviteState = (invite: Invite, now = new Date()): InviteState => {
  // 先判 used：用过的邀请即便后来又被处理（或过期）也还是“已使用”
  if (invite.usedAt) return 'used';
  if (invite.revokedAt) return 'revoked';
  return Date.parse(invite.expiresAt) <= now.getTime() ? 'expired' : 'ok';
};

/** 链接路径：邀请 `/invite/<token>`，重置密码 `/reset/<token>` */
export const invitePath = (kind: InviteKind, token: string) =>
  kind === 'reset' ? `/reset/${token}` : `/invite/${token}`;

/**
 * 建一个一次性链接。邀请默认 7 天，重置密码 24 小时（由调用方传 expiresInMs）。
 */
export const createInvite = async (
  db: Db,
  input: {
    kind: InviteKind;
    createdBy: string;
    userId?: string | null;
    expiresInMs: number;
    groupIds?: string[];
  },
): Promise<{ invite: Invite; token: string; url: string }> => {
  const token = newToken();
  const id = newId();
  const expiresAt = new Date(Date.now() + input.expiresInMs).toISOString();
  await db.query(
    `insert into invites (id, kind, token_hash, user_id, created_by, group_ids, expires_at)
     values ($1, $2, $3, $4, $5, $6::text::jsonb, $7)`,
    [
      id,
      input.kind,
      hashToken(token),
      input.userId ?? null,
      input.createdBy,
      JSON.stringify(input.groupIds ?? []),
      expiresAt,
    ],
  );
  const [invite] = await db.query<Invite>(`select ${COLUMNS} from invites i where i.id = $1`, [id]);
  return { invite: invite!, token, url: invitePath(input.kind, token) };
};

/** 按令牌查邀请；令牌只存哈希，所以按哈希查 */
export const inviteByToken = async (db: Db, token: string): Promise<Invite | null> => {
  const [invite] = await db.query<Invite>(`select ${COLUMNS} from invites i where i.token_hash = $1`, [
    hashToken(token),
  ]);
  return invite ?? null;
};

export const inviteById = async (db: Db, id: string): Promise<Invite | null> => {
  const [invite] = await db.query<Invite>(`select ${COLUMNS} from invites i where i.id = $1`, [id]);
  return invite ?? null;
};

/**
 * 认领令牌：“未使用、未撤销、未过期”才能认领成功（UPDATE 与条件判断是同一条语句，不会被并发绕过）。
 * 并发接受同一个邀请时只有一个请求能拿到；认领不到返回 null。
 */
export const claimInvite = async (
  db: Db,
  input: { token: string; kind: InviteKind; usedBy?: string | null },
): Promise<Invite | null> => {
  const now = new Date().toISOString();
  const rows = await db.query<Invite>(
    `update invites set used_at = $3, used_by = $4
      where token_hash = $1 and kind = $2
        and used_at is null and revoked_at is null and expires_at > $3
      returning id, kind, token_hash, user_id as "userId", created_by as "createdBy",
                created_at as "createdAt", expires_at as "expiresAt",
                used_by as "usedBy", used_at as "usedAt", revoked_at as "revokedAt"`,
    [hashToken(input.token), input.kind, now, input.usedBy ?? null],
  );
  return rows[0] ?? null;
};

/** 接受邀请时先认领、再建用户，建完把使用人补上（仍在同一个事务里） */
export const setInviteUsedBy = async (db: Db, id: string, userId: string) => {
  await db.query('update invites set used_by = $2 where id = $1', [id, userId]);
};

/** 撤销：只撤销未使用的邀请；已使用的返回 false（调用方给 409） */
export const revokeInvite = async (db: Db, id: string) => {
  const rows = await db.query<{ id: string }>(
    `update invites set revoked_at = $2
      where id = $1 and used_at is null and revoked_at is null returning id`,
    [id, new Date().toISOString()],
  );
  return rows.length > 0;
};

/** 管理员列表：只列邀请（重置链接不在管理界面里展示） */
export const listInvites = async (db: Db): Promise<InviteListItem[]> => {
  const rows = await db.query<InviteListItem & { usedAt: string | null }>(
    `select i.id, i.created_at as "createdAt", i.expires_at as "expiresAt",
            cu.username as "createdBy", uu.username as "usedBy", i.used_at as "usedAt",
            i.revoked_at as "revokedAt"
       from invites i
       left join users cu on cu.id = i.created_by
       left join users uu on uu.id = i.used_by
      where i.kind = 'invite' order by i.created_at desc`,
  );
  return rows.map((r) => ({
    ...r,
    state: inviteState({
      id: r.id,
      kind: 'invite',
      userId: null,
      createdBy: null,
      groupIds: [],
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      usedBy: null,
      usedAt: r.usedAt,
      revokedAt: r.revokedAt,
    }),
  }));
};

/** 公开接口返回的邀请信息：只说明有效性，不暴露是谁创建的 */
export const inviteInfo = (invite: Invite | null, instanceName: string): InviteInfo => {
  if (invite?.kind !== 'invite') return { valid: false, state: 'missing', instanceName, expiresAt: null };
  const state = inviteState(invite);
  return { valid: state === 'ok', state, instanceName, expiresAt: invite.expiresAt };
};
