#!/usr/bin/env node
// 課程關聯自動計算(IE 路線正式版)— 純本機、零 LLM:
//   讀 courses/*/meta.json 的 concepts({name, desc},生成期由 LLM 萃取)
//   → Ollama bge-m3 embed(內容 hash 快取)→ centering → 雙向 MaxSim
//   → 空隙偵測選候選邊 → 輸出 app/data/graph-auto.json(server 合併進 /api/graph)
// 手動邊(meta.json relations)為權威,已有手動邊的配對不出自動邊。
//   用法:node pipeline/relations.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const COURSES = path.join(ROOT, 'courses');
const DATA = path.join(ROOT, 'app', 'data');
const CACHE_FILE = path.join(DATA, 'embed-cache.json');
const OUT_FILE = path.join(DATA, 'graph-auto.json');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = 'bge-m3';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

async function embedBatch(texts) {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  return (await res.json()).embeddings;
}

(async () => {
  // Ollama 不在 → 優雅退出,保留上次結果
  try {
    await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(2000) });
  } catch {
    console.error(`Ollama 未啟動(${OLLAMA}),跳過關聯計算;保留既有 ${path.relative(ROOT, OUT_FILE)}。`);
    process.exit(0);
  }

  const slugs = fs.readdirSync(COURSES).filter(d => !d.startsWith('.') && !d.startsWith('_')
    && fs.existsSync(path.join(COURSES, d, 'meta.json')));
  const metas = Object.fromEntries(slugs.map(s =>
    [s, JSON.parse(fs.readFileSync(path.join(COURSES, s, 'meta.json'), 'utf8'))]));

  // 已有手動邊的配對(雙向皆算)
  const manual = new Set();
  for (const s of slugs) for (const r of metas[s].relations || []) manual.add([s, r.to].sort().join('|'));

  // 收集概念,略過沒有合格 concepts 的課
  const byCourse = {};
  for (const s of slugs) {
    const cs = (metas[s].concepts || []).filter(c => c && c.name && c.desc);
    if (cs.length < 4) { console.error(`⚠ ${s} 的 concepts 少於 4 個,跳過(請依 pipeline/prompts/concepts.md 補萃取)`); continue; }
    byCourse[s] = cs.map(c => ({ name: c.name, text: `${c.name}——${c.desc}` }));
  }
  const active = Object.keys(byCourse);
  if (active.length < 2) { console.error('可比較課程不足兩門,結束。'); process.exit(0); }

  // ---- embed(hash 快取)----
  fs.mkdirSync(DATA, { recursive: true });
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
  const missing = [];
  for (const s of active) for (const c of byCourse[s]) {
    c.key = sha(MODEL + '|' + c.text);
    if (!cache[c.key]) missing.push(c);
  }
  if (missing.length) {
    console.log(`embed ${missing.length} 個新概念(其餘走快取)…`);
    const vecs = await embedBatch(missing.map(c => c.text));
    missing.forEach((c, i) => { cache[c.key] = vecs[i]; });
    // 只保留還在用的 key,快取不無限長大
    const live = new Set(active.flatMap(s => byCourse[s].map(c => c.key)));
    cache = Object.fromEntries(Object.entries(cache).filter(([k]) => live.has(k)));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } else {
    console.log('概念向量全部命中快取。');
  }

  // ---- centering(全概念平均)----
  const all = active.flatMap(s => byCourse[s].map(c => cache[c.key]));
  const dim = all[0].length;
  const mean = new Array(dim).fill(0);
  for (const v of all) for (let i = 0; i < dim; i++) mean[i] += v[i] / all.length;
  const vec = {};
  for (const s of active) for (const c of byCourse[s]) {
    vec[c.key] = cache[c.key].map((x, i) => x - mean[i]);
  }

  // ---- 雙向 MaxSim + 證據 ----
  function maxSim(A, B) {
    return A.map(x => {
      let best = -2, bestName = null;
      for (const y of B) { const sc = cos(vec[x.key], vec[y.key]); if (sc > best) { best = sc; bestName = y.name; } }
      return { from: x.name, to: bestName, score: best };
    });
  }
  const pairs = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const [a, b] = [active[i], active[j]];
      const ab = maxSim(byCourse[a], byCourse[b]);
      const ba = maxSim(byCourse[b], byCourse[a]);
      const score = (ab.reduce((t, x) => t + x.score, 0) / ab.length
                   + ba.reduce((t, x) => t + x.score, 0) / ba.length) / 2;
      const evidence = [...ab, ...ba.map(e => ({ from: e.to, to: e.from, score: e.score, _rev: true }))]
        .sort((x, y) => y.score - x.score)
        .filter((e, idx, arr) => arr.findIndex(o => o.from === e.from && o.to === e.to) === idx)
        .slice(0, 3)
        .map(({ from, to, score }) => ({ from, to, score: Number(score.toFixed(3)) }));
      pairs.push({ a, b, score, evidence });
    }
  }
  pairs.sort((x, y) => y.score - x.score);

  // ---- 空隙偵測選邊 ----
  let gapAt = 0, gap = -1;
  for (let i = 0; i < pairs.length - 1; i++) {
    const g = pairs[i].score - pairs[i + 1].score;
    if (g > gap) { gap = g; gapAt = i; }
  }
  const selected = pairs.slice(0, gapAt + 1)
    .filter(p => !manual.has([p.a, p.b].sort().join('|')));

  const edges = selected.map(p => ({
    a: p.a, b: p.b,
    score: Number(p.score.toFixed(3)),
    evidence: p.evidence,
    why: '概念呼應:' + p.evidence.slice(0, 2).map(e => `${e.from} ↔ ${e.to}`).join('、'),
  }));

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    model: MODEL,
    method: 'concept-maxsim(centering + gap-detection)',
    edges,
    allPairs: pairs.map(p => ({ a: p.a, b: p.b, score: Number(p.score.toFixed(3)) })),
  }, null, 2));

  console.log(`\n候選邊 ${edges.length} 條(空隙 ${gap.toFixed(3)} 在第 ${gapAt + 1} 名後;手動邊配對已排除):`);
  for (const e of edges) console.log(`  ${e.score}  ${e.a} ↔ ${e.b} — ${e.why}`);
  const skipped = pairs.slice(0, gapAt + 1).length - selected.length;
  if (skipped) console.log(`(另有 ${skipped} 條過門檻配對因已有手動邊而略過)`);
  console.log(`寫入 ${path.relative(ROOT, OUT_FILE)}`);
})();
