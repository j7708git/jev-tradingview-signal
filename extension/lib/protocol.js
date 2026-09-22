// Classic-script compatible: globals via globalThis; Node tests import the file and read globalThis.
// lib/protocol.js — 訊息協定常數（不得引用 chrome.* 或任何瀏覽器 API）
// 對應 docs/ARCHITECTURE.md §4.1 與 docs/WS-NOTES.md 實測結論。

const PROTOCOL_VERSION = (globalThis.PROTOCOL_VERSION = 1);

// 09e-2：預測最少需要的 K 棒數（單一來源）。sw-core 與 Side Panel 一律讀此值，
// 不得再有第二份數字。低於此值一律拒絕預測（連 API 都不呼叫）。
const PREDICT_MIN_BARS = (globalThis.PREDICT_MIN_BARS = 50);

// §4.8.2：成本單價（USD / 1M input tokens），單一來源。sw-core 的成本計算與
// sidepanel/render.js 的成本列一律引用此值，禁止再有第二份 0.042 字面值。
const COST_USD_PER_MTOK = (globalThis.COST_USD_PER_MTOK = 0.042);

// 09f／§4.2.1：主圖 series key（單一來源）。`sds_2+` 為輔助序列，其 bar/reset/meta
// 一律不得汙染主圖。inject 由此 globalThis 取值，不得散落字面值。
const MAIN_SERIES_KEY = (globalThis.MAIN_SERIES_KEY = 'sds_1');

// bar 欄位序，對齊 TradingView tsu `s[].v` 實測：[time, open, high, low, close, volume]
const BAR_COLUMNS = (globalThis.BAR_COLUMNS = [
  'time',
  'open',
  'high',
  'low',
  'close',
  'volume',
]);

// §4.1 訊息 type 常數
const MSG = (globalThis.MSG = {
  HELLO: 'JEV_HELLO',
  PING: 'JEV_PING',
  WS_DATA: 'JEV_WS_DATA',
  SNAPSHOT_UPSERT: 'SNAPSHOT_UPSERT',
  // §4.2.2／Task 13：指標（study）逐根數值增量（inject→bridge→SW）。
  STUDIES_UPSERT: 'STUDIES_UPSERT',
  REQ_SNAPSHOT: 'REQ_SNAPSHOT',
  RUN_PREDICTION: 'RUN_PREDICTION',
  PREDICTION_UPDATED: 'PREDICTION_UPDATED',
  // §4.8.4：panel 命令類型全數收斂於此（單一來源；sw-core／SW 殼／sidepanel 一律引用）。
  GET_STATE: 'GET_STATE',
  SET_ACTIVE_TAB: 'SET_ACTIVE_TAB',
  ACTIVE_TAB_QUERY: 'ACTIVE_TAB_QUERY',
  TEST_KEY: 'TEST_KEY',
  GET_LAST_TAB: 'GET_LAST_TAB',
  GET_RING_LOG: 'GET_RING_LOG',
  RESYNC: 'RESYNC',
});

// 實測承載圖表資料的 ws 是 wss://prodata.tradingview.com/socket.io/websocket
// 邊界錨點（`(\/|$)`）堵 `tradingview.com.evil.com`、`?u=wss://x.tradingview.com` 之類的誤判。
const TV_WS_URL_RE = (globalThis.TV_WS_URL_RE =
  /^wss:\/\/([a-z0-9-]+\.)*tradingview\.com(:\d+)?(\/|$)/i);

/**
 * 組出帶版本欄位的協定訊息：`{v: PROTOCOL_VERSION, type, ...payload}`。
 * @param {string} type
 * @param {object} [payload]
 * @returns {{v:number, type:string} & object}
 */
function makeMessage(type, payload) {
  return { v: PROTOCOL_VERSION, type, ...payload };
}
globalThis.makeMessage = makeMessage;
