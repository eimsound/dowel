// 按需规范化（ADR 0016）：编辑期间不在后台调影子库；模型页状态栏查询待规范化状态，编辑者显式触发规范化。
// - GET  /api/projects/:pid/normalize：只读状态（0 影子库 I/O、不拿 derive 锁），查看者即可；
// - POST /api/projects/:pid/normalize：在影子库里重放并写回规范形式、推进黄金基线，编辑者以上。
//   派生写回已经以 op_name = 'derive' 记入 room_commits（画布修改历史可见），这里不再写 audit_events。
import {
  type ApiErrorBody,
  type NormalizeResult,
  type NormalizeStatus,
  normalizeRequestSchema,
} from '@dowel/api';
import { getDialect, PlanError, validate } from '@dowel/core';
import { InstanceLevelStatementError, StepError } from '@dowel/verifier';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { NormalizeConflictError, RefresherStoppedError } from '../derive.ts';
import { scrubSecrets } from '../secrets.ts';
import { ShadowError } from '../shadow.ts';
import { type AppContext, access, type Env } from './context.ts';

export const registerNormalize = (app: Hono<Env>, ctx: AppContext) => {
  const { rooms, shadows, refresher } = ctx;

  app.get('/api/projects/:pid/normalize', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const [st, shadow] = await Promise.all([refresher.status(a.branch), shadows.configState(a.pid)]);
    return c.json<NormalizeStatus>({
      seq: st.seq,
      pending: st.pendingCount > 0,
      pendingCount: st.pendingCount,
      objects: st.objects,
      truncated: st.truncated,
      baseline: st.baseline,
      shadow,
    });
  });

  app.post('/api/projects/:pid/normalize', async (c) => {
    const a = await access(c, ctx, 'model.normalize');
    // 请求体可省略（等同 {}）；给了就必须严格符合 schema
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new HTTPException(400, { message: '请求不合法' });
      }
    }
    const parsed = normalizeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? '请求不合法' });
    }
    const b = parsed.data;
    const fail = (status: 409 | 422 | 503, message: string, code: string, extra?: Record<string, unknown>) =>
      c.json<ApiErrorBody & Record<string, unknown>>(
        { error: scrubSecrets(message), code, ...(extra ?? {}) },
        status,
      );

    // 外部影子库（PG / MySQL / MSSQL）要替用户连库：和其他连库入口共用连接限速（#15），没真正连库的失败精确退回（#9）
    const gate = getDialect(a.dialect).capabilities.requiresExternalShadow
      ? ctx.connectionLimiter.attempt(c.get('user').id)
      : null;
    if (gate && !gate.allowed) {
      c.header('Retry-After', String(gate.retryAfterSeconds));
      throw new HTTPException(429, { message: `影子库请求太频繁了，请 ${gate.retryAfterSeconds} 秒后再试` });
    }
    const refund = () => {
      if (gate?.allowed) gate.refund();
    };

    // 静态校验先于连库：模型本身不合法（引用缺失等），影子库里一定建不出来
    const { model: cur } = await rooms.model(a.branch);
    const problems = validate(cur);
    if (problems.length) {
      refund();
      return fail(422, `模型校验未通过，无法规范化：${problems[0]}`, 'model_invalid');
    }

    let handle: { shadow: Parameters<typeof refresher.normalize>[1]['shadow']; label: string };
    try {
      handle = b.env ? await shadows.forProject(a.pid, b.env) : await shadows.forProjectTarget(a.pid);
    } catch (e) {
      if (e instanceof ShadowError) {
        if (e.preConnect) refund();
        return fail(422, e.message, 'shadow_unavailable');
      }
      throw e;
    }

    try {
      return c.json<NormalizeResult>(await refresher.normalize(a.branch, handle));
    } catch (e) {
      if (e instanceof ShadowError) return fail(422, e.message, 'shadow_unavailable');
      if (e instanceof StepError || e instanceof PlanError || e instanceof InstanceLevelStatementError) {
        const reason = e instanceof StepError ? e.reason : e.message;
        return fail(422, `规范化失败（工作副本保持原样）：${reason}`, 'canonicalize_failed');
      }
      if (e instanceof NormalizeConflictError) {
        return fail(409, e.message, 'working_changed', { currentSeq: e.currentSeq });
      }
      if (e instanceof RefresherStoppedError) return fail(503, e.message, 'shutting_down');
      // DeriveBusyError 交给 app.onError 统一映射为 503 normalize_busy
      throw e;
    }
  });
};
