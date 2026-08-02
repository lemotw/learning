'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-index-'));
process.env.COURSES_ROOT = path.join(root, 'courses');
process.env.LEARNING_DATA_ROOT = path.join(root, 'data');
process.env.GLOBAL_INDEX_FILE = path.join(root, 'data', 'global-index.sqlite');

const contentDir = path.join(process.env.COURSES_ROOT, 'active', 'algo', 'content');
fs.mkdirSync(path.join(contentDir, 'units'), { recursive: true });
fs.mkdirSync(path.join(process.env.COURSES_ROOT, 'active', 'algo', 'state'), { recursive: true });
fs.writeFileSync(path.join(process.env.COURSES_ROOT, 'active', 'algo', 'course.json'), JSON.stringify({ schema: 1, id: 'algo', slug: 'algo' }));
fs.writeFileSync(path.join(contentDir, 'meta.json'), JSON.stringify({ title: 'Algo', tags: [], concepts: [], relations: [] }));
fs.writeFileSync(path.join(contentDir, 'AGENDA.md'), '# agenda\n');
fs.writeFileSync(path.join(contentDir, 'DIAGNOSTIC.md'), '# diagnostic\n');
fs.writeFileSync(path.join(contentDir, 'units', '01.md'), '# Unit 1:One\n\n## Lab\n\nDo.\n\n## 自答題\n\n<!-- q1 keywords: a -->\n**Q1:A?**\n');
fs.writeFileSync(path.join(contentDir, 'activities.json'), JSON.stringify({ schema: 1, activities: [{
  id: 'two-sum', resource: 'leetcode:two-sum', unit: '01.md', kind: 'exercise', title: 'Two Sum',
  url: 'https://leetcode.com/problems/two-sum/', role: 'anchor', required: true, order: 10,
}] }, null, 2));

const store = require('../app/lib/db');
const index = require('../app/lib/global-index');

test('global index rebuilds course and resource projections from bundle truth', () => {
  store.setProgress('algo', '01.md', 'done');
  store.setActivityProgress('algo', 'two-sum', 'done');
  const out = index.reconcile({ full: true });
  assert.deepEqual(out.errors, []);
  const course = index.listCourses('active')[0];
  assert.equal(course.done, 1);
  assert.equal(course.activities.done, 1);
  assert.equal(course.activities.anchorsDone, 1);
  const resource = index.resourceCatalog()[0];
  assert.equal(resource.resource, 'leetcode:two-sum');
  assert.equal(resource.state, 'done');

  store.setActivityProgress('algo', 'two-sum', 'doing');
  assert.deepEqual(index.reconcile().changed, ['algo']);
  assert.equal(index.listActivities({ course: 'algo' })[0].state, 'doing');
});

test.after(() => {
  store.closeAll();
  try { index.db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});
