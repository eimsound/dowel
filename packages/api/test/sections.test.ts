import { describe, expect, test } from 'vitest';

import {
  applySectionActions,
  type CanvasSection,
  MAX_SECTION_NAME_LENGTH,
  MAX_SECTIONS,
  MCP_AUDIT_ACTIONS,
  MCP_MAX_SECTION_ACTIONS,
  MCP_MAX_SECTION_TABLES_PER_ACTION,
  MCP_TOOLS,
  mcpManageSectionsInputSchema,
  type ResolvedSectionAction,
  resolveSectionActions,
  SECTION_ACTIONS,
  SECTION_COLORS,
  type SectionTableCheck,
  sanitizeSections,
  sectionColorCssVar,
} from '../src/index.ts';

describe('sanitizeSections', () => {
  test('非数组输入安全返回空数组', () => {
    expect(sanitizeSections(null)).toEqual([]);
    expect(sanitizeSections(undefined)).toEqual([]);
    expect(sanitizeSections({})).toEqual([]);
    expect(sanitizeSections('bad')).toEqual([]);
  });

  test('强制每张表最多归属 1 个板块（保留首次出现并去重）', () => {
    const out = sanitizeSections([
      { id: 's1', name: '订单', color: 'peer-1', tables: ['t1', 't2', 't1'] },
      { id: 's2', name: '用户', color: 'peer-2', tables: ['t2', 't3', 't2'] },
    ]);
    expect(out).toEqual([
      { id: 's1', name: '订单', color: 'peer-1', tables: ['t1', 't2'] },
      { id: 's2', name: '用户', color: 'peer-2', tables: ['t3'] },
    ]);
  });

  test('校验并规范化名称、ID、颜色与扁平结构', () => {
    const longName = 'x'.repeat(MAX_SECTION_NAME_LENGTH + 20);
    const out = sanitizeSections([
      null,
      { id: '', name: '无效', color: 'peer-1', tables: [] },
      { id: 's1', name: '   ', color: 'peer-1', tables: [] },
      {
        id: ' s1 ',
        name: `  ${longName}  `,
        color: 'red',
        tables: ['t1', '', 123, '   '],
        children: [{ id: 'nested' }],
      },
      { id: 's1', name: '重复ID丢弃', color: 'peer-3', tables: ['t2'] },
      { id: 's2', name: '有效板块', color: 'invalid', tables: ['t2'] },
    ]);
    expect(out).toEqual([
      {
        id: 's1',
        name: 'x'.repeat(MAX_SECTION_NAME_LENGTH),
        color: SECTION_COLORS[0],
        tables: ['t1'],
      },
      {
        id: 's2',
        name: '有效板块',
        color: SECTION_COLORS[1],
        tables: ['t2'],
      },
    ]);
    expect(sectionColorCssVar('peer-4')).toBe('var(--peer-4)');
  });

  test('超过板块数量上限时确定性截断', () => {
    const input = Array.from({ length: MAX_SECTIONS + 15 }, (_, i) => ({
      id: `s-${i}`,
      name: `板块 ${i}`,
      color: SECTION_COLORS[i % SECTION_COLORS.length],
      tables: [`t-${i}`],
    }));
    const out = sanitizeSections(input);
    expect(out).toHaveLength(MAX_SECTIONS);
    expect(out.at(-1)?.id).toBe(`s-${MAX_SECTIONS - 1}`);
  });
});

// ───── manage_sections 增量归约器（ADR 0015 第 1 节） ─────

const TABLES: Record<string, SectionTableCheck> = {
  t1: 'ok',
  t2: 'ok',
  t3: 'ok',
  t4: 'ok',
  part1: 'partition',
  col1: 'not_table',
};
const check = (id: string): SectionTableCheck => TABLES[id] ?? 'missing';

const base = (): CanvasSection[] => [
  { id: 's1', name: '订单', color: 'peer-1', tables: ['t1', 'ghost'] },
  { id: 's2', name: '用户', color: 'peer-2', tables: ['t2'] },
];

