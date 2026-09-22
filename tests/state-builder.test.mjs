import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QUESTIONS,
  buildState,
  buildStudies,
  normalizeStudyExclude,
  estimateTokens,
  fitStateToBudget,
  INPUT_BUDGET_CHARS,
} from '../extension/lib/state-builder.js';
import '../extension/lib/protocol.js';
// protocol.js 為 classic-script 雙相容（無 ESM export）；符號掛在 globalThis。
const { BAR_COLUMNS } = globalThis;
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

test('QUESTIONS: 四題 id 與 type 正確（trend_strength 已由 bull/bear 取代）', () => {
  assert.deepEqual(Object.keys(QUESTIONS), [
    'direction',
    'up_10_bars',
    'bull_trend',
    'bear_trend',
  ]);
  assert.equal(QUESTIONS.direction.type, 'choice');
  assert.equal(QUESTIONS.up_10_bars.type, 'noul');
  assert.equal(QUESTIONS.bull_trend.type, 'score');
  assert.equal(QUESTIONS.bear_trend.type, 'score');
  assert.equal('trend_strength' in QUESTIONS, false);
});

test('QUESTIONS: bull_trend/bear_trend 五級且題字逐字對齊 §4.4', () => {
  const keys = Object.keys(QUESTIONS.direction.criteria);
  for (const k of ['long', 'neutral', 'short']) {
    assert.ok(keys.includes(k), `direction.criteria 應含 ${k}`);
  }
  const LEVELS = ['none', 'weak', 'moderate', 'strong', 'very strong'];
  for (const id of ['bull_trend', 'bear_trend']) {
    assert.equal(QUESTIONS[id].type, 'score');
    assert.equal(QUESTIONS[id].criteria.length, 5);
    assert.deepEqual(QUESTIONS[id].criteria, LEVELS);
  }
  assert.equal(
    QUESTIONS.bull_trend.instructions,
    'How strong is the bullish (upward) pressure in this series right now, judged from the recent candles and the derived features?',
  );
  assert.equal(
    QUESTIONS.bear_trend.instructions,
    'How strong is the bearish (downward) pressure in this series right now, judged from the recent candles and the derived features?',
  );
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

// ─────────────────────────────────────────────────────────────
// Task 13／§4.4：buildStudies（state.studies 陣列）
// ─────────────────────────────────────────────────────────────

function studyRec(meta, entries) {
  return { meta, series: new Map(entries) };
}

const ALMA_META = {
  scriptName: 'Script@tv-scripting-101!',
  pineId: 'STD;Arnaud%1Legoux%1Moving%1Average',
  params: { in_0: 25, in_1: 0.85, in_2: 6 },
};

test('buildStudies: 與 bars 窗口逐根對齊，缺值根補 null，columns 通用 v1..', () => {
  const bars = [
    [1000, 1, 1, 1, 1, 1],
    [1060, 2, 2, 2, 2, 2],
    [1120, 3, 3, 3, 3, 3],
  ];
  const studies = new Map([
    ['51IoAU', studyRec(ALMA_META, [[1000, [1.5]], [1120, [3.5]]])],
  ]);

  const out = buildStudies(studies, { bars });
  assert.equal(out.length, 1);
  const s = out[0];
  assert.equal(s.id, '51IoAU');
  assert.equal(s.rawName, 'Arnaud Legoux Moving Average');
  assert.equal(s.name, 'ALMA(25)');
  assert.deepEqual(s.params, { in_0: 25, in_1: 0.85, in_2: 6 });
  assert.deepEqual(s.columns, ['time', 'v1']);
  assert.deepEqual(s.values, [[1000, 1.5], null, [1120, 3.5]]);
});

test('buildStudies: nameMap 覆寫優先；rawName 仍保留自動全名', () => {
  const bars = [[1000, 1, 1, 1, 1, 1]];
  const studies = new Map([
    ['51IoAU', studyRec(ALMA_META, [[1000, [9]]])],
  ]);
  const out = buildStudies(studies, {
    bars,
    nameMap: { '51IoAU': '我的自訂均線' },
  });
  assert.equal(out[0].name, '我的自訂均線');
  assert.equal(out[0].rawName, 'Arnaud Legoux Moving Average');
});

test('buildStudies: fallback 鏈 — Pine 縮寫＋首參數；直給型用 scriptName', () => {
  const bars = [[1000, 1, 1, 1, 1, 1]];
  const studies = new Map([
    [
      'a',
      studyRec(
        { pineId: 'STD;Arnaud%1Legoux%1Moving%1Average', params: { in_0: 90 } },
        [[1000, [1]]],
      ),
    ],
    [
      'b',
      studyRec(
        { scriptName: 'Volume@tv-basicstudies-277', params: { length: 20 } },
        [[1000, [2]]],
      ),
    ],
    ['c', studyRec({ pineId: 'STD;Bollinger_Bands', params: { in_0: 30 } }, [[1000, [3]]])],
  ]);

  const out = buildStudies(studies, { bars });
  const byId = Object.fromEntries(out.map((s) => [s.id, s]));
  assert.equal(byId.a.name, 'ALMA(90)');
  assert.equal(byId.b.name, 'Volume(20)');
  assert.equal(byId.c.name, 'BB(30)');
  assert.equal(byId.b.rawName, 'Volume');
});

test('buildStudies: 縮寫優先取首個數值參數（字串來源在前也一樣）', () => {
  const bars = [[1000, 1, 1, 1, 1, 1]];
  const studies = new Map([
    [
      'x',
      studyRec(
        { scriptName: 'X', params: { source: 'close', length: 14 } },
        [[1000, [1]]],
      ),
    ],
  ]);
  const out = buildStudies(studies, { bars });
  assert.equal(out[0].name, 'X(14)');
});

test('buildStudies: 多值指標 columns v1..v3，短列補 null', () => {
  const bars = [
    [1000, 1, 1, 1, 1, 1],
    [1060, 2, 2, 2, 2, 2],
  ];
  const studies = new Map([
    [
      'bb',
      studyRec(
        { pineId: 'STD;Bollinger_Bands', params: { in_0: 30 } },
        [
          [1000, [1, 2, 3]],
          [1060, [4]], // 罕見短列 → 補 null
        ],
      ),
    ],
  ]);
  const out = buildStudies(studies, { bars });
  assert.deepEqual(out[0].columns, ['time', 'v1', 'v2', 'v3']);
  assert.deepEqual(out[0].values, [
    [1000, 1, 2, 3],
    [1060, 4, null, null],
  ]);
});

test('buildStudies: 未掛指標／空序列 → []，且不拋錯', () => {
  assert.deepEqual(buildStudies(new Map(), { bars: [] }), []);
  assert.deepEqual(buildStudies(undefined), []);
  assert.deepEqual(buildStudies(null, {}), []);
  assert.deepEqual(
    buildStudies(new Map([['x', studyRec({}, [])]]), {
      bars: [[1, 1, 1, 1, 1, 1]],
    }),
    [],
  );
  // 壞型別也不炸
  assert.deepEqual(buildStudies(42, { bars: null }), []);
});

test('buildStudies: 同窗口缺值根補 null（與 state.bars 窗口逐位對齊）', () => {
  const state = buildState(snapshot(), { bars: 50, features: false, now: NOW });
  const times = state.bars.map((b) => b[0]);
  const studies = new Map([
    ['s', studyRec({ scriptName: 'X' }, [[times[49], [7]]])],
  ]);
  const out = buildStudies(studies, { bars: state.bars });
  assert.equal(out[0].values.length, 50);
  assert.deepEqual(out[0].values[49], [times[49], 7]);
  for (let i = 0; i < 49; i += 1) assert.equal(out[0].values[i], null);
});

// ─────────────────────────────────────────────────────────────
// Task 15／F11：buildStudies opts.exclude（被排除者不進 payload）
// ─────────────────────────────────────────────────────────────

test('Task15 buildStudies: exclude（陣列/Set）過濾被排除者，其餘零改動；全排除→[]', () => {
  const bars = [
    [1000, 1, 1, 1, 1, 1],
    [1060, 2, 2, 2, 2, 2],
    [1120, 3, 3, 3, 3, 3],
  ];
  const studies = new Map([
    ['a', studyRec({ scriptName: 'A@x', params: { length: 10 } }, [[1000, [1]], [1120, [3]]])],
    ['b', studyRec({ scriptName: 'B@x', params: { length: 20 } }, [[1000, [2]], [1120, [4]]])],
    ['c', studyRec({ scriptName: 'C@x', params: { length: 30 } }, [[1060, [5]]])],
  ]);
  const base = buildStudies(studies, { bars });
  assert.equal(base.length, 3);

  const arr = buildStudies(studies, { bars, exclude: ['b'] });
  assert.deepEqual(arr.map((s) => s.id), ['a', 'c']);
  assert.deepEqual(arr[0], base.find((s) => s.id === 'a'), '未排除者逐位元不變');
  assert.deepEqual(arr[1], base.find((s) => s.id === 'c'), '未排除者逐位元不變');

  const set = buildStudies(studies, { bars, exclude: new Set(['a', 'c']) });
  assert.deepEqual(set.map((s) => s.id), ['b']);

  // 全部排除＝studies:[]（同未掛指標語意）。
  assert.deepEqual(buildStudies(studies, { bars, exclude: ['a', 'b', 'c'] }), []);
  assert.deepEqual(buildStudies(studies, { bars, exclude: new Set(['a', 'b', 'c']) }), []);

  // 未傳 exclude／空集／壞型別 → 與基準逐位元相同（零回歸）。
  const before = JSON.stringify(base);
  for (const ex of [undefined, null, [], new Set(), 42, 'b', { b: true }, ['a', 5]]) {
    const out = buildStudies(studies, { bars, exclude: ex });
    assert.equal(JSON.stringify(out), before, `exclude=${String(ex)} 應零改動（壞型別）`);
  }

  // 重複 id 去重不影響結果。
  assert.deepEqual(
    buildStudies(studies, { bars, exclude: ['b', 'b', 'b'] }).map((s) => s.id),
    ['a', 'c'],
  );
});

test('Task15 normalizeStudyExclude：非陣列/Set、含非字串→[]；去重、略過空字串', () => {
  assert.deepEqual(normalizeStudyExclude(['a', 'a', 'b', '']), ['a', 'b']);
  assert.deepEqual(normalizeStudyExclude(new Set(['a', 'a', 'b'])), ['a', 'b']);
  assert.deepEqual(normalizeStudyExclude(['a', 5]), [], '含非字串→[]');
  assert.deepEqual(normalizeStudyExclude(new Set(['a', 5])), [], 'Set 含非字串→[]');
  assert.deepEqual(normalizeStudyExclude('a'), []);
  assert.deepEqual(normalizeStudyExclude({ a: 1 }), []);
  assert.deepEqual(normalizeStudyExclude(null), []);
  assert.deepEqual(normalizeStudyExclude(undefined), []);
});

// ─────────────────────────────────────────────────────────────
// Task 14fix：fitStateToBudget 輸入預算守門
// ─────────────────────────────────────────────────────────────

/** 完整 systemone 請求字元長度（與 state-builder 內部量測同構）。 */
function payloadLen(state) {
  return JSON.stringify({ model: 'jev-latest', state, questions: QUESTIONS }).length;
}

/** n 個全窗（300 根）study 的 Map，每根帶一個值。 */
function fullStudiesMap(n) {
  const map = new Map();
  for (let i = 0; i < n; i += 1) {
    const entries = BARS.map((b, idx) => [b[0], [100 + i + idx * 0.5]]);
    map.set(
      `sid${i}`,
      studyRec(
        { scriptName: `Study${i}@tv-scripting-101!`, params: { length: 10 + i } },
        entries,
      ),
    );
  }
  return map;
}

function withStudies(state, nStudies, nameMap) {
  state.studies = buildStudies(fullStudiesMap(nStudies), {
    bars: state.bars,
    nameMap,
  });
  return state;
}

test('fitStateToBudget: 未超標 → 同一物件、JSON 逐位元不變、無 studiesTrimmed', () => {
  const state = withStudies(
    buildState(snapshot(), { bars: 50, features: true, now: NOW }),
    1,
    { sid0: '自訂' },
  );
  assert.ok(payloadLen(state) <= INPUT_BUDGET_CHARS, '前置：必須未超標');
  const before = JSON.stringify(state);
  const out = fitStateToBudget(state);
  assert.equal(out, state, '未超標須回傳同一 state 物件');
  assert.equal(JSON.stringify(out), before, '逐位元不變');
  assert.equal('studiesTrimmed' in out, false);
});

test('fitStateToBudget: 9 studies×300 → 尾端裁窗、整包 ≤ 預算、尾列最新、names/params 保留', () => {
  const state = withStudies(
    buildState(snapshot(), { bars: 300, features: false, now: NOW }),
    9,
    { sid0: '自訂0' },
  );
  assert.ok(payloadLen(state) > INPUT_BUDGET_CHARS, '前置：必須超標');
  const beforeLast = state.studies.map((s) => s.values[s.values.length - 1]);

  const out = fitStateToBudget(state);
  assert.equal(out, state);
  assert.ok(payloadLen(out) <= INPUT_BUDGET_CHARS, '裁後整包須 ≤ 預算');
  assert.ok(Number.isInteger(out.studiesTrimmed));
  const k = out.studiesTrimmed;
  assert.ok(k >= 0 && k < 300, `K 須落在 [0,300)，得到 ${k}`);
  for (const s of out.studies) assert.equal(s.values.length, k, '每 study 相同 K');
  // 尾列為最新列（time 自帶、對齊語意不變）。
  out.studies.forEach((s, i) => {
    assert.deepEqual(s.values[s.values.length - 1], beforeLast[i]);
  });
  // 身分欄位不受裁剪影響。
  assert.equal(out.studies[0].name, '自訂0');
  assert.deepEqual(out.studies[0].params, { length: 10 });
  assert.equal(out.studies[0].rawName, 'Study0');
  assert.deepEqual(out.studies[0].columns, ['time', 'v1']);

  // 確定性：同輸入同輸出（重建後再跑一次）。
  const state2 = withStudies(
    buildState(snapshot(), { bars: 300, features: false, now: NOW }),
    9,
    { sid0: '自訂0' },
  );
  assert.equal(fitStateToBudget(state2).studiesTrimmed, k);
});

test('fitStateToBudget: K=0 降級 → values: [] 但 id/name/params/columns 保留', () => {
  const state = withStudies(
    buildState(snapshot(), { bars: 300, features: false, now: NOW }),
    3,
    { sid1: '自訂1' },
  );
  const clearLen = payloadLen({
    ...state,
    studies: state.studies.map((s) => ({ ...s, values: [] })),
    studiesTrimmed: 0,
  });
  const oneLen = payloadLen({
    ...state,
    studies: state.studies.map((s) => ({ ...s, values: s.values.slice(-1) })),
    studiesTrimmed: 1,
  });
  const budget = oneLen - 1; // 清空可行、留 1 列不可行
  assert.ok(clearLen <= budget, `clearLen=${clearLen} 應 ≤ budget=${budget}`);
  assert.ok(oneLen > budget, `oneLen=${oneLen} 應 > budget=${budget}`);

  const out = fitStateToBudget(state, { budgetChars: budget });
  assert.equal(out.studiesTrimmed, 0);
  for (const s of out.studies) {
    assert.deepEqual(s.values, []);
    assert.equal(typeof s.id, 'string');
    assert.equal(typeof s.rawName, 'string');
    assert.deepEqual(s.columns, ['time', 'v1']);
  }
  assert.equal(out.studies[1].name, '自訂1');
  assert.deepEqual(out.studies[0].params, { length: 10 });
});

test('fitStateToBudget: bars+questions 本身即超預算 → 原樣回傳、不動 bars', () => {
  const state = withStudies(
    buildState(snapshot(), { bars: 300, features: false, now: NOW }),
    1,
  );
  const before = JSON.stringify(state);
  const out = fitStateToBudget(state, { budgetChars: 100 });
  assert.equal(out, state);
  assert.equal(JSON.stringify(out), before);
  assert.equal('studiesTrimmed' in out, false);
  assert.deepEqual(out.bars, state.bars);
  assert.equal(out.studies[0].values.length, 300, 'studies 亦不動');
});

test('fitStateToBudget: 無 studies 可裁時原樣回傳；budgetChars 可注入', () => {
  const state = buildState(snapshot(), { bars: 300, features: false, now: NOW });
  const before = JSON.stringify(state);
  assert.equal(fitStateToBudget(state), state);
  assert.equal(JSON.stringify(state), before);

  // 注入極小預算：仍不能憑空縮 bars → 原樣。
  const withEmpty = { ...state, studies: [] };
  assert.equal(fitStateToBudget(withEmpty, { budgetChars: 10 }), withEmpty);
});

test('Task15 排除先於預算裁剪：被排除者不吃預算 → fitStateToBudget 不裁剪', () => {
  const state = buildState(snapshot(), { bars: 300, features: false, now: NOW });
  const ids = [...fullStudiesMap(9).keys()];

  // 前置：9 個全窗 study 一定超預算。
  state.studies = buildStudies(fullStudiesMap(9), { bars: state.bars });
  assert.ok(payloadLen(state) > INPUT_BUDGET_CHARS, '前置：9 studies 必須超標');

  // 排除 7 個 → 剩 2 個即落入預算；預算裁剪不得發生。
  state.studies = buildStudies(fullStudiesMap(9), {
    bars: state.bars,
    exclude: ids.slice(0, 7),
  });
  assert.equal(state.studies.length, 2);
  assert.ok(
    payloadLen(state) <= INPUT_BUDGET_CHARS,
    '排除後應已落回預算（被排除者不吃預算）',
  );
  const out = fitStateToBudget(state);
  assert.equal(out, state, '未超標須回傳同一 state');
  assert.equal('studiesTrimmed' in out, false, '不得觸發裁剪');
  for (const s of out.studies) assert.equal(s.values.length, 300, '完整 300 窗未裁');
});
