// pi CLI driver(本機 /opt/homebrew/bin/pi)。
//
// 與 claude driver 的差別:
//   - session id 不是 CLI 給的,是我們自己命名的(--session-id「不存在就建」),
//     所以 resume 用的 id 由 course+unit+seq 推導,不必等回傳。
//   - session 檔預設跟著 cwd 走(~/.pi/agent/sessions/<escaped-cwd>/),server 的 cwd
//     不保證固定,所以用 --session-dir 指到 app/data/pi-sessions 自己管。
//   - --no-context-files 一定要加:不然 pi 會去讀專案的 AGENTS.md / CLAUDE.md,
//     那些是給 coding agent 的指令,不該污染助教的 context。
//   - 模型由使用者自己的 pi 設定決定,本專案不指定(所以助教換到 pi 就換了一顆腦袋)。
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PI_BIN = process.env.PI_BIN || 'pi';
const SESSION_DIR = path.join(__dirname, '..', '..', 'data', 'pi-sessions');
const TIMEOUT_MS = 240_000;

/** session id 只留 [a-z0-9-];pi 拿它當檔名的一部分 */
function sessionIdFor(course, unit, seq) {
  const slug = s => String(s).toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `learning-${slug(course)}-${slug(unit)}-${seq}`;
}

// 模型清單問 pi 自己(`pi --list-models`),不寫死 —— 它取決於使用者設了哪些 provider。
// 沒有 JSON 輸出可用,只有固定欄位的文字表格:provider model context max-out thinking images
// 探一次就快取在 module scope;要重讀就重啟 server。
let MODELS_CACHE = null;
function listModels() {
  if (MODELS_CACHE) return MODELS_CACHE;
  try {
    const out = execFileSync(PI_BIN, ['--list-models'], { encoding: 'utf8', timeout: 20_000 });
    MODELS_CACHE = out.split('\n').slice(1)            // 第一行是表頭
      .map(l => l.trim().split(/\s+/))
      .filter(c => c.length >= 3 && c[0] && c[1])
      .map(([provider, model, context]) => ({
        id: `${provider}/${model}`,                    // pi --model 吃 "provider/id"
        label: model,
        note: `${provider} · ${context} context`,
        provider,
      }));
  } catch {
    MODELS_CACHE = [];                                 // 問不到就不給選單,不要瞎猜
  }
  return MODELS_CACHE;
}

function run(args, { onLine, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buf = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('pi CLI timeout'));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
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
      if (code !== 0) reject(new Error(`pi exited ${code}: ${stderr.slice(0, 500)}`));
      else resolve({ stderr });
    });
  });
}

async function stream({ message, systemPrompt, resume, model, course, unit, seq, onDelta }) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const sessionId = resume || sessionIdFor(course, unit, seq);

  const args = [
    '-p', '--mode', 'json',
    '--no-tools', '--no-extensions', '--no-skills', '--no-context-files',
    '--session-dir', SESSION_DIR,
    '--session-id', sessionId,
  ];
  // 不給 model 就用 pi 自己的預設。注意:帶 --model 時 pi 會等 stdin(疑似模型選擇器),
  // 我們的 spawn 用 stdio[0]='ignore'(= /dev/null)所以不會卡;在 shell 裡手動跑要記得 </dev/null。
  if (model) args.push('--model', model);
  // 續聊時不重送 system prompt:同一個 session 已經帶著它了
  if (!resume && systemPrompt) args.push('--append-system-prompt', systemPrompt);
  // pi 不接受 `--` 分隔符(claude 接受),訊息直接當位置參數。
  // 代價:開頭是 `-` 的訊息會被當成 flag —— pi 目前沒有別的辦法。
  args.push(message);

  let finalText = '';
  let accumulated = '';
  let usedModel = null;   // 實際跑的 provider/model,由 pi 回報
  let errText = '';

  const { stderr } = await run(args, {
    onLine(ev) {
      if (ev.type === 'message_update') {
        const e = ev.assistantMessageEvent;
        if (e && e.type === 'text_delta' && e.delta) {
          accumulated += e.delta;
          if (onDelta) onDelta(e.delta);
        }
      }
      if (ev.type === 'message_end' && ev.message && ev.message.role === 'assistant') {
        // content 是 parts 陣列;textSignature 之類的 provider 內部欄位直接忽略。
        // 開了 tools 的話這裡還會有 role === 'toolResult' 的訊息,目前 --no-tools 不會出現。
        finalText = (ev.message.content || []).filter(c => c.type === 'text')
          .map(c => c.text).join('');
        if (ev.message.model) usedModel = `${ev.message.provider || ''}/${ev.message.model}`;
      }
      // error 事件的形狀還沒實測過(只驗過成功路徑),先儘量撈出訊息
      if (ev.type === 'error' || ev.error) {
        errText = (ev.error && (ev.error.message || ev.error)) || ev.message || 'pi error';
      }
    },
  });

  if (!finalText && !accumulated && errText) throw new Error(String(errText));
  // pi 對「provider 沒憑證」是完全靜默的:content: []、0 tokens、exit 0、沒有 error 事件。
  // 不擋的話使用者只會看到助教突然變成啞巴,所以自己把它變成看得懂的錯誤。
  if (!finalText && !accumulated) {
    throw new Error(model
      ? `pi 用 ${model} 回了空回應 —— 通常是 pi 那邊沒有這個 provider 的憑證,`
        + '換一個模型或先在終端機跑 `pi --list-models` / 檢查 pi 設定'
      : 'pi 回了空回應(沒有錯誤訊息),檢查 pi 的 provider 設定');
  }
  // pi 的 --session-id 是「不存在就建」,續聊一個已被刪掉的 session 不會報錯,
  // 會靜默開一段新的(context 就沒了)。它只在 stderr 留一行 warning,撈出來回報。
  const resumeLost = !!resume && /No project session found with id/.test(stderr || '');
  return { sessionId, text: finalText || accumulated, model: usedModel, resumeLost };
}

module.exports = { stream, listModels, sessionIdFor, SESSION_DIR };
