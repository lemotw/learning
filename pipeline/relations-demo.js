#!/usr/bin/env node
// Vector 關聯靜態 demo:Ollama(bge-m3)向量化 AGENDA 與單元定位 → cosine 相似度 → 候選邊
//   node pipeline/relations-demo.js
// 輸出:app/data/relations-demo.json(demo 頁讀這個)+ stdout 摘要
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COURSES = path.join(ROOT, 'courses');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = 'bge-m3';

// ---------- 取文本 ----------
function courseText(slug) {
  const agenda = read(path.join(COURSES, slug, 'AGENDA.md')) || '';
  const meta = JSON.parse(read(path.join(COURSES, slug, 'meta.json')));
  return { title: meta.title || slug, text: `${meta.title}\n${agenda}`.slice(0, 6000) };
}

// 單元文本 = 標題 + 定位 blockquote(> **定位**…)+ 前兩個小節標題
function unitText(slug, file) {
  const md = read(path.join(COURSES, slug, 'units', file));
  const title = (md.match(/^# (.+)$/m) || [, file])[1];
  const pos = (md.match(/^> \*\*(?:ℹ️ )?(?:定位|這個單元補的洞)[^\n]*\n((?:>.*\n)+)/m) || [, ''])[1]
    .replace(/^> ?/gm, '').trim();
  const heads = [...md.matchAll(/^### ?\d?\.? ?(.+)$/gm)].slice(0, 4).map(m => m[1]).join(';');
  return { title, text: `${title}\n${pos}\n${heads}`.slice(0, 2500) };
}

function read(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }

// ---------- embedding ----------
async function embed(texts) {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  return (await res.json()).embeddings;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------- main ----------
(async () => {
  const slugs = fs.readdirSync(COURSES).filter(d =>
    !d.startsWith('.') && !d.startsWith('_') && fs.existsSync(path.join(COURSES, d, 'meta.json')));

  // 收集所有文本
  const courseDocs = slugs.map(slug => ({ slug, ...courseText(slug) }));
  const unitDocs = [];
  for (const slug of slugs) {
    const dir = path.join(COURSES, slug, 'units');
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md')).sort()) {
      unitDocs.push({ slug, file: f, ...unitText(slug, f) });
    }
  }
  console.log(`向量化 ${courseDocs.length} 門課 + ${unitDocs.length} 個單元(${MODEL})…`);

  const t0 = Date.now();
  const cVecs = await embed(courseDocs.map(d => d.text));
  const uVecs = await embed(unitDocs.map(d => d.text));
  console.log(`embedding 完成,耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ---- 課程層級:全配對矩陣 ----
  const courseSims = [];
  for (let i = 0; i < courseDocs.length; i++) {
    for (let j = i + 1; j < courseDocs.length; j++) {
      courseSims.push({ a: courseDocs[i].slug, b: courseDocs[j].slug, sim: cosine(cVecs[i], cVecs[j]) });
    }
  }
  courseSims.sort((x, y) => y.sim - x.sim);

  // 相對排名:每門課的平均相似度當基線,邊要高出 margin 才算候選
  const avg = {};
  for (const s of slugs) {
    const mine = courseSims.filter(e => e.a === s || e.b === s);
    avg[s] = mine.reduce((t, e) => t + e.sim, 0) / mine.length;
  }
  const MARGIN = 0.03;
  const courseEdges = courseSims.filter(e => e.sim > avg[e.a] + MARGIN && e.sim > avg[e.b] + MARGIN);

  // ---- 單元層級:跨課最近鄰(每單元 top-3,再全域取高分)----
  const unitPairs = [];
  for (let i = 0; i < unitDocs.length; i++) {
    for (let j = i + 1; j < unitDocs.length; j++) {
      if (unitDocs[i].slug === unitDocs[j].slug) continue; // 只看跨課
      unitPairs.push({ i, j, sim: cosine(uVecs[i], uVecs[j]) });
    }
  }
  unitPairs.sort((x, y) => y.sim - x.sim);
  const unitEdges = unitPairs.slice(0, 15).map(p => ({
    a: { slug: unitDocs[p.i].slug, file: unitDocs[p.i].file, title: unitDocs[p.i].title },
    b: { slug: unitDocs[p.j].slug, file: unitDocs[p.j].file, title: unitDocs[p.j].title },
    sim: p.sim,
  }));

  // ---- 輸出 ----
  const out = {
    model: MODEL,
    generatedAt: new Date().toISOString(),
    courses: courseDocs.map((d, i) => ({ slug: d.slug, title: d.title, avgSim: avg[d.slug] })),
    courseSims,          // 完整矩陣(demo 頁畫熱度)
    courseEdges,         // 相對排名過門檻的候選邊
    unitEdges,           // 跨課單元 top 配對
  };
  const outPath = path.join(ROOT, 'app', 'data', 'relations-demo.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('\n── 課程相似度(全配對)──');
  for (const e of courseSims) console.log(`  ${e.sim.toFixed(3)}  ${e.a} ↔ ${e.b}`);
  console.log('\n── 課程候選邊(相對排名 + margin)──');
  for (const e of courseEdges) console.log(`  ${e.sim.toFixed(3)}  ${e.a} ↔ ${e.b}`);
  console.log('\n── 跨課單元 top 配對 ──');
  for (const e of unitEdges.slice(0, 10)) {
    console.log(`  ${e.sim.toFixed(3)}  [${e.a.slug}] ${e.a.title.slice(0, 24)} ↔ [${e.b.slug}] ${e.b.title.slice(0, 24)}`);
  }
  console.log(`\n寫入 ${outPath}`);
})();
