// lib/state-builder.js — ChartBuffer snapshot + 特徵 → systemone `state` 物件，
// 並集中 systemone `questions` 模板（ARCHITECTURE §6：模板不得散落 SW/UI）。
// 純 ESM，不得引用 chrome.* 或任何瀏覽器 API；零依賴，可直接在 Node import。
// 對應 docs/ARCHITECTURE.md §4.3（ChartBuffer）與 §4.4（systemone 請求 contract）。

import './protocol.js';
// protocol.js 為 classic-script 雙相容（無 ESM export）；符號掛在 globalThis。
const { BAR_COLUMNS } = globalThis;
import { computeFeatures } from './features.js';

const DEFAULT_BARS = 300;
const BAR_WIDTH = 6;

/**
 * systemone `questions` 常數，逐字對齊 docs/ARCHITECTURE.md §4.4。
 * 供 lib/jev-client.js 組請求使用（本檔為唯一來源）。
 */
export const QUESTIONS = {
  direction: {
    type: 'choice',
    instructions:
      'Given the candlestick series in `state`, what is the trade direction for the next several bars?',
    criteria: {
      long: 'Price more likely to rise than fall from here',
      neutral: 'No clear edge; range-bound or conflicting signals',
      short: 'Price more likely to fall than rise from here',
    },
  },
  up_10_bars: {
    type: 'noul',
    instructions: 'Will the close 10 bars from now be above the latest close?',
  },
  bull_trend: {
    type: 'score',
    instructions:
      'How strong is the bullish (upward) pressure in this series right now, judged from the recent candles and the derived features?',
    criteria: ['none', 'weak', 'moderate', 'strong', 'very strong'],
  },
  bear_trend: {
    type: 'score',
    instructions:
      'How strong is the bearish (downward) pressure in this series right now, judged from the recent candles and the derived features?',
    criteria: ['none', 'weak', 'moderate', 'strong', 'very strong'],
  },
};

/** 兩位數補零。 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 將 Date 格式化為 ISO 8601 **本地時區偏移**字串（非 UTC `Z`），
 * 例如 `2026-09-21T17:52:42+08:00`。
 * @param {Date} date
 * @returns {string}
 */
function toLocalIso(date) {
  const offsetMin = -date.getTimezoneOffset(); // 東經為正
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/**
 * 由 ChartBuffer snapshot 組出 systemone `state`。
 *
 * 流程：過濾非 6 欄根（記入 warnings）→ 截尾最近 `opts.bars` 根 → 算特徵。
 *
 * @param {{symbol?: string, resolution?: string, bars: number[][]}} snapshot
 *   bars 依 time 升冪，每根為 `[time,open,high,low,close,volume]`。
 * @param {{bars?: number, features?: boolean, now?: Date}} [opts]
 *   bars 預設 300；features:false 時輸出不含 features 鍵；now 僅供測試注入。
 * @returns {object} `state` 物件（符合 §4.4）；
 *   有被過濾的根時額外附 `warnings: string[]`。
 * @throws {Error} 當 `snapshot.bars` 為空或缺失時拋 `Error('empty bars')`。
 */
export function buildState(snapshot, opts = {}) {
  const raw = snapshot && Array.isArray(snapshot.bars) ? snapshot.bars : [];
  if (raw.length === 0) throw new Error('empty bars');

  const windowSize =
    Number.isInteger(opts.bars) && opts.bars > 0 ? opts.bars : DEFAULT_BARS;

  const warnings = [];
  const valid = [];
  for (let i = 0; i < raw.length; i += 1) {
    const bar = raw[i];
    if (!Array.isArray(bar) || bar.length !== BAR_WIDTH) {
      const got = Array.isArray(bar) ? `${bar.length} columns` : 'non-array';
      warnings.push(`bar[${i}] dropped: expected ${BAR_WIDTH} columns, got ${got}`);
      continue;
    }
    valid.push(bar);
  }

  const windowed =
    valid.length > windowSize ? valid.slice(valid.length - windowSize) : valid;
  const now = opts.now instanceof Date ? opts.now : new Date();

  const state = {
    symbol: snapshot.symbol,
    resolution: snapshot.resolution,
    generatedAt: toLocalIso(now),
    barsWindow: windowed.length,
    columns: BAR_COLUMNS,
    bars: windowed,
  };

  if (opts.features !== false) {
    state.features = computeFeatures(windowed);
  }
  if (warnings.length > 0) {
    state.warnings = warnings;
  }

  return state;
}

// ─────────────────────────────────────────────────────────────
// §4.2.2／Task 13：study 數列 → systemone `state.studies` 陣列
// ─────────────────────────────────────────────────────────────

/**
 * 由 study meta 推 `rawName`：
 * - 有 pineId → 取最後 `;` 後一段，`%1` 還原為空白（如 `STD;Arnaud%1Legoux%1Moving%1Average`
 *   → `Arnaud Legoux Moving Average`）。
 * - 否則取 scriptName `@` 前段（如 `Volume@tv-basicstudies-277` → `Volume`）。
 */
function deriveRawName(meta) {
  if (meta && typeof meta.pineId === 'string' && meta.pineId.length > 0) {
    const idx = meta.pineId.lastIndexOf(';');
    const seg = idx >= 0 ? meta.pineId.slice(idx + 1) : meta.pineId;
    return seg.split('%1').join(' ').trim();
  }
  if (meta && typeof meta.scriptName === 'string' && meta.scriptName.length > 0) {
    const at = meta.scriptName.indexOf('@');
    const seg = at >= 0 ? meta.scriptName.slice(0, at) : meta.scriptName;
    return seg.trim();
  }
  return '';
}

/** 多字 rawName → 首字母縮寫（`Arnaud Legoux Moving Average` → `ALMA`）。 */
function acronymOf(rawName) {
  if (!rawName) return '';
  const parts = rawName.split(/[\s_]+/).filter(Boolean);
  if (parts.length >= 2) {
    return parts
      .map((p) => p.charAt(0).toUpperCase())
      .join('');
  }
  return rawName;
}

/**
 * 取名稱參數縮寫：優先首個有限數值（多為 period，如 25）；
 * 完全無數值時才用首個非空字串。
 */
function firstParamValue(params) {
  if (!params || typeof params !== 'object') return null;
  let stringFallback = null;
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (stringFallback === null && typeof v === 'string' && v.length > 0) {
      stringFallback = v;
    }
  }
  return stringFallback;
}

