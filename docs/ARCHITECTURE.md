# ARCHITECTURE — jev-signal

## 1. 技術棧

| 層 | 選擇 | 理由 |
|----|------|------|
| Extension 框架 | Chrome Manifest V3（純 JS/ESM，**無 build step、無 npm 依賴**） | 個人工具；MV3 的 service worker 為 module 型，可直接 `import` 共享 lib，省去打包工具鏈 |
| UI | 原生 HTML + CSS + ES modules（Side Panel / Options 各一頁） | 兩個頁面邏輯簡單，引入框架是過度工程 |
| 測試 | `node --test`（Node ≥ 20）＋ JSON fixtures | 零依賴、Windows git-bash 可跑 |
| 預測 API | TypeSafe `/v1/systemone`（model `jev-latest`） | 已定案：直連官方，繞過 jev-proxy |

**禁止**：引入任何 npm runtime 依賴（含打包器、測試框架、HTTP client 庫）。`fetch`、`chrome.*` API、純 JS 数学就是全部。原因：無 build step 是本專案可維護性的基石；上架與否都不需要體重。

## 2. 拓撲與資料流

```
┌─ TradingView tab ────────────────────────────────────────────────┐
│  page context (world: MAIN)        isolated content script       │
│  ┌──────────────┐  window.postMessage  ┌──────────────────┐      │
│  │ inject/hook  │ ──── jev:hello ────→ │ content/bridge   │      │
│  │ wrap         │ ←──── jev:pong ───── │ (listener+proxy) │      │
│  │ window.      │  ── jev:data ──────→ │                  │      │
│  │ WebSocket    │  ←─ jev:reqSnap ───  │                  │      │
│  └──────┬───────┘                      └────────┬─────────┘      │
│    旁聽(不修改) ws 流量                          │ chrome.runtime │
│    tradingview.com 私有 ws (mem 協定)            ▼                │
└──────────────────────────────────────────────┼───────────────────┘
                                               ▼
                        ┌─ background service worker ─────────────┐
                        │ registry: tabId → ChartBuffer(bar 滚动) │
                        │ actions: snapshot → state-builder        │
                        │   → lib/jev-client (fetch+retry)         │
                        │   → 結果存 lastResult[tabId]             │
                        └───────────────┬─────────────────────────┘
                                        ▼
                     ┌─ Side Panel (chrome.sidePanel, 綁定 tab) ─┐
                     │ 符號/週期/K棒數 · 方向徽章 · 機率條 ·      │
                     │ confidence · token 用量 · 原始 JSON 折疊   │
                     └───────────────────────────────────────────┘
                                        ▲
                     ┌─ Options page ───┴────────────────────────┐
                     │ TYPESAFE_API_KEY · model · bars(50-1000)  │
                     │ · 派生特徵開關        （chrome.storage.local）│
                     └───────────────────────────────────────────┘

外部依賴只有一處：https://api.typesafe.ai/v1/systemone（lib/jev-client.js）
```

## 3. 目錄結構

