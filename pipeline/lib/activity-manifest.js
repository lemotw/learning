// Activity manifest 共用讀寫／驗證工具。零依賴，供 course generators、verify 與 app 共用。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 1;
const KINDS = new Set(['exercise', 'lab', 'reading', 'drill', 'project']);
const ROLES = new Set(['anchor', 'practice', 'extension']);
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const RESOURCE_RE = /^[a-z0-9][a-z0-9._-]*:.+$/;
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const MUTABLE_FIELDS = new Set(['state', 'done', 'attempts', 'lastAttempt', 'reviewDueAt', 'updatedAt']);
const FIELDS = new Set(['id', 'resource', 'unit', 'kind', 'title', 'url', 'role', 'required', 'order', 'metadata']);

function manifestPath(input) {
  const p = path.resolve(input);
  if (p.endsWith('.json')) return p;
  return path.join(p, 'activities.json');
}

function loadManifest(input, { optional = false } = {}) {
  const file = manifestPath(input);
  if (!fs.existsSync(file)) {
    if (optional) return null;
    throw new Error(`activities manifest 不存在: ${file}`);
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`${file}: JSON 解析失敗: ${e.message}`); }
  return data;
}

function validateManifest(data, { contentDir = null, allowFragments = false } = {}) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['manifest 必須是 object'];
  const top = Object.keys(data);
  for (const k of top) if (!['schema', 'activities'].includes(k)) errors.push(`未知頂層欄位: ${k}`);
  if (data.schema !== SCHEMA) errors.push(`schema 必須是 ${SCHEMA}`);
  if (!Array.isArray(data.activities)) return [...errors, 'activities 必須是 array'];

  const ids = new Set();
  const unitOrder = new Map();
  data.activities.forEach((a, i) => {
    const at = `activities[${i}]`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) { errors.push(`${at} 必須是 object`); return; }
    for (const k of Object.keys(a)) {
      if (MUTABLE_FIELDS.has(k)) errors.push(`${at}.${k}: mutable state 不得寫進 manifest`);
      else if (!FIELDS.has(k)) errors.push(`${at}.${k}: 未知欄位`);
    }
    for (const k of ['id', 'resource', 'unit', 'kind', 'title', 'role', 'required', 'order']) {
      if (!(k in a)) errors.push(`${at}.${k}: 必填`);
    }
    if (!ID_RE.test(a.id || '')) errors.push(`${at}.id: 需符合 ${ID_RE}`);
    else if (ids.has(a.id)) errors.push(`${at}.id: 重複 ${a.id}`);
    else ids.add(a.id);
    if (!RESOURCE_RE.test(a.resource || '')) errors.push(`${at}.resource: 需為 namespace:value`);
    if (!UNIT_RE.test(a.unit || '')) errors.push(`${at}.unit: 不安全或不是 .md 檔名`);
    if (!KINDS.has(a.kind)) errors.push(`${at}.kind: 不支援 ${a.kind}`);
    if (typeof a.title !== 'string' || !a.title.trim()) errors.push(`${at}.title: 不可為空`);
    if (!ROLES.has(a.role)) errors.push(`${at}.role: 不支援 ${a.role}`);
    if (typeof a.required !== 'boolean') errors.push(`${at}.required: 必須是 boolean`);
    if (!Number.isInteger(a.order) || a.order < 0) errors.push(`${at}.order: 必須是非負整數`);
    if (a.url != null) {
      try { new URL(a.url); } catch { errors.push(`${at}.url: URL 無效`); }
    }
    if (a.metadata != null && (typeof a.metadata !== 'object' || Array.isArray(a.metadata))) {
      errors.push(`${at}.metadata: 必須是 object`);
    }
    if (contentDir && UNIT_RE.test(a.unit || '') && !fs.existsSync(path.join(contentDir, 'units', a.unit))) {
      errors.push(`${at}.unit: 找不到 units/${a.unit}`);
    }
    if (a.unit && Number.isInteger(a.order)) {
      const key = `${a.unit}\0${a.order}`;
      if (unitOrder.has(key)) errors.push(`${at}.order: 與 ${unitOrder.get(key)} 在同 unit 重複`);
      else unitOrder.set(key, a.id || at);
    }
  });
  if (!allowFragments && data.activities.length && !contentDir) {
    // 無 contentDir 時只跳過 dangling-unit 檢查，其餘仍完整驗證。
  }
  return errors;
}

function assertValid(data, options = {}) {
  const errors = validateManifest(data, options);
  if (errors.length) throw new Error('Activity manifest 驗證失敗:\n  - ' + errors.join('\n  - '));
  return data;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    out[key] = Array.isArray(v) ? [...new Set(v)] : v;
  }
  return out;
}

function normalizeManifest(data) {
  const activities = (data.activities || []).map(a => {
    const out = {};
    for (const key of ['id', 'resource', 'unit', 'kind', 'title', 'url', 'role', 'required', 'order', 'metadata']) {
      if (a[key] === undefined) continue;
      out[key] = key === 'metadata' ? normalizeMetadata(a[key]) : a[key];
    }
    return out;
  }).sort((a, b) => a.unit.localeCompare(b.unit) || a.order - b.order || a.id.localeCompare(b.id));
  return { schema: SCHEMA, activities };
}

function writeManifestAtomic(input, data) {
  const file = manifestPath(input);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(normalizeManifest(data), null, 2) + '\n';
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

function mergeFragments(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const activities = [];
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (Array.isArray(data)) activities.push(...data);
    else if (Array.isArray(data.activities)) activities.push(...data.activities);
    else throw new Error(`${file}: fragment 必須是 array 或含 activities array`);
  }
  return { schema: SCHEMA, activities };
}

function diffManifests(before, after) {
  const b = new Map((before?.activities || []).map(a => [a.id, a]));
  const a = new Map((after?.activities || []).map(x => [x.id, x]));
  const added = [...a.keys()].filter(id => !b.has(id));
  const removed = [...b.keys()].filter(id => !a.has(id));
  const changed = [...a.keys()].filter(id => b.has(id)
    && JSON.stringify(normalizeManifest({ activities: [b.get(id)] }).activities[0])
      !== JSON.stringify(normalizeManifest({ activities: [a.get(id)] }).activities[0]));
  const probableRenames = [];
  for (const oldId of removed) for (const newId of added) {
    if (b.get(oldId).resource === a.get(newId).resource) probableRenames.push({ from: oldId, to: newId, resource: a.get(newId).resource });
  }
  return { added, removed, changed, probableRenames };
}

module.exports = {
  SCHEMA, KINDS, ROLES, MUTABLE_FIELDS, manifestPath, loadManifest,
  validateManifest, assertValid, normalizeManifest, writeManifestAtomic,
  mergeFragments, diffManifests,
};
