# jev-tradingview-signal（面板名稱：Jev Signal）

在 TradingView 圖表上手動按一次，把自己正在看的圖表資料（**300 根 K 棒 OHLCV ＋本地派生特徵**）送給 [TypeSafe](https://console.typesafe.ai) 的官方 **Jev** 模型做判斷，結果顯示在 Chrome 側邊面板：方向（做多／做空／觀望）、未來 10 根上漲機率、多頭趨勢強度、空頭趨勢強度。

> 個人研究工具：**不會自動下單、不碰券商 API、不保存交易紀錄、不做回測**。輸出僅供研究參考，不構成投資建議。

## 特色

- **零 npm 依賴、無 build step**：純 Chrome MV3 ＋ 原生 ES 模組，複製目錄就能用
- **只讀不干擾**：以 `world: MAIN` 旁聽 TradingView 自家 WebSocket 的**已載入**資料，**不改送、不主動訂閱**任何幀
- **金鑰只存在瀏覽器**：TypeSafe API key 只寫入 `chrome.storage.local`，只由 service worker 外呼，不進頁面 context、不落 console
- **不經過任何仲介伺服器**：擴充直接呼叫官方 `POST https://api.typesafe.ai/v1/systemone`

## 安裝（載入未封裝）

1. 下載／clone 本專案
2. Chrome → `chrome://extensions` → 開啟右上角「開發人員模式」→「載入未封裝項目」→ 選 `extension/` 資料夾
3. 點擴充圖示開啟側邊面板 → 在設定頁貼上 TypeSafe API key（在 console.typesafe.ai 申請）

## 使用

1. 在 Chrome 打開一個 TradingView 圖表（`tradingview.com/chart/...`）
2. 開啟本擴充的側邊面板，狀態列會顯示目前圖表：`圖表：BINANCE:BTCUSDT · 15 · 300 根`
3. 按「**預測**」→ 面板顯示 Jev 的判斷（含使用量、成本、耗時）

開圖後 K 棒會自動累積；站內切換商品時面板會跟著更新（緩衝重置為新商品）。

## 實測數據

| 項目 | 實測值 |
|---|---|
| 單次預測成本 | ≈ **$0.0007**（約 NT$0.02） |
| 單次往返時間 | ≈ 1.0 秒 |
| 單次 token | ≈ 17,500 tokens（送 300 根 K 棒＋派生特徵） |
| 模型 | `jev-latest`（實裝判別版本 `jev-1.13.0`） |

## 專案結構

```
extension/
  manifest.json        MV3 manifest（host_permissions 僅 tradingview.com 與 api.typesafe.ai）
  content/inject.js    world:MAIN，包裝 WebSocket 旁聽 TV 私有協定（不改送）
  content/bridge.js    isolated world 橋接（content → service worker）
  background/          service worker（訊息路由、狀態、預測呼叫）
  lib/                 協定、解析、緩衝、特徵、state 組裝、Jev client（可單獨在 Node 測）
  sidepanel/ options/  側邊面板與設定頁
docs/                  PRD、ARCHITECTURE、TASK、協定取證筆記、試用步驟
scripts/               靜態檢查 gate、驗收／診斷腳本
tests/                 node --test（130 項）＋真機抓幀 fixture
```

## 開發與測試

```bash
node --test                     # 單元測試（130/130）
node scripts/static-check.mjs task02   # 靜態 gate（task02/06/07/08）
node scripts/verify-inject.mjs         # ws 包裝器行為驗證
```

真機端到端驗收（架構師自用；需 Playwright 自帶的 Chromium，因為 branded Chrome 153 起已移除 `--load-extension`）：

```bash
node scripts/e2e-real-chrome.mjs 9333   # 載入擴充→真 TradingView→真 TypeSafe API
```

## 已知限制

- 依賴 TradingView **私有** WebSocket 協定（本專案以真機抓幀取證定案，見 `docs/WS-NOTES.md`）；TV 改版可能導致取數失效
- 只使用「圖表自己已載入」的 K 棒（通常 300 根），不主動拉更深歷史
- 決策完全由 Jev 模型輸出，本專案不做任何本地買賣建議

## 授權

MIT License（見 `LICENSE`）—— 任何人都可自由使用、修改、再散布。

## 免責聲明

本專案僅為技術研究與個人輔助工具，所有輸出皆來自第三方模型（TypeSafe Jev）的判斷，**不構成任何投資建議**。金融市場交易具高度風險，請自行判斷並承擔後果。本專案不連接任何券商、不下單、不保證任何獲利。
