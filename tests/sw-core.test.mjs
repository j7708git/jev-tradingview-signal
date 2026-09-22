// tests/sw-core.test.mjs — SW 編排核心（lib/sw-core.js）的單元測試。
// 全程 fake runtime/tabs/storage + 注入的 fake evaluate，零 chrome.*、零真等待。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../extension/lib/sw-core.js';
import { ChartBuffer } from '../extension/lib/chart-buffer.js';
import { buildState, QUESTIONS, estimateTokens } from '../extension/lib/state-builder.js';
import { JevError } from '../extension/lib/jev-client.js';

const KEY = 'SECRET-KEY-777';
const TV_URL = 'https://www.tradingview.com/chart/AbCdEf/?symbol=BINANCE%3ABTCUSDT&interval=1';

/** 一根 6 欄 bar。 */
function bar(t, close) {
  return [t, close, close + 1, close - 1, close + 0.5, 100 + (t % 7)];
}
/** n 根、time 間隔 60 秒。 */
function bars(from, n) {
  return Array.from({ length: n }, (_, i) => bar(from + i * 60, 100 + i));
}

/** 假 harness：記錄廣播與 tab 訊息，可注入 evaluate/URL/waitMs。 */
function makeHarness(overrides = {}) {
  const broadcasts = [];
  const tabMessages = [];
  const evaluateCalls = [];
  const store = {
    jevApiKey: KEY,
    jevModel: 'jev-latest',
    bars: 300,
    featuresOn: true,
    ...(overrides.store || {}),
  };
  const tabUrls = overrides.tabUrls || {};
  const evaluateImpl =
    overrides.evaluate ||
    (async () => ({
      model: 'jev-latest',
      answers: { direction: { choice: 'long' } },
      usage: { input_tokens: 1234, output_tokens: 5 },
    }));

  const deps = {
    runtime: {
      sendMessage: (msg) => {
        broadcasts.push(msg);
        return Promise.resolve();
      },
    },
    tabs: {
      sendMessage: (tabId, msg) => {
        tabMessages.push({ tabId, msg });
        if (overrides.onTabMessage) overrides.onTabMessage(tabId, msg);
        return Promise.resolve();
      },
      get: async (tabId) => ({ url: tabUrls[tabId] }),
      query: async () => [{ id: 1 }],
    },
    storage: {
      local: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) if (k in store) out[k] = store[k];
            return out;
          }
          return { ...store };
        },
      },
      // §4.7.3：可用 overrides.session（跨 db 實例共用同一物件＝模擬 SW 重啟）。
      ...(overrides.session ? { session: overrides.session } : {}),
    },
    ChartBuffer,
    buildState,
    QUESTIONS,
    estimateTokens,
    waitMs: overrides.waitMs != null ? overrides.waitMs : 5,
    evaluate: async (args) => {
      evaluateCalls.push(args);
      return evaluateImpl(args);
    },
  };
  return { deps, broadcasts, tabMessages, evaluateCalls, store };
}

function tvSender(id, url = TV_URL) {
  return { url, tab: { id, url } };
}
function panelSender() {
  return {};
}
function upsert(bs, meta, reset) {
  return { v: 1, type: 'SNAPSHOT_UPSERT', bars: bs, meta, ...(reset ? { reset: true } : {}) };
}
function run(tabId) {
  return { v: 1, type: 'RUN_PREDICTION', tabId };
}

// ─────────────────────────────────────────────────────────────
// 1) 多 tab registry
// ─────────────────────────────────────────────────────────────
test('多 tab registry：A/B 各自 upsert，buffer 與 meta 互不污染', () => {
  const db = createDb(makeHarness().deps);
  const a = bars(1_000_000, 20);
  const b = bars(2_000_000, 7);
  db.handleRuntimeMessage(upsert(a, { symbol: 'AAA', resolution: '1' }), tvSender(1));
  db.handleRuntimeMessage(upsert(b, { symbol: 'BBB', resolution: '5' }), tvSender(2));

  const ea = db.entryFor(1);
  const eb = db.entryFor(2);
  assert.equal(ea.buffer.count, 20);
  assert.equal(eb.buffer.count, 7);
  assert.deepEqual(ea.buffer.snapshot(300).map((x) => x[0]), a.map((x) => x[0]));
  assert.deepEqual(eb.buffer.snapshot(300).map((x) => x[0]), b.map((x) => x[0]));
  assert.equal(ea.meta.symbol, 'AAA');
  assert.equal(eb.meta.symbol, 'BBB');
  assert.equal(ea.meta.resolution, '1');
  assert.equal(eb.meta.resolution, '5');
});

// ─────────────────────────────────────────────────────────────
// 2) reset:true 先清再收
// ─────────────────────────────────────────────────────────────
test('reset:true 先清再收；舊 bars 不在 buffer', () => {
  const db = createDb(makeHarness().deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 20), { symbol: 'X', resolution: '1' }),
    tvSender(1),
  );
  const fresh = bars(2_000_000, 3);
  db.handleRuntimeMessage(
    upsert(fresh, { symbol: 'X', resolution: '1' }, true),
    tvSender(1),
  );
  const snap = db.entryFor(1).buffer.snapshot(300);
  assert.deepEqual(snap.map((x) => x[0]), fresh.map((x) => x[0]));
  assert.ok(!snap.some((x) => x[0] < 2_000_000));
});

