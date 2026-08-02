// 封存課程的來源搜尋。資料只存在記憶體 snapshot，courses/ 永遠是唯一真相。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const content = require('./content');

const MAX_FILE_BYTES = 1_500_000;
const cache = new Map(); // slug -> { fingerprint, docs }

function stripMarkdown(source) {
  return String(source || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, m => m.replace(/^```\w*|```$/gm, ' '))
    .replace(/!?(\[[^\]]*\])\([^)]*\)/g, '$1')
    .replace(/[`*_>#|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fileState(file) {
  try {
    const st = fs.statSync(file);
    return `${path.basename(file)}:${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch { return `${path.basename(file)}:missing`; }
}

function fingerprint(course) {
  const dir = course.contentDir || content.courseInfo(course.slug).contentDir;
  const files = [path.join(dir, 'meta.json'), path.join(dir, 'AGENDA.md')];
  const units = path.join(dir, 'units');
  try {
    for (const file of fs.readdirSync(units).filter(f => f.endsWith('.md')).sort()) {
      files.push(path.join(units, file));
    }
  } catch { /* malformed archive has no units; meta / agenda still searchable */ }
  return files.map(fileState).join('|');
}

function readSmall(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch { return ''; }
}

function buildCourse(course, fp) {
  const dir = course.contentDir || content.courseInfo(course.slug).contentDir;
  const docs = [];
  const metaText = [course.meta.title || course.slug, ...(course.meta.tags || []),
    ...(course.meta.concepts || []).flatMap(c => [c && c.name, c && c.desc])]
    .filter(Boolean).join(' ');
  if (metaText) docs.push({
    course: course.slug, courseTitle: course.meta.title || course.slug,
    kind: 'course', title: course.meta.title || course.slug, unit: null, text: metaText,
  });

  const agenda = readSmall(path.join(dir, 'AGENDA.md'));
  if (agenda) docs.push({
    course: course.slug, courseTitle: course.meta.title || course.slug,
    kind: 'agenda', title: '課綱', unit: null, text: stripMarkdown(agenda),
  });

  for (const unit of course.units) {
    const raw = readSmall(path.join(dir, 'units', unit.file));
    if (!raw) continue;
    docs.push({
      course: course.slug, courseTitle: course.meta.title || course.slug,
      kind: 'unit', title: unit.title, unit: unit.file, text: stripMarkdown(raw),
    });
  }
  cache.set(course.slug, { fingerprint: fp, docs });
}

function sync(archivedCourses) {
  const live = new Set(archivedCourses.map(c => c.slug));
  for (const slug of cache.keys()) if (!live.has(slug)) cache.delete(slug);
  for (const course of archivedCourses) {
    const fp = fingerprint(course);
    if (cache.get(course.slug)?.fingerprint !== fp) buildCourse(course, fp);
  }
}

function normalizeQuery(query) {
  return String(query || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function countHits(text, term) {
  let at = 0, count = 0;
  while ((at = text.indexOf(term, at)) >= 0) { count++; at += term.length; }
  return count;
}

function excerpt(text, terms) {
  const lower = text.toLocaleLowerCase();
  const positions = terms.map(t => lower.indexOf(t)).filter(i => i >= 0);
  const at = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, at - 72);
  const end = Math.min(text.length, at + 180);
  return (start ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/** 回傳 plain text；前端一律 escape，避免 course markdown 變成 HTML 注入。 */
function search(archivedCourses, query, limit = 30) {
  const q = normalizeQuery(query);
  if (q.length < 2) return [];
  const terms = q.split(' ').filter(Boolean);
  sync(archivedCourses);
  const out = [];
  for (const { docs } of cache.values()) {
    for (const doc of docs) {
      const title = doc.title.toLocaleLowerCase();
      const text = doc.text.toLocaleLowerCase();
      if (!terms.every(term => title.includes(term) || text.includes(term))) continue;
      const titleScore = terms.reduce((n, term) => n + (title.includes(term) ? 100 : 0), 0);
      const bodyScore = terms.reduce((n, term) => n + Math.min(countHits(text, term), 12), 0);
      out.push({ ...doc, score: titleScore + bodyScore, excerpt: excerpt(doc.text, terms) });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.courseTitle.localeCompare(b.courseTitle, 'zh-Hant'))
    .slice(0, Math.max(1, Math.min(Number(limit) || 30, 50)));
}

module.exports = { stripMarkdown, fingerprint, search, sync };
