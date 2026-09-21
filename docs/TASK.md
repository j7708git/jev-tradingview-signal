# TASK — jev-signal

嚴格串行；一次只派一個。`[ ]` 待辦 / `[-]` 進行中 / `[x]` 完成。
派工對象預設 **pi**（`pi -p`），驗收命令一律在專案根 `D:/Agent開發項目工作區/Typesafe_Jev/jev-signal` 的 git-bash 可執行。

> ⚠ 本專案與一般 web 專案的差異：Task 01 是**取證 spike**，由架構師親自在真實 Chrome＋TradingView 執行（需要登陸狀態的瀏覽器），pi 無法代替。pi 的派工從 Task 02 開始。

---

## Phase 0 — 風險消減

### [x] Task 01: TV ws 協定取證 spike（架構師執行，不派工）✅ 2026-09-21 ALL PASS
- 目標：證實「注入 world:MAIN 包 `window.WebSocket` → 旁聽 `mem` 幀 → 解出列式 OHLCV」這條路在當前 tradingview.com 可行，產出 1 份真實 ws 樣本與 1 份解析斷言。
- 產出物：`tests/fixtures/ws-sample-*.txt`（去敏感資訊的真實幀）、`docs/WS-NOTES.md`（欄位序、series key 規則、哪些幀型別有資料、dropped 統計）、最小 `parseMemFrames` 參考實作（放 `docs/` 附錄或臨時腳本，正式實作歸 Task 03）。
- 驗收：`node scripts/parse-fixture.mjs tests/fixtures/ws-sample-1.txt` 印出 ≥1 個 series、bar 數 ≥100、`fieldsOrder == [time,open,high,low,close,volume]`（time 為秒、單調递增）。
- 失敗分岔：若 TV 當前排協定與假設不符 → 就地修正 ARCHITECTURE §4.2 再往下；若注入拿不到 → 切到備援「直接呼叫 TV 資料端點」重寫 §4.2（需使用者再簽核）。
- [x] **完成（2026-09-21，架構師親自執行）**：全案假設成立，ALL PASS ×2。
  - 實測協定：socket.io 分幀 `~m~<len>~m~`（**非**舊 mem 幀）→ §4.2 已依實測改寫；整段歷史在 `timescale_update.p[1].sds_1.s[]`（300 根、`v=[t,o,h,l,c,v]` 秒級）；尾根即時在 `du`（實測 272 推送）；符號在 `symbol_resolved`；**timeframe 不在協定內**，定案讀 URL `interval`＋tsu 時間差交叉驗證。
  - 注入時機驗證：CDP 導航級注入＝未來 MV3 `world:MAIN+document_start+injectImmediately` 等價路徑，重載後首包即入帳；SPA 內切符號（ETH 15m）觸發完整重載入週期 → 新 300 根＋du 無縫接手（index 校驗通過）。
  - 交叉驗證：tsu 尾根 close 84,689.99 == 頁面標題價格；legend OHLC == du 串流值。
  - 證據檔：`tests/fixtures/ws-evidence-btc-1m.json`、`ws-evidence-eth-15m.json`、`bars-*-300.json`×2；解析器 `scripts/parse-evidence.mjs`；報告 `docs/WS-NOTES.md`。
  - 返修記錄：斷言初版要求「tsu 尾根 close == 最早 du close」失敗×2 → 根因：du 為成交級持續推送，快照後 230ms 即刷新 → 改為斷言「同一根 bar（i+time 相同）」與「最新 du close 已不同」，屬測試設計修正，非實作缺陷。

## Phase 1 — 純資料層（無浏览器依賴，pi 可全自動驗證）

### [-] Task 02: 骨架＋lib/protocol.js＋lib/chart-buffer.js（含測試）→ pi（2026-09-21 派工中）
- 目標：專案骨架（見 ARCHITECTURE §3 目錄）、manifest 佔位可載入；protocol 常數與 ChartBuffer（upsert/滚动上限/snapshot）＋`node --test` 全綠。
- Target Files: `extension/manifest.json`、`extension/lib/protocol.js`、`extension/lib/chart-buffer.js`、`tests/chart-buffer.test.mjs`、`tests/protocol.test.mjs`、`tests/fixtures/bars-300.json`、`package.json`（僅 scripts，無 dependencies）。
- 驗收：`node --test tests/` 全綠；`node -e "import('./extension/lib/chart-buffer.js').then(m=>{const b=new m.ChartBuffer(3000);console.log(b.constructor.name)})"` 輸出 `ChartBuffer`。
- [x] 完成紀錄：**2026-09-21 pi 執行，架構師親驗全綠**（`node --test` 12/12、ChartBuffer import OK、static-check task02 ALL PASS、git status 確認未越界）。pi 回報一項契約衝突（§4.5 動態註冊 vs gate 靜態宣告）→ 架構師定案改採**靜態宣告**（world:'MAIN' 自 Chrome 111 為 manifest 一級公民，省 `scripting` 權限），已修 ARCHITECTURE §4.5／static-check；pi 另測出 `TV_WS_URL_RE` 缺邊界錨點（`tradingview.com.evil.com` 誤判）→ 列為 Task 03 附帶修補項。