// ─────────────────────────────────────────────────────────────
// 3) RUN_PREDICTION happy path
// ─────────────────────────────────────────────────────────────
test('RUN_PREDICTION happy：state/questions 結構、cost、broadcast 順序 loading→done', async () => {
  const h = makeHarness();
  const db = createDb(h.deps);
  const all = bars(1_000_000, 350);
  db.handleRuntimeMessage(
    upsert(all, { symbol: 'BINANCE:BTCUSDT', resolution: '1' }),
    tvSender(1),
  );

  const res = await db.handleRuntimeMessage(run(1), panelSender());
  assert.equal(res.ok, true);

  const arg = h.evaluateCalls[0];
  assert.equal(arg.apiKey, KEY);
  assert.equal(arg.model, 'jev-latest');
  assert.equal(arg.questions, QUESTIONS);
  assert.equal(arg.state.symbol, 'BINANCE:BTCUSDT');
  assert.equal(arg.state.resolution, '1');
  assert.equal(arg.state.bars.length, 300);
  assert.equal(arg.state.bars[0][0], all[50][0]);
  assert.equal(arg.state.bars[299][0], all[349][0]);

  const entry = db.entryFor(1);
  assert.equal(entry.last.status, 'done');
  assert.deepEqual(entry.last.answers, { direction: { choice: 'long' } });
  // §4.8.2：成本單價來自 protocol.js 單一來源。
  assert.equal(entry.last.cost, (1234 * globalThis.COST_USD_PER_MTOK) / 1e6);
  assert.ok(typeof entry.last.ms === 'number');
  assert.ok(entry.last.state.bars.length === 300);

  const updates = h.broadcasts.filter((m) => m.type === 'PREDICTION_UPDATED');
  assert.deepEqual(updates.map((m) => m.state), ['loading', 'done']);
  assert.ok(updates.every((m) => m.v === 1 && m.tabId === 1));

  // GET_STATE 反映完成狀態
  const summary = db.handleRuntimeMessage(
    { v: 1, type: 'GET_STATE', tabId: 1 },
    panelSender(),
  );
  assert.equal(summary.status, 'done');
  assert.equal(summary.count, 350);
  assert.equal(summary.symbol, 'BINANCE:BTCUSDT');
  assert.equal(summary.last.status, 'done');
});

// ─────────────────────────────────────────────────────────────
// 4) 緩衝不足 → REQ_SNAPSHOT 補傳；逾時不致命
// ─────────────────────────────────────────────────────────────
test('緩衝不足 → 發 REQ_SNAPSHOT，補傳 upsert 後 state 含補進來的根', async () => {
  let db;
  const h = makeHarness({
    onTabMessage: (tabId, msg) => {
      if (msg.type === 'REQ_SNAPSHOT') {
        setTimeout(() => {
          db.handleRuntimeMessage(
            upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
            tvSender(tabId),
          );
        }, 1);
      }
    },
  });
  db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 4), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );

  const p = db.handleRuntimeMessage(run(1), panelSender());
  const reqs = h.tabMessages.filter((m) => m.msg.type === 'REQ_SNAPSHOT');
  // (a) 首觸此 tab 一則 + (b) 根數不足一則；兩者都要求 full:true。
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].tabId, 1);
  assert.equal(reqs[0].msg.v, 1);
  assert.equal(reqs[0].msg.full, true);
  assert.equal(reqs[1].tabId, 1);
  assert.equal(reqs[1].msg.full, true);
  assert.equal(db.pendingForTest(1), true);

  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(db.pendingForTest(1), false);
  assert.equal(h.evaluateCalls[0].state.bars.length, 60);
  assert.equal(h.evaluateCalls[0].state.bars[59][0], 1_000_000 + 59 * 60);
});

test('補傳逾時（waitMs=5）不致命：資料仍不足 → insufficient_data，不呼叫 API', async () => {
  const h = makeHarness({ waitMs: 5 });
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 5), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );
  const res = await db.handleRuntimeMessage(run(1), panelSender());
  assert.equal(res.ok, false);
  assert.equal(res.error.kind, 'insufficient_data');
  assert.match(res.error.message, /5 根/);
  assert.equal(h.evaluateCalls.length, 0, '資料不足不得呼叫 evaluate');
  assert.equal(db.pendingForTest(1), false);
  assert.equal(db.entryFor(1).last.kind, 'insufficient_data');
});

// ─────────────────────────────────────────────────────────────
// 5) 錯誤正規化＋redact
// ─────────────────────────────────────────────────────────────
test('evaluate 拋 JevError → last error/auth_401、broadcast error、序列化無 key', async () => {
  const h = makeHarness({
    evaluate: async () => {
      throw new JevError('auth_401', `bad key ${KEY}`);
    },
  });
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );
  const res = await db.handleRuntimeMessage(run(1), panelSender());
  assert.equal(res.ok, false);
  assert.equal(res.error, 'auth_401');

  const last = db.entryFor(1).last;
  assert.equal(last.status, 'error');
  assert.equal(last.kind, 'auth_401');
  assert.equal(last.message.includes(KEY), false);
  assert.ok(last.message.includes('[redacted]'));
  assert.equal(JSON.stringify(last).includes(KEY), false);

  const updates = h.broadcasts.filter((m) => m.type === 'PREDICTION_UPDATED');
  assert.deepEqual(updates.map((m) => m.state), ['loading', 'error']);
});

test('非 JevError 的一般 throw → status error / kind error，流程不崩', async () => {
  const h = makeHarness({
    evaluate: async () => {
      throw new Error('boom');
    },
  });
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );
  const res = await db.handleRuntimeMessage(run(1), panelSender());
  assert.equal(res.ok, false);
  assert.equal(res.error, 'error');
  assert.equal(db.entryFor(1).last.kind, 'error');
});

