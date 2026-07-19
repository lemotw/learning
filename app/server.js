// learning hub — 講義閱讀 + 學習狀態(SQLite)+ 講義側欄 AI 助教(claude CLI headless)
// 零依賴 Node。courses/ 唯讀;唯一可寫處是 app/data/。
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const store = require('./lib/db');
const content = require('./lib/content');
const chat = require('./lib/chat');

const PORT = Number(process.env.PORT || 4600);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const STATES = new Set(['unread', 'reading', 'done']);

// ---------- helpers ----------

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
  });
}

function progressMap(course) {
  const map = {};
  for (const row of store.getProgress(course)) map[row.unit] = row;
  return map;
}

function coursesWithProgress() {
  return content.listCourses().map(({ slug, meta, units }) => {
    const pm = progressMap(slug);
    const u = units.map(x => ({
      ...x,
      state: pm[x.file] ? pm[x.file].state : 'unread',
      updatedAt: pm[x.file] ? pm[x.file].updated_at : null,
    }));
    return {
      slug,
      title: meta.title || slug,
      status: meta.status || 'active',
      tags: meta.tags || [],
      relations: meta.relations || [],
      units: u,
      done: u.filter(x => x.state === 'done').length,
      total: u.length,
    };
  });
}

// ---------- AI 助教 prompt 組裝 ----------

function clip(s, max) { return s && s.length > max ? s.slice(0, max) + '\n…(截斷)' : (s || ''); }

function tutorSystemPrompt(courseSlug, unitFile, unitRaw) {
  const meta = content.readMeta(courseSlug) || {};
  const diagnostic = content.readCourseFile(courseSlug, 'DIAGNOSTIC.md');
  const agenda = content.readCourseFile(courseSlug, 'AGENDA.md');
  return [
    `你是「${meta.title || courseSlug}」這門個人化課程的 AI 助教,使用者正在閱讀單元「${unitFile}」。`,
    '回答規則:繁體中文;針對使用者的診斷弱點講解,不泛泛科普;優先用本單元講義的框架與例子;',
    '使用者答對的直覺要先肯定再延伸;適當時反問一句檢驗理解。不要使用任何工具。',
    '',
    '=== 本單元講義全文 ===', clip(unitRaw, 40_000),
    diagnostic ? '\n=== 使用者的診斷分析(已知/誤解/空白)===\n' + clip(diagnostic, 12_000) : '',
    agenda ? '\n=== 課綱(前後單元脈絡)===\n' + clip(agenda, 8_000) : '',
  ].join('\n');
}

