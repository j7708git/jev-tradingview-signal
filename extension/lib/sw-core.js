// lib/sw-core.js — service worker 編排核心（純 ESM、零瀏覽器擴充 API，依賴全部 DI 注入）。
// 對應 docs/ARCHITECTURE.md §4.1（訊息協定）、§4.3/§4.4（buffer→state→Jev）、
// §5（安全 redact）、§6（禁令：lib 不得碰擴充 API、外呼收斂 jev-client）。
//
// 這裡只做「資料中樞」：多 tab registry、快照補傳、buildState→evaluate、結果廣播。
// 殼（background/service-worker.js）負責把真擴充 API 以最小介面注入。

import './protocol.js';
// protocol.js 為 classic-script 雙相容（無 export），符號掛在 globalThis。
const { MSG, makeMessage, BAR_COLUMNS } = globalThis;

import { ChartBuffer as RealChartBuffer } from './chart-buffer.js';
import {
  buildState as realBuildState,
  QUESTIONS as realQuestions,
} from './state-builder.js';
import { JevError, evaluate as realEvaluate } from './jev-client.js';

const MAX_BARS = 3000; // §4.3 滾動上限
const MIN_BARS_FOR_PREDICT = 10; // 低於此值先向 tab 要補傳
const DEFAULT_BARS = 300; // Options 未設定時的視窗根數
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_WAIT_MS = 800; // 等補傳的上限；逾時不致命
const REDACTED = '[redacted]';
// 僅接受 tradingview.com/chart（含子網域），邊界錨點避免 evil.com 誤判。
const TV_CHART_RE = /^https:\/\/([a-z0-9-]+\.)*tradingview\.com\/chart(\/|$)/i;

// panel 專用的 extension-internal 指令（未列入 §4.1 對外協定表）。
const GET_STATE = 'GET_STATE';
const SET_ACTIVE_TAB = 'SET_ACTIVE_TAB';
const ACTIVE_TAB_QUERY = 'ACTIVE_TAB_QUERY';
const TEST_KEY = 'TEST_KEY';

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
  const evaluate = deps.evaluate || realEvaluate;
  const ChartBuffer = deps.ChartBuffer || RealChartBuffer;
  const buildState = deps.buildState || realBuildState;
  const QUESTIONS = deps.QUESTIONS || realQuestions;
  const waitMs = Number.isFinite(deps.waitMs) ? deps.waitMs : DEFAULT_WAIT_MS;

  /** tabId → {buffer, meta, status, last, predicting, pending} */
  const registry = new Map();
  let activeTabId = null;

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
    const entry = ensureEntry(tabId);
    if (msg.reset === true) entry.buffer.reset();
    entry.buffer.upsertBars(msg.bars);
    if (msg.meta && typeof msg.meta === 'object') {
      if (msg.meta.symbol !== undefined) entry.meta.symbol = msg.meta.symbol;
      if (msg.meta.resolution !== undefined) entry.meta.resolution = msg.meta.resolution;
    }
    if (entry.pending) entry.pending.finish();
    return false;
  }

  // ── 等待補傳（REQ_SNAPSHOT → 下一次 upsert 或 waitMs 逾時）──────
  function awaitSnapshot(tabId, entry) {
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
      const timer = setTimeout(finish, waitMs);
      entry.pending = { finish, timer };
      try {
        const p = tabs.sendMessage(tabId, makeMessage(MSG.REQ_SNAPSHOT));
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
    try {
      if (entry.buffer.count < MIN_BARS_FOR_PREDICT) {
        await awaitSnapshot(tabId, entry);
      }
      const opts = await readOptions();
      apiKey = typeof opts.jevApiKey === 'string' ? opts.jevApiKey : '';

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
        model: opts.jevModel || DEFAULT_MODEL,
        state,
        questions: QUESTIONS,
      });
      const usage = (res && res.usage) || {};
      const cost = (usage.input_tokens || 0) * 0.042 / 1e6;
      entry.last = {
        status: 'done',
        answers: res && res.answers,
        usage,
        cost,
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
    if (tabId === undefined || tabId === null) return { status: 'idle', count: 0 };
    const entry = registry.get(tabId);
    if (!entry) return { status: 'idle', count: 0 };
    return {
      status: entry.status,
      count: entry.buffer.count,
      symbol: entry.meta.symbol !== undefined ? entry.meta.symbol : null,
      resolution: entry.meta.resolution !== undefined ? entry.meta.resolution : null,
      last: entry.last,
      meta: entry.meta,
    };
  }

  function setActiveTab(tabId) {
    if (tabId === undefined || tabId === null) return false;
    activeTabId = tabId;
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
        case GET_STATE:
          return getState(tabId);
        case SET_ACTIVE_TAB:
          return setActiveTab(msg.tabId);
        case ACTIVE_TAB_QUERY:
          return { v: 1, type: ACTIVE_TAB_QUERY, tabId: activeTabId };
        case TEST_KEY:
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