// ─────────────────────────────────────────────────────────────
// 6) 併發鎖、idle 形、非 TV 忽略、onTabClosed
// ─────────────────────────────────────────────────────────────
test('併發鎖：進行中第二次 RUN_PREDICTION 回 {ok:false,error:"busy"}', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const h = makeHarness({ evaluate: async () => gate });
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );

  const p1 = db.handleRuntimeMessage(run(1), panelSender());
  const busy = db.handleRuntimeMessage(run(1), panelSender());
  assert.deepEqual(busy, { ok: false, error: 'busy' });

  release({ model: 'x', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal((await p1).ok, true);

  const r2 = await db.handleRuntimeMessage(run(1), panelSender());
  assert.equal(r2.ok, true);
});

test('GET_STATE 無 entry → {status:"idle",count:0,counters:{0,0}}', () => {
  const db = createDb(makeHarness().deps);
  assert.deepEqual(
    db.handleRuntimeMessage({ v: 1, type: 'GET_STATE', tabId: 999 }, panelSender()),
    { status: 'idle', count: 0, counters: { dropped: 0, ignoredSeriesFrames: 0 }, studiesCount: 0 },
  );
  assert.deepEqual(
    db.handleRuntimeMessage({ v: 1, type: 'GET_STATE' }, panelSender()),
    { status: 'idle', count: 0, counters: { dropped: 0, ignoredSeriesFrames: 0 }, studiesCount: 0 },
  );
});

test('非 TV 的 SNAPSHOT_UPSERT 被忽略；onTabClosed 清除 entry', () => {
  const db = createDb(makeHarness().deps);
  const evil = {
    url: 'https://example.com/chart/x',
    tab: { id: 7, url: 'https://example.com/chart/x' },
  };
  db.handleRuntimeMessage(upsert(bars(1_000_000, 9), { symbol: 'Z' }), evil);
  assert.equal(db.entryFor(7), undefined);

  db.handleRuntimeMessage(upsert(bars(1_000_000, 9), { symbol: 'Z' }), tvSender(8));
  assert.ok(db.entryFor(8));
  db.onTabClosed(8);
  assert.equal(db.entryFor(8), undefined);
});

// ─────────────────────────────────────────────────────────────
// 7) panel 來源與偽造 sender
// ─────────────────────────────────────────────────────────────
test('panel 來源可用顯式 tabId 預測；偽造 sender.url 的注入改不動 registry', async () => {
  const h = makeHarness();
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(3),
  );

  const res = await db.handleRuntimeMessage({ v: 1, type: 'RUN_PREDICTION', tabId: 3 }, {});
  assert.equal(res.ok, true);
  assert.equal(h.evaluateCalls[0].state.symbol, 'S');

  const before = db.entryFor(3).buffer.count;
  db.handleRuntimeMessage(upsert(bars(9_000_000, 30), { symbol: 'EVIL' }), {
    url: 'https://evil.test/chart',
    tab: { id: 3, url: 'https://evil.test/chart' },
  });
  assert.equal(db.entryFor(3).buffer.count, before);
  assert.equal(db.entryFor(3).meta.symbol, 'S');
});

// Task 09 真機缺陷的回歸契約：side panel 以「分頁」開啟時 sender.tab 有值、
// sender.url 為 chrome-extension://.../sidepanel/。SW 這一層必須先把這種 sender
// 正規化成 { ...sender, tab: undefined } 再交給 sw-core（sw-core 只認 tab===undefined）。
test('面板 sender 正規化契約：擴充頁 sender 需 tab:undefined 才走 panel 分支', async () => {
  const h = makeHarness();
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(3),
  );

  const panelAsTab = {
    tab: { id: 99 },
    url: 'chrome-extension://abcdefghijklmnop/sidepanel/sidepanel.html',
  };
  // 未經 SW 正規化時，sw-core 依 sender.tab 判為 content script → GET_STATE 被拒。
  assert.equal(
    db.handleRuntimeMessage({ v: 1, type: 'GET_STATE', tabId: 3 }, panelAsTab),
    false,
  );

  // SW 的 fromPanel 正規化後（tab: undefined）→ panel 分支，命令成功。
  // （SW 會同時以 lastActiveTabId 補 tabId；此處以顯式 tabId 模擬。）
  const normalized = { ...panelAsTab, tab: undefined };
  const summary = db.handleRuntimeMessage(
    { v: 1, type: 'GET_STATE', tabId: 3 },
    normalized,
  );
  assert.equal(summary.count, 60);
  assert.equal(summary.symbol, 'S');

  const res = await db.handleRuntimeMessage(
    { v: 1, type: 'RUN_PREDICTION', tabId: 3 },
    normalized,
  );
  assert.equal(res.ok, true);
  assert.equal(h.evaluateCalls[0].state.symbol, 'S');
});

// content script（sender.url = tradingview）絕不可被誤判為 panel：
test('content script（sender.url=tradingview）不被誤判：SNAPSHOT_UPSERT 走 content 分支、panel 命令被拒', () => {
  const h = makeHarness();
  const db = createDb(h.deps);
  const tv = tvSender(5);

  // SNAPSHOT_UPSERT 走 content 分支：回 false（本地處理完、無 sendResponse），registry 更新。
  assert.equal(
    db.handleRuntimeMessage(
      upsert(bars(1_000_000, 8), { symbol: 'TV', resolution: '1' }),
      tv,
    ),
    false,
  );
  assert.equal(db.entryFor(5).buffer.count, 8);
  assert.equal(db.entryFor(5).meta.symbol, 'TV');

  // 同一 sender 的 panel 命令被拒（未被誤判）。
  assert.equal(db.handleRuntimeMessage({ v: 1, type: 'GET_STATE' }, tv), false);
  assert.equal(
    db.handleRuntimeMessage({ v: 1, type: 'RUN_PREDICTION', tabId: 5 }, tv),
    false,
  );
});

