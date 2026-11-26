// 画布修改历史（C4）：浏览工作副本的提交时间线（默认按编辑会话读时归组，ADR 0015 §4）、
// 查看任意历史点（或整组）的差异 / 完整模型 / 与当前画布差异、展开组内单步，
// 以及一键恢复到此状态（作为新提交写入，不破坏历史）。
import {
  CANVAS_HISTORY_GROUP_MAX_STEPS,
  type CanvasHistoryConflict,
  type CanvasHistoryDetail,
  type CanvasHistoryList,
  canvasHistoryRestoreSchema,
  type CanvasHistorySteps,
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

const parseGrouped = (raw: string | undefined): boolean => {
  if (raw === undefined || raw === '') return true;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new HTTPException(400, { message: '无效的参数：grouped' });
};

/** 校验区间 [from, seq]：1 <= from <= seq 且步数不超过单组上限 */
const assertRange = (from: number, seq: number) => {
  if (seq < 1 || from < 1 || from > seq || seq - from + 1 > CANVAS_HISTORY_GROUP_MAX_STEPS)
    throw new HTTPException(400, { message: '无效的历史区间' });
};

export const registerCanvasHistory = (app: Hono<Env>, ctx: AppContext) => {
  const { db, rooms, refresher } = ctx;

  app.get('/api/projects/:pid/history', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const beforeSeq = parseOptInt(c.req.query('beforeSeq'), 'beforeSeq');
    const rawLimit = parseOptInt(c.req.query('limit'), 'limit');
    const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit ?? DEFAULT_LIMIT));
    const grouped = parseGrouped(c.req.query('grouped'));
    const list = await rooms.listHistory(a.branch, { beforeSeq, limit, grouped });
    return c.json<CanvasHistoryList>(list);
  });

  app.get('/api/projects/:pid/history/:seq', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const seq = parseSeqParam(c.req.param('seq'));
    const from = parseOptInt(c.req.query('from'), 'from');
    if (from !== undefined && from !== seq) assertRange(from, seq);
    await refresher.flush(a.branch);
    const { model: currentModel, seq: currentSeq } = await rooms.model(a.branch);
    if (from !== undefined && from !== seq) {
      // 整组净差异：只重建一次 modelAt(from - 1)，在内存中顺次重放 [from..seq]（不从快照重放两次）
      if (seq > currentSeq) throw new HTTPException(404, { message: `修改记录 #${seq} 不存在` });
      const { entry, prevModel, targetModel } = await rooms.historyRange(a.branch, from, seq, currentSeq);
      return c.json<CanvasHistoryDetail<Model>>({
        entry,
        opDiff: planDiff(prevModel, targetModel),
        model: targetModel,
        diffToCurrent: planDiff(currentModel, targetModel),
        currentSeq,
      });
    }
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

  // 展开编辑会话组：组内逐条单步（倒序，不含 seq = 0）
  app.get('/api/projects/:pid/history/:seq/steps', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const seq = parseSeqParam(c.req.param('seq'));
    const from = parseOptInt(c.req.query('from'), 'from');
    if (from === undefined) throw new HTTPException(400, { message: '缺少参数：from' });
    assertRange(from, seq);
    await refresher.flush(a.branch);
    const { seq: currentSeq } = await rooms.model(a.branch);
    if (seq > currentSeq) throw new HTTPException(404, { message: `修改记录 #${seq} 不存在` });
    const steps = await rooms.historySteps(a.branch, from, seq, currentSeq);
    return c.json<CanvasHistorySteps>({ steps, currentSeq });
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
