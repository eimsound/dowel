import { describe, expect, it } from 'vitest';

import {
  type Dialect,
  getDialect,
  publicMajorOf,
  SUPPORTED_DIALECTS,
  versionGroupKeyOf,
} from '../src/index.ts';

describe('DialectVersioning', () => {
  it('formatVersionNum 与历史 envs.formatVersionNum 逐方言一致（MSSQL 沿用 PG 式 major.minor）', () => {
    const fmt = (d: Dialect, n: number) => getDialect(d).versioning.formatVersionNum(n);
    expect(fmt('pg', 160004)).toBe('16.4');
    expect(fmt('pg', 180000)).toBe('18.0');
    expect(fmt('mysql', 80413)).toBe('8.4.13');
    expect(fmt('mysql', 90700)).toBe('9.7.0');
    expect(fmt('sqlite', 3054001)).toBe('3.54.1');
    expect(fmt('mssql', 160000)).toBe('16.0');
    expect(fmt('mssql', 150004)).toBe('15.4');
  });

  it('版本组：PG 按大版本、MySQL 按主次版本，MSSQL / SQLite 不分组', () => {
    expect(versionGroupKeyOf('pg', 160004)).toBe(16);
    expect(versionGroupKeyOf('pg', 90600)).toBeNull();
    expect(versionGroupKeyOf('pg', null)).toBeNull();
    expect(versionGroupKeyOf('mysql', 80413)).toBe(804);
    expect(versionGroupKeyOf('mysql', 90700)).toBe(907);
    expect(versionGroupKeyOf('mysql', 999)).toBeNull();
    expect(versionGroupKeyOf('mssql', 160000)).toBeNull();
    expect(versionGroupKeyOf('sqlite', 3054001)).toBeNull();
    expect(getDialect('mssql').versioning.matrix).toBeUndefined();
    expect(getDialect('sqlite').versioning.matrix).toBeUndefined();
    expect(getDialect('pg').versioning.matrix?.groupLabel(16)).toBe('PG 16');
    expect(getDialect('mysql').versioning.matrix?.groupLabel(804)).toBe('MySQL 8.4');
  });

  it('对外大版本只对 PG 有值', () => {
    expect(publicMajorOf('pg', 150008)).toBe(15);
    expect(publicMajorOf('pg', undefined)).toBeNull();
    for (const d of SUPPORTED_DIALECTS.filter((x) => x !== 'pg')) {
      expect(publicMajorOf(d, 160000)).toBeNull();
    }
  });

  it('targetPlanOptions：取最低有效版本，非法值忽略，不推导的方言返回 undefined', () => {
    const target = (d: Dialect, nums: (number | null)[]) => getDialect(d).versioning.targetPlanOptions(nums);
    expect(target('pg', [180001, null, 150008, 160004])).toEqual({ pgMajor: 15 });
    expect(target('pg', [null, 90600])).toBeUndefined();
    expect(target('mysql', [90700, null, 80413, -1])).toEqual({ mysqlVersionNum: 80413 });
    expect(target('mysql', [null])).toBeUndefined();
    expect(target('mssql', [160000, 150000])).toBeUndefined();
    expect(target('sqlite', [3054001])).toBeUndefined();
  });
});
