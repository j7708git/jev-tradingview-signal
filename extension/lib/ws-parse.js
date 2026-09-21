// lib/ws-parse.js — TradingView socket.io 分幀與 §4.2 消費規則（純函式）
// 純 ESM，不得引用 chrome.* 或任何瀏覽器 API；零依賴，可直接在 Node import。
// 規格來源：docs/WS-NOTES.md（實測協定）＋ docs/ARCHITECTURE.md §4.2。

const SDS_PREFIX_RE = /^sds_/;
const HEARTBEAT_RE = /^~h~(\d+)/;

/**
 * 解析 socket.io 文字分幀：`~m~<len>~m~<payload>`（一條 raw 可串多幀）。
 * - `len` 為十進位字元數，後隨 `~m~` 再隨 payload 本體。
 * - `~h~<n>` 心跳丟棄。
 * - 任何解析不了的尾部（含被截斷、len 超長）一律丟棄，不拋錯。
 * - 非 `~m~` 開頭者回傳 `[]`。
 *
 * @param {string} rawText
 * @returns {string[]} 每個 frame 的 payload 本體（未解析 JSON）
 */
export function parseFrames(rawText) {
  if (typeof rawText !== 'string' || !rawText.startsWith('~m~')) return [];

  const out = [];
  let i = 0;
  const n = rawText.length;

  while (i < n) {
    // 心跳（理論上不與資料幀混排，仍容忍並丟棄）
    if (rawText[i] === '~' && rawText[i + 1] === 'h') {
      const hb = HEARTBEAT_RE.exec(rawText.slice(i));
      if (!hb) break; // 解析不了的尾部
      i += hb[0].length;
      continue;
    }

    if (!rawText.startsWith('~m~', i)) break; // 解析不了的尾部

    const afterHeader = i + 3;
    const sep = rawText.indexOf('~m~', afterHeader);
    if (sep < 0) break;

    const lenText = rawText.slice(afterHeader, sep);
    if (!/^\d+$/.test(lenText)) break;

    const len = Number(lenText);
    const payloadStart = sep + 3;
    const payloadEnd = payloadStart + len;
    if (payloadEnd > n) break; // 尾幀被截斷（len 超長）→ 丟棄

    out.push(rawText.slice(payloadStart, payloadEnd));
    i = payloadEnd;
  }

  return out;
}

/**
 * 依 §4.2 把單一 payload 分派成結構化結果。
 * 輸入可為 payload JSON 字串、或已解析的 `{m, p}` 物件；亦接受 `meta` 補充 type。
 *
 * @param {string|object} jsonTextOrObj
 * @param {{m?:string, type?:string}} [meta]
 * @returns {object|null}
 *   - `{kind:'bars', seriesKey, bars:[[t,o,h,l,c,v],...]}`
 *   - `{kind:'meta', symbol}`
 *   - `{kind:'control', action:'reset'|'streaming', seriesKey}`
 *   - `{kind:'ignore', m?}`
 *   - `null`（不消費 / 解析不了）
 */
export function classifyPayload(jsonTextOrObj, meta) {
  let root = jsonTextOrObj;
  if (typeof root === 'string') {
    try {
      root = JSON.parse(root);
    } catch {
      return null; // 非 JSON
    }
  }
  if (!root || typeof root !== 'object') return null;

  let m;
  let p;
  if (Array.isArray(root)) {
    // 裸的 p 陣列：型別必須由 meta 提供
    m = meta ? meta.m ?? meta.type : undefined;
    p = root;
  } else {
    m = root.m != null ? root.m : meta ? meta.m ?? meta.type : undefined;
    p = root.p;
    if (typeof p === 'string') {
      try {
        p = JSON.parse(p);
      } catch {
        p = undefined;
      }
    }
  }
  if (typeof m !== 'string') return null;

  switch (m) {
    case 'timescale_update':
      return classifySeriesBars(p, m);

    case 'du':
      return classifyDu(p);

    case 'symbol_resolved': {
      const body = Array.isArray(p) ? p[2] : undefined;
      if (
        body &&
        typeof body === 'object' &&
        typeof body.full_name === 'string'
      ) {
        return { kind: 'meta', symbol: body.full_name };
      }
      return null;
    }

    case 'series_loading': {
      const key = Array.isArray(p) ? p[1] : undefined;
      if (typeof key === 'string' && key.startsWith('sds')) {
        return { kind: 'control', action: 'reset', seriesKey: key };
      }
      return null;
    }

    case 'series_completed': {
      const key = Array.isArray(p) ? p[1] : undefined;
      if (typeof key === 'string' && key.startsWith('sds')) {
        return { kind: 'control', action: 'streaming', seriesKey: key };
      }
      return null;
    }

    default:
      // qsd、study_*、無 m 等一律不消費
      return null;
  }
}

/** timescale_update：p[1] 內找 `/^sds_/` key 的非空 `s[]`。 */
function classifySeriesBars(p, m) {
  const body = Array.isArray(p) ? p[1] : undefined;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const key of Object.keys(body)) {
      if (!SDS_PREFIX_RE.test(key)) continue;
      const bars = extractBars(body[key]);
      if (bars) return { kind: 'bars', seriesKey: key, bars };
    }
  }
  // `p[1]==={}`（未來刻度排程）或任何非資料版：丟棄但標記型別
  return { kind: 'ignore', m };
}

/** du：尾根推送；只有 study 鍵（無 sds_*）時為 ignore。 */
function classifyDu(p) {
  const body = Array.isArray(p) ? p[1] : undefined;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const key of Object.keys(body)) {
      if (!SDS_PREFIX_RE.test(key)) continue;
      const bars = extractBars(body[key]);
      if (bars) return { kind: 'bars', seriesKey: key, bars };
    }
  }
  return { kind: 'ignore' };
}

/** 由 `{s:[{i,v}]}` 取非空 `v` 陣列（原樣，不轉換資料型別）。 */
function extractBars(node) {
  const s = node && node.s;
  if (!Array.isArray(s)) return null;
  const bars = s
    .filter((e) => e && Array.isArray(e.v))
    .map((e) => e.v);
  return bars.length > 0 ? bars : null;
}