const run = (actions: ResolvedSectionAction[], b: CanvasSection[] = base()) =>
  applySectionActions(b, actions, check);

describe('applySectionActions', () => {
  test('动作清单固定为 6 种', () => {
    expect(SECTION_ACTIONS).toEqual(['create', 'rename', 'recolor', 'delete', 'add_tables', 'remove_tables']);
  });

  test('create：默认配色按当前板块数轮转（与 SectionDialog 一致），可带 tables 并从旧板块迁出', () => {
    const res = run([
      { action: 'create', id: 'sec-a', name: '  库存  ' },
      { action: 'create', id: 'sec-b', name: '支付', color: 'peer-8', tables: ['t2', 't3', 't3'] },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sections).toEqual([
      { id: 's1', name: '订单', color: 'peer-1', tables: ['t1', 'ghost'] },
      { id: 's2', name: '用户', color: 'peer-2', tables: [] },
      { id: 'sec-a', name: '库存', color: SECTION_COLORS[2], tables: [] },
      { id: 'sec-b', name: '支付', color: 'peer-8', tables: ['t2', 't3'] },
    ]);
    expect(res.created).toEqual(['sec-a', 'sec-b']);
    expect(res.moved).toEqual([{ tableId: 't2', from: 's2', to: 'sec-b' }]);
    expect(res.changed).toBe(true);
  });

  test('默认配色在 8 色之后回到 peer-1', () => {
    const many: CanvasSection[] = Array.from({ length: 8 }, (_, i) => ({
      id: `x${i}`,
      name: `n${i}`,
      color: 'peer-3',
      tables: [],
    }));
    const res = run([{ action: 'create', id: 'sec-9', name: '第九个' }], many);
    expect(res.ok && res.sections.at(-1)?.color).toBe(SECTION_COLORS[0]);
  });

  test('create：达到 MAX_SECTIONS 上限报 invalid（不被 sanitizeSections 静默截断）', () => {
    const full: CanvasSection[] = Array.from({ length: MAX_SECTIONS }, (_, i) => ({
      id: `x${i}`,
      name: `n${i}`,
      color: 'peer-1',
      tables: [],
    }));
    const res = run([{ action: 'create', id: 'sec-over', name: '超额' }], full);
    expect(res).toMatchObject({ ok: false, code: 'invalid', index: 0 });
  });

  test('create：重复 ID、空名与超长名报 invalid', () => {
    expect(run([{ action: 'create', id: 's1', name: 'dup' }])).toMatchObject({ ok: false, code: 'invalid' });
    expect(run([{ action: 'create', id: 'sec-x', name: '   ' }])).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(
      run([{ action: 'create', id: 'sec-x', name: 'x'.repeat(MAX_SECTION_NAME_LENGTH + 1) }]),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  test('rename / recolor：值不变为 noop，不存在的板块报 section_not_found 带 index', () => {
    const same = run([
      { action: 'rename', section: 's1', name: ' 订单 ' },
      { action: 'recolor', section: 's2', color: 'peer-2' },
    ]);
    expect(same).toMatchObject({ ok: true, changed: false });

    const changed = run([
      { action: 'rename', section: 's1', name: '订单中心' },
      { action: 'recolor', section: 's2', color: 'peer-5' },
    ]);
    expect(changed.ok && changed.sections.map((x) => [x.name, x.color])).toEqual([
      ['订单中心', 'peer-1'],
      ['用户', 'peer-5'],
    ]);

    expect(
      run([
        { action: 'rename', section: 's1', name: 'ok' },
        { action: 'recolor', section: 'nope', color: 'peer-1' },
      ]),
    ).toMatchObject({ ok: false, code: 'section_not_found', index: 1 });
  });

  test('delete：只删板块，其中表回到未分组', () => {
    const res = run([{ action: 'delete', section: 's2' }]);
    expect(res.ok && res.sections.map((x) => x.id)).toEqual(['s1']);
    expect(res.ok && res.deleted).toEqual(['s2']);
    expect(run([{ action: 'delete', section: 'nope' }])).toMatchObject({
      ok: false,
      code: 'section_not_found',
      index: 0,
    });
  });

  test('add_tables：保持“一张表至多 1 个板块”并记录 moved；已在目标板块为 noop', () => {
    const res = run([{ action: 'add_tables', section: 's1', tables: ['t2', 't3', 't1'] }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sections).toEqual([
      { id: 's1', name: '订单', color: 'peer-1', tables: ['t1', 'ghost', 't2', 't3'] },
      { id: 's2', name: '用户', color: 'peer-2', tables: [] },
    ]);
    expect(res.moved).toEqual([{ tableId: 't2', from: 's2', to: 's1' }]);
    const owners = new Map<string, number>();
    for (const sec of res.sections) for (const t of sec.tables) owners.set(t, (owners.get(t) ?? 0) + 1);
    expect([...owners.values()].every((n) => n === 1)).toBe(true);

    expect(run([{ action: 'add_tables', section: 's1', tables: ['t1'] }])).toMatchObject({
      ok: true,
      changed: false,
      moved: [],
    });
  });

  test('add_tables：不存在 / 非表报 table_not_found（带 tableIds 与 index），分区子表报 invalid', () => {
    expect(
      run([
        { action: 'rename', section: 's1', name: 'x' },
        { action: 'add_tables', section: 's1', tables: ['t3', 'zzz', 'col1'] },
      ]),
    ).toEqual({
      ok: false,
      code: 'table_not_found',
      index: 1,
      message: expect.stringContaining('zzz'),
      tableIds: ['zzz', 'col1'],
    });
    const part = run([{ action: 'add_tables', section: 's1', tables: ['part1'] }]);
    expect(part).toMatchObject({ ok: false, code: 'invalid', index: 0, tableIds: ['part1'] });
    expect(!part.ok && part.message).toContain('父表');
    // create.tables 同样校验
    expect(run([{ action: 'create', id: 'sec-n', name: 'n', tables: ['nope'] }])).toMatchObject({
      ok: false,
      code: 'table_not_found',
      index: 0,
    });
  });

  test('remove_tables：不校验 model（可清悬空 ID），表不在板块中时幂等 noop', () => {
    const res = run([{ action: 'remove_tables', section: 's1', tables: ['ghost'] }]);
    expect(res.ok && res.sections[0]!.tables).toEqual(['t1']);
    expect(run([{ action: 'remove_tables', section: 's1', tables: ['t2', 'never'] }])).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(run([{ action: 'remove_tables', section: 'nope', tables: ['t1'] }])).toMatchObject({
      ok: false,
      code: 'section_not_found',
    });
  });

  test('不主动清理未触碰板块的历史悬空表 ID；失败时整批不生效', () => {
    const res = run([{ action: 'rename', section: 's2', name: '会员' }]);
    expect(res.ok && res.sections[0]!.tables).toEqual(['t1', 'ghost']);
    const b = base();
    const failed = run(
      [
        { action: 'delete', section: 's1' },
        { action: 'delete', section: 's1' },
      ],
      b,
    );
    expect(failed).toMatchObject({ ok: false, code: 'section_not_found', index: 1 });
    expect(b).toEqual(base());
  });
});

describe('resolveSectionActions', () => {
  let n = 0;
  const gen = () => `sec-gen-${++n}`;

  test('create 一律生成新 ID；$ref 引用本批更早 create.ref；普通字符串按 ID 原样使用', () => {
    n = 0;
    const res = resolveSectionActions(
      [
        { action: 'create', ref: 'orders', name: '订单' },
        { action: 'add_tables', section: '$ref:orders', tables: ['t1'] },
        { action: 'rename', section: 's2', name: '用户' },
      ],
      gen,
    );
    expect(res).toEqual({
      ok: true,
      refs: { orders: 'sec-gen-1' },
      actions: [
        { action: 'create', id: 'sec-gen-1', name: '订单' },
        { action: 'add_tables', section: 'sec-gen-1', tables: ['t1'] },
        { action: 'rename', section: 's2', name: '用户' },
      ],
    });
  });

  test('重复 ref 报 invalid；未定义或在定义之前使用的 $ref 报 section_not_found 带 index', () => {
    expect(
      resolveSectionActions(
        [
          { action: 'create', ref: 'a', name: 'A' },
          { action: 'create', ref: 'a', name: 'B' },
        ],
        gen,
      ),
    ).toMatchObject({ ok: false, code: 'invalid', index: 1 });
    expect(
      resolveSectionActions(
        [
          { action: 'delete', section: '$ref:later' },
          { action: 'create', ref: 'later', name: 'L' },
        ],
        gen,
      ),
    ).toMatchObject({ ok: false, code: 'section_not_found', index: 0 });
  });
});

describe('manage_sections MCP 契约', () => {
  test('复用 write scope 与 sync.edit 动作，登记审计动作 sections.update', () => {
    expect(MCP_TOOLS.manage_sections).toEqual({ scope: 'write', action: 'sync.edit' });
    expect(MCP_AUDIT_ACTIONS).toContain('sections.update');
  });

  test('输入 schema：所有动作 strict 拒绝坐标字段与未知字段', () => {
    const ok = mcpManageSectionsInputSchema.safeParse({
      project: 'acme/orders',
      actions: [
        { action: 'create', ref: 'a', name: '订单', color: 'peer-3', tables: ['t1'] },
        { action: 'add_tables', section: '$ref:a', tables: ['t2'] },
      ],
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.dryRun).toBe(false);

    const coordinates = [
      { action: 'create', name: 'x', x: 10, y: 20 },
      { action: 'create', name: 'x', width: 300, height: 200 },
      { action: 'rename', section: 's1', name: 'x', positions: { t1: { x: 1, y: 2 } } },
      { action: 'recolor', section: 's1', color: 'peer-1', x: 1 },
      { action: 'delete', section: 's1', y: 1 },
      { action: 'add_tables', section: 's1', tables: ['t1'], positions: {} },
      { action: 'remove_tables', section: 's1', tables: ['t1'], width: 1 },
    ];
    for (const a of coordinates) {
      expect(
        mcpManageSectionsInputSchema.safeParse({ project: 'p', actions: [a] }).success,
        JSON.stringify(a),
      ).toBe(false);
    }
    expect(
      mcpManageSectionsInputSchema.safeParse({
        project: 'p',
        actions: [{ action: 'delete', section: 's' }],
        x: 1,
      }).success,
    ).toBe(false);
  });

  test('输入 schema：动作数、表数、颜色、空表列表、动作名与 $ref 格式', () => {
    const parse = (actions: unknown[]) =>
      mcpManageSectionsInputSchema.safeParse({ project: 'p', actions }).success;
    expect(parse([])).toBe(false);
    expect(
      parse(Array.from({ length: MCP_MAX_SECTION_ACTIONS + 1 }, () => ({ action: 'delete', section: 's' }))),
    ).toBe(false);
    expect(
      parse([
        {
          action: 'add_tables',
          section: 's',
          tables: Array.from({ length: MCP_MAX_SECTION_TABLES_PER_ACTION + 1 }, (_, i) => `t${i}`),
        },
      ]),
    ).toBe(false);
    expect(parse([{ action: 'recolor', section: 's', color: 'red' }])).toBe(false);
    expect(parse([{ action: 'add_tables', section: 's', tables: [] }])).toBe(false);
    expect(parse([{ action: 'move', section: 's' }])).toBe(false);
    expect(parse([{ action: 'delete', section: '$ref:bad alias' }])).toBe(false);
    expect(parse([{ action: 'create', ref: 'bad ref', name: 'x' }])).toBe(false);
    expect(parse([{ action: 'create', name: '   ' }])).toBe(false);
  });
});