```
TradingView-Jev-Signal/
├── extension/                  # chrome://extensions「載入未封裝」指向這裡
│   ├── manifest.json
│   ├── background/
│   │   └── service-worker.js   # 協定中樞：buffer registry、快照、預測編排
│   ├── content/
│   │   ├── inject.js           # 注入 world:MAIN：包裝 WebSocket、旁聽 mem 協定
│   │   └── bridge.js           # isolated：main↔SW 訊息橋＋重連/心跳
│   ├── sidepanel/
│   │   ├── sidepanel.html / sidepanel.css / sidepanel.js
│   ├── options/
│   │   ├── options.html / options.css / options.js
│   └── lib/                    # 純函式，ESM，SW/測試共用（不得 import chrome.*）
│       ├── protocol.js         # 訊息 type 常數＋bar 欄位序＋version
│       ├── chart-buffer.js     # 增量 upsert、滚动上限、snapshot()
│       ├── features.js         # MA/RSI/動量/高低距（純數學）
│       ├── state-builder.js    # snapshot+features → systemone state
│       └── jev-client.js       # 唯一對外出口：fetch、退避重試、逾時、錯誤正規化
├── scripts/
│   ├── verify-lib.mjs          # node --test 入口包装（供派工驗收命令統一）
│   ├── live-jev.mjs            # 讀 argv 的 environment 取鑰匙，對 fixture 打真 API
│   └── diag-ws.mjs             # （第二期）ws 協定取證輔助
├── tests/
│   ├── fixtures/               # bars-300.json、expected-features.json、jev-response-*.json
│   ├── chart-buffer.test.mjs
│   ├── features.test.mjs
│   ├── state-builder.test.mjs
│   └── jev-client.test.mjs     # 以注入的 fake fetch 測重試/逾時/401/422 路徑
├── docs/                       # 本四件套＋派工 prompt 檔
└── README.md                   # 載入步驟＋鑰匙設定＋按鍵說明
```

## 4. 協定 Contract

### 4.1 訊息協定（全部經 `lib/protocol.js` 定義常數，`v:1` 版本欄位必填）

| 通道 | 方向 | type | payload |
|------|------|------|---------|
| window.postMessage | inject → bridge | `JEV_HELLO` | `{v, hooks:true}` |
| window.postMessage | bridge → inject | `JEV_PING` | `{v}` |
| window.postMessage | inject → bridge | `JEV_WS_DATA` | `{v, url, dir:'recv', frames:[...]}`（見 4.2） |
| runtime | bridge → SW | `SNAPSHOT_UPSERT` | `{v, bars: number[][], seriesKey?, meta}` |
| runtime | SW → bridge | `REQ_SNAPSHOT` | `{v}`（SW 主動要求補傳/重同步） |
| runtime | panel/options → SW | `RUN_PREDICTION` | `{v, tabId}` → 回 `{ok, result?, error?}` |
| runtime | SW → panel | `PREDICTION_UPDATED` | `{v, tabId, state:'idle|loading|done|error', payloadRef}` |

規則：所有 `window.postMessage` 訊息必須驗 `event.source === window` 且 `event.data.v === 1` 且 origin 為 `https://www.tradingview.com`，否則丟棄。原因：頁面本身也大量使用 postMessage，不驗證會誤吃（或被注入）他人訊息。

### 4.2 inject.js 旁聽規則（本專案最高風險區，規格從嚴）

> 【Task 01 取證已定案，原 mem 幀假設作廢——實測協定見 docs/WS-NOTES.md】

- 包裝 `window.WebSocket` 為 Proxy 子類：僅當 `url` 符合 `/^wss:\/\/(.*\.)?tradingview\.com/` 才挂監聽 listener；其餘 ws 原樣放行。**絕不可改動 send/close/onmessage 的行為與返回值。**
- 分幀：socket.io 文字分幀 `~m~<len>~m~<payload>`（一條 ws 訊息可串多幀）；`~h~<n>` 心跳丟棄。`parseFrames(text) → payloads[]`。
- 消費規則（按 JSON payload 的 `m` 欄位分派）：
  - `symbol_resolved` → 記 `meta.symbol = p[2].full_name`；
  - `series_loading` 且 `p[1]` 以 `sds` 開頭 → **重置該 series 的 ChartBuffer**（換符號/週期/重連的統一信號）；
  - `timescale_update` → 取 `p[1][key]`（key 匹配 `/^sds_/`，實測為 `sds_1`）之 `s[]`：每條 `{i, v}`，**`v=[time,open,high,low,close,volume]`（time 為 epoch 秒）**，整段 upsert（實測一次 300 根，i=0..299）；同型但 `p[1]==={}` 者（未來刻度排程）丟棄；
  - `du` → 只取 `p[1]` 中 `/^sds_/` key 的 `s[]`（實測恆為尾根 `{i:299,v:[...]}`），upsert 覆寫；`st` 結尾的 study 鍵第二期前不消費；
  - 其餘（`qsd`、`*_completed`…）丟棄並計數（`droppedFrames` 進除錯面板）。
