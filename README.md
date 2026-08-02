# learning — 個人化學習系統

課程生成(pipeline)+ 講義閱讀與學習管理(app)+ 課程關聯知識圖譜(IE 管線)一體的自架系統。
課程內容是純 markdown,由自製 reader 直接渲染,不需 build;所有 AI 工作(生成、助教、批改、概念萃取)
走本機 `claude` CLI 或本機 Ollama,執行期零外部 API 依賴。

> `courses/`(課程內容與個人診斷資料)不進版本控制,只存在本機。

## 系統架構

每門課是可獨立搬移的 course bundle；內容與狀態同 bundle、不同 ownership：

```
courses/
├─ active/<slug>/
│  ├─ course.json                 # 穩定 bundle identity
│  ├─ content/                    # 唯讀、可由 generator 重建
│  │  ├─ meta.json / DIAGNOSTIC.md / AGENDA.md
│  │  ├─ units/ / labs/
│  │  └─ activities.json         # 任務定義,不含 todo state
│  └─ state/state.sqlite         # 該課 progress/attempt/chat 的唯一真相
├─ archived/<slug>/              # 整個 bundle 封存後所在位置
└─ staging/<slug>/               # 生成與驗收中的 content

app/data/
├─ global-index.sqlite           # 跨課 projection,可由 bundles 重建
├─ graph-auto.json               # 關聯衍生資料
└─ embed-cache.json              # embedding 快取
```

設計原則：

- `content/` 對 app 永遠唯讀；生成器只能在 staging 產生並原子替換 content，不能碰 state。
- `state/state.sqlite` 是該課學習狀態的唯一真相；一門課壞掉不拖累其他課。
- active／archived 由 bundle 位於哪個目錄決定，不在 meta 重複保存 lifecycle state。
- `global-index.sqlite` 只服務首頁、跨課練習與待回爐查詢；刪掉後可掃 course bundles 重建。

## 課程生成流程(`/new-course`,skill 驅動)

```
1 使用者說要學什麼
2 診斷出題(6-8 題開放式 + 背景題;難度梯度:基礎→進階→超綱)── 必停:等作答
3 程度分析:答案分 ✅已有/❌誤解/⬜空白 三桶(引用原話)→ 提議課綱
   (單元數 = 洞聚類結果 6-12 + 整合單元,不硬湊固定數)
4 課綱確認 ── 必停:等回饋 → course-tool 建 staging bundle,固化 content
   此刻同步做概念萃取(見下)寫入 meta.json concepts
5 平行派 agent 生成 units + 各自的 activity fragments
6 activity-tool merge/validate → verify.sh → course-tool activate → relations.js
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

## 學習狀態與 Activity

每門課的 `state/state.sqlite` 包含：

| 表 | 內容 |
|---|---|
| `progress` | 每單元 unread/reading/done + 時間 |
| `activity_progress` | 通用任務 todo/doing/done；唯一 Activity 狀態軸 |
| `records` | append-only 學習流水帳 |
| `selfcheck_attempts` | 自答題歷次答案、verdict、AI 評語 |
| `chat_sessions` / `chat_messages` | 助教對話 session 與 transcript |

`content/activities.json` 只回答「課程安排了什麼」；SQLite 對 Activity 只記 `todo → doing → done`。Activity 可表示 exercise、Lab、reading、drill、project。course-local `id` 表示 assignment，`resource`（如 `leetcode:two-sum`）供跨課聚合。

`global-index.sqlite` 保存每課 revision 與 content fingerprint。App 寫入後立即更新 projection；首頁最多每五分鐘背景 reconcile，一天做一次 full integrity check，server 啟動檢查只是安全網。

### Course-local View plugin

View 由 `content/views.json` 宣告，entry HTML 放在 `content/views/`。設定 `courseDrawer` 的課程會在 Reader header 顯示「課程導覽」，按下後由左側開啟同一個 course-local View；助教則由右側開啟，兩者一次只開一個。Markdown 不需要重複掛載。

需要在講義特定位置呈現其他 View 時，仍可用 ```` ```view ```` fenced directive 明確掛載其 id。Reader 一律以只有 `allow-scripts` 的 sandbox iframe 載入；iframe 被 CSP 禁止連網，不能直接操作 Learning Hub API，只能透過 version 1 `postMessage` bridge 取得 Activity snapshot 或請求三態更新。沒有 View 的課程繼續使用標準 Activity 列表。

Canonical API 為 `GET /api/v1/courses/<slug>/activities` 與 `PATCH /api/v1/courses/<slug>/activities/<id>`；它直接 join course-local manifest 與 SQLite，不經 global index。NeetCode 的 `neetcode-dag` View 使用 18 個主題、21 條邊及原圖座標，題目本身只歸屬主題，不捏造題目間 prerequisite。

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

封存是同一 filesystem 上整個 bundle 的 atomic rename：

```text
courses/active/<slug> ↔ courses/archived/<slug>
```

- **保留一切資料**：content、state、進度、Activity 狀態、自答與聊天 transcript 一起移動，沒有資料複製或刪除。
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
node app/server.js                              # 起 hub(http://127.0.0.1:4600)
node pipeline/course-tool.js init <slug>         # 建 staging bundle
node pipeline/activity-tool.js validate <dir>   # 驗證 activities.json
./pipeline/verify.sh <slug>                      # 驗收一門課
node pipeline/course-tool.js activate <slug>     # staging → active
node pipeline/course-tool.js update-content <slug> # 只換 content,保留 state
node pipeline/relations.js                       # 重算 active 課程關聯
node pipeline/ingest-mkdocs.js <srcDir> <slug>   # 匯入到 staging bundle
```
