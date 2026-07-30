// claude CLI headless driver。多輪靠 --resume,串流靠 stream-json。
// 這支原本是 app/lib/chat.js 的內容,抽出來讓助教可以換 agent(見 ../agents.js)。
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5';
const GRADE_MODEL = process.env.GRADE_MODEL || 'claude-sonnet-5'; // 批改固定模型,評分標準才穩定
const TIMEOUT_MS = 240_000;

// 助教不該碰任何工具:唯讀查課程檔也不必要,context 已在 system prompt 裡
const NO_TOOLS = [
  '--disallowedTools',
  'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
  'Task', 'Agent', 'TodoWrite', 'Read', 'Glob', 'Grep',
];

// 開放給前端選的模型。claude --model 吃 alias 或完整 ID;這裡一律用完整 ID,
// 免得 alias 哪天指到別的版本、歷史紀錄對不上。
const MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', note: '預設。速度與能力平衡,1M context' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', note: '最強的 Opus,難題與長對話用' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: '最快最省,簡單問答用(200K context)' },
  { id: 'claude-fable-5', label: 'Fable 5', note: '能力最高但也最貴' },
];
const MODEL_IDS = new Set(MODELS.map(m => m.id));

function baseArgs(model) {
  const a = [...NO_TOOLS];
  if (model) a.push('--model', model);
  return a;
}

function run(args, { onLine, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let buf = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude CLI timeout'));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d;
      if (!onLine) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { onLine(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * 串流對話。首輪帶 systemPrompt 開新 session;之後帶 resume 續聊。
 * resume 是 CLI 自己給的 session UUID(從 system/init 事件撈出來的)。
 */
async function stream({ message, systemPrompt, resume, model, onDelta }) {
  const use = MODEL_IDS.has(model) ? model : DEFAULT_MODEL;
  try {
    return await once({ message, systemPrompt, resume, model: use, onDelta });
  } catch (e) {
    // CLI 把那個 session 檔清掉了(實測 30 段裡最舊的 2 段已不在
    // ~/.claude/projects/ 下)。--resume 會直接 exit 1,不該讓整輪對話失敗 ——
    // 退成開新的一段(systemPrompt 這時才派上用場),並回報 resumeLost 讓 UI 講清楚。
    // 失敗發生在 spawn 之後、還沒吐任何 stdout,所以不會有半截的 delta 已經送出去。
    if (resume && /No conversation found with session ID/.test(String(e.message))) {
      const r = await once({ message, systemPrompt, resume: null, model: use, onDelta });
      return { ...r, resumeLost: true };
    }
    throw e;
  }
}

async function once({ message, systemPrompt, resume, model, onDelta }) {
  const use = model;
  const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    ...baseArgs(use)];
  if (resume) args.push('--resume', resume);
  else if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  args.push('--', message);

  let sessionId = resume || null;
  let finalText = '';
  let accumulated = '';

  await run(args, {
    onLine(ev) {
      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'stream_event') {
        const delta = ev.event && ev.event.delta;
        if (delta && delta.type === 'text_delta' && delta.text) {
          accumulated += delta.text;
          if (onDelta) onDelta(delta.text);
        }
      }
      if (ev.type === 'result') {
        if (ev.session_id) sessionId = ev.session_id;
        if (typeof ev.result === 'string') finalText = ev.result;
      }
    },
  });

  return { sessionId, text: finalText || accumulated, model: use };
}

/** 一次性呼叫(自答題批改用),不留 session。resolve 純文字結果 */
async function oneShot(prompt, { timeoutMs } = {}) {
  const args = ['-p', '--output-format', 'json', '--no-session-persistence',
    ...baseArgs(GRADE_MODEL), '--', prompt];
  const { stdout } = await run(args, { timeoutMs });
  const parsed = JSON.parse(stdout);
  if (typeof parsed.result !== 'string') throw new Error('unexpected claude output');
  return parsed.result;
}

module.exports = { stream, oneShot, MODELS, DEFAULT_MODEL };