// ─────────────────────────────────────────────────────────────
// 補充：型別白名單、resolution 兜底、active tab
// ─────────────────────────────────────────────────────────────
test('型別/版本不合法、非 panel 缺 tab.id → 一律 false', () => {
  const db = createDb(makeHarness().deps);
  assert.equal(db.handleRuntimeMessage(null, panelSender()), false);
  assert.equal(
    db.handleRuntimeMessage({ v: 2, type: 'RUN_PREDICTION', tabId: 1 }, panelSender()),
    false,
  );
  assert.equal(db.handleRuntimeMessage({ v: 1, type: 'WHAT' }, panelSender()), false);
  assert.equal(
    db.handleRuntimeMessage({ v: 1, type: 'RUN_PREDICTION', tabId: 1 }, { tab: {} }),
    false,
  );
  assert.equal(
    db.handleRuntimeMessage({ v: 1, type: 'SNAPSHOT_UPSERT', bars: [] }, { tab: {} }),
    false,
  );
});

test('resolution 兜底：meta 無 resolution 時由 tab URL interval= 解析', async () => {
  const h = makeHarness({ tabUrls: { 1: 'https://www.tradingview.com/chart/x/?interval=15' } });
  const db = createDb(h.deps);
  db.handleRuntimeMessage(upsert(bars(1_000_000, 60), { symbol: 'S' }), tvSender(1));
  await db.handleRuntimeMessage(run(1), panelSender());
  assert.equal(h.evaluateCalls[0].state.resolution, '15');
});

test('SET_ACTIVE_TAB 記錄、ACTIVE_TAB_QUERY 回報；panel 未帶 tabId 時沿用', async () => {
  const h = makeHarness();
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(42),
  );
  const set = db.handleRuntimeMessage({ v: 1, type: 'SET_ACTIVE_TAB', tabId: 42 }, panelSender());
  assert.equal(set.tabId, 42);
  const q = db.handleRuntimeMessage({ v: 1, type: 'ACTIVE_TAB_QUERY' }, panelSender());
  assert.equal(q.tabId, 42);

  const res = await db.handleRuntimeMessage({ v: 1, type: 'RUN_PREDICTION' }, panelSender());
  assert.equal(res.ok, true);
  assert.equal(h.evaluateCalls[0].state.symbol, 'S');
});

test('featuresOn:false → state 不含 features 鍵', async () => {
  const h = makeHarness({ store: { featuresOn: false } });
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );
  await db.handleRuntimeMessage(run(1), panelSender());
  assert.equal('features' in h.evaluateCalls[0].state, false);
});

// ─────────────────────────────────────────────────────────────
// Task 09e：資料不足拒絕 + GET_STATE 觸發重同步
// ─────────────────────────────────────────────────────────────
test('09e-1 資料不足直接拒絕：不呼叫 evaluate（fake 計數 0）、error.kind=insufficient_data', async () => {
  const h = makeHarness();
  const db = createDb(h.deps);
  // 20 根 >= 補傳門檻(10) 但 < PREDICT_MIN_BARS(50)：不觸發 (b)，直接拒絕。
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 20), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );
  const res = await db.handleRuntimeMessage(run(1), panelSender());
  assert.equal(res.ok, false);
  assert.equal(res.error.kind, 'insufficient_data');
  assert.match(res.error.message, /20 根/);
  assert.match(res.error.message, /≥50/);
  assert.equal(h.evaluateCalls.length, 0, '09e-1：不得呼叫 evaluate，不得消耗額度');
  assert.equal(db.entryFor(1).last.kind, 'insufficient_data');
  const updates = h.broadcasts.filter((m) => m.type === 'PREDICTION_UPDATED');
  assert.deepEqual(updates.map((m) => m.state), ['loading', 'error']);
});

test('09e-3 GET_STATE 根數不足時不阻塞地發 REQ_SNAPSHOT{full:true}；足夠時不發', () => {
  const h = makeHarness();
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 5), { symbol: 'S', resolution: '1' }),
    tvSender(21),
  );

  // 只看這次 GET_STATE 的效果：清掉首觸那則。
  h.tabMessages.length = 0;
  const thin = db.handleRuntimeMessage(
    { v: 1, type: 'GET_STATE', tabId: 21 },
    panelSender(),
  );
  // 同步回傳目前狀態（不阻塞），且主動要求全量重送。
  assert.equal(thin.count, 5);
  assert.equal(thin.symbol, 'S');
  const thinReqs = h.tabMessages.filter((m) => m.msg.type === 'REQ_SNAPSHOT');
  assert.equal(thinReqs.length, 1);
  assert.equal(thinReqs[0].tabId, 21);
  assert.equal(thinReqs[0].msg.full, true);

  // 補到 60 根後，GET_STATE 不再要求重送。
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(21),
  );
  h.tabMessages.length = 0;
  const full = db.handleRuntimeMessage(
    { v: 1, type: 'GET_STATE', tabId: 21 },
    panelSender(),
  );
  assert.equal(full.count, 60);
  assert.equal(
    h.tabMessages.filter((m) => m.msg.type === 'REQ_SNAPSHOT').length,
    0,
  );
});

// ─────────────────────────────────────────────────────────────
// Task 09c：§4.7.2 全量重送觸發 + §4.7.3 狀態持久化
// ─────────────────────────────────────────────────────────────
test('§4.7.2(a) 首觸 tab 即發 REQ_SNAPSHOT{full:true}（新建 entry 後）', () => {
  const h = makeHarness();
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 5), { symbol: 'S', resolution: '1' }),
    tvSender(11),
  );
  const reqs = h.tabMessages.filter((m) => m.msg.type === 'REQ_SNAPSHOT');
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].tabId, 11);
  assert.equal(reqs[0].msg.v, 1);
  assert.equal(reqs[0].msg.full, true);
});

