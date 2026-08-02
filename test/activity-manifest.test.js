'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const A = require('../pipeline/lib/activity-manifest');

function sample(id = 'arrays-two-sum') {
  return { schema: 1, activities: [{
    id, resource: 'leetcode:two-sum', unit: '01-arrays.md', kind: 'exercise',
    title: 'Two Sum', url: 'https://leetcode.com/problems/two-sum/',
    role: 'anchor', required: true, order: 10, metadata: { concepts: ['hash', 'hash'] },
  }] };
}

test('activity manifest validates references and rejects mutable state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activities-'));
  fs.mkdirSync(path.join(dir, 'units'));
  fs.writeFileSync(path.join(dir, 'units', '01-arrays.md'), '# unit\n');
  assert.deepEqual(A.validateManifest(sample(), { contentDir: dir }), []);
  const bad = sample(); bad.activities[0].state = 'done';
  assert.match(A.validateManifest(bad, { contentDir: dir }).join('\n'), /mutable state/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalize/write is deterministic and diff catches probable id rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activities-'));
  const file = path.join(dir, 'activities.json');
  A.writeManifestAtomic(file, sample());
  const first = fs.readFileSync(file, 'utf8');
  A.writeManifestAtomic(file, A.loadManifest(file));
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert.deepEqual(A.loadManifest(file).activities[0].metadata.concepts, ['hash']);
  const renamed = sample('hash-two-sum');
  const d = A.diffManifests(sample(), renamed);
  assert.deepEqual(d.probableRenames, [{ from: 'arrays-two-sum', to: 'hash-two-sum', resource: 'leetcode:two-sum' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