function gradePrompt(courseSlug, unitRaw, q, answer) {
  return [
    '你是課程助教,批改使用者對講義自答題的口頭式回答。批改標準:',
    '- 下列「必含概念」是評分準繩:同義說法、自己的話講出同一概念都算講到;死背術語但講錯機制不算。',
    '- 有講錯的機制或因果一定要指出。',
    '- verdict 只有 pass(核心概念都到位)或 redo(有缺漏或講錯)。',
    '只輸出 JSON,格式:{"verdict":"pass|redo","missing":["沒講到的概念"],"feedback":"2-4 句評語,指出缺什麼、哪裡講錯、怎麼補"}',
    '',
    '=== 題目 ===', q.question,
    '=== 必含概念 ===', q.keywords.join('、'),
    '=== 使用者的回答 ===', answer,
    '=== 講義相關內容(評分依據)===', clip(unitRaw, 30_000),
  ].join('\n');
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  const q = url.searchParams;

  if (req.method === 'GET' && url.pathname === '/api/courses') {
    return json(res, 200, coursesWithProgress());
  }

  if (req.method === 'GET' && url.pathname === '/api/graph') {
    const courses = coursesWithProgress();
    const known = new Set(courses.map(c => c.slug));
    const nodes = courses.map(c => ({
      id: c.slug, title: c.title, status: c.status, done: c.done, total: c.total,
      units: c.units.map(u => ({ file: u.file, title: u.title, state: u.state })),
    }));
    const edges = [];
    const seen = new Set();
    for (const c of courses) {
      for (const r of c.relations) {
        if (!known.has(r.to)) continue;
        edges.push({ source: c.slug, target: r.to, type: r.type || 'related', why: r.why || '', origin: 'manual' });
        seen.add([c.slug, r.to].sort().join('|'));
      }
    }
    // 自動候選邊(pipeline/relations.js 產出);手動邊優先,同配對不重複
    try {
      const auto = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'graph-auto.json'), 'utf8'));
      for (const e of auto.edges || []) {
        if (!known.has(e.a) || !known.has(e.b)) continue;
        if (seen.has([e.a, e.b].sort().join('|'))) continue;
        edges.push({ source: e.a, target: e.b, type: 'related', origin: 'auto',
          score: e.score, why: e.why || '', evidence: e.evidence || [] });
      }
    } catch { /* 沒有 auto 檔就只出手動邊 */ }
    return json(res, 200, { nodes, edges });
  }

  if (req.method === 'GET' && url.pathname === '/api/unit') {
    const course = q.get('course'), unit = q.get('unit');
    const { md, questions } = content.readUnit(course, unit);
    const meta = content.readMeta(course) || {};
    const units = content.listUnits(course);
    const pm = progressMap(course);
    return json(res, 200, {
      course, unit, md,
      courseTitle: meta.title || course,
      questions: questions.map(({ id, question }) => ({ id, question })), // keywords 不外流
      units: units.map(u => ({ ...u, state: pm[u.file] ? pm[u.file].state : 'unread' })),
      state: pm[unit] ? pm[unit].state : 'unread',
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/progress') {
    const { course, unit, state } = await readBody(req);
    if (!STATES.has(state)) return json(res, 400, { error: 'bad state' });
    content.readUnit(course, unit); // 驗證存在 + 路徑安全
    store.setProgress(course, unit, state);
    store.addRecord(course, unit, 'read', `state → ${state}`);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/records') {
    return json(res, 200, store.recentRecords(Number(q.get('limit') || 20)));
  }

  if (req.method === 'POST' && url.pathname === '/api/records') {
    const { course, unit, kind, note } = await readBody(req);
    if (!course || !kind) return json(res, 400, { error: 'course/kind required' });
    store.addRecord(course, unit || null, kind, note);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/redo') {
    return json(res, 200, store.redoQueue());
  }

  if (req.method === 'GET' && url.pathname === '/api/selfcheck') {
    return json(res, 200, store.attempts(q.get('course'), q.get('unit')));
  }

  if (req.method === 'POST' && url.pathname === '/api/selfcheck') {
    const { course, unit, qid, answer } = await readBody(req);
    if (!answer || !answer.trim()) return json(res, 400, { error: 'empty answer' });
    const { raw, questions } = content.readUnit(course, unit);
    const question = questions.find(x => x.id === qid);
    if (!question) return json(res, 404, { error: 'question not found' });

    const out = await chat.oneShot(gradePrompt(course, raw, question, answer));
    let graded;
    try {
      graded = chat.extractJson(out);
    } catch {
      graded = { verdict: 'redo', missing: [], feedback: '批改輸出解析失敗,請重試。原始輸出:' + out.slice(0, 300) };
    }
    const verdict = graded.verdict === 'pass' ? 'pass' : 'redo';
    store.addAttempt(course, unit, qid, answer, verdict, graded.feedback || '');
    store.addRecord(course, unit, 'selfcheck', `${qid}: ${verdict}`);
    return json(res, 200, {
      verdict,
      missing: graded.missing || [],
      feedback: graded.feedback || '',
      keywords: question.keywords, // 批改後才展示
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/history') {
    const course = q.get('course'), unit = q.get('unit');
    const sess = store.latestChatSession(course, unit);
    if (!sess) return json(res, 200, { sessionId: null, messages: [] });
    return json(res, 200, { sessionId: sess.session_id, messages: store.chatHistory(course, unit, sess.session_id) });
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const { course, unit, message, newSession } = await readBody(req);
    if (!message || !message.trim()) return json(res, 400, { error: 'empty message' });
    const { raw } = content.readUnit(course, unit);

    const prev = newSession ? null : store.latestChatSession(course, unit);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      const { sessionId, text } = await chat.streamChat({
        message,
        resumeSessionId: prev ? prev.session_id : null,
        systemPrompt: prev ? null : tutorSystemPrompt(course, unit, raw),
        onDelta: (t) => send('delta', { text: t }),
      });
      if (!prev && sessionId) {
        store.addChatSession(course, unit, sessionId);
        store.addRecord(course, unit, 'chat', '開新對話');
      }
      if (sessionId) {
        store.addChatMessage(course, unit, sessionId, 'user', message);
        store.addChatMessage(course, unit, sessionId, 'assistant', text);
      }
      send('done', { sessionId, text });
    } catch (e) {
      send('error', { error: String(e.message || e) });
    }
    return res.end();
  }

  json(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  const ext = path.extname(file);
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (ext === '.html') headers['Cache-Control'] = 'no-store'; // 頁面永遠拿最新版
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    const code = e.status || 500;
    if (!res.headersSent) json(res, code, { error: String(e.message || e) });
    else res.end();
    if (code >= 500) console.error(e);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`learning hub on http://${HOST}:${PORT}  (courses: ${content.COURSES_ROOT})`);
});
