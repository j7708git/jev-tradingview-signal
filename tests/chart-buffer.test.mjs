import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChartBuffer } from '../extension/lib/chart-buffer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'bars-300.json'), 'utf8'),
);
const BARS = fixture.bars;

test('fixture 有 300 根 6 欄真實 bar', () => {
  assert.equal(BARS.length, 300);
  for (const b of BARS) {
    assert.equal(Array.isArray(b), true);
    assert.equal(b.length, 6);
  }
});

test('upsertBars 300 根後 count=300', () => {
  const buf = new ChartBuffer(3000);
  const written = buf.upsertBars(BARS);
  assert.equal(written, 300);
  assert.equal(buf.count, 300);
});

test('重複 upsert 不膨脹', () => {
  const buf = new ChartBuffer(3000);
  buf.upsertBars(BARS);
  buf.upsertBars(BARS);
  buf.upsertBars(BARS);
  assert.equal(buf.count, 300);

  const snap = buf.snapshot();
  assert.equal(snap.length, 300);
  assert.deepEqual(snap[0], BARS[0]);
  assert.deepEqual(snap[299], BARS[299]);
});

test('同 time 覆寫生效（改 close 後 snapshot 最後一根為新值）', () => {
  const buf = new ChartBuffer(3000);
  buf.upsertBars(BARS);

  const last = BARS[299].slice();
  last[4] = 999999.5; // close
  buf.upsertBars([last]);

  assert.equal(buf.count, 300);
  const snap = buf.snapshot();
  assert.equal(snap.length, 300);
  assert.equal(snap[299][0], BARS[299][0]);
  assert.equal(snap[299][4], 999999.5);
});

test('snapshot(50) 取最近 50 根且 time 升冪', () => {
  const buf = new ChartBuffer(3000);
  buf.upsertBars(BARS);

  const snap = buf.snapshot(50);
  assert.equal(snap.length, 50);
  assert.deepEqual(snap[0], BARS[250]);
  assert.deepEqual(snap[49], BARS[299]);
  for (let i = 1; i < snap.length; i += 1) {
    assert.ok(snap[i][0] > snap[i - 1][0], `time 應升冪 @${i}`);
  }

  // bars(n) 與 snapshot(n) 同義
  assert.deepEqual(buf.bars(50), snap);
});

test('maxBars=100 灌 300 根 → count=100、dropped=200、firstTime=第 201 根', () => {
  const buf = new ChartBuffer(100);
  buf.upsertBars(BARS);

  assert.equal(buf.count, 100);
  const meta = buf.meta();
  assert.equal(meta.count, 100);
  assert.equal(meta.dropped, 200);
  assert.equal(meta.firstTime, BARS[200][0]);
  assert.equal(meta.lastTime, BARS[299][0]);

  const snap = buf.snapshot();
  assert.equal(snap.length, 100);
  assert.deepEqual(snap[0], BARS[200]);
  assert.deepEqual(snap[99], BARS[299]);

  // 再灌新的一根，持續丟最舊、dropped 累計
  const extra = [BARS[299][0] + 60, 1, 2, 0.5, 1.5, 10];
  buf.upsertBars([extra]);
  assert.equal(buf.count, 100);
  assert.equal(buf.meta().dropped, 201);
  assert.equal(buf.meta().lastTime, extra[0]);
});

test('reset 後 count=0 且 meta 歸零', () => {
  const buf = new ChartBuffer(3000);
  buf.upsertBars(BARS);
  assert.equal(buf.count, 300);

  buf.reset();
  assert.equal(buf.count, 0);
  assert.deepEqual(buf.snapshot(10), []);

  const meta = buf.meta();
  assert.equal(meta.count, 0);
  assert.equal(meta.firstTime, null);
  assert.equal(meta.lastTime, null);
  assert.equal(meta.dropped, 0);
});
