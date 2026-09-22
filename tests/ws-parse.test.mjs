import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib 為 classic-script 雙相容（無 ESM export，符號掛在 globalThis）；此處以 side-effect 載入後取用。
import '../extension/lib/ws-parse.js';

const { parseFrames, classifyPayload, parseCreateStudy, parseDuStudies } =
  globalThis;

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));

const evidence = fixture('ws-evidence-btc-1m.json');
const expected = fixture('bars-btc-1m-300.json');
const FIXTURE_BARS = expected.bars;

/** 依 socket.io 分幀規則把 payload 物件包成 raw frame。 */
function frameText(payloadObj) {
  const body = JSON.stringify(payloadObj);
  return `~m~${body.length}~m~${body}`;
}

/** 由證據幀還原成真實 socket.io payload `{m, p}`。 */
function evidencePayload(frame) {
  // 證據包把 du 的 body 收在 `b`、cid 獨立；tsu 的完整 p 陣列在 `p`。
  if (frame.m === 'du') return { m: 'du', p: [frame.cid, frame.b] };
  return { m: frame.m, p: frame.p };
}

// ─────────────────────────────────────────────────────────────
// parseFrames：分幀、心跳、中斷尾幀
// ─────────────────────────────────────────────────────────────

test('parseFrames 解析單幀與多幀串接', () => {
  const a = frameText({ m: 'a', p: [1] });
  const b = frameText({ m: 'b', p: [2, 3] });

  assert.deepEqual(parseFrames(a), [JSON.stringify({ m: 'a', p: [1] })]);
  assert.deepEqual(parseFrames(a + b), [
    JSON.stringify({ m: 'a', p: [1] }),
    JSON.stringify({ m: 'b', p: [2, 3] }),
  ]);
});

test('parseFrames 丟棄心跳 `~h~<n>`', () => {
  assert.deepEqual(parseFrames('~h~5'), []);

  const a = frameText({ m: 'a', p: [1] });
  const b = frameText({ m: 'b', p: [2] });
  assert.deepEqual(parseFrames(a + '~h~5' + b), [
    JSON.stringify({ m: 'a', p: [1] }),
    JSON.stringify({ m: 'b', p: [2] }),
  ]);
});

test('parseFrames 丟棄中斷尾幀（len 超長）不拋錯', () => {
  const a = frameText({ m: 'a', p: [1] });
  assert.deepEqual(parseFrames(a + '~m~9999~m~{"m":'), [
    JSON.stringify({ m: 'a', p: [1] }),
  ]);
  assert.deepEqual(parseFrames('~m~'), []);
  assert.deepEqual(parseFrames('~m~abc~m~x'), []);
});

test('parseFrames 非 ~m~ 開頭回傳 []', () => {
  assert.deepEqual(parseFrames('{"m":"a"}'), []);
  assert.deepEqual(parseFrames(''), []);
  assert.deepEqual(parseFrames(undefined), []);
  assert.deepEqual(parseFrames(123), []);
});

// ─────────────────────────────────────────────────────────────
// classifPayload：直接單元
// ─────────────────────────────────────────────────────────────

test('classifyPayload: series_loading(sds_*) → reset 控制訊號', () => {
  const p = JSON.parse(evidence.frames.find((f) => f.m === 'series_loading').p);
  assert.deepEqual(classifyPayload({ m: 'series_loading', p }), {
    kind: 'control',
    action: 'reset',
    seriesKey: 'sds_1',
  });

  // 非 sds 開頭 → null
  assert.equal(classifyPayload({ m: 'series_loading', p: ['cid', 'x_1'] }), null);
});

test('classifyPayload: series_completed(sds_*) → streaming 控制訊號', () => {
  const p = JSON.parse(
    evidence.frames.find((f) => f.m === 'series_completed').p,
  );
  assert.deepEqual(classifyPayload({ m: 'series_completed', p }), {
    kind: 'control',
    action: 'streaming',
    seriesKey: 'sds_1',
  });
});