test('§4.7.2(b) 根數 ≥ MIN 時不再發全量請求；< MIN 時帶 full:true', async () => {
  const h = makeHarness();
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );
  await db.handleRuntimeMessage(run(1), panelSender());
  // 60 根 >= RESYNC_MIN_BARS(10)：只有 (a) 首觸那則，沒有 (b)。
  const reqs = h.tabMessages.filter((m) => m.msg.type === 'REQ_SNAPSHOT');
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].msg.full, true);
});

/** 可跨 db 實例共用的 storage.session 假物件。 */
function makeSessionApi() {
  const store = {};
  return {
    store,
    api: {
      get: async (keys) => {
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) if (k in store) out[k] = store[k];
          return out;
        }
        return { ...store };
      },
      set: async (obj) => {
        Object.assign(store, obj);
      },
    },
  };
}

test('§4.7.3 SW 重啟後 lastActiveTabId 仍在：storage.session 還原，GET_LAST_TAB 與 panel 訊息沿用', async () => {
  const session = makeSessionApi();

  // 實例 1：content script upsert → 記錄並持久化 tabId=7。
  const h1 = makeHarness({ session: session.api });
  const db1 = createDb(h1.deps);
  db1.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(7),
  );
  await Promise.resolve(); // 讓 persistActiveTab 的 microtask 落地
  assert.equal(session.store.lastActiveTabId, 7);

  // 實例 2：模擬 SW 被回收後重啟（新 registry、同一 storage.session）。
  const h2 = makeHarness({ session: session.api });
  const db2 = createDb(h2.deps);

  const last = await db2.handleRuntimeMessage(
    { v: 1, type: 'GET_LAST_TAB' },
    panelSender(),
  );
  assert.deepEqual(last, { v: 1, type: 'GET_LAST_TAB', tabId: 7 });

  // panel 訊息未帶 tabId → sw-core 以還原的 activeTabId=7 觸發該 tab 的全量請求。
  const res = await db2.handleRuntimeMessage(
    { v: 1, type: 'RUN_PREDICTION' },
    panelSender(),
  );
  assert.equal(res.ok, false); // registry 空 → 逾時後 0 根，不致命
  const req = h2.tabMessages.find((m) => m.msg.type === 'REQ_SNAPSHOT');
  assert.ok(req, '應對還原出來的 tab 7 發 REQ_SNAPSHOT');
  assert.equal(req.tabId, 7);
  assert.equal(req.msg.full, true);
});

test('§4.7.3 session 讀取失敗降級為記憶體值，不拋錯', async () => {
  const session = {
    get: async () => {
      throw new Error('session unavailable');
    },
    set: async () => {
      throw new Error('session unavailable');
    },
  };
  const h = makeHarness({ session });
  const db = createDb(h.deps);
  // 讀取失敗：GET_LAST_TAB 仍可回答（記憶體值 null），不得拋錯。
  const last = await db.handleRuntimeMessage(
    { v: 1, type: 'GET_LAST_TAB' },
    panelSender(),
  );
  assert.deepEqual(last, { v: 1, type: 'GET_LAST_TAB', tabId: null });
  // 寫入失敗亦不影響 upsert 處理。
  assert.equal(
    db.handleRuntimeMessage(
      upsert(bars(1_000_000, 3), { symbol: 'S', resolution: '1' }),
      tvSender(9),
    ),
    false,
  );
  assert.equal(db.entryFor(9).buffer.count, 3);
});

// ─────────────────────────────────────────────────────────────
// Task 10 §4.8：counter 捎帶 / ring log / RESYNC
// ─────────────────────────────────────────────────────────────

/** 帶 counters 的 upsert（模擬 inject §4.8.1 捎帶）。 */
function upsertWithCounters(bs, meta, counters, reset) {
  return { ...upsert(bs, meta, reset), counters };
}

test('§4.8.1 counters 捎帶：upsert 帶 counters → entry.counters 更新、GET_STATE 帶著回', () => {
  const db = createDb(makeHarness().deps);

  // 未收到 upsert 前：預設 {0,0}。
  assert.deepEqual(
    db.handleRuntimeMessage({ v: 1, type: 'GET_STATE' }, panelSender()),
    { status: 'idle', count: 0, counters: { dropped: 0, ignoredSeriesFrames: 0 }, studiesCount: 0 },
  );

  db.handleRuntimeMessage(
    upsertWithCounters(
      bars(1_000_000, 60),
      { symbol: 'S', resolution: '1' },
      { dropped: 7, ignoredSeriesFrames: 3 },
    ),
    tvSender(1),
  );
  assert.deepEqual(db.entryFor(1).counters, { dropped: 7, ignoredSeriesFrames: 3 });

  const summary = db.handleRuntimeMessage(
    { v: 1, type: 'GET_STATE', tabId: 1 },
    panelSender(),
  );
  assert.deepEqual(summary.counters, { dropped: 7, ignoredSeriesFrames: 3 });
  // 其餘欄位語意不變。
  assert.equal(summary.count, 60);
  assert.equal(summary.symbol, 'S');
});

test('§4.8.1 counters 缺值／非數值降級為 0，不拋錯、不覆蓋整包', () => {
  const db = createDb(makeHarness().deps);
  db.handleRuntimeMessage(
    upsertWithCounters(bars(1_000_000, 5), { symbol: 'S' }, { dropped: 'x' }),
    tvSender(1),
  );
  assert.deepEqual(db.entryFor(1).counters, { dropped: 0, ignoredSeriesFrames: 0 });

  // 完全不帶 counters 的舊格式 upsert：entry 仍存在且 counters 預設 0。
  db.handleRuntimeMessage(upsert(bars(2_000_000, 5), { symbol: 'S' }), tvSender(2));
  assert.deepEqual(db.entryFor(2).counters, { dropped: 0, ignoredSeriesFrames: 0 });
});

