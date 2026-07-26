# 助教可選 agent（claude / pi）實作方案

> 狀態：**方案，未實作**。以下所有「實測」標記的結論都在 2026-07-27 於本機驗證過；
> 其餘為設計提案。批改（selfcheck grading）不在本方案範圍，維持走 claude。

---

## 1. 為什麼要做

現在 `app/lib/chat.js` 把後端寫死成本機 `claude` CLI headless（`-p --output-format stream-json`），
多輪靠 `--resume <session_id>`。單元助教只有這一條路。

本機另外裝了 `pi`（`/opt/homebrew/bin/pi`，v0.80.6），是另一套 agent CLI，
能力邊界與模型選擇都不同。想讓助教可以切換，等於多一個「換一顆腦袋問同一份講義」的選項。

---

## 2. 實測結論：pi 接得起來

四項關鍵能力都驗過，不是推測。

### 2.1 串流格式對得上（實測）

```bash
pi -p --mode json --no-tools --no-session --no-extensions --no-skills "回答兩個字:測試"
```

吐 NDJSON，每行一個事件。文字增量在：

```
message_update → assistantMessageEvent.type === 'text_delta' → .delta
```

事件序列：`session` → `agent_start` → `turn_start` → `message_start`(user) →
`message_end`(user) → `message_start`(assistant) → `message_update`×N →
`message_end` → `turn_end` → `agent_end` → `agent_settled`。

對照現在 claude 的 `stream-json`，兩者都是「一行一個 JSON 事件、逐 token 吐 delta」，
差別只在欄位路徑。**一個 adapter 就能收斂成同一個 `onDelta(text)` 介面。**

### 2.2 固定 session id 可續聊（實測）

`--session-id <id>` 的語意是「用這個 id，不存在就建」。兩次**獨立的 process 呼叫**：

| 呼叫 | 輸入 | 回應 |
|---|---|---|
| 1 | `--session-id learning-k8s-05 "記住數字 4173,只回 ok"` | `ok` |
| 2 | `--session-id learning-k8s-05 "剛剛叫你記的數字?只回數字"` | **`4173`** |

記憶跨 process 保住了。

**這件事的意義**：session id 可以由 `course + unit` 直接推導，不必等 CLI 回傳再存。
也就是說走 pi 這條路時，`chat_sessions` 表在功能上是多餘的
（但**仍要保留**，理由見 §4.2）。

### 2.3 session 是可讀的 jsonl（實測）

```
~/.pi/agent/sessions/<escaped-cwd>/<ISO時間>_<uuid>.jsonl
```

每行一個帶 `type` 的物件：`session`（含 `cwd`/`id`/`version`）、
`session_info`（含自動產生的 `name` 標題）、`message`、`model_change`、
`thinking_level_change`。

`message` 行的 `message.role` 有三種：`user` / `assistant` / **`toolResult`**。
content 是 parts 陣列（`[{type:'text', text:'...'}]`）。

目錄名是 escaped cwd → **session 綁 cwd**。`--session-dir <dir>` 可覆寫
（實測有效，優先序：`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `<agentDir>/sessions`）。

### 2.4 有現成參考實作

`~/lemo/repo/archived/pi-web`（Go，自己封存的）就是 pi 的 web UI。可直接抄的部分：

| 檔案 | 內容 |
|---|---|
| `internal/rpc/prompt.go:44` | 一次性提問的旗標組合：`--mode rpc --no-session --no-tools --no-extensions --no-context-files` |
| `internal/rpc/worker.go:72` | 長駐 `pi --mode rpc` worker pool，省掉每輪 spawn 冷啟動 |
| `internal/sessions/` | session jsonl reader |
| `internal/agentdir/agentdir.go` | session dir 優先序的處理 |

> 註：`--mode rpc` 是長駐雙向協定，`--mode json` 是一次性。
> 本方案用 `json` 就夠 —— 現在 chat.js 也是每輪 spawn，沒有比現況差。

---

## 3. 必須先接受的兩個差異

### 3.1 模型會變，而且不受本專案控制

實測那次 pi 跑的是 **`openai-codex` / `gpt-5.6-terra`**（pi 的 `--provider` 預設是
`google`，實際落點由使用者的 pi 設定決定）。

而 `app/lib/chat.js` 上一版才刻意把模型釘死：

```js
const CHAT_MODEL  = process.env.CHAT_MODEL  || 'claude-sonnet-5';
const GRADE_MODEL = process.env.GRADE_MODEL || 'claude-sonnet-5'; // 固定模型讓評分標準穩定
```

**結論：助教可以接 pi，批改不要。** 批改要的是跨時間可比的評分標準，
換模型等於毀掉那個保證。本方案完全不動 `gradeAnswer()`。

### 3.2 session 不能跨 agent 續聊

claude 的 session 在 `~/.claude/projects/`，pi 的在 `~/.pi/agent/sessions/`，
格式與 id 空間都不同。**用 claude 開的對話無法交給 pi 續聊，反之亦然。**

所以「切換 agent」的正確語意是**開一段新對話**，不是接著聊。
UI 必須把這件事講清楚，否則使用者會以為助教突然失憶。

---

## 4. 實作方案

### 4.1 新增 `app/lib/agents.js`：driver registry

把「怎麼叫起一個 agent」抽成 driver，`chat.js` 只保留 claude driver 的內容並改為被註冊。

```js
// app/lib/agents.js
// 每個 driver 提供 stream({ message, systemPrompt, resume, onDelta }) → { sessionId, text }
// resume 的型別由 driver 自己解讀:claude 是 CLI 給的 UUID,pi 是我們自己命名的 id。

