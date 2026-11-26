import { describe, expect, it } from 'vitest';

import {
  PlanError,
  checkMysqlCompatibility,
  checkMysqlVersionCompatibility,
  diagnoseModel,
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
  MysqlColumnExt,
  mysqlColumnRefs,
  mysqlIdent,
  mysqlLiteral,
  mysqlNormalizeType,
  mysqlPlan,
  mysqlQualified,
  mysqlRenameInExpr,
  mysqlRenameQualifiedInExpr,
  MysqlTableExt,
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

    // 先加显式覆盖索引再保留 FK：P2 显式删 FK 与旧隐式索引，P11 建显式索引，P14 重建 FK 复用显式索引
    const m1WithIdx = structuredClone(m1);
    addIndex(m1WithIdx, posts, [{ column: uid }]);
    const stepsAddIdx = plan(m1, m1WithIdx);
    const dropFkForIdx = stepsAddIdx.findIndex(
      (st) => st.sql === 'ALTER TABLE `posts` DROP FOREIGN KEY `posts_user_id_fkey`',
    );
    const dropImplForIdx = stepsAddIdx.findIndex(
      (st) => st.sql === 'DROP INDEX `posts_user_id_fkey` ON `posts`',
    );
    const createExpIdx = stepsAddIdx.findIndex(
      (st) => st.kind === 'createIndex' && st.target === 'posts_user_id_idx',
    );
    const addFkForIdx = stepsAddIdx.findIndex(
      (st) => st.kind === 'addForeignKey' && st.target === 'posts_user_id_fkey',
    );
    expect(dropFkForIdx).toBeGreaterThanOrEqual(0);
    expect(dropFkForIdx).toBeLessThan(dropImplForIdx);
    expect(dropImplForIdx).toBeLessThan(createExpIdx);
    expect(createExpIdx).toBeLessThan(addFkForIdx);

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

  it('C1: blocks events, prepared statements, ALTER INSTANCE, UNDO TABLESPACE, CLONE, IMPORT TABLE, multi-var SET GLOBAL, routine smuggling, cross-DB refs, and internal objects', () => {
    for (const bad of [
      'CREATE EVENT ev1 ON SCHEDULE EVERY 1 HOUR DO DELETE FROM users;',
      'ALTER EVENT ev1 DISABLE;',
      'DROP EVENT IF EXISTS ev1;',
      "PREPARE s FROM 'DROP DATABASE prod';",
      'EXECUTE s;',
      'DEALLOCATE PREPARE s;',
      'ALTER INSTANCE ROTATE INNODB MASTER KEY;',
      "CREATE UNDO TABLESPACE undo_003 ADD DATAFILE 'undo_003.ibu';",
      'ALTER UNDO TABLESPACE undo_003 SET INACTIVE;',
      'DROP UNDO TABLESPACE undo_003;',
      "CLONE LOCAL DATA DIRECTORY = '/tmp/clone';",
      "IMPORT TABLE FROM '/tmp/t.cfg';",
      'SET @a = 1, GLOBAL read_only = 1;',
      'SET @a = 1, PERSIST max_connections = 500;',
      'SET @a = 1, @@global.read_only = 1;',
      'SET @a = 1, @@persist_only.innodb_buffer_pool_size = 1;',
      'CREATE PROCEDURE p() BEGIN SET @x = 1, GLOBAL read_only = 1; END;',
      'CREATE TRIGGER tr AFTER INSERT ON users FOR EACH ROW BEGIN ALTER INSTANCE RELOAD TLS; END;',
      'CREATE DEFINER = CURRENT_USER() TRIGGER tr AFTER INSERT ON dowel_history FOR EACH ROW SET @x = 1;',
      'CREATE DEFINER = root@127.0.0.1 VIEW dowel_v AS SELECT 1;',
      'DROP TABLE prod.users;',
      'ALTER TABLE prod.users ADD COLUMN x INT;',
      'TRUNCATE TABLE prod.users;',
      'RENAME TABLE users TO prod.users;',
      'CREATE TABLE prod.evil (id INT);',
      'CREATE TABLE copy_u LIKE prod.users;',
      'CREATE TABLE c (id INT, FOREIGN KEY (id) REFERENCES prod.users (id));',
      'DELETE FROM prod.users;',
      'UPDATE prod.users SET name = "x";',
      'INSERT INTO prod.users VALUES (1);',
      'CREATE VIEW v AS SELECT * FROM prod.users;',
      'SELECT prod.users.id FROM users;',
      'CALL prod.my_proc();',
      'SELECT * FROM __dowel_shadow_mark;',
      "UPDATE users u, dowel_versions v SET v.name = 'tampered';",
      'DELETE d FROM users u, dowel_versions d WHERE u.id = d.number;',
      'DELETE FROM d USING users u, dowel_versions d;',
      'SELECT * FROM users JOIN dowel_history h ON h.id = users.id;',
      'CREATE TABLE clone_h LIKE dowel_history;',
    ]) {
      expect(findInstanceLevelStatement(bad, 'mysql'), `should block: ${bad}`).not.toBeNull();
    }

    for (const ok of [
      'CREATE TABLE `users` (`id` int PRIMARY KEY, `name` varchar(64)) ENGINE=InnoDB;',
      "CREATE VIEW `v_users` AS SELECT `u`.`id`, TRIM(BOTH ' ' FROM `u`.`name`) AS n FROM `users` `u` INNER JOIN `orders` `o` ON `u`.`id` = `o`.`user_id`;",
      'UPDATE `settings` SET `global` = 1 WHERE `id` = 1;',
      "SELECT * FROM `users` WHERE `name` LIKE 'dowel_%';",
      'SELECT * FROM `users` USE INDEX (`idx_a`) WHERE `id` = 1;',
      'SET @tmp = 1, SESSION sql_mode = STRICT_TRANS_TABLES;',
    ]) {
      expect(findInstanceLevelStatement(ok, 'mysql'), `should allow: ${ok}`).toBeNull();
    }
  });

  it('C2: rejects unsafe MySQL engine/charset/collation identifiers at Zod, edit, validate, and plan boundaries', () => {
    expect(MysqlTableExt.safeParse({ engine: 'InnoDB; DROP TABLE x' }).success).toBe(false);
    expect(MysqlTableExt.safeParse({ charset: 'utf8mb4 --' }).success).toBe(false);
    expect(MysqlTableExt.safeParse({ collation: 'utf8mb4_0900_ai_ci; SELECT 1' }).success).toBe(false);
    expect(MysqlColumnExt.safeParse({ charset: 'utf8mb4`' }).success).toBe(false);
    expect(
      MysqlTableExt.safeParse({ engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' })
        .success,
    ).toBe(true);

    const m = emptyModel('mysql');
    const s = createSchema(m, 'default');
    expect(() =>
      createTable(m, s, 'bad', undefined, null, { mysql: { engine: 'InnoDB; DROP TABLE x' } }),
    ).toThrow();
    const t = createTable(m, s, 't');
    expect(() => setTableExt(m, t, { mysql: { charset: 'utf8mb4; --' } })).toThrow();
    expect(() => addColumn(m, t, { name: 'a', type: 'varchar(10)', collation: 'bad;coll' })).toThrow();
    const c = addColumn(m, t, { name: 'a', type: 'varchar(10)' });
    expect(() => setColumnExt(m, c, { mysql: { charset: 'bad charset' } })).toThrow();

    // 即使直接篡改 IR 绕过 edit，validate 与 createAll/plan 也必须拒绝
    const tampered = structuredClone(m);
    (tampered.objects[t] as { ext?: { mysql?: { engine?: string } } }).ext = {
      mysql: { engine: 'InnoDB; DROP DATABASE prod' },
    };
    expect(validate(tampered).some((e) => e.includes('存储引擎名'))).toBe(true);
    expect(() => createAll(tampered)).toThrow(/存储引擎名/);
    expect(() => plan(m, tampered)).toThrow(/存储引擎名/);
  });

  it('H2: keeps InnoDB implicit FK owners synchronized across multi-FK evolution and prefix overlap', () => {
    const m0 = emptyModel('mysql');
    const s = createSchema(m0, 'default');
    const parent = createTable(m0, s, 'parents');
    const pa = addColumn(m0, parent, { name: 'a', type: 'bigint', notNull: true });
    const pb = addColumn(m0, parent, { name: 'b', type: 'bigint', notNull: true });
    addPrimaryKey(m0, parent, [pa, pb]);
    addUnique(m0, parent, [pa]);

    const child = createTable(m0, s, 'children');
    const cid = addColumn(m0, child, { name: 'id', type: 'bigint', notNull: true });
    const ca = addColumn(m0, child, { name: 'a', type: 'bigint', notNull: true });
    const cb = addColumn(m0, child, { name: 'b', type: 'bigint', notNull: true });
    addPrimaryKey(m0, child, [cid]);

    // 场景 1: v1(fk_z(a)) -> v2(+fk_a(a)) -> v3(-fk_a(a))
    const v1 = structuredClone(m0);
    const fkZ = addForeignKey(v1, child, [ca], parent, [pa]);
    renameKey(v1, fkZ, 'fk_z');

    const v2 = structuredClone(v1);
    const fkA = addForeignKey(v2, child, [ca], parent, [pa]);
    renameKey(v2, fkA, 'fk_a');

    const s12 = plan(v1, v2);
    // fk_z 必须被重建并清理旧隐式索引 fk_z，再按字典序先建 fk_a 后建 fk_z
    expect(s12.map((st) => st.sql)).toEqual([
      'ALTER TABLE `children` DROP FOREIGN KEY `fk_z`',
      'DROP INDEX `fk_z` ON `children`',
      'ALTER TABLE `children` ADD CONSTRAINT `fk_a` FOREIGN KEY (`a`) REFERENCES `parents` (`a`)',
      'ALTER TABLE `children` ADD CONSTRAINT `fk_z` FOREIGN KEY (`a`) REFERENCES `parents` (`a`)',
    ]);

    const v3 = structuredClone(v2);
    dropKey(v3, fkA);
    const s23 = plan(v2, v3);
    // v2 物理隐式索引由最后加入的 fk_z 持有，删非拥有者 fk_a 时仅需 DROP FOREIGN KEY fk_a
    expect(s23.map((st) => st.sql)).toEqual(['ALTER TABLE `children` DROP FOREIGN KEY `fk_a`']);

    // 场景 2: v1(fk_z(a, b)) -> v2(+fk_a(a)) -> v3(-fk_z(a, b))
    const p1 = structuredClone(m0);
    const pFkZ = addForeignKey(p1, child, [ca, cb], parent, [pa, pb]);
    renameKey(p1, pFkZ, 'fk_z');

    const p2 = structuredClone(p1);
    const pFkA = addForeignKey(p2, child, [ca], parent, [pa]);
    renameKey(p2, pFkA, 'fk_a');

    const sp12 = plan(p1, p2);
    // 长前缀 fk_z(a,b) 已覆盖短前缀 fk_a(a)，MySQL 8.0+ 直接复用 KEY fk_z(a,b)，无需重建 fk_z
    expect(sp12.map((st) => st.sql)).toEqual([
      'ALTER TABLE `children` ADD CONSTRAINT `fk_a` FOREIGN KEY (`a`) REFERENCES `parents` (`a`)',
    ]);

    const p3 = structuredClone(p2);
    dropKey(p3, pFkZ);
    const sp23 = plan(p2, p3);
    // 删拥有者 fk_z(a,b) 时，先删非拥有者 fk_a 再删 fk_z + DROP INDEX fk_z，随后重建 fk_a(a) 获得独立隐式索引
    expect(sp23.map((st) => st.sql)).toEqual([
      'ALTER TABLE `children` DROP FOREIGN KEY `fk_a`',
      'ALTER TABLE `children` DROP FOREIGN KEY `fk_z`',
      'DROP INDEX `fk_z` ON `children`',
      'ALTER TABLE `children` ADD CONSTRAINT `fk_a` FOREIGN KEY (`a`) REFERENCES `parents` (`a`)',
    ]);
  });

  it('H3: enforces MySQL case-insensitive columns, camelCase expression refs, and last-column drop protection in edit.ts', () => {
    const m = emptyModel('mysql');
    const s = createSchema(m, 'default');
    const t = createTable(m, s, 'accounts');
    const uid = addColumn(m, t, { name: 'userId', type: 'bigint', notNull: true });
    expect(() => addColumn(m, t, { name: 'userid', type: 'bigint' })).toThrow(/已存在/);
    const other = addColumn(m, t, { name: 'email', type: 'varchar(191)' });
    expect(() => renameColumn(m, other, 'USERID')).toThrow(/已存在/);

    // camelCase 列名在 CHECK 与函数索引表达式中不误报“不存在的列”
    expect(() => addCheck(m, t, 'userId > 0')).not.toThrow();
    expect(() => addIndex(m, t, [{ expr: 'lower(email)' }])).not.toThrow();

    // 不允许删光 MySQL 表最后一列
    dropColumn(m, other);
    expect(() => dropColumn(m, uid)).toThrow(/至少需要保留一列/);
  });

  it('H4 & L1: converts inherited char columns on table charset/collation change, excludes FULLTEXT/SPATIAL from AUTO_INCREMENT cover, and avoids duplicate MODIFY COLUMN', () => {
    const m0 = emptyModel('mysql');
    const s = createSchema(m0, 'default');
    const t = createTable(m0, s, 'docs');
    setTableExt(m0, t, {
      mysql: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
    });
    const id = addColumn(m0, t, {
      name: 'id',
      type: 'bigint',
      notNull: true,
      ext: { mysql: { autoIncrement: true } },
    });
    const title = addColumn(m0, t, { name: 'title', type: 'varchar(100)', notNull: true });
    const rawCode = addColumn(m0, t, {
      name: 'raw_code',
      type: 'varchar(32)',
      notNull: true,
      collation: 'utf8mb4_bin',
    });
    addPrimaryKey(m0, t, [id]);

    // H4: 修改表级 collation，自动先下发 DEFAULT CHARACTER SET ... COLLATE ...，再 MODIFY 继承字符列 title，但不改带显式 collation 的 raw_code
    const m1 = structuredClone(m0);
    setTableExt(m1, t, {
      mysql: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' },
    });
    const csSteps = plan(m0, m1);
    const alterCharsetIdx = csSteps.findIndex((st) =>
      st.sql.includes('DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'),
    );
    const modTitleIdx = csSteps.findIndex((st) => st.sql.includes('MODIFY COLUMN `title`'));
    expect(alterCharsetIdx).toBeGreaterThanOrEqual(0);
    expect(modTitleIdx).toBeGreaterThan(alterCharsetIdx);
    expect(csSteps.some((st) => st.sql.includes('MODIFY COLUMN `raw_code`'))).toBe(false);

    // L1: 仅取消 AUTO_INCREMENT 时只在 P3 发射一次 MODIFY COLUMN，不在 P9c 重复发射
    const mNoAi = structuredClone(m0);
    setColumnExt(mNoAi, id, { mysql: { autoIncrement: false } });
    const noAiSteps = plan(m0, mNoAi);
    const modIdSteps = noAiSteps.filter((st) => st.sql.includes('MODIFY COLUMN `id`'));
    expect(modIdSteps).toHaveLength(1);
    expect(modIdSteps[0]!.sql).not.toContain('AUTO_INCREMENT');

    // L1: 当 PK 被删且同列仅有 FULLTEXT 索引时，P3 仍必须剥离 AUTO_INCREMENT
    const mFt0 = emptyModel('mysql');
    const sf = createSchema(mFt0, 'default');
    const tf = createTable(mFt0, sf, 'ft_tbl');
    const fid = addColumn(mFt0, tf, {
      name: 'id',
      type: 'bigint',
      notNull: true,
      ext: { mysql: { autoIncrement: true } },
    });
    const fpk = addPrimaryKey(mFt0, tf, [fid]);
    addIndex(mFt0, tf, [{ column: fid }], { ext: { mysql: { indexType: 'FULLTEXT' } } });
    const mFt1 = structuredClone(mFt0);
    dropKey(mFt1, fpk);
    const ftIdx = addIndex(mFt1, tf, [{ column: fid }]);
    expect(ftIdx).toBeTruthy();
    const ftSteps = plan(mFt0, mFt1);
    const stripIdx = ftSteps.findIndex(
      (st) => st.sql.includes('MODIFY COLUMN `id`') && !st.sql.includes('AUTO_INCREMENT'),
    );
    const dropPk = ftSteps.findIndex((st) => st.sql.includes('DROP PRIMARY KEY'));
    expect(stripIdx).toBeGreaterThanOrEqual(0);
    expect(stripIdx).toBeLessThan(dropPk);
    expect(title).toBeTruthy();
    expect(rawCode).toBeTruthy();
  });

  it('R2-1 & R2-3: closes sql_mode/SET_VAR, skipDefiner, splitMysqlStatements >10, single-stmt routines/XA, cross-DB DML/TABLE/fn, and collation-only table alter', () => {
    // 1.1: SET RESOURCE GROUP、危险 sql_mode 与 /*+ SET_VAR(sql_mode=...) */ 优化器提示
    for (const bad of [
      'SET RESOURCE GROUP usr_default;',
      "SET sql_mode = 'ANSI';",
      "SET sql_mode = '4';",
      "SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ANSI_QUOTES';",
      "SET LOCAL sql_mode = 'NO_BACKSLASH_ESCAPES';",
      'SET sql_mode = ANSI_QUOTES;',
      'SET sql_mode = 4;',
      'SET sql_mode = @m;',
      "CREATE PROCEDURE p() BEGIN DECLARE m VARCHAR(64) DEFAULT 'ANSI_QUOTES'; SET sql_mode = m; END;",
      "SET @@sql_mode = CONCAT('ANSI', '_QUOTES');",
      "SET @@session.sql_mode = (SELECT 'ANSI_QUOTES');",
      "SET @a = 1, @@local.sql_mode = 'NO_BACKSLASH_ESCAPES';",
      "SELECT /*+ SET_VAR(sql_mode='ANSI_QUOTES') */ 1;",
      'SELECT /*+ SET_VAR(`sql_mode` = ANSI) */ 1;',
      // 1.2: skipDefiner 引号/反引号 host 紧邻关键字
      "CREATE DEFINER='root'@'%'EVENT ev1 ON SCHEDULE EVERY 1 HOUR DO SELECT 1;",
      "CREATE DEFINER='root'@'%'VIEW dowel_v AS SELECT 1;",
      'CREATE DEFINER=`root`@`localhost`TRIGGER tr AFTER INSERT ON dowel_history FOR EACH ROW SET @x = 1;',
      // 1.3: 无 BEGIN 单语句例程、FOLLOWS/PRECEDES、DECLARE ... HANDLER 与 XA
      'CREATE PROCEDURE p() EXECUTE s;',
      'CREATE PROCEDURE p() FLUSH TABLE;',
      'CREATE PROCEDURE p() FLUSH PRIVILEGES;',
      'CREATE PROCEDURE p() RESET MASTER;',
      'CREATE PROCEDURE p() SHUTDOWN;',
      'CREATE PROCEDURE p() RESTART;',
      "CREATE PROCEDURE p() BINLOG 'abc';",
      "CREATE PROCEDURE p() GRANT ALL ON *.* TO 'u'@'%';",
      "CREATE PROCEDURE p() XA START 'tx1';",
      "XA START 'tx1';",
      'CREATE TRIGGER tr AFTER INSERT ON users FOR EACH ROW FOLLOWS tr0 FLUSH TABLES;',
      'CREATE TRIGGER tr AFTER INSERT ON users FOR EACH ROW PRECEDES tr0 RESET PERSIST;',
      'CREATE PROCEDURE p() BEGIN DECLARE CONTINUE HANDLER FOR SQLEXCEPTION EXECUTE s; END;',
      // 1.4: STRAIGHT_JOIN、穿过 JOIN...ON/USING 与派生表别名的多表、括号表因子、LOCK TABLES、HANDLER、tbl.*、TABLE 语句、跨库函数、ALTER RENAME/EXCHANGE、维护命令
      'SELECT * FROM users STRAIGHT_JOIN prod.orders;',
      'SELECT * FROM users u JOIN orders o ON u.id = o.user_id, dowel_versions v;',
      'SELECT * FROM users u JOIN orders o USING (id), prod.accounts a;',
      'SELECT * FROM (SELECT 1) AS sub, prod.users;',
      'LOCK TABLES t1 AS a1 READ, prod.t2 WRITE;',
      'LOCK TABLES t1 READ LOCAL, dowel_history WRITE;',
      'LOCK TABLES t1 LOW_PRIORITY WRITE, prod.t2 READ;',
      'HANDLER prod.users OPEN;',
      'HANDLER dowel_history OPEN;',
      "UPDATE (dowel_claims) SET note = 'x';",
      'SELECT * FROM (prod.users);',
      'SELECT dowel_versions.* FROM users;',
      'DELETE prod.users.* FROM users;',
      'TABLE prod.users;',
      'TABLE dowel_history;',
      'SELECT 1 UNION TABLE prod.users;',
      'SELECT prod.secret_fn(1);',
      'ALTER TABLE users RENAME prod.users;',
      'ALTER TABLE users RENAME dowel_evil;',
      'ALTER TABLE t EXCHANGE PARTITION p0 WITH TABLE prod.users;',
      'ANALYZE TABLE prod.users;',
      'OPTIMIZE TABLE dowel_history;',
      'REPAIR TABLE prod.users;',
      'CHECK TABLE prod.users;',
      'CHECKSUM TABLE dowel_versions;',
    ]) {
      expect(findInstanceLevelStatement(bad, 'mysql'), `should block: ${bad}`).not.toBeNull();
    }

    expect(isNontransactionalSql("XA START 'tx1'", 'mysql')).toBe(true);

    // 正常单库写法绝不误报
    for (const ok of [
      "SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';",
      'SET sql_mode = DEFAULT;',
      'SET sql_mode = STRICT_TRANS_TABLES;',
      'SELECT /*+ MAX_EXECUTION_TIME(1000) */ id FROM users;',
      'SELECT STRAIGHT_JOIN u.id FROM users u;',
      'SELECT EXTRACT(YEAR FROM u.created_at), SUBSTRING(u.name FROM 1 FOR 3), SUBSTR(u.name FROM 2), WEIGHT_STRING(u.name) FROM users u;',
      'CREATE TABLE `t` (`shutdown` int, `restart` int, `execute` int, `flush` int, `reset` int, `xa` int);',
      'CREATE TABLE t (shutdown INT, restart INT, execute INT, flush INT, reset INT, xa INT);',
      'ALTER TABLE `users` RENAME COLUMN `a` TO `b`;',
      "UPDATE users SET role = 'admin', password = 'secret', sql_mode = 'custom' WHERE id = 1;",
      'SELECT shutdown;',
    ]) {
      expect(findInstanceLevelStatement(ok, 'mysql'), `should allow: ${ok}`).toBeNull();
    }

    // splitMysqlStatements 对无引号 DEFINER=user@localhost 不会将 user 误判为非例程对象
    const definerUserSplit = splitMysqlStatements(
      'CREATE DEFINER=user@localhost PROCEDURE p() BEGIN SET @a = 1; SET @b = 2; END; SELECT 1;',
    );
    expect(definerUserSplit).toHaveLength(2);
    expect(definerUserSplit[0]).toContain('SET @b = 2;');
    expect(definerUserSplit[1]).toBe('SELECT 1');

    // 1.2: splitMysqlStatements 超过 10 个词的 CREATE DEFINER ... PROCEDURE 仍正确保留 BEGIN...END 复合块
    const longHeaderProc = `
      CREATE /* c1 */ DEFINER = 'admin'@'127.0.0.1'
      SQL SECURITY DEFINER
      PROCEDURE long_proc(IN a INT, IN b INT)
      COMMENT 'long header'
      DETERMINISTIC
      MODIFIES SQL DATA
      BEGIN
        SET @x = 1;
        SET @y = 2;
      END;
      CREATE TABLE t_after (event INT, begin INT);
      CREATE TABLE t_next (id INT);
    `;
    const splitLong = splitMysqlStatements(longHeaderProc);
    expect(splitLong).toHaveLength(3);
    expect(splitLong[0]).toContain('PROCEDURE long_proc');
    expect(splitLong[0]).toContain('SET @y = 2;');
    expect(splitLong[1]).toContain('CREATE TABLE t_after');
    expect(splitLong[2]).toBe('CREATE TABLE t_next (id INT)');

    // R2-3: 表级仅设非 utf8mb4 的 collation（省略 charset）不硬编码 utf8mb4
    const mc0 = emptyModel('mysql');
    const sc = createSchema(mc0, 'default');
    const tc = createTable(mc0, sc, 'legacy');
    const lId = addColumn(mc0, tc, { name: 'id', type: 'int', notNull: true });
    addColumn(mc0, tc, { name: 'code', type: 'varchar(32)', notNull: true });
    addPrimaryKey(mc0, tc, [lId]);

    const mc1 = structuredClone(mc0);
    setTableExt(mc1, tc, { mysql: { collation: 'latin1_bin' } });
    const latinSteps = plan(mc0, mc1);
    expect(latinSteps[0]!.sql).toBe('ALTER TABLE `legacy` DEFAULT COLLATE latin1_bin');
    expect(latinSteps[0]!.sql).not.toContain('utf8mb4');
    expect(latinSteps.some((st) => st.sql.includes('MODIFY COLUMN `code`'))).toBe(true);
  });

  it('guards DROP VIEW lists and JSON_TABLE table lists while allowing SET(...) enum types and ON DELETE/UPDATE SET actions', () => {
    for (const bad of [
      'DROP VIEW v1, prod.v2;',
      'DROP VIEW IF EXISTS v1, dowel_v;',
      'DROP VIEW v1, v2, prod.v3;',
      "SELECT * FROM JSON_TABLE('[{\"a\":1}]', '$[*]' COLUMNS (a INT PATH '$.a')) AS jt, prod.users;",
      "SELECT * FROM JSON_TABLE('[{\"a\":1}]', '$[*]' COLUMNS (a INT PATH '$.a')) AS jt, dowel_history;",
      "DELETE u FROM JSON_TABLE('[{\"a\":1}]', '$[*]' COLUMNS (a INT PATH '$.a')) AS jt, prod.users AS u;",
      "DELETE FROM t1 USING JSON_TABLE('[{\"a\":1}]', '$[*]' COLUMNS (a INT PATH '$.a')) AS jt, prod.users;",
      "SELECT * FROM (JSON_TABLE('[{\"a\":1}]', '$[*]' COLUMNS (a INT PATH '$.a')) AS jt, prod.users);",
      "UPDATE JSON_TABLE('[{\"a\":1}]', '$[*]' COLUMNS (a INT PATH '$.a')) AS jt, prod.users u SET u.name = 'x';",
      'SELECT * FROM (SELECT 1) AS sub (c1), prod.users;',
      "CREATE PROCEDURE p() BEGIN DECLARE flags SET('a','b'); SET GLOBAL read_only = 1; END;",
      "CREATE TRIGGER tr AFTER DELETE ON users FOR EACH ROW SET sql_mode = 'ANSI';",
      'CREATE TRIGGER tr AFTER UPDATE ON users FOR EACH ROW BEGIN SET RESOURCE GROUP usr_default; END;',
    ]) {
      expect(findInstanceLevelStatement(bad, 'mysql'), `should block: ${bad}`).not.toBeNull();
    }

    for (const ok of [
      'DROP VIEW IF EXISTS v1, v2;',
      "SELECT * FROM JSON_TABLE('[{\"a\":1}]', '$[*]' COLUMNS (a INT PATH '$.a')) AS jt;",
      "SELECT jt.a, u.name FROM JSON_TABLE('[{\"a\":1}]', '$[*]' COLUMNS (a INT PATH '$.a')) AS jt JOIN users u ON jt.a = u.id;",
      "CREATE TABLE t (flags SET('a', 'b'), sql_mode VARCHAR(64));",
      "CREATE TABLE t (flags SET('a', 'b'), global INT);",
      "CREATE TABLE t (flags SET('a', 'b'), id INT, `sql_mode` VARCHAR(64));",
      "CREATE TABLE t (flags SET('a', 'b'), persist INT, persist_only INT);",
      'CREATE TABLE t (id INT REFERENCES p(id) ON DELETE SET NULL, sql_mode VARCHAR(64), global INT);',
      'CREATE TABLE t (id INT REFERENCES p(id) ON UPDATE SET DEFAULT, sql_mode VARCHAR(64), persist INT);',
    ]) {
      expect(findInstanceLevelStatement(ok, 'mysql'), `should allow: ${ok}`).toBeNull();
    }
  });
});

describe('MySQL 静态兼容性收集与 diagnoseModel', () => {
  const vectorModel = () => {
    const m = emptyModel('mysql');
    const s = createSchema(m, 'default');
    const t = createTable(m, s, 'emb');
    addColumn(m, t, { id: 'c1', name: 'id', type: 'int', notNull: true });
    addColumn(m, t, { id: 'c2', name: 'v1', type: 'vector(3)' });
    addColumn(m, t, { id: 'c3', name: 'v2', type: 'VECTOR(8)' });
    return m;
  };

  it('一次收集全部不兼容的 VECTOR 列；规划器仍抛出第一条 PlanError', () => {
    const m = vectorModel();
    const issues = checkMysqlCompatibility(m, 80400);
    expect(issues.map((i) => i.objectId)).toEqual(['c2', 'c3']);
    expect(issues[0]).toMatchObject({ code: 'vector_type', severity: 'error', objectName: 'emb.v1' });
    expect(checkMysqlCompatibility(m, 90700)).toEqual([]);
    expect(checkMysqlCompatibility(m, null)).toEqual([]);
    expect(() => checkMysqlVersionCompatibility(m, 80400)).toThrow(PlanError);
    expect(() => checkMysqlVersionCompatibility(m, 80400)).toThrow(issues[0]!.message);
  });

  it('diagnoseModel 取环境最低版本作为目标', () => {
    const m = vectorModel();
    const d = diagnoseModel(m, [90700, 80413]);
    expect(d.target).toBe('MySQL 8.4');
    expect(d.compatibility.errors.total).toBe(2);
    expect(d.compatibility.errors.items[0]).toMatchObject({ minVersion: 'MySQL 9.0' });
    expect(diagnoseModel(m, [90700]).compatibility.errors.total).toBe(0);
    expect(diagnoseModel(m, []).target).toBeNull();
  });
});
