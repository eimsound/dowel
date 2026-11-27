// Inspector / Canvas 的“非空”复选框、推断提示与 NN 徽标（Issue #161，ADR 0019）：
// 复选框只绑显式 notNull；SQL Server 持久化计算列由引擎推断为非空时不勾选、显示只读提示，
// 徽标与画布按有效可空性显示。
import { type Column, emptyModel, type Model, runMutator, setMssqlInferredNotNull } from '@dowel/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test } from 'vitest';

import { buildCanvasColumn } from '../src/components/Canvas.tsx';
import {
  ColumnNotNullBadge,
  ColumnNotNullCheckbox,
  ColumnNotNullInferredHint,
} from '../src/components/ColumnNullability.tsx';
import i18n from '../src/i18n.ts';
import {
  canvasColumnNotNull,
  columnNullability,
  notNullCheckboxDisabled,
  showRowInferredDescription,
} from '../src/nullability.ts';

afterEach(async () => {
  await i18n.changeLanguage('zh');
});

const mssql = (cp: { notNull?: boolean; inferred?: boolean; stored?: boolean } = {}): Model => {
  const m = emptyModel('mssql');
  runMutator(m, 'createSchema', { id: 's', name: 'dbo' });
  runMutator(m, 'createTable', { id: 't', schema: 's', name: 'items' });
  runMutator(m, 'addColumn', {
    table: 't',
    column: { id: 'code', name: 'code', type: 'nvarchar(10)', notNull: true },
  });
  runMutator(m, 'addColumn', {
    table: 't',
    column: {
      id: 'cp',
      name: 'cp',
      type: 'nvarchar(10)',
      notNull: cp.notNull ?? false,
      generated: { expr: '([code])', stored: cp.stored ?? true },
    },
  });
  if (cp.inferred) setMssqlInferredNotNull(m.objects.cp as Column, true);
  return m;
};
const col = (m: Model, id = 'cp') => m.objects[id] as Column;
const state = (m: Model, id = 'cp') => columnNullability(m, col(m, id));

describe('columnNullability', () => {
  test('显式声明：勾选、徽标、无推断提示（不论是否也推断为非空）', () => {
    expect(state(mssql({ notNull: true }))).toEqual({ explicit: true, effective: true, inferredOnly: false });
    expect(state(mssql({ notNull: true, inferred: true }))).toEqual({
      explicit: true,
      effective: true,
      inferredOnly: false,
    });
  });

  test('只由引擎推断：不勾选、显示推断提示、徽标仍显示', () => {
    expect(state(mssql({ inferred: true }))).toEqual({
      explicit: false,
      effective: true,
      inferredOnly: true,
    });
  });

  test('可空：不勾选、无提示、无徽标', () => {
    expect(state(mssql())).toEqual({ explicit: false, effective: false, inferredOnly: false });
  });

  test('勾选推断列 → 显式；再取消 → 回到推断提示（推断值不变）', () => {
    const m = mssql({ inferred: true });
    runMutator(m, 'setNotNull', { id: 'cp', notNull: true });
    expect(state(m)).toEqual({ explicit: true, effective: true, inferredOnly: false });
    runMutator(m, 'setNotNull', { id: 'cp', notNull: false });
    expect(state(m)).toEqual({ explicit: false, effective: true, inferredOnly: true });
  });

  test('非持久化计算列与普通列：不看推断标记', () => {
    const m = mssql({ stored: false });
    col(m).ext = { mssql: { inferredNotNull: true } };
    expect(state(m)).toEqual({ explicit: false, effective: false, inferredOnly: false });
    expect(state(m, 'code')).toEqual({ explicit: true, effective: true, inferredOnly: false });
  });

  test('其他方言不读 ext.mssql', () => {
    const m = emptyModel('pg');
    runMutator(m, 'createSchema', { id: 's', name: 'public' });
    runMutator(m, 'createTable', { id: 't', schema: 's', name: 'items' });
    runMutator(m, 'addColumn', {
      table: 't',
      column: { id: 'g', name: 'g', type: 'integer', generated: { expr: '(1)', stored: true } },
    });
    col(m, 'g').ext = { mssql: { inferredNotNull: true } };
    expect(state(m, 'g')).toEqual({ explicit: false, effective: false, inferredOnly: false });
  });

  test('提示与徽标文案（中 / 英）', async () => {
    expect(i18n.t('insp.notNullInferredHint')).toBe(
      '由表达式推断为非空，DDL 不写 NOT NULL；勾选才是显式声明。推断结果在规范化时更新。',
    );
    expect(i18n.t('insp.notNullInferred')).toBe('由表达式推断为非空（未显式声明）');
    await i18n.changeLanguage('en');
    expect(i18n.t('insp.notNullInferredHint')).toBe(
      'Inferred as non-null from the expression; the DDL does not add NOT NULL. Check the box to declare it explicitly. Updated on normalization.',
    );
    expect(i18n.t('insp.notNullInferred')).toBe('Inferred as non-null from the expression (not explicit)');
  });
});

