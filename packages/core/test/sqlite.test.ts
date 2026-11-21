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
  getDialect,
  isNontransactionalSql,
  plan,
  renameColumn,
  renameTable,
  runMutator,
  scrubSecrets,
  setColumnExt,
  setColumnType,
  setDefault,
  setNotNull,
  setPartitionBy,
  setTableExt,
  splitSqliteStatements,
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
});
