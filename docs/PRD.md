# PRD — jev-signal（TradingView × Jev 預測 Chrome Extension）

## 1. 背景與目標

Denny 在 Chrome 使用 TradingView 看圖。本專案做一個個人用 Chrome Extension：
按下按鈕後，extension 把**當前圖表已載入的全部 K 棒 OHLC（含成交量）**取出，
組成結構化 state，直接呼叫 **TypeSafe 官方 `/v1/systemone` API（Jev 模型）**，
取回**型別化、帶校準機率的盤勢判斷（做多／觀望／做空）**，顯示在 Side Panel。

明确定位：**判斷輔助工具，不是交易系統**。所有輸出僅供參考，不構成投資建議，絕不自動下單。

## 2. 使用者故事

- US1：作為看盤的人，我在任何 TradingView 圖表分頁點擴充圖示，Side Panel 打開並顯示「目前抓到的圖表：符號／週期／K棒數」，讓我知道它讀的是哪張圖。
- US2：作為看盤的人，我按「預測」按鈕，2 秒內（Jev 端 70–500ms＋網路）看到方向結論（做多／觀望／做空）、三項機率條、confidence，以及一句話狀態描述。
- US3：作為除錯的人，我能展開「原始 payload／原始回應」檢視實際送出的 JSON 與 API 回傳，不需開 DevTools。
- US4：作為金鑰持有者，我在擴充設定頁貼上 `TYPESAFE_API_KEY`，key 只存在瀏覽器擴充儲存區，從不顯示完整明文、從不送到除 api.typesafe.ai 以外的任何地方。
- US5：作為重度使用者，我可以調整送給 Jev 的 K 棒數量（預設最近 300 根）與派生特徵開關（MA20/50、RSI14、動量，預設開）。

## 3. 功能需求（每項附驗收標準）

| # | 功能 | 驗收標準 |
|---|------|---------|
| F1 | 圖表資料旁聽：注入頁面（world:MAIN）包裝 `window.WebSocket`，被動擷取 TradingView `mem` 協定中的 series OHLCV 增量，維護滚动緩衝 | 在 tradingview.com 開圖後，`chrome://extensions` service worker console 可查到 snapshot：`bars > 200`、欄位順序確認為 `[time,open,high,low,close,volume]`、time 為秒且單調递增 |
| F2 | 快照請求：service worker 向「活動分頁」要當前圖表快照（含符號、週期、最近 N 根 bar） | 同一瀏覽器開 2 個 TV 分頁（不同符號），對分頁 A 按預測，payload 中 symbol 確實是 A |
| F3 | 派生特徵：本地純數學計算 MA20/MA50/RSI14/動量/高低距，附加在 state 摘要區塊 | 對固定 fixture 計算結果與 expected 完全一致（容差 1e-9）；開關關閉時 state 中不出現 `features` |
| F4 | Jev 呼叫：`POST https://api.typesafe.ai/v1/systemone`，body 為 `{model:"jev-latest", state, questions}`；429/529 指數退避重試最多 3 次；10s 逾時 | 驗證腳本以 fixture state 實際呼叫，HTTP 200 且 `answers` 含 3 個預期的 question id 與各自型別欄位 |
| F5 | 結果呈現：Side Panel 顯示方向徽章（多=綠／觀=灰／空=紅）、三個選項的機率條、confidence、input token 數；錯誤狀態有明確中文訊息 | 人工試玩：換符號、斷網、錯 key 三種情況都有可分辨的 UI 狀態，不會永遠卡「預測中」 |
| F6 | 設定頁：API key（password 欄位）、模型（jev-latest/jev-preview）、bar 數（50–1000）、特徵開關 | 存錯鑰匙格式→可存但預測時給 401 中文提示；設定重載後保留 |
| F7 | 除錯輸出：payload 與回應 JSON 可在 Panel 展開複製 | 複製出的 JSON 用 `JSON.parse` 可解析（e2e 腳本以固定樣板驗證組裝邏輯） |

## 4. Non-Goals（明確不做）

- 不自動下單、不連任何券商／交易所 API。
- 不做歷史回測、不做勝率統計面板（第一期）。
- 不抓 TradingView 指標（study）數值——第一期只有 OHLCV＋本地派生特徵；指標串接留第二期。
- 不做跨會話預測紀錄持久化（只留 service worker 記憶體中的 ring log）。
- 不上架 Chrome Web Store（個人「載入未封裝」；架構不散佈憑證、保留日後上架可能性）。
- 不支援 tradingview.com 以外的圖表站。
- 不做手機版／非 Chrome 瀏覽器適配。

## 5. 成功標準（可測試）

1. 在真實 TradingView 圖表（任一格內符號＋任一常用週期）按「預測」，3 秒內 Side Panel 出現帶機率的判斷結果。
2. 全程不打開 DevTools：抓數、送 prediction、顯示結果一條線可用；出錯時 Panel 訊息能定位環節（取數失敗／API 拒絕）。
3. 一次預測成本 ≤ $0.005（依 usage.input_tokens 換算 $0.042/MTok 驗證）。
4. 程式碼中不存在任何明文 API key；`git grep` 驗證無 key 字串進 repo。

## 6. 決策記錄（使用者已確認／採建議預設）

| 決策 | 結論 | 來源 |
|------|------|------|
| Jev 接法 | extension 直打 TypeSafe 官方 API，繞過 jev-proxy（不新增後端） | 使用者明確選擇 |
| 取數方式 | 掛載頁面 WebSocket 旁聽（方案②） | 使用者明確選擇 |
| 取數深度 | 第一期只旁聽已載入 K 棒；協定層預留主動拉深度介面 | 建議預設（超時未答） |
| state 內容 | OHLCV＋本地派生特徵（MA/RSI/動量）；特徵開關可關 | 建議預設（超時未答） |
| 問題組合 | 三題：direction(choice)＋up_10_bars(noul)＋trend_strength(score) | 建議預設（超時未答） |
| 使用方式 | 手動按鈕→一次預測，Side Panel 顯示 | 使用者明確選擇 |
| 定位 | 個人工具，chrome://extensions 載入；好用再考慮上架 | 使用者明確選擇 |