describe('Inspector 与 Canvas 渲染绑定（renderToStaticMarkup + 纯映射，#178 review）', () => {
  test('ColumnNotNullCheckbox：复选框只绑显式 notNull（推断非空时不勾选且不禁用，可点击勾选为显式）', () => {
    const renderBox = (m: Model, id = 'cp') =>
      renderToStaticMarkup(
        createElement(ColumnNotNullCheckbox, {
          model: m,
          column: col(m, id),
          hintId: 'hint-cp',
          label: i18n.t('insp.notNull'),
          onChange: () => {},
        }),
      );

    // 推断非空：未勾选、不禁用、带 aria-describedby（杀死 checked={nn.effective} 变异）
    const inferredHtml = renderBox(mssql({ inferred: true }));
    expect(inferredHtml).not.toContain('checked');
    expect(inferredHtml).not.toContain('disabled');
    expect(inferredHtml).toContain('aria-describedby="hint-cp"');

    // 显式 NOT NULL（不论是否也推断为非空）：勾选、无推断 aria-describedby
    for (const m of [mssql({ notNull: true }), mssql({ notNull: true, inferred: true })]) {
      const explicitHtml = renderBox(m);
      expect(explicitHtml).toContain('checked');
      expect(explicitHtml).not.toContain('aria-describedby');
    }

    // 可空列：未勾选、无 aria-describedby
    const nullableHtml = renderBox(mssql());
    expect(nullableHtml).not.toContain('checked');
    expect(nullableHtml).not.toContain('aria-describedby');

    // 非持久化计算列：禁用
    const virtualHtml = renderBox(mssql({ stored: false }));
    expect(virtualHtml).toContain('disabled');
    expect(virtualHtml).not.toContain('checked');

    // MSSQL SPARSE 可空列：禁用
    const mSparse = mssql();
    runMutator(mSparse, 'addColumn', {
      table: 't',
      column: { id: 'sp', name: 'sp', type: 'nvarchar(10)', ext: { mssql: { sparse: true } } },
    });
    expect(notNullCheckboxDisabled(mSparse, col(mSparse, 'sp'))).toBe(true);
    expect(renderBox(mSparse, 'sp')).toContain('disabled');
  });

  test('ColumnNotNullInferredHint & showRowInferredDescription：仅在非显式推断非空时展示提示（杀死去掉提示变异）', () => {
    const renderHint = (m: Model) =>
      renderToStaticMarkup(
        createElement(ColumnNotNullInferredHint, {
          model: m,
          column: col(m),
          id: 'hint-cp',
          text: i18n.t('insp.notNullInferredHint'),
        }),
      );

    const inferredModel = mssql({ inferred: true });
    expect(renderHint(inferredModel)).toBe(
      `<p id="hint-cp" class="hint m-0">${i18n.t('insp.notNullInferredHint')}</p>`,
    );
    expect(showRowInferredDescription(inferredModel, col(inferredModel), false)).toBe(true);
    expect(showRowInferredDescription(inferredModel, col(inferredModel), true)).toBe(false);

    for (const m of [
      mssql({ notNull: true, inferred: true }),
      mssql({ notNull: true }),
      mssql(),
      mssql({ stored: false }),
    ]) {
      expect(renderHint(m)).toBe('');
      expect(showRowInferredDescription(m, col(m), false)).toBe(false);
    }
  });

  test('ColumnNotNullBadge & Canvas buildCanvasColumn：按有效可空性显示徽标与隐藏问号（杀死只看 c.notNull 变异）', () => {
    const renderBadge = (m: Model) =>
      renderToStaticMarkup(
        createElement(ColumnNotNullBadge, {
          model: m,
          column: col(m),
          inferredTitle: i18n.t('insp.notNullInferred'),
        }),
      );
    const canvasCol = (m: Model, isPk = false) =>
      buildCanvasColumn(m, col(m), {
        isPk,
        isFk: false,
        isUq: false,
        isPartKey: false,
        hasSourceHandle: false,
        hasTargetHandle: false,
      });

    // 只由表达式推断非空：Inspector 显示虚线框 NN + title；Canvas notNull 为 true（不画 ?）
    const inferredModel = mssql({ inferred: true });
    expect(renderBadge(inferredModel)).toBe(
      `<b class="flag inferred" title="${i18n.t('insp.notNullInferred')}">NN</b>`,
    );
    expect(canvasCol(inferredModel).notNull).toBe(true);
    expect(canvasColumnNotNull(inferredModel, col(inferredModel), false)).toBe(true);

    // 显式 NOT NULL：实心 NN、无 title；Canvas notNull 为 true
    const explicitModel = mssql({ notNull: true });
    expect(renderBadge(explicitModel)).toBe('<b class="flag">NN</b>');
    expect(canvasCol(explicitModel).notNull).toBe(true);

    // 可空 / 非持久化计算列（即使误带 inferredNotNull）：无 NN 徽标；Canvas notNull 为 false（显示 ?）；作 PK 时为 true
    const nullableModel = mssql();
    expect(renderBadge(nullableModel)).toBe('');
    expect(canvasCol(nullableModel).notNull).toBe(false);
    expect(canvasCol(nullableModel, true).notNull).toBe(true);

    const virtTagged = mssql({ stored: false });
    col(virtTagged).ext = { mssql: { inferredNotNull: true } };
    expect(renderBadge(virtTagged)).toBe('');
    expect(canvasCol(virtTagged).notNull).toBe(false);
  });
});
