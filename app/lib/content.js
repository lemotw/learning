// Course bundle 內容掃描與解析。content/ 唯讀；state/ 由 db.js 管理。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const bundles = require('./course-bundles');
const activityManifest = require('../../pipeline/lib/activity-manifest');
const viewManifest = require('../../pipeline/lib/view-manifest');

const COURSES_ROOT = bundles.ROOT;
const SAFE_SEG = bundles.SAFE_SEG;
const COURSE_STATUSES = new Set(['generating', 'active', 'archived']);

function safeJoin(slug, ...segs) {
  return bundles.contentPath(slug, ...segs);
}

function metaPath(slug) {
  return safeJoin(slug, 'meta.json');
}

function readMeta(slug) {
  const b = bundles.locate(slug);
  if (!b) return null;
  try { return JSON.parse(fs.readFileSync(path.join(b.contentDir, 'meta.json'), 'utf8')); } catch { return null; }
}

// Bundle layout 以所在目錄為 lifecycle 真相；legacy flat layout 才讀舊 meta.status。
function courseStatus(meta, bundle = null) {
  if (bundle) return bundle.status;
  return meta && COURSE_STATUSES.has(meta.status) ? meta.status : 'active';
}

function courseInfo(slug) {
  const bundle = bundles.locate(slug);
  if (!bundle) throw Object.assign(new Error('course not found'), { status: 404 });
  const meta = readMeta(slug);
  if (!meta) throw Object.assign(new Error('course metadata malformed'), { status: 500 });
  return { slug, id: bundle.id, meta, status: bundle.status, bundle, contentDir: bundle.contentDir };
}

function unitTitle(md) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function listUnits(slug) {
  const dir = safeJoin(slug, 'units');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(file => {
    const md = fs.readFileSync(path.join(dir, file), 'utf8');
    return { file, title: unitTitle(md) || file };
  });
}

function listCourses({ status } = {}) {
  const wanted = status ? new Set(Array.isArray(status) ? status : [status]) : null;
  return bundles.list().filter(b => !wanted || wanted.has(b.status)).map(bundle => {
    const meta = readMeta(bundle.slug);
    if (!meta) return null;
    return {
      slug: bundle.slug, id: bundle.id, meta, status: bundle.status,
      bundle, contentDir: bundle.contentDir, units: listUnits(bundle.slug),
    };
  }).filter(Boolean);
}

// 自答題約定:<!-- qN keywords: a, b, c --> 的下一個非空行是題目
const Q_RE = /<!--\s*(q[\w-]*)\s+keywords:\s*([^>]*?)\s*-->\s*\n\s*(.+)/g;

function parseQuestions(md) {
  const out = [];
  for (const m of md.matchAll(Q_RE)) {
    out.push({
      id: m[1],
      keywords: m[2].split(/[,、]/).map(s => s.trim()).filter(Boolean),
      question: m[3].trim().replace(/^\*\*|\*\*$/g, ''),
    });
  }
  return out;
}

function readUnit(slug, file) {
  const p = safeJoin(slug, 'units', file);
  if (!fs.existsSync(p)) throw Object.assign(new Error('unit not found'), { status: 404 });
  const raw = fs.readFileSync(p, 'utf8');
  const questions = parseQuestions(raw);
  const md = raw.replace(/<!--\s*q[\w-]*\s+keywords:[^>]*-->\s*\n/g, '');
  return { raw, md, questions };
}

function readCourseFile(slug, name) {
  const p = safeJoin(slug, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function readActivities(slug) {
  const { contentDir } = courseInfo(slug);
  const data = activityManifest.loadManifest(contentDir, { optional: true });
  if (!data) return [];
  activityManifest.assertValid(data, { contentDir });
  return activityManifest.normalizeManifest(data).activities;
}

function readViews(slug) {
  const { contentDir } = courseInfo(slug);
  const data = viewManifest.loadManifest(contentDir, { optional: true });
  if (!data) return { schema: 1, views: [] };
  viewManifest.assertValid(data, { contentDir });
  return viewManifest.normalizeManifest(data);
}

function readView(slug, id) {
  if (!viewManifest.ID_RE.test(id || '')) throw Object.assign(new Error('bad view id'), { status: 400 });
  const view = readViews(slug).views.find(v => v.id === id);
  if (!view) throw Object.assign(new Error('view not found'), { status: 404 });
  return view;
}

function readViewEntry(slug, id) {
  const info = courseInfo(slug), view = readView(slug, id);
  return { view, file: path.join(info.contentDir, view.entry) };
}

function readViewData(slug, id) {
  const info = courseInfo(slug), view = readView(slug, id);
  if (!view.data) return null;
  return JSON.parse(fs.readFileSync(path.join(info.contentDir, view.data), 'utf8'));
}

function contentFingerprint(slug) {
  const { contentDir } = courseInfo(slug);
  const files = [];
  for (const name of ['meta.json', 'AGENDA.md', 'activities.json', 'views.json']) {
    const p = path.join(contentDir, name); if (fs.existsSync(p)) files.push(p);
  }
  const units = path.join(contentDir, 'units');
  if (fs.existsSync(units)) for (const name of fs.readdirSync(units).filter(x => x.endsWith('.md')).sort()) files.push(path.join(units, name));
  const viewsDir = path.join(contentDir, 'views');
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(file); else if (ent.isFile()) files.push(file);
    }
  };
  walk(viewsDir);
  try {
    const manifest = viewManifest.loadManifest(contentDir, { optional: true });
    for (const view of manifest?.views || []) {
      if (!viewManifest.safeRelative(view.data, '.json')) continue;
      const file = path.join(contentDir, view.data);
      if (fs.existsSync(file) && !files.includes(file)) files.push(file);
    }
  } catch { /* malformed manifest 會由 verify/readViews 報錯 */ }
  files.sort();
  return files.map(file => {
    const st = fs.statSync(file);
    return `${path.relative(contentDir, file)}:${st.size}:${Math.floor(st.mtimeMs)}`;
  }).join('|');
}

module.exports = {
  COURSES_ROOT, SAFE_SEG, COURSE_STATUSES, safeJoin, metaPath,
  courseStatus, courseInfo, listCourses, readMeta, listUnits, readUnit, readCourseFile,
  parseQuestions, readActivities, readViews, readView, readViewEntry, readViewData, contentFingerprint,
};
