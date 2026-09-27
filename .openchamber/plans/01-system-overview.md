# 系統全貌（jev-tradingview-signal / Jev Signal）

個人用 Chrome MV3 擴充：在 TradingView 圖表上按一次，把當前圖表已載入的資料送給 TypeSafe 官方 Jev
模型做一次盤勢判斷，結果顯示在 Side Panel。**判斷輔助工具，不是交易系統**——不連券商、不下單、不回測。

## 硬約束（違反即為缺陷）

- **零 npm runtime 依賴、無 build step、無打包器**。`fetch` + `chrome.*` + 純數學就是全部。
- `extension/lib/*` **不得 import `chrome.*`**（這是可測試性的前提：同一批模組要在 Node 裡被 unit test）。
- 對外網路**只准**在 `lib/jev-client.js`（單點管控，audit 只 grep 一處）。
- `host_permissions` 封死兩條：`https://www.tradingview.com/*`、`https://api.typesafe.ai/*`。
- content script 是 classic script → 進 content 棧的 `protocol.js`／`ws-parse.js` **不得用 `export`**，
  改 `globalThis.X = X` 暴露，ESM 側用 side-effect import 取值（ARCHITECTURE §4.6）。
- `docs/` 由架構師維護；派工者（pi）不得修改文件。

## 資料流（六段）

```
TradingView 分頁
  page context (world:MAIN)   content/inject.js  包 window.WebSocket，旁聽 socket.io 幀
        │ window.postMessage（驗 source/origin/v=1）
  isolated                   content/bridge.js  重連、心跳、full 旗標轉發
        │ chrome.runtime
  background                 service-worker.js（薄殼）→ lib/sw-core.js（可測核）
        │                    tabId → ChartBuffer + studies registry
        │                    buildState → features → buildStudies → fitStateToBudget
        │ lib/jev-client.js（fetch、退避重試、逾時、redact）
        ▼
  POST https://api.typesafe.ai/v1/systemone   model=jev-latest，四題
        ▼
  Side Panel：方向徽章、機率條、confidence、bull/bear 趨勢、token 成本、原始 JSON
```

外部依賴只有 `api.typesafe.ai` 一處。時間框架（resolution）**不在協定內**，讀 `location.search` 的
`interval`（TV 自己會在 SPA 期間寫錯，實測寫 1 而畫面是 15m——以畫面為準，讀 URL 只是無害加固）。

## 模組地圖

| 檔案 | 職責 |
| --- | --- |
| `lib/protocol.js` | `MSG` 常數、bar 欄位序、`PREDICT_MIN_BARS=50`、`COST_USD_PER_MTOK=0.042`、`MAIN_SERIES_KEY='sds_1'` |
| `lib/ws-parse.js` | 幀分幀、payload 分派、`create_study`／`du` study 解析（無 export） |
| `lib/chart-buffer.js` | 增量 upsert、MAX_BARS=3000、`snapshot(n)` |
| `lib/features.js` | MA20/50、RSI14（Wilder）、動量、区間%（純數學） |
| `lib/state-builder.js` | snapshot+features+studies → systemone `state`；`INPUT_BUDGET_CHARS=29000` 預算守門 |
| `lib/jev-client.js` | 唯一 fetch 出口；錯誤正規化為 `JevError{kind}` |
| `lib/sw-core.js` | SW 可測核（零 `chrome.*`）：registry、predict、ring log、RESYNC |
| `background/service-worker.js` | 薄殼：訊息路由、`storage.session` 持久化、panel 身分判讀 |
| `sidepanel/app.js`+`render.js` | 狀態機、指標映射 UI（F10 改名／F11 排除）、除錯區 |
| `options/app.js`+`render.js` | API key（password）、model、bars 50–1000、特徵開關 |

## 現況（2026-09-28）

- Task 01–15 全數完成，四期（風險消減／純資料層／接線／二期指標）皆已驗收，含真機 e2e。
- `npm test` **209/209**（主 checkout 保留 gitignored 的 `scratch/` 時為 210）；static-check task02/06/07/08 四 gate ALL PASS；verify-inject 19/19 PASS。
- 成本：無指標 ≈$0.0007／次；掛 10 指標 ≈$0.0012／次（標準 ≤$0.005）。單次約 1 秒。
- repo：`https://github.com/j7708git/jev-tradingview-signal`（public, MIT）。

## 驗收命令（每次改完必跑）

```bash
npm test                                  # 209/209；勿用 node --test tests/（Node 24 會壞）
node scripts/static-check.mjs task02      # 無依賴 + manifest + lib 無 chrome.*
node scripts/static-check.mjs task06      # inject 不改 send、零 fetch
node scripts/static-check.mjs task07      # SW 無直接外呼、sw-core 零 chrome.*
node scripts/static-check.mjs task08      # 無 inline script、無外部資源
node scripts/verify-inject.mjs            # 19/19 行為臺（真實幀餵入）
```

真機 e2e（架構師專用，需 Playwright Chromium）：`node scripts/e2e-real-chrome.mjs`、
`node scripts/e2e-error-paths.mjs`。

## 規格真源

| 文件 | 內容 |
| --- | --- |
| `docs/ARCHITECTURE.md` | §4.2 協定、§4.4 state/questions、§4.4.1 預算守門、§4.7 重同步、§4.8 除錯 |
| `docs/WS-NOTES.md` | TradingView 私有協定取證（§1–6 K棒、§7 指標） |
| `docs/PRD.md` | F1–F11、Non-Goals、成功標準 |
| `docs/TASK.md` | 15 個任務的完成紀錄與真機證據 |
| `docs/TRY-IT.md` | 人工驗收步驟 |
| `README.md` | 對外說明 |
