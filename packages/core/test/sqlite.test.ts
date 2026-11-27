import { describe, expect, it } from 'vitest';

import {
  addCheck,
  addColumn,
  addForeignKey,
  addIndex,
  addPrimaryKey,
  addUnique,
  createAll,
  createEnum,
  createSchema,
  createSequence,
  createTable,
  dropColumn,
  emptyBase,
  emptyModel,
  findInstanceLevelStatement,
  formatScript,
  getDialect,
  isNontransactionalSql,
  macros,
  mutators,
  plan,
  renameColumn,
  renameKey,
  renameTable,
  runMacro,
  runMutator,
  scrubSecrets,
  setColumnExt,
  setColumnType,
  setDefault,
  setNotNull,
  setPartitionBy,
  setPrimaryKey,
  setTableExt,
  splitSqliteStatements,
  SQLITE_COLUMN_TYPE_NOTE,
  validate,
} from '../src/index.ts';

describe('multi-dialect core foundation & SQLite planner', () => {
  it('registers pg and sqlite dialects with expected capabilities', () => {
    const pg = getDialect('pg');
    const sqlite = getDialect('sqlite');
    expect(pg.capabilities.schemas).toBe(true);
    expect(pg.capabilities.defaultSchema).toBe('public');
    expect(pg.capabilities.requiresExternalShadow).toBe(true);
    expect(sqlite.capabilities.schemas).toBe(false);
    expect(sqlite.capabilities.defaultSchema).toBe('main');
    expect(sqlite.capabilities.requiresExternalShadow).toBe(false);
    expect(sqlite.capabilities.requiresTableRebuild).toBe(true);
    expect(sqlite.capabilities.historyStorage).toBe('prefix');
  });

  it('scrubSecrets masks postgres, mysql, mssql URLs and ODBC passwords', () => {
    expect(scrubSecrets('mysql://root:s3cr3t@db.local:3306/app')).toBe('mysql://root:***@db.local:3306/app');
    expect(scrubSecrets('mysql2://u:p@ss@host/db')).toBe('mysql2://u:***@host/db');
    expect(scrubSecrets('mssql://sa:Str0ng!Pass@10.0.0.1:1433/app')).toBe('mssql://sa:***@10.0.0.1:1433/app');
    expect(scrubSecrets('sqlserver://sa:pass/word@host/db')).toBe('sqlserver://sa:***@host/db');
    expect(scrubSecrets('Server=h;Database=d;User Id=sa;Password=secret123;Encrypt=true')).toBe(
      'Server=h;Database=d;User Id=sa;Password=***;Encrypt=true',
    );
    expect(scrubSecrets('Server=h;Pwd=my_pwd;Uid=sa')).toBe('Server=h;Pwd=***;Uid=sa');
    expect(scrubSecrets('sqlite:///data/app.db')).toBe('sqlite:///data/app.db');
  });

  it('blocks unsupported features on sqlite models via edit and mutators', () => {
    const m = emptyModel('sqlite');
    const s = createSchema(m, 'main');
    const t = createTable(m, s, 'users');
    const c = addColumn(m, t, { name: 'id', type: 'INTEGER', notNull: true });
    expect(() => createSchema(m, 'other')).toThrow();
    expect(() => createEnum(m, s, 'role', ['a'])).toThrow();
    expect(() => createSequence(m, s, 'seq1')).toThrow();
    expect(() =>
      setPartitionBy(m, t, {
        strategy: 'range',
        keys: [{ column: c, expr: null, opclass: null, collation: null }],
      }),
    ).toThrow();
    expect(() =>
      runMutator(m, 'createEnum', { id: 'e1', schema: s, name: 'status', values: ['ok'] }),
    ).toThrow();
  });

  it('detects SQLite non-transactional and dangerous file statements', () => {
    expect(isNontransactionalSql('PRAGMA foreign_keys = OFF', 'sqlite')).toBe(true);
    expect(isNontransactionalSql('VACUUM', 'sqlite')).toBe(true);
    expect(isNontransactionalSql('BEGIN IMMEDIATE; CREATE TABLE t(a INT); COMMIT', 'sqlite')).toBe(true);
    expect(isNontransactionalSql('CREATE TABLE t(a INT)', 'sqlite')).toBe(false);

    expect(findInstanceLevelStatement("ATTACH DATABASE '/etc/passwd' AS p", 'sqlite')).not.toBeNull();
    expect(findInstanceLevelStatement("ATTACH '/tmp/x.db' AS x", 'sqlite')).not.toBeNull();
    expect(findInstanceLevelStatement('DETACH DATABASE x', 'sqlite')).not.toBeNull();
    expect(findInstanceLevelStatement("VACUUM INTO '/tmp/dump.db'", 'sqlite')).not.toBeNull();
    expect(
      findInstanceLevelStatement("-- ATTACH DATABASE '/tmp/x'\nCREATE TABLE t (a INT)", 'sqlite'),
    ).toBeNull();
  });

  it('splits SQLite statements while preserving CREATE TRIGGER BEGIN ... END blocks', () => {
    const sql = `
      CREATE TABLE a (id INTEGER PRIMARY KEY);
      CREATE TRIGGER tr_a AFTER INSERT ON a BEGIN
        UPDATE a SET id = CASE WHEN id > 0 THEN id ELSE 1 END;
        SELECT 1;
      END;
      CREATE INDEX idx_a ON a(id);
    `;
    const stmts = splitSqliteStatements(sql);
    expect(stmts).toHaveLength(3);
    expect(stmts[1]).toContain('CREATE TRIGGER tr_a');
    expect(stmts[1]).toContain('END');
  });

  it('uses in-place ALTER for safe SQLite edits and 12-step rebuild for table/column structural changes', () => {
    const m0 = emptyModel('sqlite');
    const s = createSchema(m0, 'main');
    const t = createTable(m0, s, 'users');
    const id = addColumn(m0, t, { name: 'id', type: 'INTEGER', notNull: true });
    addPrimaryKey(m0, t, [id]);
    setColumnExt(m0, id, { sqlite: { autoincrement: true } });
    const nameCol = addColumn(m0, t, {
      name: 'name',
      type: 'TEXT',
      notNull: true,
      default: { expr: "'anon'" },
    });
    expect(validate(m0)).toEqual([]);

    const createSteps = createAll(m0);
    expect(createSteps).toHaveLength(1);
    expect(createSteps[0]!.sql).toContain('PRIMARY KEY AUTOINCREMENT');

    // 1. In-place rename + safe ADD COLUMN
    const m1 = structuredClone(m0);
    renameTable(m1, t, 'accounts');
    renameColumn(m1, nameCol, 'full_name');
    addColumn(m1, t, { name: 'bio', type: 'TEXT' });
    const inPlaceSteps = plan(m0, m1);
    expect(inPlaceSteps.map((st) => st.kind)).toEqual(['renameTable', 'renameColumn', 'addColumn']);
    expect(inPlaceSteps.every((st) => st.transactional !== false)).toBe(true);

    // 2. Column type / NOT NULL / STRICT change triggers official 12-step rebuild
    const m2 = structuredClone(m1);
    setColumnType(m2, nameCol, 'TEXT');
    setNotNull(m2, nameCol, false);
    setDefault(m2, nameCol, null);
    setTableExt(m2, t, { sqlite: { strict: true } });
    const rebuildSteps = plan(m1, m2);
    expect(rebuildSteps).toHaveLength(1);
    expect(rebuildSteps[0]!.kind).toBe('rebuildTable');
    expect(rebuildSteps[0]!.transactional).toBe(false);
    expect(rebuildSteps[0]!.sql).toContain('PRAGMA foreign_keys = OFF');
    expect(rebuildSteps[0]!.sql).toContain('BEGIN IMMEDIATE');
    expect(rebuildSteps[0]!.sql).toContain('INSERT INTO');
    expect(rebuildSteps[0]!.sql).toContain('PRAGMA foreign_key_check');
    expect(rebuildSteps[0]!.sql).toContain('COMMIT');
    expect(rebuildSteps[0]!.sql).toContain('PRAGMA foreign_keys = ON');
    expect(rebuildSteps[0]!.sql).toContain('STRICT');

    // 3. emptyBase for sqlite always yields single 'main' schema
    const base = emptyBase(m2, null);
    expect(base.dialect).toBe('sqlite');
    expect(Object.values(base.objects)).toHaveLength(1);
    expect(Object.values(base.objects)[0]!.name).toBe('main');

    // 4. Adding CHECK/UNIQUE/FK/Index + dropping unused column
    const m3 = structuredClone(m2);
    const bioCol = Object.values(m3.objects).find((o) => o.kind === 'column' && o.name === 'bio')!;
    addUnique(m3, t, [nameCol]);
    addCheck(m3, t, 'length(full_name) > 0');
    addIndex(m3, t, [{ column: nameCol }]);
    const orders = createTable(m3, s, 'orders');
    const oid = addColumn(m3, orders, { name: 'id', type: 'INTEGER', notNull: true });
    const uid = addColumn(m3, orders, { name: 'account_id', type: 'INTEGER', notNull: true });
    addPrimaryKey(m3, orders, [oid]);
    addForeignKey(m3, orders, [uid], t, [id], { onDelete: 'cascade' });
    dropColumn(m3, bioCol.id);
    expect(validate(m3)).toEqual([]);
    const steps23 = plan(m2, m3);
    expect(steps23.some((st) => st.kind === 'rebuildTable')).toBe(true);
    expect(steps23.some((st) => st.kind === 'createTable' && st.target === 'orders')).toBe(true);
    expect(steps23.some((st) => st.kind === 'createIndex')).toBe(true);
  });

  it('C1 & H1: blocks whitespace-less ATTACH/DETACH, EXPLAIN ATTACH, dangerous PRAGMAs, and dowel_* tampering', () => {
    for (const bad of [
      "ATTACH'/etc/passwd'AS pwn;",
      "ATTACH('x')AS pwn;",
      'DETACH"pwn";',
      'DETACH(pwn);',
      "EXPLAIN ATTACH '/tmp/x' AS pwn;",
      "EXPLAIN QUERY PLAN ATTACH '/tmp/x' AS pwn;",
      'PRAGMA writable_schema = ON;',
      'PRAGMA main.writable_schema = 1;',
      "PRAGMA temp_store_directory = '/tmp';",
      "PRAGMA data_store_directory = '/tmp';",
      'DROP TABLE dowel_history;',
      'DROP TRIGGER IF EXISTS dowel_history_no_delete;',
      'DELETE FROM dowel_history;',
      "UPDATE dowel_claims SET note = 'x';",
      "INSERT INTO dowel_meta VALUES ('k', 'v');",
      'CREATE TRIGGER tr_evil AFTER INSERT ON dowel_history BEGIN SELECT 1; END;',
      'CREATE TRIGGER tr_evil2 AFTER INSERT ON users BEGIN DELETE FROM dowel_history; END;',
    ]) {
      expect(findInstanceLevelStatement(bad, 'sqlite'), `expected block: ${bad}`).not.toBeNull();
    }
    expect(findInstanceLevelStatement('CREATE TABLE users (id INTEGER PRIMARY KEY)', 'sqlite')).toBeNull();
  });

  it('H1: enforces real-time identifier length and reserved prefix checks in edit.ts', () => {
    const pg = emptyModel('pg');
    const pub = createSchema(pg, 'public');
    expect(() => createSchema(pg, 'dowel')).toThrow(/dowel/);
    expect(() => createTable(pg, pub, 'a'.repeat(64))).toThrow(/63/);
    expect(() => createTable(pg, pub, '中'.repeat(22))).toThrow(/63/); // 66 UTF-8 bytes

    const sq = emptyModel('sqlite');
    const main = createSchema(sq, 'main');
    expect(() => createTable(sq, main, 'sqlite_secret')).toThrow(/sqlite_/);
    expect(() => createTable(sq, main, 'dowel_custom')).toThrow(/dowel_/);
    expect(() => createTable(sq, main, 'x'.repeat(129))).toThrow(/128/);
    const t = createTable(sq, main, 'notes');
    const id = addColumn(sq, t, { name: 'id', type: 'INTEGER', notNull: true });
    const ix = addIndex(sq, t, [{ column: id }]);
    expect(() => renameKey(sq, ix, 'sqlite_idx')).toThrow(/sqlite_/);
    expect(() => renameKey(sq, ix, 'dowel_idx')).toThrow(/dowel_/);
  });

  it('H3 & M1: pulls child FK table into atomic rebuild when parent rebuilds + renames referenced column, preserves sqlite_sequence & emits FK abort guard', () => {
    const m0 = emptyModel('sqlite');
    const main = createSchema(m0, 'main');
    const orgs = createTable(m0, main, 'orgs');
    const oid = addColumn(m0, orgs, { name: 'id', type: 'INTEGER', notNull: true });
    addPrimaryKey(m0, orgs, [oid]);
    setColumnExt(m0, oid, { sqlite: { autoincrement: true } });

    const members = createTable(m0, main, 'members');
    const mid = addColumn(m0, members, { name: 'id', type: 'INTEGER', notNull: true });
    const mOrg = addColumn(m0, members, { name: 'org_id', type: 'INTEGER', notNull: true });
    addPrimaryKey(m0, members, [mid]);
    addForeignKey(m0, members, [mOrg], orgs, [oid]);

    const m1 = structuredClone(m0);
    // Parent table both rebuilds (STRICT) AND renames referenced column id -> org_pk
    setTableExt(m1, orgs, { sqlite: { strict: true } });
    renameColumn(m1, oid, 'org_pk');

    const steps = plan(m0, m1);
    const rebuild = steps.find((s) => s.kind === 'rebuildTable');
    expect(rebuild).toBeDefined();
    expect(rebuild!.target).toContain('orgs');
    expect(rebuild!.target).toContain('members');
    expect(rebuild!.sql).toContain('sqlite_sequence');
    expect(rebuild!.sql).toContain('_dowel_fk_guard');
    expect(formatScript(steps, 'sqlite')).toContain('PRAGMA foreign_key_check');
  });

  it('M5: setPrimaryKey atomically updates PK on WITHOUT ROWID & clears autoincrement; dropColumn blocks last column on SQLite', () => {
    const m = emptyModel('sqlite');
    const main = createSchema(m, 'main');
    const t = createTable(m, main, 'items');
    const id = addColumn(m, t, { name: 'id', type: 'INTEGER', notNull: true });
    expect(() => dropColumn(m, id)).toThrow(/最后一列/);

    const code = addColumn(m, t, { name: 'code', type: 'TEXT', notNull: true });
    addPrimaryKey(m, t, [id]);
    setColumnExt(m, id, { sqlite: { autoincrement: true } });
    // Expanding to composite PK via setPrimaryKey clears autoincrement automatically
    setPrimaryKey(m, t, [id, code]);
    expect(validate(m)).toEqual([]);
    expect((m.objects[id] as { ext?: { sqlite?: { autoincrement?: boolean } } }).ext).toBeUndefined();

    // Turning on WITHOUT ROWID and atomically swapping PK to [code] succeeds without intermediate PK-less state
    setTableExt(m, t, { sqlite: { withoutRowid: true } });
    runMutator(m, 'setPrimaryKey', { table: t, columns: [code] });
    expect(validate(m)).toEqual([]);
    // Clearing PK completely on WITHOUT ROWID still fails
    expect(() => setPrimaryKey(m, t, [])).toThrow(/WITHOUT ROWID/);
  });

  it('SQLite type fidelity: STRICT whitelist, untyped columns, BIGINT/INT PK & AUTOINCREMENT, DDL, plan, macros', () => {
    // 1. STRICT 白名单与未声明类型报错
    const ms = emptyModel('sqlite');
    const mainS = createSchema(ms, 'main');
    const strictT = createTable(ms, mainS, 'strict_t', undefined, null, { sqlite: { strict: true } });
    const cInt = addColumn(ms, strictT, { name: 'id', type: 'int', notNull: true });
    expect((ms.objects[cInt] as { type: string }).type).toBe('INT');
    for (const ok of ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'ANY']) {
      addColumn(ms, strictT, { name: `c_${ok.toLowerCase()}`, type: ok.toLowerCase() });
    }
    expect(() => addColumn(ms, strictT, { name: 'bad_big', type: 'bigint' })).toThrow(/STRICT 表不支持/);
    expect(() => addColumn(ms, strictT, { name: 'bad_bool', type: 'BOOLEAN' })).toThrow(/STRICT 表不支持/);
    expect(() => addColumn(ms, strictT, { name: 'bad_empty', type: '' })).toThrow(/必须声明类型/);
    expect(() => addColumn(ms, strictT, { name: 'bad_ws', type: '   ' })).toThrow(/必须声明类型/);
    expect(() => setColumnType(ms, cInt, 'bigint')).toThrow(/STRICT 表不支持/);
    expect(() => setColumnType(ms, cInt, '')).toThrow(/必须声明类型/);
    expect(validate(ms)).toEqual([]);

    // 绕过编辑入口写入非法类型 / 空类型，validate 分别给出清晰提示
    (ms.objects[cInt] as { type: string }).type = '';
    expect(validate(ms)).toContainEqual(expect.stringMatching(/STRICT 表的列必须声明类型/));
    (ms.objects[cInt] as { type: string }).type = 'BIGINT';
    expect(validate(ms)).toContainEqual(expect.stringMatching(/当前为 BIGINT/));
    (ms.objects[cInt] as { type: string }).type = 'INT';

    // 非 STRICT 含无类型列时开启 STRICT 失败且报错提及“未声明类型”
    const looseT = createTable(ms, mainS, 'loose_t');
    const looseCol = addColumn(ms, looseT, { name: 'e', type: '' });
    expect((ms.objects[looseCol] as { type: string }).type).toBe('');
    expect(() => setTableExt(ms, looseT, { sqlite: { strict: true } })).toThrow(/未声明类型/);
    setColumnType(ms, looseCol, 'TEXT');
    expect((ms.objects[looseCol] as { type: string }).type).toBe('TEXT');
    setColumnType(ms, looseCol, '   ');
    expect((ms.objects[looseCol] as { type: string }).type).toBe('');
    expect(validate(ms)).toEqual([]);

    // 2. AUTOINCREMENT 只允许在 INTEGER 单列 PK 上，INT / BIGINT 拒绝，改类型自动清理
    const mPk = emptyModel('sqlite');
    const sPk = createSchema(mPk, 'main');
    const tBig = createTable(mPk, sPk, 'big_pk');
    const bigId = addColumn(mPk, tBig, { name: 'id', type: 'bigint', notNull: true });
    addPrimaryKey(mPk, tBig, [bigId]);
    const tInt = createTable(mPk, sPk, 'int_pk');
    const intId = addColumn(mPk, tInt, { name: 'id', type: 'int', notNull: true });
    addPrimaryKey(mPk, tInt, [intId]);
    expect(() => setColumnExt(mPk, bigId, { sqlite: { autoincrement: true } })).toThrow(/AUTOINCREMENT/);
    expect(() => setColumnExt(mPk, intId, { sqlite: { autoincrement: true } })).toThrow(/AUTOINCREMENT/);
    // 绕过校验写入时 validate 同样拦截
    (mPk.objects[bigId] as { ext?: { sqlite?: { autoincrement?: boolean } } }).ext = {
      sqlite: { autoincrement: true },
    };
    expect(validate(mPk)).toContainEqual(expect.stringMatching(/AUTOINCREMENT 只能用于 INTEGER/));
    setColumnExt(mPk, bigId, null);

    const tAuto = createTable(mPk, sPk, 'auto_pk');
    const autoId = addColumn(mPk, tAuto, { name: 'id', type: 'INTEGER', notNull: true });
    addPrimaryKey(mPk, tAuto, [autoId]);
    setColumnExt(mPk, autoId, { sqlite: { autoincrement: true } });
    setColumnType(mPk, autoId, 'bigint');
    expect((mPk.objects[autoId] as { ext?: unknown }).ext).toBeUndefined();
    expect(validate(mPk)).toEqual([]);

    // 3. DDL 渲染（无类型列省略类型不留双空格；BIGINT PK 保留 BIGINT）+ plan 重建触发
    const mDdl = emptyModel('sqlite');
    const sDdl = createSchema(mDdl, 'main');
    const tbl = createTable(mDdl, sDdl, 'items');
    const idCol = addColumn(mDdl, tbl, { name: 'id', type: 'bigint', notNull: true });
    addPrimaryKey(mDdl, tbl, [idCol]);
    const e1 = addColumn(mDdl, tbl, { name: 'e', type: '', notNull: true, default: { expr: '1' } });
    addColumn(mDdl, tbl, { name: 'bare', type: '' });
    const ddl = createAll(mDdl)[0]!.sql;
    expect(ddl).toBe('CREATE TABLE items (id BIGINT NOT NULL, e NOT NULL DEFAULT 1, bare, PRIMARY KEY (id))');
    expect(ddl).not.toContain('  ');

    const mAddUntyped = structuredClone(mDdl);
    addColumn(mAddUntyped, tbl, { name: 'extra', type: '' });
    const addSteps = plan(mDdl, mAddUntyped);
    expect(addSteps).toHaveLength(1);
    expect(addSteps[0]!.sql).toBe('ALTER TABLE items ADD COLUMN extra');

    const mToText = structuredClone(mDdl);
    setColumnType(mToText, e1, 'TEXT');
    expect(plan(mDdl, mToText).map((s) => s.kind)).toEqual(['rebuildTable']);
    expect(plan(mToText, mDdl).map((s) => s.kind)).toEqual(['rebuildTable']);

    const mToInt = structuredClone(mDdl);
    setColumnType(mToInt, idCol, 'INTEGER');
    expect(plan(mDdl, mToInt).map((s) => s.kind)).toEqual(['rebuildTable']);

    // 4. 宏 defineTable / alterColumn 支持显式空类型（非 STRICT）与报错（STRICT / 省略）
    const mMac = emptyModel('sqlite');
    createSchema(mMac, 'main', 's');
    runMacro(
      mMac,
      'defineTable',
      {
        name: 'loose_mac',
        columns: [
          { id: '$ref:pk', name: 'id', type: 'bigint', notNull: true },
          { id: '$ref:e', name: 'e', type: '' },
          { id: '$ref:w', name: 'w', type: '   ' },
        ],
        primaryKey: { columns: ['id'] },
      },
      new Map(),
    );
    const eId = Object.values(mMac.objects).find((o) => o.kind === 'column' && o.name === 'e')!.id;
    expect((mMac.objects[eId] as { type: string }).type).toBe('');
    expect(runMacro(structuredClone(mMac), 'alterColumn', { id: eId, type: '' }, new Map()).ops).toEqual([]);
    runMacro(mMac, 'alterColumn', { id: eId, type: 'TEXT' }, new Map());
    expect((mMac.objects[eId] as { type: string }).type).toBe('TEXT');
    runMacro(mMac, 'alterColumn', { id: eId, type: '' }, new Map());
    expect((mMac.objects[eId] as { type: string }).type).toBe('');

    expect(() =>
      runMacro(mMac, 'defineTable', { name: 'missing_type', columns: [{ name: 'a' }] }, new Map()),
    ).toThrow(/缺少列类型.*type: ""/);
    expect(() =>
      runMacro(
        mMac,
        'defineTable',
        { name: 'strict_empty', ext: { sqlite: { strict: true } }, columns: [{ name: 'a', type: '' }] },
        new Map(),
      ),
    ).toThrow(/columns\[0\]\.type.*STRICT 表的列必须声明类型/);

    const stMac = createTable(mMac, 's', 'strict_mac', undefined, null, { sqlite: { strict: true } });
    const stCol = addColumn(mMac, stMac, { name: 'a', type: 'TEXT' });
    expect(() => runMacro(mMac, 'alterColumn', { id: stCol, type: '' }, new Map())).toThrow(
      /type.*STRICT 表的列必须声明类型/,
    );

    expect(macros.defineTable.description).toContain(SQLITE_COLUMN_TYPE_NOTE);
    expect(macros.alterColumn.description).toContain(SQLITE_COLUMN_TYPE_NOTE);
    expect(mutators.addColumn.args.shape.column.shape.type.description).toContain(SQLITE_COLUMN_TYPE_NOTE);
    expect(mutators.setColumnType.args.shape.type.description).toContain(SQLITE_COLUMN_TYPE_NOTE);
  });
});
