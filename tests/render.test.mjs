// tests/render.test.mjs — Side Panel / Options 純渲染層 + SW TEST_KEY 路徑。
// 只 import 純 ESM（render.js / sw-core.js），零 DOM、零 chrome.*、零真網路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DISCLAIMER,
  OPEN_OPTIONS_CLASS,
  OPEN_OPTIONS_ACTION,
  renderOpenOptionsButton,
  COST_PER_INPUT_TOKEN,
  DIRECTION_CLASS,
  ERROR_MESSAGES,
  errorMsg,
  escapeHtml,
  renderDirection,
  renderProbabilities,
  renderUp10,
  renderTrend,
  trendLevel,
  renderCost,
  renderDetails,
  renderResult,
  renderLoading,
  renderError,
  renderStatus,
  renderCounters,
  renderRingLog,
  renderRingLogRow,
  formatClock,
  renderStudiesMeta,
  renderStudiesSummary,
  applyStudyNameEdit,
  STUDY_INPUT_CLASS,
  STUDIES_EMPTY_TEXT,
} from '../extension/sidepanel/render.js';

import {
  BARS_MIN,
  BARS_MAX,
  BARS_DEFAULT,
  MODEL_DEFAULT,
  normalizeSettings,
  keyHint,
} from '../extension/options/render.js';

import { createDb } from '../extension/lib/sw-core.js';
import { JevError } from '../extension/lib/jev-client.js';

// ─────────────────────────────────────────────────────────────
// C1：方向徽章 / 機率條 / legend / 成本 / JSON / 免責
// ─────────────────────────────────────────────────────────────

test('方向徽章：long=做多綠 / neutral=觀望灰 / short=做空紅，附 confidence%', () => {
  const long = renderDirection({ choice: 'long', confidence: 0.62 });
  assert.match(long, /dir-long/);
  assert.match(long, /做多/);
  assert.match(long, /62%/);

  const neutral = renderDirection({ choice: 'neutral', confidence: 0.5 });
  assert.match(neutral, /dir-neutral/);
  assert.match(neutral, /觀望/);
  assert.match(neutral, /50%/);

  const short = renderDirection({ choice: 'short', confidence: 0.71 });
  assert.match(short, /dir-short/);
  assert.match(short, /做空/);
  assert.match(short, /71%/);
});

test('方向徽章：未知 choice 退化為觀望，缺 confidence 不炸', () => {
  const html = renderDirection({ choice: 'moon', confidence: undefined });
  assert.match(html, /dir-neutral/);
  assert.match(html, /觀望/);
  assert.doesNotMatch(html, /badge-conf/);
});

test('機率條：三條、寬度取整、標百分比', () => {
  const html = renderProbabilities({ long: 0.62, neutral: 0.23, short: 0.15 });
  assert.match(html, /width:62%/);
  assert.match(html, /width:23%/);
  assert.match(html, /width:15%/);
  assert.match(html, />62%</);
  assert.match(html, />23%</);
  assert.match(html, />15%</);
  const rows = html.match(/prob-row/g) || [];
  assert.equal(rows.length, 3);
});

test('機率條：缺欄位視為 0%，非數字不炸', () => {
  const html = renderProbabilities({ long: 0.4, neutral: 'x' });
  assert.match(html, /width:40%/);
  assert.match(html, /width:0%/);
});

test('trendLevel：用答案附的 legend 映射（數字索引 / 字串級名）', () => {
  const legend = ['none', 'weak', 'moderate', 'strong', 'very strong'];
  assert.equal(trendLevel({ score: 2, legend }), 'moderate');
  assert.equal(trendLevel({ score: 0, legend }), 'none');
  assert.equal(trendLevel({ score: 'strong', legend }), 'strong');
  assert.equal(trendLevel({ score: 'moderate' }), 'moderate');
  assert.equal(trendLevel({}), '—');
  // 渲染字串也帶級名（相容：舊 trend_strength 包成答案層）
  assert.match(renderTrend({ trend_strength: { score: 2, legend } }), /moderate/);
});

