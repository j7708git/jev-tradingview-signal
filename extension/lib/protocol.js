// lib/protocol.js — 訊息協定常數（純 ESM，不得引用 chrome.* 或任何瀏覽器 API）
// 對應 docs/ARCHITECTURE.md §4.1 與 docs/WS-NOTES.md 實測結論。

export const PROTOCOL_VERSION = 1;

// bar 欄位序，對齊 TradingView tsu `s[].v` 實測：[time, open, high, low, close, volume]
export const BAR_COLUMNS = ['time', 'open', 'high', 'low', 'close', 'volume'];

// §4.1 訊息 type 常數
export const MSG = {
  HELLO: 'JEV_HELLO',
  PING: 'JEV_PING',
  WS_DATA: 'JEV_WS_DATA',
  SNAPSHOT_UPSERT: 'SNAPSHOT_UPSERT',
  REQ_SNAPSHOT: 'REQ_SNAPSHOT',
  RUN_PREDICTION: 'RUN_PREDICTION',
  PREDICTION_UPDATED: 'PREDICTION_UPDATED',
};

// 實測承載圖表資料的 ws 是 wss://prodata.tradingview.com/socket.io/websocket
// 邊界錨點（`(\/|$)`）堵 `tradingview.com.evil.com`、`?u=wss://x.tradingview.com` 之類的誤判。
export const TV_WS_URL_RE = /^wss:\/\/([a-z0-9-]+\.)*tradingview\.com(:\d+)?(\/|$)/i;

/**
 * 組出帶版本欄位的協定訊息：`{v: PROTOCOL_VERSION, type, ...payload}`。
 * @param {string} type
 * @param {object} [payload]
 * @returns {{v:number, type:string} & object}
 */
export function makeMessage(type, payload) {
  return { v: PROTOCOL_VERSION, type, ...payload };
}
