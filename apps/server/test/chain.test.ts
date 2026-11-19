// 冻结迁移的纯逻辑：空库模型表示“范围内的一个全新数据库”，是否带 public 由项目的 schema 范围决定。
// - 范围覆盖 public（null 或包含 'public'）：带 public（目标模型有就沿用它的 ID，没有就生成一个）；
// - 范围不含 public（例如 ['app']）：不带，冻结的基线和第一个版本都不碰 public。
import { addColumn, createSchema, createTable, emptyModel, type Model } from '@dowel/core';
import { describe, expect, test } from 'vitest';
import {
  chainFrom,
  emptyBase,
  freezeBaseline,
  freezeScripts,
  instanceLevelProblem,
  scopeCoversPublic,
} from '../src/chain.ts';

const model = (schemas: string[]): Model => {
  const m = emptyModel();
  for (const s of schemas) {
    const id = createSchema(m, s);
    const t = createTable(m, id, 'orders');
    addColumn(m, t, { name: 'id', type: 'bigint' });
  }
  return m;
};

const sqlOf = (f: { up: { sql: string }[]; down: { sql: string }[] }) =>
  [...f.up, ...f.down].map((s) => s.sql).join('\n');

test('范围是否覆盖 public', () => {
  expect(scopeCoversPublic(null)).toBe(true);
  expect(scopeCoversPublic(undefined)).toBe(true);
  expect(scopeCoversPublic([])).toBe(true);
  expect(scopeCoversPublic(['public', 'app'])).toBe(true);
  expect(scopeCoversPublic(['app'])).toBe(false);
});

describe('emptyBase', () => {
  test('范围覆盖 public，目标模型有 public：空库里也有 public，ID 相同', () => {
    const to = model(['public']);
    const pub = Object.values(to.objects).find((o) => o.kind === 'schema')!;
    expect(Object.keys(emptyBase(to, null).objects)).toEqual([pub.id]);
    expect(Object.keys(emptyBase(to, ['public']).objects)).toEqual([pub.id]);
  });

  test('范围覆盖 public，目标模型没有 public：空库里带一个新的 public（用户把它删了）', () => {
    const base = emptyBase(model(['app']), null);
    const schemas = Object.values(base.objects);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toMatchObject({ kind: 'schema', name: 'public' });
  });

  test('目标模型没有 public 时 public 的 ID 是确定的：连续两次得到深度相等的结果（回填 / 重新验证 / 预览一致）', () => {
    const noPublic = model(['app']);
    expect(emptyBase(noPublic, null)).toEqual(emptyBase(noPublic, null));
    expect(emptyBase(noPublic, ['public', 'app'])).toEqual(emptyBase(model(['other']), null));
    // 由它冻结出来的脚本也完全一样（checksum 相同）
    expect(freezeBaseline(noPublic, null).checksum).toBe(freezeBaseline(noPublic, null).checksum);
    expect(freezeBaseline(noPublic, null).from).toEqual(emptyBase(noPublic, null));
  });

  test('范围不含 public：空库模型是空的，哪怕目标模型里有 public', () => {
    expect(emptyBase(model(['app']), ['app']).objects).toEqual({});
    expect(emptyBase(model(['public', 'app']), ['app']).objects).toEqual({});
    expect(chainFrom(null, model(['app']), ['app']).objects).toEqual({});
  });

  test('有上一个版本时 from 就是它，与范围无关', () => {
    const parent = { model: model(['app']) };
    expect(chainFrom(parent, model(['app']), null)).toBe(parent.model);
  });
});

describe('范围不含 public：冻结脚本不碰 public', () => {
  const to = model(['app']);

  test('v0 基线：只建 app，没有 DROP SCHEMA public', () => {
    const f = freezeBaseline(to, ['app']);
    expect(f.up[0]!.sql).toBe('CREATE SCHEMA app');
    expect(sqlOf(f)).not.toMatch(/public/);
    expect(f.down).toEqual([]);
  });

  test('第一个版本（从空库迁移）：up 和 down 都不碰 public', () => {
    const f = freezeScripts(emptyBase(to, ['app']), to);
    expect(sqlOf(f)).not.toMatch(/public/);
    expect(f.down.map((s) => s.sql)).toContain('DROP SCHEMA app');
  });
});

describe('范围覆盖 public', () => {
  test('目标模型有 public：基线不会 CREATE 它（空库本来就有），第一个版本也不会 DROP 它', () => {
    const withPublic = model(['public', 'app']);
    for (const scope of [null, ['public', 'app']]) {
      const sql = freezeBaseline(withPublic, scope)
        .up.map((s) => s.sql)
        .join('\n');
      expect(sql).not.toContain('CREATE SCHEMA public');
      expect(sql).toContain('CREATE SCHEMA app');
      const v1 = freezeScripts(emptyBase(withPublic, scope), withPublic);
      expect(sqlOf(v1)).not.toMatch(/(CREATE|DROP) SCHEMA public/);
    }
  });

  test('目标模型里用户把 public 删了：基线和第一个版本都要 DROP SCHEMA public（全新的库本来就有它）', () => {
    const noPublic = model(['app']);
    for (const scope of [null, ['public', 'app']]) {
      expect(freezeBaseline(noPublic, scope).up.map((s) => s.sql)).toContain('DROP SCHEMA public');
      const v1 = freezeScripts(emptyBase(noPublic, scope), noPublic);
      expect(v1.up.map((s) => s.sql)).toContain('DROP SCHEMA public');
      // 回滚把它建回来
      expect(v1.down.map((s) => s.sql)).toContain('CREATE SCHEMA public');
    }
  });
});

describe('instanceLevelProblem（发布时的兜底检查、编辑脚本时的检查）', () => {
  const ok = (sql: string) => ({ sql, transactional: true });
  test('规划器生成的冻结脚本没有实例级语句', () => {
    const f = freezeScripts(emptyBase(model(['public']), null), model(['public', 'app']));
    expect(instanceLevelProblem(f.up, f.down)).toBeNull();
    expect(instanceLevelProblem(freezeBaseline(model(['app']), ['app']).up, [])).toBeNull();
  });

  test('有实例级语句就说明是哪一边第几步', () => {
    const up = instanceLevelProblem([ok('CREATE TABLE a (i int)'), ok('CREATE DATABASE x')], []);
    expect(up).toContain('升级脚本第 2 步');
    expect(up).toContain('实例级语句不能放进迁移');
    const down = instanceLevelProblem([ok('SELECT 1')], [ok('ALTER SYSTEM SET a = 1')]);
    expect(down).toContain('回滚脚本第 1 步');
    // 先报升级那一边
    expect(instanceLevelProblem([ok('DROP ROLE r')], [ok('CREATE ROLE r')])).toContain('升级脚本第 1 步');
  });
});
