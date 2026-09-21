# WS-NOTES — TradingView 資料協定取證報告（Task 01）

取證時間：2026-09-21（台北）· 方法：CDP `Page.addScriptToEvaluateOnNewDocument` 注入 `window.WebSocket` 包裝器（document 級、先於頁面腳本），純旁聽不修改。
證據檔：`tests/fixtures/ws-evidence-btc-1m.json`（BINANCE:BTCUSDT 1m）、`ws-evidence-eth-15m.json`（BINANCE:ETHUSDT 15m，SPA 內切符號情境）。
驗證：`node scripts/parse-evidence.mjs <fixture>` → 兩檔 **ALL PASS**。

## 1. 連線與分幀

- 圖表資料 ws：`wss://prodata.tradingview.com/socket.io/websocket?from=chart`（page load 時新建一條；實測僅此一條承載圖表資料）。
- **分幀不是舊版 `/m\t` mem 協定，是 socket.io 文字分幀**：
  `~m~<len>~m~<payload>` 串接，一條 ws 訊息可含多幀；首幀常為 `~m~300~m~{"session_id":...}`。
  content script 的 `parseFrames()` 就照這個實作（§4.2 已同步修正）。
- 心跳：`~h~<n>` 型 payload → 直接丟棄（取證時每 5s 一次）。
- 取證中**零條二進位幀**（binary=0）；假設未來遇到 ArrayBuffer 一律計 `droppedFrames` 不猜。

## 2. 訊息型別（實測計數，BTC 1m 場）

| `m` | 角色 | 對我們的價值 |
|---|---|---|
| `symbol_resolved` | `[cid, "sds_sym_1", {full_name, name, currency_code, ...}]` | **符號元資料**（`p[2].full_name`） |
| `series_loading` | `[cid, "sds_1", "s1"]` | 載入開始 → **ChartBuffer 重置信號** |
| `timescale_update` | `[cid, {"sds_1":{node, s:[{i,v:6元組}×300], ns, t, lbs}}, ...]` | **整段 300 根歷史**（主菜） |
| `series_completed` | `[cid, "sds_1", "streaming", "s1", {rt_update_period:0}]` | 進入串流態 |
| `du` | `[cid, {"sds_1":{s:[{i:299, v:[...]}]} , <studyId>:{st:[...]}}]` | **尾根即時推送**（每筆成交級） |
| `study_loading/completed` + `du` 內的 6 碼隨機 key（`st` 欄） | 指標數值 | 第二期指標串接的入口（本次不消費） |
| `qsd` | watchlist/quotes 雜訊（本次 836 條） | 丟棄 |
| 第二型 `timescale_update` `[cid, {}, {index, zoffset, changes:[未來時間戳], marks}]` | 未來刻度排程 | 丟棄（注意别誤認成資料） |

## 3. Bar 欄位 Contract（已驗證）

- `v = [time, open, high, low, close, volume]`，time 為 **epoch 秒、單調遞增**；週期 = 相鄰 time 差（實測 60s/900s 兩檔皆對）。
- `s[].i` 為 `0..299` 連續索引；預設深度**固定 300 根**（`i=299` 恒為尾根）。
- OHLC 合法性（h≥max(o,c)、l≤min(o,c)）抽頭尾各 5 根全過。
- **交叉驗證**：tsu 尾根 close 84,689.99 == 頁面標題；du 串流值與 legend 的 O/H/L/C 逐欄對上。

## 4. 生命週期結論（直接決定實作）

1. **注入時機**：必須先於頁面建 ws → `registerContentScripts` + `world:'MAIN'` + `run_at:document_start` + `injectImmediately:true`。取證用 CDP 導航級注入模擬，實測成立（重載後 45 幀立即入帳）。
2. **換符號/週期（SPA 內，不重載頁面）**：觸發一整輪 `series_loading → tsu(新300根) → series_completed`，**cid 不變**、series key 仍叫 `sds_1`、舊 buffer 立即作廢 → **收到 `series_loading`(sds_*) 即重置 ChartBuffer**，無縫接手，旁聽方案在 SPA 情境同樣成立（ETH 場實測 tailDu 接手 index 正確）。
3. **timeframe 不在下行協定裡**：元資料來源定案為 `location.search`（TV 換符號/週期會同步改寫 URL：`?symbol=BINANCE%3AETHUSDT&interval=15`）＋ tsu 相鄰 time 差交叉校驗（不一致時以 URL 為準、記 warn）。
4. `du` 只推尾根 → 預測取數＝「tsu 整段 ＋ du 持續覆寫 i=299」，ChartBuffer 的 upsert 語意正確。
5. ws 斷線重連後會重演整輪 loading → 重置邏輯天然冪等。

## 5. 對 ARCHITECTURE 的修訂

§4.2 原文假設「空格分隔 mem 幀、MF××× 欄位、fields_order」→ **作廢**，改照本報告 §1/§2/§3。已回寫 ARCHITECTURE.md。
