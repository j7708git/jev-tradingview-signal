# TASK — jev-tradingview-signal

嚴格串行；一次只派一個。`[ ]` 待辦 / `[-]` 進行中 / `[x]` 完成。

> **公開發佈（2026-09-22）**：<https://github.com/j7708git/jev-tradingview-signal>（public，MIT）。`docs/.prompt-task*.txt`（派工單）與 `scratch/`（診斷工具）列在 `.gitignore`，不隨公開發佈；本機絕對路徑已去識別化。
派工對象預設 **pi**（`pi -p`），驗收命令一律在專案根的 git-bash 可執行。
> 測試標準指令為 `npm test`（＝ bare `node --test` 自動探索，Task 10 後 **147/147**；其中 1 則來自 gitignore 的 `scratch/parse-frames-test.mjs`，`tests/` 本身 146 則）。注意 Node 24 下 `node --test tests/` 目錄參數會報「找不到模組」，勿再使用。

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

### [x] Task 02: 骨架＋lib/protocol.js＋lib/chart-buffer.js（含測試）✅ 2026-09-21（pi）
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

### [x] Task 08: Side Panel ＋ Options UI ✅ 2026-09-21（pi，commit da675c8）
- 目標：F5/F6/F7。Panel 狀態機（idle/loading/done/error）、機率條、徽章、token 用量、原始 JSON 折疊、免責固定語；Options 的 key/model/bars/特徵開關。
- Target Files: `extension/sidepanel/*`、`extension/options/*`。
- 驗收：`node --test tests/` 全綠；HTML 通過 `node scripts/static-check.mjs`（無 inline script、無外部資源引用）。
- [x] 完成紀錄：**2026-09-21 pi 執行，架構師親驗全綠**（`node --test` 107/107；static-check task02/06/07/08 四 gate 全過；verify-inject 19/19 PASS）。架構師另以「真 app.js＋chrome stub」在真 Chrome（file:// 單檔拼接式試飛）驗證渲染：狀態列正確顯示 `圖表：BINANCE:BTCUSDT · 15 · 301 根 · buffer total 301`、預測鈕由 disabled→啟用、click 進 loading、Options 頁金鑰遮罩 `••••c123 (len=15)`＋模型/bars/特徵開關皆正確渲染、零 console 例外。

### [x] Task 06fix: inject.js WebSocket 常數改 getter（真機根因修復）✅ 2026-09-21（pi，`pi -c` 續接）
- 症狀：真機 `__JEV_HOOK=true` 但 `window.WebSocket` 仍為原生 → 包裝未生效。
- 根因：`JevWebSocket.CONNECTING = NativeWS.CONNECTING` 等直接賦值——原生常數為唯讀（constructor 上 non-writable／部分環境為 prototype getter），strict 下拋 TypeError 使整段包裝中止（非 strict 則靜默遺失常數）。
- 修法：改 `Object.defineProperty(JevWebSocket, name, { get(){ return name in NativeWS ? NativeWS[name] : NativeWS.prototype[name]; } })`，不賦值、維持唯讀語意、兩環境皆可見。
- **驗收臺同步硬化**：`scripts/verify-inject.mjs` 的 MockWS 由「可寫 static 欄位」改為 prototype getter（＝真原生語意），修前會如實 FAIL、修後 PASS——避免假綠。
- 真機複驗：`window.WebSocket` 非原生（`wsNative:false`），真 TradingView 頁實收 `SNAPSHOT_UPSERT`，首發 **300 根**（`reset:true`、`BINANCE:BTCUSDT`），後續尾根增量每則 1 根。

