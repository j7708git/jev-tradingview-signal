# TradingView 私有 ws 協定（硬事實）

逆向工程而來、**改版即失效**的東西。取證報告在 `docs/WS-NOTES.md`，證據檔在 `tests/fixtures/`。
這裡只留「改程式前必須知道」的部分。

## 連線與分幀

- 圖表資料只有一條：`wss://prodata.tradingview.com/socket.io/websocket?from=chart`。
- 分幀是 **socket.io 文字格式** `~m~<len>~m~<payload>`，一條 ws 訊息可含多幀；心跳 `~h~<n>` 丟棄。
  取證期間**零條二進位幀**；遇到 ArrayBuffer 一律計 dropped，不猜。
- 取數路徑是**旁聽**：只掛 `onmessage` 監聽，**絕不改动 `send`／`close`／回傳值**。

## Bar 形狀

- `v = [time, open, high, low, close, volume]`，time 為 **epoch 秒**、單調遞增。
- `timescale_update`（`p[1].sds_1.s[]`）給整段歷史，實測一次 **300 根**、`i = 0..299`。
- `du` 只推尾根（`i=299`），成交級持續覆寫 → ChartBuffer 必須是 upsert 語意。
- 每根的 `i` 在 study 的歷史批裡是**負 sentinel**（實測 `-1000100`）→ 一律以 `v[0]` 當 key，忽略 `i`。

## 主圖隔離（最容易出事的地方）

同一條 ws 上會同時推送多個 series：

```
reset sds_1 → meta sds_sym_1 (BINANCE:SOLUSDT) → bars sds_1 ×300
reset sds_2 → meta sds_sym_2 (INTERNAL:SEASONALS) → bars sds_2 ×366   ← 輔助，不是主圖
```

1. **主圖 series 恆為 `sds_1`**；`sds_2+` 一律丟棄並計 `ignoredSeriesFrames`。**666 根 = 300＋366 ＝污染狀態**，
   正常值是 300＋尾根。真機驗收有反污染斷言（根數須落在 250–400）。
2. **series 身分會重新編號**：站內換商品後 `sds_sym_1 → sds_sym_3`、`ss_1 → ss_2`。所以判主圖**不能**寫死
   身分索引，要看 `symbol_resolved` 的 `p[2].full_name`：以 `INTERNAL:` 開頭者一律忽略，其餘（真實商品）
   即使身分是 `sds_sym_3` 也要接受。
3. **真實商品變更才完整重置**（`bars.clear()` ＋ sent 游標）：否則換商品會把新舊 K 棒混在一起
   （真機實測過 300＋新資料＝337 根的污染值）。`INTERNAL:*` 的出現不得觸發清緩衝。
4. **嚴禁用 URL 的 `?symbol=` 推斷當前商品**——真機實測站內切換後 URL 不更新，唯一可信來源是主圖的
   `symbol_resolved`。
5. `timeframe` 不在下行協定裡 → 讀 `location.search` 的 `interval`，並與相鄰 bar 時間差交叉校驗。

## 指標（study）

- **身分取自上行 `create_study`**（`p = [cid, studyId, "st1", "sds_1", scriptName, options]`）：
  Pine 型讀 `pineId`（`%1`→空白）＋ `in_0..in_N`（真值在 `{v,f,t}.v`）；直給型讀具名參數。
  `options.text` 是加密 Pine 正文，**永不進入任何輸出**（redact）。
- **數值取自下行 `du` 的 `<studyId>:{st:[{i,v}]}`**，`v = [epoch秒, ...1–4 值]`，以 `v[0]` 對齊 bars。
- `st` 恆空者（TV 內部／非時序型，如 VRVP、BarSet）**自動排除**，不是寫死清單。
- `studyId` 由 client 生成並存在 layout，**跨 reload 穩定**（實測 7 個中 6 個不變）→ 使用者自訂名稱的
  持久化主鍵就是它。

## 已知地雷（Task 06fix / 09f / 09g）

- `WebSocket` 的 `CONNECTING/OPEN/...` 是**唯讀**常數。直接賦值會在 strict 下拋 TypeError，讓整段包裝中止
  （真機症狀：注入旗標在線、但 `window.WebSocket` 仍是原生）。正確做法：`Object.defineProperty` getter。
- `series_loading`（reset）若清掉「已寫入但尚未 flush」的 bar，300 根歷史會永遠消失 → **reset 只清已送出游標**。
- evidence fixture 裡 `symbol_resolved` 的 `p` 曾被 `slice(1200)` 截斷（非合法 JSON）→ 測試用 regex 復建
  `full_name`；**證據檔不可變**（曾有派工者擅自修它，被判定違規並還原）。
- 逐值比對一律用 tsu 還原序列；`du` 會覆寫尾根，屬協定語意而非缺陷。
