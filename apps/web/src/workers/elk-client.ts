import type { ElkLayoutRequest, ElkLayoutResponse, ElkWorkerEdge, ElkWorkerNode } from './elk.worker.ts';

export class StaleLayoutError extends Error {
  constructor() {
    super('已过时的 ELK 布局请求');
  }
}

interface PendingRequest {
  version: number;
  resolve: (positions: Record<string, { x: number; y: number }>) => void;
  reject: (err: unknown) => void;
}

let worker: Worker | null = null;
let seq = 0;
let latestVersion = 0;
const pending = new Map<number, PendingRequest>();

const ensureWorker = (): Worker | null => {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  worker = new Worker(new URL('./elk.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<ElkLayoutResponse>) => {
    const msg = e.data;
    const item = pending.get(msg.requestId);
    if (!item) return;
    pending.delete(msg.requestId);
    if (item.version !== latestVersion) {
      item.reject(new StaleLayoutError());
      return;
    }
    if (msg.ok) item.resolve(msg.positions);
    else item.reject(new Error(msg.error));
  };
  worker.onerror = (err) => {
    const reason = err instanceof ErrorEvent ? (err.error ?? new Error(err.message)) : err;
    for (const [, item] of pending) item.reject(reason);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
};

export const cancelPendingElkLayouts = (): void => {
  latestVersion++;
  for (const [id, item] of pending) {
    pending.delete(id);
    item.reject(new StaleLayoutError());
  }
};

export const runElkLayout = async (
  nodes: ElkWorkerNode[],
  edges: ElkWorkerEdge[],
  options?: { signal?: AbortSignal },
): Promise<Record<string, { x: number; y: number }>> => {
  if (options?.signal?.aborted) throw new StaleLayoutError();
  const version = ++latestVersion;
  const requestId = ++seq;
  for (const [oldId, oldItem] of pending) {
    if (oldItem.version < version) {
      pending.delete(oldId);
      oldItem.reject(new StaleLayoutError());
    }
  }
  const w = ensureWorker();
  if (!w) {
    const { runElkGraph } = await import('./elk.worker.ts');
    const positions = await runElkGraph(nodes, edges);
    if (version !== latestVersion || options?.signal?.aborted) throw new StaleLayoutError();
    return positions;
  }
  return new Promise<Record<string, { x: number; y: number }>>((resolve, reject) => {
    const onAbort = () => {
      if (pending.delete(requestId)) {
        reject(new StaleLayoutError());
      }
    };
    if (options?.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
    pending.set(requestId, {
      version,
      resolve: (pos) => {
        options?.signal?.removeEventListener('abort', onAbort);
        resolve(pos);
      },
      reject: (err) => {
        options?.signal?.removeEventListener('abort', onAbort);
        reject(err);
      },
    });
    const req: ElkLayoutRequest = { requestId, nodes, edges };
    w.postMessage(req);
  });
};
