// Course-local view manifest 驗證。View 是 content plugin；mutable state 仍只能走 host Activity API。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 1;
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const FIELDS = new Set(['id', 'title', 'entry', 'data', 'height']);

function manifestPath(input) {
  const p = path.resolve(input);
  return p.endsWith('.json') ? p : path.join(p, 'views.json');
}

function loadManifest(input, { optional = false } = {}) {
  const file = manifestPath(input);
  if (!fs.existsSync(file)) {
    if (optional) return null;
    throw new Error(`view manifest 不存在: ${file}`);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`${file}: JSON 解析失敗: ${e.message}`); }
}

function safeRelative(value, ext) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) return false;
  if (ext && path.posix.extname(value) !== ext) return false;
  return value.split('/').every(seg => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(seg));
}

function validateManifest(data, { contentDir = null } = {}) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['manifest 必須是 object'];
  for (const key of Object.keys(data)) if (!['schema', 'courseDrawer', 'views'].includes(key)) errors.push(`未知頂層欄位: ${key}`);
  if (data.schema !== SCHEMA) errors.push(`schema 必須是 ${SCHEMA}`);
  if (!Array.isArray(data.views)) return [...errors, 'views 必須是 array'];

  const ids = new Set();
  data.views.forEach((view, i) => {
    const at = `views[${i}]`;
    if (!view || typeof view !== 'object' || Array.isArray(view)) { errors.push(`${at} 必須是 object`); return; }
    for (const key of Object.keys(view)) if (!FIELDS.has(key)) errors.push(`${at}.${key}: 未知欄位`);
    for (const key of ['id', 'title', 'entry']) if (!(key in view)) errors.push(`${at}.${key}: 必填`);
    if (!ID_RE.test(view.id || '')) errors.push(`${at}.id: 需符合 ${ID_RE}`);
    else if (ids.has(view.id)) errors.push(`${at}.id: 重複 ${view.id}`);
    else ids.add(view.id);
    if (typeof view.title !== 'string' || !view.title.trim()) errors.push(`${at}.title: 不可為空`);
    if (!safeRelative(view.entry, '.html')) errors.push(`${at}.entry: 必須是安全的相對 .html 路徑`);
    if (view.data != null && !safeRelative(view.data, '.json')) errors.push(`${at}.data: 必須是安全的相對 .json 路徑`);
    if (view.height != null && (!Number.isInteger(view.height) || view.height < 240 || view.height > 1600)) {
      errors.push(`${at}.height: 必須是 240–1600 的整數`);
    }
    if (contentDir && safeRelative(view.entry, '.html') && !fs.existsSync(path.join(contentDir, view.entry))) {
      errors.push(`${at}.entry: 找不到 ${view.entry}`);
    }
    if (contentDir && view.data && safeRelative(view.data, '.json')) {
      const file = path.join(contentDir, view.data);
      if (!fs.existsSync(file)) errors.push(`${at}.data: 找不到 ${view.data}`);
      else try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { errors.push(`${at}.data: JSON 解析失敗: ${e.message}`); }
    }
  });
  if (data.courseDrawer != null) {
    if (!ID_RE.test(data.courseDrawer)) errors.push(`courseDrawer: 需符合 ${ID_RE}`);
    else if (!ids.has(data.courseDrawer)) errors.push(`courseDrawer: 找不到 view ${data.courseDrawer}`);
  }
  return errors;
}

function assertValid(data, options = {}) {
  const errors = validateManifest(data, options);
  if (errors.length) throw new Error('View manifest 驗證失敗:\n  - ' + errors.join('\n  - '));
  return data;
}

function parseDirective(source) {
  const text = String(source || '').trim();
  if (!text) throw new Error('view directive 不可為空');
  let config;
  if (text.startsWith('{')) {
    try { config = JSON.parse(text); } catch (e) { throw new Error(`view directive JSON 無效: ${e.message}`); }
    for (const key of Object.keys(config)) if (!['id', 'view'].includes(key)) throw new Error(`view directive 未知欄位: ${key}`);
    config = { id: config.id || config.view };
  } else config = { id: text };
  if (!ID_RE.test(config.id || '')) throw new Error(`view id 無效: ${config.id || ''}`);
  return config;
}

function normalizeManifest(data) {
  const out = {
    schema: SCHEMA,
    views: (data.views || []).map(view => {
      const out = {};
      for (const key of ['id', 'title', 'entry', 'data', 'height']) if (view[key] !== undefined) out[key] = view[key];
      return out;
    }).sort((a, b) => a.id.localeCompare(b.id)),
  };
  if (data.courseDrawer) out.courseDrawer = data.courseDrawer;
  return out;
}

module.exports = {
  SCHEMA, ID_RE, safeRelative, manifestPath, loadManifest, validateManifest, assertValid, parseDirective, normalizeManifest,
};
