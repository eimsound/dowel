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
  MAX_GO_REPEAT,
  mssqlColumnRefs,
  mssqlDerivedNames,
  mssqlIdent,
  mssqlLiteral,
  mssqlNormalizeType,
  mssqlPlan,
  mssqlQualified,
  mssqlRenameInExpr,
  mssqlRenameQualifiedInExpr,
  mssqlTokenize,
  plan,
  PlanError,
  renameColumn,
  renameKey,
  renameSchema,
  renameTable,
  setColumnExt,
  setColumnType,
  setComment,
  setDefault,
  setNotNull,
  splitMssqlBatches,
  validate,
} from '../src/index.ts';

describe('MSSQL core dialect: quote, lexer, batch splitter, naming, types, nontx, planner', () => {
  it('registers mssql dialect with expected capabilities and emptyBase', () => {
    const d = getDialect('mssql');
    expect(d.capabilities).toEqual({
      schemas: true,
      defaultSchema: 'dbo',
      maxIdentLength: 128,
      maxIdentUnit: 'chars',
      enums: false,
      sequences: true,
      partitioning: false,
      transactionalDdl: true,
      requiresTableRebuild: false,
      supportsColumnOrder: false,
      requiresExternalShadow: true,
      historyStorage: 'schema',
      nullsNotDistinct: false,
      comments: true,
    });

    const m = emptyModel('mssql');
    const dbo = createSchema(m, 'dbo');
    const baseAll = emptyBase(m, null);
    expect(baseAll.dialect).toBe('mssql');
    expect(Object.values(baseAll.objects)).toHaveLength(1);
    expect(Object.values(baseAll.objects)[0]!.id).toBe(dbo);
    expect(Object.values(baseAll.objects)[0]!.name).toBe('dbo');

    const baseOther = emptyBase(m, ['app']);
    expect(Object.values(baseOther.objects)).toHaveLength(0);
  });

  it('quotes bracket identifiers, qualified names, literals, and tokenizes nested comments / strings', () => {
    expect(mssqlIdent('users')).toBe('[users]');
    expect(mssqlIdent('a]b')).toBe('[a]]b]');
    expect(mssqlQualified('dbo', 'order]items')).toBe('[dbo].[order]]items]');
    expect(mssqlLiteral("O'Reilly")).toBe("N'O''Reilly'");

    const toks = mssqlTokenize(
      `/* outer /* nested */ still comment */ SELECT [col]]1], "col""2", N'it''s', 'a', @var, a_1 -- line\nFROM [dbo].[t]`,
    );
    const qidents = toks.filter((t) => t.kind === 'qident').map((t) => t.text);
    expect(qidents).toEqual(['col]1', 'col"2', 'dbo', 't']);
    const idents = toks.filter((t) => t.kind === 'ident').map((t) => t.text);
    expect(idents).toEqual(['select', 'a_1', 'from']);

    // columnRefs skips CAST/CONVERT types, COLLATE names, function names, and variables
    const refs = mssqlColumnRefs(
      `CAST([price] AS decimal(10, 2)) + CONVERT(nvarchar(50), [tag]) + LEN(code COLLATE Latin1_General_CS_AS) + @x`,
    ).map((t) => t.text);
    expect(refs).toEqual(['price', 'tag', 'code']);

    expect(mssqlRenameInExpr('[a] + LEN(a) + CAST(a AS int)', 'a', 'amount')).toBe(
      '[amount] + LEN([amount]) + CAST([amount] AS int)',
    );
    expect(mssqlRenameQualifiedInExpr('[old].[seq_1]', 'old', null, { schema: 'new_s', name: null })).toBe(
      '[new_s].[seq_1]',
    );
  });

  it('splits GO [count] batches accurately without breaking strings, comments, or brackets', () => {
    const sql = [
      'CREATE SCHEMA [app];',
      'GO',
      "INSERT INTO [app].[notes] VALUES (N'line1\nGO\nline3');",
      '/* block comment with',
      'GO',
      '/* nested',
      'GO 5',
      '*/',
      'GO',
      '*/',
      'SELECT [col\nGO\nname] FROM [app].[notes];',
      '  go  -- trailing comment',
      "PRINT N'hi';",
      'GO 2',
      'SELECT 1; -- GO on same line is NOT a separator',
      'GO 0',
      'SELECT 2;',
    ].join('\n');

    const batches = splitMssqlBatches(sql);
    expect(batches).toHaveLength(5);
    expect(batches[0]).toBe('CREATE SCHEMA [app];');
    expect(batches[1]).toContain("N'line1\nGO\nline3'");
    expect(batches[1]).toContain('[col\nGO\nname]');
    expect(batches[2]).toBe("PRINT N'hi';");
    expect(batches[3]).toBe("PRINT N'hi';");
    // GO 0 drops the `SELECT 1;` batch
    expect(batches[4]).toBe('SELECT 2;');

    // Guard against huge GO repeat abuse
    expect(() => splitMssqlBatches(`SELECT 1\nGO ${MAX_GO_REPEAT + 1}`)).toThrow(PlanError);
  });

  it('formats scripts with GO between batch-isolated statements', () => {
    const out = formatScript(
      [
        { sql: 'CREATE SCHEMA [app]' },
        { sql: 'CREATE TABLE [app].[t] ([id] int NOT NULL)' },
        { sql: 'CREATE VIEW [app].[v] AS SELECT [id] FROM [app].[t]' },
        { sql: 'CREATE INDEX [IX_t_id] ON [app].[t] ([id])' },
      ],
      'mssql',
    );
    expect(out).toBe(
      [
        'CREATE SCHEMA [app];',
        'GO',
        '',
        'CREATE TABLE [app].[t] ([id] int NOT NULL);',
        'GO',
        '',
        'CREATE VIEW [app].[v] AS SELECT [id] FROM [app].[t];',
        'GO',
        '',
        'CREATE INDEX [IX_t_id] ON [app].[t] ([id]);',
      ].join('\n'),
    );
  });

  it('enforces 128-char identifier limits, reserved schema names, and DF_/PK_/UQ_/FK_/CK_/IX_ naming', () => {
    const m = emptyModel('mssql');
    for (const bad of ['dowel', 'DOWEL', 'sys', 'INFORMATION_SCHEMA', 'guest', 'db_owner', 'db_custom']) {
      expect(() => createSchema(m, bad)).toThrow(/保留/);
    }
    const dbo = createSchema(m, 'dbo');
    expect(() => createTable(m, dbo, 'a'.repeat(129))).toThrow(/128/);
    expect(() => createEnum(m, dbo, 'role', ['a'])).toThrow(/枚举/);

    const longTbl = 't'.repeat(80);
    const longCol = 'c'.repeat(80);
    expect(mssqlDerivedNames.default(longTbl, longCol).length).toBeLessThanOrEqual(128);
    expect(mssqlDerivedNames.default('users', 'status')).toBe('DF_users_status');
    expect(mssqlDerivedNames.primaryKey('users')).toBe('PK_users');
    expect(mssqlDerivedNames.unique('users', ['email'])).toBe('UQ_users_email');
    expect(mssqlDerivedNames.foreignKey('orders', ['user_id'])).toBe('FK_orders_user_id');
    expect(mssqlDerivedNames.check('users', 'age')).toBe('CK_users_age');
    expect(mssqlDerivedNames.index('users', ['email'])).toBe('IX_users_email');

    const t = createTable(m, dbo, 'users');
    const id = addColumn(m, t, { name: 'id', type: 'bigint', notNull: true });
    const status = addColumn(m, t, { name: 'status', type: 'nvarchar(32)', default: { expr: "N'active'" } });
    addPrimaryKey(m, t, [id]);
    expect(
      (m.objects[status] as { ext?: { mssql?: { defaultName?: string } } }).ext?.mssql?.defaultName,
    ).toBe('DF_users_status');
    renameTable(m, t, 'accounts');
    expect(
      (m.objects[status] as { ext?: { mssql?: { defaultName?: string } } }).ext?.mssql?.defaultName,
    ).toBe('DF_accounts_status');
    renameColumn(m, status, 'state');
    expect(
      (m.objects[status] as { ext?: { mssql?: { defaultName?: string } } }).ext?.mssql?.defaultName,
    ).toBe('DF_accounts_state');
  });

  it('normalizes MSSQL types including SQL Server 2025 json and vector(n)', () => {
    expect(mssqlNormalizeType('INTEGER')).toBe('int');
    expect(mssqlNormalizeType('NVARCHAR( 255 )')).toBe('nvarchar(255)');
    expect(mssqlNormalizeType('NVARCHAR(MAX)')).toBe('nvarchar(max)');
    expect(mssqlNormalizeType('DECIMAL(10, 2)')).toBe('decimal(10,2)');
    expect(mssqlNormalizeType('DECIMAL(10)')).toBe('decimal(10,0)');
    expect(mssqlNormalizeType('FLOAT(24)')).toBe('real');
    expect(mssqlNormalizeType('FLOAT(53)')).toBe('float');
    expect(mssqlNormalizeType('DATETIME2')).toBe('datetime2(7)');
    expect(mssqlNormalizeType('DATETIMEOFFSET(3)')).toBe('datetimeoffset(3)');
    expect(mssqlNormalizeType('JSON')).toBe('json');
    expect(mssqlNormalizeType('VECTOR( 1536 )')).toBe('vector(1536)');
  });

  it('detects MSSQL non-transactional statements and blocks instance-level / dowel tampering SQL', () => {
    expect(isNontransactionalSql('CREATE DATABASE [foo]', 'mssql')).toBe(true);
    expect(isNontransactionalSql('ALTER DATABASE [foo] SET RECOVERY SIMPLE', 'mssql')).toBe(true);
    expect(isNontransactionalSql('CREATE FULLTEXT CATALOG [ft] AS DEFAULT', 'mssql')).toBe(true);
    expect(isNontransactionalSql("DBCC SHRINKDATABASE (N'app')", 'mssql')).toBe(true);
    expect(isNontransactionalSql("BACKUP DATABASE [app] TO DISK = N'/tmp/a.bak'", 'mssql')).toBe(true);
    expect(isNontransactionalSql('RECONFIGURE', 'mssql')).toBe(true);
    expect(isNontransactionalSql('CREATE TABLE [dbo].[t] ([id] int NOT NULL)', 'mssql')).toBe(false);

    for (const bad of [
      'CREATE DATABASE [evil]',
      'DROP LOGIN [sa]',
      'ALTER SERVER ROLE [sysadmin] ADD MEMBER [u]',
      'CREATE ENDPOINT [ep] STATE = STARTED AS TCP (LISTENER_PORT = 5022) FOR TSQL ()',
      "CREATE CREDENTIAL [c] WITH IDENTITY = N'x'",
      "EXEC sys.sp_configure N'xp_cmdshell', 1",
      "EXEC master.dbo.xp_cmdshell 'whoami'",
      'RECONFIGURE WITH OVERRIDE',
      'SHUTDOWN WITH NOWAIT',
      "BACKUP DATABASE [app] TO DISK = N'/tmp/a.bak'",
      "RESTORE DATABASE [app] FROM DISK = N'/tmp/a.bak'",
      "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=x;', 'SELECT 1')",
      "SELECT * FROM OPENDATASOURCE('SQLNCLI', 'Data Source=x').db.dbo.t",
      "BULK INSERT [dbo].[t] FROM '/etc/passwd'",
      'DROP SCHEMA [dowel]',
      'DROP TABLE [dowel].[history]',
      'DELETE FROM dowel.history',
      "UPDATE [dowel].[versions] SET [checksum] = N'0'",
      "INSERT INTO dowel.meta ([key], [value]) VALUES (N'k', N'1')",
      "EXEC sys.sp_rename N'[dowel].[history]', N'h2', N'OBJECT'",
    ]) {
      expect(findInstanceLevelStatement(bad, 'mssql'), `expected block: ${bad}`).not.toBeNull();
    }

    expect(
      findInstanceLevelStatement(
        "-- DROP DATABASE [evil]\n/* EXEC xp_cmdshell 'id' */\nCREATE TABLE [dbo].[users] ([id] int NOT NULL, [note] nvarchar(50) DEFAULT (N'DROP DATABASE'))",
        'mssql',
      ),
    ).toBeNull();
  });

  it('plans named DEFAULT drop/recreate, sp_rename, dependency teardown/rebuild, IDENTITY error, CLUSTERED uniqueness, sequences, comments, and 2019/2022/2025 checks', () => {
    const m0 = emptyModel('mssql');
    const dbo = createSchema(m0, 'dbo', 's-dbo');
    const seq = createSequence(
      m0,
      dbo,
      'order_seq',
      { type: 'bigint', start: '100', increment: '1' },
      'seq-1',
    );
    const t = createTable(m0, dbo, 'users', 't-users');
    const id = addColumn(m0, t, {
      id: 'c-id',
      name: 'id',
      type: 'bigint',
      notNull: true,
      ext: { mssql: { identity: { seed: '1', increment: '1' } } },
    });
    const code = addColumn(m0, t, {
      id: 'c-code',
      name: 'code',
      type: 'nvarchar(32)',
      notNull: true,
      default: { expr: "N'guest'" },
    });
    const seqCol = addColumn(m0, t, {
      id: 'c-seq',
      name: 'seq_no',
      type: 'bigint',
      notNull: true,
      default: { nextval: seq },
    });
    const score = addColumn(m0, t, {
      id: 'c-score',
      name: 'score',
      type: 'int',
      notNull: true,
      default: { expr: '0' },
    });
    addColumn(m0, t, {
      id: 'c-double',
      name: 'double_score',
      type: 'int',
      notNull: true,
      generated: { expr: '[score] * 2', stored: true },
    });
    addPrimaryKey(m0, t, [id], 'pk-users');
    const uq = addUnique(m0, t, [code], false, 'uq-code');
    addCheck(m0, t, '[score] >= 0', 'ck-score');
    addIndex(
      m0,
      t,
      [{ column: code, desc: true }],
      {
        include: [score],
        where: '[score] > 0',
        ext: { mssql: { fillFactor: 80 } },
      },
      'ix-code',
    );
    setComment(m0, t, '用户表');
    setComment(m0, code, '用户编码');

    expect(validate(m0)).toEqual([]);

    // createAll should NOT emit CREATE SCHEMA [dbo], should emit IDENTITY, named DF_, CLUSTERED PK, PERSISTED NOT NULL, sequence, FILLFACTOR, MS_Description
    const created = createAll(m0);
    expect(created.some((s) => /CREATE SCHEMA \[dbo\]/i.test(s.sql))).toBe(false);
    const tblSql = created.find((s) => s.kind === 'createTable')!.sql;
    expect(tblSql).toContain('IDENTITY(1, 1)');
    expect(tblSql).toContain("CONSTRAINT [DF_users_code] DEFAULT (N'guest')");
    expect(tblSql).toContain('NEXT VALUE FOR [dbo].[order_seq]');
    expect(tblSql).toContain('[double_score] AS ([score] * 2) PERSISTED NOT NULL');
    expect(created.find((s) => s.kind === 'addPrimaryKey')!.sql).toContain('PRIMARY KEY CLUSTERED');
    expect(created.find((s) => s.kind === 'createIndex')!.sql).toContain(
      'INCLUDE ([score]) WHERE [score] > 0 WITH (FILLFACTOR = 80)',
    );
    expect(created.some((s) => s.sql.includes('sp_addextendedproperty'))).toBe(true);

    // 1. Altering column type drops DF, dependent UQ/IX/CK/computed column, alters column, then recreates all
    const m1 = structuredClone(m0);
    setColumnType(m1, code, 'nvarchar(64)');
    setColumnType(m1, score, 'bigint');
    setComment(m1, code, '新编码注释');
    setComment(m1, t, null);
    const steps01 = plan(m0, m1);
    const dropDfIdx = steps01.findIndex((s) => s.kind === 'dropDefault' && s.sql.includes('[DF_users_code]'));
    const dropUqIdx = steps01.findIndex((s) => s.kind === 'dropUnique');
    const dropIxIdx = steps01.findIndex((s) => s.kind === 'dropIndex' && s.sql.includes('ON [dbo].[users]'));
    const alterCodeIdx = steps01.findIndex(
      (s) => s.kind === 'alterColumn' && s.sql.includes('[code] nvarchar(64)'),
    );
    const setDfIdx = steps01.findIndex((s) => s.kind === 'setDefault' && s.sql.includes('[DF_users_code]'));
    const addUqIdx = steps01.findIndex((s) => s.kind === 'addUnique');
    expect(dropDfIdx).toBeGreaterThanOrEqual(0);
    expect(dropUqIdx).toBeGreaterThanOrEqual(0);
    expect(dropIxIdx).toBeGreaterThanOrEqual(0);
    expect(dropDfIdx).toBeLessThan(alterCodeIdx);
    expect(dropUqIdx).toBeLessThan(alterCodeIdx);
    expect(dropIxIdx).toBeLessThan(alterCodeIdx);
    expect(alterCodeIdx).toBeLessThan(setDfIdx);
    expect(alterCodeIdx).toBeLessThan(addUqIdx);
    expect(steps01.some((s) => s.sql.includes('sp_updateextendedproperty'))).toBe(true);
    expect(steps01.some((s) => s.sql.includes('sp_dropextendedproperty'))).toBe(true);

    // 2. Dropping a column with a DEFAULT constraint must drop the DF constraint first
    const m2 = structuredClone(m1);
    dropColumn(m2, seqCol);
    const dropSteps = plan(m1, m2);
    const dfDrop = dropSteps.findIndex((s) => s.kind === 'dropDefault');
    const colDrop = dropSteps.findIndex((s) => s.kind === 'dropColumn');
    expect(dfDrop).toBeGreaterThanOrEqual(0);
    expect(dfDrop).toBeLessThan(colDrop);

    // 3. sp_rename for table, column, constraint, index, and default constraint
    const m3 = structuredClone(m2);
    renameTable(m3, t, 'members');
    renameKey(m3, uq, 'UQ_members_custom');
    const renameSteps = plan(m2, m3);
    expect(
      renameSteps.some((s) => s.sql.includes("EXEC sys.sp_rename N'[dbo].[users]', N'members', N'OBJECT'")),
    ).toBe(true);
    expect(renameSteps.some((s) => s.sql.includes("N'UQ_members_custom', N'OBJECT'"))).toBe(true);
    // DF_users_code auto-derived to DF_members_code -> sp_rename OBJECT
    expect(renameSteps.some((s) => s.sql.includes("N'DF_members_code', N'OBJECT'"))).toBe(true);

    // 4. Schema rename -> CREATE SCHEMA + ALTER SCHEMA TRANSFER + DROP SCHEMA
    const ms0 = emptyModel('mssql');
    const app = createSchema(ms0, 'app', 's-app');
    const st = createTable(ms0, app, 'items', 't-items');
    addColumn(ms0, st, { name: 'id', type: 'int', notNull: true });
    const ms1 = structuredClone(ms0);
    renameSchema(ms1, app, 'core');
    const schSteps = plan(ms0, ms1);
    expect(schSteps.map((s) => s.kind)).toEqual(['createSchema', 'transferSchema', 'dropSchema']);
    expect(schSteps[1]!.sql).toBe('ALTER SCHEMA [core] TRANSFER [app].[items]');

    // 5. In-place IDENTITY modification throws PlanError
    const mBadId = structuredClone(m0);
    setColumnExt(mBadId, id, null);
    expect(() => plan(m0, mBadId)).toThrow(PlanError);
    expect(() => plan(m0, mBadId)).toThrow(/IDENTITY/);

    const mBadIdSeed = structuredClone(m0);
    setColumnExt(mBadIdSeed, id, { mssql: { identity: { seed: '10', increment: '1' } } });
    expect(() => plan(m0, mBadIdSeed)).toThrow(PlanError);

    // 6a. Switching CLUSTERED from implicit PK to UNIQUE automatically rebuilds PK as NONCLUSTERED and creates CLUSTERED UNIQUE first
    const mSwitchCl = structuredClone(m0);
    (mSwitchCl.objects[uq] as { ext?: { mssql?: { clustered?: boolean } } }).ext = {
      mssql: { clustered: true },
    };
    expect(validate(mSwitchCl)).toEqual([]);
    const switchSteps = plan(m0, mSwitchCl);
    const addUqClIdx = switchSteps.findIndex(
      (s) => s.kind === 'addUnique' && s.sql.includes('UNIQUE CLUSTERED'),
    );
    const addPkNonClIdx = switchSteps.findIndex(
      (s) => s.kind === 'addPrimaryKey' && s.sql.includes('PRIMARY KEY NONCLUSTERED'),
    );
    expect(addUqClIdx).toBeGreaterThanOrEqual(0);
    expect(addPkNonClIdx).toBeGreaterThan(addUqClIdx);

    // 6b. Explicit multiple CLUSTERED constraints/indexes on one table fail validation and planning
    const mBadCl = structuredClone(mSwitchCl);
    (mBadCl.objects['pk-users'] as { ext?: { mssql?: { clustered?: boolean } } }).ext = {
      mssql: { clustered: true },
    };
    expect(validate(mBadCl).some((e) => e.includes('CLUSTERED'))).toBe(true);
    expect(() => plan(m0, mBadCl)).toThrow(/CLUSTERED/);

    // 7. SQL Server 2019 (15) / 2022 (16) reject 2025 native json & vector(n), while 2025 (17) allows them
    const m2025 = emptyModel('mssql');
    const d25 = createSchema(m2025, 'dbo');
    const t25 = createTable(m2025, d25, 'embeddings');
    addColumn(m2025, t25, { name: 'id', type: 'int', notNull: true });
    addColumn(m2025, t25, { name: 'payload', type: 'json' });
    addColumn(m2025, t25, { name: 'vec', type: 'vector(3)' });
    expect(validate(m2025)).toEqual([]);
    expect(() => mssqlPlan(emptyBase(m2025, null), m2025, { mssqlMajor: 15 })).toThrow(/2025/);
    expect(() => mssqlPlan(emptyBase(m2025, null), m2025, { mssqlMajor: 16 })).toThrow(/2025/);
    const steps25 = mssqlPlan(emptyBase(m2025, null), m2025, { mssqlMajor: 17 });
    expect(steps25[0]!.sql).toContain('[payload] json NULL');
    expect(steps25[0]!.sql).toContain('[vec] vector(3) NULL');

    // 8. Dropping NOT NULL on a non-PK column and adding FK between tables
    const mFk0 = emptyModel('mssql');
    const sd = createSchema(mFk0, 'dbo');
    const pTbl = createTable(mFk0, sd, 'parents');
    const pId = addColumn(mFk0, pTbl, { name: 'id', type: 'int', notNull: true });
    addPrimaryKey(mFk0, pTbl, [pId]);
    const cTbl = createTable(mFk0, sd, 'children');
    const cId = addColumn(mFk0, cTbl, { name: 'id', type: 'int', notNull: true });
    const cPid = addColumn(mFk0, cTbl, { name: 'parent_id', type: 'int', notNull: true });
    addPrimaryKey(mFk0, cTbl, [cId]);
    addForeignKey(mFk0, cTbl, [cPid], pTbl, [pId], { onDelete: 'cascade' });

    const mFk1 = structuredClone(mFk0);
    setNotNull(mFk1, cPid, false);
    setDefault(mFk1, cPid, { expr: '0' });
    const fkSteps = plan(mFk0, mFk1);
    expect(fkSteps.findIndex((s) => s.kind === 'dropForeignKey')).toBeLessThan(
      fkSteps.findIndex((s) => s.kind === 'alterColumn'),
    );
    expect(fkSteps.findIndex((s) => s.kind === 'alterColumn')).toBeLessThan(
      fkSteps.findIndex((s) => s.kind === 'addForeignKey'),
    );
  });
});