test('09h 趨勢兩題：bull_trend/bear_trend 渲染兩列（多頭／空頭趨勢強度）', () => {
  const legend = ['none', 'weak', 'moderate', 'strong', 'very strong'];
  const html = renderTrend({
    bull_trend: { score: 2, legend },
    bear_trend: { score: 0, legend },
  });
  assert.match(html, /多頭趨勢強度/);
  assert.match(html, /空頭趨勢強度/);
  assert.match(html, /moderate/);
  assert.match(html, /none/);
  assert.equal((html.match(/class="trend"/g) || []).length, 2);
});

test('09h 趨勢兩題：缺 bear_trend 不拋錯，該列顯示「—」', () => {
  const legend = ['none', 'weak', 'moderate', 'strong', 'very strong'];
  let html = '';
  assert.doesNotThrow(() => {
    html = renderTrend({ bull_trend: { score: 3, legend } });
  });
  assert.match(html, /多頭趨勢強度/);
  assert.match(html, /空頭趨勢強度/);
  assert.match(html, /—/);
});

test('09h 相容：回應含舊 trend_strength 時渲染單列「趨勢強度」', () => {
  const html = renderTrend({
    trend_strength: { score: 'moderate', legend: ['none', 'weak', 'moderate'] },
  });
  assert.match(html, /趨勢強度/);
  assert.doesNotMatch(html, /多頭趨勢強度/);
  assert.doesNotMatch(html, /空頭趨勢強度/);
  assert.equal((html.match(/class="trend"/g) || []).length, 1);
});

test('up_10_bars.noul → 未來 10 根上漲機率：NN%', () => {
  assert.match(renderUp10({ noul: 0.58 }), /未來 10 根上漲機率：/);
  assert.match(renderUp10({ noul: 0.58 }), /58%/);
  assert.match(renderUp10({}), /—/);
});

test('成本列：tokens、4 位小數 cost（前端重算）、ms、model', () => {
  const html = renderCost(
    { usage: { input_tokens: 1234 }, ms: 987, cost: 999 },
    'jev-preview',
  );
  const expectedCost = (1234 * 0.042) / 1e6;
  assert.match(html, /1234 tokens/);
  assert.ok(html.includes(`$${expectedCost.toFixed(4)}`));
  assert.equal(expectedCost.toFixed(4), '0.0001');
  assert.match(html, /987ms/);
  assert.match(html, /jev-preview/);
});

test('renderDetails：兩個 details、含 bars 欄名、可複製 target', () => {
  const last = {
    state: { columns: ['time', 'open', 'high', 'low', 'close', 'volume'], bars: [[1, 2, 3, 4, 5, 6]] },
    answers: { direction: { choice: 'long' } },
    usage: { input_tokens: 10, output_tokens: 2 },
  };
  const html = renderDetails(last);
  assert.equal((html.match(/<details/g) || []).length, 2);
  assert.match(html, /bars/);
  assert.match(html, /columns/);
  assert.match(html, /time/);
  assert.match(html, /data-copy-target="payload-json"/);
  assert.match(html, /data-copy-target="answer-json"/);
});

test('renderResult：done 版型含 JSON 折疊與免責固定語', () => {
  const last = {
    status: 'done',
    state: { columns: ['time'], bars: [[1, 2, 3, 4, 5, 6]] },
    answers: {
      direction: { choice: 'short', probabilities: { long: 0.1, neutral: 0.2, short: 0.7 }, confidence: 0.7 },
      up_10_bars: { noul: 0.3 },
      bull_trend: { score: 'weak', legend: ['none', 'weak'], confidence: 0.4 },
      bear_trend: { score: 'none', legend: ['none', 'weak'], confidence: 0.6 },
    },
    usage: { input_tokens: 500, output_tokens: 10 },
    ms: 321,
  };
  const html = renderResult(last, { model: 'jev-latest' });
  assert.match(html, /dir-short/);
  assert.match(html, /多頭趨勢強度/);
  assert.match(html, /空頭趨勢強度/);
  assert.match(html, /原始 payload/);
  assert.match(html, /原始回應/);
  assert.ok(html.includes(DISCLAIMER));
});

