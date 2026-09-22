// lib/sw-core.js — service worker 編排核心（純 ESM、零瀏覽器擴充 API，依賴全部 DI 注入）。
// 對應 docs/ARCHITECTURE.md §4.1（訊息協定）、§4.3/§4.4（buffer→state→Jev）、
// §5（安全 redact）、§6（禁令：lib 不得碰擴充 API、外呼收斂 jev-client）。
//
// 這裡只做「資料中樞」：多 tab registry、快照補傳、buildState→evaluate、結果廣播。
// 殼（background/service-worker.js）負責把真擴充 API 以最小介面注入。

import './protocol.js';
// protocol.js 為 classic-script 雙相容（無 export），符號掛在 globalThis。
const { MSG, makeMessage, BAR_COLUMNS, PREDICT_MIN_BARS, COST_USD_PER_MTOK } =
  globalThis;

import { ChartBuffer as RealChartBuffer } from './chart-buffer.js';
import {
  buildState as realBuildState,
  QUESTIONS as realQuestions,
} from './state-builder.js';
import { JevError, evaluate as realEvaluate } from './jev-client.js';

const MAX_BARS = 3000; // §4.3 滾動上限
// 補傳觸發門檻：低於此值先向 tab 要補傳（§4.7.2）。與「能否預測」的
// PREDICT_MIN_BARS（50，來自 protocol.js 單一來源）是兩件不同的事：
// 這裡只是盡早觸發重同步；即使補傳後仍不足 50，會在 doPredict 拒絕預測。
const RESYNC_MIN_BARS = 10;
const DEFAULT_BARS = 300; // Options 未設定時的視窗根數
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_WAIT_MS = 800; // 等補傳的上限；逾時不致命
const REDACTED = '[redacted]';
// 僅接受 tradingview.com/chart（含子網域），邊界錨點避免 evil.com 誤判。
const TV_CHART_RE = /^https:\/\/([a-z0-9-]+\.)*tradingview\.com\/chart(\/|$)/i;

// §4.8.2：ring log 只在記憶體，上限 20（超出丟最舊），禁止任何持久化。
const RING_LOG_MAX = 20;
// 錯誤筆短 message 上限（redact 後才截短）。
const RING_MESSAGE_MAX = 120;

const SESSION_LAST_TAB_KEY = 'lastActiveTabId'; // 儲存區 session 的鍵名

/** §4.8.1：inject 尚未回報前的旁聽計數預設值。 */
function defaultCounters() {
  return { dropped: 0, ignoredSeriesFrames: 0 };
}

/**
 * §4.8.2：ring log 錯誤筆用的短 message 再 redact。
 * 即使上層已 redact 過，這裡仍防呆剝除 key／Bearer／長 token 並截短。
 */
function redactShort(value, apiKey) {
  let s = value == null ? '' : String(value);
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    s = s.split(apiKey).join(REDACTED);
  }
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, REDACTED);
  s = s.replace(/[A-Za-z0-9._\-]{20,}/g, REDACTED);
  if (s.length > RING_MESSAGE_MAX) s = s.slice(0, RING_MESSAGE_MAX) + '…';
  return s;
}

// TEST_KEY 專用：極小固定 state（3 根範例 bar＋features:null）與最簡 direction 單題。
// 刻意寫死、不走 state-builder（Options 的連線測試不需要真實圖表資料）。
const TEST_KEY_STATE = {
  symbol: 'TEST',
  resolution: '1',
  generatedAt: '1970-01-01T00:00:00+00:00',
  barsWindow: 3,
  columns: BAR_COLUMNS,
  bars: [
    [0, 1, 2, 0.5, 1.5, 100],
    [60, 1.5, 2.5, 1, 2, 110],
    [120, 2, 3, 1.5, 2.5, 120],
  ],
  features: null,
};
const TEST_KEY_QUESTIONS = {
  direction: {
    type: 'choice',
    instructions: 'Is the price more likely to rise or fall over the next bars?',
    criteria: { long: 'rise', neutral: 'flat', short: 'fall' },
  },
};

/** sender 的來源網址是否為 TV 圖表頁（優先用 sender.url，其次 sender.tab.url）。 */
function isTvSender(sender) {
  const url =
    sender && sender.url != null
      ? sender.url
      : sender && sender.tab
        ? sender.tab.url
        : undefined;
  return typeof url === 'string' && TV_CHART_RE.test(url);
}