### [x] Task 09fix: Side Panel 身分判準改用 sender.url ✅ 2026-09-21（pi，真機 e2e 揭出）
- 症狀：面板以**分頁**開啟（chrome-extension://…/sidepanel/sidepanel.html）時永遠顯示「等待中」、預測鈕 disabled。
- 根因：`isPanel` 以 `sender.tab === undefined` 判定；面板當分頁時 `sender.tab` 有值 → 被當成 content script → `msg.type !== SNAPSHOT_UPSERT` → 拒絕，訊息無回應（實測回 `undefined`、耗時 1ms）。正式 side panel 情境（sender.tab undefined）不受影響。
- 修法：SW 層以 `sender.url` 是否屬本擴充 `sidepanel/`、`options/` 判定 fromPanel，成立時把 sender 正規化為 `{...sender, tab: undefined}` 再交給 sw-core（**不動 sw-core 公開契約**）。
- 意義：正式用法行為不變，但面板在分頁／其他宿主下也能運作，且使自動化 e2e 得以覆蓋真 panel。

## Phase 3 — 端到端與收尾

### [x] Task 09c: reset 不丟資料＋全量重送＋SW 狀態持久化 ✅ 2026-09-21（pi）
- 規格：`docs/ARCHITECTURE.md` §4.7（4.7.1–4.7.4）。
- 真機根因：`series_loading` 的 reset 會清掉尚未 flush 的 300 根歷史（網路層取證：ws 上有 300／366 根的 `timescale_update`，inject 卻第一則就發空 reset、之後只有 n=1）；且 MV3 SW 被回收後記憶體狀態消失。
- 實作：`inject.js` reset 只清 sent 游標（不再 `bars.clear()`）；`JEV_PING{full:true}` → 清游標＋`reset:true` 全量 flush；`bridge.js` 轉發 full 旗標；`sw-core.js` 在「首觸某 tab」與「buffer < MIN_BARS_FOR_PREDICT」時發 `REQ_SNAPSHOT{full:true}`、並把 `GET_LAST_TAB` 移入 core 以納入持久化；`service-worker.js` 用 `chrome.storage.session` 持久化 `lastActiveTabId`（讀寫失敗降級為記憶體值）。
- 驗收：`node --test` **115/115**（109 基準＋6 新：reset 全量、full/非 full 差異、首觸即發全量請求、根數門檻、SW 重啟後 tabId 還在、session 失敗降級）；四 gate 全過；verify-inject 全過。

### [x] Task 09d: resolution 讀取時機＋symbol 身分變更清緩衝 ✅ 2026-09-21（pi）
- 09d-1（**誤判修正**）：我原先以為「網址 `interval=1`、state 卻報 15」是取樣不新鮮的缺陷。真機複查 TV 畫面週期鈕顯示 **15m** → **state 的 15 才是對的**，是 TV 自己在 SPA 期間把 URL 的 `interval` 參數寫成 1（TV 自身的 quirk），不是我們的 bug。pi 依工單把 resolution 改為 flush 當下讀 `location.search`（讀不到沿用舊值）——**保留為無害的加固**，但**不列為缺陷修復**。
- 09d-2（**已被 §4.2.1 取代**）：原設計「收到 `symbol_resolved` 且 symbol 與當前不同即完整重置」。真機證明此判準錯誤——輔助序列（`INTERNAL:SEASONALS`）的 `symbol_resolved` 會誤觸，清掉主圖資料。正確規則：只有**主圖**（`sds_sym_1`/`ss_1`）symbol 變更才清緩衝。

### [x] Task 09e: 資料不足拒預測＋門檻單一來源＋GET_STATE 觸發重同步 ✅ 2026-09-21（pi）
- 背景：真機 e2e 揭出「SW 冷啟動後緩衝只剩 1 根，卻照樣呼叫 TypeSafe API」，回傳 觀望 91%／趨勢強度 0.06 這種垃圾（會被誤讀成訊號）。
- 實作：`PREDICT_MIN_BARS = 50` 集中在 `lib/protocol.js`（單一來源，panel 與 sw-core 共用）；等完全量重送後仍 < 50 根 → 回 `{ok:false, err:'insufficient_data'}` 且**不呼叫 API**；`GET_STATE` 於根數不足時觸發全量重送（面板可自行恢復）。`node --test` 120/120。
- 真機複驗：資料不足時 3ms 回 `insufficient_data`、0 token；資料足夠時正常預測（見 09f 驗收）。

