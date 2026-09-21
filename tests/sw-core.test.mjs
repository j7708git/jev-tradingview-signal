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
  assert.equal(entry.last.cost, (1234 * 0.042) / 1e6);
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

test('GET_STATE 無 entry → {status:"idle",count:0}', () => {
  const db = createDb(makeHarness().deps);
  assert.deepEqual(
    db.handleRuntimeMessage({ v: 1, type: 'GET_STATE', tabId: 999 }, panelSender()),
    { status: 'idle', count: 0 },
  );
  assert.deepEqual(
    db.handleRuntimeMessage({ v: 1, type: 'GET_STATE' }, panelSender()),
    { status: 'idle', count: 0 },
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
