import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sma,
  rsiWilder,
  momentumPct,
  rangePct,
  computeFeatures,
} from '../extension/lib/features.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BARS = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'bars-btc-1m-300.json'), 'utf8'),
).bars;

const mean = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
const approx = (got, want, tol = 1e-9) =>
  assert.ok(Math.abs(got - want) <= tol, `${got} != ${want} (±${tol})`);

// ─────────────────────────────────────────────────────────────
// Wilder RSI：教科書序列（StockCharts 經典 14 期上升/下降表）
// ─────────────────────────────────────────────────────────────

// 首 14 個差值均溫後，RSI ≈ 70.5；其後數值續在高檔（66–70）盤旋。
const TEXTBOOK_CLOSES = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245,
  45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028,
  46.0328, 46.4116, 46.2222, 45.6439,
];

test('rsiWilder: 教科書序列首個 RSI ≈70.5', () => {
  const rsi = rsiWilder(TEXTBOOK_CLOSES, 14);
  assert.equal(rsi.length, TEXTBOOK_CLOSES.length - 14);
  assert.ok(Math.abs(rsi[0] - 70.46) <= 0.5, `first RSI = ${rsi[0]}`);
});

test('rsiWilder: 後續數值收斂在 65–75 區間', () => {
  const rsi = rsiWilder(TEXTBOOK_CLOSES, 14);
  // rsi[1..4] 對應 66.3 / 66.5 / 69.4 / 66.4（第 5 個後遇到大跌才跌破 65）。
  for (const v of rsi.slice(1, 5)) {
    assert.ok(v >= 65 && v <= 75, `RSI ${v} 應落在 65–75`);
  }
});

test('rsiWilder: 全升 → 100，全跌 → 0', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);

  const rsiUp = rsiWilder(up, 14);
  const rsiDown = rsiWilder(down, 14);
  assert.equal(rsiUp.every((v) => v === 100), true);
  assert.equal(rsiDown.every((v) => v === 0), true);
});

// ─────────────────────────────────────────────────────────────
// bars-btc-1m-300 全 300 根：與手算一致
// ─────────────────────────────────────────────────────────────

test('sma: 最近 period 筆平均；不足回 null', () => {
  approx(sma([1, 2, 3, 4], 2), 3.5);
  approx(sma([1, 2, 3, 4], 4), 2.5);
  assert.equal(sma([1, 2, 3], 5), null);
  assert.equal(sma([], 1), null);
  assert.equal(sma(null, 3), null);
  assert.equal(sma([1, 2, 3], 0), null);
});

test('momentumPct: (last/base − 1)×100；不足回 null', () => {
  approx(momentumPct([10, 11, 12, 13, 14, 15], 5), 50);
  assert.equal(momentumPct([1, 2, 3], 5), null);
  assert.equal(momentumPct(null, 5), null);
});

test('rangePct: (maxHigh − minLow)/lastClose×100；不足回 null', () => {
  const bars = [
    [0, 1, 10, 0, 8, 0],
    [60, 1, 20, 4, 9, 0],
    [120, 1, 12, 6, 10, 0],
  ];
  approx(rangePct(bars, 3), ((20 - 0) / 10) * 100);
  approx(rangePct(bars, 2), ((20 - 4) / 10) * 100);
  assert.equal(rangePct(bars, 10), null);
  assert.equal(rangePct(null, 20), null);
});

test('computeFeatures: 300 根 BTC 1m 與手算逐項一致', () => {
  const closes = BARS.map((b) => b[4]);
  const f = computeFeatures(BARS);

  approx(f.ma20, mean(closes.slice(-20)));
  approx(f.ma50, mean(closes.slice(-50)));
  approx(f.momentumPct5, (closes[closes.length - 1] / closes[closes.length - 1 - 5] - 1) * 100);
  assert.equal(f.lastClose, closes[closes.length - 1]);

  assert.ok(f.rsi14 > 0 && f.rsi14 < 100, `rsi14 = ${f.rsi14}`);
  assert.ok(Number.isFinite(f.rsi14));

  const win = BARS.slice(-20);
  const hi = Math.max(...win.map((b) => b[2]));
  const lo = Math.min(...win.map((b) => b[3]));
  approx(f.rangePct20, ((hi - lo) / closes[closes.length - 1]) * 100);
});

test('computeFeatures: 資料不足（10 根）回 null 欄位而非拋錯', () => {
  let f;
  assert.doesNotThrow(() => {
    f = computeFeatures(BARS.slice(0, 10));
  });
  assert.equal(f.ma20, null);
  assert.equal(f.ma50, null);
  assert.equal(f.rsi14, null);
  assert.equal(f.rangePct20, null);
  assert.ok(Number.isFinite(f.momentumPct5)); // lookback 5 足夠
  assert.ok(Number.isFinite(f.lastClose));
});

test('computeFeatures: 空 / 非法輸入不拋錯且欄位全 null', () => {
  for (const bad of [null, undefined, [], 'nope']) {
    let f;
    assert.doesNotThrow(() => {
      f = computeFeatures(bad);
    });
    assert.deepEqual(f, {
      ma20: null,
      ma50: null,
      rsi14: null,
      momentumPct5: null,
      rangePct20: null,
      lastClose: null,
    });
  }
});