### [x] Task 09f: 多 series 隔離（只有 sds_1 是主圖）✅ 2026-09-21（pi）
- 完成紀錄：`protocol.js` 增 `globalThis.MAIN_SERIES_KEY='sds_1'`（單一來源）；`ws-parse.js` 的 `{kind:'meta'}` 補 `seriesRef`（=p[1]）；`inject.js` 加主序列過濾（bars/reset 只看 `sds_1`，meta 只認 `sds_sym_1`/`ss_1`，其餘丟棄並累加 `ignoredSeriesFrames`），`bars.clear()` 僅由主圖 symbol 變更觸發。`node --test` **124/124**（新增 fixture 真機重播：主圖恰 300 根、symbol=BINANCE:SOLUSDT、sds_2 的 366 根不入緩衝、sds_2 reset 不影響主圖）；四 gate 全 ALL PASS；verify-inject verdict PASS。
- **架構師真機取證（本輪最重要發現）**：TV 在同一條 ws 上同時推送多個 series。用 `scratch/diag24.mjs` dump 95 幀（165KB）後離線重播（`scratch/replay-keys.mjs`）得到事件序列：
  `reset/sds_1 → meta(sds_sym_1, BINANCE:SOLUSDT) → bars/sds_1(300) → reset/sds_2 → meta(sds_sym_2, INTERNAL:SEASONALS) → bars/sds_2(366) → … → meta(ss_1, BINANCE:SOLUSDT) → bars/sds_1(1) 尾根`
- 兩個既有缺陷因此確認：① inject 把輔助序列 `sds_2` 的 366 根與主圖 300 根混進同一緩衝（**我先前看到的 666 根是污染狀態，不是成功**）；② 我 09d-2 派的「任何 symbol 變更就清緩衝」被 `INTERNAL:SEASONALS` 誤觸，直接清掉主圖 300 根 → 只剩 1 根（09d-2 為錯誤設計，已由 §4.2.1 取代）。
- **更正紀錄**：Task09c 後那次「真機 7/7 PASS、666 根、做空 62%」的預測是在**污染資料**上跑的，該樣本作廢，不得當成通過證據；已在 09f 修完後以「緩衝 300 根且全為主圖 bar」重跑取代。
- 真機 fixture 已存證：`tests/fixtures/ws-multiseries-real.txt`；派工單：`docs/.prompt-task09f.txt`。
- **架構師親驗（真機 e2e 8/8 PASS）**：`圖表：BINANCE:BTCUSDT · 15 · 300 根 · buffer total 300`（新增反污染斷言：根數須在 250–400，666 視為失敗）；`RUN_PREDICTION ok:true` 1000ms、17373 tokens、$0.0007；DOM 渲染 做空/做多/觀望、未來10根上漲機率 55%、趨勢強度 3.32。
- **資料真實性交叉核對**：送進 API 的 state 300 根，最後一根 close **85,343.86** vs TV 畫面即時價 **85,355.40**（同一根進行中的 15m bar）；首末根時距 269,100 秒 = 299×900 → 恰為 300 根 15 分鐘 K 棒。