test('classifyPayload: symbol_resolved → meta symbol', () => {
  // 證據包 symbol_resolved 的 p 被截斷（1200 字），故以其中 full_name 重建完整 payload。
  const rawP = evidence.frames.find((f) => f.m === 'symbol_resolved').p;
  const symbol = /"full_name":"([^"]+)"/.exec(rawP)[1];
  assert.equal(symbol, 'BINANCE:BTCUSDT');

  const res = classifyPayload({
    m: 'symbol_resolved',
    p: ['cs_bqZ2Ww4OwPWV', 'sds_sym_1', { full_name: symbol }],
  });
  assert.deepEqual(res, {
    kind: 'meta',
    symbol: 'BINANCE:BTCUSDT',
    seriesRef: 'sds_sym_1',
  });

  // 無 full_name → null
  assert.equal(
    classifyPayload({ m: 'symbol_resolved', p: ['cid', 'k', {}] }),
    null,
  );
});

test('classifyPayload: symbol_resolved 帶 seriesRef（主圖 sds_sym_1 / 輔助 sds_sym_2 / study ss_1）', () => {
  assert.deepEqual(
    classifyPayload({
      m: 'symbol_resolved',
      p: ['cid', 'sds_sym_2', { full_name: 'INTERNAL:SEASONALS' }],
    }),
    { kind: 'meta', symbol: 'INTERNAL:SEASONALS', seriesRef: 'sds_sym_2' },
  );
  assert.deepEqual(
    classifyPayload({
      m: 'symbol_resolved',
      p: ['cid', 'ss_1', { full_name: 'BINANCE:SOLUSDT' }],
    }),
    { kind: 'meta', symbol: 'BINANCE:SOLUSDT', seriesRef: 'ss_1' },
  );
});

test('classifyPayload: timescale_update p[1]==={} → ignore（未來刻度排程）', () => {
  const empty = evidence.frames.filter(
    (f) => f.m === 'timescale_update' && f.p[1] && Object.keys(f.p[1]).length === 0,
  );
  assert.ok(empty.length >= 1, '證據應含未來刻度排程幀');

  assert.deepEqual(classifyPayload({ m: 'timescale_update', p: empty[0].p }), {
    kind: 'ignore',
    m: 'timescale_update',
  });
});

test('classifyPayload: du 只有 study 鍵 → ignore', () => {
  assert.deepEqual(
    classifyPayload({
      m: 'du',
      p: ['cs_x', { 'STD;RSIst': { st: [1, 2, 3] } }],
    }),
    { kind: 'ignore' },
  );
});

test('classifyPayload: 其餘型別 / 非 JSON / 無 m → null', () => {
  assert.equal(classifyPayload({ m: 'qsd', p: [] }), null);
  assert.equal(classifyPayload({ m: 'study_loading', p: [] }), null);
  assert.equal(classifyPayload('not json{'), null);
  assert.equal(classifyPayload({ p: [1, 2] }), null);
  assert.equal(classifyPayload(null), null);

  // meta 可補型別（裸 p 陣列）
  assert.deepEqual(
    classifyPayload(['cid', 'sds_9', 's1'], { m: 'series_loading' }),
    { kind: 'control', action: 'reset', seriesKey: 'sds_9' },
  );
});

// ─────────────────────────────────────────────────────────────
// 以真實 evidence 重組成 raw → parseFrames → classifyPayload
// ─────────────────────────────────────────────────────────────

