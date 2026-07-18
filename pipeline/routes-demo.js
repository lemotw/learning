#!/usr/bin/env node
// 三路線關聯 demo 資料生成:
//   A. 整份 embed + 幾何後處理(centering / ABTT)
//   B. LLM 概念萃取(指射)+ MaxSim 多向量比對
//   C. 指令式 embedding(qwen3-embedding + 任務指令前綴)
// 輸出 app/web/routes-demo.json,三個 demo 頁共用
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const chat = require('../app/lib/chat');

const ROOT = path.join(__dirname, '..');
const COURSES = path.join(ROOT, 'courses');
const OLLAMA = 'http://127.0.0.1:11434';

// 人工基準(先前手動判的三條關聯,頁面上用來對照著色)
const TRUE_EDGES = new Set([
  'fundamental-analysis|technical-analysis',
  'k8s|linux-sysadmin',
  'db_scale|k8s',
]);
const pairKey = (a, b) => [a, b].sort().join('|');

async function embed(model, texts) {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`ollama ${model} ${res.status}: ${await res.text()}`);
  return (await res.json()).embeddings;
}

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

function center(vecs) {
  const dim = vecs[0].length;
  const mean = new Array(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) mean[i] += v[i] / vecs.length;
  return vecs.map(v => v.map((x, i) => x - mean[i]));
}

// 冪迭代求第一主成分,投影移除(ABTT 的 k=1 版)
function removeTopPC(centered) {
  const dim = centered[0].length;
  let u = new Array(dim).fill(0).map((_, i) => Math.sin(i + 1)); // 固定種子避免隨機
  for (let it = 0; it < 50; it++) {
    const next = new Array(dim).fill(0);
    for (const v of centered) {
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += v[i] * u[i];
      for (let i = 0; i < dim; i++) next[i] += dot * v[i];
    }
    const norm = Math.sqrt(next.reduce((t, x) => t + x * x, 0));
    u = next.map(x => x / norm);
  }
  return centered.map(v => {
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += v[i] * u[i];
    return v.map((x, i) => x - dot * u[i]);
  });
}

function allPairs(slugs, score) {
  const out = [];
  for (let i = 0; i < slugs.length; i++)
    for (let j = i + 1; j < slugs.length; j++)
      out.push({ a: slugs[i], b: slugs[j], score: score(i, j), isTrue: TRUE_EDGES.has(pairKey(slugs[i], slugs[j])) });
  return out.sort((x, y) => y.score - x.score);
}

// 分布健康度:排序後找最大相鄰落差(空隙),與空隙下方群的值域比
function gapStats(pairs) {
  const s = pairs.map(p => p.score);
  let gapAt = 0, gap = -1;
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] - s[i + 1] > gap) { gap = s[i] - s[i + 1]; gapAt = i; }
  }
  return { spread: s[0] - s[s.length - 1], gap, gapAfterRank: gapAt + 1 };
}