### [x] Task 09g: 站內換商品：符號更新＋清掉舊商品 K 棒 ✅ 2026-09-22（pi；使用者實測回報）
- 真機缺陷：使用者實測發現站內切換商品後面板仍顯示舊商品、payload symbol 不變。架構師真機取證（`scratch/diag27.mjs`＋fixture `tests/fixtures/ws-symbol-switch-real.txt`，236 幀）：切換後 TV **重新編號 series 身分**（`sds_sym_1`→`sds_sym_3`、`ss_1`→`ss_2`），而初版把主圖符號身分寫死 `sds_sym_1`／`ss_1` → 新符號被當輔助序列忽略 → `meta.symbol` 停在舊值；且主圖緩衝混入新舊商品 bar（面板 337 根＝300＋新資料的污染值）。
- 修法（§4.2.1 規則 2/3/6/7）：符號判準改看 `p[2].full_name` 內容——`INTERNAL:` 開頭者一律忽略（不改 symbol、不清緩衝），其餘真實商品（即使身分為 `sds_sym_3`／`ss_2`）接受並更新 `meta.symbol`；真實商品變更才 `bars.clear()＋sent.clear()＋pendingReset`。主圖 bars/reset 的 seriesKey 仍為 `sds_1`；**嚴禁以 URL 的 `?symbol=` 推斷商品**（真機實測站內切換後 URL 不更新）。
- 驗收：`node --test` **127/127**（新增：真機換商品 fixture 依序餵入 → symbol=ETHUSDT、INTERNAL 不清不覆、舊 300 根 BTC 被清、sds_3 的 366 根不入緩衝）；四 gate ALL PASS；verify-inject verdict PASS。**真機複驗**：切換前 `{count:300, symbol:BINANCE:BTCUSDT}` → 切換後 `{count:300, symbol:BINANCE:ETHUSDT}`（不再 337）、inject 發出乾淨的 `{n:300, reset:true, sym:ETHUSDT}`。

### [x] Task 09h: 趨勢強度拆成「多頭／空頭」兩題 ✅ 2026-09-22（pi；使用者需求變更）
- 需求：使用者實測後要求原本單一「趨勢強度」（`trend_strength`）拆成 **`bull_trend`（多頭趨勢強度）／`bear_trend`（空頭趨勢強度）** 兩題，同為 `score` 型、同一組 5 級 criteria；面板顯示兩列。規格：`docs/ARCHITECTURE.md` §4.4、`docs/PRD.md` 問題組合（三題→四題）。
- 實作：`state-builder.js` QUESTIONS 移除 `trend_strength`、新增兩題（instructions 逐字對齊 §4.4）；`sidepanel/render.js` `renderTrend(answers)` 渲染兩列，舊回應含 `trend_strength` 時相容渲染單列「趨勢強度」，任一題缺漏該列顯示「—」。state 內容（OHLCV/特徵）與訊息協定不變。
- 驗收：`node --test` **130/130**（新增：QUESTIONS 無 trend_strength、bull/bear 五級與題字、兩列渲染、缺題降級、舊 trend_strength 相容）；四 gate ALL PASS；verify-inject verdict PASS。**真機 e2e 8/8 PASS**：`多頭趨勢強度 2.59 ｜ 空頭趨勢強度 0.78`（真實 TypeSafe 回應，1009ms、17551 tokens、$0.0007）。
- [x] 附帶修補（架構師，2026-09-22）：`scripts/live-jev.mjs` 驗證題目同步改為 `bull_trend`/`bear_trend`＋score 型別檢查與 exit code 對齊，並修掉原檔 console.log 多餘括號的語法錯誤（原檔根本無法執行；修後 live 重跑 **verdict: PASS 1059ms**、$0.00073、bull/bear 兩題齊）；docs 四件套＋OVERVIEW 同步去 `trend_strength` 化、統一 repo 命名、修正成本數字、TASK 去重排序。

### [x] Task 09: e2e 人工驗收（架構師＋使用者）✅ 2026-09-22 使用者實測通過
- 目標：真實 Chrome 載入未封裝擴充 → 開 TV 圖表 → 按預測 → Panel 出結果。
- 驗收清單（逐條打勾並記錄證據）：
  1. 載入擴充無 manifest 錯誤；
  2. 開 `tradingview.com/chart/…` 即自動抓 bar（SW console 可見 `bars>200`）；
  3. 兩張不同符號分頁各自準確；
  4. 按預測 3 秒內出結果；
  5. 錯 key → 顯示 auth 中文提示；斷網 → offline 提示；
  6. 成本估算顯示 ≤ $0.005/次；
  7. `git grep` 無明文 key。
