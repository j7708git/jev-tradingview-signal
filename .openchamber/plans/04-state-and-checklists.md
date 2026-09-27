# 現況與檢查清單

更新於 2026-09-28。

## 現在做到哪

Phase 0–4 / Task 01–15 **全數完成並通過真機 e2e**（詳 `docs/TASK.md`）。最近一次工作是**文件與程式碼
對齊**：補回 `WS-NOTES §7`（指標取證）、把 `ARCHITECTURE` 的目錄樹／§4.1 訊息表／§4.2.2／§4.4.1 對齊現況、
修掉 TRY-IT 與 OVERVIEW 的過時敘述、把 README 的測試數與二期功能補齊。**零程式碼改動。**

沒有進行中的任務。下一個需求由使用者提出後再開 Task 16。

## 每次改完必跑（綠才算完成）

```bash
npm test                                  # 期望 209/209
node scripts/static-check.mjs task02      # 四個 gate 各自帶參數跑，不帶參數只跑 task02
node scripts/static-check.mjs task06
node scripts/static-check.mjs task07
node scripts/static-check.mjs task08
node scripts/verify-inject.mjs            # 19/19
```

改了 content script 或 lib 的話，加跑真機：`node scripts/e2e-real-chrome.mjs`（Playwright Chromium，
全新 `--user-data-dir`）。改了面板/選項頁加跑 `node scripts/e2e-error-paths.mjs`（錯 key／斷網）。

## 明確不做（Non-Goal，別順手做）

- 不自動下單、不連券商／交易所 API。
- 不做回測、不做勝率統計面板。
- 不主動發自製訂閱幀（逃生門只留介面）。
- 不解析 Pine 語意（指標只送名稱／參數／數值，欄位通用 `v1..vn`）。
- 不做跨會話預測紀錄持久化（ring log 只在 SW 記憶體，20 筆，SW 回收即清）。
- 不上架 Chrome Web Store（目前「載入未封裝」個人用）。
- 不支援 tradingview.com 以外的圖表站、不做非 Chrome 適配。

## 若要繼續，可考慮的方向（都還沒簽核）

1. **指標欄位語意命名**：`v1..vn` 對模型不友善，但要懂 Pine plot 順序 → 與 Non-Goal 衝突，需先重新簽核。
2. **更聰明的預算裁剪**：目前是尾端等比裁窗；可改成依重要度挑指標。
3. **深歷史**：動用逃生門主動訂閱幀（會開始干擾頁面，風險上升）。
4. **ring log 匯出**（手動下載 CSV）——維持「不持久化」但方便回顧。
5. **上架評估**：架構已為此保留（零憑證、不散佈 key）。

## 新 session 起步建議

先讀這三份就夠了：`01-system-overview.md`（全貌與硬約束）、`02-tradingview-ws-protocol.md`（協定硬事實）、
`03-decisions-and-gotchas.md`（why 與地雷）。細節一律回 `docs/`。
