# learning — 個人化學習系統

課程生成(pipeline)+ 講義閱讀與學習管理(app)+ 課程關聯知識圖譜(IE 管線)一體的自架系統。
課程內容是純 markdown,由自製 reader 直接渲染,不需 build;所有 AI 工作(生成、助教、批改、概念萃取)
走本機 `claude` CLI 或本機 Ollama,執行期零外部 API 依賴。

> `courses/`(課程內容與個人診斷資料)不進版本控制,只存在本機。

## 系統架構

三層分離,職責單向流動:

```
┌─ 生成層 pipeline/ ──────────────────────────────────────────┐
│ prompts/(診斷、程度分析、單元撰寫、概念萃取規格)             │
│ templates/(meta.json / AGENDA / 單元骨架)                   │
│ verify.sh(機械驗收) relations.js(關聯計算)                │
└──────────────┬──────────────────────────────────────────────┘
               │ 生成(LLM 在場的 session)
               ▼
┌─ 內容層 courses/<slug>/(唯讀、gitignored)──────────────────┐
│ meta.json(標題/狀態/concepts/relations/archivedAt)         │
│ DIAGNOSTIC.md(診斷問答,永久留檔)  AGENDA.md(課綱)       │
│ units/*.md(講義)  labs/(實驗檔)                          │
└──────────────┬──────────────────────────────────────────────┘
               │ 讀取
               ▼
┌─ 應用層 app/ ───────────────────────────────────────────────┐
│ server.js(零依賴 Node)+ lib/(db / content / chat)        │
│ web/(index 課程列表+圖譜、reader 閱讀器)                   │
│ data/(唯一可寫:SQLite 狀態、embed 快取、graph-auto.json)  │
└─────────────────────────────────────────────────────────────┘
```

設計原則:**內容層對一般 app 流程永遠唯讀;一切學習狀態集中在 `app/data/`**。唯一例外是
`app/lib/course-lifecycle.js`:它是受控邊界,只能原子更新 `meta.json` 的封存狀態,不搬移、不刪除任何課程檔。課程 md 是唯一真相,
資料庫壞了只丟學習記錄不丟內容。

## 課程生成流程(`/new-course`,skill 驅動)

```
1 使用者說要學什麼
2 診斷出題(6-8 題開放式 + 背景題;難度梯度:基礎→進階→超綱)── 必停:等作答
3 程度分析:答案分 ✅已有/❌誤解/⬜空白 三桶(引用原話)→ 提議課綱
   (單元數 = 洞聚類結果 6-12 + 整合單元,不硬湊固定數)
4 課綱確認 ── 必停:等回饋 → 固化 DIAGNOSTIC.md / AGENDA.md / meta.json
   此刻同步做概念萃取(見下)寫入 meta.json concepts
5 平行派 agent 生成單元講義(每 agent 3-4 個單元)
6 verify.sh 機械驗收(行數/必含區段/keywords 可解析)→ 跑 relations.js 更新關聯
7 DIAGNOSTIC.md 永久留檔(助教與批改的個人化依據)
```

### 單元講義格式規約

```markdown
# Unit N:標題 —— 一句副標

> **定位**:2-4 句,對應診斷哪個洞、與其他單元的依賴。

## 1. 原理小節(每節回答一個「為什麼」)…

## Lab
具體可執行(工具/步驟/記錄什麼),或閱讀任務 + 帶著找答案的問題。

## 自答題
<!-- q1 keywords: 概念A, 概念B -->   ← 批改評分準繩,渲染前剝除、作答前不顯示
**Q1:題目**
```

驗收豁免標記:`<!-- verify: skip=lines,lab -->`(整合/附錄類特例)。

## 學習狀態(SQLite,`node:sqlite` 零依賴)

| 表 | 內容 |
|---|---|
| `progress` | 每單元 unread/reading/done + 時間 |
| `records` | append-only 學習流水帳(read/selfcheck/chat/lab) |
| `selfcheck_attempts` | 自答題歷次作答:答案、verdict(pass/redo)、AI 評語 |
| `chat_sessions` / `chat_messages` | 助教對話 session 對應與全文 |

回爐佇列 = 每題最新一次作答為 redo 的集合(一句 SQL)。

## AI 助教(reader 右側欄)

後端 spawn 本機 `claude` CLI headless(走訂閱,無 API key):

- 首輪 `--append-system-prompt` 載入:**本單元講義全文 + 該課 DIAGNOSTIC.md + AGENDA.md**
  ——助教知道使用者當初哪題答錯、前後單元教過什麼,回答針對個人的洞
- 之後 `--resume <session_id>` 續聊,context 不重送;session id 存 SQLite,server 重啟可續
- `--output-format stream-json --include-partial-messages` 逐段串流,server 轉 SSE 給前端
- 工具全鎖(`--disallowedTools Bash,Edit,…`),助教只答題不動檔案

## 自答題 AI 批改

1. 題目旁的 `<!-- qN keywords -->` 是給 AI 的評分準繩(同義說法也算對,不做字串比對)
2. 送出 → `claude -p` 一次性呼叫,輸出 JSON `{verdict, missing, feedback}`
3. 批改後才顯示必含概念;歷次作答留存;回爐題進首頁佇列