- [-] 進行中紀錄（2026-09-21，架構師親自）：
  - **環境事實**：branded Chrome 153 已移除 `--load-extension`（實測 log：`--load-extension is not allowed in Google Chrome, ignoring.`，`DisableLoadExtensionCommandLineSwitch` flag 亦無效）→ 自動化改用 **Playwright 自帶 Chromium**（`%LOCALAPPDATA%\ms-playwright\chromium-1243`），`--load-extension` 有效、擴充真的載入（SW target 現身）。驗收腳本 `scripts/e2e-real-chrome.mjs`（架構師專用，pi 不得跑）。
  - 過程中修掉四個真缺陷（全部先寫規格、派工修、架構師真機複驗）：
    - **Task 06fix**：inject 的 ws 包裝被「唯讀常數賦值」中止 → 包裝從未生效。改 getter。
    - **Task 09fix**：面板身分判準只看 `sender.tab` → 面板以分頁開啟時被誤判為 content script、訊息遭拒。改看 `sender.url`。
    - **Task 09c**（關鍵）：真機實測「歷史從未送出」——ws 串流確有 `timescale_update` 300／366 根（網路層取證），但 inject 第一則發射竟是**空的 reset**，之後只有 1 根尾根；根因＝`series_loading`（reset）把尚未 flush 的歷史清掉（§4.7.1），加上 MV3 SW 生命週期讓記憶體狀態消失（§4.7.3）。修法：reset 只清 sent 游標不清 bar、`REQ_SNAPSHOT{full:true}` 全量重送、`lastActiveTabId` 存 `storage.session`。
    - **Task 09d**：resolution 取樣不新鮮（網址 `interval=1` 卻報 15）＋SPA 切換 symbol 時舊幣 bar 殘留（vm 實測 merged=303）。
  - **真機 e2e 最終結果（`scripts/e2e-real-chrome.mjs`，8/8 PASS；2026-09-22 09g/09h 後）**：擴充載入無錯誤；金鑰寫入 `chrome.storage.local`；真 TradingView 圖表載入；Side Panel 狀態列 `圖表：BINANCE:BTCUSDT · 15 · 300 根 · buffer total 300`（含反污染斷言）；預測鈕由 disabled→啟用；`RUN_PREDICTION` **ok:true／1009ms（真 TypeSafe API）**；面板渲染 `做多 36% / 做多 57% / 觀望 31% / 做空 12%｜未來 10 根上漲機率 53%｜多頭趨勢強度 2.59｜空頭趨勢強度 0.78｜17551 tokens · $0.0007 · jev-latest`。
    - ⚠️ 更早一筆「7/7 PASS／666 根／趨勢強度 2.99」為**污染狀態**下的觀測（666 = 主圖 300＋輔助序列 366，且趨勢強度為舊單題版），已作廢，見 Task 09f 更正紀錄。
  - **站內切換標的複驗（09g 後）**：`{count:300, symbol:BINANCE:BTCUSDT}` → 站內切換 → `{count:300, symbol:BINANCE:ETHUSDT}`（無混幣、符號即時更新）。
  - **清單狀態**：①②③④⑥⑦已驗（③=不同分頁各自準確、⑥=實測 $0.0007/次 ≈ NT$0.02、⑦=`git grep` 無明文長 token 且未追蹤 `.env`）；⑤已於 2026-09-22 真機補驗完成（見下方⑤補驗紀錄）。
  - **使用者手動實測（2026-09-22）**：回報「做得不錯」= 通過。使用者實測中另抓出兩個問題（站內換商品符號不更新＝真缺陷已修 09g；趨勢強度拆分＝需求變更已做 09h）。
  - **切換標的複驗**：整頁重載切 ETHUSDT/5 → state `{count:300, symbol:BINANCE:ETHUSDT, resolution:"5"}`（乾淨，無混幣）。
  - **清單⑤ 真機補驗（2026-09-22，架構師以 `scripts/e2e-error-paths.mjs` 執行，17/17 PASS）**：
    - 錯 key：寫入偽金鑰 → `RUN_PREDICTION` 799ms 回 `{ok:false, error:'auth_401'}` → Panel DOM「預測失敗｜auth_401｜API key 已被拒絕（401）」＋免責固定語；回應序列化與 DOM 皆不含金鑰字串（redact 實測）。
    - 斷網：CDP attach SW target 雙重阻斷（`Network.emulateNetworkConditions{offline}`＋`Fetch.failRequest`）→ 真 fetch 產生 TypeError 走完整正規化路徑 → 回 `offline` → Panel DOM「離線或防火牆擋了 api.typesafe.ai」＋免責語。（註：屬模擬斷網，非拔實體網路。）
    - 復原：換回真金鑰 → `ok:true`（1446ms、17557 tokens、$0.0007），DOM 回正常結果渲染——錯誤狀態未卡死面板。
  - 清單七項 ①–⑦ 至此**全數真機驗證完畢**，Task 09 無殘留待辦。