(async () => {
  const slugs = fs.readdirSync(COURSES).filter(d => !d.startsWith('.') && !d.startsWith('_')
    && fs.existsSync(path.join(COURSES, d, 'meta.json')));
  const meta = Object.fromEntries(slugs.map(s =>
    [s, JSON.parse(fs.readFileSync(path.join(COURSES, s, 'meta.json'), 'utf8'))]));
  const agendas = Object.fromEntries(slugs.map(s =>
    [s, fs.readFileSync(path.join(COURSES, s, 'AGENDA.md'), 'utf8')]));
  const docs = slugs.map(s => `${meta[s].title}\n${agendas[s]}`.slice(0, 6000));

  // ---------- 路線 A:整份 embed + 幾何後處理 ----------
  console.log('路線 A:bge-m3 整份 embed + centering + ABTT…');
  const aVecs = await embed('bge-m3', docs);
  const aCentered = center(aVecs);
  const aAbtt = removeTopPC(aCentered);
  const routeA = {
    raw: allPairs(slugs, (i, j) => cos(aVecs[i], aVecs[j])),
    centered: allPairs(slugs, (i, j) => cos(aCentered[i], aCentered[j])),
    abtt: allPairs(slugs, (i, j) => cos(aAbtt[i], aAbtt[j])),
  };

  // ---------- 路線 B:LLM 概念萃取 + MaxSim ----------
  console.log('路線 B:claude 萃取概念(指射)…');
  const prompt = [
    '你會看到多門課程的課綱。對每門課萃取 8-12 個「概念片語」——這門課實際教的知識指涉物。',
    '規則:裸名詞片語(2-8 字),禁止模板/教學詞(單元、Lab、自答題、診斷、實作、驗收、整合、檢查表、學習、課程),',
    '禁止「XX 的 YY」長句,每個概念要具體到該領域(例:「B+tree 索引」「K線型態」「namespace 隔離」)。',
    '只輸出 JSON:{"<slug>": ["概念1", ...], ...}',
    '',
    ...slugs.map(s => `=== ${s}(${meta[s].title})===\n${agendas[s].slice(0, 3500)}`),
  ].join('\n');
  const conceptsRaw = await chat.oneShot(prompt, { timeoutMs: 300_000 });
  const concepts = chat.extractJson(conceptsRaw);
  for (const s of slugs) if (!Array.isArray(concepts[s]) || !concepts[s].length) throw new Error(`概念萃取缺 ${s}`);

  console.log('路線 B:embed 概念片語 + centering + MaxSim…');
  const flat = [];
  for (const s of slugs) for (const c of concepts[s]) flat.push({ slug: s, c });
  const cVecsRaw = await embed('bge-m3', flat.map(f => f.c));
  const cVecs = center(cVecsRaw); // 概念層也做 centering
  const byCourse = Object.fromEntries(slugs.map(s => [s, []]));
  flat.forEach((f, i) => byCourse[f.slug].push({ c: f.c, v: cVecs[i] }));

  function maxSim(A, B) {
    const best = [];
    for (const x of A) {
      let m = -2, mc = null;
      for (const y of B) { const sc = cos(x.v, y.v); if (sc > m) { m = sc; mc = y.c; } }
      best.push({ from: x.c, to: mc, score: m });
    }
    return best;
  }
  const evidence = {};
  const routeB = allPairs(slugs, (i, j) => {
    const A = byCourse[slugs[i]], B = byCourse[slugs[j]];
    const ab = maxSim(A, B), ba = maxSim(B, A);
    const score = (ab.reduce((t, x) => t + x.score, 0) / ab.length
                 + ba.reduce((t, x) => t + x.score, 0) / ba.length) / 2;
    evidence[pairKey(slugs[i], slugs[j])] = [...ab].sort((x, y) => y.score - x.score).slice(0, 3);
    return score;
  });

  // ---------- 路線 C:指令式 embedding ----------
  console.log('路線 C:qwen3-embedding + 任務指令…');
  const INSTRUCT = 'Instruct: 辨識這份課綱教授的知識主題與領域,忽略寫作風格、文件格式與教學框架\nQuery: ';
  const qVecs = await embed('qwen3-embedding:0.6b', docs.map(d => INSTRUCT + d));
  const routeC = {
    raw: allPairs(slugs, (i, j) => cos(qVecs[i], qVecs[j])),
    centered: allPairs(slugs, (i, j) => {
      return null; // 佔位,下面統一算
    }),
  };
  const qCentered = center(qVecs);
  routeC.centered = allPairs(slugs, (i, j) => cos(qCentered[i], qCentered[j]));

  // ---------- 輸出 ----------
  const withStats = pairs => ({ pairs, stats: gapStats(pairs) });
  const out = {
    generatedAt: new Date().toISOString(),
    courses: slugs.map(s => ({ slug: s, title: meta[s].title })),
    trueEdges: [...TRUE_EDGES],
    routeA: { raw: withStats(routeA.raw), centered: withStats(routeA.centered), abtt: withStats(routeA.abtt) },
    routeB: { concepts, maxsim: withStats(routeB), evidence },
    routeC: { raw: withStats(routeC.raw), centered: withStats(routeC.centered) },
  };
  fs.writeFileSync(path.join(ROOT, 'app', 'web', 'routes-demo.json'), JSON.stringify(out, null, 2));

  for (const [name, r] of [['A.raw', routeA.raw], ['A.centered', routeA.centered], ['A.abtt', routeA.abtt],
                            ['B.maxsim', routeB], ['C.raw', routeC.raw], ['C.centered', routeC.centered]]) {
    const st = gapStats(r);
    console.log(`\n── ${name}(值域 ${st.spread.toFixed(3)},最大空隙 ${st.gap.toFixed(3)} 在第 ${st.gapAfterRank} 名後)──`);
    for (const p of r) console.log(`  ${p.isTrue ? '●' : '○'} ${p.score.toFixed(3)}  ${p.a} ↔ ${p.b}`);
  }
  console.log('\n寫入 app/web/routes-demo.json');
})();