test('renderLoading / renderStatus：秒級計時與 buffer total 狀態列', () => {
  assert.match(renderLoading(3.4), /loading-timer/);
  assert.match(renderLoading(3.4), />3s</);

  const status = renderStatus({ symbol: 'BTCUSD', resolution: '1', count: 12 });
  assert.match(status, /圖表：BTCUSD/);
  assert.match(status, /12 根/);
  assert.match(status, /buffer total 12/);

  const waiting = renderStatus({ status: 'idle', count: 0 });
  assert.match(waiting, /等待中/);
  assert.match(waiting, /buffer total 0/);
});

// ─────────────────────────────────────────────────────────────
// C1：errorMsg 全 kind 覆蓋（與 jev-client 的 kind 清單對照）
// ─────────────────────────────────────────────────────────────

test('errorMsg：jev-client 全部 kind 皆有中文且與原文不同', () => {
  // 這份清單逐一對照 lib/jev-client.js 所有 new JevError(kind, ...) 呼叫。
  const kinds = [
    'no_key',
    'auth_401',
    'bad_request_422',
    'rate_exhausted',
    'overloaded',
    'timeout',
    'offline',
    'offhost',
  ];
  for (const kind of kinds) {
    const msg = errorMsg(kind);
    assert.equal(typeof msg, 'string', `${kind} 應有訊息`);
    assert.ok(msg.length > 0, `${kind} 訊息非空`);
    assert.notEqual(msg, kind, `${kind} 應被映射成中文`);
    assert.equal(ERROR_MESSAGES[kind], msg, `${kind} 應來自對照表`);
  }
});

test('errorMsg：指定文案逐字符合規格', () => {
  assert.equal(errorMsg('no_key'), '尚未設定 API key，請開啟擴充設定（右鍵→選項）');
  assert.equal(errorMsg('auth_401'), 'API key 已被拒絕（401）');
  assert.equal(errorMsg('rate_exhausted'), 'Jev 限流，稍後再試');
  assert.equal(errorMsg('overloaded'), 'Jev 過載，稍後再試');
  assert.equal(errorMsg('timeout'), '請求逾時（10s）');
  assert.equal(errorMsg('offline'), '離線或防火牆擋了 api.typesafe.ai');
  assert.equal(errorMsg('bad_request_422'), '請求格式被拒絕（422）');
  assert.equal(errorMsg('offhost'), 'API 回應異常');
});

test('errorMsg：未知 kind 顯示原文但先過 [redacted] 檢查', () => {
  assert.equal(errorMsg('weird_kind'), 'weird_kind');
  assert.equal(errorMsg('weird_kind', 'boom'), 'boom');
  // 疑似 token 的長串與 Bearer 片段一律遮罩
  const leak = errorMsg('weird', 'failed Bearer sk-SECRETTOKEN1234567890ABCDEF');
  assert.equal(leak.includes('SECRETTOKEN1234567890ABCDEF'), false);
  assert.match(leak, /\[redacted\]/);
});

test('09e-2 門檻單一來源：globalThis.PREDICT_MIN_BARS=50，insufficient_data 用同一值', () => {
  assert.equal(globalThis.PREDICT_MIN_BARS, 50);
  const msg = errorMsg('insufficient_data');
  assert.equal(msg, ERROR_MESSAGES.insufficient_data);
  assert.match(msg, /K 棒不足/);
  assert.match(msg, /50/);
});

test('renderError：中文訊息、kind 標籤、免責語', () => {
  const html = renderError('auth_401', 'ignored');
  assert.match(html, /API key 已被拒絕（401）/);
  assert.match(html, /auth_401/);
  assert.ok(html.includes(DISCLAIMER));
});

// ─────────────────────────────────────────────────────────────
// F8：Panel 設定入口（⚙ 按鈕＋no_key CTA）
// ─────────────────────────────────────────────────────────────

