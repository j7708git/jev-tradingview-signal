import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QUESTIONS,
  buildState,
  estimateTokens,
} from '../extension/lib/state-builder.js';
import { BAR_COLUMNS } from '../extension/lib/protocol.js';
import { computeFeatures } from '../extension/lib/features.js';

// 固定測試時區，讓 generatedAt（本地偏移）在任一主機上皆可重現。
process.env.TZ = 'Asia/Taipei';

const HERE = dirname(fileURLToPath(import.meta.url));
const BARS = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'bars-300.json'), 'utf8'),
).bars;
const EXPECTED = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'expected-state.json'), 'utf8'),
);

const NOW = new Date('2026-09-21T12:00:00+08:00');
const snapshot = (bars = BARS) => ({
  symbol: 'BINANCE:BTCUSDT',
  resolution: '1',
  bars,
});

// ─────────────────────────────────────────────────────────────
// QUESTIONS 常數（§4.4 逐字）
// ─────────────────────────────────────────────────────────────

test('QUESTIONS: 三題 id 與 type 正確', () => {
  assert.deepEqual(Object.keys(QUESTIONS), [
    'direction',
    'up_10_bars',
    'trend_strength',
  ]);
  assert.equal(QUESTIONS.direction.type, 'choice');
  assert.equal(QUESTIONS.up_10_bars.type, 'noul');
  assert.equal(QUESTIONS.trend_strength.type, 'score');
});

test('QUESTIONS: direction criteria ⊇ long/neutral/short；trend_strength 五級', () => {
  const keys = Object.keys(QUESTIONS.direction.criteria);
  for (const k of ['long', 'neutral', 'short']) {
    assert.ok(keys.includes(k), `direction.criteria 應含 ${k}`);
  }
  assert.equal(QUESTIONS.trend_strength.criteria.length, 5);
  assert.deepEqual(QUESTIONS.trend_strength.criteria, [
    'none',
    'weak',
    'moderate',
    'strong',
    'very strong',
  ]);
  // instructions 必須使用反引號 `state`（§4.4）
  assert.match(QUESTIONS.direction.instructions, /`state`/);
  assert.equal(
    QUESTIONS.up_10_bars.instructions,
    'Will the close 10 bars from now be above the latest close?',
  );
});

// ─────────────────────────────────────────────────────────────
// golden state（§4.4 contract）
// ─────────────────────────────────────────────────────────────

test('golden: 300 根 BINANCE:BTCUSDT 1m 與 expected-state.json deepStrictEqual', () => {
  const state = buildState(snapshot(), { bars: 300, now: NOW });
  assert.deepStrictEqual(state, EXPECTED);
});

test('golden: features 為完整六鍵，且與 features.js 輸出逐值一致', () => {
  const state = buildState(snapshot(), { bars: 300, now: NOW });
  assert.deepEqual(Object.keys(state.features).sort(), [
    'lastClose',
    'ma20',
    'ma50',
    'momentumPct5',
    'rangePct20',
    'rsi14',
  ]);
  assert.deepStrictEqual(state.features, computeFeatures(BARS));
});

test('columns 為 protocol.BAR_COLUMNS 引用；generatedAt 為本地偏移 ISO 非 Z', () => {
  const state = buildState(snapshot(), { features: false, now: NOW });
  assert.equal(state.columns, BAR_COLUMNS);
  assert.equal(state.generatedAt, '2026-09-21T12:00:00+08:00');
  assert.equal(state.generatedAt.endsWith('Z'), false);
});

// ─────────────────────────────────────────────────────────────
// 特徵開關與視窗
// ─────────────────────────────────────────────────────────────

test('features:false → 無 features 鍵，bars 等於截尾輸入', () => {
  const state = buildState(snapshot(), { bars: 300, features: false, now: NOW });
  assert.equal('features' in state, false);
  assert.equal(state.barsWindow, 300);
  assert.deepEqual(state.bars, BARS);
});

test('bars:50 → barsWindow=50 且只剩最後 50 根', () => {
  const state = buildState(snapshot(), { bars: 50, features: false, now: NOW });
  assert.equal(state.barsWindow, 50);
  assert.deepEqual(state.bars, BARS.slice(-50));
  assert.deepEqual(state.bars[0], BARS[250]);
  assert.deepEqual(state.bars[49], BARS[299]);
});

test('snapshot 僅 10 根 → barsWindow=10（不足不補）', () => {
  const state = buildState(snapshot(BARS.slice(0, 10)), {
    bars: 300,
    features: false,
    now: NOW,
  });
  assert.equal(state.barsWindow, 10);
  assert.equal(state.bars.length, 10);
});

// ─────────────────────────────────────────────────────────────
// token 估算與防呆
// ─────────────────────────────────────────────────────────────

test('estimateTokens(golden) > 1000 且為整數', () => {
  const tokens = estimateTokens(EXPECTED);
  assert.ok(Number.isInteger(tokens), `tokens 應為整數，得到 ${tokens}`);
  assert.ok(tokens > 1000, `tokens=${tokens} 應 > 1000`);
});

test('空 bars 或缺 bars → 拋 Error(empty bars)', () => {
  assert.throws(() => buildState({ symbol: 'X', resolution: '1', bars: [] }), /empty bars/);
  assert.throws(() => buildState({ symbol: 'X', resolution: '1' }), /empty bars/);
  assert.throws(() => buildState(), /empty bars/);
});

test('欄位數非 6 的根被過濾並產生 warnings；正常時無 warnings 鍵', () => {
  const bad = [...BARS, [BARS[299][0] + 60, 1, 2, 3, 4]]; // 尾根僅 5 欄
  const state = buildState(snapshot(bad), {
    bars: 300,
    features: false,
    now: NOW,
  });
  assert.equal(state.bars.length, 300);
  assert.equal(state.barsWindow, 300);
  assert.deepEqual(state.bars, BARS);
  assert.ok(Array.isArray(state.warnings));
  assert.equal(state.warnings.length, 1);
  assert.equal(state.warnings[0].includes('bar[300]'), true);

  assert.equal('warnings' in buildState(snapshot(), { now: NOW }), false);
});
