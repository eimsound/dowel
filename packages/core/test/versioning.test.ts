import { describe, expect, it } from 'vitest';

import {
  type Dialect,
  describeTarget,
  diagnoseModel,
  emptyModel,
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

describe('describeTarget / targetInfo（ADR 0015 第 5 节：get_model 的目标版本上下文）', () => {
  const cases: {
    dialect: Dialect;
    nums: (number | null)[];
    label: string;
    features: Record<string, boolean>;
  }[] = [
    {
      dialect: 'pg',
      nums: [170002, null, 150004],
      label: 'PG 15',
      features: {
        nullsNotDistinct: true,
        partitionedIdentity: false,
        partitionedExclusion: false,
        domainNotNullInConstraint: false,
        virtualGenerated: false,
        namedNotNull: false,
        notNullNotValid: false,
        partitionedNotValidConstraint: false,
        uuidv7: false,
        repack: false,
      },
    },
    { dialect: 'mysql', nums: [90700, 80413], label: 'MySQL 8.4', features: { vectorType: false } },
    { dialect: 'mysql', nums: [90700], label: 'MySQL 9.7', features: { vectorType: true } },
    {
      dialect: 'mssql',
      nums: [170000, 160000],
      label: 'SQL Server 2022',
      features: { nativeJson: false, vectorType: false },
    },
    {
      dialect: 'mssql',
      nums: [170000],
      label: 'SQL Server 2025',
      features: { nativeJson: true, vectorType: true },
    },
  ];

  it.each(cases)(
    '$dialect $nums → $label，且与 compatibility().target / diagnoseModel.target 完全一致',
    (c) => {
      const info = describeTarget(c.dialect, c.nums);
      expect(info).toEqual({ label: c.label, features: c.features });
      expect(getDialect(c.dialect).versioning.targetInfo?.(c.nums)).toEqual(info);
      const model = emptyModel(c.dialect);
      expect(getDialect(c.dialect).versioning.compatibility?.(model, c.nums)?.target).toBe(c.label);
      expect(diagnoseModel(model, c.nums).target).toBe(c.label);
    },
  );

  it('PG 18 门控特性按版本开启', () => {
    expect(describeTarget('pg', [180000])?.features).toMatchObject({
      virtualGenerated: true,
      uuidv7: true,
      repack: false,
    });
  });

  it.each(SUPPORTED_DIALECTS)('%s：没有环境或版本未缓存时返回 null，且与诊断 target 一致', (d) => {
    expect(describeTarget(d, [])).toBeNull();
    expect(describeTarget(d, [null, null])).toBeNull();
    expect(describeTarget(d)).toBeNull();
    expect(diagnoseModel(emptyModel(d), [null]).target).toBeNull();
  });

  it('SQLite 不区分目标版本：即使有缓存版本也返回 null', () => {
    expect(describeTarget('sqlite', [3054001])).toBeNull();
    expect(diagnoseModel(emptyModel('sqlite'), [3054001]).target).toBeNull();
  });
});
