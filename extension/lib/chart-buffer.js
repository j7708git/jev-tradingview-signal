// lib/chart-buffer.js — 增量 K 棒滾動緩衝（純 ESM，不得引用 chrome.* 或任何瀏覽器 API）
// 對應 docs/ARCHITECTURE.md §4.3 與 docs/WS-NOTES.md §2/§4 的 upsert 語意。

const DEFAULT_MAX_BARS = 3000;
const BAR_WIDTH = 6;

export class ChartBuffer {
  /**
   * @param {number} [maxBars=3000] 滾動上限；超過丟最舊。
   */
  constructor(maxBars = DEFAULT_MAX_BARS) {
    this.maxBars = maxBars;
    this._byTime = new Map(); // time(epoch 秒) -> number[6]
    this._dropped = 0;
  }

  /** 目前緩衝根數。 */
  get count() {
    return this._byTime.size;
  }

  /**
   * 增量寫入。bars 為 `[time, open, high, low, close, volume]` 6 元組陣列；
   * 以 b[0] 為 key，同 time 逐一覆寫（尾根收盤價會反覆刷新）。
   * @param {number[][]} bars
   * @returns {number} 實際寫入（新增或覆寫）的根數
   */
  upsertBars(bars) {
    if (!Array.isArray(bars)) return 0;
    let written = 0;
    for (const bar of bars) {
      if (!Array.isArray(bar) || bar.length < BAR_WIDTH) continue;
      const time = bar[0];
      // 複製 6 欄，避免呼叫方日後改動同一陣列參考
      this._byTime.set(time, [
        bar[0],
        bar[1],
        bar[2],
        bar[3],
        bar[4],
        bar[5],
      ]);
      written += 1;
    }
    this._evict();
    return written;
  }

  /** 清空緩衝（Task 06 收到 series_loading 時調用）。 */
  reset() {
    this._byTime.clear();
    this._dropped = 0;
  }

  /**
   * 依 time 升冪排序後取最近 n 根。
   * @param {number} [n] 省略或大於 count 時回傳全部。
   * @returns {number[][]}
   */
  snapshot(n) {
    const sorted = this._sortedBars();
    const take = n == null || n >= sorted.length ? sorted.length : n;
    return sorted.slice(sorted.length - take);
  }

  /** snapshot() 同義。 */
  bars(n) {
    return this.snapshot(n);
  }

  /** @returns {{count:number, firstTime:number|null, lastTime:number|null, dropped:number}} */
  meta() {
    const sorted = this._sortedBars();
    return {
      count: sorted.length,
      firstTime: sorted.length ? sorted[0][0] : null,
      lastTime: sorted.length ? sorted[sorted.length - 1][0] : null,
      dropped: this._dropped,
    };
  }

  _sortedBars() {
    return [...this._byTime.values()].sort((a, b) => a[0] - b[0]);
  }

  _evict() {
    const excess = this._byTime.size - this.maxBars;
    if (excess <= 0) return;
    const times = [...this._byTime.keys()].sort((a, b) => a - b);
    for (let i = 0; i < excess; i += 1) {
      this._byTime.delete(times[i]);
      this._dropped += 1;
    }
  }
}
