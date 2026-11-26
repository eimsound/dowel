// WS 同步 client 的服务端隔离：内部键绑定 `${userId}:${rawClient}`，下发前经 forPeer() 仅对本人还原原始 client。

import { type Op, SYSTEM_CLIENT, type ToClient } from '@dowel/sync';

import type { Peer } from './types.ts';

/** 将客户端上报的 client 标识绑定到当前认证用户，在 Room 幂等表与持久化层跨副本彻底隔离不同用户 */
export const scopeClient = (userId: string, client: string): string => `${userId}:${client}`;

/** 将客户端待确认版本引用 `p:${rawClient}:${n}` 改写为绑定用户后的 `p:${scopedClient}:${n}` */
export const rewriteReadsToScoped = (
  reads: Op['reads'],
  rawClient: string,
  scopedClient: string,
): Op['reads'] => {
  const prefix = `p:${rawClient}:`;
  return reads.map(([id, seen]) => {
    if (typeof seen === 'string' && seen.startsWith(prefix)) {
      return [id, `p:${scopedClient}:${seen.slice(prefix.length)}`];
    }
    return [id, seen];
  });
};

export const syncClientOf = (peer: Peer): string | null =>
  peer.client ? scopeClient(peer.user.id, peer.client) : null;

/** 发给客户端前映射 commit.client：本连接自己的提交还原为原始 client，系统提交保持 system，他人提交不暴露内部键且不与本连接冲突 */
export const forPeer = (peer: Peer, msg: ToClient): ToClient => {
  if (msg.t !== 'commit') return msg;
  const ownSync = syncClientOf(peer);
  if (ownSync && msg.client === ownSync) {
    return { ...msg, client: peer.client! };
  }
  if (msg.client === SYSTEM_CLIENT) return msg;
  return { ...msg, client: '' };
};