test('F8：renderError(no_key) 含設定 CTA，其餘 kind 一律不含', () => {
  const noKey = renderError('no_key', 'ignored');
  assert.match(noKey, /去設定 API key/);
  assert.match(noKey, new RegExp(`class="[^"]*${OPEN_OPTIONS_CLASS}`));
  assert.match(noKey, new RegExp(`data-action="${OPEN_OPTIONS_ACTION}"`));

  for (const kind of Object.keys(ERROR_MESSAGES)) {
    if (kind === 'no_key') continue;
    const html = renderError(kind, 'ignored');
    assert.doesNotMatch(html, /去設定 API key/, `${kind} 不得有設定 CTA`);
    assert.doesNotMatch(
      html,
      new RegExp(OPEN_OPTIONS_CLASS),
      `${kind} 不得帶 ${OPEN_OPTIONS_CLASS} hook`,
    );
  }
});

test('F8：renderError 既有結構不變（error-box／title／kicker／msg／disclaimer）', () => {
  const html = renderError('no_key', 'ignored');
  for (const cls of ['error-box', 'error-title', 'error-kicker', 'error-msg', 'disclaimer']) {
    assert.match(html, new RegExp(`class="${cls}"`), `缺少 ${cls}`);
  }
  assert.ok(html.includes(DISCLAIMER));
});

test('F8：renderOpenOptionsButton 純函式、共用 hook、文案 escape', () => {
  const html = renderOpenOptionsButton('去設定 API key');
  assert.match(html, new RegExp(`data-action="${OPEN_OPTIONS_ACTION}"`));
  assert.match(html, new RegExp(OPEN_OPTIONS_CLASS));
  assert.match(html, /去設定 API key/);
  assert.doesNotMatch(renderOpenOptionsButton('<b>x</b>'), /<b>x<\/b>/);
});

