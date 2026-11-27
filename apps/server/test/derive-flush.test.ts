// OpaqueRefresher.flush() 的结果契约（Issue #135、#132 N1 / N2）：
// - 写回冲突的重试预算只属于一次 flush，give_up 之后不跨调用泄漏；
// - 只有至少一次写回被接受、且已无待规范化对象时才报 normalized；写回全被拒后别人的编辑消除了待规范化对象报 clean；
// - 跑满 MAX_CATCHUP_ROUNDS 仍有待规范化对象时如实报 skipped（round_limit），不论期间是否写回过；
// - 返回的 model / seq 就是判定所针对的房间状态（调用方不必、也不该再读一次房间）。
// 以及分支在各个 await 期间被 forget（项目删除）时 flush / normalize 都不报成功（Issue #144）。
import { emptyModel, type Model, type Obj, runMutator } from '@dowel/core';
import { describe, expect, test, vi } from 'vitest';

import { BranchForgottenError, NormalizeConflictError, OpaqueRefresher } from '../src/derive.ts';
import type { Rooms } from '../src/rooms.ts';
import type { Shadow } from '../src/shadow.ts';

const base = () => {
  const m = emptyModel();
  runMutator(m, 'createSchema', { id: 's', name: 'public' });
  runMutator(m, 'createTable', { id: 't', schema: 's', name: 'orders' });
  runMutator(m, 'addColumn', { table: 't', column: { id: 'c', name: 'total', type: 'integer' } });
  return m;
};

const exprOf = (m: Model, id: string) => (m.objects[id] as { expr: string } | undefined)?.expr;

