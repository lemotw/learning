'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-archive-'));
process.env.COURSES_ROOT = root;

const content = require('../app/lib/content');
const lifecycle = require('../app/lib/course-lifecycle');
const search = require('../app/lib/archive-search');

function makeCourse(slug, status = 'active') {
  const dir = path.join(root, slug);
  fs.mkdirSync(path.join(dir, 'units'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    title: '資料庫規模化', status, tags: ['資料庫'],
    concepts: [{ name: '索引', desc: '以資料結構縮小查詢範圍' }], relations: [],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'AGENDA.md'), '# 課綱\n\n從儲存引擎到索引與交易。\n');
  fs.writeFileSync(path.join(dir, 'DIAGNOSTIC.md'), '只應存在於診斷檔的隱私詞\n');
  fs.writeFileSync(path.join(dir, 'units', '01-index.md'), '# Unit 1:索引\n\nB-tree 索引讓查詢避免全表掃描。\n');
  return dir;
}

test('archive keeps course source, hides it from active, and restore is lossless', () => {
  const dir = makeCourse('db-scale');
  const unitBefore = fs.readFileSync(path.join(dir, 'units', '01-index.md'), 'utf8');

  const archived = lifecycle.archive('db-scale');
  assert.equal(archived.status, 'archived');
  assert.equal(content.listCourses({ status: 'active' }).length, 0);
  assert.equal(content.listCourses({ status: 'archived' }).length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'units', '01-index.md'), 'utf8'), unitBefore);
  assert.ok(content.readMeta('db-scale').archivedAt);
  assert.throws(() => lifecycle.requireActive('db-scale'), e => e.code === 'course_archived');

  const found = search.search(content.listCourses({ status: 'archived' }), 'B-tree 查詢');
  assert.equal(found.length, 1);
  assert.equal(found[0].unit, '01-index.md');
  assert.equal(search.search(content.listCourses({ status: 'archived' }), '隱私詞').length, 0);

  const restored = lifecycle.restore('db-scale');
  assert.equal(restored.status, 'active');
  assert.equal(content.courseInfo('db-scale').status, 'active');
  assert.equal(content.readMeta('db-scale').archivedAt, undefined);
  assert.equal(fs.readFileSync(path.join(dir, 'units', '01-index.md'), 'utf8'), unitBefore);
});

test('archive rejects a course with an in-flight mutation', () => {
  makeCourse('busy-course');
  const release = lifecycle.beginActiveOperation('busy-course');
  assert.throws(() => lifecycle.archive('busy-course'), e => e.code === 'course_busy');
  release();
  assert.equal(lifecycle.archive('busy-course').status, 'archived');
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
