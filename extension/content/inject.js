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
  // §4.2.1：主圖 series key 單一來源在 lib/protocol.js；這裡只讀取，不硬寫字面值。
  var mainSeriesKey =
    typeof MAIN_SERIES_KEY !== 'undefined' ? MAIN_SERIES_KEY : undefined;

  // §4.2.1 規則 2：符號身分（sds_sym_1／ss_1）會於站內換商品時重新編號，
  // 故不得用固定索引判斷主圖；改以符號「內容」判定：INTERNAL:* 為 TV 內部
  // 輔助序列，一律忽略；其餘非空字串才是真實商品符號。
  function isRealSymbol(name) {
    return (
      typeof name === 'string' &&
      name.length > 0 &&
      name.indexOf('INTERNAL:') !== 0
    );
  }

  // 內部狀態
  var bars = new Map(); // time -> [t,o,h,l,c,v]
  var sent = new Map(); // time -> 已上送版本（增量游標）
  var symbol = null;
  var dropped = 0;
  var ignoredSeriesFrames = 0; // §4.2.1：非主圖 series 丟棄的幀數
  var pendingReset = false;
  var emitTimer = null;
  var timeframeChecked = false;
  var lastResolution = '1'; // 讀不到 interval 時沿用的上一次值

  /**
   * 09d-1：讀「當下」URL 的 interval；讀不到（或非 http(s) 頁面／無 search）回 null。
   * 呼叫端負責沿用 lastResolution，值不得變成 undefined/null。
   */
  function readResolutionFresh() {
    try {
      var search = (typeof location !== 'undefined' && location.search) || '';
      var m = /[?&]interval=([^&]*)/.exec(search);
      if (!m) return null;
      var v = m[1];
      try {
        v = decodeURIComponent(v);
      } catch (e) {
        /* 保留原值 */
      }
      return v || null;
    } catch (e) {
      return null;
    }
  }

  /** timeframe：TV 於 SPA 內同步改寫 URL；每次呼叫都重讀，讀不到沿用上一次。 */
  function readResolution() {
    var fresh = readResolutionFresh();
    if (fresh != null) lastResolution = fresh;
    return lastResolution;
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
      // §4.2.1：只有主圖 series 的 bar 進緩衝；其他 series 丢棄並計數。
      if (res.seriesKey === mainSeriesKey) {
        rememberBars(res.bars);
      } else {
        ignoredSeriesFrames += 1;
      }
    } else if (res.kind === 'meta') {
      // §4.2.1 規則 2／6：以符號內容判定真實商品，不依賴可變的身分索引。
      var nextSymbol = res.symbol;
      if (isRealSymbol(nextSymbol)) {
        if (nextSymbol !== symbol) {
          // 規則 3：真實商品變更（含首次得知）→ 完整重置，避免新舊商品 bar 混入。
          // INTERNAL:* 不會走到這裡，故不會清任何東西。
          bars.clear();
          sent.clear();
          pendingReset = true;
          schedule();
        }
        symbol = nextSymbol;
      } else {
        ignoredSeriesFrames += 1;
      }
    } else if (res.kind === 'control') {
      if (res.action === 'reset') {
        // §4.2.1：只有 sds_1 的 reset 作用於主圖；sds_2+ 的 reset 完全無效。
        if (res.seriesKey === mainSeriesKey) {
          // §4.7.1：reset 只重置「已送出」游標，不得清除未送出的 bar。
          sent.clear();
          pendingReset = true;
          schedule();
        } else {
          ignoredSeriesFrames += 1;
        }
      } else if (res.seriesKey !== mainSeriesKey) {
        // 輔助序列的 streaming 控制訊號一律忽略並計數。
        ignoredSeriesFrames += 1;
      }
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
      // §4.8.1：隨每則 upsert 捎帶旁聽計數（新增欄位；既有 payload 欄位形狀不變）。
      counters: { dropped: dropped, ignoredSeriesFrames: ignoredSeriesFrames },
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
    // 常數（CONNECTING/OPEN/CLOSING/CLOSED）：原生為唯讀屬性（真機為 constructor 上
    // 的 non-writable；部分環境只暴露在 prototype getter），直接賦值
    // `JevWebSocket.OPEN = ...` 在 strict 下會拋 TypeError 並讓整段包裝中止
    // （Task 09 真機根因）。改用「不賦值」的 getter：來源優先 constructor，
    // 回退 prototype，兩種環境都可見且維持唯讀語意。
    var WS_CONSTANTS = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    for (var ci = 0; ci < WS_CONSTANTS.length; ci += 1) {
      (function (name) {
        Object.defineProperty(JevWebSocket, name, {
          configurable: true,
          enumerable: true,
          get: function () {
            return name in NativeWS ? NativeWS[name] : NativeWS.prototype[name];
          },
        });
      })(WS_CONSTANTS[ci]);
    }
    W.WebSocket = JevWebSocket;
  }

  // bridge.js 收到 SW 的 REQ_SNAPSHOT 後以 JEV_PING 喚醒，這裡立即 force-emit。
  // §4.7.2：帶 full:true 時先清空已送出游標，立刻全量 flush（reset:true + 全部 bars）；
  // 不帶 full 則維持既有增量補送行為。
  W.addEventListener('message', function (event) {
    if (event.source !== W) return;
    var data = event.data;
    if (!data || data.v !== 1 || data.type !== 'JEV_PING') return;
    if (data.full === true) {
      sent.clear();
      pendingReset = true;
    }
    flush();
  });
})();