### [x] Task 10: 除錯增強（完整版：①計數面板＋②ring log＋③重同步鈕）✅ 2026-09-22（pi）
- 規格：`docs/ARCHITECTURE.md` §4.8（4.8.1–4.8.5）。派工單：`docs/.prompt-task10.txt`。
- ①inject 旁聽計數（dropped／ignoredSeriesFrames）隨 SNAPSHOT_UPSERT 捎帶 → GET_STATE 帶 counters → Panel 折疊除錯區；②sw-core 記憶體 ring log 最近 20 次預測摘要（**不持久化**）＋新訊息 GET_RING_LOG；③Panel「重同步」鈕 → RESYNC → REQ_SNAPSHOT{full:true}。
- 附帶（Task 07 掛帳）：panel 命令 MSG 常數收斂進 protocol.js＋成本常數 COST_USD_PER_MTOK 單一來源。
- 驗收：`npm test` 全綠（零回歸＋新增用例）；`node scripts/static-check.mjs` 四 gate＋`node scripts/verify-inject.mjs` verdict PASS（19/19 不得回歸）。
- [x] 完成紀錄：**2026-09-22 pi 兩輪執行（主任務＋核准偏差的 inject-reset 斷言補強），架構師親驗全綠**：`npm test` **147/147**（130 基準＋17 新，fail 0）、static-check **task02/06/07/08 四 gate 全 ALL PASS**（架構師逐一親跑）、verify-inject **19/19 verdict PASS**、git 無越界（scripts/ 未被碰、docs/ 僅架構師改動）。
  - 交付：①counters 捎帶（SNAPSHOT_UPSERT→entry.counters→GET_STATE）＋Panel 折疊除錯區（dropped／ignoredSeriesFrames）；②ringLog 記憶體 20 筆（不持久化、doPredict 結束必 push 含錯誤筆、redact 無 key）＋GET_RING_LOG；③RESYNC→REQ_SNAPSHOT{full:true}＋「重同步」鈕。附帶：panel 7 型命令收斂進 protocol.MSG（14 鍵，Task 07 掛帳了結）＋COST_USD_PER_MTOK=0.042 單一來源。
  - 核准偏差：工單所列 sidepanel/sidepanel.js 實檔為 sidepanel/app.js（就地修改）；tests/inject-reset.test.mjs 追加 2 則 counters 斷言（第二輪核准，Target Files 追加）；vm 跨 realm 逐欄 assert.equal 取代 deepStrictEqual（prototype 誤判）。
  - 驗證注意：`static-check.mjs` 需帶 `taskNN` 參數逐一跑，**不帶參數只跑 task02**。

---

## Phase 4 — 第二期優化（2026-09-22 使用者需求：設定入口＋指標串接）

