#!/usr/bin/env node
// Activity manifest CLI: init / validate / format / merge / diff
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const A = require('./lib/activity-manifest');

function usage() {
  console.error(`usage:
  node pipeline/activity-tool.js init <content-dir>
  node pipeline/activity-tool.js validate <content-dir|activities.json>
  node pipeline/activity-tool.js format <content-dir|activities.json>
  node pipeline/activity-tool.js merge <fragments-dir> --out <activities.json> [--content <content-dir>]
  node pipeline/activity-tool.js diff <before.json> <after.json>`);
  process.exit(2);
}

const args = process.argv.slice(2);
const cmd = args.shift();
const option = name => {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return null;
  return args[i + 1];
};

try {
  if (cmd === 'init') {
    if (!args[0]) usage();
    const file = A.manifestPath(args[0]);
    if (fs.existsSync(file)) throw new Error(`不覆寫既有 manifest: ${file}`);
    A.writeManifestAtomic(file, { schema: 1, activities: [] });
    console.log(`created ${file}`);
  } else if (cmd === 'validate') {
    if (!args[0]) usage();
    const file = A.manifestPath(args[0]);
    const contentDir = file.endsWith(path.join('', 'activities.json')) ? path.dirname(file) : null;
    const data = A.loadManifest(file);
    A.assertValid(data, { contentDir });
    console.log(`OK ${file}: ${data.activities.length} activities`);
  } else if (cmd === 'format') {
    if (!args[0]) usage();
    const file = A.manifestPath(args[0]);
    const data = A.loadManifest(file);
    A.assertValid(data, { contentDir: path.dirname(file) });
    A.writeManifestAtomic(file, data);
    console.log(`formatted ${file}`);
  } else if (cmd === 'merge') {
    if (!args[0] || !option('--out')) usage();
    const data = A.mergeFragments(path.resolve(args[0]));
    const contentDir = option('--content') ? path.resolve(option('--content')) : path.dirname(path.resolve(option('--out')));
    A.assertValid(data, { contentDir });
    A.writeManifestAtomic(path.resolve(option('--out')), data);
    console.log(`merged ${data.activities.length} activities → ${path.resolve(option('--out'))}`);
  } else if (cmd === 'diff') {
    if (!args[0] || !args[1]) usage();
    const before = A.loadManifest(args[0]);
    const after = A.loadManifest(args[1]);
    const d = A.diffManifests(before, after);
    console.log(`新增 ${d.added.length}: ${d.added.join(', ') || '—'}`);
    console.log(`修改 ${d.changed.length}: ${d.changed.join(', ') || '—'}`);
    console.log(`移除 ${d.removed.length}: ${d.removed.join(', ') || '—'}`);
    for (const r of d.probableRenames) console.log(`⚠ 疑似 ID 更名 ${r.from} → ${r.to} (${r.resource})`);
    if (d.probableRenames.length) process.exitCode = 1;
  } else usage();
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