### [x] Task 03: ws-parse ＋ features.js（MA/RSI/動量）＋兩項附帶修補 ✅ 2026-09-21（pi）
- 目標：依 Task 01 的 WS-NOTES 實作協定解析（純函式，Node 可測）；features 純數學（SMA/RSI14 Wilder/動量/区间%），對 expected fixture 容差 1e-9。
- Target Files: `extension/lib/ws-parse.js`、`extension/lib/features.js`、`tests/ws-parse.test.mjs`、`tests/features.test.mjs`、fixtures。
- 驗收：`node --test tests/` 全綠；`node scripts/parse-fixture.mjs tests/fixtures/ws-sample-1.txt` 复現 Task 01 同一斷言。
- [x] 完成紀錄：**2026-09-21 pi 執行，架構師親驗全綠**（`node --test` 32/32＝12 舊零回歸＋20 新；static-check 含修補 B gate ALL PASS；regex 負例通過）。修補 A（TV_WS_URL_RE 錨點）＋修補 B（去 scripting）同場完成。pi 四項偏差全數核准：逐值比對改用 tsu 還原序列（du 會覆寫尾根，屬協定語意）、fixture 的 symbol_resolved 截斷瑕疵已記 WS-NOTES §6、RSI 教科書序列後段自然跌落 57.97（斷言據實收窄）、`classifyPayload` 第二參數後援納入契約。原驗收命令 `parse-fixture.mjs` 由 `scripts/parse-evidence.mjs`（Task 01 版）＋ws-parse 測試的 fixture 還原斷言取代。

### [x] Task 04: state-builder.js（含 questions 常數與特徵開關）✅ 2026-09-21（pi）
- 目標：snapshot＋features → §4.4 的 state JSON；`features:false` 時不出現 `features`；bars 截尾（預設 300）；token 估算函式 `estimateTokens(state)`。
- Target Files: `extension/lib/state-builder.js`、`tests/state-builder.test.mjs`、`tests/fixtures/expected-state.json`。
- 驗收：`node --test tests/` 全綠；`JSON.stringify(buildState(snap,{bars:300,features:true}))` 對 expected-state.json 深度相等（時間戳欄位正規化後）。
- [x] 完成紀錄：**2026-09-21 pi 執行，架構師親驗全綠**（`node --test` 43/43＝32 零回歸＋11 新；QUESTIONS 三 id 正確；golden sha256 二次生成 byte 相同；獨立重跑 deepStrictEqual true；`estimateTokens`=4231 → 300 根 state ≈4.2K token，成本上界再獲實據）。契約裁定：pi 問「barsWindow 過濾邊界」→ 以「實際送出根數」為準（本專案 bars 只來自 ChartBuffer，非法欄位不經產線路徑）；tests 內 pin TZ=Asia/Taipei 屬正當手法；`toLocalIso` 私有化核准。

### [x] Task 05: jev-client.js（fetch＋退避重試＋錯誤正規化）✅ 2026-09-21（pi＋架構師 live 補驗）
- 目標：§4.4/§5 契約的實作；fetch 可注入（fake fetch 測試）；重試僅 429/529；錯誤 kind 齊滿；任何輸出路徑不洩 key。
- Target Files: `extension/lib/jev-client.js`、`tests/jev-client.test.mjs`、`tests/fixtures/jev-response-ok.json`、`tests/fixtures/jev-response-422.json`。
- 驗收：`node --test tests/` 全綠；`node scripts/live-jev.mjs`（讀 `JEV_API_KEY` 環境變數，對 expected-state 打真 API）回 `direction`／`up_10_bars`／`trend_strength` 三答案與 usage。
- [x] 完成紀錄：**2026-09-21 pi 執行（不打網路）＋架構師以 `scripts/live-jev.mjs` 補做真實 API 驗證**。
  - 離線：`node --test` 64/64（43 零回歸＋21 新，全错误路徑＋redact 偵測斷言）；static-check ALL PASS；契約匯出核對通過。
  - **LIVE（金標 300 根 BTC 1m → 真實 https://api.typesafe.ai/v1/systemone）**：`verdict: PASS (1003ms)`，judge=`jev-1.13.0`，三答案齊——direction=long（P: long .44/neutral .23/short .33, confidence .15）、up_10_bars noul=.55、trend_strength=3.12/strong（confidence .77）；usage 17,262 in / 74 out → **$0.00073/次**（PRD 成本標準 ≤$0.005 的 1/7）。
  - 合理性旁證：輸出恰是「強趨勢但方向低信心」——符合校準機率語意，非固定口癖。
  - 備註：`estimateTokens` 估 4.2K vs 實際 17.3K（Jev tokenizer 對數字串更貴）→ 成本結論不變，Panel 的「成本顯示」以 usage 實測為準（Task 08 注意）。pi 附加項（USER_AGENT 匯出、非物件 200→offhost）核准。