- **timeframe 不在下行協定中**：`meta.resolution` 讀 `location.search` 的 `interval`（TV 於 SPA 內同步改寫 URL），並與 tsu 相鄰 time 差交叉校驗，不一致以 URL 為準＋warn 計數。
- 第一期只消費「圖表自己已經請求的資料」：不主動發送任何自製訂閱幀。協定解析集中於 `lib/ws-parse.js` 的 `parseMemFrames`（名字沿用，回傳 `{seriesKey, bars, meta?, control:'load|complete'}`）；解析不了的幀靜默丟棄並計數。
- 節流：每 2 秒最多一次 `SNAPSHOT_UPSERT`，只送**增量** bar（time > 上次已送最大 time，或尾根數值有變）。
- 已知逃生門（預留介面，不实裝）：`seriesKey` 結構保留，供第二期主動發訂閱幀拉更深歷史或抓 study 值。

### 4.3 ChartBuffer（lib/chart-buffer.js）

- `upsertBars(bars)`：以 `bars[i][0]`（epoch 秒）為 key 的 Map；重複 time 以數值欄位 merge（最後一根收盤價會持續刷新）。
- 上限 `MAX_BARS = 3000`（超出丟最舊；只影響記憶體，預測預設只取最近 `bars` 根，見 Options）。
- `snapshot(n)` → 按 time 排序取最近 n 根 `{ symbol?, resolution?, bars, meta:{count, firstTime, lastTime, source:'tv-ws-listen'} }`。

### 4.4 systemone 請求 Contract（lib/jev-client.js + state-builder.js）

```jsonc
// POST https://api.typesafe.ai/v1/systemone
// Authorization: Bearer <key from chrome.storage.local, never logged>
{
  "model": "jev-latest",                      // 必填；Options 可切 jev-preview
  "state": {
    "symbol": "BTCUSD",
    "resolution": "1D",
    "generatedAt": "2026-09-21T10:00:00+08:00",
    "barsWindow": 300,
    "columns": ["time","open","high","low","close","volume"],
    "bars": [[1690000000,1,2,0.5,1.5,100], ...],   // 列式，省 token
    "features": { "ma20": 63000.1, "ma50": 58000.2, "rsi14": 55.3,
                  "momentumPct5": 2.1, "rangePct20": 8.4, "lastClose": 64000 }
  },
  "questions": {
    "direction": { "type": "choice",
      "instructions": "Given the candlestick series in `state`, what is the trade direction for the next several bars?",
      "criteria": {
        "long":  "Price more likely to rise than fall from here",
        "neutral": "No clear edge; range-bound or conflicting signals",
        "short": "Price more likely to fall than rise from here" } },
    "up_10_bars": { "type": "noul",
      "instructions": "Will the close 10 bars from now be above the latest close?" },
    "trend_strength": { "type": "score",
      "instructions": "How strong is the prevailing trend in this series?",
      "criteria": ["none","weak","moderate","strong","very strong"] }
  }
}
```

回應（已查證 docs.typesafe.ai/api）：`{ model, answers:{direction:{choice,probabilities,confidence}, up_10_bars:{noul}, trend_strength:{score,legend,probabilities,confidence}}, usage:{input_tokens,output_tokens} }`。

錯誤正規化（client 一律拋統一 `JevError{kind}`）：`no_key`(未設定) / `auth_401` / `bad_request_422` / `rate_429`（退避重試 500ms→1s→2s，3 次後 `rate_exhausted`）/ `overloaded_529`（同 429）/ `timeout` / `offline` / `offhost`(回應非 2xx 其他)。429/529 之外的非 2xx **不重試**。原因：Jev 是判斷服務不是資料服務，重複打非限流錯誤沒有意義。

