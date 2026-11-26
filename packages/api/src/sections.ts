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

// ───── 增量板块动作（MCP manage_sections，ADR 0015 第 1 节）─────
// 纯函数归约器：不依赖 @dowel/core，前后端可复用；服务端在房间锁内基于最新板块调用，
// 绝不做全量替换，避免并发协作时抹掉同事新建的板块。

/** 增量板块动作名 */
export const SECTION_ACTIONS = [
  'create',
  'rename',
  'recolor',
  'delete',
  'add_tables',
  'remove_tables',
] as const;
export type SectionActionName = (typeof SECTION_ACTIONS)[number];

/** 已解析的板块动作：`create.id` 由调用方预先分配（`sec-<uuid>`），`section` 均为真实板块 ID */
export type ResolvedSectionAction =
  | { action: 'create'; id: string; name: string; color?: SectionColor; tables?: string[] }
  | { action: 'rename'; section: string; name: string }
  | { action: 'recolor'; section: string; color: SectionColor }
  | { action: 'delete'; section: string }
  | { action: 'add_tables'; section: string; tables: string[] }
  | { action: 'remove_tables'; section: string; tables: string[] };

/**
 * 表 ID 校验结果（仅对 `create.tables` 与 `add_tables.tables` 调用）：
 * live model 中 `kind === 'table'` 且不是分区子表才为 'ok'；分区子表返回 'partition'（跟随父表显示）。
 */
export type SectionTableCheck = 'ok' | 'missing' | 'not_table' | 'partition';

export interface SectionActionError {
  ok: false;
  code: 'section_not_found' | 'table_not_found' | 'invalid';
  /** 出错的动作下标（从 0 开始） */
  index: number;
  message: string;
  /** table_not_found / 分区子表时涉及的表 ID */
  tableIds?: string[];
}

/** 表从一个板块迁入另一个板块（保持“一张表至多属于 1 个板块”） */
export interface SectionTableMove {
  tableId: string;
  from: string;
  to: string;
}

export interface SectionActionsApplied {
  ok: true;
  /** 经 sanitizeSections 兜底后的结果 */
  sections: CanvasSection[];
  /** 与（清洗后的）基准相比是否有结构变化；false 即 noop */
  changed: boolean;
  moved: SectionTableMove[];
  /** 本批新建的板块 ID（按动作顺序） */
  created: string[];
  /** 本批删除的板块 ID（按动作顺序） */
  deleted: string[];
}

export type SectionActionsResult = SectionActionsApplied | SectionActionError;

const sameSections = (a: CanvasSection[], b: CanvasSection[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.name !== y.name || x.color !== y.color) return false;
    if (x.tables.length !== y.tables.length) return false;
    for (let j = 0; j < x.tables.length; j++) if (x.tables[j] !== y.tables[j]) return false;
  }
  return true;
};

const normalizeSectionName = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name.length >= 1 && name.length <= MAX_SECTION_NAME_LENGTH ? name : null;
};

/**
 * 对基准板块依次应用一批增量动作（全有或全无：任一动作失败即返回错误、不产生部分结果）。
 * - 不主动清理未被触碰板块里的历史悬空表 ID（保留历史恢复场景下的原归属）；
 * - `remove_tables` 不校验 model，允许清掉已删除表留下的悬空 ID，表不在板块中时幂等 noop；
 * - 达到 MAX_SECTIONS 时 `create` 直接报 invalid，绝不让 sanitizeSections 静默截断。
 */
