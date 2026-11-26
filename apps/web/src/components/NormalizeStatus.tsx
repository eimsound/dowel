// 模型页状态栏里的“表达式规范化”状态与手动按钮（ADR 0016）：编辑期间不自动回影子库，
// 这里显示工作副本相对黄金基线有几处待规范化，编辑者可以随时点“规范化”在影子库里校验并写回规范形式。
// 布局见 DESIGN.md「状态栏」与 .agents/docs/ui/mockups/shell.html 的模型页状态栏。
import type { NormalizeResult, NormalizeStatus as NormalizeStatusBody } from '@dowel/api';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api.ts';
import { normalizeToast } from '../envs.ts';
import { useToast } from './Toasts.tsx';

/** 状态查询跟着工作副本 seq 防抖，连续编辑时不刷屏请求 */
const SEQ_DEBOUNCE_MS = 300;

const useDebounced = <T,>(value: T, ms: number): T => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
};

export const NormalizeStatus = ({
  pid,
  seq,
  synced,
  readOnly,
}: {
  pid: string;
  /** 工作副本当前 seq（变化后重新查询状态） */
  seq: number;
  /** 已连接且没有待确认的本地修改 */
  synced: boolean;
  readOnly: boolean;
}) => {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const descId = useId();
  const debouncedSeq = useDebounced(seq, SEQ_DEBOUNCE_MS);
  const q = useQuery({
    queryKey: ['normalize', pid, debouncedSeq],
    queryFn: () => api<NormalizeStatusBody>('GET', `/api/projects/${pid}/normalize`),
    enabled: synced,
    placeholderData: keepPreviousData,
  });
  const run = useMutation({
    mutationFn: () => api<NormalizeResult>('POST', `/api/projects/${pid}/normalize`, {}),
    onSuccess: (res) => {
      // 写回推进了 seq、改了表达式：状态、迁移、DDL、画布历史都要重新取（#32）
      for (const key of ['normalize', 'migration', 'ddl', 'canvas-history', 'history-head']) {
        void qc.invalidateQueries({ queryKey: [key, pid] });
      }
      toast(normalizeToast(res, t), res.outcome === 'normalized' ? 'info' : 'notice');
    },
    onError: (e) => {
      toast(e instanceof ApiError ? e.message : t('ws.normalize.failed'), 'error');
    },
  });

  const st = q.data;
  const count = st?.pendingCount ?? 0;
  const noShadow = st?.shadow === 'none';
  const running = run.isPending;
  /** 不能点的原因（按钮保持在 Tab 顺序里，点了给出中性提示） */
  const blocked = !synced ? t('ws.normalize.notSynced') : noShadow ? t('ws.normalize.noShadow') : null;
  const describe = blocked ?? (count > 0 ? t('ws.normalize.pending', { count }) : t('ws.normalize.clean'));

  return (
    <span className="flex items-center gap-1.5">
      {st && (
        <span
          className="flex items-center gap-1.5"
          title={readOnly && count > 0 ? t('ws.normalize.viewerTip') : undefined}
        >
          <span aria-hidden="true" className={`size-[7px] rounded-full ${count > 0 ? 'bg-warn' : 'bg-ok'}`} />
          {count > 0 ? t('ws.normalize.pending', { count }) : t('ws.normalize.clean')}
        </span>
      )}
      {!readOnly && (
        <>
          <button
            type="button"
            className="btn ghost sm px-1.5 text-xs"
            disabled={running}
            aria-busy={running || undefined}
            aria-disabled={(!running && blocked !== null) || undefined}
            aria-describedby={descId}
            onClick={() => {
              if (blocked) {
                toast(blocked, 'notice');
                return;
              }
              run.mutate();
            }}
          >
            <RefreshCw size={12} aria-hidden="true" className={running ? 'animate-spin' : undefined} />
            {running ? t('ws.normalize.running') : t('ws.normalize.action')}
          </button>
          <span id={descId} className="sr-only">
            {describe}
          </span>
        </>
      )}
    </span>
  );
};
