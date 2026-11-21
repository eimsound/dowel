// 前端多方言 UI 规格与 i18n 一致性单元测试（不依赖任何数据库或外部容器）。
import {
  addColumn,
  addPrimaryKey,
  createAll,
  createSchema,
  createTable,
  type Dialect,
  emptyModel,
  formatScript,
  getDialect,
  validate,
} from '@dowel/core';
import { describe, expect, test } from 'vitest';

import {
  defaultSchemaOf,
  DIALECT_UI_LIST,
  DIALECT_UI_SPECS,
  dialectUiSpec,
  formatEngineVersion,
} from '../src/dialects.ts';
import i18n from '../src/i18n.ts';

describe('DIALECT_UI_SPECS 与 @dowel/core capabilities 对齐', () => {
  test('全部 4 种方言均已启用且能力标志与 core 一致', () => {
    expect(DIALECT_UI_LIST.map((d) => d.id)).toEqual(['pg', 'sqlite', 'mysql', 'mssql']);
    for (const ui of DIALECT_UI_LIST) {
      const core = getDialect(ui.id).capabilities;
      expect(ui.implemented, `${ui.id}.implemented`).toBe(true);
      expect(ui.defaultSchema, `${ui.id}.defaultSchema`).toBe(core.defaultSchema);
      expect(ui.schemas, `${ui.id}.schemas`).toBe(core.schemas);
      expect(ui.enums, `${ui.id}.enums`).toBe(core.enums);
      expect(ui.sequences, `${ui.id}.sequences`).toBe(core.sequences);
      expect(ui.partitioning, `${ui.id}.partitioning`).toBe(core.partitioning);
      expect(ui.transactionalDdl, `${ui.id}.transactionalDdl`).toBe(core.transactionalDdl);
      expect(ui.requiresExternalShadow, `${ui.id}.requiresExternalShadow`).toBe(core.requiresExternalShadow);
      expect(ui.historyStorage, `${ui.id}.historyStorage`).toBe(core.historyStorage);
      expect(ui.comments, `${ui.id}.comments`).toBe(core.comments);
    }
  });

  test('URL 与影子库占位符符合各方言规范', () => {
    expect(DIALECT_UI_SPECS.mysql.urlPlaceholder).toMatch(/^mysql:\/\//);
    expect(DIALECT_UI_SPECS.mysql.shadowPlaceholder).toMatch(/^mysql:\/\//);
    expect(DIALECT_UI_SPECS.mssql.urlPlaceholder).toMatch(/^mssql:\/\/.*\?encrypt=true/);
    expect(DIALECT_UI_SPECS.mssql.shadowPlaceholder).toMatch(/^mssql:\/\/.*\?encrypt=true/);
  });

  test('dialectUiSpec 与 defaultSchemaOf 回退行为', () => {
    expect(dialectUiSpec(undefined).id).toBe('pg');
    expect(dialectUiSpec(null).id).toBe('pg');
    expect(dialectUiSpec('unknown').id).toBe('pg');
    expect(defaultSchemaOf({ dialect: 'pg' })).toBe('public');
    expect(defaultSchemaOf({ dialect: 'sqlite' })).toBe('main');
    expect(defaultSchemaOf({ dialect: 'mysql' })).toBe('default');
    expect(defaultSchemaOf({ dialect: 'mssql' })).toBe('dbo');
  });

  test.each(['pg', 'sqlite', 'mysql', 'mssql'] as const)(
    '%s: defaultPkColumn 建表并通过核心 model 校验与 DDL 生成',
    (dialect: Dialect) => {
      const ui = DIALECT_UI_SPECS[dialect];
      const m = emptyModel(dialect);
      const schId = createSchema(m, ui.defaultSchema, 'sch1');
      const tblId = createTable(m, schId, 'items', 'tbl1');
      const pkCol = ui.defaultPkColumn('col1');
      addColumn(m, tblId, pkCol);
      if (ui.autoPrimaryKey) {
        addPrimaryKey(m, tblId, ['col1'], 'pk1');
      }

      expect(validate(m), `${dialect} validate 应无错误`).toEqual([]);
      const sql = formatScript(createAll(m), dialect);
      expect(sql.length).toBeGreaterThan(0);

      if (dialect === 'mysql') {
        expect(pkCol.ext?.mysql?.autoIncrement).toBe(true);
        expect(sql).toContain('AUTO_INCREMENT');
      } else if (dialect === 'mssql') {
        expect(pkCol.ext?.mssql?.identity).toEqual({ seed: '1', increment: '1' });
        expect(sql).toContain('IDENTITY(1, 1)');
        expect(sql).toContain('GO');
      } else if (dialect === 'sqlite') {
        expect(pkCol.ext?.sqlite?.autoincrement).toBe(true);
        expect(sql).toContain('AUTOINCREMENT');
      }
    },
  );
});

describe('formatEngineVersion', () => {
  test('正确格式化常规版本号、仅 major、空白版本号与 full 模式', () => {
    expect(formatEngineVersion('pg', null, 18)).toBe('PG 18');
    expect(formatEngineVersion('pg', '18.2', 18, true)).toBe('PostgreSQL 18.2');
    expect(formatEngineVersion('mysql', '8.4.3', 8, true)).toBe('MySQL 8.4.3');
    expect(formatEngineVersion('mssql', '2022 (16.0)', 16)).toBe('MSSQL 2022 (16.0)');
    expect(formatEngineVersion('mssql', '   ', 16)).toBe('MSSQL 16');
    expect(formatEngineVersion('sqlite', '   ', null)).toBeNull();
    expect(formatEngineVersion('pg', null, null)).toBeNull();
  });
});

describe('多方言 i18n 键对齐与解禁状态', () => {
  const flattenKeys = (obj: Record<string, unknown>, prefix = ''): string[] => {
    const out: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      const next = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(...flattenKeys(v as Record<string, unknown>, next));
      } else {
        out.push(next);
      }
    }
    return out.sort();
  };

  test('zh 与 en 词条键集合完全一致且无「即将支持 / Coming soon」描述', () => {
    const zhStore = i18n.getResourceBundle('zh', 'translation') as Record<string, unknown>;
    const enStore = i18n.getResourceBundle('en', 'translation') as Record<string, unknown>;
    expect(flattenKeys(zhStore)).toEqual(flattenKeys(enStore));

    for (const lng of ['zh', 'en'] as const) {
      const mysqlDesc = i18n.t('wiz.dialectDesc.mysql', { lng });
      const mssqlDesc = i18n.t('wiz.dialectDesc.mssql', { lng });
      expect(mysqlDesc).not.toMatch(/即将支持|coming soon/i);
      expect(mssqlDesc).not.toMatch(/即将支持|coming soon/i);
    }
  });
});
