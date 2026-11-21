import {
  addCheck,
  addColumn,
  addForeignKey,
  addIndex,
  addPrimaryKey,
  addUnique,
  all,
  createAll,
  createSchema,
  createTable,
  emptyModel,
  plan,
  renameColumn,
  setColumnExt,
  setNotNull,
  setTableExt,
  validate,
} from '@dowel/core';
import { describe, expect, it } from 'vitest';

import {
  diffSqliteSnapshots,
  getEngine,
  importSqliteSnapshot,
  openSqliteDb,
  readSqliteSnapshot,
  reconcileIds,
  sqliteEngine,
  sqliteHistory,
  stepsChecksum,
  toScriptSteps,
} from '../src/index.ts';

describe('@dowel/engines SQLite adapter', () => {
  it('roundtrips tables, STRICT, WITHOUT ROWID, AUTOINCREMENT, GENERATED, CHECK, FK, partial & expression indexes, views, triggers', async () => {
    const h = openSqliteDb(':memory:');
    try {
      await h.db.exec(`
        CREATE TABLE orgs (
          id INTEGER NOT NULL CONSTRAINT orgs_pk PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL COLLATE NOCASE UNIQUE,
          name TEXT NOT NULL DEFAULT 'default',
          CONSTRAINT chk_code CHECK (length(code) > 0)
        ) STRICT;

        CREATE TABLE members (
          org_id INTEGER NOT NULL,
          email TEXT NOT NULL,
          score REAL DEFAULT 0.5,
          email_len INTEGER GENERATED ALWAYS AS (length(email)) VIRTUAL,
          double_score REAL GENERATED ALWAYS AS (score * 2) STORED,
          PRIMARY KEY (org_id, email),
          FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
        ) WITHOUT ROWID, STRICT;

        CREATE UNIQUE INDEX idx_members_email_lower ON members (lower(email)) WHERE score > 0;
        CREATE INDEX idx_orgs_name_desc ON orgs (name COLLATE NOCASE DESC);

        CREATE VIEW active_orgs AS SELECT id, code FROM orgs;
        CREATE TRIGGER tr_orgs_insert AFTER INSERT ON orgs BEGIN SELECT 1; END;
      `);

      const snap1 = await readSqliteSnapshot(h.db);
      expect(snap1.tables.orgs?.strict).toBe(true);
      expect(snap1.tables.orgs?.withoutRowid).toBe(false);
      expect(snap1.tables.orgs?.columns.id?.autoincrement).toBe(true);
      expect(snap1.tables.orgs?.columns.code?.collation).toBe('NOCASE');
      expect(snap1.tables.orgs?.checks).toEqual([{ name: 'chk_code', expr: 'length(code) > 0' }]);
      expect(snap1.tables.members?.withoutRowid).toBe(true);
      expect(snap1.tables.members?.strict).toBe(true);
      expect(snap1.tables.members?.columns.email_len?.generated).toEqual({
        expr: 'length(email)',
        stored: false,
      });
      expect(snap1.tables.members?.columns.double_score?.generated).toEqual({
        expr: 'score * 2',
        stored: true,
      });
      expect(snap1.tables.members?.foreignKeys[0]).toMatchObject({
        columns: ['org_id'],
        refTable: 'orgs',
        refColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'restrict',
        deferrable: true,
        initiallyDeferred: true,
      });
      expect(snap1.tables.members?.indexes.idx_members_email_lower).toEqual({
        unique: true,
        elements: [{ column: null, expr: 'lower(email)', desc: false, collation: null }],
        where: 'score > 0',
      });
      expect(Object.keys(snap1.opaques).sort()).toEqual(['trigger:tr_orgs_insert', 'view:active_orgs']);

      const model = importSqliteSnapshot(snap1);
      expect(model.dialect).toBe('sqlite');
      expect(validate(model)).toEqual([]);

      // Rebuild from IR into fresh memory DB and assert 0 diff
      const h2 = openSqliteDb(':memory:');
      try {
        for (const s of createAll(model)) {
          await sqliteEngine.execStepSql(h2.db, s.sql);
        }
        const snap2 = await readSqliteSnapshot(h2.db);
        expect(diffSqliteSnapshots(snap2, snap1)).toEqual([]);

        // reconcileIds preserves IDs on re-import
        const reimported = reconcileIds(model, importSqliteSnapshot(snap2));
        expect(plan(model, reimported)).toEqual([]);
      } finally {
        h2.close();
      }
    } finally {
      h.close();
    }
  });

  it('12-step rebuild rolls back atomically on PRAGMA foreign_key_check failure and restores foreign_keys=ON', async () => {
    const h = openSqliteDb(':memory:');
    try {
      await h.db.exec(`
        CREATE TABLE parent (id INTEGER NOT NULL PRIMARY KEY);
        CREATE TABLE child (id INTEGER NOT NULL PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));
        INSERT INTO parent VALUES (1);
        INSERT INTO child VALUES (10, 1);
      `);

      // Malicious/broken rebuild that drops parent rows so child FK becomes invalid
      const brokenStep = [
        'PRAGMA foreign_keys = OFF',
        'BEGIN IMMEDIATE',
        'CREATE TABLE "_dowel_tmp_1" ("id" INTEGER NOT NULL PRIMARY KEY)',
        'DROP TABLE "parent"',
        'ALTER TABLE "_dowel_tmp_1" RENAME TO "parent"',
        'PRAGMA foreign_key_check',
        'COMMIT',
        'PRAGMA foreign_keys = ON',
      ].join(';\n');

      await expect(sqliteEngine.execStepSql(h.db, brokenStep)).rejects.toThrow(/foreign_key_check/);

      // Transaction rolled back: parent row 1 still exists!
      const rows = await h.db.query<{ id: number }>('SELECT id FROM parent');
      expect(rows).toEqual([{ id: 1 }]);
      // PRAGMA foreign_keys restored to ON!
      const [fk] = await h.db.query<{ foreign_keys: number }>('PRAGMA foreign_keys');
      expect(fk?.foreign_keys).toBe(1);
    } finally {
      h.close();
    }
  });

  it('analyzes 12-step table rebuild as high risk with rewrites', async () => {
    const m0 = emptyModel('sqlite');
    const s = createSchema(m0, 'main');
    const t = createTable(m0, s, 'items');
    const id = addColumn(m0, t, { name: 'id', type: 'INTEGER', notNull: true });
    const title = addColumn(m0, t, { name: 'title', type: 'TEXT' });
    addPrimaryKey(m0, t, [id]);
    setColumnExt(m0, id, { sqlite: { autoincrement: true } });

    const m1 = structuredClone(m0);
    setNotNull(m1, title, true);
    setTableExt(m1, t, { sqlite: { strict: true } });
    addCheck(m1, t, 'length(title) > 0');
    addUnique(m1, t, [title]);
    addIndex(m1, t, [{ column: title }]);

    const steps = plan(m0, m1);
    const h = openSqliteDb(':memory:');
    try {
      const risks = await getEngine('sqlite').analyzeStepRisk(h.db, m0, steps);
      const rebuildIdx = steps.findIndex((st) => st.kind === 'rebuildTable');
      expect(rebuildIdx).toBeGreaterThanOrEqual(0);
      expect(risks[rebuildIdx]).toMatchObject({
        level: 'high',
        rewrites: ['items'],
      });
    } finally {
      h.close();
    }
  });

  it('enforces append-only dowel_history & dowel_claims via triggers and excludes dowel_* from snapshot', async () => {
    const h = openSqliteDb(':memory:');
    try {
      expect(await sqliteHistory.historyExists(h.db)).toBe(false);
      await sqliteHistory.ensureHistory(h.db);
      expect(await sqliteHistory.historyExists(h.db)).toBe(true);
      expect(await sqliteHistory.readHistoryFormat(h.db)).toBe(1);

      const m = emptyModel('sqlite');
      const s = createSchema(m, 'main');
      const t = createTable(m, s, 'notes');
      const id = addColumn(m, t, { name: 'id', type: 'INTEGER', notNull: true });
      addPrimaryKey(m, t, [id]);
      const up = toScriptSteps(createAll(m), 'sqlite');
      const checksum = stepsChecksum(up, []);

      await sqliteHistory.writeProject(h.db, {
        projectId: 'p1',
        name: 'Notes',
        instanceId: 'inst-1',
        claimedAt: new Date().toISOString(),
        claimedBy: 'u1',
      });
      await sqliteHistory.recordVersion(h.db, {
        projectId: 'p1',
        versionId: 'v1',
        number: 1,
        parentId: null,
        name: 'init',
        scope: null,
        upSteps: up,
        downSteps: [],
        checksum,
        model: m,
        fingerprint: 'fp1',
        publishedAt: new Date().toISOString(),
        publishedBy: 'u1',
      });
      const runId = await sqliteHistory.startRun(h.db, {
        projectId: 'p1',
        fromVersion: null,
        toVersion: 'v1',
        direction: 'up',
        executedBy: 'u1',
        via: 'web',
        instanceId: 'inst-1',
      });
      await sqliteHistory.markStep(h.db, runId, 0);
      await sqliteHistory.finishRun(h.db, runId, 'done');

      // Append-only trigger blocks DELETE and UPDATE of finished runs
      await expect(h.db.exec('DELETE FROM dowel_history')).rejects.toThrow(/只追加/);
      await expect(h.db.exec(`UPDATE dowel_history SET error = 'hack' WHERE id = ${runId}`)).rejects.toThrow(
        /只追加/,
      );

      // Claim + claims append-only trigger
      const claimed = await sqliteHistory.claimProject(h.db, {
        projectId: 'p1',
        instanceId: 'inst-2',
        claimedBy: 'u2',
        claimedByName: 'Admin',
        name: 'Notes',
      });
      expect(claimed).toEqual({ changed: true, previousInstanceId: 'inst-1' });
      await expect(h.db.exec('DELETE FROM dowel_claims')).rejects.toThrow(/只追加/);
      await expect(h.db.exec("UPDATE dowel_claims SET note = 'x'")).rejects.toThrow(/只追加/);

      // Snapshot completely ignores dowel_* tables
      const snap = await readSqliteSnapshot(h.db);
      expect(Object.keys(snap.tables)).toEqual([]);

      // listHistoryProjects reports the project cleanly
      const listed = await sqliteHistory.listHistoryProjects(h.db);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        projectId: 'p1',
        instanceId: 'inst-2',
        versions: 1,
        headNumber: 1,
        currentNumber: 1,
      });

      // Project lock mutex rejects concurrent lock with timeoutMs = 0
      await sqliteHistory.withProjectLock(h.db, 'p1', 1000, async () => {
        await expect(sqliteHistory.withProjectLock(h.db, 'p1', 0, async () => {})).rejects.toMatchObject({
          code: 'lock_timeout',
        });
      });

      // Add FK table just to silence unused import
      const t2 = createTable(m, s, 'tags');
      const tid = addColumn(m, t2, { name: 'id', type: 'INTEGER', notNull: true });
      const nid = addColumn(m, t2, { name: 'note_id', type: 'INTEGER', notNull: true });
      addPrimaryKey(m, t2, [tid]);
      addForeignKey(m, t2, [nid], t, [id]);
      expect(validate(m)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('C1: engine-level authorizer blocks ATTACH/DETACH and dangerous PRAGMAs', async () => {
    const h = openSqliteDb(':memory:');
    try {
      await expect(h.db.exec("ATTACH':memory:'AS pwn")).rejects.toThrow(/not authorized/);
      await expect(h.db.exec('PRAGMA writable_schema = ON')).rejects.toThrow(/not authorized/);
    } finally {
      h.close();
    }
  });

  it('H2, H3, M1, M2, L2: view/trigger deps, parent rebuild+rename FK sync, sqlite_sequence HWM, offline FK abort, multi-FK refColumns, unconditional FK restore', async () => {
    const h = openSqliteDb(':memory:');
    try {
      await h.db.exec(`
        CREATE TABLE orgs (
          id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL UNIQUE,
          alt_code TEXT NOT NULL UNIQUE
        );
        CREATE TABLE members (
          id INTEGER NOT NULL PRIMARY KEY,
          org_id INTEGER NOT NULL,
          ref_code TEXT NOT NULL,
          FOREIGN KEY (org_id) REFERENCES orgs(id),
          CONSTRAINT fk_code FOREIGN KEY (ref_code) REFERENCES orgs(code),
          CONSTRAINT fk_alt FOREIGN KEY (ref_code) REFERENCES orgs(alt_code)
        );
        CREATE TABLE audit_log (id INTEGER PRIMARY KEY, note TEXT);
        CREATE VIEW v_org_codes AS SELECT o.id, o.code FROM orgs o;
        CREATE VIEW v_org_summary AS SELECT id FROM v_org_codes;
        CREATE TRIGGER tr_orgs_audit AFTER INSERT ON orgs BEGIN
          INSERT INTO audit_log(note) VALUES (NEW.code);
        END;
        INSERT INTO orgs (code, alt_code) VALUES ('a', 'a'), ('b', 'b'), ('c', 'c');
        DELETE FROM orgs;
      `);

      const snap0 = await readSqliteSnapshot(h.db);
      // M2: two FKs on same column ref_code pointing to different refColumns match their distinct names
      const fkByName = new Map(snap0.tables.members!.foreignKeys.map((f) => [f.name, f.refColumns]));
      expect(fkByName.get('fk_code')).toEqual(['code']);
      expect(fkByName.get('fk_alt')).toEqual(['alt_code']);

      // H2: view & cross-table trigger deps are populated
      const m0 = importSqliteSnapshot(snap0);
      const orgsTbl = all(m0, 'table').find((t) => t.name === 'orgs')!;
      const auditTbl = all(m0, 'table').find((t) => t.name === 'audit_log')!;
      const orgCodeCol = all(m0, 'column').find((c) => c.parent === orgsTbl.id && c.name === 'code')!;
      const vCodes = all(m0, 'opaque').find((o) => o.name === 'v_org_codes')!;
      const vSummary = all(m0, 'opaque').find((o) => o.name === 'v_org_summary')!;
      const trAudit = all(m0, 'opaque').find((o) => o.name === 'tr_orgs_audit')!;
      expect(vCodes.deps).toContain(orgsTbl.id);
      expect(vCodes.deps).toContain(orgCodeCol.id);
      expect(vSummary.deps).toContain(vCodes.id);
      expect(trAudit.deps).toContain(orgsTbl.id);
      expect(trAudit.deps).toContain(auditTbl.id);
      expect(trAudit.deps).toContain(orgCodeCol.id);

      // H2 + H3 + M1: rebuild orgs (STRICT) + rename referenced column id -> org_pk, update view DDL accordingly
      const m1 = structuredClone(m0);
      const oid = all(m1, 'column').find((c) => c.parent === orgsTbl.id && c.name === 'id')!.id;
      setTableExt(m1, orgsTbl.id, { sqlite: { strict: true } });
      renameColumn(m1, oid, 'org_pk');
      // Update view DDLs to match renamed column
      for (const o of all(m1, 'opaque')) {
        if (o.name === 'v_org_codes')
          o.ddl = ['CREATE VIEW v_org_codes AS SELECT o.org_pk, o.code FROM orgs o'];
        if (o.name === 'v_org_summary')
          o.ddl = ['CREATE VIEW v_org_summary AS SELECT org_pk FROM v_org_codes'];
      }

      const steps = plan(m0, m1);
      for (const s of steps) {
        await sqliteEngine.execStepSql(h.db, s.sql);
      }

      // M1: AUTOINCREMENT high-water mark (3) preserved even though table was empty during rebuild -> next id is 4
      await h.db.exec("INSERT INTO orgs (code, alt_code) VALUES ('d', 'd')");
      const [inserted] = await h.db.query<{ org_pk: number }>('SELECT org_pk FROM orgs');
      expect(inserted?.org_pk).toBe(4);

      // Verify snapshot matches fresh build of m1
      const snapAfter = await readSqliteSnapshot(h.db);
      const fresh = openSqliteDb(':memory:');
      try {
        for (const s of createAll(m1)) await sqliteEngine.execStepSql(fresh.db, s.sql);
        expect(diffSqliteSnapshots(snapAfter, await readSqliteSnapshot(fresh.db))).toEqual([]);
      } finally {
        fresh.close();
      }

      // M1 offline abort: running raw SQL with _dowel_fk_guard fails even without Dowel's execSqliteStepSql wrapper
      await h.db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
      await h.db.exec("INSERT INTO members (id, org_id, ref_code) VALUES (1, 9999, 'missing')");
      expect(() =>
        h.raw.exec(
          'CREATE TEMP TABLE _dowel_fk_guard (x INT NOT NULL); INSERT INTO temp._dowel_fk_guard SELECT NULL FROM pragma_foreign_key_check LIMIT 1; DROP TABLE temp._dowel_fk_guard;',
        ),
      ).toThrow(/NOT NULL constraint failed/);
      await h.db.exec('ROLLBACK; PRAGMA foreign_keys = ON;');

      // L2: unconditional foreign_keys restore even on custom script without standard OFF token
      await sqliteEngine.execStepSql(h.db, 'PRAGMA main.foreign_keys = 0');
      const [fkState] = await h.db.query<{ foreign_keys: number }>('PRAGMA foreign_keys');
      expect(fkState?.foreign_keys).toBe(1);
    } finally {
      h.close();
    }
  });
});
