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