## 課程關聯知識圖譜(Information Extraction 管線)

圖譜的邊全部由 IE 管線自動產生。分兩期:

**生成期(LLM 在場,零額外成本)**——概念萃取,規格見 `pipeline/prompts/concepts.md`:

- 從 AGENDA 萃取 8-12 個概念 `{name, desc}`:裸名詞片語(2-10 字)+ 一句定義(15-30 字)
- 禁模板/教學詞(單元、Lab、診斷…)——文體詞會汙染比對
- 寫入 meta.json `concepts`;講義大改時由改動的 session 重萃取

**執行期(`pipeline/relations.js`,純本機、零 LLM)**:

```
讀 active 課的 concepts → Ollama bge-m3 embed「name——desc」(內容 hash 快取)
→ centering(減全概念平均向量,消同文體基線/anisotropy)
→ 雙向 MaxSim(A 每個概念到 B 取最佳 cosine,平均;ColBERT late interaction)
→ 空隙偵測(分數排序取最大相鄰落差切線)選邊
→ 輸出 app/data/graph-auto.json(含 top 概念配對當證據,自動組 why)
```

- 手動覆寫層:meta.json `relations`(平時空;要標 `prereq` 方向或宣告 IE 沒抓到的邊才用),
  同配對手動優先
- `/api/graph` 合併兩源;前端 tooltip 顯示相似度 + 概念呼應證據。封存課不參與預設圖譜，還原後背景重算
- Ollama 未啟動時腳本優雅跳過,保留上次結果

### 選型依據(實驗封存於 `archive/relations-experiments/`)

以人工判定的關聯為基準,對照三路線:整份 embed + 幾何後處理(centering 有效、ABTT 小語料翻車)、
概念萃取 + MaxSim(唯一排序全對,自帶證據)、指令式 embedding(qwen3-embedding,免後處理但壓不掉模糊邊)。
結論與文獻一致:關係發現用 GraphRAG 式 schema-guided extraction + multi-vector late interaction 為主幹。

## 課程封存與來源搜尋

封存是 `meta.json` 的狀態轉移，不是刪除：`active → archived → active`。

- **保留一切資料**：`courses/<slug>/` 原路徑不動，講義／課綱／labs／DIAGNOSTIC，以及 SQLite 的進度、自答與助教歷程均不刪除。
- **工作面隔離**：首頁、總進度、待回爐、預設知識圖譜只出 active 課；封存課在首頁「封存」tab 瀏覽。
- **唯讀回看**：封存講義仍能閱讀、看歷史自答與助教對話；progress、批改與新助教訊息由前後端共同停用。還原後直接接續原進度。
- **來源搜尋**：封存 tab 可搜尋課名、tags、concepts、`AGENDA.md` 和 `units/*.md`。搜尋是依檔案 mtime/size 增量建立的記憶體 snapshot，source 仍是唯一真相；初版刻意不索引 DIAGNOSTIC、SQLite 歷程與 labs。
- **併發**：助教串流或批改進行時暫拒封存（409），避免操作完成後寫進已封存課。

## 離線閱讀(PWA)

`app/web/sw.js` + `pwa.js` + `manifest.json`,零依賴、無 build,server 端只加了三個 MIME 型別:

- **快取策略**:shell(html/css/pwa.js)stale-while-revalidate;vendor cache-first(換檔手動 bump `sw.js` 的 `CACHE_VERSION`);GET `api/*` network-first(4s timeout)斷線退快取;**非 GET 完全不攔**(進度/批改/助教 SSE 原生走網路)
- **內容預下載**:index 在線載入後把全部 active 單元的講義+自答歷史+助教對話抓一輪進快取(30 分鐘節流,單元數變動即重抓);封存課只在使用者主動開啟後依正常 GET 快取
- **離線判定**:SW 退快取時加 `X-Sw-Cache: hit` 標頭,頁面據此顯示離線徽章並停用助教/批改/進度按鈕(不用 `navigator.onLine`——手機有網路但不在 tailnet 時它會誤判)
- 手機:以 ts.net HTTPS 造訪一次後即可離線閱讀;建議「加入主畫面」(iOS 對主畫面 App 豁免 7 天儲存回收)
- 路徑全相對,根路徑與反代子路徑(`/learning/`)部署皆可

## 部署

- launchd `com.lemotw.learning-hub`(開機自啟、崩潰重拉),port 4600
- Tailscale Serve `--https=4600` 供 tailnet 存取
- 開發:`node app/server.js`;環境變數 `PORT` / `COURSES_ROOT` / `CLAUDE_BIN` / `CHAT_MODEL` / `OLLAMA_URL`

## 常用指令

```bash
node app/server.js               # 起 hub(http://127.0.0.1:4600)
./pipeline/verify.sh <slug>      # 驗收一門課
node pipeline/relations.js       # 重算課程關聯(需本機 Ollama + bge-m3)
node pipeline/ingest-mkdocs.js <srcDir> <slug>   # 匯入舊 mkdocs 課程
```
