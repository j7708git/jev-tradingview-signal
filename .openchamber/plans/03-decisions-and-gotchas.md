# 決策與地雷（為什麼這樣做 / 踩過什麼坑）

決策記錄的「why」在這裡；`docs/ARCHITECTURE.md` 有細節，`docs/TASK.md` 有逐次驗收證據。

## 決策（難以逆轉、有真取捨的）

1. **零依賴、無 build step**（不用打包器、不用測試框架）。個人工具，複製目錄就能用；維護性的基石是
   「改完直接載入，不用先跑工具鏈」。上架與否都不需要體重。
2. **直打 TypeSafe 官方 API，繞過 jev-proxy**（不新增後端、少一層故障點）。代價是 API key 進瀏覽器，
   因此 key 只存 `chrome.storage.local`、只在 fetch 瞬間成 header、任何 log 都不含片段。
3. **旁聽頁面 ws，不主動發訂閱幀**。代價是拿不到圖表沒載入的深度；換來的是完全不干擾頁面、且 TV 改版時
   失效面較小。逃生門（主動訂閱）保留介面但**刻意不實裝**。
4. **lib 分層：`sw-core.js` 零 `chrome.*`**。service worker 的邏輯因此能在 Node 裡直接單測，注入依賴做
   迴歸測試。這條規則不守，測試覆盖率會瞬間塌掉。
5. **指標以 `studyId` 為持久化主鍵、禁止寫死指標清單**。TV 的身分索引會跳號（`sds_sym_1→sds_sym_3`），
   寫死清單等於每次 TV 改版就壞。名稱鏈：使用者覆寫 → `ALMA(25)` 式自動名 → pineId 簽章。
6. **`trend_strength` 拆成 `bull_trend`／`bear_trend`**（使用者實測後要求）。舊回應仍相容渲染單列。
7. **K 棒不足 50 根直接拒預測**（`PREDICT_MIN_BARS`，單一來源在 `protocol.js`）。寧可回
   `insufficient_data`，也不要把 1 根 bar 送進模型——那會得到「觀望 91%」這種會被誤讀成訊號的垃圾。
8. **指標過多時裁值窗、不是砍指標**。API 輸入有物理上限（實測約 32K tokens），`fitStateToBudget` 只裁
   `studies[].values` 的尾端並標 `studiesTrimmed`；bars 不動。規格因此讓步：studies 值窗 ≤ bars 窗。
9. **手動按鈕觸發，不自動連續預測**。定位是輔助判斷，不是訊號機器。

## 地雷（踩過的坑，修法已在程式碼與測試裡）

| 症狀 | 根因 | 修法 |
| --- | --- | --- |
| 真機 `__JEV_HOOK=true` 但 ws 未被包裝 | 原生 ws 常數唯讀，賦值拋 TypeError 使整段中止 | 改 getter（static-check 與 MockWS 同步硬化，防假綠） |
| 開圖 30 秒只收到 1 根 bar | reset 落在節流窗內，清掉未 flush 的 300 根 | reset 只清已送游標；首觸／根數不足時 `REQ_SNAPSHOT{full:true}` 全量重送 |
| SW 偶發只剩 1 根 | MV3 SW 被回收，記憶體 registry 消失 | `lastActiveTabId` 存 `storage.session`；重啟後主動補全量 |
| 面板以分頁開啟時永遠「等待中」 | `isPanel` 只看 `sender.tab`（分頁時有值） | 改看 `sender.url` 是否屬本擴充 sidepanel/options |
| 面板顯示 666 根、做空 62% | 輔助序列 366 根混進主圖緩衝 | 只消費 `sds_1`＋真機反污染斷言；該次預測樣本作廢 |
| 換商品後 symbol 不更新、337 根 | 身分寫死 `sds_sym_1`；且 `INTERNAL:SEASONALS` 誤觸清緩衝 | 改看 `full_name` 內容判斷 |
| 多指標 payload 被 400/422 | `max_tokens_exceeded`（33K vs 上限 32K） | 預算守門 + `studiesTrimmed` |
| 自動化裝不了擴充 | branded Chrome 153 已移除 `--load-extension` | 改用 Playwright 自帶 Chromium |
| 重跑 e2e 拿到舊版行為 | 重複使用的 profile 載入舊 SW 快取 | 每次全新 `--user-data-dir` |
| TV 掛指標彈「Join for free」 | 未登入方案的牆 | 用 session cookie 轉移登入（值不入對話、不落檔） |

## 流程紀律

- 派工對象預設 pi，**一次只派一個、嚴格串行**；`scripts/` 與 `docs/` 屬架構師地盤。
- 驗收失敗**不整模組重寫**：根因編號寫進 TASK 該任務的完成紀錄，發最小修補 prompt。
- 真相來自真機：Task 01／09／12／14 的定案都是真機抓幀後回寫規格，不是從文件推測。
