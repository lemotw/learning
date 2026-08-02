#!/usr/bin/env node
// 課程關聯自動計算(IE 路線正式版)— 純本機、零 LLM:
//   讀 courses/active/*/content/meta.json 的 concepts({name, desc},生成期由 LLM 萃取)
//   → Ollama bge-m3 embed(內容 hash 快取)→ centering → 雙向 MaxSim
//   → 空隙偵測選候選邊 → 輸出 app/data/graph-auto.json(server 合併進 /api/graph)
// 手動邊(meta.json relations)為權威,已有手動邊的配對不出自動邊。
//   用法:node pipeline/relations.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const bundles = require(path.join(ROOT, 'app', 'lib', 'course-bundles'));
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

  // Bundle 所在目錄就是 lifecycle 真相；只有 active/ 參與日常 graph。
  const activeBundles = bundles.list({ status: 'active' });
  const slugs = activeBundles.map(b => b.slug);
  const metas = Object.fromEntries(activeBundles.map(b =>
    [b.slug, JSON.parse(fs.readFileSync(path.join(b.contentDir, 'meta.json'), 'utf8'))]));

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

  // ---- 另外四種計分方式(僅供 /#/scoring 檢視頁比較,不影響上面的預設邊)----
  //   全部在同一組 centering 後的向量上算,差別只在「怎麼把 12x12 個配對分數縮成一個數」。
  const combos = [];
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++) combos.push([active[i], active[j]]);

  const crossPairs = (a, b) => {
    const out = [];
    for (const x of byCourse[a]) for (const y of byCourse[b])
      out.push({ from: x.name, to: y.name, score: cos(vec[x.key], vec[y.key]) });
    return out;
  };
  const centroidOf = a => {
    const g = new Array(dim).fill(0);
    for (const c of byCourse[a]) { const v = vec[c.key]; for (let i = 0; i < dim; i++) g[i] += v[i] / byCourse[a].length; }
    return g;
  };
  const centroids = Object.fromEntries(active.map(s => [s, centroidOf(s)]));
  const r3 = x => Number(x.toFixed(3));
  // 證據:概念配對(橋樑型)
  const pairItems = list => [...list].sort((x, y) => y.score - x.score)
    .slice(0, 3).map(e => ({ label: `${e.from} ↔ ${e.to}`, score: r3(e.score) }));
  // 證據:各自最靠近「對方整團中心」的概念(交融型;不宣稱一對一對應)
  const bridgeItems = (a, b) => {
    const near = (side, ct) => byCourse[side].map(c => ({ label: c.name, score: cos(vec[c.key], ct) }))
      .sort((x, y) => y.score - x.score).slice(0, 3).map(o => ({ label: o.label, score: r3(o.score) }));
    return [...near(a, centroids[b]), ...near(b, centroids[a])];
  };

  const rawScores = {
    maxsim: Object.fromEntries(pairs.map(p => [`${p.a}|${p.b}`, p.score])),
    centroid: {}, allmean: {}, top3: {},
  };
  for (const [a, b] of combos) {
    const cp = crossPairs(a, b), k = `${a}|${b}`;
    rawScores.centroid[k] = cos(centroids[a], centroids[b]);
    rawScores.allmean[k] = cp.reduce((t, e) => t + e.score, 0) / cp.length;
    rawScores.top3[k] = [...cp].sort((x, y) => y.score - x.score).slice(0, 3)
      .reduce((t, e) => t + e.score, 0) / 3;
  }
  // z 分數取大:兩種尺度各自標準化後取較大者(橋樑型與交融型都抓得到)
  const zOf = m => {
    const vals = Object.values(m), mu = vals.reduce((t, x) => t + x, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((t, x) => t + (x - mu) ** 2, 0) / vals.length) || 1;
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, (v - mu) / sd]));
  };
  const zM = zOf(rawScores.maxsim), zC = zOf(rawScores.centroid);
  rawScores.zmax = Object.fromEntries(combos.map(([a, b]) => {
    const k = `${a}|${b}`; return [k, Math.max(zM[k], zC[k])];
  }));

  const key = (a, b) => (rawScores.maxsim[`${a}|${b}`] !== undefined ? `${a}|${b}` : `${b}|${a}`);
  const SCORER_DEF = [
    ['maxsim',   'MaxSim(現行)',   '每個概念到對面找最像的取分、雙向平均。只看得到「最像的那一對」,所以只認得橋樑型關聯。', 'pair'],
    ['centroid', '重心 cos',        '兩門課各自的概念重心,直接算夾角。看得到整體重疊(交融型),但看不見窄橋。',        'bridge'],
    ['allmean',  '全配對平均',      '所有跨課概念配對的平均。最平滑,但會被大量不相干配對稀釋。',                      'pair'],
    ['top3',     'Top-3 平均',      '取最像的三對取平均。介於 MaxSim 與全平均之間,比單一最大值穩一點。',              'pair'],
    ['zmax',     'z 分數取大',      'MaxSim 與重心各自標準化後取大值,兩型關聯都想抓。代價:分數是相對的,加課會全部重算。', 'pair'],
  ];
  const scorers = {};
  for (const [id, label, note, kind] of SCORER_DEF) {
    const list = combos.map(([a, b]) => {
      const k = key(a, b), score = rawScores[id][k];
      const items = kind === 'bridge' ? bridgeItems(a, b) : pairItems(crossPairs(a, b));
      const why = kind === 'bridge'
        ? '兩邊都在談:' + items.slice(0, 2).map(i => i.label).join('、') + ' ｜ ' + items.slice(3, 5).map(i => i.label).join('、')
        : '概念呼應:' + items.slice(0, 2).map(i => i.label).join('、');
      return { a, b, score: Number(score.toFixed(4)), evidence: items, why, manual: manual.has([a, b].sort().join('|')) };
    }).sort((x, y) => y.score - x.score);
    // 該計分方式自己的空隙切點(第幾名之後落差最大)
    let gAt = 0, gMax = -Infinity;
    for (let i = 0; i < list.length - 1; i++) {
      const g = list[i].score - list[i + 1].score;
      if (g > gMax) { gMax = g; gAt = i; }
    }
    scorers[id] = { label, note, kind, gapCut: gAt + 1, gapSize: Number(gMax.toFixed(4)), pairs: list };
  }

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
    defaultScorer: 'maxsim',
    scorers,
  }, null, 2));

  console.log(`\n候選邊 ${edges.length} 條(空隙 ${gap.toFixed(3)} 在第 ${gapAt + 1} 名後;手動邊配對已排除):`);
  for (const e of edges) console.log(`  ${e.score}  ${e.a} ↔ ${e.b} — ${e.why}`);
  const skipped = pairs.slice(0, gapAt + 1).length - selected.length;
  if (skipped) console.log(`(另有 ${skipped} 條過門檻配對因已有手動邊而略過)`);
  console.log(`寫入 ${path.relative(ROOT, OUT_FILE)}`);
})();
