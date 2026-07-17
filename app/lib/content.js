// 課程內容掃描與解析 — courses/ 目錄唯讀,meta.json + units/*.md
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const COURSES_ROOT = process.env.COURSES_ROOT
  || path.join(__dirname, '..', '..', 'courses');

const SAFE_SEG = /^[\w][\w.-]*$/; // slug 與檔名白名單,擋路徑跳脫

function safeJoin(...segs) {
  for (const s of segs) {
    if (!SAFE_SEG.test(s)) throw Object.assign(new Error(`bad path segment: ${s}`), { status: 400 });
  }
  return path.join(COURSES_ROOT, ...segs);
}

function readMeta(slug) {
  const p = path.join(COURSES_ROOT, slug, 'meta.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function unitTitle(md) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function listUnits(slug) {
  const dir = path.join(COURSES_ROOT, slug, 'units');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(file => {
    const md = fs.readFileSync(path.join(dir, file), 'utf8');
    return { file, title: unitTitle(md) || file };
  });
}

function listCourses() {
  if (!fs.existsSync(COURSES_ROOT)) return [];
  return fs.readdirSync(COURSES_ROOT)
    .filter(d => !d.startsWith('.') && !d.startsWith('_'))
    .map(slug => {
      const meta = readMeta(slug);
      if (!meta) return null;
      return { slug, meta, units: listUnits(slug) };
    })
    .filter(Boolean);
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
  // 送前端的版本剝掉 keywords 註解(作答前不給看)
  const md = raw.replace(/<!--\s*q[\w-]*\s+keywords:[^>]*-->\s*\n/g, '');
  return { raw, md, questions };
}

function readCourseFile(slug, name) {
  const p = safeJoin(slug, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

module.exports = { COURSES_ROOT, listCourses, readMeta, listUnits, readUnit, readCourseFile, parseQuestions };
