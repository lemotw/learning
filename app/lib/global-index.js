// 可重建的跨課程 projection。Course content + course-local state 才是唯一真相。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bundles = require('./course-bundles');
const content = require('./content');
const store = require('./db');

const DATA_DIR = process.env.LEARNING_DATA_ROOT || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = process.env.GLOBAL_INDEX_FILE || path.join(DATA_DIR, 'global-index.sqlite');
const db = new DatabaseSync(FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS courses (
    slug TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    archived_at TEXT,
    state_revision INTEGER NOT NULL,
    content_fingerprint TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recent_records (
    course TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    unit TEXT,
    kind TEXT NOT NULL,
    note TEXT,
    PRIMARY KEY(course, source_id)
  );
  CREATE TABLE IF NOT EXISTS redo_queue (
    course TEXT NOT NULL,
    unit TEXT NOT NULL,
    question_id TEXT NOT NULL,
    verdict TEXT NOT NULL,
    feedback TEXT,
    ts TEXT NOT NULL,
    PRIMARY KEY(course, unit, question_id)
  );
  CREATE TABLE IF NOT EXISTS activities (
    course TEXT NOT NULL,
    activity_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    unit TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    role TEXT NOT NULL,
    required INTEGER NOT NULL,
    order_no INTEGER NOT NULL,
    metadata_json TEXT,
    course_status TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at TEXT,
    PRIMARY KEY(course, activity_id)
  );
  CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status);
  CREATE INDEX IF NOT EXISTS idx_records_ts ON recent_records(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_activity_resource ON activities(resource_id);
  CREATE INDEX IF NOT EXISTS idx_activity_state ON activities(course_status,state);
`);

// global index 是衍生資料；舊的多維 Activity projection 直接丟掉重建。
const activityCols = db.prepare('PRAGMA table_info(activities)').all().map(c => c.name);
if (activityCols.includes('attempt_count') || activityCols.includes('review_due_at')) {
  db.exec(`
    DROP TABLE activities;
    CREATE TABLE activities (
      course TEXT NOT NULL, activity_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      unit TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
      role TEXT NOT NULL, required INTEGER NOT NULL, order_no INTEGER NOT NULL,
      metadata_json TEXT, course_status TEXT NOT NULL, state TEXT NOT NULL,
      updated_at TEXT, PRIMARY KEY(course, activity_id)
    );
    CREATE INDEX idx_activity_resource ON activities(resource_id);
    CREATE INDEX idx_activity_state ON activities(course_status,state);
    DELETE FROM courses;
    DELETE FROM recent_records;
    DELETE FROM redo_queue;
  `);
}

const now = () => new Date().toISOString();
const getMeta = key => db.prepare('SELECT value FROM index_meta WHERE key=?').get(key)?.value || null;
const setMeta = (key, value) => db.prepare(`INSERT INTO index_meta(key,value) VALUES (?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));

function buildSummary(info, state, activities) {
  const pm = Object.fromEntries(state.progress.map(p => [p.unit, p]));
  const units = content.listUnits(info.slug).map(u => ({
    ...u,
    state: pm[u.file]?.state || 'unread',
    updatedAt: pm[u.file]?.updated_at || null,
  }));
  const ap = Object.fromEntries(state.activityProgress.map(p => [p.activity_id, p]));
  const activityCounts = { todo: 0, doing: 0, done: 0, total: activities.length, anchorsDone: 0, anchorsTotal: 0 };
  for (const a of activities) {
    const s = ap[a.id]?.state || 'todo';
    activityCounts[s]++;
    if (a.role === 'anchor') {
      activityCounts.anchorsTotal++;
      if (s === 'done') activityCounts.anchorsDone++;
    }
  }
  return {
    slug: info.slug,
    id: info.id,
    title: info.meta.title || info.slug,
    status: info.status,
    archivedAt: state.archivedAt || info.meta.archivedAt || null,
    tags: info.meta.tags || [],
    relations: info.meta.relations || [],
    units,
    done: units.filter(x => x.state === 'done').length,
    total: units.length,
    activities: activityCounts,
  };
}

function reindexCourse(slug) {
  const info = content.courseInfo(slug);
  const state = store.stateSummary(slug);
  const manifest = content.readActivities(slug);
  const fingerprint = content.contentFingerprint(slug);
  const summary = buildSummary(info, state, manifest);
  const progress = Object.fromEntries(state.activityProgress.map(p => [p.activity_id, p]));
  const previousActivities = new Map(db.prepare('SELECT * FROM activities WHERE course=?').all(slug)
    .map(a => [a.activity_id, a]));

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO courses
      (slug,course_id,status,title,archived_at,state_revision,content_fingerprint,summary_json,indexed_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(slug) DO UPDATE SET course_id=excluded.course_id,status=excluded.status,
        title=excluded.title,archived_at=excluded.archived_at,state_revision=excluded.state_revision,
        content_fingerprint=excluded.content_fingerprint,summary_json=excluded.summary_json,indexed_at=excluded.indexed_at`)
      .run(slug, info.id, info.status, summary.title, summary.archivedAt, state.revision,
        fingerprint, JSON.stringify(summary), now());
    for (const table of ['recent_records', 'redo_queue', 'activities']) db.prepare(`DELETE FROM ${table} WHERE course=?`).run(slug);
    const recStmt = db.prepare(`INSERT INTO recent_records(course,source_id,ts,unit,kind,note) VALUES (?,?,?,?,?,?)`);
    for (const r of state.records) recStmt.run(slug, r.id, r.ts, r.unit || null, r.kind, r.note || null);
    const redoStmt = db.prepare(`INSERT INTO redo_queue(course,unit,question_id,verdict,feedback,ts) VALUES (?,?,?,?,?,?)`);
    for (const r of state.redo) redoStmt.run(slug, r.unit, r.question_id, r.verdict, r.feedback || null, r.ts);
    const actStmt = db.prepare(`INSERT INTO activities
      (course,activity_id,resource_id,unit,kind,title,url,role,required,order_no,metadata_json,
       course_status,state,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const liveActivityIds = new Set();
    for (const a of manifest) {
      liveActivityIds.add(a.id);
      const p = progress[a.id] || {};
      actStmt.run(slug, a.id, a.resource, a.unit, a.kind, a.title, a.url || null, a.role,
        a.required ? 1 : 0, a.order, JSON.stringify(a.metadata || {}), info.status,
        p.state || 'todo', p.updated_at || null);
    }
    // Manifest 移除只代表 assignment retired；既有進度與嘗試歷史不能消失。
    for (const id of Object.keys(progress)) {
      if (liveActivityIds.has(id)) continue;
      const p = progress[id], old = previousActivities.get(id);
      actStmt.run(slug, id, old?.resource_id || `course:${info.id}:${id}`, old?.unit || '',
        old?.kind || 'exercise', old?.title || id, old?.url || null, 'retired', 0, 0,
        JSON.stringify({ retired: true }), info.status, p.state, p.updated_at || null);
    }
    db.exec('COMMIT');
    return summary;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function reconcile({ full = false } = {}) {
  const live = new Set();
  const changed = [];
  const errors = [];
  for (const b of bundles.list()) {
    live.add(b.slug);
    try {
      if (full) {
        const integrity = store.checkIntegrity(b.slug);
        if (integrity.some(x => x !== 'ok')) throw new Error(`state sqlite integrity: ${integrity.join(', ')}`);
      }
      const rev = store.getRevision(b.slug);
      const fp = content.contentFingerprint(b.slug);
      const row = db.prepare('SELECT status,state_revision,content_fingerprint FROM courses WHERE slug=?').get(b.slug);
      if (full || !row || row.status !== b.status || row.state_revision !== rev || row.content_fingerprint !== fp) {
        reindexCourse(b.slug); changed.push(b.slug);
      }
    } catch (e) { errors.push({ course: b.slug, error: e.message }); }
  }
  for (const row of db.prepare('SELECT slug FROM courses').all()) {
    if (live.has(row.slug)) continue;
    for (const table of ['courses', 'recent_records', 'redo_queue', 'activities']) db.prepare(`DELETE FROM ${table} WHERE ${table === 'courses' ? 'slug' : 'course'}=?`).run(row.slug);
    changed.push(`-${row.slug}`);
  }
  setMeta('last_probe_at', now());
  if (full) setMeta('last_full_check_at', now());
  if (errors.length) setMeta('last_errors', JSON.stringify(errors)); else setMeta('last_errors', '[]');
  return { changed, errors, full, checkedAt: getMeta('last_probe_at') };
}

function listCourses(status = 'active') {
  return db.prepare('SELECT summary_json FROM courses WHERE status=? ORDER BY title').all(status)
    .map(r => JSON.parse(r.summary_json));
}

function recentRecords(limit = 20, status = 'active') {
  return db.prepare(`SELECT r.* FROM recent_records r JOIN courses c ON c.slug=r.course
    WHERE c.status=? ORDER BY r.ts DESC LIMIT ?`).all(status, limit);
}

function redoQueue(status = 'active') {
  return db.prepare(`SELECT r.* FROM redo_queue r JOIN courses c ON c.slug=r.course
    WHERE c.status=? ORDER BY r.ts DESC`).all(status);
}

function listActivities({ course = null, unit = null, status = null, kind = null, role = null } = {}) {
  const where = [], params = [];
  for (const [col, val] of [['course', course], ['unit', unit], ['state', status], ['kind', kind], ['role', role]]) {
    if (val == null) continue; where.push(`${col}=?`); params.push(val);
  }
  return db.prepare(`SELECT * FROM activities${where.length ? ' WHERE ' + where.join(' AND ') : ''}
    ORDER BY course,unit,order_no,activity_id`).all(...params).map(r => ({
      ...r, required: !!r.required, metadata: JSON.parse(r.metadata_json || '{}'),
    }));
}

function resourceCatalog({ includeArchived = true } = {}) {
  const where = includeArchived ? '' : "WHERE course_status='active'";
  const rows = db.prepare(`SELECT * FROM activities ${where} ORDER BY resource_id,updated_at DESC`).all();
  const grouped = new Map();
  const rank = { todo: 0, doing: 1, done: 2 };
  for (const r of rows) {
    const g = grouped.get(r.resource_id) || {
      resource: r.resource_id, title: r.title, url: r.url, state: 'todo',
      updatedAt: null, courses: [],
    };
    g.courses.push({ course: r.course, activityId: r.activity_id, status: r.course_status, role: r.role });
    if (rank[r.state] > rank[g.state]) g.state = r.state;
    if (r.updated_at && (!g.updatedAt || r.updated_at > g.updatedAt)) g.updatedAt = r.updated_at;
    grouped.set(r.resource_id, g);
  }
  return [...grouped.values()].sort((a, b) => a.title.localeCompare(b.title));
}

let running = null;
let lastScheduledProbe = 0;
const PROBE_MS = Number(process.env.INDEX_PROBE_MS || 5 * 60_000);
function scheduleCheck(reason = 'manual', { force = false, full = false } = {}) {
  const age = Date.now() - lastScheduledProbe;
  if (!force && reason === 'homepage' && age < PROBE_MS) return running || Promise.resolve({ skipped: true });
  if (running) return running;
  lastScheduledProbe = Date.now();
  running = new Promise(resolve => setImmediate(resolve)).then(() => reconcile({ full })).finally(() => { running = null; });
  return running;
}

function shouldFullCheck() {
  const last = Date.parse(getMeta('last_full_check_at') || 0);
  return !last || Date.now() - last >= 24 * 60 * 60_000;
}

function status() {
  return {
    file: FILE,
    checking: !!running,
    lastProbeAt: getMeta('last_probe_at'),
    lastFullCheckAt: getMeta('last_full_check_at'),
    errors: JSON.parse(getMeta('last_errors') || '[]'),
  };
}

module.exports = {
  FILE, db, reindexCourse, reconcile, scheduleCheck, shouldFullCheck, status,
  listCourses, recentRecords, redoQueue, listActivities, resourceCatalog,
};
