// 助教可選的 agent。每個 driver 提供
//   stream({ message, systemPrompt, resume, model, course, unit, seq, onDelta })
//     → { sessionId, text, model }
// resume 的型別由 driver 自己解讀:claude 是 CLI 給的 UUID,pi 是我們自己命名的 id。
'use strict';

const { execFileSync } = require('node:child_process');
const claude = require('./drivers/claude');
const pi = require('./drivers/pi');

const DEFS = [
  {
    id: 'claude',
    label: 'Claude',
    note: '本機 claude CLI。模型可選,批改也走這條(固定 model,評分標準才穩定)。',
    bin: process.env.CLAUDE_BIN || 'claude',
    models: claude.MODELS,
    defaultModel: claude.DEFAULT_MODEL,
    driver: claude,
  },
  {
    id: 'pi',
    label: 'pi',
    note: '本機 pi CLI。模型清單問 pi 自己(pi --list-models),含你設好的所有 provider。',
    bin: process.env.PI_BIN || 'pi',
    // 不寫死:清單取決於使用者在 pi 裡設了哪些 provider。
    // 第一項空字串 = 不指定,交給 pi 自己的預設。
    get models() {
      const m = pi.listModels();
      return m.length ? [{ id: '', label: '(pi 預設)', note: '不指定,用 pi 自己設定的模型' }, ...m] : [];
    },
    defaultModel: '',
    driver: pi,
  },
];

// 沒裝的 agent 不該出現在選單裡(給假選擇比少一個選項糟)。
// which 探一次就好,結果快取在 module scope。
const AVAILABLE = new Map();
function available(def) {
  if (!AVAILABLE.has(def.id)) {
    let ok = false;
    try { execFileSync('which', [def.bin], { stdio: 'ignore' }); ok = true; } catch { ok = false; }
    AVAILABLE.set(def.id, ok);
  }
  return AVAILABLE.get(def.id);
}

/** 給 /api/agents:前端拿來畫選單 */
function list() {
  return DEFS.map(d => ({
    id: d.id, label: d.label, note: d.note,
    models: d.models, defaultModel: d.defaultModel,
    available: available(d),
  }));
}

/** 解析成實際要用的 agent。認不出來或沒裝就退回第一個裝好的 */
function resolve(id) {
  const want = DEFS.find(d => d.id === id && available(d));
  if (want) return want;
  return DEFS.find(d => available(d)) || null;
}

module.exports = { list, resolve, DEFAULT_AGENT: 'claude' };
