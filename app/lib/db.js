// Course-local SQLite state。每門課的 state/state.sqlite 是唯一真相；跨課 index 可重建。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bundles = require('./course-bundles');

const connections = new Map();
const ACTIVITY_STATES = new Set(['todo', 'doing', 'done']);
const now = () => new Date().toISOString();

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS state_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO state_meta (key, value) VALUES ('schema_version', '2');
  INSERT OR IGNORE INTO state_meta (key, value) VALUES ('revision', '0');

  CREATE TABLE IF NOT EXISTS progress (
    unit TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'unread',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    unit TEXT,
    kind TEXT NOT NULL,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS selfcheck_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    unit TEXT NOT NULL,
    question_id TEXT NOT NULL,
    answer TEXT NOT NULL,
    verdict TEXT NOT NULL,
    feedback TEXT
  );
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT 'claude',
    model TEXT,
    UNIQUE(unit, session_id)
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    unit TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity_progress (
    activity_id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'todo' CHECK(state IN ('todo','doing','done')),
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_records_ts ON records(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_selfcheck_latest ON selfcheck_attempts(unit, question_id, id DESC);
`;

function migrateSchema(db) {
  const version = Number(db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get()?.value || 1);
  if (version >= 2) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE activity_progress_v2 (
        activity_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'todo' CHECK(state IN ('todo','doing','done')),
        updated_at TEXT NOT NULL
      );
      INSERT INTO activity_progress_v2(activity_id,state,updated_at)
        SELECT activity_id,state,updated_at FROM activity_progress;
      DROP TABLE activity_progress;
      ALTER TABLE activity_progress_v2 RENAME TO activity_progress;
      DROP TABLE IF EXISTS activity_attempts;
      UPDATE state_meta SET value='2' WHERE key='schema_version';
      UPDATE state_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision';
    `);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

function openCourse(course) {
  const bundle = bundles.requireBundle(course);
  const key = bundle.id;
  if (connections.has(key)) return connections.get(key);
  fs.mkdirSync(bundle.stateDir, { recursive: true });
  const file = path.join(bundle.stateDir, 'state.sqlite');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrateSchema(db);
  connections.set(key, db);
  return db;
}

function revision(db) {
  return Number(db.prepare("SELECT value FROM state_meta WHERE key='revision'").get()?.value || 0);
}

function bump(db) {
  db.prepare("UPDATE state_meta SET value = CAST(value AS INTEGER) + 1 WHERE key='revision'").run();
}

function mutate(course, fn) {
  const db = openCourse(course);
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(db);
    bump(db);
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function rowsAcross(sql, params = [], { statuses = null } = {}) {
  const out = [];
  for (const b of bundles.list()) {
    if (statuses && !statuses.has(b.status)) continue;
    const db = openCourse(b.slug);
    for (const row of db.prepare(sql).all(...params)) out.push({ ...row, course: b.slug });
  }
  return out;
}

function closeCourse(course) {
  const b = bundles.locate(course);
  if (!b) return;
  const db = connections.get(b.id);
  if (!db) return;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.close(); } finally { connections.delete(b.id); }
}

function closeAll() {
  for (const b of bundles.list()) closeCourse(b.slug);
}

module.exports = {
  db: null,
  now,
  ACTIVITY_STATES,
  openCourse,
  closeCourse,
  closeAll,

  getRevision(course) { return revision(openCourse(course)); },

  checkIntegrity(course) {
    return openCourse(course).prepare('PRAGMA quick_check').all().map(r => r.quick_check || Object.values(r)[0]);
  },

  getStateMeta(course, key) {
    return openCourse(course).prepare('SELECT value FROM state_meta WHERE key = ?').get(key)?.value || null;
  },

  setStateMeta(course, key, value) {
    return mutate(course, db => db.prepare(`INSERT INTO state_meta(key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value)));
  },

  getProgress(course) {
    return openCourse(course).prepare('SELECT unit, state, updated_at FROM progress').all();
  },

  setProgress(course, unit, state) {
    return mutate(course, db => db.prepare(`
      INSERT INTO progress (unit, state, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (unit) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
    `).run(unit, state, now()));
  },

  addRecord(course, unit, kind, note) {
    return mutate(course, db => db.prepare('INSERT INTO records (ts, unit, kind, note) VALUES (?, ?, ?, ?)')
      .run(now(), unit || null, kind, note || null));
  },

  recentRecords(limit = 20, statuses = new Set(['active', 'archived'])) {
    return rowsAcross('SELECT * FROM records ORDER BY id DESC', [], { statuses })
      .sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
  },

  courseRecords(course, limit = 100) {
    return openCourse(course).prepare('SELECT * FROM records ORDER BY id DESC LIMIT ?').all(limit);
  },

  addAttempt(course, unit, qid, answer, verdict, feedback) {
    return mutate(course, db => db.prepare(`INSERT INTO selfcheck_attempts (ts, unit, question_id, answer, verdict, feedback)
      VALUES (?, ?, ?, ?, ?, ?)`).run(now(), unit, qid, answer, verdict, feedback || null));
  },

  attempts(course, unit) {
    return openCourse(course).prepare(
      'SELECT * FROM selfcheck_attempts WHERE unit = ? ORDER BY id ASC'
    ).all(unit);
  },

  courseRedoQueue(course) {
    return openCourse(course).prepare(`
      SELECT unit, question_id, verdict, feedback, ts FROM selfcheck_attempts
      WHERE id IN (SELECT MAX(id) FROM selfcheck_attempts GROUP BY unit, question_id)
        AND verdict = 'redo' ORDER BY ts DESC
    `).all();
  },

  redoQueue(statuses = new Set(['active', 'archived'])) {
    const out = [];
    for (const b of bundles.list()) {
      if (!statuses.has(b.status)) continue;
      out.push(...this.courseRedoQueue(b.slug).map(r => ({ ...r, course: b.slug })));
    }
    return out.sort((a, b) => b.ts.localeCompare(a.ts));
  },

  latestChatSession(course, unit) {
    return openCourse(course).prepare('SELECT * FROM chat_sessions WHERE unit = ? ORDER BY id DESC LIMIT 1').get(unit);
  },

  addChatSession(course, unit, sessionId, agent = 'claude', model = null) {
    return mutate(course, db => db.prepare(`INSERT INTO chat_sessions (unit, session_id, created_at, agent, model)
      VALUES (?, ?, ?, ?, ?)`).run(unit, sessionId, now(), agent, model));
  },

  chatSessionCount(course, unit) {
    return openCourse(course).prepare('SELECT COUNT(*) n FROM chat_sessions WHERE unit = ?').get(unit).n;
  },

  chatSession(course, unit, sessionId) {
    return openCourse(course).prepare('SELECT * FROM chat_sessions WHERE unit = ? AND session_id = ?').get(unit, sessionId);
  },

  chatSessions(course, unit) {
    return openCourse(course).prepare(`
      SELECT s.session_id, s.created_at, s.agent, s.model,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.unit=s.unit AND m.session_id=s.session_id) AS n,
        (SELECT m.content FROM chat_messages m WHERE m.unit=s.unit AND m.session_id=s.session_id
          AND m.role='user' ORDER BY m.id ASC LIMIT 1) AS first_ask,
        (SELECT MAX(m.ts) FROM chat_messages m WHERE m.unit=s.unit AND m.session_id=s.session_id) AS last_ts
      FROM chat_sessions s WHERE s.unit = ? ORDER BY s.id DESC
    `).all(unit);
  },

  addChatMessage(course, unit, sessionId, role, content) {
    return mutate(course, db => db.prepare(`INSERT INTO chat_messages (ts, unit, session_id, role, content)
      VALUES (?, ?, ?, ?, ?)`).run(now(), unit, sessionId, role, content));
  },

  chatHistory(course, unit, sessionId) {
    return openCourse(course).prepare(`SELECT ts, role, content FROM chat_messages
      WHERE unit = ? AND session_id = ? ORDER BY id ASC`).all(unit, sessionId);
  },

  getActivityProgress(course) {
    return openCourse(course).prepare('SELECT * FROM activity_progress').all();
  },

  setActivityProgress(course, activityId, state) {
    if (!ACTIVITY_STATES.has(state)) throw Object.assign(new Error('bad activity state'), { status: 400 });
    const updatedAt = now();
    mutate(course, db => db.prepare(`INSERT INTO activity_progress
      (activity_id,state,updated_at) VALUES (?,?,?)
      ON CONFLICT(activity_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`)
      .run(activityId, state, updatedAt));
    return { activityId, state, updatedAt };
  },

  stateSummary(course) {
    const db = openCourse(course);
    return {
      revision: revision(db),
      archivedAt: db.prepare("SELECT value FROM state_meta WHERE key='archived_at'").get()?.value || null,
      progress: db.prepare('SELECT unit,state,updated_at FROM progress').all(),
      activityProgress: db.prepare('SELECT * FROM activity_progress').all(),
      redo: this.courseRedoQueue(course),
      records: db.prepare('SELECT * FROM records ORDER BY id DESC LIMIT 100').all(),
    };
  },
};
