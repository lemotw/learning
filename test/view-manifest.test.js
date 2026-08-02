'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const V = require('../pipeline/lib/view-manifest');

function sample() {
  return { schema: 1, courseDrawer: 'roadmap', views: [{
    id: 'roadmap', title: 'Roadmap', entry: 'views/roadmap/index.html',
    data: 'views/roadmap/graph.json', height: 800,
  }] };
}

test('view manifest validates sandbox entry and data files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'views-'));
  fs.mkdirSync(path.join(dir, 'views', 'roadmap'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'views', 'roadmap', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(dir, 'views', 'roadmap', 'graph.json'), '{}');
  assert.deepEqual(V.validateManifest(sample(), { contentDir: dir }), []);
  assert.deepEqual(V.parseDirective('roadmap'), { id: 'roadmap' });
  assert.deepEqual(V.parseDirective('{"view":"roadmap"}'), { id: 'roadmap' });
  const bad = sample(); bad.views[0].entry = '../escape.html';
  assert.match(V.validateManifest(bad, { contentDir: dir }).join('\n'), /安全/);
  const dangling = sample(); dangling.courseDrawer = 'missing';
  assert.match(V.validateManifest(dangling, { contentDir: dir }).join('\n'), /找不到 view/);
  fs.rmSync(dir, { recursive: true, force: true });
});
