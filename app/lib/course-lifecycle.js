// Course lifecycle 唯一寫入邊界：bundle layout 以 active/archived atomic rename 表達生命週期。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const content = require('./content');
const bundles = require('./course-bundles');
const store = require('./db');

const inFlight = new Map();

function lifecycleError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function requireActive(slug) {
  const info = content.courseInfo(slug);
  if (info.status === 'archived') throw lifecycleError('course is archived', 409, 'course_archived');
  if (info.status !== 'active') throw lifecycleError('course is not active', 409, 'course_not_active');
  return info;
}

function beginActiveOperation(slug) {
  requireActive(slug);
  inFlight.set(slug, (inFlight.get(slug) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (inFlight.get(slug) || 1) - 1;
    if (next > 0) inFlight.set(slug, next); else inFlight.delete(slug);
  };
}

function isBusy(slug) { return (inFlight.get(slug) || 0) > 0; }

// 僅供 legacy flat layout 遷移相容；bundle content 一般流程永遠唯讀。
function writeMetaAtomic(slug, meta) {
  const file = content.metaPath(slug);
  const tmp = path.join(path.dirname(file), `.meta-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  const mode = fs.statSync(file).mode & 0o777;
  try {
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', { mode });
    fs.renameSync(tmp, file);
  } finally { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {} }
}

function transition(slug, from, to) {
  const info = content.courseInfo(slug);
  if (info.status !== from) throw lifecycleError(
    from === 'active' ? 'course is not active' : 'course is not archived', 409,
    from === 'active' ? 'course_not_active' : 'course_not_archived');
  if (isBusy(slug)) throw lifecycleError('course is busy', 409, 'course_busy');

  const archivedAt = to === 'archived' ? new Date().toISOString() : null;
  if (info.bundle.layout === 'legacy') {
    const meta = { ...info.meta, status: to };
    if (archivedAt) meta.archivedAt = archivedAt; else delete meta.archivedAt;
    writeMetaAtomic(slug, meta);
    return { slug, title: meta.title || slug, status: to, archivedAt };
  }

  store.setStateMeta(slug, 'archived_at', archivedAt || '');
  store.closeCourse(slug); // checkpoint WAL 後才能安全搬整個 bundle
  bundles.ensureRoots();
  const src = info.bundle.dir;
  const dstRoot = to === 'archived' ? bundles.ARCHIVED_ROOT : bundles.ACTIVE_ROOT;
  const dst = path.join(dstRoot, slug);
  if (fs.existsSync(dst)) throw lifecycleError('destination course already exists', 409, 'course_destination_exists');
  try { fs.renameSync(src, dst); }
  catch (e) { throw lifecycleError(`course move failed: ${e.message}`, 500, 'course_move_failed'); }
  return { slug, title: info.meta.title || slug, status: to, archivedAt };
}

const archive = slug => transition(slug, 'active', 'archived');
const restore = slug => transition(slug, 'archived', 'active');

module.exports = { requireActive, beginActiveOperation, isBusy, archive, restore, writeMetaAtomic };