const AGENTS = {
  claude: {
    label: 'Claude',
    note: '預設。模型釘在 claude-sonnet-5,口吻與批改一致。',
    stream: require('./drivers/claude').stream,
  },
  pi: {
    label: 'pi',
    note: '本機 pi CLI,模型由你的 pi 設定決定(實測落在 gpt-5.6-terra)。',
    stream: require('./drivers/pi').stream,
  },
};

function available() {
  // pi 沒裝就不要出現在選單裡。用 which 探一次,結果快取在 module scope。
  ...
}
```

**pi driver 的參數**（對齊現在 claude driver 的「助教不碰工具」原則）：

```js
const args = [
  '-p', '--mode', 'json',
  '--no-tools', '--no-extensions', '--no-skills', '--no-context-files',
  '--session-dir', PI_SESSION_DIR,          // app/data/pi-sessions,自己管不跟著 cwd 跑
  '--session-id', sessionIdFor(course, unit, seq),
];
if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
```

- `--no-context-files` 一定要加：不然 pi 會去讀專案的 `AGENTS.md` / `CLAUDE.md`，
  那些是給 coding agent 的指令，不該污染助教的 context。
- `--session-dir` 指到 `app/data/pi-sessions`：server 的 cwd 不保證固定，
  用預設路徑會讓 session 散在不同 escaped-cwd 目錄下。
- session id 命名：`learning-<course>-<unit 去掉 .md>-<seq>`，
  `seq` 是該單元第幾段對話（對應「＋新對話」）。

**delta 解析**：

```js
if (ev.type === 'message_update') {
  const e = ev.assistantMessageEvent;
  if (e && e.type === 'text_delta' && e.delta) onDelta(e.delta);
}
if (ev.type === 'message_end' && ev.message.role === 'assistant') {
  finalText = ev.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
}
```

> `message.content` 裡的 `textSignature` 欄位是 provider 的內部簽章，直接忽略。
> 若哪天開了 tools，`role === 'toolResult'` 的訊息也要在這裡濾掉。

### 4.2 DB：`chat_sessions` 加一欄 `agent`

**保留 `chat_sessions` 表**，即使 pi 的 session id 可推導 —— 因為要記「這段對話是哪個
agent 開的」。沒有這欄，重新載入頁面後就無法決定該用哪個 driver 續聊。

```sql
ALTER TABLE chat_sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude';
```

`db.js` 現在是用 `CREATE TABLE IF NOT EXISTS` 開場，加欄位要另外處理既有 DB
（目前有 27 筆 session、170 則訊息，全部是 claude 開的，所以 `DEFAULT 'claude'` 正確）：

```js
// 冪等 migration:欄位已存在就跳過
const cols = db.prepare('PRAGMA table_info(chat_sessions)').all().map(c => c.name);
if (!cols.includes('agent')) {
  db.exec("ALTER TABLE chat_sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'");
}
```

`addChatSession(course, unit, sessionId, agent)` 加第四個參數；
`latestChatSession()` 回傳值多帶 `agent`。

### 4.3 Server：`/api/chat` 收 `agent` 參數

`app/server.js:236` 的 POST handler：

```js
const { course, unit, message, newSession, agent } = await readBody(req);
const prev = newSession ? null : store.latestChatSession(course, unit);

// 切 agent 等於開新對話 —— session 不能跨 agent 續聊(§3.2)
const use = agent || (prev ? prev.agent : 'claude');
const resume = (prev && prev.agent === use) ? prev.session_id : null;