export const applySectionActions = (
  base: readonly CanvasSection[],
  actions: readonly ResolvedSectionAction[],
  checkTable: (id: string) => SectionTableCheck,
): SectionActionsResult => {
  const start = sanitizeSections(base);
  const working: CanvasSection[] = start.map((s) => ({ ...s, tables: [...s.tables] }));
  const moved: SectionTableMove[] = [];
  const created: string[] = [];
  const deleted: string[] = [];

  const fail = (
    code: SectionActionError['code'],
    index: number,
    message: string,
    tableIds?: string[],
  ): SectionActionError => ({ ok: false, code, index, message, ...(tableIds ? { tableIds } : {}) });

  const findSection = (id: string) => working.find((s) => s.id === id);

  /** 把一批表加入目标板块；返回错误或 null */
  const addTables = (target: CanvasSection, tables: readonly string[], index: number) => {
    const unique = [...new Set(tables)];
    const notFound: string[] = [];
    const partitions: string[] = [];
    for (const id of unique) {
      const res = id.length > MAX_SECTION_TABLE_ID_LENGTH ? 'missing' : checkTable(id);
      if (res === 'missing' || res === 'not_table') notFound.push(id);
      else if (res === 'partition') partitions.push(id);
    }
    if (notFound.length) {
      return fail('table_not_found', index, `表不存在：${notFound.join(', ')}`, notFound);
    }
    if (partitions.length) {
      return fail(
        'invalid',
        index,
        `分区子表不能单独加入板块（跟随其父表显示），请改为加入父表：${partitions.join(', ')}`,
        partitions,
      );
    }
    for (const id of unique) {
      if (target.tables.includes(id)) continue;
      for (const other of working) {
        if (other === target) continue;
        const pos = other.tables.indexOf(id);
        if (pos === -1) continue;
        other.tables.splice(pos, 1);
        moved.push({ tableId: id, from: other.id, to: target.id });
      }
      target.tables.push(id);
    }
    return null;
  };

  for (let index = 0; index < actions.length; index++) {
    const a = actions[index]!;
    switch (a.action) {
      case 'create': {
        const id = typeof a.id === 'string' ? a.id.trim() : '';
        if (!id || id.length > MAX_SECTION_ID_LENGTH) return fail('invalid', index, '无效的板块 ID');
        if (findSection(id)) return fail('invalid', index, `板块 ID 已存在：${id}`);
        const name = normalizeSectionName(a.name);
        if (!name) {
          return fail('invalid', index, `板块名称去掉首尾空白后须为 1–${MAX_SECTION_NAME_LENGTH} 个字符`);
        }
        if (a.color !== undefined && !isSectionColor(a.color)) {
          return fail('invalid', index, `无效的板块颜色：${String(a.color)}`);
        }
        if (working.length >= MAX_SECTIONS) {
          return fail('invalid', index, `板块数量已达上限 ${MAX_SECTIONS} 个，请先删除不再需要的板块`);
        }
        const section: CanvasSection = {
          id,
          name,
          color: a.color ?? SECTION_COLORS[working.length % SECTION_COLORS.length]!,
          tables: [],
        };
        working.push(section);
        created.push(id);
        if (a.tables?.length) {
          const err = addTables(section, a.tables, index);
          if (err) return err;
        }
        break;
      }
      case 'rename': {
        const s = findSection(a.section);
        if (!s) return fail('section_not_found', index, `板块不存在：${a.section}`);
        const name = normalizeSectionName(a.name);
        if (!name) {
          return fail('invalid', index, `板块名称去掉首尾空白后须为 1–${MAX_SECTION_NAME_LENGTH} 个字符`);
        }
        s.name = name;
        break;
      }
      case 'recolor': {
        const s = findSection(a.section);
        if (!s) return fail('section_not_found', index, `板块不存在：${a.section}`);
        if (!isSectionColor(a.color)) return fail('invalid', index, `无效的板块颜色：${String(a.color)}`);
        s.color = a.color;
        break;
      }
      case 'delete': {
        const pos = working.findIndex((s) => s.id === a.section);
        if (pos === -1) return fail('section_not_found', index, `板块不存在：${a.section}`);
        working.splice(pos, 1);
        deleted.push(a.section);
        break;
      }
      case 'add_tables': {
        const s = findSection(a.section);
        if (!s) return fail('section_not_found', index, `板块不存在：${a.section}`);
        const err = addTables(s, a.tables, index);
        if (err) return err;
        break;
      }
      case 'remove_tables': {
        const s = findSection(a.section);
        if (!s) return fail('section_not_found', index, `板块不存在：${a.section}`);
        const drop = new Set(a.tables);
        s.tables = s.tables.filter((t) => !drop.has(t));
        break;
      }
      default: {
        const unknown = (a as { action?: unknown }).action;
        return fail('invalid', index, `未知的板块动作：${String(unknown)}`);
      }
    }
  }

  const sections = sanitizeSections(working);
  return { ok: true, sections, changed: !sameSections(start, sections), moved, created, deleted };
};

