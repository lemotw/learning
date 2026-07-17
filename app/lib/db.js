// SQLite(node:sqlite,零依賴)— 只存狀態與行為;內容真相在 courses/ 的 md
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'learning.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS progress (
    course TEXT NOT NULL,
    unit TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'unread',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (course, unit)
  );
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    course TEXT NOT NULL,
    unit TEXT,
    kind TEXT NOT NULL,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS selfcheck_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    course TEXT NOT NULL,
    unit TEXT NOT NULL,
    question_id TEXT NOT NULL,
    answer TEXT NOT NULL,
    verdict TEXT NOT NULL,
    feedback TEXT
  );
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course TEXT NOT NULL,
    unit TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    course TEXT NOT NULL,
    unit TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();

module.exports = {
  db,
  now,

  getProgress(course) {
    return db.prepare('SELECT unit, state, updated_at FROM progress WHERE course = ?').all(course);
  },

  setProgress(course, unit, state) {
    db.prepare(`
      INSERT INTO progress (course, unit, state, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (course, unit) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
    `).run(course, unit, state, now());
  },

  addRecord(course, unit, kind, note) {
    db.prepare('INSERT INTO records (ts, course, unit, kind, note) VALUES (?, ?, ?, ?, ?)')
      .run(now(), course, unit, kind, note || null);
  },

  recentRecords(limit = 20) {
    return db.prepare('SELECT * FROM records ORDER BY id DESC LIMIT ?').all(limit);
  },

  addAttempt(course, unit, qid, answer, verdict, feedback) {
    db.prepare(`INSERT INTO selfcheck_attempts (ts, course, unit, question_id, answer, verdict, feedback)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(now(), course, unit, qid, answer, verdict, feedback || null);
  },

  attempts(course, unit) {
    return db.prepare(
      'SELECT * FROM selfcheck_attempts WHERE course = ? AND unit = ? ORDER BY id ASC'
    ).all(course, unit);
  },

  // 每題最新一次作答為 redo 的清單(待回爐佇列)
  redoQueue() {
    return db.prepare(`
      SELECT course, unit, question_id, verdict, feedback, ts FROM selfcheck_attempts
      WHERE id IN (
        SELECT MAX(id) FROM selfcheck_attempts GROUP BY course, unit, question_id
      ) AND verdict = 'redo'
      ORDER BY ts DESC
    `).all();
  },

  latestChatSession(course, unit) {
    return db.prepare(
      'SELECT * FROM chat_sessions WHERE course = ? AND unit = ? ORDER BY id DESC LIMIT 1'
    ).get(course, unit);
  },

  addChatSession(course, unit, sessionId) {
    db.prepare('INSERT INTO chat_sessions (course, unit, session_id, created_at) VALUES (?, ?, ?, ?)')
      .run(course, unit, sessionId, now());
  },

  addChatMessage(course, unit, sessionId, role, content) {
    db.prepare(`INSERT INTO chat_messages (ts, course, unit, session_id, role, content)
      VALUES (?, ?, ?, ?, ?, ?)`).run(now(), course, unit, sessionId, role, content);
  },

  chatHistory(course, unit, sessionId) {
    return db.prepare(
      'SELECT ts, role, content FROM chat_messages WHERE course = ? AND unit = ? AND session_id = ? ORDER BY id ASC'
    ).all(course, unit, sessionId);
  },
};