test('§4.8.2 ring log 成功筆：answers 摘要、costUsd、model、新→舊', async () => {
  const h = makeHarness({
    evaluate: async () => ({
      model: 'jev-1.13.0',
      answers: {
        direction: { choice: 'long', probabilities: { long: 0.6, neutral: 0.3, short: 0.1 } },
        up_10_bars: { noul: 0.55 },
        bull_trend: { score: 2 },
        bear_trend: { score: 1 },
      },
      usage: { input_tokens: 1234, output_tokens: 7 },
    }),
  });
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'BINANCE:BTCUSDT', resolution: '15' }),
    tvSender(1),
  );
  const res = await db.handleRuntimeMessage(run(1), panelSender());
  assert.equal(res.ok, true);

  const log = db.handleRuntimeMessage(
    { v: 1, type: globalThis.MSG.GET_RING_LOG },
    panelSender(),
  );
  assert.equal(log.ok, true);
  assert.equal(log.entries.length, 1);
  const e = log.entries[0];
  assert.equal(e.ok, true);
  assert.equal(e.tabId, 1);
  assert.equal(e.symbol, 'BINANCE:BTCUSDT');
  assert.equal(e.resolution, '15');
  assert.equal(e.direction, 'long');
  assert.deepEqual(e.probs, { long: 0.6, neutral: 0.3, short: 0.1 });
  assert.equal(e.up10, 0.55);
  assert.equal(e.bull, 2);
  assert.equal(e.bear, 1);
  assert.equal(e.inputTokens, 1234);
  assert.equal(e.outputTokens, 7);
  // §4.8.2：costUsd = inputTokens × COST_USD_PER_MTOK / 1e6。
  assert.equal(e.costUsd, (1234 * globalThis.COST_USD_PER_MTOK) / 1e6);
  assert.equal(e.model, 'jev-1.13.0');
  assert.ok(typeof e.at === 'number');
  assert.ok(typeof e.ms === 'number' && e.ms >= 0);
});

test('§4.8.2 ring log：上限 20 丟最舊且新→舊排序', async () => {
  let calls = 0;
  const h = makeHarness({
    evaluate: async () => {
      calls += 1;
      return { model: 'm', answers: {}, usage: { input_tokens: calls, output_tokens: 0 } };
    },
  });
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );
  for (let i = 0; i < 22; i += 1) {
    await db.handleRuntimeMessage(run(1), panelSender());
  }

  const log = db.handleRuntimeMessage(
    { v: 1, type: globalThis.MSG.GET_RING_LOG },
    panelSender(),
  );
  assert.equal(log.entries.length, 20, '上限 20');
  // 新→舊：第一筆是最後一次預測（calls=22），最後一筆是保留的最舊（calls=3；1、2 已丟）。
  assert.equal(log.entries[0].inputTokens, 22);
  assert.equal(log.entries[19].inputTokens, 3);
  for (let i = 1; i < log.entries.length; i += 1) {
    assert.ok(log.entries[i - 1].at >= log.entries[i].at, 'at 需非遞增（新→舊）');
  }
});

test('§4.8.2 ring log 錯誤筆：含 kind＋已 redact 短 message，無 key／header 片段', async () => {
  const h = makeHarness({
    evaluate: async () => {
      throw new JevError('auth_401', `bad key ${KEY}`);
    },
  });
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );
  await db.handleRuntimeMessage(run(1), panelSender());

  const log = db.handleRuntimeMessage(
    { v: 1, type: globalThis.MSG.GET_RING_LOG },
    panelSender(),
  );
  assert.equal(log.entries.length, 1);
  const e = log.entries[0];
  assert.equal(e.ok, false);
  assert.equal(e.kind, 'auth_401');
  assert.ok(String(e.message).includes('[redacted]'));
  assert.equal(String(e.message).includes(KEY), false);
  assert.equal(JSON.stringify(e).includes(KEY), false);
  assert.ok(String(e.message).length <= 121, '短 message（含省略號上限）');
  assert.equal(e.costUsd, 0);
  assert.equal(e.inputTokens, 0);
});

test('§4.8.2 ring log：資料不足拒絕也留一筆（ok:false, kind=insufficient_data）', async () => {
  const h = makeHarness();
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 20), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );
  const res = await db.handleRuntimeMessage(run(1), panelSender());
  assert.equal(res.ok, false);

  const log = db.handleRuntimeMessage(
    { v: 1, type: globalThis.MSG.GET_RING_LOG },
    panelSender(),
  );
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].ok, false);
  assert.equal(log.entries[0].kind, 'insufficient_data');
});

test('§4.8.3 RESYNC：對該 tab 發 REQ_SNAPSHOT{full:true} 並回 {ok:true,count}', async () => {
  const h = makeHarness({ tabUrls: { 1: TV_URL }, waitMs: 5 });
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );

  h.tabMessages.length = 0; // 只看 RESYNC 這一則
  const res = await db.handleRuntimeMessage(
    { v: 1, type: globalThis.MSG.RESYNC, tabId: 1 },
    panelSender(),
  );
  assert.deepEqual(res, { ok: true, count: 60 });

  const reqs = h.tabMessages.filter((m) => m.msg.type === globalThis.MSG.REQ_SNAPSHOT);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].tabId, 1);
  assert.equal(reqs[0].msg.v, 1);
  assert.equal(reqs[0].msg.full, true, '§4.7.2 語意：full:true 全量重送');
});

