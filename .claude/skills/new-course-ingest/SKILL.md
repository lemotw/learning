---
name: new-course
description: 在本專案建立一門個人化課程(診斷 → 程度分析+課綱 → 確認固化 → 平行生成講義 → 驗收)。使用者說「我想學 X」「開一門 X 的課」時使用。用法:/new-course <主題>
---

# 建立新課程(learning hub 版)

本專案的課程由 `app/`(reader/關聯圖/AI 助教)直接渲染,**不用 mkdocs、不需 build**。
主題來自指令參數;沒給就先問。

## 七步流程

1. **使用者說要學什麼**(指令參數/對話)。
2. **診斷出題**:依 `pipeline/prompts/diagnostic.md` 出 6-8 題 + 1-2 題背景題,**停下來等作答**。難度不能都太貼合已知、也不能離太遠。
3. **程度分析**:依 `pipeline/prompts/assess.md` 分 ✅/❌/⬜ 三桶(引用原話),提議 agenda(單元數 = 洞聚類結果 6-12 + 整合單元)與課程關聯(讀 `courses/active/*/content/meta.json` 提議 relations)。
4. **給使用者看,等回饋修改**。確認後先跑 `node pipeline/course-tool.js init <slug>`,再固化到 `courses/staging/<slug>/content/`: `DIAGNOSTIC.md`、`AGENDA.md`、`meta.json`(照 `pipeline/templates/`;slug 用英文 kebab-case),並建 `units/` 佔位檔、`labs/`。固化 meta.json 時**依 `pipeline/prompts/concepts.md` 規格從 AGENDA 萃取 8-12 個概念填入 `concepts`**。`course.json` 與 `state/` 由 course-tool 管理,生成 agent 不得改動。
5. **平行生成講義**:用 `pipeline/prompts/unit-writer.md` 模板派 agent,每個 agent 3-4 個單元、同一則訊息平行發出。格式重點:markdown-it 可渲染(禁 `!!!`)、`## Lab`、`## 自答題` + `<!-- qN keywords: ... -->` 緊貼題目上一行。
6. **驗收與啟用**:先跑 `node pipeline/activity-tool.js merge courses/staging/<slug>/content/_activity-fragments --out courses/staging/<slug>/content/activities.json --content courses/staging/<slug>/content`(沒有 fragment 就保留空 manifest),再跑 `./pipeline/verify.sh <slug>`。通過後執行 `node pipeline/course-tool.js activate <slug>`；課程是否 active 由 bundle 位於 `courses/active/` 決定,不再寫 meta.status。接著跑 `node pipeline/relations.js`。
7. **診斷永久留檔**:DIAGNOSTIC.md 不得刪除——reader 的 AI 助教與自答題批改都靠它個人化。

## 必停點

步驟 2(等作答)與步驟 4(等課綱確認)是僅有的兩個必停點,其餘自動執行。

## 原則

- 每門課是 course bundle:`content/` 唯讀、`state/state.sqlite` 保存該課狀態。生成流程只能更新 staging `content/`,不得刪除或改寫 active bundle 的 `state/`。
- 封存／還原由 `courses/active/<slug> ↔ courses/archived/<slug>` atomic rename 表達；不要手改 meta.status。
- Activity 定義在 `content/activities.json`,todo/doing/done 只存在 state.sqlite；不得把 mutable state 寫進 JSON 或 markdown checkbox。
- 自訂呈現是 optional course-local plugin：在 `content/views.json` 宣告；課程共用導覽用 `courseDrawer` 指向 view id，特定內文位置才用 Markdown 的 ```` ```view ```` fence。HTML 放 `content/views/`，只能走 Reader bridge，不能直接 fetch API；一般圖解仍用 Mermaid。
- 講義品質紅線:教為什麼、點名修正誤解(引用原話)、Lab 可執行或給閱讀任務、失敗案例並重。
- 不確定關聯就不要硬連;`relations` 是手動宣告的權威邊,寧缺勿濫(自動候選邊由概念比對腳本另行產生,兩者分開存)。
- **講義或課綱大幅改動時,同一個 session 要順手依 `pipeline/prompts/concepts.md` 重萃取 concepts**——概念過期會讓自動關聯失準。
