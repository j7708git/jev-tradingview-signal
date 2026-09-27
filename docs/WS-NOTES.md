# WS-NOTES — TradingView 資料協定取證報告（Task 01；§7 為 Task 12）

取證時間：2026-09-21（台北）· 方法：CDP `Page.addScriptToEvaluateOnNewDocument` 注入 `window.WebSocket` 包裝器（document 級、先於頁面腳本），純旁聽不修改。
（§1–§6＝Task 01 K 棒取證；§7＝Task 12 指標（study）取證，2026-09-22 補記於此，因 ARCHITECTURE §4.2.2 與 TASK.md Task 12 皆引用本節。）
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

## 6. 證據檔已知瑕疵（Task 03 實測發現，後續任务須知）

- fixtures 內 `symbol_resolved` 的 `p` 欄在導出時被 slice(1200) 截斷 → **非合法 JSON**（parse-evidence.mjs 與 ws-parse 測試皆以 regex 取 full_name 復建）。真實 ws 不受影響。
- `du` 為成交級推送：會覆寫 tsu 快照尾根並追加新根（實測 time 1789989900 close 84689.99→串流值、新增 1789990200）→ 逐值比對一律用 **tsu 還原序列**，串流語意另測（Task 03 測試已樹立典範）。
- `classifyPayload(payload, meta)` 第二參數為 pi 自加的型別後援（接受裸 p 陣列/meta.m），已核准納入契約，Task 06/07 可無視之。

## 7. 指標（study）取證（Task 12，2026-09-22 補記）

取證時間：2026-09-22（台北）· 場景：`BINANCE:BTCUSDT` 15m，掛 BB30／ALMA25／ALMA90／VRVP／Volume／CMF20／BarSet 七個研究。
證據檔：`tests/fixtures/ws-studies-real.txt`（37 行去識別幀；含 7 則上行 `create_study`、16 則 `du`）。

### 7.1 四個未知數的結論

| 未知數 | 結論 |
|---|---|
| ① studyId → 名稱／參數如何取得 | **取自上行 `create_study` 幀**（見 7.2）。Pine 原始碼加密（`options.text` blob）**不需解密**——身分與參數皆明文 |
| ② `st` 欄位形狀 | 完整逐根序列＋尾根即時增量；`v = [epoch秒, ...1–4 值]`，**以 `v[0]` 對齊 bars**（見 7.3） |
| ③ Pine 可辨識度 | built-in 指標 pineId 明文可辨識（`STD;Bollinger_Bands` 等）；自訂 Pine 有 pineId 或 `scriptName` 可降級識別；**非時序型指標（VRVP）`st` 恆空 → 自動排除** |
| ④ 識別鍵穩定性 | **`studyId` 由 client 生成並存於 layout，跨 reload 穩定**（實測 7 個中 6 個不變；唯一換號者為 TV 內部 `BarSetContinuousRollDates@tv-corestudies-47`，非使用者指標）→ `studyNameMap` 主鍵＝`studyId`，失效時 fallback `pineId`＋`in_*` 簽章 |

### 7.2 上行 `create_study`（`ws.send` 只讀觀察，不改動 send）

```
p = [cid, studyId, "st1", "sds_1", scriptName, options]
```

- `studyId`：6 碼字串（實測 `51IoAU`、`uNfUeE`、`p8FAfY`、`9Hn5lT`、`bkRG25`、`yl9zbk`、`xKKeY2`）。
- Pine 型（`options.pineId` 為字串）：`params` 取 `in_0..in_N`，每個值的真值在 `{v, f, t}` 包裝的 `.v`（`t` 為型別字串，如 `integer`／`float`／`resolution`／`source`／`bool`）。
- 直給型（無 pineId）：`params` 取具名參數，如 `Volume@tv-basicstudies-277` → `{length:20, col_prev_close:false}`。
- `options.text`（加密 Pine 正文）、`pineFeatures`、`__fast_calc`、`__profile` **永不進入 meta**（redact）。
- 實測 pineId 樣本：`STD;Arnaud%1Legoux%1Moving%1Average`（ALMA25/ALMA90）、`STD;Bollinger_Bands`、`STD;Chaikin_Money_Flow`；`%1` 還原為空白後即為指標全名。

### 7.3 下行 `du` 的 study 數值

```
du → p[1] = { "<studyId>": { st: [ {i, v:[time, ...1–4值]}, ... ] } }
```

- **忽略 `i` 欄位**：歷史批的 `i` 是負 sentinel（實測 `i = -1000100`），只有尾根增量為 `i = 299`；一律以 `v[0]`（epoch 秒）為 key 寫入。
- 首見即**逐批遞增**（實測每批 `n=5` 根，時間自 `1789692300` 推進到 `1790051400`），之後每則 `du` 只帶尾根（`n=1`）。
- **每 study 值數 1–4 可變**：ALMA25／ALMA90＝1 值；Volume＝3 值（`[當根值, 旗標 0/1, 累計值]`，實測 `[13.37, 1, 208.92]`）；BB＝3 值（上／中／下軌）；CMF20＝1 值。→ payload 欄位通用命名 `v1..vn`（plot 語意不可知）。
- `st` 恆空者（VRVP／`xKKeY2`）**自動排除**，非寫死指標清單。
- 時間軸與主圖 bars 同源（皆 `1790051400` 尾根），可逐根對齊。

### 7.4 實作對應（Task 13）

- `lib/ws-parse.js`：`parseCreateStudy`（上行身分）、`parseDuStudies`（下行數值；負 sentinel `i` 忽略、`st` 空自動排除、`sds_*` 鍵不誤認）。
- `content/inject.js`：包 `ws.send` **只讀記錄**（絕不改動 send 行為，static-check task06 持續 ALL PASS）。
- `lib/sw-core.js`：`entry.studies`（`Map<studyId, {meta, series:Map<time, values>}>`，每 study 上限 3000 根）＋ 新訊息 `STUDIES_UPSERT {v, meta, patches, gone}`。
- `lib/state-builder.js`：`buildStudies` → `state.studies`（`name` 取 `studyNameMap` 覆寫值、`rawName` 保留自動名、值窗與 bars 同窗口、缺值根 `null`、未掛指標為 `[]`）。
- 測試現況：`ws-studies-real` fixture 7 則 `create_study` 全解析、BarSet（`yl9zbk`）無值自動排除、redact 斷言 `text` 零殘留。