/** 從 tab URL 的 `interval=` 解析 resolution（resolution 兜底）。 */
function parseResolution(url) {
  if (typeof url !== 'string') return undefined;
  const m = /[?&]interval=([^&]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/**
 * 建立可測的 SW 編排核心。
 *
 * @param {object} deps
 * @param {{sendMessage:Function}} deps.runtime       廣播給 runtime listeners
 * @param {{sendMessage:Function,get:Function,query:Function}} deps.tabs
 * @param {{local:{get:Function}}} deps.storage
 * @param {Function} deps.evaluate                    lib/jev-client 的 evaluate（可注入 fake）
 * @param {Function} [deps.ChartBuffer]               lib/chart-buffer 的類別（可注入）
 * @param {Function} [deps.buildState]                lib/state-builder 的 buildState
 * @param {object}   [deps.QUESTIONS]                 lib/state-builder 的 QUESTIONS
 * @param {Function} [deps.estimateTokens]            保留（純 lib，任務未用到）
 * @param {number}   [deps.waitMs=800]                等 REQ_SNAPSHOT 補傳的上限
 * @returns {{handleRuntimeMessage:Function,onTabClosed:Function,entryFor:Function,pendingForTest:Function}}
 */
export function createDb(deps = {}) {
  const runtime = deps.runtime;
  const tabs = deps.tabs;
  const storage = deps.storage;
  const session = storage && storage.session ? storage.session : null;
  const evaluate = deps.evaluate || realEvaluate;
  const ChartBuffer = deps.ChartBuffer || RealChartBuffer;
  const buildState = deps.buildState || realBuildState;
  const QUESTIONS = deps.QUESTIONS || realQuestions;
  const waitMs = Number.isFinite(deps.waitMs) ? deps.waitMs : DEFAULT_WAIT_MS;

  /** tabId → {buffer, meta, status, last, predicting, pending, counters} */
  const registry = new Map();
  /** §4.8.2：最近 RING_LOG_MAX 次 doPredict 摘要（舊→新存；查詢時反轉為新→舊）。 */
  const ringLog = [];
  let activeTabId = null;
  let activeLoaded = false;
  let activeLoadPromise = null;

  // ── lastActiveTabId 持久化（§4.7.3；lib 只經注入的 storage.session）──
  async function loadActiveTab() {
    if (activeLoaded) return activeTabId;
    if (activeLoadPromise) return activeLoadPromise;
    activeLoadPromise = (async () => {
      try {
        if (session && typeof session.get === 'function') {
          const got = await session.get([SESSION_LAST_TAB_KEY]);
          if (got && got[SESSION_LAST_TAB_KEY] != null && activeTabId == null) {
            activeTabId = got[SESSION_LAST_TAB_KEY];
          }
        }
      } catch {
        /* 讀取失敗：降級為記憶體值，不得拋錯 */
      }
      activeLoaded = true;
      return activeTabId;
    })();
    return activeLoadPromise;
  }

  function persistActiveTab() {
    try {
      if (session && typeof session.set === 'function') {
        const p = session.set({ [SESSION_LAST_TAB_KEY]: activeTabId });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch {
      /* 寫入失敗不致命 */
    }
  }

  /** 由 content script 的 upsert 記錄當前圖表 tab（並持久化）。 */
  function noteActiveTab(tabId) {
    if (tabId === undefined || tabId === null) return;
    if (activeTabId === tabId) return;
    activeTabId = tabId;
    persistActiveTab();
  }

  // SW 啟動即嘗試還原（不阻塞同步 API）。
  void loadActiveTab();

  function ensureEntry(tabId) {
    let entry = registry.get(tabId);
    if (!entry) {
      entry = {
        buffer: new ChartBuffer(MAX_BARS),
        meta: { symbol: undefined, resolution: undefined },
        status: 'idle',
        last: null,
        predicting: false,
        pending: null,
        counters: defaultCounters(),
      };
      registry.set(tabId, entry);
    }
    return entry;
  }

  function entryFor(tabId) {
    return registry.get(tabId);
  }

  function pendingForTest(tabId) {
    const entry = registry.get(tabId);
    return !!(entry && entry.pending);
  }

  function broadcast(type, payload) {
    if (!runtime || typeof runtime.sendMessage !== 'function') return;
    try {
      const p = runtime.sendMessage(makeMessage(type, payload));
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* 沒有 listener 時吞掉，不讓廣播影響預測流程 */
    }
  }

  // ── SNAPSHOT_UPSERT ───────────────────────────────────────────────
  function handleUpsert(tabId, msg) {
    const isFirstTouch = !registry.has(tabId);
    const entry = ensureEntry(tabId);
    // §4.7.2(a)：本 SW 實例首次接觸此 tab → 主動要求全量歷史（不阻塞本訊息）。
    if (isFirstTouch) void awaitSnapshot(tabId, entry, { full: true });
    if (msg.reset === true) entry.buffer.reset();
    entry.buffer.upsertBars(msg.bars);
    if (msg.meta && typeof msg.meta === 'object') {
      if (msg.meta.symbol !== undefined) entry.meta.symbol = msg.meta.symbol;
      if (msg.meta.resolution !== undefined) entry.meta.resolution = msg.meta.resolution;
    }
    // §4.8.1：inject 隨每則 upsert 捎帶的旁聽計數；缺值／非數值一律視為 0。
    if (msg.counters && typeof msg.counters === 'object') {
      const droppedN = Number(msg.counters.dropped);
      const ignoredN = Number(msg.counters.ignoredSeriesFrames);
      entry.counters = {
        dropped: Number.isFinite(droppedN) ? droppedN : 0,
        ignoredSeriesFrames: Number.isFinite(ignoredN) ? ignoredN : 0,
      };
    }
    if (entry.pending) entry.pending.finish();
    return false;
  }

  /** §4.8.2：把一次 doPredict 的結果摘要成 ring log 一筆並推入（超出上限丟最舊）。 */
  function pushRingLog(tabId, entry, t0, model, apiKey) {
    const last = entry.last;
    if (!last) return;
    const now = Date.now();
    const meta = entry.meta || {};
    const base = {
      at: now,
      tabId,
      symbol: meta.symbol !== undefined ? meta.symbol : null,
      resolution: meta.resolution !== undefined ? meta.resolution : null,
      ms: Number.isFinite(Number(last.ms)) ? Number(last.ms) : now - t0,
      model: last.model || model,
    };
    let rec;
    if (last.status === 'done') {
      const answers = last.answers || {};
      const direction = answers.direction || {};
      const up = answers.up_10_bars || {};
      const bull = answers.bull_trend || {};
      const bear = answers.bear_trend || {};
      const usage = last.usage || {};
      const inputRaw = Number(usage.input_tokens);
      const outputRaw = Number(usage.output_tokens);
      const inputTokens = Number.isFinite(inputRaw) ? inputRaw : 0;
      const outputTokens = Number.isFinite(outputRaw) ? outputRaw : 0;
      rec = {
        ...base,
        ok: true,
        direction: direction.choice,
        probs: direction.probabilities,
        up10: up.noul,
        bull: bull.score,
        bear: bear.score,
        inputTokens,
        outputTokens,
        costUsd: (inputTokens * COST_USD_PER_MTOK) / 1e6,
      };
    } else {
      rec = {
        ...base,
        ok: false,
        kind: last.kind || 'error',
        message: redactShort(last.message, apiKey),
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
    }
    ringLog.push(rec);
    if (ringLog.length > RING_LOG_MAX) ringLog.shift();
  }

  // ── 等待補傳（REQ_SNAPSHOT → 下一次 upsert 或 waitMs 逾時）──────
  function awaitSnapshot(tabId, entry, opts = {}) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (entry.pending) {
          clearTimeout(entry.pending.timer);
          entry.pending = null;
        }
        resolve();
      };
      // 已有 pending（例如首觸請求）先釋放，避免計時器洩漏。
      if (entry.pending) entry.pending.finish();
      const timer = setTimeout(finish, waitMs);
      entry.pending = { finish, timer };
      try {
        const payload = opts.full === true ? { full: true } : undefined;
        const p = tabs.sendMessage(tabId, makeMessage(MSG.REQ_SNAPSHOT, payload));
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        /* tab 已關或無 content script：等逾時即可 */
      }
    });
  }

  async function readOptions() {
    try {
      const got = await storage.local.get(['jevApiKey', 'jevModel', 'bars', 'featuresOn']);
      return got && typeof got === 'object' ? got : {};
    } catch {
      return {};
    }
  }

  async function resolutionFromTab(tabId) {
    try {
      const tab = await tabs.get(tabId);
      return parseResolution(tab && tab.url);
    } catch {
      return undefined;
    }
  }

  function normalizeBars(v) {
    return Number.isInteger(v) && v > 0 ? v : DEFAULT_BARS;
  }

  // ── RUN_PREDICTION ────────────────────────────────────────────────
  async function doPredict(tabId, entry) {
    entry.predicting = true;
    entry.status = 'loading';
    broadcast(MSG.PREDICTION_UPDATED, { tabId, state: 'loading', status: 'loading' });
    const t0 = Date.now();
    let apiKey = '';
    let model = DEFAULT_MODEL;
    try {
      if (entry.buffer.count < RESYNC_MIN_BARS) {
        // §4.7.2(b)：根數不足 → 要求全量重送（沿用 waitMs，逾時不致命）。
        await awaitSnapshot(tabId, entry, { full: true });
      }
      // 09e-1：等完（或未觸發補傳）後仍不足 PREDICT_MIN_BARS → 拒絕預測，
      // 不得呼叫 evaluate（不消耗 API 額度），也不進行 buildState。
      if (entry.buffer.count < PREDICT_MIN_BARS) {
        const got = entry.buffer.count;
        const message = `K 棒不足（目前 ${got} 根，需 ≥${PREDICT_MIN_BARS}）`;
        entry.last = { status: 'error', kind: 'insufficient_data', message };
        entry.status = 'error';
        broadcast(MSG.PREDICTION_UPDATED, { tabId, state: 'error', status: 'error' });
        return { ok: false, error: { kind: 'insufficient_data', message }, result: entry.last };
      }
      const opts = await readOptions();
      apiKey = typeof opts.jevApiKey === 'string' ? opts.jevApiKey : '';
      model = opts.jevModel || DEFAULT_MODEL;

      const barsN = normalizeBars(opts.bars);
      const snap = entry.buffer.snapshot(barsN);
      let resolution = entry.meta.resolution;
      if (resolution === undefined) resolution = await resolutionFromTab(tabId);
      const state = buildState(
        { symbol: entry.meta.symbol, resolution, bars: snap },
        { bars: barsN, features: opts.featuresOn !== false },
      );

      const res = await evaluate({
        apiKey,
        model,
        state,
        questions: QUESTIONS,
      });
      const usage = (res && res.usage) || {};
      // §4.8.2：成本單價單一來源（lib/protocol.js 的 COST_USD_PER_MTOK）。
      const cost = ((usage.input_tokens || 0) * COST_USD_PER_MTOK) / 1e6;
      entry.last = {
        status: 'done',
        answers: res && res.answers,
        usage,
        cost,
        model: (res && res.model) || model,
        state,
        ms: Date.now() - t0,
        at: Date.now(),
      };
      entry.status = 'done';
      broadcast(MSG.PREDICTION_UPDATED, { tabId, state: 'done', status: 'done' });
      return { ok: true, result: entry.last };
    } catch (err) {
      let kind = 'error';
      if (err instanceof JevError) kind = err.kind;
      else if (err && typeof err.kind === 'string') kind = err.kind;

      let message = err && err.message != null ? String(err.message) : String(err);
      // client 已 redact；這裡再防呆一次，key 只在此變數短暫存在。
      if (apiKey) message = message.split(apiKey).join(REDACTED);
      entry.last = { status: 'error', kind, message };
      entry.status = 'error';
      broadcast(MSG.PREDICTION_UPDATED, { tabId, state: 'error', status: 'error' });
      return { ok: false, error: kind, result: entry.last };
    } finally {
      // §4.8.2：每次 doPredict 結束（含錯誤）都留下一筆記憶體摘要。
      pushRingLog(tabId, entry, t0, model, apiKey);
      entry.predicting = false;
    }
  }

  // ── TEST_KEY（panel/options 來源）───────────────────────────────
  // 守「外呼單點」：Options 不必自己 fetch；成功回 {ok:true}，失敗回 {ok:false, kind}。
  async function testKey() {
    const opts = await readOptions();
    const apiKey = typeof opts.jevApiKey === 'string' ? opts.jevApiKey : '';
    const model = opts.jevModel || DEFAULT_MODEL;
    try {
      await evaluate({
        apiKey,
        model,
        state: TEST_KEY_STATE,
        questions: TEST_KEY_QUESTIONS,
      });
      return { ok: true };
    } catch (err) {
      let kind = 'offhost';
      if (err instanceof JevError) kind = err.kind;
      else if (err && typeof err.kind === 'string') kind = err.kind;
      return { ok: false, kind };
    }
  }

  function runPrediction(tabId) {
    if (tabId === undefined || tabId === null) return { ok: false, error: 'no_tab' };
    const entry = ensureEntry(tabId);
    if (entry.predicting) return { ok: false, error: 'busy' };
    return doPredict(tabId, entry);
  }

  function getState(tabId) {
    if (tabId === undefined || tabId === null) {
      return { status: 'idle', count: 0, counters: defaultCounters() };
    }
    const entry = registry.get(tabId);
    if (!entry) return { status: 'idle', count: 0, counters: defaultCounters() };
    // 09e-3：SW 重啟後常見「首則訊息只有尾根」；若根數不足則主動要求全量重送
    // （不阻塞回應；面板下一輪輪詢即恢復）。預測進行中不動用 pending 以免干擾。
    if (!entry.predicting && entry.buffer.count < PREDICT_MIN_BARS) {
      void awaitSnapshot(tabId, entry, { full: true });
    }
    return {
      status: entry.status,
      count: entry.buffer.count,
      symbol: entry.meta.symbol !== undefined ? entry.meta.symbol : null,
      resolution: entry.meta.resolution !== undefined ? entry.meta.resolution : null,
      // §4.8.1：GET_STATE 新增 counters（其餘欄位與語意不變）。
      counters: entry.counters ? { ...entry.counters } : defaultCounters(),
      last: entry.last,
      meta: entry.meta,
    };
  }

  /** §4.8.2：GET_RING_LOG → 新→舊的記憶體摘要（永不持久化）。 */
  function getRingLog() {
    return { ok: true, entries: ringLog.slice().reverse() };
  }

  /**
   * §4.8.3：RESYNC → 對該 tab 發 REQ_SNAPSHOT{full:true}（§4.7.2 語意），
   * 等補傳（沿用 waitMs，逾時不致命）後回該 tab buffer 根數。
   * 無 entry／非 TV tab → {ok:false}。
   */
  async function resync(tabId) {
    if (tabId === undefined || tabId === null) return { ok: false };
    const entry = registry.get(tabId);
    if (!entry) return { ok: false };
    let url;
    try {
      const tab = await tabs.get(tabId);
      url = tab && tab.url;
    } catch {
      return { ok: false };
    }
    if (typeof url !== 'string' || !TV_CHART_RE.test(url)) return { ok: false };
    await awaitSnapshot(tabId, entry, { full: true });
    return { ok: true, count: entry.buffer.count };
  }

  function setActiveTab(tabId) {
    if (tabId === undefined || tabId === null) return false;
    activeTabId = tabId;
    persistActiveTab();
    return { v: 1, type: 'ACTIVE_TAB', tabId };
  }

  // ── 入口 ──────────────────────────────────────────────────────────
  function handleRuntimeMessage(msg, sender) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.v !== 1) return false;

    const isPanel = !sender || sender.tab === undefined;
    const tabId = msg.tabId != null ? msg.tabId : activeTabId;

    if (isPanel) {
      switch (msg.type) {
        case MSG.RUN_PREDICTION:
          return runPrediction(tabId);
        case MSG.GET_STATE:
          return getState(tabId);
        case MSG.SET_ACTIVE_TAB:
          return setActiveTab(msg.tabId);
        case MSG.ACTIVE_TAB_QUERY:
          return { v: 1, type: MSG.ACTIVE_TAB_QUERY, tabId: activeTabId };
        case MSG.GET_LAST_TAB:
          // §4.7.3：SW 重啟後仍能回答；先確保 session 值已還原。
          return loadActiveTab().then(() => ({
            v: 1,
            type: MSG.GET_LAST_TAB,
            tabId: activeTabId,
          }));
        case MSG.GET_RING_LOG:
          return getRingLog();
        case MSG.RESYNC:
          return resync(tabId);
        case MSG.TEST_KEY:
          return testKey();
        default:
          return false;
      }
    }

    // 非 panel：只接受帶 id 的 content script，且只認 SNAPSHOT_UPSERT。
    const senderTab = sender.tab;
    if (senderTab.id === undefined || senderTab.id === null) return false;
    if (msg.type !== MSG.SNAPSHOT_UPSERT) return false;
    if (!isTvSender(sender)) return false;
    noteActiveTab(senderTab.id);
    return handleUpsert(senderTab.id, msg);
  }

  function onTabClosed(tabId) {
    const entry = registry.get(tabId);
    if (!entry) return;
    if (entry.pending) entry.pending.finish();
    registry.delete(tabId);
    if (activeTabId === tabId) activeTabId = null;
  }

  return { handleRuntimeMessage, onTabClosed, entryFor, pendingForTest };
}
