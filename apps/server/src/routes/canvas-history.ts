// 画布修改历史（C4）：浏览工作副本的提交时间线、查看任意历史点的单步差异 / 完整模型 / 与当前画布差异，
// 以及一键恢复到此状态（作为新提交写入，不破坏历史）。
import {
  type CanvasHistoryConflict,
  type CanvasHistoryDetail,
  type CanvasHistoryList,
  canvasHistoryRestoreSchema,
  type ModelUpdate,
} from '@dowel/api';
import { deepEqual, type Model } from '@dowel/core';
import { planDiff } from '@dowel/executor';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { audit } from '../audit.ts';
import { WorkingChangedError } from '../rooms.ts';
import { type AppContext, access, body, type Env } from './context.ts';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const parseSeqParam = (raw: string | undefined): number => {
  if (!raw || !/^\d+$/.test(raw)) throw new HTTPException(400, { message: '无效的历史序号' });
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new HTTPException(400, { message: '无效的历史序号' });
  return n;
};

const parseOptInt = (raw: string | undefined, name: string): number | undefined => {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) throw new HTTPException(400, { message: `无效的参数：${name}` });
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new HTTPException(400, { message: `无效的参数：${name}` });
  return n;
};

export const registerCanvasHistory = (app: Hono<Env>, ctx: AppContext) => {
  const { db, rooms, refresher } = ctx;

  app.get('/api/projects/:pid/history', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const beforeSeq = parseOptInt(c.req.query('beforeSeq'), 'beforeSeq');
    const rawLimit = parseOptInt(c.req.query('limit'), 'limit');
    const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit ?? DEFAULT_LIMIT));
    const list = await rooms.listHistory(a.branch, { beforeSeq, limit });
    return c.json<CanvasHistoryList>(list);
  });

  app.get('/api/projects/:pid/history/:seq', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const seq = parseSeqParam(c.req.param('seq'));
    await refresher.flush(a.branch);
    const { model: currentModel, seq: currentSeq } = await rooms.model(a.branch);
    const targetModel = await rooms.modelAt(a.branch, seq);
    const prevModel = seq > 0 ? await rooms.modelAt(a.branch, seq - 1) : null;
    const opDiff = prevModel ? planDiff(prevModel, targetModel) : { total: 0, items: [] };
    const diffToCurrent = planDiff(currentModel, targetModel);
    const entry = await rooms.historyEntry(a.branch, seq, { prevModel, targetModel, currentSeq });
    return c.json<CanvasHistoryDetail<Model>>({
      entry,
      opDiff,
      model: targetModel,
      diffToCurrent,
      currentSeq,
    });
  });

  app.post('/api/projects/:pid/history/:seq/restore', async (c) => {
    const a = await access(c, ctx, 'sync.edit');
    const seq = parseSeqParam(c.req.param('seq'));
    const b = await body(c, canvasHistoryRestoreSchema);
    await refresher.flush(a.branch);
    const { model: currentModel, seq: currentSeq } = await rooms.model(a.branch);
    const targetModel = await rooms.modelAt(a.branch, seq);
    const conflictOf = (curSeq: number, curModel: Model) =>
      c.json<CanvasHistoryConflict>(
        {
          error: '工作副本在你查看期间已被修改，请确认最新差异后再恢复',
          code: 'working_changed',
          currentSeq: curSeq,
          diffToCurrent: planDiff(curModel, targetModel),
        },
        409,
      );
    if (b.workingSeq !== currentSeq) return conflictOf(currentSeq, currentModel);
    const diffToCurrent = planDiff(currentModel, targetModel);
    if (diffToCurrent.total === 0 && deepEqual(currentModel, targetModel)) {
      return c.json<ModelUpdate>({
        seq: currentSeq,
        objects: Object.keys(currentModel.objects).length,
      });
    }
    const fromSeq = currentSeq;
    try {
      await ctx.replace(a.branch, c.get('user').name, targetModel, 'restoreHistory', b.workingSeq);
    } catch (e) {
      if (e instanceof WorkingChangedError) return conflictOf(e.currentSeq, e.currentModel);
      throw e;
    }
    const next = await rooms.model(a.branch);
    await audit(
      db,
      c,
      {
        action: 'model.restore',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'project',
        targetId: a.pid,
        projectId: a.pid,
        data: { fromSeq, restoredSeq: seq, newSeq: next.seq },
      },
      ctx.security,
    );
    return c.json<ModelUpdate>({
      seq: next.seq,
      objects: Object.keys(next.model.objects).length,
    });
  });
};