/** 引擎的规范形式：给 CHECK 加括号和类型转换；记下调用次数 */
const canonicalShadow = (calls = { n: 0 }): Shadow =>
  ({
    canonicalize: async (_prev: Model, next: Model) => {
      calls.n++;
      return Object.values(next.objects)
        .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
        .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr}::integer)` }) as Obj);
    },
  }) as unknown as Shadow;

interface Live {
  m: Model;
  seq: number;
}

/**
 * 内存版房间。ctl.reject：接下来要拒绝的写回次数；onReject / onAccept：写回被拒 / 被接受之后
 * 模拟一次并发编辑（直接改 live，seq + 1）；beforePatch / onState：写回之前 / 每次读房间状态之前的钩子
 * （onState 拿到的是第几次读，从 1 开始）。
 */
const ctlRooms = (
  live: Live,
  ctl: {
    reject: number;
    onReject?: (live: Live) => void;
    onAccept?: (live: Live) => void;
    beforePatch?: (live: Live) => void;
    onState?: (n: number) => void;
  },
) => {
  let states = 0;
  return {
    state: async () => {
      ctl.onState?.(++states);
      return { model: structuredClone(live.m), versions: {}, seq: live.seq };
    },
    model: async () => ({ model: structuredClone(live.m), seq: live.seq }),
    patch: async (_b: string, _u: string, objects: Obj[]) => {
      ctl.beforePatch?.(live);
      if (ctl.reject > 0) {
        ctl.reject--;
        ctl.onReject?.(live);
        return { committed: false, rejected: true, seq: live.seq };
      }
      for (const o of objects) live.m.objects[o.id] = o;
      live.seq++;
      ctl.onAccept?.(live);
      return { committed: true, rejected: false, seq: live.seq };
    },
  } as unknown as Rooms;
};

const memStore = () => {
  const saved: Model[] = [];
  return {
    saved,
    store: {
      load: async () => structuredClone(saved.at(-1) ?? null),
      save: async (_b: string, m: Model) => void saved.push(structuredClone(m)),
    },
  };
};

describe('OpaqueRefresher.flush 结果契约', () => {
  test('#135 问题 1：give_up 之后，下一次独立的 flush 仍有完整的写回冲突重试预算', async () => {
    const live: Live = { m: base(), seq: 0 };
    const ctl = { reject: 4 };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, ctl), async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    // 第一次：连续 4 次被拒（> MAX_REJECT_RETRIES = 3）→ 放弃
    await expect(r.flush('b')).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'write_conflict' });
    expect(saved).toHaveLength(1);
    // 第二次独立的 flush：被拒 3 次仍在预算内，第 4 次写回成功
    ctl.reject = 3;
    const out = await r.flush('b');
    expect(out.kind).toBe('normalized');
    expect(exprOf(live.m, 'k')).toBe('(total > 0::integer)');
    expect(saved).toHaveLength(2);
  });

  test('#135 问题 2：首轮写回被拒、并发编辑消除了待规范化对象 → clean（没有写回被接受，不报 normalized）', async () => {
    const live: Live = { m: base(), seq: 0 };
    const ctl = {
      reject: 1,
      // 写回被拒的原因：别人同时把这条 CHECK 删了
      onReject: (l: Live) => {
        delete l.m.objects.k;
        l.seq++;
      },
    };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, ctl), async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const out = await r.flush('b');
    expect(out).toMatchObject({ kind: 'clean', seq: live.seq });
    expect(out.model).toEqual(live.m);
    // 没有写回被接受：基线不动
    expect(saved).toHaveLength(1);
  });

  test('N2：跑满 MAX_CATCHUP_ROUNDS 仍有待规范化对象 → skipped(round_limit)，即便期间有写回被接受', async () => {
    const live: Live = { m: base(), seq: 0 };
    let n = 0;
    const ctl = {
      reject: 0,
      // 每次写回之后都有人马上再加一条未规范化的 CHECK（持续编辑造成活锁）
      onAccept: (l: Live) => {
        runMutator(l.m, 'addCheck', { id: `k${++n}`, table: 't', expr: `total > ${n}` });
        l.seq++;
      },
    };
    const calls = { n: 0 };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, ctl), async () => canonicalShadow(calls), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const out = await r.flush('b');
    expect(calls.n).toBe(5);
    expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'round_limit', seq: live.seq });
    // 返回的模型里确实还有待规范化的对象
    expect(exprOf(out.model, `k${n}`)).toBe(`total > ${n}`);
    // 被接受的写回照常推进了基线（I3：saves <= accepted）
    expect(saved.length - 1).toBe(5);
  });

  test('N2 / #135 边界：写回全被拒时到不了轮数上限（MAX_REJECT_RETRIES 3 < MAX_CATCHUP_ROUNDS 5），第 4 次被拒即放弃', async () => {
    const live: Live = { m: base(), seq: 0 };
    const calls = { n: 0 };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, { reject: 100 }), async () => canonicalShadow(calls), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    await expect(r.flush('b')).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'write_conflict' });
    expect(calls.n).toBe(4);
    expect(saved).toHaveLength(1);
  });

  test('写回被接受后连续被拒计数清零：拒 2 次 → 接受（又冒出待规范化对象）→ 再拒 2 次 → 跑满轮数（不清零则第 4 次被拒就报 write_conflict）', async () => {
    const live: Live = { m: base(), seq: 0 };
    let added = false;
    const ctl = {
      reject: 2,
      onAccept: (l: Live) => {
        if (added) return;
        added = true;
        runMutator(l.m, 'addCheck', { id: 'k2', table: 't', expr: 'total < 100' });
        l.seq++;
        ctl.reject = 2;
      },
    };
    const { store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, ctl), async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    // 轮次：拒、拒、接受（k2 冒出来）、拒、拒 → 跑满 5 轮
    const out = await r.flush('b');
    expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'round_limit' });
    expect(exprOf(live.m, 'k')).toBe('(total > 0::integer)');
  });

  test('N1：返回的 model / seq 就是判定过的那一份；flush 之后的编辑不在里面', async () => {
    const live: Live = { m: base(), seq: 0 };
    const { store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, { reject: 0 }), async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const out = await r.flush('b');
    expect(out.kind).toBe('normalized');
    expect(out.seq).toBe(live.seq);
    expect(out.model).toEqual(live.m);
    expect(exprOf(out.model, 'k')).toBe('(total > 0::integer)');
    // 之后别人又加了一条：返回值不受影响，修改返回值也不影响房间
    runMutator(live.m, 'addCheck', { id: 'k2', table: 't', expr: 'total < 100' });
    live.seq++;
    expect(out.model.objects.k2).toBeUndefined();
    delete out.model.objects.k;
    expect(live.m.objects.k).toBeDefined();
  });

  test('停机后 flush 报 skipped(stopped)，模型原样返回', async () => {
    const live: Live = { m: base(), seq: 3 };
    const { store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, { reject: 0 }), async () => canonicalShadow(), store);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    r.stop();
    const out = await r.flush('b');
    expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'stopped', seq: 3 });
    expect(exprOf(out.model, 'k')).toBe('total > 0');
  });

  test('写回期间分支被 forget → skipped(forgotten)，且不推进基线', async () => {
    const live: Live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    let r!: OpaqueRefresher;
    const rooms = ctlRooms(live, {
      reject: 0,
      onAccept: () => {
        r.forget('b');
      },
    });
    r = new OpaqueRefresher(rooms, async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const out = await r.flush('b');
    expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'forgotten', seq: live.seq });
    expect(exprOf(out.model, 'k')).toBe('(total > 0::integer)');
    expect(saved).toHaveLength(1);
    await r.drain();
    expect(r.tracked('b')).toBe(false);
  });

  test('写回期间分支被 forget 且 rooms.patch 抛错（项目删除提交后先 forget 再踢房间）→ skipped(forgotten) 且不打失败告警', async () => {
    const live: Live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    let r!: OpaqueRefresher;
    const rooms = ctlRooms(live, {
      reject: 0,
      beforePatch: () => {
        r.forget('b');
        throw new Error('分支 b 不存在');
      },
    });
    r = new OpaqueRefresher(rooms, async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await r.flush('b');
      expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'forgotten', seq: 0 });
      expect(exprOf(out.model, 'k')).toBe('total > 0');
      expect(saved).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('写回已接受但 store.save 抛错 → skipped(store_failed) 且返回写回后的模型、基线与内存缓存均不推进', async () => {
    const live: Live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    let failSave = false;
    const flakyStore = {
      load: store.load,
      save: async (b: string, m: Model) => {
        if (failSave) throw new Error('disk io error');
        await store.save(b, m);
      },
    };
    const r = new OpaqueRefresher(ctlRooms(live, { reject: 0 }), async () => canonicalShadow(), flakyStore);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    failSave = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await r.flush('b');
      expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'store_failed', seq: 1 });
      expect(out.seq).toBe(live.seq);
      expect(out.model).toEqual(live.m);
      expect(exprOf(out.model, 'k')).toBe('(total > 0::integer)');
      expect(saved).toHaveLength(1);
      await expect(r.status('b')).resolves.toMatchObject({ pendingCount: 1, baseline: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).not.toContain('规范化表达式');
    } finally {
      warn.mockRestore();
    }
  });

  test('未 forget 时 rooms.patch 抛错 → skipped(store_failed)，不报 canonicalize_failed', async () => {
    const live: Live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    const rooms = ctlRooms(live, {
      reject: 0,
      beforePatch: () => {
        throw new Error('pg connection lost');
      },
    });
    const r = new OpaqueRefresher(rooms, async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await r.flush('b');
      expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'store_failed', seq: 0 });
      expect(exprOf(out.model, 'k')).toBe('total > 0');
      expect(saved).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).not.toContain('规范化表达式');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('分支在各个 await 期间被 forget（Issue #144）', () => {
  /** 已有基线、工作副本多了一条待规范化的 CHECK；hooks 里可以拿到 refresher 去 forget */
  const setup = async (
    hooks: {
      rooms?: Omit<Parameters<typeof ctlRooms>[1], 'reject'>;
      save?: (r: OpaqueRefresher) => void;
      load?: (r: OpaqueRefresher) => void;
    } = {},
  ) => {
    const live: Live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    let r!: OpaqueRefresher;
    let armed = false;
    const hookedStore = {
      load: async () => {
        if (armed) hooks.load?.(r);
        return store.load();
      },
      save: async (b: string, m: Model) => {
        // 删除项目后保存基线更新 0 行：forget 之后不再记进 saved
        if (armed && hooks.save) return hooks.save(r);
        await store.save(b, m);
      },
    };
    const rooms = ctlRooms(live, { reject: 0, ...hooks.rooms });
    r = new OpaqueRefresher(rooms, async () => canonicalShadow(), hookedStore);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    armed = true;
    return { live, saved, r, handle: { shadow: canonicalShadow(), label: 'test-shadow' } };
  };

  test('flush：保存基线（store.save）期间被 forget → skipped(forgotten)，内存基线不写', async () => {
    const { live, saved, r } = await setup({ save: (r) => r.forget('b') });
    const out = await r.flush('b');
    expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'forgotten', seq: live.seq });
    expect(exprOf(out.model, 'k')).toBe('(total > 0::integer)');
    expect(saved).toHaveLength(1);
    await r.drain();
    expect(r.tracked('b')).toBe(false);
  });

  test('flush：读基线（store.load）期间被 forget → skipped(forgotten)，不报 clean', async () => {
    const live: Live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    // 平台库里已有基线、与工作副本一致；新进程内存里没有缓存，flush 要去读库
    saved.push(structuredClone(live.m));
    let r!: OpaqueRefresher;
    const hookedStore = {
      load: async () => {
        r.forget('b');
        return store.load();
      },
      save: store.save,
    };
    r = new OpaqueRefresher(ctlRooms(live, { reject: 0 }), async () => canonicalShadow(), hookedStore);
    const out = await r.flush('b');
    expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'forgotten', seq: 0 });
    await r.drain();
    expect(r.tracked('b')).toBe(false);
  });

  test('normalize：写回（rooms.patch）期间被 forget、写回本身成功 → BranchForgottenError，基线不推进', async () => {
    const { saved, r, handle } = await setup({ rooms: { onAccept: () => r.forget('b') } });
    await expect(r.normalize('b', handle)).rejects.toBeInstanceOf(BranchForgottenError);
    expect(saved).toHaveLength(1);
    await r.drain();
    expect(r.tracked('b')).toBe(false);
  });

  // 注：以下抛错用例模拟 routes/projects.ts 的真实顺序（事务提交后先同步 forget，再踢房间 / 关影子库）；
  // 完整 HTTP 删除顺序与门控竞态见 apps/server/test/normalize.test.ts。
  test('normalize：写回期间被 forget 且 rooms.patch 抛错（项目删除提交后先 forget 再踢房间）→ BranchForgottenError 而不是写回失败', async () => {
    const { saved, r, handle } = await setup({
      rooms: {
        beforePatch: () => {
          r.forget('b');
          throw new Error('分支 b 不存在');
        },
      },
    });
    await expect(r.normalize('b', handle)).rejects.toBeInstanceOf(BranchForgottenError);
    expect(saved).toHaveLength(1);
  });

  test('normalize：读回（rooms.state）期间被 forget → BranchForgottenError，基线不推进', async () => {
    const { saved, r, handle } = await setup({
      // 第 1 次读是开始时，第 2 次是写回之后的读回
      rooms: { onState: (n) => void (n === 2 && r.forget('b')) },
    });
    await expect(r.normalize('b', handle)).rejects.toBeInstanceOf(BranchForgottenError);
    expect(saved).toHaveLength(1);
  });

  test('normalize：读回期间被 forget 且 rooms.state 抛错 → BranchForgottenError', async () => {
    const { r, handle } = await setup({
      rooms: {
        onState: (n) => {
          if (n !== 2) return;
          r.forget('b');
          throw new Error('分支 b 不存在');
        },
      },
    });
    await expect(r.normalize('b', handle)).rejects.toBeInstanceOf(BranchForgottenError);
  });

  test('normalize：保存基线（store.save）期间被 forget → BranchForgottenError，内存基线不写', async () => {
    const { saved, r, handle } = await setup({ save: (r) => r.forget('b') });
    await expect(r.normalize('b', handle)).rejects.toBeInstanceOf(BranchForgottenError);
    expect(saved).toHaveLength(1);
    await r.drain();
    expect(r.tracked('b')).toBe(false);
  });

  test.each([
    ['正常返回', false],
    ['抛错（项目删除关掉了影子库连接）', true],
  ])(
    'normalize：影子库里规范化期间被 forget、canonicalize %s → BranchForgottenError（不再报 409 写回冲突或影子库错误）',
    async (_label, fail) => {
      const { live, saved, r } = await setup();
      const handle = {
        label: 'test-shadow',
        shadow: {
          canonicalize: async (prev: Model, next: Model) => {
            r.forget('b');
            if (fail) throw new Error('影子库连接已关闭');
            return canonicalShadow().canonicalize(prev, next);
          },
        } as unknown as Shadow,
      };
      const p = r.normalize('b', handle);
      await expect(p).rejects.toBeInstanceOf(BranchForgottenError);
      await expect(p).rejects.not.toBeInstanceOf(NormalizeConflictError);
      // 没有写回、基线不推进
      expect(exprOf(live.m, 'k')).toBe('total > 0');
      expect(saved).toHaveLength(1);
    },
  );

  test('normalize：读基线（store.load）期间被 forget → BranchForgottenError，不报 clean', async () => {
    const live: Live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    saved.push(structuredClone(live.m));
    let r!: OpaqueRefresher;
    const hookedStore = {
      load: async () => {
        r.forget('b');
        return store.load();
      },
      save: store.save,
    };
    r = new OpaqueRefresher(ctlRooms(live, { reject: 0 }), async () => canonicalShadow(), hookedStore);
    await expect(r.normalize('b', { shadow: canonicalShadow(), label: 'x' })).rejects.toBeInstanceOf(
      BranchForgottenError,
    );
  });

  test('normalize：读基线（store.load）期间被 forget 且模型待规范化 → 抛 BranchForgottenError 且不解析影子库', async () => {
    const live: Live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    saved.push(structuredClone(live.m));
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    let resolveCalls = 0;
    let r!: OpaqueRefresher;
    const hookedStore = {
      load: async () => {
        r.forget('b');
        return store.load();
      },
      save: store.save,
    };
    r = new OpaqueRefresher(ctlRooms(live, { reject: 0 }), async () => canonicalShadow(), hookedStore);
    await expect(
      r.normalize('b', async () => {
        resolveCalls++;
        return { shadow: canonicalShadow(), label: 'x' };
      }),
    ).rejects.toBeInstanceOf(BranchForgottenError);
    expect(resolveCalls).toBe(0);
  });

  test('normalize：排队等待前序任务（flush）期间被 forget → 入口即抛 BranchForgottenError，零房间/基线/影子库 I/O；排空后活分支不误伤', async () => {
    const live: Live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    saved.push(structuredClone(live.m));
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    let stateCalls = 0;
    let resolveCalls = 0;
    let canonicalizeCalls = 0;
    let markLoadEntered!: () => void;
    const loadEntered = new Promise<void>((res) => (markLoadEntered = res));
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((res) => (releaseLoad = res));
    let holdLoad = true;
    const hookedStore = {
      load: async () => {
        if (holdLoad) {
          holdLoad = false;
          markLoadEntered();
          await loadGate;
        }
        return store.load();
      },
      save: store.save,
    };
    const rooms = ctlRooms(live, {
      reject: 0,
      onState: () => {
        stateCalls++;
      },
    });
    const r = new OpaqueRefresher(rooms, async () => canonicalShadow(), hookedStore);
    const flushP = r.flush('b');
    await loadEntered;

    const normP = r.normalize('b', async () => {
      resolveCalls++;
      return {
        shadow: {
          canonicalize: async (_p: Model, next: Model) => {
            canonicalizeCalls++;
            return canonicalShadow().canonicalize(_p, next);
          },
        } as unknown as Shadow,
        label: 'lazy',
      };
    });
    const normCheck = expect(normP).rejects.toBeInstanceOf(BranchForgottenError);

    r.forget('b');
    releaseLoad();
    await expect(flushP).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
    await normCheck;
    expect(stateCalls).toBe(1);
    expect(resolveCalls).toBe(0);
    expect(canonicalizeCalls).toBe(0);

    // 队列排空后 forgotten 标记自动清除，后续活分支调用不会误报
    await Promise.resolve();
    await Promise.resolve();
    expect(r.tracked('b')).toBe(false);
    await expect(
      r.normalize('b', async () => ({ shadow: canonicalShadow(), label: 'lazy' })),
    ).resolves.toMatchObject({ ok: true, outcome: 'normalized' });
  });

  test('对照：没被 forget 时 normalize 照常成功并推进基线', async () => {
    const { saved, r, handle } = await setup();
    await expect(r.normalize('b', handle)).resolves.toMatchObject({ ok: true, outcome: 'normalized' });
    expect(saved).toHaveLength(2);
  });
});