// ───── 输入解析：`$ref:<alias>` → 服务端生成的板块 ID ─────

/** 板块别名占位符（与 MCP apply_changes 的 `$ref:<alias>` 同一格式） */
export const SECTION_REF_PATTERN = /^\$ref:[A-Za-z0-9_.-]{1,64}$/;
export const SECTION_REF_ALIAS_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** manage_sections 的原始输入动作（与 MCP 输入 schema 同构；`section` 为板块 ID 或 `$ref:<alias>`） */
export type SectionActionInput =
  | { action: 'create'; ref?: string; name: string; color?: SectionColor; tables?: string[] }
  | { action: 'rename'; section: string; name: string }
  | { action: 'recolor'; section: string; color: SectionColor }
  | { action: 'delete'; section: string }
  | { action: 'add_tables'; section: string; tables: string[] }
  | { action: 'remove_tables'; section: string; tables: string[] };

export type ResolveSectionActionsResult =
  | { ok: true; actions: ResolvedSectionAction[]; refs: Record<string, string> }
  | SectionActionError;

/**
 * 把原始输入动作解析为 ResolvedSectionAction：`create` 一律由 genId 生成新 ID（重复 `ref` 报 invalid），
 * `section: '$ref:<alias>'` 只能引用本批更早的 `create.ref`（未定义报 section_not_found）；
 * 其他字符串按板块 ID 原样使用，绝不按名称猜测板块。
 */
export const resolveSectionActions = (
  inputs: readonly SectionActionInput[],
  genId: () => string,
): ResolveSectionActionsResult => {
  const refs = new Map<string, string>();
  const out: ResolvedSectionAction[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const a = inputs[index]!;
    if (a.action === 'create') {
      const id = genId();
      if (a.ref !== undefined) {
        if (!SECTION_REF_ALIAS_PATTERN.test(a.ref)) {
          return { ok: false, code: 'invalid', index, message: `无效的板块别名：${a.ref}` };
        }
        if (refs.has(a.ref)) {
          return { ok: false, code: 'invalid', index, message: `板块别名重复：${a.ref}` };
        }
        refs.set(a.ref, id);
      }
      out.push({
        action: 'create',
        id,
        name: a.name,
        ...(a.color !== undefined ? { color: a.color } : {}),
        ...(a.tables !== undefined ? { tables: [...a.tables] } : {}),
      });
      continue;
    }
    let section = a.section;
    if (section.startsWith('$ref:')) {
      const alias = section.slice(5);
      const id = SECTION_REF_PATTERN.test(section) ? refs.get(alias) : undefined;
      if (!id) {
        return {
          ok: false,
          code: 'section_not_found',
          index,
          message: `未定义的板块别名：${section}（只能引用本批更早的 create.ref）`,
        };
      }
      section = id;
    }
    switch (a.action) {
      case 'rename':
        out.push({ action: 'rename', section, name: a.name });
        break;
      case 'recolor':
        out.push({ action: 'recolor', section, color: a.color });
        break;
      case 'delete':
        out.push({ action: 'delete', section });
        break;
      case 'add_tables':
        out.push({ action: 'add_tables', section, tables: [...a.tables] });
        break;
      case 'remove_tables':
        out.push({ action: 'remove_tables', section, tables: [...a.tables] });
        break;
    }
  }
  return { ok: true, actions: out, refs: Object.fromEntries(refs) };
};