test('ws-evidence-btc-1m: raw 重組還原 bars，與 bars-btc-1m-300 逐值一致', () => {
  const selected = evidence.frames.filter(
    (f) => f.m === 'timescale_update' || f.m === 'du',
  );
  const raw = selected.map((f) => frameText(evidencePayload(f))).join('');
  const payloads = parseFrames(raw);
  assert.equal(payloads.length, selected.length);

  const tsuBars = [];
  const duBars = [];
  let dropCount = 0;

  for (let i = 0; i < payloads.length; i += 1) {
    const res = classifyPayload(payloads[i]);
    if (res === null) continue;
    if (res.kind === 'ignore') {
      dropCount += 1;
      continue;
    }
    assert.equal(res.kind, 'bars');
    assert.equal(res.seriesKey, 'sds_1');
    if (selected[i].m === 'timescale_update') tsuBars.push(...res.bars);
    else duBars.push(...res.bars);
  }

  // 還原出的歷史快照（tsu）＝ fixtures，逐值一致
  assert.equal(tsuBars.length, 300);
  assert.deepEqual(tsuBars, FIXTURE_BARS);

  // du 尾根 ＋ 新 bar
  assert.ok(duBars.length > 0);

  // 類比 ChartBuffer：tsu 整段 → du 覆寫尾根 / 追加新根
  const stream = new Map();
  for (const b of tsuBars) stream.set(b[0], b);
  for (const b of duBars) stream.set(b[0], b);

  // 歷史快照（first-seen）與 fixtures 取 time 交集逐值比對
  const snapshotFirstSeen = new Map();
  for (const b of tsuBars) snapshotFirstSeen.set(b[0], b);
  for (const b of duBars) {
    if (!snapshotFirstSeen.has(b[0])) snapshotFirstSeen.set(b[0], b);
  }
  assert.ok(snapshotFirstSeen.size >= 295);
  for (const expectedBar of FIXTURE_BARS) {
    const got = snapshotFirstSeen.get(expectedBar[0]);
    assert.ok(got, `time ${expectedBar[0]} 應存在`);
    assert.deepEqual(got, expectedBar);
  }

  // upsert 後的串流：根數、欄位序、time 單調遞增
  assert.ok(stream.size >= 295, `stream size ${stream.size}`);
  const times = [...stream.keys()].sort((a, b) => a - b);
  for (let i = 0; i < times.length; i += 1) {
    const bar = stream.get(times[i]);
    assert.equal(bar.length, 6);
    assert.equal(bar[0], times[i]);
    if (i > 0) assert.ok(bar[0] > times[i - 1], 'time 應嚴格遞增');
  }

  // du 確實覆寫了 tsu 尾根，且追加了 tsu 之後的新根
  const tsuLastTime = FIXTURE_BARS[FIXTURE_BARS.length - 1][0];
  assert.notDeepEqual(stream.get(tsuLastTime), FIXTURE_BARS[FIXTURE_BARS.length - 1]);
  assert.ok(stream.size === FIXTURE_BARS.length + 1);
  assert.ok(dropCount >= 1, '未來刻度 tsu 應被丟棄計數');
});

// ─────────────────────────────────────────────────────────────
// Task 13／§4.2.2：study 解析（真實 fixture ws-studies-real.txt）
// ─────────────────────────────────────────────────────────────

const STUDIES_RAW = readFileSync(
  join(HERE, 'fixtures', 'ws-studies-real.txt'),
  'utf8',
);
const STUDIES_LINES = STUDIES_RAW.split(/\r?\n/).filter(Boolean);

/** fixture 每行格式 `SEND {json}` / `RECV {json}`。 */
function studyLines() {
  return STUDIES_LINES.map((line) => ({
    dir: line.slice(0, 4),
    obj: JSON.parse(line.slice(5)),
  }));
}

test('parseCreateStudy: Pine 型取 pineId＋in_*，text/pineFeatures/__* 全排除', () => {
  const line = studyLines().find(
    (l) => l.dir === 'SEND' && l.obj.p && l.obj.p[1] === '51IoAU',
  );
  assert.ok(line, 'fixture 應含 51IoAU 的 create_study');

  const res = parseCreateStudy(JSON.stringify(line.obj)); // JSON 字串亦可
  assert.equal(res.kind, 'study_meta');
  assert.equal(res.studyId, '51IoAU');
  assert.equal(res.meta.pineId, 'STD;Arnaud%1Legoux%1Moving%1Average');
  assert.equal(res.meta.scriptName, 'Script@tv-scripting-101!');
  assert.deepEqual(res.meta.params, {
    in_0: 25,
    in_1: 0.85,
    in_2: 6,
    in_3: '',
    in_4: true,
  });
  assert.equal('text' in res.meta, false, '加密 text 不得進 meta');
  assert.equal('pineFeatures' in res.meta, false);
  assert.equal('__fast_calc' in res.meta, false);
  assert.equal('__profile' in res.meta, false);
  assert.equal(JSON.stringify(res.meta).includes('bmI9Ks46'), false);
});

test('parseCreateStudy: 直給型取具名參數（Volume length/col_prev_close）', () => {
  const line = studyLines().find(
    (l) => l.dir === 'SEND' && l.obj.p && l.obj.p[1] === '9Hn5lT',
  );
  const res = parseCreateStudy(line.obj);
  assert.equal(res.studyId, '9Hn5lT');
  assert.equal(res.meta.pineId, undefined);
  assert.equal(res.meta.scriptName, 'Volume@tv-basicstudies-277');
  assert.deepEqual(res.meta.params, { length: 20, col_prev_close: false });
});

