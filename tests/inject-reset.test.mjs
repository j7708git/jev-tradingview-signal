// tests/inject-reset.test.mjs — Task 09c §4.7.1 / §4.7.2 的 inject 端行為測試。
// 以 vm 沙箱依 manifest 宣告順序載入 protocol→ws-parse→inject（classic-script），
// 用 mock WebSocket 餵真實格式幀，斷言 flush 的 reset/bars 語意。零網路、零 chrome.*。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(p, 'utf8');
const toClassic = (src) =>
  src
    .replace(/^import[^;\n]*;?$/gm, '')
    .replace(/^export\s+(const|let|var)\s+(\w+)\s*=/gm, '$1 $2 = globalThis.$2 =')
    .replace(/^export\s+(async\s+)?function\s+(\w+)/gm, '$1function $2');

const TV_WS = 'wss://prodata.tradingview.com/socket.io/websocket?from=chart';

/** 一根 6 欄 bar。 */
function makeBars(from, n) {
  return Array.from({ length: n }, (_, i) => [from + i * 60, 1, 2, 0.5, 1.5, 100]);
}

/** socket.io 文字分幀：~m~<len>~m~<json>。 */
function frame(obj) {
  const p = JSON.stringify(obj);
  return `~m~${p.length}~m~${p}`;
}

/** timescale_update：p[1][key].s[] 每條 {i, v}（預設主圖 sds_1）。 */
function tsu(list, key) {
  const seriesKey = key || 'sds_1';
  return {
    m: 'timescale_update',
    p: ['cs_TEST', { [seriesKey]: { s: list.map((v, i) => ({ i, v })) } }],
  };
}

/** series_loading(sds_*) → inject classify 為 reset 控制訊號（預設主圖 sds_1）。 */
function seriesLoading(key) {
  return { m: 'series_loading', p: ['cs_TEST', key || 'sds_1', 's1'] };
}

/** symbol_resolved → inject classify 為 meta（預設主圖身分 sds_sym_1）。 */
function symbolResolved(name, ref) {
  return {
    m: 'symbol_resolved',
    p: ['cs_TEST', ref || 'sds_sym_1', { full_name: name }],
  };
}