## Phase 2 — Extension 接線

### [x] Task 06: inject.js（world:MAIN ws 包裝）＋ content/bridge.js ✅ 2026-09-21（pi）
- 目標：§4.2 旁聽規則＋節流增量上送；重連/心跳；零改動 ws 行為。
- Target Files: `extension/content/inject.js`、`extension/content/bridge.js`（manifest 已靜態宣告兩檔，無需 registerContentScripts 代碼）。
- 驗收：`node --test` 全綠；`node scripts/verify-inject.mjs` verdict PASS；`node scripts/static-check.mjs task06` ALL PASS；加載後真機檢查見 Task 09。
- [x] 完成紀錄：**2026-09-21 pi 執行，架構師親驗全綠**（`node --test` 67/67；**verify-inject 驗收臺 19/19 verdict PASS**——以 Task 01 真實幀餵進 inject：301 根、與金標逐值一致（1 根差異＝du 尾根刷新屬預期）、非 TV 連線零消費、send/close 透傳、series_loading 重置＋符號更新全對；static-check task02/task06 ALL PASS）。
  - 返修/治理記錄：pi 為讓驗收臺通過**擅自修復了已 commit 的證據檔**（ws-evidence-btc-1m.json 截斷 p 補尾）→ 架構師判定違反「證據檔不可變」→ `git checkout HEAD` 还原，改為硬化驗收臺（toPayload 對 WS-NOTES §6 已知截斷以 regex 復建），還原後重跑仍 verdict PASS。
  - pi 必要偏差核准：C3 globalThis 化外溢到 state-builder/jev-client 的 import 鏈（side-effect import＋globalThis 取值，零邏輯變動）——此為「lib 需同時跑 classic script 與 ESM」的必然結果，已回寫 ARCHITECTURE §4.6。
  - 原驗收命令的 `parse-fixture.mjs` 由 `verify-inject.mjs` 行為臺＋static-check 取代（TASK 本體已同步）。

### [x] Task 07: service-worker 編排（sw-core 可測核＋薄殼）✅ 2026-09-21（pi）
- 目標：§4.1 訊息協定的 SW 側完整實作；多 tab registry；predict 流程串 Task 03/04/05 模組。
- Target Files: `extension/lib/sw-core.js`（架構師核准新增：邏輯與 chrome.* 分層）、`extension/background/service-worker.js`、`tests/sw-core.test.mjs`。
- 驗收：`node --test` 全綠；static-check task07（無直接外網 fetch、sw-core 零 chrome.*）；verify-inject 不回歸。
- [x] 完成紀錄：**2026-09-21 pi 執行，架構師親驗全綠**（82/82＝67 零回歸＋15 新；task02/06/07 gates＋驗收臺全過；未碰 scripts/——上輪教訓生效，本輪 scope 完全乾淨）。備註核准：GET_STATE 等四個 panel 訊息型別未進 protocol.MSG（字串常數於 sw-core/殼，第二版可收斂）；`waitMs` dep 化（預設 800）為正當可測性設計；併發鎖 busy、非 TV sender 忽略、錯誤二次 redact 皆有測試。

### [-] Task 08: Side Panel ＋ Options UI → pi（2026-09-21 派工中）
- 目標：F5/F6/F7。Panel 狀態機（idle/loading/done/error）、機率條、徽章、token 用量、原始 JSON 折疊、免責固定語；Options 的 key/model/bars/特徵開關。
- Target Files: `extension/sidepanel/*`、`extension/options/*`。
- 驗收：`node --test tests/` 全綠；HTML 通過 `node scripts/static-check.mjs`（無 inline script、無外部資源引用）。
- [x] 完成紀錄：（待填）

## Phase 3 — 端到端與收尾

### [ ] Task 09: e2e 人工驗收（架構師＋使用者）
- 目標：真實 Chrome 載入未封裝擴充 → 開 TV 圖表 → 按預測 → Panel 出結果。
- 驗收清單（逐條打勾並記錄證據）：
  1. 載入擴充無 manifest 錯誤；
  2. 開 `tradingview.com/chart/…` 即自動抓 bar（SW console 可見 `bars>200`）；
  3. 兩張不同符號分頁各自準確；
  4. 按預測 3 秒內出結果；
  5. 錯 key → 顯示 auth 中文提示；斷網 → offline 提示；
  6. 成本估算顯示 ≤ $0.005/次；
  7. `git grep` 無明文 key。
- [x] 完成紀錄：（待填）

### [ ] Task 10:（選做，可取捨）除錯增強
- droppedFrames／各 series 計數進 debug 面板；ring log 最近 20 次預測；「重同步」按鈕（觸發 REQ_SNAPSHOT）。
- [x] 完成紀錄：（待填）

---

## 依賴圖（串行順序）

```
01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → (10)
```

任何任務驗收失敗：根因編號寫進本檔該任務的「完成紀錄」，發最小修補 prompt（pi 用 `pi -c` 續接），不整模組重寫。