test('F8：sidepanel.html 有 ⚙ 設定按鈕且掛同一 hook（無 inline script／外部資源）', () => {
  const html = readFileSync(
    new URL('../extension/sidepanel/sidepanel.html', import.meta.url),
    'utf8',
  );
  assert.match(html, /⚙ 設定/);
  assert.match(html, /id="open-options-btn"/);
  assert.match(html, new RegExp(`data-action="${OPEN_OPTIONS_ACTION}"`));
  assert.match(html, new RegExp(OPEN_OPTIONS_CLASS));
  assert.doesNotMatch(html, /<script(?![^>]*src=)/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('F8：app.js 經 openOptionsPage 開啟且以共用 class 綁定；render.js 不碰 chrome.*', () => {
  const appSrc = readFileSync(
    new URL('../extension/sidepanel/app.js', import.meta.url),
    'utf8',
  );
  const renderSrc = readFileSync(
    new URL('../extension/sidepanel/render.js', import.meta.url),
    'utf8',
  );
  assert.match(appSrc, /chrome\.runtime\.openOptionsPage\s*\(/);
  assert.match(appSrc, new RegExp(OPEN_OPTIONS_CLASS));
  // render.js 為純函式：不得呼叫任何 chrome.* API（註解中的「零 chrome.*」不算）。
  assert.doesNotMatch(renderSrc, /\bchrome\.(?:runtime|storage|sidePanel|tabs)\b/);
});

test('escapeHtml：標籤與引號被編碼', () => {
  assert.equal(escapeHtml('<b>"x"&\'y\'</b>'), '&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;');
});

test('成本常數：$0.042 / 1M tokens，且與 protocol.js 單一來源同源', () => {
  assert.equal(COST_PER_INPUT_TOKEN, 0.042 / 1e6);
  assert.equal(globalThis.COST_USD_PER_MTOK, 0.042);
  assert.equal(COST_PER_INPUT_TOKEN, globalThis.COST_USD_PER_MTOK / 1e6);
  assert.equal(DIRECTION_CLASS.long, 'dir-long');
});

test('§4.8.5(a) renderCounters：正常值照實、缺值／非數值一律顯示 0', () => {
  assert.equal(
    renderCounters({ dropped: 7, ignoredSeriesFrames: 3 }),
    'dropped=7 · ignoredSeriesFrames=3',
  );
  assert.equal(renderCounters(undefined), 'dropped=0 · ignoredSeriesFrames=0');
  assert.equal(renderCounters({}), 'dropped=0 · ignoredSeriesFrames=0');
  assert.equal(
    renderCounters({ dropped: 'x', ignoredSeriesFrames: NaN }),
    'dropped=0 · ignoredSeriesFrames=0',
  );
});

test('§4.8.5(b) renderRingLog：成功筆與錯誤筆、時戳、空清單降級', () => {
  const entries = [
    {
      at: Date.UTC(2026, 0, 2, 3, 4),
      symbol: 'BINANCE:BTCUSDT',
      ok: true,
      direction: 'long',
      probs: { long: 0.57, neutral: 0.23, short: 0.2 },
      up10: 0.55,
      bull: 2,
      bear: 1,
      ms: 123,
      inputTokens: 17123,
      outputTokens: 74,
      costUsd: 0.0007192,
      model: 'jev-1.13.0',
    },
    {
      at: Date.UTC(2026, 0, 2, 3, 3),
      symbol: 'BINANCE:BTCUSDT',
      ok: false,
      kind: 'auth_401',
      message: 'bad',
      ms: 80,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      model: 'jev-latest',
    },
  ];
  const html = renderRingLog(entries);
  assert.equal((html.match(/class="ring-row"/g) || []).length, 2);
  // 時間 HH:MM（本地時區，僅驗型式）。
  assert.match(html, /\d{2}:\d{2}/);
  assert.match(html, /BINANCE:BTCUSDT/);
  assert.match(html, /做多/);
  assert.match(html, /57%/);
  assert.match(html, /多2\/空1/);
  assert.match(html, /17123 tokens/);
  assert.match(html, /\$0\.0007/);
  assert.match(html, /auth_401/);

  const empty = renderRingLog([]);
  assert.match(empty, /ring-empty/);
  assert.match(empty, /—/);
  assert.doesNotThrow(() => renderRingLog(undefined));
  assert.doesNotThrow(() => renderRingLog(null));
});

test('§4.8.5(b) renderRingLog／formatClock 缺值降級不拋錯', () => {
  assert.equal(formatClock(undefined), '—');
  assert.equal(formatClock('x'), '—');
  const html = renderRingLog([{}]);
  assert.match(html, /ring-row/);
  assert.match(html, /—/);
  assert.match(html, /\$0\.0000/);
  // 單列渲染也不拋錯。
  assert.doesNotThrow(() => renderRingLogRow({ ok: true }));
});

test('§4.8.5(b) renderRingLog HTML escape：符號與 kind 不帶出標籤', () => {
  const html = renderRingLog([
    { at: 0, symbol: '<img src=x>', ok: false, kind: '<b>x</b>', costUsd: 0 },
  ]);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;img/);
});

// ─────────────────────────────────────────────────────────────
// C2：normalizeSettings / keyHint
// ─────────────────────────────────────────────────────────────

test('normalizeSettings：空值全走預設', () => {
  const s = normalizeSettings({});
  assert.equal(s.jevApiKey, '');
  assert.equal(s.jevModel, MODEL_DEFAULT);
  assert.equal(s.bars, BARS_DEFAULT);
  assert.equal(s.featuresOn, true);
  assert.deepEqual(normalizeSettings(null), s);
  assert.deepEqual(normalizeSettings(undefined), s);
});

test('normalizeSettings：bars 邊界鉗制 0→50、2000→1000、字串數字→number', () => {
  assert.equal(normalizeSettings({ bars: 0 }).bars, BARS_MIN);
  assert.equal(normalizeSettings({ bars: 2000 }).bars, BARS_MAX);
  assert.equal(normalizeSettings({ bars: 10 }).bars, BARS_MIN);
  assert.equal(normalizeSettings({ bars: '300' }).bars, 300);
  assert.equal(typeof normalizeSettings({ bars: '300' }).bars, 'number');
  assert.equal(normalizeSettings({ bars: 'abc' }).bars, BARS_DEFAULT);
  assert.equal(normalizeSettings({ bars: 499.9 }).bars, 499);
});

test('normalizeSettings：featuresOn 正規化（"false"→false、其他真值→true）', () => {
  assert.equal(normalizeSettings({ featuresOn: 'false' }).featuresOn, false);
  assert.equal(normalizeSettings({ featuresOn: false }).featuresOn, false);
  assert.equal(normalizeSettings({ featuresOn: 0 }).featuresOn, false);
  assert.equal(normalizeSettings({ featuresOn: 'true' }).featuresOn, true);
  assert.equal(normalizeSettings({ featuresOn: true }).featuresOn, true);
  assert.equal(normalizeSettings({ featuresOn: 1 }).featuresOn, true);
  assert.equal(normalizeSettings({ featuresOn: 'whatever' }).featuresOn, true);
});

test('normalizeSettings：model 白名單，非法回預設', () => {
  assert.equal(normalizeSettings({ jevModel: 'jev-preview' }).jevModel, 'jev-preview');
  assert.equal(normalizeSettings({ jevModel: 'gpt' }).jevModel, MODEL_DEFAULT);
  assert.equal(normalizeSettings({ jevApiKey: 123 }).jevApiKey, '');
  assert.equal(normalizeSettings({ jevApiKey: 'k' }).jevApiKey, 'k');
});

test('keyHint：只揭露後 4 碼與長度，不超過後 4 碼', () => {
  const key = 'abcdef1234567890';
  const hint = keyHint(key);
  assert.equal(hint, '••••7890 (len=16)');
  assert.ok(hint.includes('(len=16)'));
  assert.equal(hint.includes('abcdef'), false);
  assert.equal(hint.includes('123456'), false);
  // 只揭露 4 碼：把非 bullet 的英數取出後應恰為最後 4 碼
  const revealed = hint.replace(/[^A-Za-z0-9]/g, '').replace('len16', '');
  assert.equal(revealed, '7890');
});

test('keyHint：空/非字串回未設定', () => {
  assert.equal(keyHint(''), '（未設定）');
  assert.equal(keyHint(undefined), '（未設定）');
  assert.equal(keyHint(12345678), '（未設定）');
  assert.equal(keyHint('abc'), '••••abc (len=3)');
});

// ─────────────────────────────────────────────────────────────
// C4：SW TEST_KEY 成功 / 失敗兩路徑
// ─────────────────────────────────────────────────────────────

/** 只為 TEST_KEY 佈置的最小 harness（fake storage + 記錄 evaluate 參數）。 */
function makeKeyHarness(overrides = {}) {
  const evaluateCalls = [];
  const store = {
    jevApiKey: 'K'.repeat(32),
    jevModel: 'jev-preview',
    bars: 300,
    featuresOn: true,
    ...(overrides.store || {}),
  };
  const deps = {
    runtime: { sendMessage: () => Promise.resolve() },
    tabs: {
      sendMessage: () => Promise.resolve(),
      get: async () => ({}),
      query: async () => [],
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
    },
    evaluate: async (args) => {
      evaluateCalls.push(args);
      if (overrides.evaluate) return overrides.evaluate(args);
      return { model: 'jev-latest', answers: { direction: { choice: 'long' } }, usage: {} };
    },
  };
  return { deps, evaluateCalls, store };
}

test('TEST_KEY 成功：極小固定 state 可 JSON.stringify，單題 direction，model/key 來自 storage', async () => {
  const h = makeKeyHarness();
  const db = createDb(h.deps);

  const res = await db.handleRuntimeMessage({ v: 1, type: 'TEST_KEY' }, {});
  assert.deepEqual(res, { ok: true });

  assert.equal(h.evaluateCalls.length, 1);
  const args = h.evaluateCalls[0];
  assert.equal(args.apiKey, h.store.jevApiKey);
  assert.equal(args.model, 'jev-preview');

  assert.doesNotThrow(() => JSON.stringify(args.state));
  const state = JSON.parse(JSON.stringify(args.state));
  assert.equal(state.bars.length, 3);
  assert.equal(state.barsWindow, 3);
  assert.equal(state.features, null);
  assert.ok(Array.isArray(state.columns));
  assert.deepEqual(Object.keys(args.questions), ['direction']);
  assert.equal(args.questions.direction.type, 'choice');
});

test('TEST_KEY 失敗：JevError.kind 回 {ok:false, kind}，不洩 key', async () => {
  const h = makeKeyHarness({
    evaluate: async () => {
      throw new JevError('auth_401', `bad ${'K'.repeat(32)}`);
    },
  });
  const db = createDb(h.deps);

  const res = await db.handleRuntimeMessage({ v: 1, type: 'TEST_KEY' }, {});
  assert.deepEqual(res, { ok: false, kind: 'auth_401' });
  assert.equal(JSON.stringify(res).includes('KKKK'), false);
});

test('TEST_KEY 一般 throw 也要正規化（kind=offhost），且非 panel 來源被拒', async () => {
  const h = makeKeyHarness({
    evaluate: async () => {
      throw new Error('boom');
    },
  });
  const db = createDb(h.deps);

  const res = await db.handleRuntimeMessage({ v: 1, type: 'TEST_KEY' }, {});
  assert.deepEqual(res, { ok: false, kind: 'offhost' });

  // content script 來源（sender.tab 存在）不得觸發 TEST_KEY。
  const rejected = db.handleRuntimeMessage(
    { v: 1, type: 'TEST_KEY' },
    { url: 'https://www.tradingview.com/chart/x', tab: { id: 9 } },
  );
  assert.equal(rejected, false);
});

// ─────────────────────────────────────────────────────────────
// Task 14／F10：指標映射 UI＋done 結果區指標摘要（純函式）
// ─────────────────────────────────────────────────────────────

test('Task14 renderStudiesMeta：N 指標 N 輸入框，預設值＝自動名、帶 data-study-id／data-auto-name', () => {
  const list = [
    { id: 'sid1', name: 'ALMA(25)', rawName: 'Arnaud Legoux Moving Average' },
    { id: 'sid2', name: 'Volume(20)', rawName: 'Volume' },
  ];
  const html = renderStudiesMeta(list);
  assert.equal((html.match(new RegExp(STUDY_INPUT_CLASS, 'g')) || []).length, 2);
  assert.match(html, /data-study-id="sid1"/);
  assert.match(html, /data-study-id="sid2"/);
  assert.match(html, /value="ALMA\(25\)"/);
  assert.match(html, /value="Volume\(20\)"/);
  assert.match(html, /data-auto-name="ALMA\(25\)"/);
  assert.match(html, /data-auto-name="Volume\(20\)"/);
});

test('Task14 renderStudiesMeta：nameMap 覆寫優先；無覆寫用自動名；不改動傳入 map', () => {
  const map = { sid1: '我的均線' };
  const html = renderStudiesMeta(
    [
      { id: 'sid1', name: 'ALMA(25)' },
      { id: 'sid2', name: 'Volume(20)' },
    ],
    map,
  );
  assert.match(html, /value="我的均線"/);
  assert.match(html, /value="Volume\(20\)"/);
  assert.deepEqual(map, { sid1: '我的均線' });
});

test('Task14 renderStudiesMeta：未偵測到指標／壞輸入 → 降級文案，不拋錯', () => {
  assert.match(renderStudiesMeta([]), new RegExp(STUDIES_EMPTY_TEXT));
  assert.match(renderStudiesMeta(null), new RegExp(STUDIES_EMPTY_TEXT));
  assert.match(renderStudiesMeta(undefined), new RegExp(STUDIES_EMPTY_TEXT));
  assert.doesNotThrow(() => renderStudiesMeta([{}]));
  assert.doesNotThrow(() => renderStudiesMeta('x', 'bad-map'));
});

test('Task14 renderStudiesMeta：study id／name escape 不帶出標籤', () => {
  const html = renderStudiesMeta([{ id: '<img src=x>', name: '"><b>x</b>' }]);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /&lt;img/);
});

test('Task14 applyStudyNameEdit：trim、空字串刪鍵、保留其他鍵、不改動原 map', () => {
  const base = { a: 'A', b: 'B' };
  assert.deepEqual(applyStudyNameEdit(base, 'a', '  X  '), { a: 'X', b: 'B' });
  assert.deepEqual(applyStudyNameEdit(base, 'a', '   '), { b: 'B' });
  assert.deepEqual(applyStudyNameEdit(base, 'c', 'C'), { a: 'A', b: 'B', c: 'C' });
  assert.deepEqual(base, { a: 'A', b: 'B' }, '原 map 不得被改動');
  assert.deepEqual(applyStudyNameEdit(null, 'a', 'A'), { a: 'A' });
  assert.deepEqual(applyStudyNameEdit({ a: 1, b: 2 }, 'a', ''), { b: 2 });
  assert.deepEqual(applyStudyNameEdit({ a: 'A' }, null, 'x'), { a: 'A' });
});

test('Task14 renderStudiesSummary：每指標一行（名稱＋末值＋值個數），空清單回空字串', () => {
  const studies = [
    { id: 's1', name: 'ALMA(25)', values: [[1, 10, 20], null, [3, 30, 40]] },
    { id: 's2', name: 'Volume(20)', values: [null, null] },
  ];
  const html = renderStudiesSummary(studies);
  assert.match(html, /本次附帶指標/);
  assert.equal((html.match(/study-summary-row/g) || []).length, 2);
  assert.match(html, /ALMA\(25\)/);
  assert.match(html, /末值 30, 40/);
  assert.match(html, /2 值/);
  assert.match(html, /Volume\(20\)/);
  assert.match(html, /0 值/);
  assert.match(html, /末值 —/);
  assert.equal(renderStudiesSummary([]), '');
  assert.equal(renderStudiesSummary(undefined), '');
  assert.doesNotThrow(() => renderStudiesSummary([{}]));
});

test('Task14 renderResult：done 結果區含指標摘要；無 indicators 不新增空區塊', () => {
  const base = {
    status: 'done',
    answers: { direction: { choice: 'long', probabilities: { long: 1, neutral: 0, short: 0 } } },
    usage: { input_tokens: 10 },
    ms: 5,
  };
  const withStudies = renderResult({
    ...base,
    state: {
      columns: ['time'],
      bars: [[1, 2, 3, 4, 5, 6]],
      studies: [{ id: 's1', name: 'ALMA(25)', values: [[1, 10], [2, 20]] }],
    },
  });
  assert.match(withStudies, /本次附帶指標/);
  assert.match(withStudies, /ALMA\(25\)/);
  assert.match(withStudies, /末值 20/);
  assert.match(withStudies, /2 值/);

  const withoutStudies = renderResult({
    ...base,
    state: { columns: ['time'], bars: [[1, 2, 3, 4, 5, 6]], studies: [] },
  });
  assert.doesNotMatch(withoutStudies, /本次附帶指標/);
  assert.doesNotThrow(() => renderResult({ ...base, state: undefined }));
});

test('Task14：sidepanel.html 有「指標映射」折疊區與容器；無 inline script／外部資源', () => {
  const html = readFileSync(
    new URL('../extension/sidepanel/sidepanel.html', import.meta.url),
    'utf8',
  );
  assert.match(html, /指標映射/);
  assert.match(html, /id="studies-map"/);
  assert.match(html, /id="studies-map-block"/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('Task14：app.js 只寫 studyNameMap 一鍵；render.js 維持純函式不碰 chrome.*', () => {
  const appSrc = readFileSync(
    new URL('../extension/sidepanel/app.js', import.meta.url),
    'utf8',
  );
  assert.match(appSrc, /chrome\.storage\.local\.get\('studyNameMap'\)/);
  assert.match(appSrc, /chrome\.storage\.local\.set\(\{\s*studyNameMap\s*\}\)/);
  assert.match(appSrc, /STUDY_INPUT_CLASS/);
  assert.match(appSrc, /applyStudyNameEdit/);

  const renderSrc = readFileSync(
    new URL('../extension/sidepanel/render.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(renderSrc, /\bchrome\.(?:runtime|storage|sidePanel|tabs)\b/);
});