test('parseCreateStudy: 非 create_study／缺 studyId／壞 JSON → null', () => {
  assert.equal(parseCreateStudy({ m: 'du', p: [] }), null);
  assert.equal(parseCreateStudy({ m: 'create_study', p: ['c'] }), null);
  assert.equal(parseCreateStudy({ m: 'create_study', p: ['c', 42] }), null);
  assert.equal(parseCreateStudy('not json{'), null);
  assert.equal(parseCreateStudy(null), null);
});

test('parseDuStudies: 忽略 i（負 sentinel）並以 time 為 key；同 time 尾根覆寫', () => {
  const obj = {
    m: 'du',
    p: [
      'cs',
      {
        '51IoAU': {
          st: [
            { i: -1000100, v: [1000, 1] },
            { i: -1000099, v: [2000, 2] },
            { trimmed: 396 },
            { i: 298, v: [2000, 3] },
            { i: 299, v: [3000, 4] },
          ],
        },
      },
    ],
  };

  const out = parseDuStudies(JSON.stringify(obj)); // payload JSON 字串
  assert.equal(out.length, 1);
  assert.equal(out[0].studyId, '51IoAU');
  assert.deepEqual(out[0].rows, [
    [1000, 1],
    [2000, 2],
    [2000, 3],
    [3000, 4],
  ]);

  const byTime = new Map(out[0].rows.map((r) => [r[0], r[1]]));
  assert.equal(byTime.get(2000), 3, '同 time 以最後一筆覆寫');
});

test('parseDuStudies: st 空／只有 trimmed／只有 time 無值 → 自動排除；sds 鍵不處理', () => {
  assert.equal(parseDuStudies({ m: 'du', p: ['c', { a: { st: [] } }] }), null);
  assert.equal(
    parseDuStudies({ m: 'du', p: ['c', { a: { st: [{ trimmed: 5 }] } }] }),
    null,
  );
  assert.equal(
    parseDuStudies({ m: 'du', p: ['c', { a: { st: [{ i: 0, v: [1] }] } }] }),
    null,
  );
  assert.equal(
    parseDuStudies({
      m: 'du',
      p: ['c', { sds_1: { s: [{ i: 0, v: [1, 2, 3, 4, 5, 6] }] } }],
    }),
    null,
  );
  assert.equal(parseDuStudies({ m: 'timescale_update', p: ['c', {}] }), null);
  assert.equal(parseDuStudies('nope{'), null);
});

test('ws-studies-real: 7 個 create_study 全解析；BarSet(yl9zbk) 無 st 值自動排除', () => {
  const metas = new Map();
  const series = new Map();

  for (const { dir, obj } of studyLines()) {
    if (dir === 'SEND') {
      const m = parseCreateStudy(obj);
      if (m) metas.set(m.studyId, m.meta);
    } else {
      const list = parseDuStudies(obj);
      if (!list) continue;
      for (const e of list) {
        const s = series.get(e.studyId) || new Map();
        for (const r of e.rows) s.set(r[0], r.slice(1));
        series.set(e.studyId, s);
      }
    }
  }

  assert.equal(metas.size, 7, '7 個 create_study 皆解析出 meta');
  assert.equal(series.size, 6, '只有 6 個 study 有逐根 st 值');
  assert.equal(series.has('yl9zbk'), false, 'BarSet 無 st 值 → 排除');

  // VRVP（xKKeY2）只取 st 數值（3 欄），不含 ns graphics blob。
  assert.ok(
    [...series.get('xKKeY2').values()].every(
      (v) => Array.isArray(v) && v.length === 3,
    ),
    'VRVP st 值為 3 欄，ns/圖形指令不得混入',
  );
  assert.equal(series.get('xKKeY2').size, 4);

  // ALMA25 尾根覆寫：最後一筆 i=299 的值為最終值。
  assert.equal(series.get('51IoAU').get(1790051400)[0], 85623.68789247931);
  assert.equal(series.get('uNfUeE').size, 4);
  assert.equal(series.get('9Hn5lT').size, 4);
});

test('§4.2.2 redact：parseCreateStudy meta 不含 text（加密 blob）任何片段', () => {
  const line = studyLines().find(
    (l) => l.dir === 'SEND' && l.obj.p && l.obj.p[1] === 'uNfUeE',
  );
  const res = parseCreateStudy(line.obj);
  const textBlob = line.obj.p[5].text;
  assert.ok(textBlob && textBlob.length > 20);
  assert.equal(JSON.stringify(res.meta).includes(textBlob.slice(0, 24)), false);
  assert.equal('text' in res.meta, false);
});
