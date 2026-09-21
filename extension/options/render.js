// options/render.js — Options 頁的純函式邏輯（無 DOM、無 chrome.*、無 fetch）。
// 契約（Task 08 C2/C3）：storage.local 鍵名固定為
// jevApiKey / jevModel / bars / featuresOn；邊界鉗制與型別正規化在此集中。

export const BARS_MIN = 50;
export const BARS_MAX = 1000;
export const BARS_DEFAULT = 300;
export const MODELS = ['jev-latest', 'jev-preview'];
export const MODEL_DEFAULT = 'jev-latest';

/** 寬鬆轉 boolean：undefined／空字串走預設，常見真偽字串都吃。 */
function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  return Boolean(value);
}

/**
 * 把 storage 的原始值正規化成表單可用的設定。
 * 保證回傳 `{jevApiKey:string, jevModel:string, bars:number, featuresOn:boolean}`。
 *
 * @param {object} raw
 * @returns {{jevApiKey:string, jevModel:string, bars:number, featuresOn:boolean}}
 */
export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};

  const jevApiKey = typeof r.jevApiKey === 'string' ? r.jevApiKey : '';
  const jevModel = MODELS.includes(r.jevModel) ? r.jevModel : MODEL_DEFAULT;

  let bars;
  if (r.bars === undefined || r.bars === null || r.bars === '') {
    bars = BARS_DEFAULT;
  } else {
    bars = Number(r.bars);
    if (!Number.isFinite(bars)) bars = BARS_DEFAULT;
  }
  bars = Math.trunc(bars);
  if (bars < BARS_MIN) bars = BARS_MIN;
  if (bars > BARS_MAX) bars = BARS_MAX;

  const featuresOn = toBool(r.featuresOn, true);

  return { jevApiKey, jevModel, bars, featuresOn };
}

/**
 * 金鑰提示字串：只揭露長度與後 4 碼（例 `••••3f7a (len=32)`）。
 * 永不回傳完整 key；空值回「（未設定）」。
 *
 * @param {string} key
 * @returns {string}
 */
export function keyHint(key) {
  if (typeof key !== 'string' || key.length === 0) return '（未設定）';
  return `••••${key.slice(-4)} (len=${key.length})`;
}