test('§4.8.3 RESYNC：無 entry／非 TV tab（含 tab 已導離）→ {ok:false}', async () => {
  const h = makeHarness({
    tabUrls: { 2: 'https://example.com/chart/x' },
    waitMs: 5,
  });
  const db = createDb(h.deps);

  // 無 entry。
  assert.deepEqual(
    await db.handleRuntimeMessage(
      { v: 1, type: globalThis.MSG.RESYNC, tabId: 42 },
      panelSender(),
    ),
    { ok: false },
  );

  // 有 entry，但該 tab 現址已非 tradingview.com/chart（sender 當時是 TV，如今導離）。
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(2),
  );
  assert.deepEqual(
    await db.handleRuntimeMessage(
      { v: 1, type: globalThis.MSG.RESYNC, tabId: 2 },
      panelSender(),
    ),
    { ok: false },
  );
});

test('§4.8.3 RESYNC 無 tabId 時沿用 lastActiveTabId；content script 來源被拒', async () => {
  const h = makeHarness({ tabUrls: { 5: TV_URL }, waitMs: 5 });
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(5),
  );
  h.tabMessages.length = 0;

  // 不帶 tabId → 沿用 activeTabId=5。
  const res = await db.handleRuntimeMessage(
    { v: 1, type: globalThis.MSG.RESYNC },
    panelSender(),
  );
  assert.equal(res.ok, true);
  assert.equal(res.count, 60);

  // content script 來源（sender.tab 有值）不得觸發 RESYNC。
  assert.equal(
    db.handleRuntimeMessage({ v: 1, type: globalThis.MSG.RESYNC, tabId: 5 }, tvSender(5)),
    false,
  );
});

test('§4.8.2 ring log 不持久化：storage 只可能寫 lastActiveTabId，絕不寫 ring log', async () => {
  const writes = [];
  const h = makeHarness({
    session: {
      get: async () => ({}),
      set: async (obj) => {
        writes.push(obj);
      },
    },
  });
  const db = createDb(h.deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );
  await db.handleRuntimeMessage(run(1), panelSender());

  // 確實有 ring log 一筆。
  const log = db.handleRuntimeMessage(
    { v: 1, type: globalThis.MSG.GET_RING_LOG },
    panelSender(),
  );
  assert.equal(log.entries.length, 1);

  // 持久化只可能是 lastActiveTabId；ring log 鍵不得出現在任何 storage 寫入。
  const keys = writes.flatMap((w) => Object.keys(w));
  assert.ok(keys.length > 0, '應至少寫過 activeTabId');
  assert.deepEqual([...new Set(keys)], ['lastActiveTabId']);
  assert.ok(writes.every((w) => !/ring/i.test(JSON.stringify(w))));
});

// ─────────────────────────────────────────────────────────────
// Task 13／§4.2.2：study 消費（entry.studies / GET_STATE.studiesCount / state.studies）
// ─────────────────────────────────────────────────────────────

/** STUDIES_UPSERT 訊息（模擬 inject→bridge→SW）。 */
function studiesUpsert(meta, patches, gone) {
  return {
    v: 1,
    type: globalThis.MSG.STUDIES_UPSERT,
    meta,
    patches,
    ...(gone ? { gone } : {}),
  };
}

test('Task13 STUDIES_UPSERT：meta+patches → entry.studies、GET_STATE studiesCount', () => {
  const db = createDb(makeHarness().deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );

  assert.equal(
    db.handleRuntimeMessage(
      studiesUpsert(
        { '51IoAU': { scriptName: 'Script@x', pineId: 'STD;Arnaud%1Legoux%1Moving%1Average', params: { in_0: 25 } } },
        { '51IoAU': [[1000, 1], [1060, 2]] },
      ),
      tvSender(1),
    ),
    false,
  );

  const rec = db.entryFor(1).studies.get('51IoAU');
  assert.equal(rec.meta.pineId, 'STD;Arnaud%1Legoux%1Moving%1Average');
  assert.deepEqual(rec.meta.params, { in_0: 25 });
  assert.deepEqual(rec.series.get(1000), [1]);
  assert.deepEqual(rec.series.get(1060), [2]);

  // 同 time 後到覆寫。
  db.handleRuntimeMessage(
    studiesUpsert({}, { '51IoAU': [[1060, 22]] }),
    tvSender(1),
  );
  assert.deepEqual(db.entryFor(1).studies.get('51IoAU').series.get(1060), [22]);

  const summary = db.handleRuntimeMessage(
    { v: 1, type: globalThis.MSG.GET_STATE, tabId: 1 },
    panelSender(),
  );
  assert.equal(summary.studiesCount, 1);
  assert.equal(summary.count, 60);
});

test('Task13 每 study 序列上限 3000 丟最舊；gone 移除該 study', () => {
  const db = createDb(makeHarness().deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );

  const rows = Array.from({ length: 3005 }, (_, i) => [i + 1, i]);
  db.handleRuntimeMessage(
    studiesUpsert({ sid: { scriptName: 'X' } }, { sid: rows }),
    tvSender(1),
  );
  const series = db.entryFor(1).studies.get('sid').series;
  assert.equal(series.size, 3000);
  assert.equal(series.has(1), false, '最舊 5 根被丟棄');
  assert.equal(series.has(3005), true);

  db.handleRuntimeMessage(studiesUpsert({}, {}, ['sid']), tvSender(1));
  assert.equal(db.entryFor(1).studies.has('sid'), false, 'gone 移除');
});