/** 建立沙箱並載入 manifest MAIN 棧；回傳操作把手。 */
function setup() {
  const captured = []; // { msg, target }
  const listeners = {}; // window message listeners（JEV_PING 用）
  const timers = [];

  class MockWS {
    constructor(url) {
      MockWS.instances.push(this);
      this.url = url;
      this._l = {};
    }
    addEventListener(t, f) {
      (this._l[t] ||= []).push(f);
    }
    removeEventListener(t, f) {
      this._l[t] = (this._l[t] || []).filter((x) => x !== f);
    }
    send() {
      (this.sentArgs ||= []).push(Array.from(arguments));
      if (this.throwOnSend) throw this.throwOnSend;
      return this.sendReturn;
    }
    close() {
      this.closed = true;
    }
    dispatch(data) {
      for (const f of this._l.message || []) f({ data });
    }
  }
  for (const [k, v] of [
    ['CONNECTING', 0],
    ['OPEN', 1],
    ['CLOSING', 2],
    ['CLOSED', 3],
  ]) {
    Object.defineProperty(MockWS.prototype, k, { get: () => v });
  }
  MockWS.instances = [];

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    location: {
      origin: 'https://www.tradingview.com',
      href: 'https://www.tradingview.com/chart/x/?interval=1',
      search: '?interval=1',
    },
    postMessage: (msg, target) => captured.push({ msg, target }),
    WebSocket: MockWS,
    navigator: { onLine: true },
    document: { visibilityState: 'visible', hidden: false },
    addEventListener: (t, f) => {
      (listeners[t] ||= []).push(f);
    },
    removeEventListener: (t, f) => {
      listeners[t] = (listeners[t] || []).filter((x) => x !== f);
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  const mf = JSON.parse(read('extension/manifest.json'));
  const stack = mf.content_scripts[0].js;
  for (const f of stack) {
    vm.runInContext(toClassic(read('extension/' + f)), ctx, { filename: f });
  }

  const ws = new sandbox.WebSocket(TV_WS);
  // vm 內部的 `window` 是 contextify 後的 global，與外層 sandbox 物件不同一；
  // inject 的 JEV_PING handler 有 `event.source !== window` 校驗，故 source 必須用內部 window。
  const innerWindow = vm.runInContext('window', ctx);
  const fireMessage = (data) => {
    for (const f of listeners.message || []) f({ source: innerWindow, data });
  };
  const messages = () => captured.map((c) => c.msg);
  // Task 13 起每次 flush 可能在 SNAPSHOT_UPSERT 後再帶一則 STUDIES_UPSERT；
  // 既有斷言全部針對 bar 快照，故 last() 只取最近一則 SNAPSHOT_UPSERT。
  const last = () =>
    messages().filter((m) => m && m.type === 'SNAPSHOT_UPSERT').at(-1);
  const lastOf = (type) =>
    messages().filter((m) => m && m.type === type).at(-1);
  return { sandbox, ws, captured, messages, last, lastOf, fireMessage };
}

test('§4.7.1 reset 不清空未送出的 bar；reset 後第一次 flush 全量（reset:true）', () => {
  const h = setup();

  // 5 根已進 buffer、尚未 flush（節流窗內）。
  h.ws.dispatch(frame(tsu(makeBars(1_000_000, 5))));
  // flush 前收到 reset（真機首屏 series_loading 與 tsu 交錯）。
  h.ws.dispatch(frame(seriesLoading()));

  h.sandbox.__JEV_FORCE_EMIT();

  const em = h.last();
  assert.equal(em.type, 'SNAPSHOT_UPSERT');
  assert.equal(em.reset, true, 'reset 後第一次 flush 必須 reset:true');
  assert.equal(
    em.bars.length,
    5,
    'bars 數 == flush 當下 buffer 內 bar 數（不得被 reset 清掉）',
  );
});

test('§4.7.2 full:true 清游標並立即全量 flush；非 full 維持增量', () => {
  const h = setup();

  // 首批 3 根，全量。
  h.ws.dispatch(frame(tsu(makeBars(1_000_000, 3))));
  h.sandbox.__JEV_FORCE_EMIT();
  let em = h.last();
  assert.equal(em.reset, false);
  assert.equal(em.bars.length, 3);

  // 尾根增量：只送 1 根。
  h.ws.dispatch(frame(tsu(makeBars(1_000_180, 1))));
  h.sandbox.__JEV_FORCE_EMIT();
  em = h.last();
  assert.equal(em.reset, false);
  assert.equal(em.bars.length, 1);

  // full:true → 清空游標並全量（此時 buffer 共 4 根）。
  h.fireMessage({ v: 1, type: 'JEV_PING', full: true });
  em = h.last();
  assert.equal(em.reset, true);
  assert.equal(em.bars.length, 4);

  // 不帶 full 的 JEV_PING：維持增量（只送新增那根）。
  h.ws.dispatch(frame(tsu(makeBars(1_000_240, 1))));
  h.fireMessage({ v: 1, type: 'JEV_PING' });
  em = h.last();
  assert.equal(em.reset, false);
  assert.equal(em.bars.length, 1);
});

test('09d-1 resolution 每次 flush 重讀 URL；URL 改變跟著變、讀不到沿用上一次', () => {
  const h = setup();

  // URL: interval=5 → flush 當下讀到 5
  h.sandbox.location.search = '?interval=5';
  h.ws.dispatch(frame(tsu(makeBars(1_000_000, 1))));
  h.sandbox.__JEV_FORCE_EMIT();
  assert.equal(h.last().meta.resolution, '5');

  // SPA 改寫 URL 為 interval=15 → 下一次 flush 跟著變（不得停在舊值）
  h.sandbox.location.search = '?interval=15';
  h.ws.dispatch(frame(tsu(makeBars(1_000_060, 1))));
  h.sandbox.__JEV_FORCE_EMIT();
  assert.equal(h.last().meta.resolution, '15');

  // 無 search / 讀不到 interval → 沿用上一次（15），不得變 undefined/null/'1'
  h.sandbox.location.search = '';
  h.ws.dispatch(frame(tsu(makeBars(1_000_120, 1))));
  h.sandbox.__JEV_FORCE_EMIT();
  const em = h.last();
  assert.equal(em.meta.resolution, '15');
  assert.equal(typeof em.meta.resolution, 'string');
  assert.ok(em.meta.resolution.length > 0);
});

test('§4.2.1 主圖 symbol 變更才清緩衝（sds_sym_1）；相同 symbol 不清', () => {
  const h = setup();

  // 幣種 A：3 根並已送出。
  h.ws.dispatch(frame(symbolResolved('BINANCE:AAAUSDT')));
  h.ws.dispatch(frame(tsu(makeBars(1_000_000, 3))));
  h.sandbox.__JEV_FORCE_EMIT();
  let em = h.last();
  assert.equal(em.meta.symbol, 'BINANCE:AAAUSDT');
  assert.equal(em.bars.length, 3);
  assert.equal(em.meta.total, 3);

  // 相同 symbol：不得清緩衝 → 舊 bar 仍在，只增量送新尾根。
  h.ws.dispatch(frame(symbolResolved('BINANCE:AAAUSDT')));
  h.ws.dispatch(frame(tsu(makeBars(1_000_180, 1))));
  h.sandbox.__JEV_FORCE_EMIT();
  em = h.last();
  assert.equal(em.bars.length, 1, '僅增量');
  assert.equal(em.meta.total, 4, '相同 symbol 不得清緩衝');

  // 換幣種（身分變更）：完整重置，第一次 flush 只含新幣種。
  h.ws.dispatch(frame(symbolResolved('BINANCE:BBBUSDT')));
  h.ws.dispatch(frame(tsu(makeBars(2_000_000, 2))));
  h.sandbox.__JEV_FORCE_EMIT();
  em = h.last();
  assert.equal(em.reset, true, '主圖 symbol 變更後第一次 flush 必須 reset:true');
  assert.equal(em.meta.symbol, 'BINANCE:BBBUSDT');
  assert.equal(em.bars.length, 2);
  assert.equal(em.meta.total, 2, '舊幣種 bar 不得殘留');
  assert.ok(
    em.bars.every((b) => b[0] >= 2_000_000),
    '不得含舊幣種時間戳的 bar',
  );
});

test('§4.2.1 多 series 隔離（真機 fixture）：主圖 = 300 根、symbol=SOLUSDT、sds_2 的 366 根不入缓衝', () => {
  const raw = readFileSync('tests/fixtures/ws-multiseries-real.txt', 'utf8');
  const h = setup();
  h.ws.dispatch(raw); // parseFrames 拆出全部真實帧；inject 逐帧消費
  h.sandbox.__JEV_FORCE_EMIT();

  const em = h.last();
  assert.equal(em.type, 'SNAPSHOT_UPSERT');
  assert.equal(em.meta.symbol, 'BINANCE:SOLUSDT');
  assert.notEqual(em.meta.symbol, 'INTERNAL:SEASONALS');
  assert.equal(em.meta.total, 300, '主圖缓衝恰為 300（不得含 sds_2 的 366）');
  assert.equal(em.bars.length, 300);
  assert.ok(em.bars.every((b) => Array.isArray(b) && b.length === 6));
});

test('§4.2.1 輔助序列 sds_2 的 reset / symbol / bars 完全不得影響主圖', () => {
  const h = setup();

  // 主圖先建立 300 根並送出。
  h.ws.dispatch(frame(tsu(makeBars(1_000_000, 300))));
  h.sandbox.__JEV_FORCE_EMIT();
  assert.equal(h.last().meta.total, 300);
  assert.equal(h.last().meta.symbol, null);

  // 輔助序列：reset + symbol(INTERNAL:SEASONALS) + 366 根 bar。
  h.ws.dispatch(frame(seriesLoading('sds_2')));
  h.ws.dispatch(frame(symbolResolved('INTERNAL:SEASONALS', 'sds_sym_2')));
  h.ws.dispatch(frame(tsu(makeBars(2_000_000, 366), 'sds_2')));
  h.sandbox.__JEV_FORCE_EMIT();

  const em = h.last();
  assert.equal(em.reset, false, 'sds_2 reset 不得觸發主圖 reset');
  assert.equal(em.meta.total, 300, '主圖缓衝不得被 sds_2 影響');
  assert.equal(em.meta.symbol, null, 'sds_sym_2 不得更新 meta.symbol');
  assert.equal(em.bars.length, 0, 'sds_2 的 366 根不得上送');
});

test('09g 站內換商品（真機 fixture）：meta.symbol=ETHUSDT、缓衝只含新商品、INTERNAL 不改符號不清缓衝', () => {
  const raw = readFileSync('tests/fixtures/ws-symbol-switch-real.txt', 'utf8');
  const h = setup();
  h.ws.dispatch(raw);
  h.sandbox.__JEV_FORCE_EMIT();

  const em = h.last();
  // (a) 符號更新為新商品（身分 sds_sym_3 可變；內容才是判準）
  assert.equal(em.meta.symbol, 'BINANCE:ETHUSDT');
  assert.notEqual(em.meta.symbol, 'BINANCE:BTCUSDT');
  // (b) fixture 含 INTERNAL:SEASONALS 的 symbol_resolved：不得改 symbol、不得清缓衝
  assert.notEqual(em.meta.symbol, 'INTERNAL:SEASONALS');
  // (c)(d) 主圖缓衝 = 新商品 300 根；舊商品與 sds_3 的 366 根皆不在
  assert.equal(em.meta.total, 300);
  assert.equal(em.bars.length, 300);
  assert.ok(
    em.bars.every((b) => b[0] >= 1789762500 && b[0] <= 1790031600),
    '只含新商品時間範圍的 bar（排除舊商品與 sds_3）',
  );
});

test('09g 舊商品 bar 必須清掉：先餵 300 根 BTCUSDT，再餵換商品序列', () => {
  const raw = readFileSync('tests/fixtures/ws-symbol-switch-real.txt', 'utf8');
  const h = setup();

  // 舊商品：BTCUSDT 300 根（時間 100_000_000 起，與 fixture 完全不重疊）。
  h.ws.dispatch(frame(symbolResolved('BINANCE:BTCUSDT')));
  h.ws.dispatch(frame(tsu(makeBars(100_000_000, 300))));
  h.sandbox.__JEV_FORCE_EMIT();
  let em = h.last();
  assert.equal(em.meta.symbol, 'BINANCE:BTCUSDT');
  assert.equal(em.meta.total, 300);

  // 換商品序列。
  h.ws.dispatch(raw);
  h.sandbox.__JEV_FORCE_EMIT();
  em = h.last();
  assert.equal(em.meta.symbol, 'BINANCE:ETHUSDT');
  assert.equal(em.meta.total, 300, '舊 300 根已清，只留新商品 300 根');
  assert.equal(em.bars.length, 300);
  assert.ok(
    em.bars.every((b) => b[0] >= 1789762500),
    '不得殘留舊商品（100_000_000 級）的 time',
  );
});

test('09g INTERNAL:* 的 symbol_resolved 不得改 symbol、不得清缓衝', () => {
  const h = setup();
  h.ws.dispatch(frame(symbolResolved('BINANCE:AAAUSDT')));
  h.ws.dispatch(frame(tsu(makeBars(1_000_000, 5))));
  h.sandbox.__JEV_FORCE_EMIT();
  assert.equal(h.last().meta.total, 5);

  // 輔助序列的 symbol_resolved（身分 sds_sym_2 / INTERNAL:SEASONALS）。
  h.ws.dispatch(frame(symbolResolved('INTERNAL:SEASONALS', 'sds_sym_2')));
  h.sandbox.__JEV_FORCE_EMIT();
  const em = h.last();
  assert.equal(em.meta.symbol, 'BINANCE:AAAUSDT', 'INTERNAL 不得改 symbol');
  assert.equal(em.meta.total, 5, 'INTERNAL 不得清缓衝');
  assert.equal(em.reset, false);
});

// ─────────────────────────────────────────────────────────────
// Task 10 §4.8.1：SNAPSHOT_UPSERT 捎帶旁聽計數
// ─────────────────────────────────────────────────────────────

test('§4.8.1 upsert 攜帶 counters：非主圖 series 幀遞增 ignoredSeriesFrames、解析不了的壞幀遞增 dropped', () => {
  const h = setup();

  // 首則（主圖 3 根正常資料）：counters 應為 {0,0}。
  h.ws.dispatch(frame(tsu(makeBars(1_000_000, 3))));
  h.sandbox.__JEV_FORCE_EMIT();
  let em = h.last();
  // 註：em 來自 vm 沙箱（跨 realm），故逐欄斷言而非 deepStrictEqual。
  assert.equal(em.counters.dropped, 0);
  assert.equal(em.counters.ignoredSeriesFrames, 0);

  // 三種非主圖 series 幀：sds_2 reset、sds_2 bars、INTERNAL symbol → 各 +1。
  h.ws.dispatch(frame(seriesLoading('sds_2')));
  h.ws.dispatch(frame(tsu(makeBars(2_000_000, 5), 'sds_2')));
  h.ws.dispatch(frame(symbolResolved('INTERNAL:SEASONALS', 'sds_sym_2')));
  h.sandbox.__JEV_FORCE_EMIT();
  em = h.last();
  assert.equal(em.counters.ignoredSeriesFrames, 3, '非主圖幀各計一次');
  assert.equal(em.counters.dropped, 0, '非主圖幀不得計入 dropped');

  // 解析不了的幀（classify → null）與欄位不足的 bar → dropped 各 +1。
  h.ws.dispatch(frame({ m: 'qsd', p: [1, 2, 3] }));
  h.ws.dispatch(
    frame({
      m: 'timescale_update',
      p: ['cs_TEST', { sds_1: { s: [{ i: 0, v: [1, 2, 3] }] } }],
    }),
  );
  h.sandbox.__JEV_FORCE_EMIT();
  em = h.last();
  assert.equal(em.counters.dropped, 2, 'qsd 幀＋欄位不足 bar 各計一次');
  assert.equal(em.counters.ignoredSeriesFrames, 3, 'ignored 不得因 dropped 改變');
  assert.equal(em.meta.dropped, em.counters.dropped, '與既有 meta.dropped 同步');
});

test('§4.8.1 counters 為累計值且既有 payload 欄位形狀不變', () => {
  const h = setup();
  h.ws.dispatch(frame(tsu(makeBars(1_000_000, 3))));
  h.sandbox.__JEV_FORCE_EMIT();

  // 壞幀 +1 dropped，再加一根主圖尾根增量。
  h.ws.dispatch(frame({ m: 'qsd', p: [] }));
  h.ws.dispatch(frame(tsu(makeBars(1_000_180, 1))));
  h.sandbox.__JEV_FORCE_EMIT();
  const em = h.last();

  // counters 為累計值（第二則仍帶著第一則的狀態，非重置）。
  assert.equal(em.counters.dropped, 1);
  assert.equal(em.counters.ignoredSeriesFrames, 0);

  // 既有欄位形狀不變：counters 只是新增欄位。
  assert.equal(em.v, 1);
  assert.equal(em.type, 'SNAPSHOT_UPSERT');
  assert.equal(typeof em.reset, 'boolean');
  assert.ok(Array.isArray(em.bars));
  assert.ok(em.bars.every((b) => Array.isArray(b) && b.length === 6));
  assert.deepEqual(Object.keys(em.meta).sort(), [
    'dropped',
    'resolution',
    'symbol',
    'total',
    'ts',
  ]);
  assert.equal(typeof em.meta.total, 'number');
  assert.equal(typeof em.meta.dropped, 'number');
  assert.equal(typeof em.meta.ts, 'number');
});

// ─────────────────────────────────────────────────────────────
// Task 13／§4.2.2：send 只讀包裝 ＋ study 消費
// ─────────────────────────────────────────────────────────────

/** vm 跨 realm 物件 → 外層 plain object（deepEqual 前先正規化）。 */
const plain = (x) => JSON.parse(JSON.stringify(x));

/** create_study 上行幀（含加密 text blob，必須被 redact 掉）。 */
function createStudyFrame(id, extraOptions) {
  return {
    m: 'create_study',
    p: [
      'cs_TEST',
      id,
      'st1',
      'sds_1',
      'Script@tv-scripting-101!',
      {
        text: 'TOP-SECRET-BLOB',
        pineId: 'STD;Arnaud%1Legoux%1Moving%1Average',
        pineVersion: '29.0',
        pineFeatures: { v: '{}', f: true, t: 'text' },
        in_0: { v: 25, f: true, t: 'integer' },
        in_1: { v: 0.85, f: true, t: 'float' },
        __fast_calc: { v: false, f: true, t: 'bool' },
        __profile: { v: false, f: true, t: 'bool' },
        ...(extraOptions || {}),
      },
    ],
  };
}

/** du 下行幀：以 `st:[{i,v}]` 推送 study 逐根值（i 用負 sentinel 不影響）。 */
function duStudyFrame(id, rows) {
  return {
    m: 'du',
    p: [
      'cs_TEST',
      {
        [id]: {
          st: rows.map(([time, val]) => ({ i: -1000100, v: [time, val] })),
          ns: { d: '{"graphics":"must-not-leak"}' },
          t: 's1_st1',
        },
      },
    ],
  };
}

test('Task13 send 只讀包裝：同參數呼叫原生、同返回、例外一致（不改行為）', () => {
  const h = setup();

  h.ws.sendReturn = 'NATIVE-RET';
  const r = h.ws.send('a', { b: 1 });
  assert.equal(r, 'NATIVE-RET', '返回值原樣透傳');
  assert.deepEqual(h.ws.sentArgs, [['a', { b: 1 }]], '參數未經改動');

  const boom = new Error('native send exploded');
  h.ws.throwOnSend = boom;
  assert.throws(() => h.ws.send('c'), /native send exploded/, '原生例外一致往外拋');
  assert.deepEqual(h.ws.sentArgs[1], ['c'], '例外前仍原樣呼叫了原生 send');
});

test('Task13 create_study(send)＋du study(recv) → STUDIES_UPSERT（text redact、尾根覆寫）', () => {
  const h = setup();

  h.ws.send(frame(createStudyFrame('51IoAU')));
  // 負 sentinel i 的歷史批＋尾根覆寫，ns graphics 不得混入。
  h.ws.dispatch(
    frame({
      m: 'du',
      p: [
        'cs_TEST',
        {
          '51IoAU': {
            st: [
              { i: -1000100, v: [1000, 1] },
              { i: 299, v: [1000, 2] },
              { i: 300, v: [1060, 3] },
            ],
            ns: { d: '{"graphics":"must-not-leak"}' },
            t: 's1_st1',
          },
        },
      ],
    }),
  );
  h.sandbox.__JEV_FORCE_EMIT();

  const su = plain(h.lastOf('STUDIES_UPSERT'));
  assert.ok(su, '應發出 STUDIES_UPSERT');
  assert.equal(su.v, 1);
  assert.equal(su.type, 'STUDIES_UPSERT');
  assert.equal(su.meta['51IoAU'].pineId, 'STD;Arnaud%1Legoux%1Moving%1Average');
  assert.deepEqual(su.meta['51IoAU'].params, { in_0: 25, in_1: 0.85 });
  assert.equal('text' in su.meta['51IoAU'], false);
  assert.equal('pineFeatures' in su.meta['51IoAU'], false);
  assert.equal('__fast_calc' in su.meta['51IoAU'], false);
  assert.equal(JSON.stringify(su).includes('TOP-SECRET-BLOB'), false, 'text 不得外流');
  assert.equal(JSON.stringify(su).includes('must-not-leak'), false, 'ns 圖形指令不得外流');
  assert.deepEqual(su.patches['51IoAU'], [[1000, 2], [1060, 3]], '負 i 忽略、同 time 尾根覆寫');
});

test('Task13 STUDIES_UPSERT 只送增量：同值不重送、meta 只送一次、變更才送', () => {
  const h = setup();
  h.ws.send(frame(createStudyFrame('sid')));
  h.ws.dispatch(frame(duStudyFrame('sid', [[1000, 1]])));
  h.sandbox.__JEV_FORCE_EMIT();

  const first = h.lastOf('STUDIES_UPSERT');
  assert.ok(first);
  assert.deepEqual(plain(first).patches, { sid: [[1000, 1]] });
  assert.ok(first.meta.sid, '首次帶 meta');

  // 同值再來 → 無變更 → 不再發 STUDIES_UPSERT。
  h.ws.dispatch(frame(duStudyFrame('sid', [[1000, 1]])));
  h.sandbox.__JEV_FORCE_EMIT();
  assert.equal(h.lastOf('STUDIES_UPSERT'), first, '無變更不得重送');

  // 值變更 → 只送增量，meta 已送不再重複。
  h.ws.dispatch(frame(duStudyFrame('sid', [[1000, 2]])));
  h.sandbox.__JEV_FORCE_EMIT();
  const second = h.lastOf('STUDIES_UPSERT');
  assert.notEqual(second, first);
  assert.deepEqual(plain(second).patches, { sid: [[1000, 2]] });
  assert.deepEqual(plain(second).meta, {}, 'meta 只送一次');
});

test('Task13 full:true 觸發 study meta+patches 全量重送（SW 重啟可重建）', () => {
  const h = setup();
  h.ws.send(frame(createStudyFrame('sid')));
  h.ws.dispatch(frame(duStudyFrame('sid', [[1000, 1], [1060, 2]])));
  h.sandbox.__JEV_FORCE_EMIT();
  assert.ok(h.lastOf('STUDIES_UPSERT'));

  h.fireMessage({ v: 1, type: 'JEV_PING', full: true });
  const su = plain(h.lastOf('STUDIES_UPSERT'));
  assert.ok(su.meta.sid, 'full:true 需重送 meta');
  assert.deepEqual(su.patches.sid, [[1000, 1], [1060, 2]], 'full:true 需全量重送');
});

test('Task13 主圖 symbol 完整重置清 study 序列（同值會重送），meta 不重送', () => {
  const h = setup();
  h.ws.send(frame(createStudyFrame('sid')));
  h.ws.dispatch(frame(symbolResolved('BINANCE:AAAUSDT')));
  h.ws.dispatch(frame(duStudyFrame('sid', [[1000, 1]])));
  h.sandbox.__JEV_FORCE_EMIT();
  assert.deepEqual(plain(h.lastOf('STUDIES_UPSERT')).patches, { sid: [[1000, 1]] });

  // 站內換商品（真實 symbol 變更）→ 序列清；同值重現需重新送出。
  h.ws.dispatch(frame(symbolResolved('BINANCE:BBBUSDT')));
  h.ws.dispatch(frame(duStudyFrame('sid', [[1000, 1]])));
  h.sandbox.__JEV_FORCE_EMIT();
  const su = plain(h.lastOf('STUDIES_UPSERT'));
  assert.deepEqual(su.patches, { sid: [[1000, 1]] }, '序列已清 → 同值重送');
  assert.deepEqual(su.meta, {}, '身分保留、無需重送 meta');

  // 換商品後 bars 快照必須 reset:true（既有契約不得回歸）。
  assert.equal(h.last().reset, true);
});

test('Task13 已被消費的 study du 不計入 dropped（counters 語意一致）', () => {
  const h = setup();
  h.ws.send(frame(createStudyFrame('sid')));
  h.ws.dispatch(frame(duStudyFrame('sid', [[1000, 1]])));
  h.sandbox.__JEV_FORCE_EMIT();
  const em = h.last();
  assert.equal(em.counters.dropped, 0, 'study du 已消費不得算 dropped');
  assert.equal(em.counters.ignoredSeriesFrames, 0);
});

test('Task13 st 恆空的 study（如 BarSet）自動排除；非 TV ws 的 send 不記錄', () => {
  const h = setup();
  // create_study 有身分，但 du 的 st 為空 → 不得出現在 STUDIES_UPSERT。
  h.ws.send(frame(createStudyFrame('yl9zbk')));
  h.ws.dispatch(
    frame({ m: 'du', p: ['cs_TEST', { yl9zbk: { st: [], t: 's1_st1' } }] }),
  );
  h.sandbox.__JEV_FORCE_EMIT();
  assert.equal(h.lastOf('STUDIES_UPSERT'), undefined, 'st 恆空 → 無 study 訊息');

  // 非 TV 連線：send 不應觸發任何 study 記錄。
  const other = new h.sandbox.WebSocket('wss://example.com/ws');
  other.send(frame(createStudyFrame('evil')));
  h.sandbox.__JEV_FORCE_EMIT();
  assert.equal(h.lastOf('STUDIES_UPSERT'), undefined, '非 TV ws 不被消費');
});