const { sessionId, text } = await agents.get(use).stream({
  message,
  resume,
  systemPrompt: resume ? null : tutorSystemPrompt(course, unit, raw),
  onDelta: (t) => send('delta', { text: t }),
});
if (!resume && sessionId) store.addChatSession(course, unit, sessionId, use);
```

這段的關鍵是 `resume` 的判斷條件：`prev.agent === use`。
使用者換 agent 時 `resume` 變 `null` → 自動帶上 `systemPrompt` 重開一段，
不會拿 claude 的 session id 去餵 pi。

另外加一個 endpoint 讓前端知道有哪些選項（pi 沒裝就不該出現在選單）：

```
GET /api/agents → [{ id, label, note, available }]
```

### 4.4 前端：選單放哪裡

`reader.html` 的對話 panel header 已經很擠 —— 380px 側欄裡
`單元助教` + 三顆按鈕就吃掉約 283px，之前副標題就是被擠成一字一行才修掉的。
**不要再往 header 塞東西。**

改放在 header 下面獨立一列（跟規劃中的「歷史 session 選單」共用這一列）：

```html
<div class="chatbar" id="chatBar">
  <select id="agentPick" title="選擇助教 agent"></select>
  <select id="sessPick" title="切換歷史對話"></select>
</div>
```

```css
.chatbar { display: flex; align-items: center; gap: 8px;
           padding: 6px 14px; border-bottom: 1px solid var(--border); font-size: 12px; }
.chatbar[hidden] { display: none; }   /* display:flex 會蓋掉 hidden,必須明寫 */
```

行為：

- 只有一個 agent 可用（pi 沒裝）時整列的 agent 選單隱藏，不要給假選擇。
- 選單值存 `localStorage`（跟 `chatFull` 一樣）—— 上一/下一單元是整頁重新載入。
- **切換 agent 時要明確提示會開新對話**，直接在 chatlog 插一則系統訊息比 alert 好：
  `── 已切換到 pi,以下是新的一段對話 ──`
- 送出時把當前選擇一起帶：`body: JSON.stringify({ course, unit, message, newSession, agent })`

---

## 5. 動到的檔案

| 檔案 | 動作 |
|---|---|
| `app/lib/agents.js` | **新增** — driver registry + 可用性偵測 |
| `app/lib/drivers/claude.js` | **新增** — 從現在的 `chat.js` 搬出 `streamChat()` |
| `app/lib/drivers/pi.js` | **新增** — `--mode json` 解析 + session id 命名 |
| `app/lib/chat.js` | 縮成只留 `gradeAnswer()`（批改，不動邏輯） |
| `app/lib/db.js` | `chat_sessions` 加 `agent` 欄 + 冪等 migration |
| `app/server.js` | POST `/api/chat` 收 `agent`；新增 GET `/api/agents` |
| `app/web/reader.html` | `.chatbar` 一列 + agent 選單 + 送出帶 agent |
| `app/web/style.css` | `.chatbar` 樣式 |

不動：`gradeAnswer()` 的行為、`selfcheck_attempts`、`redoQueue()`、圖譜與計分頁。

---

## 6. 風險與未決

| 項目 | 狀況 |
|---|---|
| pi 的模型不可控 | 由使用者 pi 設定決定，本專案無法保證。UI 的 `note` 要寫明。 |
| 冷啟動延遲 | 每輪 spawn 一次 pi。實測單輪可接受，但比 claude 慢多少**沒量過**。若成為問題，抄 pi-web 的 `--mode rpc` worker pool。 |
| pi session 的 GC | 不知道 pi 是否會自行清理舊 session 檔。若會，續聊會失敗 → driver 需要 fallback 成開新對話。**未驗證。** |
| 錯誤格式 | pi 失敗時吐什麼還沒測（只測過成功路徑）。`--mode json` 的 error 事件形狀需補驗。 |
| `toolResult` | 目前 `--no-tools`，不會出現。開了才要處理。 |
| 成本 | 實測一次極短對話 $0.00103（376 in / 6 out）。pi 走使用者自己的 provider 帳單，不經本專案。 |

---

## 7. 建議的實作順序

1. **先抽 driver 但不加 pi** —— 把 `chat.js` 的 `streamChat()` 搬到
   `drivers/claude.js`、建 registry，行為完全不變。這步可以獨立驗證沒改壞現況。
2. `db.js` migration + `/api/chat` 收 `agent`（值只可能是 `claude`）。仍然行為不變。
3. 加 `drivers/pi.js`，用 CLI 手動驗一輪 → 再接上 `/api/agents` 與前端選單。
4. 補 §6 那三項未驗證：pi 的 error 事件、session GC、冷啟動延遲。

前兩步是純重構，出事範圍可控；第 3 步才真的引入新行為。
