import { afterEach, describe, expect, test, vi } from 'vitest';

import { cancelPendingElkLayouts, runElkLayout, StaleLayoutError } from '../src/workers/elk-client.ts';
import type { ElkLayoutRequest, ElkLayoutResponse } from '../src/workers/elk.worker.ts';

describe('elk-client Web Worker 布局调度', () => {
  afterEach(() => {
    cancelPendingElkLayouts();
    vi.unstubAllGlobals();
  });

  test('支持无 Worker 环境回退，并在连续提交新请求时淘汰过期请求', async () => {
    vi.stubGlobal('Worker', undefined);
    const p1 = runElkLayout(
      [
        { id: 't1', width: 250, height: 100 },
        { id: 't2', width: 250, height: 100 },
      ],
      [{ id: 'fk1', sources: ['t1'], targets: ['t2'] }],
    );
    const p2 = runElkLayout([{ id: 't3', width: 250, height: 80 }], []);

    await expect(p1).rejects.toBeInstanceOf(StaleLayoutError);
    const pos2 = await p2;
    expect(pos2.t3).toBeDefined();
    expect(typeof pos2.t3!.x).toBe('number');
    expect(typeof pos2.t3!.y).toBe('number');
  });

  test('通过 Worker postMessage 调度计算并在新请求到来时拒收迟到的旧响应', async () => {
    const callbacks: Array<() => void> = [];
    class MockWorker {
      onmessage: ((e: MessageEvent<ElkLayoutResponse>) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      postMessage(req: ElkLayoutRequest) {
        const idx = req.requestId;
        callbacks.push(() => {
          this.onmessage?.({
            data: {
              requestId: idx,
              ok: true,
              positions: Object.fromEntries(req.nodes.map((n, i) => [n.id, { x: i * 300, y: 0 }])),
            },
          } as MessageEvent<ElkLayoutResponse>);
        });
      }
      terminate() {}
    }

    vi.stubGlobal('Worker', MockWorker);
    const p1 = runElkLayout([{ id: 'a', width: 250, height: 100 }], []);
    const p2 = runElkLayout([{ id: 'b', width: 250, height: 100 }], []);

    // p1 在 p2 发起时已被标记失效
    await expect(p1).rejects.toBeInstanceOf(StaleLayoutError);
    for (const cb of callbacks) cb();
    await expect(p2).resolves.toEqual({ b: { x: 0, y: 0 } });
  });
});
