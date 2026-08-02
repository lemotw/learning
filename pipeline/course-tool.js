#!/usr/bin/env node
// Course bundle generation helper: init staging / activate / update-content。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const bundles = require('../app/lib/course-bundles');

const [cmd, slug] = process.argv.slice(2);
if (!cmd || !slug) {
  console.error('usage: node pipeline/course-tool.js <init|activate|update-content> <slug>');
  process.exit(2);
}
bundles.assertSlug(slug);
bundles.ensureRoots();
const staging = path.join(bundles.STAGING_ROOT, slug);
const active = path.join(bundles.ACTIVE_ROOT, slug);

function refreshIndex() {
  try {
    const index = require('../app/lib/global-index');
    index.reindexCourse(slug);
    index.db.close();
  } catch (e) { console.error(`⚠ global index 將由下次 reconcile 修復: ${e.message}`); }
}

function verify() {
  const r = spawnSync(path.join(ROOT, 'pipeline', 'verify.sh'), [slug], {
    cwd: ROOT, env: { ...process.env, COURSE_CONTENT_DIR: path.join(staging, 'content') },
    stdio: 'inherit', shell: false,
  });
  if (r.status !== 0) throw new Error('course verify failed');
}

try {
  if (cmd === 'init') {
    if (fs.existsSync(staging)) throw new Error(`staging course already exists: ${slug}`);
    const mounted = bundles.locate(slug);
    if (mounted?.status === 'archived') throw new Error(`archived course must be restored before update: ${slug}`);
    fs.mkdirSync(path.join(staging, 'content', 'units'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'content', 'labs'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'state'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'course.json'), JSON.stringify(mounted?.identity || {
      schema: 1, id: slug, slug, createdAt: new Date().toISOString(),
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(staging, 'content', 'activities.json'), '{\n  "schema": 1,\n  "activities": []\n}\n');
    console.log(staging);
  } else if (cmd === 'activate') {
    if (!fs.existsSync(staging)) throw new Error(`staging course not found: ${slug}`);
    if (fs.existsSync(active)) throw new Error(`active course already exists: ${slug}`);
    verify();
    fs.renameSync(staging, active);
    refreshIndex();
    console.log(`activated ${slug}`);
  } else if (cmd === 'update-content') {
    if (!fs.existsSync(staging)) throw new Error(`staging course not found: ${slug}`);
    if (!fs.existsSync(active)) throw new Error(`active course not found: ${slug}`);
    verify();
    const current = path.join(active, 'content');
    const incoming = path.join(staging, 'content');
    const old = path.join(active, `.content-old-${process.pid}-${Date.now()}`);
    fs.renameSync(current, old);
    try {
      fs.renameSync(incoming, current);
      fs.rmSync(old, { recursive: true, force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (e) {
      if (!fs.existsSync(current) && fs.existsSync(old)) fs.renameSync(old, current);
      throw e;
    }
    refreshIndex();
    console.log(`updated content ${slug}; state preserved`);
  } else throw new Error(`unknown command: ${cmd}`);
} catch (e) {
  console.error('✗ ' + e.message);
  process.exit(1);
}
