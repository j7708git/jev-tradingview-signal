import { test } from 'node:test';
import assert from 'node:assert/strict';

// lib 為 classic-script 雙相容（無 ESM export，符號掛在 globalThis）；此處以 side-effect 載入後取用。
import '../extension/lib/protocol.js';

const {
  PROTOCOL_VERSION,
  BAR_COLUMNS,
  MSG,
  TV_WS_URL_RE,
  makeMessage,
  COST_USD_PER_MTOK,
} = globalThis;

test('PROTOCOL_VERSION 為 1', () => {
  assert.equal(PROTOCOL_VERSION, 1);
});

test('BAR_COLUMNS 欄位序為 [time,open,high,low,close,volume]', () => {
  assert.deepEqual(BAR_COLUMNS, [
    'time',
    'open',
    'high',
    'low',
    'close',
    'volume',
  ]);
});

test('MSG 鍵集合完整（§4.8.4 收斂後）且每個值為對應字串', () => {
  assert.deepEqual(
    Object.keys(MSG).sort(),
    [
      'HELLO',
      'PING',
      'WS_DATA',
      'SNAPSHOT_UPSERT',
      'STUDIES_UPSERT',
      'REQ_SNAPSHOT',
      'RUN_PREDICTION',
      'PREDICTION_UPDATED',
      'GET_STATE',
      'SET_ACTIVE_TAB',
      'ACTIVE_TAB_QUERY',
      'TEST_KEY',
      'GET_LAST_TAB',
      'GET_RING_LOG',
      'RESYNC',
    ].sort(),
  );

  assert.deepEqual(MSG, {
    HELLO: 'JEV_HELLO',
    PING: 'JEV_PING',
    WS_DATA: 'JEV_WS_DATA',
    SNAPSHOT_UPSERT: 'SNAPSHOT_UPSERT',
    STUDIES_UPSERT: 'STUDIES_UPSERT',
    REQ_SNAPSHOT: 'REQ_SNAPSHOT',
    RUN_PREDICTION: 'RUN_PREDICTION',
    PREDICTION_UPDATED: 'PREDICTION_UPDATED',
    GET_STATE: 'GET_STATE',
    SET_ACTIVE_TAB: 'SET_ACTIVE_TAB',
    ACTIVE_TAB_QUERY: 'ACTIVE_TAB_QUERY',
    TEST_KEY: 'TEST_KEY',
    GET_LAST_TAB: 'GET_LAST_TAB',
    GET_RING_LOG: 'GET_RING_LOG',
    RESYNC: 'RESYNC',
  });
});

test('§4.8.2 成本單價 COST_USD_PER_MTOK 為 0.042 且為 globalThis 單一來源', () => {
  assert.equal(COST_USD_PER_MTOK, 0.042);
  assert.equal(globalThis.COST_USD_PER_MTOK, 0.042);
});

test('TV_WS_URL_RE 只接受 wss://*.tradingview.com', () => {
  assert.ok(
    TV_WS_URL_RE.test('wss://prodata.tradingview.com/socket.io/websocket?from=chart'),
  );
  assert.ok(TV_WS_URL_RE.test('wss://tradingview.com/x'));
  assert.ok(TV_WS_URL_RE.test('wss://a-b.c.tradingview.com/x'));

  assert.equal(TV_WS_URL_RE.test('ws://prodata.tradingview.com/x'), false);
  assert.equal(TV_WS_URL_RE.test('wss://nottradingview.com/x'), false);
  assert.equal(TV_WS_URL_RE.test('wss://evil.com/tradingview.com'), false);

  // 修補 A 負例：網域邊界錨點（尾綴假冒 / query 夾帶）
  assert.equal(TV_WS_URL_RE.test('wss://tradingview.com.evil.com/x'), false);
  assert.equal(
    TV_WS_URL_RE.test('wss://evil.com/?u=wss://x.tradingview.com'),
    false,
  );
});

test('makeMessage 產生 {v, type, ...payload}', () => {
  assert.deepEqual(makeMessage(MSG.HELLO, { hooks: true }), {
    v: 1,
    type: 'JEV_HELLO',
    hooks: true,
  });

  // 省略 payload 時仍帶 v / type
  assert.deepEqual(makeMessage(MSG.REQ_SNAPSHOT), {
    v: 1,
    type: 'REQ_SNAPSHOT',
  });
});
