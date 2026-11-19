// 环境的共用数据：列表 / 状态 / 历史的查询、漂移警告的判断、执行接口的 SSE 读取。
import type { EnvHistory, EnvInfo, EnvStatus, ExecErrorDetails, ExecEvent, ExecPolicy } from '@dowel/api';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api.ts';
import { readSse } from './sse.ts';

export const useEnvs = (pid: string | undefined) =>
  useQuery({
    queryKey: ['envs', pid],
    queryFn: () => api<EnvInfo[]>('GET', `/api/projects/${pid}/environments`),
    enabled: !!pid,
  });

export const useEnvStatus = (pid: string, eid: string) =>
  useQuery({
    queryKey: ['env-status', pid, eid],
    queryFn: () => api<EnvStatus>('GET', `/api/projects/${pid}/environments/${eid}/status`),
  });

/** 执行历史要连目标库读 dowel.history：连不上就显示错误，不自动重试（接口有限速） */
export const useEnvHistory = (pid: string, eid: string) =>
  useQuery({
    queryKey: ['env-history', pid, eid],
    queryFn: () => api<EnvHistory>('GET', `/api/projects/${pid}/environments/${eid}/history`),
  });

/** 有漂移（或检查失败）的环境：图标栏、概览的警告用 */
export const driftWarnings = (envs: EnvInfo[] | undefined) =>
  (envs ?? []).filter((e) => e.drift.status === 'drifted' || e.drift.status === 'error');

export const EXEC_POLICIES: ExecPolicy[] = ['editor', 'admin', 'executor'];

/**
 * 读执行 / 回滚 / 写基线的 SSE：每条消息 `data: {ExecEvent JSON}`（解析见 sse.ts）。
 * 请求本身被拒绝（403 / 422 / 404，还没开始流）抛 ApiError；流里出错是最后一条带 error 的事件，由调用方处理。
 */
export const streamExec = async (
  path: string,
  body: unknown,
  onEvent: (e: ExecEvent) => void,
): Promise<void> => {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? res.statusText, data);
  }
  await readSse(res, (data) => onEvent(JSON.parse(data) as ExecEvent));
};

export type { ExecErrorDetails };
