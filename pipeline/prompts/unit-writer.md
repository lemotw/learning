# 單元撰寫 agent 的 prompt 模板(流程步驟 5)

派工時複製以下模板填入 `{...}`。每個 agent 負責 3-4 個單元,同一則訊息平行發出。

---

你在寫「{課程名稱}」個人化課程的單元講義(繁體中文,GitHub-flavored Markdown)。
講義由自製 reader 直接渲染 markdown-it:**不要用 mkdocs 的 `!!!` admonition 語法**;
引言區塊用 `>`,圖解用 mermaid fence 或 ASCII code block,對照用表格,程式碼 fence 標語言。課程共用 plugin 由 `content/views.json` 的 `courseDrawer` 掛到左側「課程導覽」；只有要插在特定內文位置時才用 ```` ```view ```` fence。不要把 HTML/JS 直接寫進 Markdown。

先讀兩個檔案:

1. `courses/staging/{slug}/content/DIAGNOSTIC.md` —— 使用者的已知/誤解/空白,內文要針對這些洞來寫。
2. `courses/staging/{slug}/content/AGENDA.md` —— 課綱。你負責單元的大綱每個要點都要展開成小節。

單元結構(必守,格式見 `pipeline/templates/unit.md.tmpl`):

```markdown
# Unit N:{標題} —— {一句副標,說出核心洞見}

> **定位**:2-4 句。這單元解什麼問題、對應診斷的哪個洞、和其他單元的依賴。

## 1. {原理小節}…(編號小節,每節回答一個「為什麼」)

## Lab
具體可執行:工具、步驟、要記錄什麼、預期看到什麼。做不出 lab 的單元,
改成「閱讀任務」:指定文獻/文件章節 + 要帶著找答案的 2-3 個問題。

## 自答題
<!-- q1 keywords: 概念A, 概念B, 概念C -->
**Q1:{題目}**
```

品質紅線:

- 每份 150-300 行(整合類 100-200)。**禁止名詞解釋化**:每個概念都要回答「為什麼是這樣設計」。
- 診斷裡的 ❌ 誤解要在內文**點名修正**:引用使用者原話,說明錯在哪、正確框架是什麼。
- 使用者答對的直覺先肯定再延伸。亮點概念要「正名」。
- 自答題 1-3 題;`<!-- qN keywords: ... -->` 註解**緊貼在題目上一行**(reader 靠它解析與批改,keywords 是給 AI 批改的評分準繩,同義說法也算對)。
- 案例要具體可查證;失敗案例與成功案例並重。
- 若單元要求使用者實際完成練習、Lab、閱讀或專案,另寫
  `courses/staging/{slug}/content/_activity-fragments/{unit-file}.json`。fragment 是 activity array,
  欄位遵守 `pipeline/schemas/activities.schema.json`;不得放 state/done/attempts。Activity id 建立後永久穩定。

任務:完成以下單元。檔案是佔位檔,先 Read 再 Write 完整覆寫:

1. `courses/staging/{slug}/content/units/01-xxx.md` —— 「{標題}」。{要點;**修正點:使用者把 X 說成 Y**}
2. …

完成後回報每個檔案路徑與行數。你的最終訊息是給主 agent 的資料,不是給使用者的。
