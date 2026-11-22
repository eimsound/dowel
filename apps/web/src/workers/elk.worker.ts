import ELK from 'elkjs/lib/elk.bundled.js';

export interface ElkWorkerNode {
  id: string;
  width: number;
  height: number;
}

export interface ElkWorkerEdge {
  id: string;
  sources: string[];
  targets: string[];
}

export interface ElkLayoutRequest {
  requestId: number;
  nodes: ElkWorkerNode[];
  edges: ElkWorkerEdge[];
}

export type ElkLayoutResponse =
  | {
      requestId: number;
      ok: true;
      positions: Record<string, { x: number; y: number }>;
    }
  | {
      requestId: number;
      ok: false;
      error: string;
    };

const elk = new ELK();

export const runElkGraph = async (
  nodes: ElkWorkerNode[],
  edges: ElkWorkerEdge[],
): Promise<Record<string, { x: number; y: number }>> => {
  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
    },
    children: nodes,
    edges,
  });
  const positions: Record<string, { x: number; y: number }> = {};
  for (const c of res.children ?? []) {
    positions[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
  }
  return positions;
};

const workerScope = globalThis as unknown as {
  window?: unknown;
  postMessage?: (msg: ElkLayoutResponse) => void;
  onmessage?: ((e: MessageEvent<ElkLayoutRequest>) => void) | null;
};

// 仅在独立 Web Worker 上下文中注册消息监听，主线程 / Vitest 直接导入 runElkGraph 时不挂载
if (typeof workerScope.window === 'undefined' && typeof workerScope.postMessage === 'function') {
  workerScope.onmessage = async (e: MessageEvent<ElkLayoutRequest>) => {
    const { requestId, nodes, edges } = e.data;
    try {
      const positions = await runElkGraph(nodes, edges);
      workerScope.postMessage!({ requestId, ok: true, positions });
    } catch (err) {
      workerScope.postMessage!({
        requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