test('Task13 symbol 完整重置 → study 序列清、meta 保留；同 symbol reset 不清', () => {
  const db = createDb(makeHarness().deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'AAA', resolution: '1' }),
    tvSender(1),
  );
  db.handleRuntimeMessage(
    studiesUpsert({ sid: { scriptName: 'X', params: { in_0: 1 } } }, { sid: [[1000, 1]] }),
    tvSender(1),
  );
  assert.equal(db.entryFor(1).studies.get('sid').series.size, 1);

  // 同 symbol 的 reset:true（series_loading／timeframe）不得清 study 序列。
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'AAA', resolution: '5' }, true),
    tvSender(1),
  );
  assert.equal(db.entryFor(1).studies.get('sid').series.size, 1);

  // 真實 symbol 變更 → 清序列、保留 meta。
  db.handleRuntimeMessage(
    upsert(bars(2_000_000, 60), { symbol: 'BBB', resolution: '5' }),
    tvSender(1),
  );
  const rec = db.entryFor(1).studies.get('sid');
  assert.equal(rec.series.size, 0, 'symbol 變更清空序列');
  assert.equal(rec.meta.scriptName, 'X', 'meta 保留');
  assert.equal(db.entryFor(1).studies.size, 1);

  // INTERNAL:* 的 symbol 不得觸發清序列（防護）。
  db.handleRuntimeMessage(
    studiesUpsert({}, { sid: [[1000, 9]] }),
    tvSender(1),
  );
  db.handleRuntimeMessage(
    upsert(bars(2_000_000, 60), { symbol: 'INTERNAL:SEASONALS', resolution: '5' }),
    tvSender(1),
  );
  assert.equal(db.entryFor(1).studies.get('sid').series.size, 1);
});

test('Task13 STUDIES_UPSERT 壞型別輸入不炸', () => {
  const db = createDb(makeHarness().deps);
  db.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(1),
  );

  const bad = [
    { v: 1, type: globalThis.MSG.STUDIES_UPSERT, meta: null, patches: null },
    { v: 1, type: globalThis.MSG.STUDIES_UPSERT, meta: 'x', patches: [] },
    { v: 1, type: globalThis.MSG.STUDIES_UPSERT, meta: { a: 1 }, patches: { a: 'no' } },
    {
      v: 1,
      type: globalThis.MSG.STUDIES_UPSERT,
      meta: { b: { scriptName: 'B', evil: 'drop' } },
      patches: { b: [[1], [2, 'x'], [NaN, 1], ['t', 1], null, {}] },
    },
    { v: 1, type: globalThis.MSG.STUDIES_UPSERT, gone: 'nope' },
    { v: 1, type: globalThis.MSG.STUDIES_UPSERT, gone: [1, null, 'z'] },
  ];
  for (const m of bad) {
    assert.equal(db.handleRuntimeMessage(m, tvSender(1)), false, '不拋錯、回 false');
  }

  // 壞輸入中唯一有效的一列被收下；其餘任意鍵被 sanitize 掉。
  const series = db.entryFor(1).studies.get('b').series;
  assert.deepEqual([...series.entries()], [[2, ['x']]]);
  assert.equal('evil' in db.entryFor(1).studies.get('b').meta, false);

  // 非 TV sender 的 STUDIES_UPSERT 一律拒絕。
  assert.equal(
    db.handleRuntimeMessage(
      studiesUpsert({ x: {} }, { x: [[1, 1]] }),
      { url: 'https://example.com', tab: { id: 9, url: 'https://example.com' } },
    ),
    false,
  );
  assert.equal(db.entryFor(9), undefined);
});

test('Task13 RUN_PREDICTION：state.studies 與 bars 窗口對齊、nameMap 覆寫、未掛指標 []', async () => {
  const h = makeHarness({ store: { studyNameMap: { sid: '自訂名稱' } } });
  const db = createDb(h.deps);
  const all = bars(1_000_000, 350);
  db.handleRuntimeMessage(
    upsert(all, { symbol: 'BINANCE:BTCUSDT', resolution: '1' }),
    tvSender(1),
  );

  const t0 = all[347][0];
  const t1 = all[348][0];
  const t2 = all[349][0];
  db.handleRuntimeMessage(
    studiesUpsert(
      { sid: { scriptName: 'Volume@tv-basicstudies-277', params: { length: 20 } } },
      { sid: [[t0, 1], [t1, 2], [t2, 3]] },
    ),
    tvSender(1),
  );

  const res = await db.handleRuntimeMessage(run(1), panelSender());
  assert.equal(res.ok, true);
  const state = h.evaluateCalls[0].state;
  assert.ok(Array.isArray(state.studies), 'state 必須帶 studies');
  assert.equal(state.studies.length, 1);
  const s = state.studies[0];
  assert.equal(s.id, 'sid');
  assert.equal(s.name, '自訂名稱', 'nameMap 覆寫優先');
  assert.equal(s.rawName, 'Volume');
  assert.deepEqual(s.params, { length: 20 });
  assert.deepEqual(s.columns, ['time', 'v1']);
  // state.bars 視窗 = 最近 300 根（all.slice(50)）；study 值在最後 3 根。
  assert.equal(s.values.length, state.bars.length);
  assert.equal(s.values.length, 300);
  assert.deepEqual(s.values[297], [t0, 1]);
  assert.deepEqual(s.values[298], [t1, 2]);
  assert.deepEqual(s.values[299], [t2, 3]);
  assert.equal(s.values[0], null, '同窗口缺值根補 null');

  // 未掛指標的 tab → studies:[]。
  const h2 = makeHarness();
  const db2 = createDb(h2.deps);
  db2.handleRuntimeMessage(
    upsert(bars(1_000_000, 60), { symbol: 'S', resolution: '1' }),
    tvSender(2),
  );
  await db2.handleRuntimeMessage(run(2), panelSender());
  assert.deepEqual(h2.evaluateCalls[0].state.studies, []);
});