/** 無使用者覆寫時的自動名稱：`acronym(rawName)＋(首個參數)`，如 `ALMA(25)`。 */
function autoStudyName(rawName, params, fallbackId) {
  const short = acronymOf(rawName) || (fallbackId != null ? String(fallbackId) : '');
  const pv = firstParamValue(params);
  return pv === null ? short : `${short}(${pv})`;
}

/**
 * 把 SW 的 studies（`Map<id, {meta, series: Map<time, vals>}>`）轉成 §4.4 studies 陣列。
 *
 * - `values` 與 `opts.bars` 同一窗口逐根對齊；該 study 缺值的根補 `null`；
 * - `columns` 通用 `['time','v1',…]`（多圖指標 BB＝v1..v3）；
 * - `name` 優先 `opts.nameMap[id]`，否則自動名稱；`rawName` 保留自動名稱；
 * - `params` 原樣帶出；空序列的 study 直接略過（未掛指標 → `[]`）。
 *
 * @param {Map<string, {meta:object, series:Map<number, number[]>}>} studiesMap
 * @param {{bars?:number[][], nameMap?:Record<string,string>}} [opts]
 * @returns {Array<{id:string,name:string,rawName:string,params:object,columns:string[],values:(number[]|null)[]}>}
 */
export function buildStudies(studiesMap, opts = {}) {
  const bars = opts && Array.isArray(opts.bars) ? opts.bars : [];
  const nameMap =
    opts && opts.nameMap && typeof opts.nameMap === 'object' ? opts.nameMap : {};
  const out = [];

  if (!studiesMap || typeof studiesMap.forEach !== 'function') return out;

  studiesMap.forEach((rec, id) => {
    if (!rec || typeof rec !== 'object') return;
    const series = rec.series instanceof Map ? rec.series : new Map();
    if (series.size === 0) return; // 只收有逐根值的 study

    const meta = rec.meta && typeof rec.meta === 'object' ? rec.meta : {};
    const rawName = deriveRawName(meta);
    const params =
      meta.params && typeof meta.params === 'object' ? { ...meta.params } : {};

    const override = nameMap[id];
    const name =
      typeof override === 'string' && override.length > 0
        ? override
        : autoStudyName(rawName, params, id);

    let arity = 0;
    series.forEach((vals) => {
      if (Array.isArray(vals) && vals.length > arity) arity = vals.length;
    });
    if (arity < 1) arity = 1;
    if (arity > 4) arity = 4; // §4.4：1–4 值

    const columns = ['time'];
    for (let i = 1; i <= arity; i += 1) columns.push(`v${i}`);

    const values = [];
    for (let i = 0; i < bars.length; i += 1) {
      const time = Array.isArray(bars[i]) ? bars[i][0] : undefined;
      const vals = series.get(time);
      if (!Array.isArray(vals)) {
        values.push(null); // 同窗口缺值根 → null
        continue;
      }
      const row = [time];
      for (let k = 0; k < arity; k += 1) {
        row.push(k < vals.length ? vals[k] : null);
      }
      values.push(row);
    }

    out.push({ id, name, rawName, params, columns, values });
  });

  return out;
}

