// content/inject.js — world:MAIN 的 ws 旁聽器（classic script，無 import/export）。
// 包裝 window.WebSocket，僅對 tradingview.com 的 ws 掛 onmessage 旁聽；
// 依 lib/ws-parse.js 的 parseFrames/classifyPayload 累積 bar，節流以 window.postMessage
// 對 isolated 的 bridge.js 增量上送 SNAPSHOT_UPSERT。
// 零 fetch、零 chrome.*（MAIN 世界拿不到也不該要）。
(function () {
  'use strict';

  var W = window;

  // 冪等：重複載入不得雙包 WebSocket。
  if (W.__JEV_HOOK) return;
  W.__JEV_HOOK = true;

  var DEFAULT_EMIT_MS = 2000;
  var TV_ORIGIN =
    (typeof location !== 'undefined' && location.origin) ||
    'https://www.tradingview.com';

  // lib 符號（manifest 保證 lib/protocol.js → lib/ws-parse.js 先載；此處防禦性取用）。
  var fnParseFrames = typeof parseFrames === 'function' ? parseFrames : null;
  var fnClassify = typeof classifyPayload === 'function' ? classifyPayload : null;
  var wsRe = typeof TV_WS_URL_RE !== 'undefined' ? TV_WS_URL_RE : null;
  var snapshotType =
    typeof MSG !== 'undefined' && MSG && MSG.SNAPSHOT_UPSERT
      ? MSG.SNAPSHOT_UPSERT
      : 'SNAPSHOT_UPSERT';

  // 內部狀態
  var bars = new Map(); // time -> [t,o,h,l,c,v]
  var sent = new Map(); // time -> 已上送版本（增量游標）
  var symbol = null;
  var dropped = 0;
  var pendingReset = false;
  var emitTimer = null;
  var timeframeChecked = false;

  /** timeframe：TV 於 SPA 內同步改寫 URL，讀 `interval`（缺省 '1'）。 */
  function readResolution() {
    var search = (typeof location !== 'undefined' && location.search) || '';
    var m = /[?&]interval=([^&]*)/.exec(search);
    if (!m) return '1';
    var v = m[1];
    try {
      v = decodeURIComponent(v);
    } catch (e) {
      /* 保留原值 */
    }
    return v || '1';
  }

  function barEquals(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /** tsu 相鄰 time 差與 URL interval 交叉校驗；不一致 warn 一次，以 URL 為準。 */
  function crossCheckTimeframe(list) {
    if (timeframeChecked || !Array.isArray(list) || list.length < 2) return;

    var times = [];
    for (var i = 0; i < list.length; i += 1) {
      var t = list[i] && list[i][0];
      if (typeof t === 'number' && isFinite(t)) times.push(t);
    }
    if (times.length < 2) return;
    times.sort(function (a, b) {
      return a - b;
    });

    var diff = Infinity;
    for (var j = 1; j < times.length; j += 1) {
      var d = times[j] - times[j - 1];
      if (d > 0 && d < diff) diff = d;
    }
    if (!isFinite(diff)) return;

    timeframeChecked = true;
    var res = readResolution();
    if (/^\d+$/.test(res)) {
      var expectedSec = Number(res) * 60;
      if (expectedSec !== diff) {
        console.warn(
          '[jev-signal] interval/timeframe 交叉校驗不一致：URL interval=' +
            res +
            '（' +
            expectedSec +
            's）vs tsu 相鄰 time 差 ' +
            diff +
            's；以 URL 為準。'
        );
      }
    }
  }

  /** kind:'bars' → Map<time,bar> upsert。 */
  function rememberBars(list) {
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; i += 1) {
      var b = list[i];
      if (!Array.isArray(b) || b.length < 6) {
        dropped += 1;
        continue;
      }
      var bar = b.slice(0, 6);
      bars.set(bar[0], bar);
    }
    crossCheckTimeframe(list);
    schedule();
  }

  /** 逐 payload 依 §4.2 消費規則分派。 */
  function handlePayload(jsonText) {
    if (!fnClassify) {
      dropped += 1;
      return;
    }
    var res;
    try {
      res = fnClassify(jsonText);
    } catch (e) {
      dropped += 1;
      return;
    }
    if (!res || res.kind === 'ignore') {
      dropped += 1;
      return;
    }

    if (res.kind === 'bars') {
      rememberBars(res.bars);
    } else if (res.kind === 'meta') {
      symbol = res.symbol;
    } else if (res.kind === 'control') {
      if (res.action === 'reset') {
        bars.clear();
        sent.clear();
        pendingReset = true;
        schedule();
      }
      // action:'streaming' 無需處理
    }
  }

  function onSocketMessage(event) {
    var data = event && event.data;
    if (typeof data !== 'string') {
      dropped += 1;
      return;
    }
    if (!fnParseFrames) return;
    var payloads = fnParseFrames(data);
    for (var i = 0; i < payloads.length; i += 1) handlePayload(payloads[i]);
  }

  /** 節流：每 EMIT_MS（可被 window.__JEV_EMIT_MS 覆蓋）最多排一次。 */
  function schedule() {
    if (emitTimer !== null) return;
    var ms = W.__JEV_EMIT_MS;
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) ms = DEFAULT_EMIT_MS;
    emitTimer = setTimeout(flush, ms);
  }

  /** 立即上送自上次 emission 以來新增/變更的 bar；游標推進。 */
  function flush() {
    if (emitTimer !== null) {
      clearTimeout(emitTimer);
      emitTimer = null;
    }

    var changed = [];
    bars.forEach(function (bar, time) {
      var prev = sent.get(time);
      if (!prev || !barEquals(prev, bar)) changed.push(bar);
    });
    changed.sort(function (a, b) {
      return a[0] - b[0];
    });

    var wasReset = pendingReset;
    pendingReset = false;

    var msg = {
      v: 1,
      type: snapshotType,
      reset: wasReset,
      bars: changed,
      meta: {
        symbol: symbol,
        resolution: readResolution(),
        total: bars.size,
        dropped: dropped,
        ts: Date.now(),
      },
    };

    for (var i = 0; i < changed.length; i += 1) {
      sent.set(changed[i][0], changed[i].slice(0, 6));
    }

    W.postMessage(msg, TV_ORIGIN);
    return msg;
  }

  // 測試鉤子：可重複呼叫；flush 後游標推進（下次只送增量）。
  W.__JEV_FORCE_EMIT = flush;

  // 包裝 WebSocket 為子類構造器：僅 TV 連線掛監聽；send/close/addEventListener/
  // removeEventListener 與回傳值一律不動（純透傳）。
  var NativeWS = W.WebSocket;
  if (typeof NativeWS === 'function' && wsRe) {
    var JevWebSocket = class extends NativeWS {
      constructor() {
        super(...arguments);
        var url = arguments[0];
        if (typeof url === 'string' && wsRe.test(url)) {
          this.addEventListener('message', onSocketMessage);
        }
      }
    };
    // 轉掛常數，避免頁面讀到 undefined。
    JevWebSocket.CONNECTING = NativeWS.CONNECTING;
    JevWebSocket.OPEN = NativeWS.OPEN;
    JevWebSocket.CLOSING = NativeWS.CLOSING;
    JevWebSocket.CLOSED = NativeWS.CLOSED;
    W.WebSocket = JevWebSocket;
  }

  // bridge.js 收到 SW 的 REQ_SNAPSHOT 後以 JEV_PING 喚醒，這裡立即 force-emit。
  W.addEventListener('message', function (event) {
    if (event.source !== W) return;
    var data = event.data;
    if (!data || data.v !== 1 || data.type !== 'JEV_PING') return;
    flush();
  });
})();
