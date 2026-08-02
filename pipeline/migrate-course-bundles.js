#!/usr/bin/env node
// 一次性遷移：courses/<slug> + app/data/learning.db → bundle content/ + course-local state.sqlite。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const COURSES = process.env.COURSES_ROOT || path.join(ROOT, 'courses');
const LEGACY_DB = process.env.LEGACY_DB || path.join(ROOT, 'app', 'data', 'learning.db');
const DRY = process.argv.includes('--dry');
const NO_BACKUP = process.argv.includes('--no-backup');
const reserved = new Set(['active', 'archived', 'staging']);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function legacyCourses() {
  if (!fs.existsSync(COURSES)) return [];
  return fs.readdirSync(COURSES).filter(slug => !reserved.has(slug) && !slug.startsWith('.')
    && fs.existsSync(path.join(COURSES, slug, 'meta.json'))).sort();
}

const slugs = legacyCourses();
if (!slugs.length) { console.log('沒有 legacy flat courses，無需遷移。'); process.exit(0); }
console.log(`將遷移 ${slugs.length} 門: ${slugs.join(', ')}`);
if (DRY) process.exit(0);

if (!NO_BACKUP) {
  const backupRoot = path.join(ROOT, 'app', 'data', 'backups', `course-bundles-${stamp}`);
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.cpSync(COURSES, path.join(backupRoot, 'courses'), { recursive: true,
    filter: src => !src.includes(`${path.sep}active${path.sep}`) && !src.includes(`${path.sep}archived${path.sep}`) });
  if (fs.existsSync(LEGACY_DB)) {
    const src = new DatabaseSync(LEGACY_DB);
    const out = path.join(backupRoot, 'learning.db').replaceAll("'", "''");
    src.exec(`VACUUM INTO '${out}'`); src.close();
  }
  console.log(`備份: ${backupRoot}`);
}

for (const dir of ['active', 'archived', 'staging']) fs.mkdirSync(path.join(COURSES, dir), { recursive: true });

// 先搬 filesystem。每門課先進隱藏 temp，完成後才 rename 成可發現 bundle。
for (const slug of slugs) {
  const old = path.join(COURSES, slug);
  const metaFile = path.join(old, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const lifecycle = meta.status === 'archived' ? 'archived' : (meta.status === 'generating' ? 'staging' : 'active');
  const parent = path.join(COURSES, lifecycle);
  const tmp = path.join(parent, `.${slug}.migrating-${process.pid}`);
  const dst = path.join(parent, slug);
  if (fs.existsSync(dst)) throw new Error(`destination exists: ${dst}`);
  fs.mkdirSync(tmp, { recursive: true });
  fs.renameSync(old, path.join(tmp, 'content'));
  fs.mkdirSync(path.join(tmp, 'state'));
  fs.writeFileSync(path.join(tmp, 'course.json'), JSON.stringify({
    schema: 1, id: slug, slug, createdAt: meta.created || new Date().toISOString().slice(0, 10),
  }, null, 2) + '\n');
  const cleanMeta = { ...meta };
  delete cleanMeta.status; delete cleanMeta.archivedAt;
  fs.writeFileSync(path.join(tmp, 'content', 'meta.json'), JSON.stringify(cleanMeta, null, 2) + '\n');
  if (meta.archivedAt) fs.writeFileSync(path.join(tmp, '.archived-at'), meta.archivedAt + '\n');
  fs.renameSync(tmp, dst);
  console.log(`filesystem: ${slug} → ${lifecycle}/${slug}`);
}

// require 必須發生在 filesystem 遷移後，module 才會定位到 bundle layout。
const store = require('../app/lib/db');
const legacy = fs.existsSync(LEGACY_DB) ? new DatabaseSync(LEGACY_DB, { readOnly: true }) : null;

const tables = [
  ['progress', ['unit', 'state', 'updated_at'], 'unit'],
  ['records', ['id', 'ts', 'unit', 'kind', 'note'], 'id'],
  ['selfcheck_attempts', ['id', 'ts', 'unit', 'question_id', 'answer', 'verdict', 'feedback'], 'id'],
  ['chat_sessions', ['id', 'unit', 'session_id', 'created_at', 'agent', 'model'], 'id'],
  ['chat_messages', ['id', 'ts', 'unit', 'session_id', 'role', 'content'], 'id'],
];

function hasTable(db, table) {
  return !!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

for (const slug of slugs) {
  const db = store.openCourse(slug);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (legacy) for (const [table, cols, orderBy] of tables) {
      if (!hasTable(legacy, table)) continue;
      const rows = legacy.prepare(`SELECT ${cols.join(',')} FROM ${table} WHERE course=? ORDER BY ${orderBy}`).all(slug);
      if (!rows.length) continue;
      const qs = cols.map(() => '?').join(',');
      const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${qs})`);
      for (const row of rows) stmt.run(...cols.map(c => row[c]));
    }
    const archivedFile = path.join(require('../app/lib/course-bundles').requireBundle(slug).dir, '.archived-at');
    if (fs.existsSync(archivedFile)) {
      db.prepare("INSERT OR REPLACE INTO state_meta(key,value) VALUES ('archived_at',?)")
        .run(fs.readFileSync(archivedFile, 'utf8').trim());
      fs.unlinkSync(archivedFile);
    }
    db.prepare("UPDATE state_meta SET value='1' WHERE key='revision'").run();
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  console.log(`state: ${slug} migrated`);
}
legacy?.close();
store.closeAll();
console.log('遷移完成；舊 app/data/learning.db 保留，待驗證後再移除。');
