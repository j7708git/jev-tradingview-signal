// lib/features.js — 純數學特徵（SMA / Wilder RSI / 動量 / 區間%）
// 純 ESM，不得引用 chrome.* 或任何瀏覽器 API；零依賴，可直接在 Node import。
// 輸入 bars 依 time 升冪（同 ChartBuffer.snapshot() 輸出）；
// 資料不足或非法輸入一律回 null，絕不拋錯。

/** 是否為有限的 number。 */
function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * 最近 `period` 筆的簡單移動平均。
 * @param {number[]} values
 * @param {number} period
 * @returns {number|null} 不足窗口或非法輸入回 null
 */
export function sma(values, period) {
  if (!Array.isArray(values)) return null;
  if (!Number.isInteger(period) || period <= 0) return null;
  if (values.length < period) return null;

  let sum = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    if (!isFiniteNumber(values[i])) return null;
    sum += values[i];
  }
  return sum / period;
}

/**
 * Wilder 平滑 RSI。首 `period` 個差值取簡單平均，其後
 * `avg = (prev * (period - 1) + cur) / period`。
 * 回傳自 `closes[period]` 起算的 RSI 序列（長度 n - period）。
 * @param {number[]} closes
 * @param {number} [period=14]
 * @returns {number[]|null} 不足窗口或非法輸入回 null
 */
export function rsiWilder(closes, period = 14) {
  if (!Array.isArray(closes)) return null;
  if (!Number.isInteger(period) || period <= 0) return null;
  if (closes.length < period + 1) return null;
  for (const c of closes) {
    if (!isFiniteNumber(c)) return null;
  }

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  const out = [rsiFrom(avgGain, avgLoss)];
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push(rsiFrom(avgGain, avgLoss));
  }
  return out;
}

/** avgLoss=0 → 100；全跌（avgGain=0）→ 0。 */
function rsiFrom(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * 動量百分比：`(last / closes[last - lookback] - 1) * 100`。
 * @param {number[]} closes
 * @param {number} [lookback=5]
 * @returns {number|null}
 */
export function momentumPct(closes, lookback = 5) {
  if (!Array.isArray(closes)) return null;
  if (!Number.isInteger(lookback) || lookback <= 0) return null;
  if (closes.length <= lookback) return null;

  const last = closes[closes.length - 1];
  const base = closes[closes.length - 1 - lookback];
  if (!isFiniteNumber(last) || !isFiniteNumber(base) || base === 0) return null;
  return (last / base - 1) * 100;
}

/**
 * 區間百分比：最近 `n` 根的 `(max(high) - min(low)) / lastClose * 100`。
 * @param {number[][]} bars
 * @param {number} [n=20]
 * @returns {number|null}
 */
export function rangePct(bars, n = 20) {
  if (!Array.isArray(bars)) return null;
  if (!Number.isInteger(n) || n <= 0) return null;
  if (bars.length < n) return null;

  const window = bars.slice(bars.length - n);
  let hi = -Infinity;
  let lo = Infinity;
  for (const bar of window) {
    if (!Array.isArray(bar) || bar.length < 5) return null;
    const high = bar[2];
    const low = bar[3];
    if (!isFiniteNumber(high) || !isFiniteNumber(low)) return null;
    if (high > hi) hi = high;
    if (low < lo) lo = low;
  }

  const lastClose = window[window.length - 1][4];
  if (!isFiniteNumber(lastClose) || lastClose === 0) return null;
  return ((hi - lo) / lastClose) * 100;
}

/**
 * 一次算出 state 所需特徵；小數不截斷，資料不足項為 null。
 * @param {number[][]} bars
 * @returns {{ma20:number|null, ma50:number|null, rsi14:number|null,
 *            momentumPct5:number|null, rangePct20:number|null,
 *            lastClose:number|null}}
 */
export function computeFeatures(bars) {
  const empty = {
    ma20: null,
    ma50: null,
    rsi14: null,
    momentumPct5: null,
    rangePct20: null,
    lastClose: null,
  };
  if (!Array.isArray(bars) || bars.length === 0) return empty;

  const closes = [];
  for (const bar of bars) {
    if (!Array.isArray(bar) || bar.length < 5 || !isFiniteNumber(bar[4])) {
      return empty;
    }
    closes.push(bar[4]);
  }

  const rsiSeries = rsiWilder(closes, 14);
  return {
    ma20: sma(closes, 20),
    ma50: sma(closes, 50),
    rsi14: rsiSeries ? rsiSeries[rsiSeries.length - 1] : null,
    momentumPct5: momentumPct(closes, 5),
    rangePct20: rangePct(bars, 20),
    lastClose: closes[closes.length - 1],
  };
}
