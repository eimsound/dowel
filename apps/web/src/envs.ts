// 环境的共用数据：列表 / 状态 / 历史的查询、漂移警告的判断、执行接口的 SSE 读取。
import type {
  AttachResult,
  EnvHistory,
  EnvInfo,
  EnvStatus,
  ExecErrorDetails,
  ExecEvent,
  ExecPolicy,
  NormalizeResult,
} from '@dowel/api';
import { type Dialect, getDialect } from '@dowel/core';
import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';

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

/** 接入已有历史成功后的提示文案：按是否接入、领先版本、当前版本与认领状态选择完整整句，避免句末拼接双标点或渲染 v— */
export const attachSuccessMessage = (
  t: TFunction,
  name: string,
  result: Pick<AttachResult, 'attached' | 'claimed' | 'currentVersion' | 'aheadVersions'>,
): string => {
  if (!result.attached) return t('tk.attachedNone', { name });
  const aheadCount = result.aheadVersions?.length ?? 0;
  const version = result.currentVersion?.number;
  if (aheadCount > 0) {
    if (version !== undefined) {
      return t(result.claimed ? 'tk.attachedAheadOkClaimed' : 'tk.attachedAheadOk', {
        name,
        count: aheadCount,
        number: version,
      });
    }
    return t(result.claimed ? 'tk.attachedAheadNoVersionClaimed' : 'tk.attachedAheadNoVersion', {
      name,
      count: aheadCount,
    });
  }
  if (version !== undefined) {
    return t(result.claimed ? 'tk.attachedOkClaimed' : 'tk.attachedOk', { name, number: version });
  }
  return t(result.claimed ? 'tk.attachedNoVersionClaimed' : 'tk.attachedNoVersion', { name });
};

/** 接入领先环境时若识别并自动作废了不在活跃主链上的岔路版本，生成补充提示文案 */
export const attachRetiredMessage = (
  t: TFunction,
  retiredVersions: Pick<AttachResult, 'retiredVersions'>['retiredVersions'] | undefined,
): string | null => {
  if (!retiredVersions?.length) return null;
  return t('tk.attachedRetired', {
    list: retiredVersions.map((v) => `v${v.number}`).join(t('vl.listSep')),
  });
};

/**
 * 读执行 / 回滚的 SSE：每条消息 `data: {ExecEvent JSON}`（解析见 sse.ts）。
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

/**
 * 状态栏显示的按需规范化影子库来源，与服务端 `Shadows.forProjectTarget` 的选影一致（仅用于按需规范化；
 * 发布与重新验证按数据库完整版本号逐组选影）：
 * 1. 按目标库版本组（`DialectVersionMatrix.groupKeyOf(engineVersionNum)`）分组，已知版本组升序在前、未探测的在后，
 *    优先最低已知版本组；该组没有可用影子库时依次回退到下一组；
 * 2. 组内按选影优先级：显式独立影子库 > 非生产环境（同实例 `{库名}_dowel`）> 允许同实例的生产环境。
 * 都不可用时返回 null。
 */
export const usableShadowEnv = <
  E extends Pick<EnvInfo, 'shadowUrl' | 'production' | 'allowSameInstance' | 'engineVersionNum'>,
>(
  envs: readonly E[] | undefined,
  dialect: Dialect = 'pg',
): E | null => {
  const rank = (e: E) => (e.shadowUrl != null ? 0 : !e.production ? 1 : e.allowSameInstance ? 2 : 3);
  const matrix = getDialect(dialect).versioning.matrix;
  const groupOf = (e: E) => matrix?.groupKeyOf(e.engineVersionNum) ?? null;
  const groups = new Map<number | null, E[]>();
  for (const e of envs ?? []) {
    const k = groupOf(e);
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }
  const keys = [...groups.keys()].filter((k): k is number => k !== null).sort((a, b) => a - b);
  const ordered: (number | null)[] = [...keys, ...(groups.has(null) ? [null] : [])];
  for (const k of ordered) {
    let best: E | null = null;
    for (const e of groups.get(k) ?? []) {
      if (rank(e) < 3 && (best === null || rank(e) < rank(best))) best = e;
    }
    if (best) return best;
  }
  return null;
};

/** 手动规范化成功后的提示文案 */
export const normalizeToast = (
  res: Pick<NormalizeResult, 'outcome' | 'normalizedCount' | 'shadow'>,
  t: TFunction,
): string =>
  res.outcome === 'normalized'
    ? t('ws.normalize.normalized', { count: res.normalizedCount, shadow: res.shadow })
    : res.outcome === 'verified'
      ? t('ws.normalize.verifiedClean', { shadow: res.shadow })
      : t('ws.normalize.alreadyClean');
