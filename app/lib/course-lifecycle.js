// 課程生命週期唯一寫入邊界：封存只改 meta.status，永不搬移或刪除 course source。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const content = require('./content');

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

/**
 * 包住會 await 的課程寫入工作（助教 / 批改）。
 * 封存時拒絕 busy 課，避免 CLI 回來後把資料寫進剛轉成唯讀的課程。
 */
function beginActiveOperation(slug) {
  requireActive(slug);
  inFlight.set(slug, (inFlight.get(slug) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (inFlight.get(slug) || 1) - 1;
    if (next > 0) inFlight.set(slug, next);
    else inFlight.delete(slug);
  };
}

function isBusy(slug) {
  return (inFlight.get(slug) || 0) > 0;
}

function writeMetaAtomic(slug, meta) {
  const file = content.metaPath(slug);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.meta-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  const mode = fs.statSync(file).mode & 0o777;
  try {
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', { mode });
    fs.renameSync(tmp, file);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function transition(slug, from, to) {
  const info = content.courseInfo(slug);
  if (info.status !== from) {
    throw lifecycleError(
      from === 'active' ? 'course is not active' : 'course is not archived',
      409,
      from === 'active' ? 'course_not_active' : 'course_not_archived'
    );
  }
  if (isBusy(slug)) throw lifecycleError('course is busy', 409, 'course_busy');

  // 保留 concepts / relations / migratedFrom 等未知欄位；只更新 lifecycle metadata。
  const meta = { ...info.meta, status: to };
  if (to === 'archived') meta.archivedAt = new Date().toISOString();
  else delete meta.archivedAt;
  writeMetaAtomic(slug, meta);
  return { slug, title: meta.title || slug, status: to, archivedAt: meta.archivedAt || null };
}

function archive(slug) {
  return transition(slug, 'active', 'archived');
}

function restore(slug) {
  return transition(slug, 'archived', 'active');
}

module.exports = {
  requireActive,
  beginActiveOperation,
  isBusy,
  archive,
  restore,
  writeMetaAtomic,
};
