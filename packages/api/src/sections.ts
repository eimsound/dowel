// 纯布局层画布板块（Section）共享契约与确定性清洗器。
// 板块只存储在布局层（branches.sections），绝不进入 @dowel/core IR、DDL、diff、迁移或版本快照。
import { z } from 'zod';

/** 与 DESIGN.md 对齐的板块配色 token（peer-1 … peer-8） */
export const SECTION_COLORS = [
  'peer-1',
  'peer-2',
  'peer-3',
  'peer-4',
  'peer-5',
  'peer-6',
  'peer-7',
  'peer-8',
] as const;

export type SectionColor = (typeof SECTION_COLORS)[number];

export interface CanvasSection {
  id: string;
  name: string;
  color: SectionColor;
  tables: string[];
}

export const MAX_SECTIONS = 200;
export const MAX_SECTION_NAME_LENGTH = 64;
export const MAX_SECTION_ID_LENGTH = 128;
export const MAX_SECTION_TABLE_ID_LENGTH = 128;

export const sectionColorSchema = z.enum(SECTION_COLORS);

export const canvasSectionSchema = z.object({
  id: z.string().trim().min(1).max(MAX_SECTION_ID_LENGTH),
  name: z.string().trim().min(1).max(MAX_SECTION_NAME_LENGTH),
  color: sectionColorSchema,
  tables: z.array(z.string().min(1).max(MAX_SECTION_TABLE_ID_LENGTH)),
});

const SECTION_COLOR_SET = new Set<string>(SECTION_COLORS);

export const isSectionColor = (v: unknown): v is SectionColor =>
  typeof v === 'string' && SECTION_COLOR_SET.has(v);

export const sectionColorCssVar = (color: SectionColor): string => `var(--${color})`;

/**
 * 确定性清洗画布板块列表：
 * - 非数组或非法元素静默忽略，绝不抛错；
 * - 强制扁平（忽略任何嵌套/未知字段）；
 * - 裁剪板块名并过滤空名，限制长度与数量上限（200）；
 * - 非法颜色按当前输出索引确定性回退到 SECTION_COLORS；
 * - 强制“每张表最多归属 1 个板块”，跨板块重复时保留首次出现的归属并去重。
 */
export const sanitizeSections = (raw: unknown): CanvasSection[] => {
  if (!Array.isArray(raw)) return [];
  const out: CanvasSection[] = [];
  const seenIds = new Set<string>();
  const seenTables = new Set<string>();

  for (const item of raw) {
    if (out.length >= MAX_SECTIONS) break;
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;

    if (typeof rec.id !== 'string') continue;
    const id = rec.id.trim();
    if (!id || id.length > MAX_SECTION_ID_LENGTH || seenIds.has(id)) continue;

    if (typeof rec.name !== 'string') continue;
    const name = rec.name.trim().slice(0, MAX_SECTION_NAME_LENGTH).trim();
    if (!name) continue;

    const color: SectionColor = isSectionColor(rec.color)
      ? rec.color
      : SECTION_COLORS[out.length % SECTION_COLORS.length]!;

    const tables: string[] = [];
    if (Array.isArray(rec.tables)) {
      for (const t of rec.tables) {
        if (typeof t !== 'string') continue;
        if (!t || t.length > MAX_SECTION_TABLE_ID_LENGTH || !t.trim()) continue;
        if (seenTables.has(t)) continue;
        seenTables.add(t);
        tables.push(t);
      }
    }

    seenIds.add(id);
    out.push({ id, name, color, tables });
  }

  return out;
};
