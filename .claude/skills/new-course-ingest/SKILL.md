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
3. **程度分析**:依 `pipeline/prompts/assess.md` 分 ✅/❌/⬜ 三桶(引用原話),提議 agenda(單元數 = 洞聚類結果 6-12 + 整合單元)與課程關聯(讀 `courses/*/meta.json` 提議 relations)。
4. **給使用者看,等回饋修改**。確認後固化:`courses/<slug>/DIAGNOSTIC.md`、`AGENDA.md`、`meta.json`(照 `pipeline/templates/`;slug 用英文 kebab-case),並建 `units/` 佔位檔(只有 `# Unit N:標題` 一行)、`labs/`。固化 meta.json 時**依 `pipeline/prompts/concepts.md` 規格從 AGENDA 萃取 8-12 個概念填入 `concepts`**(name + desc,禁模板詞)——這是課程關聯自動計算的資料來源;萃取在此刻做掉,關聯腳本執行期就完全不需要 LLM。
5. **平行生成講義**:用 `pipeline/prompts/unit-writer.md` 模板派 agent,每個 agent 3-4 個單元、同一則訊息平行發出。格式重點:markdown-it 可渲染(禁 `!!!`)、`## Lab`、`## 自答題` + `<!-- qN keywords: ... -->` 緊貼題目上一行。
6. **驗收**:跑 `./pipeline/verify.sh <slug>`;不過的單元帶評語重派。過了把 meta.json 的 `status` 改成 `active`,接著跑 `node pipeline/relations.js` 更新自動關聯(純本機,需 Ollama;不在就會自行跳過)。瀏覽器開 `http://127.0.0.1:4600/reader.html?course=<slug>&unit=01-….md` 抽讀確認渲染正常。
7. **診斷永久留檔**:DIAGNOSTIC.md 不得刪除——reader 的 AI 助教與自答題批改都靠它個人化。

## 必停點

步驟 2(等作答)與步驟 4(等課綱確認)是僅有的兩個必停點,其餘自動執行。

## 原則

- `courses/` 對一般 app 流程是唯讀;學習狀態都在 `app/data/learning.db`,不要往課程目錄寫狀態。唯一例外是 course lifecycle 的封存／還原會原子更新 `meta.json.status`（`active ↔ archived`），不搬移或刪除 source。
- 講義品質紅線:教為什麼、點名修正誤解(引用原話)、Lab 可執行或給閱讀任務、失敗案例並重。
- 不確定關聯就不要硬連;`relations` 是手動宣告的權威邊,寧缺勿濫(自動候選邊由概念比對腳本另行產生,兩者分開存)。
- **講義或課綱大幅改動時,同一個 session 要順手依 `pipeline/prompts/concepts.md` 重萃取 concepts**——概念過期會讓自動關聯失準。
