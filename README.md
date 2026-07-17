# learning — 個人化學習系統

課程生成(pipeline)+ 講義閱讀與學習管理(app)一體的專案。課程內容是純 markdown,
由自製 reader 直接渲染,不需 build。

## 架構

```
courses/     內容層(唯讀):每門課 meta.json + DIAGNOSTIC.md + AGENDA.md + units/*.md + labs/
pipeline/    生成層:診斷/分析/單元撰寫 prompts、模板、verify.sh 驗收
app/         應用層:零依賴 Node server + SQLite(node:sqlite)+ web UI
app/data/    狀態層(唯一可寫,gitignored):learning.db
```

## 功能

- **首頁 `/`**:學科關聯圖(cytoscape,課程節點可展開單元、點單元進講義)+ 進行中課程 / 待回爐 / 最近記錄
- **reader `/reader.html?course=&unit=`**:markdown 渲染(mermaid、highlight)、閱讀狀態、上一/下一單元
- **AI 助教側欄**:spawn 本機 `claude` CLI headless(走訂閱,不用 API key),
  首輪 `--append-system-prompt` 載入講義全文 + DIAGNOSTIC.md + AGENDA.md,之後 `--resume` 續聊;對話落 SQLite
- **自答題 AI 批改**:題目旁 `<!-- qN keywords: ... -->` 註解是評分準繩(作答前不顯示);
  批改回 pass/回爐 + 評語,歷次作答留存,回爐題進首頁佇列

## 開發

```bash
node app/server.js            # http://127.0.0.1:4600
./pipeline/verify.sh <slug>   # 驗收一門課
```

環境變數:`PORT`、`COURSES_ROOT`、`CLAUDE_BIN`(claude 絕對路徑)、`CHAT_MODEL`(助教模型,預設用使用者預設)。

## 開新課程

在專案目錄跑 Claude Code:`/new-course <主題>`(skill 在 `.claude/skills/new-course/`)。
七步流程:說要學什麼 → 診斷 6-8 題(停)→ 程度分析 + agenda + 課程關聯提議 → 確認後固化
DIAGNOSTIC/AGENDA/meta.json(停)→ 平行生成單元 → verify.sh 驗收 → 診斷永久留檔。

`courses/demo-http`、`courses/demo-git` 是驗證 app 用的 demo,可整個目錄刪除。
