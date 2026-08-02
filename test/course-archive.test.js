'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-archive-'));
process.env.COURSES_ROOT = root;
process.env.LEARNING_DATA_ROOT = path.join(root, '.data');

const content = require('../app/lib/content');
const lifecycle = require('../app/lib/course-lifecycle');
const search = require('../app/lib/archive-search');
const store = require('../app/lib/db');

function makeCourse(slug, status = 'active') {
  const dir = path.join(root, status === 'archived' ? 'archived' : 'active', slug);
  const cdir = path.join(dir, 'content');
  fs.mkdirSync(path.join(cdir, 'units'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'course.json'), JSON.stringify({ schema: 1, id: slug, slug }, null, 2) + '\n');
  fs.writeFileSync(path.join(cdir, 'meta.json'), JSON.stringify({
    title: '資料庫規模化', tags: ['資料庫'],
    concepts: [{ name: '索引', desc: '以資料結構縮小查詢範圍' }], relations: [],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(cdir, 'AGENDA.md'), '# 課綱\n\n從儲存引擎到索引與交易。\n');
  fs.writeFileSync(path.join(cdir, 'DIAGNOSTIC.md'), '只應存在於診斷檔的隱私詞\n');
  fs.writeFileSync(path.join(cdir, 'units', '01-index.md'), '# Unit 1:索引\n\nB-tree 索引讓查詢避免全表掃描。\n');
  return dir;
}

test('archive atomically moves the whole bundle and restore is lossless', () => {
  const dir = makeCourse('db-scale');
  const unitBefore = fs.readFileSync(path.join(dir, 'content', 'units', '01-index.md'), 'utf8');
  store.setProgress('db-scale', '01-index.md', 'done');

  const archived = lifecycle.archive('db-scale');
  const archivedDir = path.join(root, 'archived', 'db-scale');
  assert.equal(archived.status, 'archived');
  assert.equal(content.listCourses({ status: 'active' }).length, 0);
  assert.equal(content.listCourses({ status: 'archived' }).length, 1);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(path.join(archivedDir, 'content', 'units', '01-index.md'), 'utf8'), unitBefore);
  assert.ok(store.getStateMeta('db-scale', 'archived_at'));
  assert.equal(store.getProgress('db-scale')[0].state, 'done');
  assert.throws(() => lifecycle.requireActive('db-scale'), e => e.code === 'course_archived');

  const found = search.search(content.listCourses({ status: 'archived' }), 'B-tree 查詢');
  assert.equal(found.length, 1);
  assert.equal(found[0].unit, '01-index.md');
  assert.equal(search.search(content.listCourses({ status: 'archived' }), '隱私詞').length, 0);

  const restored = lifecycle.restore('db-scale');
  assert.equal(restored.status, 'active');
  assert.equal(content.courseInfo('db-scale').status, 'active');
  assert.equal(store.getStateMeta('db-scale', 'archived_at'), null);
  assert.equal(store.getProgress('db-scale')[0].state, 'done');
  assert.equal(fs.readFileSync(path.join(dir, 'content', 'units', '01-index.md'), 'utf8'), unitBefore);
});

test('archive rejects a course with an in-flight mutation', () => {
  makeCourse('busy-course');
  const release = lifecycle.beginActiveOperation('busy-course');
  assert.throws(() => lifecycle.archive('busy-course'), e => e.code === 'course_busy');
  release();
  assert.equal(lifecycle.archive('busy-course').status, 'archived');
});

test.after(() => {
  store.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
});
