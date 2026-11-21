// 执行申请与收件箱（P5b）的查询和实时更新。
// 实时：外壳里连一条 /api/me/inbox/stream（SSE），收到未读数就写进缓存，收到“申请有变化”就让相关查询失效。
import type {
  ExecRequestDetail,
  ExecRequestSummary,
  InboxEvent,
  InboxList,
  PendingRequest,
  RequestStatus,
} from '@dowel/api';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from './api.ts';

/** 环境上还没结束的申请（待审批、已通过、执行中、执行失败） */
export const useEnvRequests = (pid: string, eid: string) =>
  useQuery({
    queryKey: ['requests', pid, eid],
    queryFn: () =>
      api<ExecRequestSummary[]>(
        'GET',
        `/api/projects/${pid}/requests?environment=${encodeURIComponent(eid)}&status=open`,
      ),
  });

export const useRequest = (pid: string, rid: string) =>
  useQuery({
    queryKey: ['request', pid, rid],
    queryFn: () => api<ExecRequestDetail>('GET', `/api/projects/${pid}/requests/${rid}`),
  });

export const useInbox = () =>
  useQuery({ queryKey: ['inbox'], queryFn: () => api<InboxList>('GET', '/api/me/inbox') });

export const usePending = () =>
  useQuery({
    queryKey: ['inbox-pending'],
    queryFn: () => api<PendingRequest[]>('GET', '/api/me/inbox/pending'),
  });

export const useMyRequests = () =>
  useQuery({
    queryKey: ['my-requests'],
    queryFn: () => api<ExecRequestSummary[]>('GET', '/api/me/requests'),
  });

/** 图标栏的未读数：先取一次，之后由 SSE 推送更新 */
export const useUnread = () =>
  useQuery({
    queryKey: ['inbox-unread'],
    queryFn: async () => (await api<InboxList>('GET', '/api/me/inbox')).unread,
    staleTime: 60_000,
  });

/** 申请有变化：所有和申请、收件箱有关的查询都重新拉 */
export const invalidateRequests = (qc: QueryClient) =>
  Promise.all(
    ['requests', 'request', 'inbox', 'inbox-pending', 'my-requests', 'inbox-unread'].map((k) =>
      qc.invalidateQueries({ queryKey: [k] }),
    ),
  );

/**
 * 收件箱的实时更新（外壳里调用一次）。EventSource 断线会自动重连；服务端每 25 秒发一次心跳。
 * 未读数直接写进缓存；申请状态变化时让列表失效（界面上正在看的申请详情、环境页的待处理申请会刷新）。
 */
export const useInboxStream = () => {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/me/inbox/stream');
    es.onmessage = (m) => {
      let e: InboxEvent;
      try {
        e = JSON.parse(m.data) as InboxEvent;
      } catch {
        return;
      }
      if (e.unread !== undefined) {
        const prev = qc.getQueryData<number>(['inbox-unread']);
        qc.setQueryData(['inbox-unread'], e.unread);
        if (prev !== undefined && prev !== e.unread) void qc.invalidateQueries({ queryKey: ['inbox'] });
      }
      if (e.requests) void invalidateRequests(qc);
    };
    return () => es.close();
  }, [qc]);
};

/** 状态徽标的样式 */
export const STATUS_TONE: Record<RequestStatus, '' | 'ok' | 'warn' | 'danger'> = {
  pending: 'warn',
  approved: 'ok',
  executing: 'warn',
  executed: 'ok',
  failed: 'danger',
  rejected: 'danger',
  withdrawn: '',
  invalid: '',
  expired: '',
};