/**
 * 以 `JSON.stringify(state)` 長度粗估 token 數（4 字元 ≈ 1 token）。
 * @param {object} state
 * @returns {number} 整數
 */
export function estimateTokens(state) {
  return Math.ceil(JSON.stringify(state).length / 4);
}

// ─────────────────────────────────────────────────────────────
// Task 14fix：輸入預算守門（§4.4 systemone 請求大小上限）
// ─────────────────────────────────────────────────────────────

/**
 * systemone 輸入預算（JSON 字元數）。API 對輸入設上限，超過回 400/422，
 * body 為 `{"detail":{"error_type":"max_tokens_exceeded"}}`。
 *
 * 架構師實測（2026-09-22；9 指標 × 300 窗）：
 *   - pass＝29,669 input_tokens ／ 37.2KB payload
 *   - fail≈33K input_tokens ／ 40.9KB payload（上限約 32K tokens）
 * 實測 token/byte ≈ 0.8；為保守計以「JSON 字元數」為守門量並取 29000
 * （約 23K tokens），在 32K 上限前留安全邊際。
 */
export const INPUT_BUDGET_CHARS = 29000;

/**
 * 完整 systemone 請求的實際字元長度（與 jev-client 送出的 body 同構）。
 * @param {object} state
 * @returns {number}
 */
function payloadChars(state) {
  return JSON.stringify({ model: 'jev-latest', state, questions: QUESTIONS }).length;
}

/**
 * 以「尾端裁窗」把 systemone `state` 壓進輸入預算。
 *
 * - 未超標（整包 ≤ 預算）→ 原樣回傳同一 state 物件（零改動、逐位元不變）。
 * - 超標 → 對每個 `state.studies[*].values` 取「相同 K」的尾端 `slice(-K)`
 *   （0 ≤ K ≤ `state.barsWindow`；rows 自帶 time，對齊語意不變），
 *   以確定性二分搜尋最大可行 K，並附 `state.studiesTrimmed = K`。
 * - K=0（清空 values；id/name/rawName/params/columns 保留）仍超標
 *   → 代表 bars＋questions 本身就超預算：原樣回傳、不動 bars，交 API 錯誤路徑回報。
 *
 * @param {object} state §4.4 state（`studies` 為陣列時才可能被裁）
 * @param {{budgetChars?: number}} [opts] `budgetChars` 可注入（測試用）
 * @returns {object} 同一個（未超標／無法裁）或裁後 state
 */
export function fitStateToBudget(state, opts = {}) {
  if (!state || typeof state !== 'object') return state;
  const budget =
    Number.isFinite(opts.budgetChars) && opts.budgetChars >= 0
      ? opts.budgetChars
      : INPUT_BUDGET_CHARS;

  if (payloadChars(state) <= budget) return state;

  const studies = state.studies;
  // 無 studies 可裁（或全空）→ 無法降長度，原樣回傳交錯誤路徑。
  if (!Array.isArray(studies) || studies.length === 0) return state;

  // 以不變動原 state 的視圖量長度（保留鍵順序，且計入最終會附加的
  // `studiesTrimmed` 欄位，確保裁後整包含標記仍 ≤ 預算）。
  const trimmedView = (k) => {
    const nextStudies = studies.map((s) => {
      if (!s || typeof s !== 'object') return s;
      const values = Array.isArray(s.values) ? s.values : [];
      return { ...s, values: k > 0 ? values.slice(-k) : [] };
    });
    return { ...state, studies: nextStudies, studiesTrimmed: k };
  };

  // K=0 清空仍超標 → bars＋questions 本身即超：原樣回傳、不動 bars。
  if (payloadChars(trimmedView(0)) > budget) return state;

  const hi =
    Number.isInteger(state.barsWindow) && state.barsWindow > 0
      ? state.barsWindow
      : 0;
  let lo = 0;
  let high = hi;
  while (lo < high) {
    const mid = Math.ceil((lo + high) / 2);
    if (payloadChars(trimmedView(mid)) <= budget) lo = mid;
    else high = mid - 1;
  }
  const k = lo;

  for (const s of studies) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.values)) continue;
    s.values = k > 0 ? s.values.slice(-k) : [];
  }
  state.studiesTrimmed = k;
  return state;
}
