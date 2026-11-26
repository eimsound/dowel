// MCP 工具 / Prompt 清单的共享契约（ADR 0015 第 6 节）：只读工具的 scope 与项目动作、历史限额常量，
// 以及“永不注册恢复历史 / 发布版本 / 执行迁移”的红线。
import { describe, expect, test } from 'vitest';

import {
  CANVAS_HISTORY_GROUP_MAX_STEPS,
  MCP_HISTORY_DIFF_MAX_ITEMS,
  MCP_HISTORY_MAX_LIMIT,
  MCP_HISTORY_SQL_MAX_CHARS,
  MCP_PROMPTS,
  MCP_TOOLS,
  type McpToolErrorCode,
} from '../src/index.ts';

/** 绝不能出现在 MCP 工具清单里的写入 / 越权动作 */
const FORBIDDEN_TOOLS = [
  'restore_history',
  'revert_history',
  'rollback',
  'publish_version',
  'execute_migration',
];

describe('MCP_TOOLS', () => {
  test('红线：不包含恢复历史、回滚、发布版本或执行迁移类工具', () => {
    const names = Object.keys(MCP_TOOLS);
    for (const name of FORBIDDEN_TOOLS) expect(names).not.toContain(name);
    for (const name of names) {
      expect(name).not.toMatch(/restore|revert|rollback|publish|execute/i);
    }
  });

  test('新增的上下文与历史工具都是只读 scope + project.read', () => {
    for (const name of ['get_objects', 'list_history', 'get_history_diff'] as const) {
      expect(MCP_TOOLS[name]).toEqual({ scope: 'read', action: 'project.read' });
    }
  });

  test('只有 apply_changes / manage_sections 需要 write，verify_migration 需要 verify', () => {
    const byScope = (scope: string) =>
      Object.entries(MCP_TOOLS)
        .filter(([, v]) => v.scope === scope)
        .map(([k]) => k)
        .sort();
    expect(byScope('write')).toEqual(['apply_changes', 'manage_sections']);
    expect(byScope('verify')).toEqual(['verify_migration']);
  });

  test('history_not_found 是合法的工具错误码', () => {
    const code: McpToolErrorCode = 'history_not_found';
    expect(code).toBe('history_not_found');
  });

  test('历史限额常量', () => {
    expect(MCP_HISTORY_MAX_LIMIT).toBe(50);
    expect(MCP_HISTORY_DIFF_MAX_ITEMS).toBe(100);
    expect(MCP_HISTORY_SQL_MAX_CHARS).toBe(2000);
    expect(CANVAS_HISTORY_GROUP_MAX_STEPS).toBeGreaterThan(1);
  });
});

describe('MCP_PROMPTS', () => {
  test('名称唯一，scope 与预期一致', () => {
    const names = MCP_PROMPTS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.fromEntries(MCP_PROMPTS.map((p) => [p.name, p.requiredScope]))).toEqual({
      design_tables: 'write',
      refactor_column: 'write',
      review_unpublished_changes: 'read',
      review_canvas_history: 'read',
    });
  });

  test('每个 Prompt 都有必填的 project 参数，参数均有描述与长度上限', () => {
    for (const p of MCP_PROMPTS) {
      expect(p.description.length).toBeGreaterThan(0);
      const project = p.arguments.find((a) => a.name === 'project');
      expect(project?.required).toBe(true);
      const argNames = p.arguments.map((a) => a.name);
      expect(new Set(argNames).size).toBe(argNames.length);
      for (const a of p.arguments) {
        expect(a.description.length).toBeGreaterThan(0);
        expect(a.maxLength).toBeGreaterThan(0);
      }
    }
  });

  test('参数上限', () => {
    const arg = (prompt: string, name: string) =>
      MCP_PROMPTS.find((p) => p.name === prompt)!.arguments.find((a) => a.name === name)!;
    expect(arg('design_tables', 'requirements')).toMatchObject({ required: true, maxLength: 4000 });
    expect(arg('design_tables', 'section')).toMatchObject({ required: false, maxLength: 100 });
    expect(arg('refactor_column', 'change')).toMatchObject({ required: true, maxLength: 1000 });
    expect(arg('review_canvas_history', 'beforeSeq')).toMatchObject({ required: false, numeric: true });
    expect(arg('review_canvas_history', 'limit')).toMatchObject({ required: false, numeric: true });
  });

  test('Prompt 名称不与工具重名，也不触碰红线动作', () => {
    for (const p of MCP_PROMPTS) {
      expect(Object.keys(MCP_TOOLS)).not.toContain(p.name);
      expect(FORBIDDEN_TOOLS).not.toContain(p.name);
    }
  });
});
