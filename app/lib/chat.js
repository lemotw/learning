// 自答題批改。對話已經搬到 agents.js + drivers/,這裡只留批改。
// 批改刻意不給選 agent 也不給選模型:評分標準要跨時間可比,固定模型才有這個保證。
'use strict';

const claude = require('./drivers/claude');

/** 從模型回覆萃取 JSON(容忍 ```json fence 或前後閒話) */
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const m = candidate.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON found in model output');
  return JSON.parse(m[0]);
}

module.exports = { oneShot: claude.oneShot, extractJson };