### 4.5 manifest.json 關鍵段（v3）

```jsonc
{
  "manifest_version": 3,
  "name": "Jev Signal",
  "version": "0.1.0",
  "permissions": ["storage", "sidePanel", "activeTab"],
  "host_permissions": [
    "https://www.tradingview.com/*",     // 注入＋旁聽其 ws
    "https://api.typesafe.ai/*"          // 唯一外呼出口
  ],
  "background": { "service_worker": "background/service-worker.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://www.tradingview.com/chart/*"],
      "js": ["content/inject.js"], "run_at": "document_start", "world": "MAIN" },
    { "matches": ["https://www.tradingview.com/chart/*"],
      "js": ["content/bridge.js"], "run_at": "document_start" }
  ],
  "side_panel": { "default_path": "sidepanel/sidepanel.html" },
  "options_page": "options/options.html",
  "action": { "default_title": "Open Jev Signal" }
}
```

inject.js 與 bridge.js 一律**靜態宣告**於 manifest `content_scripts`（`world:'MAIN'` / `run_at:'document_start'` 直接支援，見 §4.5）→ 命中 matches 即保證先於頁面建 ws。不使用 `chrome.scripting` 動態註冊（多一條權限、多一套注釋、且無 injectImmediately 等價物流）。Task 01 取證用 CDP 導航級注入＝靜態宣告之時序等價路徑，結論直接適用。（原「經 registerContentScripts 註冊」之表述作廢；`permissions` 移除 `scripting`。）

### 4.6 lib 模組載入模型（Task 06 定案）

Chrome content script 是 classic script，`export` 語法不可用；同一批 lib 又要在 Node（ESM）裡被 unit test 與 SW import。定案：**`lib/protocol.js`、`lib/ws-parse.js` 探「無 export、`globalThis.X = X` 暴露」的雙相容寫法**；需要它倆的 ESM 檔（SW 鏈上的 state-builder/jev-client 等）一律 `import './protocol.js'`（side-effect，填充 globalThis）＋`const { X } = globalThis` 取值。**禁止**在雙相容檔使用 `export`；測試檔同側讀 globalThis，斷言邏輯不動。SW 本身仍為 `type: module`，可 import 有 export 的純 ESM 檔（features/state-builder/jev-client/chart-buffer 維持 ESM 即可，因其不進 content script 棧）。

## 5. 安全規則

1. API key 只存 `chrome.storage.local`（Options 輸入，password input，顯示僅掩碼）；**只允許**在 `lib/jev-client.js` 內讀取並在 fetch 瞬間成 header。原因：單點管控，audit 只 grep 一處。
2. 任何 log（含 `console.log`、除錯面板、錯誤訊息）不得含 header 或 key 片段；client 拋錯前主動剝除。
3. Panel 的「原始 payload」不含 key（key 在 header 不在 body）。
4. host_permissions 封死兩條 origin；程式中禁止拼接任意 URL 出口。
5. 结果 UI 底部常駐固定語：「僅供研究參考，不構成投資建議」。

## 6. dsh/pi 禁令清單（派工專用）

- 禁止新增任何 npm 依賴或 build step；測試只用 `node --test`。
- 禁止修改 `docs/` 下任何文件（規格由架構師維護）。
- 禁止在 `extension/lib/*` 之外的檔案實作 fetch 到外網（外部呼叫收斂到 jev-client.js）。
- 禁止把 chrome.* API 帶進 `lib/`（lib 必須可在 Node 直接 import，這是可測試性的前提）。
- 禁止改動頁面 ws 的 `send`（只包 `onmessage` 監聽；動到出口函式即算失敗）。
- prompt 模板／questions 常數集中在 `lib/state-builder.js`，不得散落在 SW/UI。
- 每個任務驗收命令必須在 git-bash（Windows）可直接執行，路徑用 `C:/...` 前斜線格式。
