// b 方案:spawn 本機 claude CLI headless。多輪靠 --resume,串流靠 stream-json。
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CHAT_MODEL = process.env.CHAT_MODEL || ''; // 空 = 用使用者預設模型
const TIMEOUT_MS = 240_000;

// 助教不該碰任何工具:唯讀查課程檔也不必要,context 已在 system prompt 裡
const NO_TOOLS = [
  '--disallowedTools',
  'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
  'Task', 'Agent', 'TodoWrite', 'Read', 'Glob', 'Grep',
];

function baseArgs() {
  const a = [...NO_TOOLS];
  if (CHAT_MODEL) a.push('--model', CHAT_MODEL);
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
 * 串流對話。首輪帶 systemPrompt 開新 session;之後帶 resumeSessionId 續聊。
 * onDelta(text) 逐段回吐。resolve {sessionId, text}
 */
async function streamChat({ message, systemPrompt, resumeSessionId, onDelta }) {
  const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', ...baseArgs()];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  else if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  args.push('--', message);

  let sessionId = resumeSessionId || null;
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

  return { sessionId, text: finalText || accumulated };
}

/** 一次性呼叫(自答題批改用),不留 session。resolve 純文字結果 */
async function oneShot(prompt, { timeoutMs } = {}) {
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', ...baseArgs(), '--', prompt];
  const { stdout } = await run(args, { timeoutMs });
  const parsed = JSON.parse(stdout);
  if (typeof parsed.result !== 'string') throw new Error('unexpected claude output');
  return parsed.result;
}

/** 從模型回覆萃取 JSON(容忍 ```json fence 或前後閒話) */
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const m = candidate.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON found in model output');
  return JSON.parse(m[0]);
}

module.exports = { streamChat, oneShot, extractJson };