### [x] Task 11: Panel 設定入口（⚙ 按鈕＋no_key CTA）✅ 2026-09-22（pi）
- 目標：F8。Panel「⚙ 設定」→ `chrome.runtime.openOptionsPage()`（無新權限）；renderError 的 no_key 態帶同一 CTA。
- Target Files: `extension/sidepanel/*`、`tests/render.test.mjs`。
- 驗收：`npm test` 全綠；static-check task08 過；真機點擊開設定頁。
- [x] 完成紀錄：**2026-09-22 pi 執行，架構師親驗全綠**：`npm test` **152/152**（147＋5 新）、static-check task02/06/07/08 全 ALL PASS、verify-inject verdict PASS、git 無越界（僅 sidepanel 4 檔＋render.test）。真機點擊驗收（`scratch/diag-f8-click.mjs`，**6/6 PASS**）：⚙ 設定鈕存在（label「⚙ 設定」、class `ghost open-options`）→ 點擊真開出 options 分頁（openOptionsPage 生效）；no_key 錯誤盒 CTA「去設定 API key」在場、其他 kind 不含 CTA。
  - 實作要點：`OPEN_OPTIONS_CLASS/ACTION` 常數單一來源（render.js）；openOptionsPageSafe 靜默降級不拋錯；renderError 既有結構不變僅加 CTA。

### [x] Task 12: study 協定取證 spike（架構師執行，不派工）✅ 2026-09-22 ALL PASS
- 目標：解開 §4.2.2 四未知數（studyId→名稱/參數映射、`st` 形狀、Pine 可辨識度、**識別鍵穩定性**——跨 reload／SPA 換符號是否重編號，決定 `studyNameMap` 鍵與持久化效果）；掛 EMA/RSI/布林的真機圖 dump 幀樣本。
- 產出物：`tests/fixtures/ws-studies-real.txt`（去識別）＋`docs/WS-NOTES.md` §7＋§4.2.2 回寫定案。
- 驗收：證明「名稱＋參數＋逐根數值」三者皆可得，或記錄不可得項的降級方案。
- [x] 完成紀錄：**2026-09-22 架構師 browser-harness 真機取證（BTCUSDT 15m，BB30/ALMA25/ALMA90/VRVP/Vol/CMF20/BarSet 七研究），四未知數全數定案**——①身分/參數在**上行 create_study 明文**（pineId＋in_*／具名參數；Pine 原始碼加密但不需解密）；②`st`＝完整逐根序列＋尾根增量、`v=[epoch秒,...1–4值]`、時間對齊 bars；③built-in 全可辨識、自訂 Pine 有 pineId、非時序型（VRVP）st 恆空自動排除；④studyId 由 client 存 layout 跨 reload 穩定（7 個中 6 個不變，唯一換號為 TV 內部 BarSet）→ `studyNameMap` 主鍵＝studyId、fallback＝pineId|in_* 簽章。證據：`tests/fixtures/ws-studies-real.txt`＋WS-NOTES §7。

### [ ] Task 13: study 消費實作（ws-parse/inject/sw-core/state-builder）
- 依 Task 12 定案契約派 pi；state.studies 對齊 `bars` 窗口，`name` 取 `studyNameMap` 覆寫值（無覆寫用自動名稱）、`rawName` 保留；未掛指標 `studies:[]` 零回歸。

### [ ] Task 14: Panel 呈現 studies＋真機 e2e 驗收
- Panel 指標名稱映射 UI（F10）：動態輸入框、預設＝自動偵測名稱、失焦即存、持久化；＋payload/結果區顯示附帶指標；真機掛指標圖 e2e；成本複驗 ≤$0.005/次。

---

## 依賴圖（串行順序）

```
01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14
```

任何任務驗收失敗：根因編號寫進本檔該任務的「完成紀錄」，發最小修補 prompt（pi 用 `pi -c` 續接），不整模組重寫。
