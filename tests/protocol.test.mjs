import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_VERSION,
  BAR_COLUMNS,
  MSG,
  TV_WS_URL_RE,
  makeMessage,
} from '../extension/lib/protocol.js';

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

test('MSG 鍵集合完整且每個值為對應字串', () => {
  assert.deepEqual(
    Object.keys(MSG).sort(),
    [
      'HELLO',
      'PING',
      'WS_DATA',
      'SNAPSHOT_UPSERT',
      'REQ_SNAPSHOT',
      'RUN_PREDICTION',
      'PREDICTION_UPDATED',
    ].sort(),
  );

  assert.deepEqual(MSG, {
    HELLO: 'JEV_HELLO',
    PING: 'JEV_PING',
    WS_DATA: 'JEV_WS_DATA',
    SNAPSHOT_UPSERT: 'SNAPSHOT_UPSERT',
    REQ_SNAPSHOT: 'REQ_SNAPSHOT',
    RUN_PREDICTION: 'RUN_PREDICTION',
    PREDICTION_UPDATED: 'PREDICTION_UPDATED',
  });
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
