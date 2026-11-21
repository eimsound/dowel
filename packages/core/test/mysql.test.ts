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
  dropKey,
  dropTable,
  emptyBase,
  emptyModel,
  findInstanceLevelStatement,
  formatScript,
  getDialect,
  isNontransactionalSql,
  MYSQL_SHADOW_MARK_TABLE,
  mysqlColumnRefs,
  mysqlIdent,
  mysqlLiteral,
  mysqlNormalizeType,
  mysqlPlan,
  mysqlQualified,
  mysqlRenameInExpr,
  mysqlRenameQualifiedInExpr,
  mysqlTokenize,
  normalizeType,
  plan,
  renameColumn,
  renameKey,
  renameTable,
  setColumnExt,
  setColumnType,
  setComment,
  setDefault,
  setNotNull,
  setTableExt,
  splitMysqlStatements,
  validate,
} from '../src/index.ts';

describe('MySQL dialect core (MySQL 8.4 & 9.7)', () => {
  it('registers mysql dialect with expected capabilities', () => {
    const mysql = getDialect('mysql');
    expect(mysql.id).toBe('mysql');
    expect(mysql.capabilities).toEqual({
      schemas: false,
      defaultSchema: 'default',
      maxIdentLength: 64,
      maxIdentUnit: 'chars',
      enums: false,
      sequences: false,
      partitioning: false,
      transactionalDdl: false,
      requiresTableRebuild: false,
      supportsColumnOrder: true,
      requiresExternalShadow: true,
      historyStorage: 'prefix',
      nullsNotDistinct: false,
      comments: true,
    });
  });

  it('quotes identifiers with backticks and safely escapes string literals', () => {
    expect(mysqlIdent('users')).toBe('`users`');
    expect(mysqlIdent('order')).toBe('`order`');
    expect(mysqlIdent('a`b')).toBe('`a``b`');
    expect(mysqlQualified('default', 'users')).toBe('`users`');
    expect(mysqlQualified('mydb', 'users')).toBe('`mydb`.`users`');

    expect(mysqlLiteral("hello 'world'")).toBe("'hello ''world'''");
    expect(mysqlLiteral('path\\to\\file')).toBe("'path\\\\to\\\\file'");
    expect(mysqlLiteral("a\\'b\nc\0d")).toBe("'a\\\\''b\\nc\\0d'");
  });

  it('tokenizes MySQL expressions including comments, conditional comments, strings, and introducers', () => {
    const toks = mysqlTokenize(
      "`Col``1` > 0 -- line\n# hash\n/* block */ /*!80000 AND status = _utf8mb4'ok\\'!' */",
    );
    const qidents = toks.filter((t) => t.kind === 'qident').map((t) => t.text);
    const idents = toks.filter((t) => t.kind === 'ident').map((t) => t.text);
    expect(qidents).toEqual(['Col`1']);
    expect(idents).toContain('and');
    expect(idents).toContain('status');

    const d = getDialect('mysql');
    const refs = mysqlColumnRefs(
      "char_length(`name`) > 0 AND status = _utf8mb4'active' AND CAST(age AS SIGNED) >= 18",
    );
    const nonKwRefs = refs
      .filter((r) => !(r.kind === 'ident' && d.keywords.has(r.text.toLowerCase())))
      .map((r) => r.text);
    expect(nonKwRefs).toEqual(['name', 'status', 'age']);

    expect(mysqlRenameInExpr("`price` * qty + char_length('price')", 'price', 'unit_price')).toBe(
      "`unit_price` * qty + char_length('price')",
    );
    expect(
      mysqlRenameQualifiedInExpr('db1.users.id', 'db1', 'users', { schema: 'db2', name: 'accounts' }),
    ).toBe('`db2`.`accounts`.id');
  });

  it('splits multi-statement MySQL scripts while preserving triggers, routines, CASE/IF blocks, and DELIMITER', () => {
    const sql = `
      CREATE TABLE a (id INT PRIMARY KEY);
      DELIMITER ;;
      CREATE TRIGGER tr_a BEFORE UPDATE ON a FOR EACH ROW
      BEGIN
        IF OLD.id <> NEW.id THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nope;really';
        END IF;
        SET @x = CASE WHEN NEW.id > 0 THEN 1 ELSE 0 END;
      END;;
      DELIMITER ;
      CREATE INDEX idx_a ON a (id);
    `;
    const stmts = splitMysqlStatements(sql);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain('CREATE TABLE a');
    expect(stmts[1]).toContain('CREATE TRIGGER tr_a');
    expect(stmts[1]).toContain('END IF');
    expect(stmts[2]).toBe('CREATE INDEX idx_a ON a (id)');
  });

  it('normalizes MySQL 8.4 & 9.7 data types consistently', () => {
    expect(normalizeType('INTEGER', 'mysql')).toBe('int');
    expect(normalizeType('INT(11)', 'mysql')).toBe('int');
    expect(normalizeType('BIGINT(20) UNSIGNED', 'mysql')).toBe('bigint unsigned');
    expect(normalizeType('TINYINT(1)', 'mysql')).toBe('tinyint(1)');
    expect(normalizeType('BOOLEAN', 'mysql')).toBe('tinyint(1)');
    expect(normalizeType('TINYINT(4)', 'mysql')).toBe('tinyint');
    expect(normalizeType('DECIMAL', 'mysql')).toBe('decimal(10,0)');
    expect(normalizeType('NUMERIC(12, 4)', 'mysql')).toBe('decimal(12,4)');
    expect(normalizeType('DOUBLE PRECISION', 'mysql')).toBe('double');
    expect(normalizeType('VARCHAR(255)', 'mysql')).toBe('varchar(255)');
    expect(normalizeType('CHAR', 'mysql')).toBe('char(1)');
    expect(normalizeType('DATETIME(0)', 'mysql')).toBe('datetime');
    expect(normalizeType('DATETIME(6)', 'mysql')).toBe('datetime(6)');
    expect(normalizeType('TIMESTAMP(3)', 'mysql')).toBe('timestamp(3)');
    expect(normalizeType("ENUM('open', 'closed')", 'mysql')).toBe("enum('open','closed')");
    expect(normalizeType("SET('a', 'b')", 'mysql')).toBe("set('a','b')");
    expect(normalizeType('VECTOR(1536)', 'mysql')).toBe('vector(1536)');
    expect(mysqlNormalizeType('JSON')).toBe('json');
  });

  it('enforces 64-char limit, single default schema, reserved names, and AUTO_INCREMENT rules', () => {
    const m = emptyModel('mysql');
    const s = createSchema(m, 'default');
    expect(() => createSchema(m, 'other')).toThrow();
    expect(() => createEnum(m, s, 'role', ['a'])).toThrow();
    expect(() => createSequence(m, s, 'seq1')).toThrow();
    expect(() => createTable(m, s, 'dowel_custom')).toThrow(/dowel_/);
    expect(() => createTable(m, s, MYSQL_SHADOW_MARK_TABLE)).toThrow(/__dowel_shadow_mark/);
    expect(() => createTable(m, s, 'a'.repeat(65))).toThrow(/64/);

    const t = createTable(m, s, 'items');
    expect(validate(m).some((e) => e.includes('至少需要一列'))).toBe(true);

    const id = addColumn(m, t, { name: 'id', type: 'bigint', notNull: true });
    setColumnExt(m, id, { mysql: { autoIncrement: true } });
    // 未建主键/索引前 AUTO_INCREMENT 校验失败
    expect(validate(m).some((e) => e.includes('首列'))).toBe(true);

    addPrimaryKey(m, t, [id]);
    expect(validate(m)).toEqual([]);

    const ix = addIndex(m, t, [{ column: id }]);
    expect(() => renameKey(m, ix, 'PRIMARY')).toThrow(/PRIMARY/);
    expect(() => renameKey(m, ix, 'dowel_idx')).toThrow(/dowel_/);
  });

  it('detects non-transactional DDL and blocks instance-level & internal-table statements (including /*! conditional comments */)', () => {
    expect(isNontransactionalSql('CREATE TABLE `t` (`id` int)', 'mysql')).toBe(true);
    expect(isNontransactionalSql('ALTER TABLE `t` ADD COLUMN `a` int', 'mysql')).toBe(true);
    expect(isNontransactionalSql('DROP INDEX `ix` ON `t`', 'mysql')).toBe(true);
    expect(isNontransactionalSql('RENAME TABLE `a` TO `b`', 'mysql')).toBe(true);
    expect(isNontransactionalSql('INSERT INTO `t` VALUES (1)', 'mysql')).toBe(false);
    expect(isNontransactionalSql('UPDATE `t` SET `a` = 1', 'mysql')).toBe(false);

    for (const bad of [
      'CREATE DATABASE evil;',
      'DROP SCHEMA IF EXISTS prod;',
      'ALTER DATABASE app CHARACTER SET latin1;',
      "CREATE USER 'hacker'@'%' IDENTIFIED BY 'pw';",
      "DROP USER 'root'@'localhost';",
      "GRANT ALL PRIVILEGES ON *.* TO 'u'@'%';",
      "REVOKE SELECT ON *.* FROM 'u'@'%';",
      'SET GLOBAL max_connections = 1000;',
      'SET PERSIST sql_mode = "";',
      'SET @@global.read_only = 1;',
      'SET @@persist.wait_timeout = 10;',
      "INSTALL PLUGIN evil SONAME 'evil.so';",
      "UNINSTALL COMPONENT 'file://component_x';",
      'FLUSH PRIVILEGES;',
      'RESET MASTER;',
      'SHUTDOWN;',
      "LOAD DATA INFILE '/etc/passwd' INTO TABLE t;",
      "SELECT * FROM users INTO OUTFILE '/tmp/dump.txt';",
      "SELECT 1 INTO DUMPFILE '/tmp/x';",
      'USE mysql;',
      '/*!50000 DROP DATABASE prod */',
      "/*!80000 GRANT ALL ON *.* TO 'x'@'%' */",
      'DROP TABLE dowel_history;',
      'DELETE FROM dowel_history;',
      "UPDATE dowel_claims SET note = 'tampered';",
      'TRUNCATE TABLE __dowel_shadow_mark;',
      'RENAME TABLE users TO dowel_evil;',
      'CREATE TRIGGER evil AFTER INSERT ON users FOR EACH ROW DELETE FROM dowel_history;',
    ]) {
      expect(findInstanceLevelStatement(bad, 'mysql'), `should block: ${bad}`).not.toBeNull();
    }

    expect(
      findInstanceLevelStatement(
        '-- DROP DATABASE foo\n# GRANT ALL\n/* SET GLOBAL x = 1 */\nCREATE TABLE `users` (`id` int PRIMARY KEY)',
        'mysql',
      ),
    ).toBeNull();
  });

  it('plans full MODIFY COLUMN, AUTO_INCREMENT key swaps, expression/TEXT defaults, generated columns, indexes, and 8.4 vs 9.7 VECTOR', () => {
    const m0 = emptyModel('mysql');
    const s = createSchema(m0, 'default');
    const users = createTable(m0, s, 'users');
    setTableExt(m0, users, {
      mysql: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
    });
    setComment(m0, users, '用户表');

    const id = addColumn(m0, users, {
      name: 'id',
      type: 'bigint',
      notNull: true,
      ext: { mysql: { unsigned: true, autoIncrement: true } },
    });
    const email = addColumn(m0, users, {
      name: 'email',
      type: 'varchar(255)',
      notNull: true,
      collation: 'utf8mb4_bin',
    });
    const bio = addColumn(m0, users, {
      name: 'bio',
      type: 'text',
      default: { expr: "'empty'" },
    });
    const updatedAt = addColumn(m0, users, {
      name: 'updated_at',
      type: 'timestamp',
      notNull: true,
      default: { expr: 'CURRENT_TIMESTAMP' },
      ext: { mysql: { onUpdateCurrentTimestamp: true } },
    });
    const fullLen = addColumn(m0, users, {
      name: 'email_len',
      type: 'int',
      generated: { expr: 'char_length(`email`)', stored: true },
    });
    setComment(m0, email, '登录邮箱');
    addPrimaryKey(m0, users, [id]);
    addUnique(m0, users, [email]);
    addCheck(m0, users, 'char_length(`email`) > 3');
    addIndex(m0, users, [{ column: bio }], { ext: { mysql: { lengths: [64] } } });
    addIndex(m0, users, [{ expr: 'lower(`email`)', desc: true }]);

    expect(validate(m0)).toEqual([]);

    const created = createAll(m0);
    expect(created.every((st) => st.transactional === false)).toBe(true);
    expect(created[0]!.sql).toContain('`id` bigint UNSIGNED NOT NULL AUTO_INCREMENT');
    expect(created[0]!.sql).toContain("`bio` text DEFAULT ('empty')");
    expect(created[0]!.sql).toContain('ON UPDATE CURRENT_TIMESTAMP');
    expect(created[0]!.sql).toContain('GENERATED ALWAYS AS (char_length(`email`)) STORED');
    expect(created[0]!.sql).toContain("COMMENT '登录邮箱'");
    expect(created[0]!.sql).toContain("COMMENT='用户表'");
    expect(created.some((st) => st.sql.includes('`bio`(64)'))).toBe(true);
    expect(created.some((st) => st.sql.includes('((lower(`email`)) DESC)'))).toBe(true);

    // 变更：改 email 列名（联动生成列与 CHECK 约束）、扩大 PK 为 (id, updated_at) 保留 AUTO_INCREMENT、新增外键子表
    const m1 = structuredClone(m0);
    renameColumn(m1, email, 'mail');
    setColumnType(m1, id, 'bigint');
    setNotNull(m1, bio, true);
    setDefault(m1, bio, { expr: "'n/a'" });
    const pk0 = Object.values(m1.objects).find((o) => o.kind === 'primaryKey' && o.parent === users)!;
    dropKey(m1, pk0.id);
    addPrimaryKey(m1, users, [id, updatedAt]);

    const posts = createTable(m1, s, 'posts');
    const pid = addColumn(m1, posts, { name: 'id', type: 'bigint', notNull: true });
    const uid = addColumn(m1, posts, {
      name: 'user_id',
      type: 'bigint',
      notNull: true,
      ext: { mysql: { unsigned: true } },
    });
    addPrimaryKey(m1, posts, [pid]);
    const fkId = addForeignKey(m1, posts, [uid], users, [id], { onDelete: 'cascade' });

    expect(validate(m1)).toEqual([]);
    const steps01 = plan(m0, m1);
    const sqlAll = formatScript(steps01, 'mysql');
    // 删旧 PK 前必须先剥离 AUTO_INCREMENT，建新 PK 后再恢复
    const stripAiIdx = steps01.findIndex(
      (st) => st.sql.includes('MODIFY COLUMN `id`') && !st.sql.includes('AUTO_INCREMENT'),
    );
    const dropPkIdx = steps01.findIndex((st) => st.sql.includes('DROP PRIMARY KEY'));
    const addPkIdx = steps01.findIndex((st) => st.sql.includes('ADD PRIMARY KEY'));
    const restoreAiIdx = steps01.findIndex(
      (st) => st.sql.includes('MODIFY COLUMN `id`') && st.sql.includes('AUTO_INCREMENT'),
    );
    expect(stripAiIdx).toBeGreaterThanOrEqual(0);
    expect(stripAiIdx).toBeLessThan(dropPkIdx);
    expect(dropPkIdx).toBeLessThan(addPkIdx);
    expect(addPkIdx).toBeLessThan(restoreAiIdx);
    expect(sqlAll).toContain('DROP COLUMN `email_len`');
    expect(sqlAll).toContain('RENAME COLUMN `email` TO `mail`');
    expect(sqlAll).toContain("MODIFY COLUMN `bio` text NOT NULL DEFAULT ('n/a')");
    expect(sqlAll).toContain('ADD CONSTRAINT `posts_user_id_fkey` FOREIGN KEY');

    // 删除 FK 时自动清理 InnoDB 隐式索引
    const m2 = structuredClone(m1);
    dropKey(m2, fkId);
    const steps12 = plan(m1, m2);
    expect(steps12.map((st) => st.sql)).toEqual([
      'ALTER TABLE `posts` DROP FOREIGN KEY `posts_user_id_fkey`',
      'DROP INDEX `posts_user_id_fkey` ON `posts`',
    ]);

    // 先加显式覆盖索引再保留 FK：自动清理旧隐式索引
    const m1WithIdx = structuredClone(m1);
    addIndex(m1WithIdx, posts, [{ column: uid }]);
    const stepsAddIdx = plan(m1, m1WithIdx);
    expect(stepsAddIdx.some((st) => st.kind === 'createIndex' && st.target === 'posts_user_id_idx')).toBe(
      true,
    );
    expect(stepsAddIdx.some((st) => st.sql === 'DROP INDEX `posts_user_id_fkey` ON `posts`')).toBe(true);

    // 已有显式覆盖索引时删 FK：不误删不存在的隐式索引
    const m1DropFkWithIdx = structuredClone(m1WithIdx);
    dropKey(m1DropFkWithIdx, fkId);
    const stepsDropFkOnly = plan(m1WithIdx, m1DropFkWithIdx);
    expect(stepsDropFkOnly.map((st) => st.sql)).toEqual([
      'ALTER TABLE `posts` DROP FOREIGN KEY `posts_user_id_fkey`',
    ]);

    // 删除表与空基线
    const base = emptyBase(m1, null);
    expect(base.dialect).toBe('mysql');
    expect(Object.values(base.objects)[0]!.name).toBe('default');

    // MySQL 8.4 拒绝 VECTOR(3)，MySQL 9.7 允许
    const mVec = emptyModel('mysql');
    const sv = createSchema(mVec, 'default');
    const emb = createTable(mVec, sv, 'embeddings');
    const eid = addColumn(mVec, emb, { name: 'id', type: 'int', notNull: true });
    addColumn(mVec, emb, { name: 'vec', type: 'vector(3)', notNull: true });
    addPrimaryKey(mVec, emb, [eid]);
    expect(() => mysqlPlan(emptyBase(mVec, null), mVec, { mysqlVersionNum: 80400 })).toThrow(/VECTOR.*9\.0/);
    const vecSteps = mysqlPlan(emptyBase(mVec, null), mVec, { mysqlVersionNum: 90700 });
    expect(vecSteps[0]!.sql).toContain('`vec` vector(3) NOT NULL');

    // 避免未使用变量告警
    expect(fullLen).toBeTruthy();
    const mDrop = structuredClone(m1);
    renameTable(mDrop, posts, 'articles');
    dropColumn(mDrop, bio);
    dropTable(mDrop, posts);
    expect(plan(m1, mDrop).some((st) => st.kind === 'dropTable')).toBe(true);
  });
});
