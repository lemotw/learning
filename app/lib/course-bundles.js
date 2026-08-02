// Course bundle filesystem locator。生命週期以 active/archived 目錄為真相；遷移期相容舊 flat layout。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.COURSES_ROOT || path.join(__dirname, '..', '..', 'courses');
const ACTIVE_ROOT = path.join(ROOT, 'active');
const ARCHIVED_ROOT = path.join(ROOT, 'archived');
const STAGING_ROOT = path.join(ROOT, 'staging');
const RESERVED = new Set(['active', 'archived', 'staging']);
const SAFE_SEG = /^[\w][\w.-]*$/;

function assertSlug(slug) {
  if (!SAFE_SEG.test(slug || '')) throw Object.assign(new Error(`bad course slug: ${slug}`), { status: 400 });
  return slug;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isDir(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function bundleAt(dir, slug, status, layout) {
  const contentDir = layout === 'bundle' ? path.join(dir, 'content') : dir;
  const stateDir = layout === 'bundle' ? path.join(dir, 'state') : path.join(dir, '.learning');
  if (!fs.existsSync(path.join(contentDir, 'meta.json'))) return null;
  const identity = layout === 'bundle' ? readJson(path.join(dir, 'course.json')) : null;
  return {
    slug,
    id: identity?.id || slug,
    status,
    layout,
    dir,
    contentDir,
    stateDir,
    identity: identity || { schema: 1, id: slug, slug },
  };
}

function locate(slug) {
  assertSlug(slug);
  const active = bundleAt(path.join(ACTIVE_ROOT, slug), slug, 'active', 'bundle');
  const archived = bundleAt(path.join(ARCHIVED_ROOT, slug), slug, 'archived', 'bundle');
  const staging = bundleAt(path.join(STAGING_ROOT, slug), slug, 'generating', 'bundle');
  if (active && archived) throw Object.assign(new Error(`duplicate course bundle: ${slug}`), { status: 500 });
  // Active/archived 是掛載中的真相；同 slug staging 可同時存在，供安全 content update。
  if (active || archived) return active || archived;
  if (staging) return staging;

  // 遷移期相容 courses/<slug>/meta.json；最終 migration 完成後不再產生這種 layout。
  const legacyDir = path.join(ROOT, slug);
  const meta = readJson(path.join(legacyDir, 'meta.json'));
  if (meta) return bundleAt(legacyDir, slug, meta.status === 'archived' ? 'archived' : 'active', 'legacy');
  return null;
}

function list({ status } = {}) {
  const out = [];
  const seen = new Set();
  const addRoot = (root, lifecycle) => {
    if (!isDir(root)) return;
    for (const slug of fs.readdirSync(root).sort()) {
      if (slug.startsWith('.') || slug.startsWith('_') || !SAFE_SEG.test(slug)) continue;
      const b = bundleAt(path.join(root, slug), slug, lifecycle, 'bundle');
      if (!b) continue;
      if (seen.has(slug)) throw new Error(`duplicate course bundle: ${slug}`);
      seen.add(slug); out.push(b);
    }
  };
  addRoot(ACTIVE_ROOT, 'active');
  addRoot(ARCHIVED_ROOT, 'archived');

  // Legacy flat courses coexist only during migration.
  if (isDir(ROOT)) for (const slug of fs.readdirSync(ROOT).sort()) {
    if (RESERVED.has(slug) || slug.startsWith('.') || slug.startsWith('_') || !SAFE_SEG.test(slug) || seen.has(slug)) continue;
    const dir = path.join(ROOT, slug);
    const meta = readJson(path.join(dir, 'meta.json'));
    if (!meta) continue;
    const b = bundleAt(dir, slug, meta.status === 'archived' ? 'archived' : 'active', 'legacy');
    if (b) { seen.add(slug); out.push(b); }
  }
  return status ? out.filter(b => b.status === status) : out;
}

function requireBundle(slug) {
  const b = locate(slug);
  if (!b) throw Object.assign(new Error('course not found'), { status: 404 });
  return b;
}

function ensureRoots() {
  for (const dir of [ACTIVE_ROOT, ARCHIVED_ROOT, STAGING_ROOT]) fs.mkdirSync(dir, { recursive: true });
}

function stateFile(slug) {
  return path.join(requireBundle(slug).stateDir, 'state.sqlite');
}

function contentPath(slug, ...segments) {
  const b = requireBundle(slug);
  for (const s of segments) if (!SAFE_SEG.test(s)) throw Object.assign(new Error(`bad path segment: ${s}`), { status: 400 });
  return path.join(b.contentDir, ...segments);
}

module.exports = {
  ROOT, ACTIVE_ROOT, ARCHIVED_ROOT, STAGING_ROOT, SAFE_SEG,
  assertSlug, locate, list, requireBundle, ensureRoots, stateFile, contentPath,
};
