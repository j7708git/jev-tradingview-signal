// lib/state-builder.js — ChartBuffer snapshot + 特徵 → systemone `state` 物件，
// 並集中 systemone `questions` 模板（ARCHITECTURE §6：模板不得散落 SW/UI）。
// 純 ESM，不得引用 chrome.* 或任何瀏覽器 API；零依賴，可直接在 Node import。
// 對應 docs/ARCHITECTURE.md §4.3（ChartBuffer）與 §4.4（systemone 請求 contract）。

import { BAR_COLUMNS } from './protocol.js';
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
  trend_strength: {
    type: 'score',
    instructions: 'How strong is the prevailing trend in this series?',
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

/**
 * 以 `JSON.stringify(state)` 長度粗估 token 數（4 字元 ≈ 1 token）。
 * @param {object} state
 * @returns {number} 整數
 */
export function estimateTokens(state) {
  return Math.ceil(JSON.stringify(state).length / 4);
}
