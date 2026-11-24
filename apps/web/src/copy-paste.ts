// 复制粘贴的布局层辅助（纯函数，便于单测）：粘贴后的表放在哪、是否沿用来源板块。
// 布局与板块只在布局层，绝不进入 IR（02-consensus.md）。
import type { CanvasSection } from '@dowel/api';
import type { ClipboardPayload, PastePlan } from '@dowel/core';

import type { Layout } from './workspace.ts';

const NODE_W = 250;
const GAP_X = 80;
const ROW_H = 260;
const GRID_COLS = 4;

/**
 * 计算新表坐标：保留来源布局里的相对位置，整体以 center 为中心；来源没有坐标的表在其下方按网格排开。
 * center 为 null（画布未就绪）时以原点为中心。
 */
export const placePastedTables = (
  payload: ClipboardPayload,
  plan: Pick<PastePlan, 'tableMap' | 'newTables'>,
  center: { x: number; y: number } | null,
): Layout => {
  const c = center ?? { x: 0, y: 0 };
  const srcIds = payload.tables.filter((id) => plan.tableMap[id]);
  const withPos = srcIds.filter((id) => payload.layout[id]);
  const out: Layout = {};
  let bottom = c.y;
  if (withPos.length) {
    const xs = withPos.map((id) => payload.layout[id]!.x);
    const ys = withPos.map((id) => payload.layout[id]!.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs) + NODE_W;
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const dx = c.x - (minX + maxX) / 2;
    const dy = c.y - (minY + maxY) / 2;
    for (const id of withPos) {
      const p = payload.layout[id]!;
      out[plan.tableMap[id]!] = { x: Math.round(p.x + dx), y: Math.round(p.y + dy) };
    }
    bottom = maxY + dy + ROW_H;
  }
  const rest = srcIds.filter((id) => !payload.layout[id]);
  if (rest.length) {
    const cols = Math.min(GRID_COLS, rest.length);
    const width = cols * NODE_W + (cols - 1) * GAP_X;
    const left = c.x - width / 2;
    rest.forEach((id, i) => {
      out[plan.tableMap[id]!] = {
        x: Math.round(left + (i % cols) * (NODE_W + GAP_X)),
        y: Math.round(bottom + Math.floor(i / cols) * ROW_H),
      };
    });
  }
  return out;
};

/**
 * 连续粘贴时（视口没动）新表会正好叠在上一次粘贴的表上：只要任一新表与已有的表坐标相差不到 20px，
 * 就整体向右下挪 32px，直到不再重叠（最多 50 次）。
 */
export const nudgeAway = (positions: Layout, existing: Layout): Layout => {
  const others = Object.values(existing);
  if (!others.length) return positions;
  const near = (p: { x: number; y: number }) =>
    others.some((o) => Math.abs(o.x - p.x) < 20 && Math.abs(o.y - p.y) < 20);
  let dx = 0;
  for (let i = 0; i < 50 && Object.values(positions).some((p) => near({ x: p.x + dx, y: p.y + dx })); i++)
    dx += 32;
  if (!dx) return positions;
  return Object.fromEntries(Object.entries(positions).map(([k, p]) => [k, { x: p.x + dx, y: p.y + dx }]));
};

/**
 * 同一项目内粘贴时，新表沿用来源表所在的板块（板块仍存在才沿用）；跨项目粘贴不动板块。
 * 返回 null 表示板块无需变化。
 */
export const sectionsAfterPaste = (
  sections: CanvasSection[],
  payload: ClipboardPayload,
  plan: Pick<PastePlan, 'tableMap'>,
  projectId: string,
): CanvasSection[] | null => {
  if (payload.source.projectId !== projectId) return null;
  const add = new Map<string, string[]>();
  for (const [src, sectionId] of Object.entries(payload.sections)) {
    const next = plan.tableMap[src];
    if (!next || !sections.some((s) => s.id === sectionId)) continue;
    add.set(sectionId, [...(add.get(sectionId) ?? []), next]);
  }
  if (!add.size) return null;
  return sections.map((s) => (add.has(s.id) ? { ...s, tables: [...s.tables, ...add.get(s.id)!] } : s));
};

/** 表 ID → 板块 ID（复制时记下，供同项目粘贴沿用） */
export const sectionIndex = (
  sections: CanvasSection[],
  tableIds: Iterable<string>,
): Record<string, string> => {
  const want = new Set(tableIds);
  const out: Record<string, string> = {};
  for (const s of sections) for (const t of s.tables) if (want.has(t) && !(t in out)) out[t] = s.id;
  return out;
};
