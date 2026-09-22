// Classic-script compatible: globals via globalThis; Node tests import the file and read globalThis.
// lib/ws-parse.js — TradingView socket.io 分幀與 §4.2 消費規則（純函式）
// 不得引用 chrome.* 或任何瀏覽器 API；零依賴，可直接在 Node import。
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
function parseFrames(rawText) {
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
globalThis.parseFrames = parseFrames;

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
function classifyPayload(jsonTextOrObj, meta) {
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
        // §4.2.1：`p[1]` 是 series 身分（sds_sym_1 主圖 / sds_sym_2 輔助 / ss_1 study）；
        // 消費端靠 seriesRef 判斷是否為主圖符號來源。
        return {
          kind: 'meta',
          symbol: body.full_name,
          seriesRef: Array.isArray(p) ? p[1] : undefined,
        };
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
globalThis.classifyPayload = classifyPayload;

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

// ────────────────────────────────────────────────────────────────────
// Task 13／§4.2.2：study 身分（上行 create_study）與逐根數值（下行 du）
// ────────────────────────────────────────────────────────────────────

/** create_study options 內不得進入 meta 的鍵（含加密 text blob）。 */
const STUDY_OPTION_EXCLUDE = new Set([
  'text',
  'pineFeatures',
  'pineId',
  'pineVersion',
  '__fast_calc',
  '__profile',
]);

/** 把 `{v, f, t}` 包裝還原成值；非包裝則原樣。 */
function unwrapOptionValue(entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'v' in entry) {
    return entry.v;
  }
  return entry;
}

/** 把 payload（JSON 字串或已解析物件）轉為 `{m,p}` 物件，失敗回 null。 */
function coercePayloadObject(jsonTextOrObj) {
  let root = jsonTextOrObj;
  if (typeof root === 'string') {
    try {
      root = JSON.parse(root);
    } catch {
      return null;
    }
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  return root;
}

/**
 * 解析上行 `create_study`：`p=[cid, studyId, "st1", "sds_1", scriptName, options]`。
 * - Pine 型（options.pineId 為字串）：`meta.pineId` ＋ `params` 取 `in_0..in_N`。
 * - 直給型：`params` 取具名參數（排除 `text`／`pineFeatures`／`__*` 等）。
 * - `options.text`（加密 blob）永不複製（redact）。
 *
 * @param {string|object} jsonTextOrObj
 * @returns {{kind:'study_meta', studyId:string, meta:{scriptName?:string, pineId?:string, params?:object}}|null}
 */
function parseCreateStudy(jsonTextOrObj) {
  const root = coercePayloadObject(jsonTextOrObj);
  if (!root || root.m !== 'create_study') return null;
  const p = root.p;
  if (!Array.isArray(p)) return null;
  const studyId = p[1];
  if (typeof studyId !== 'string' || studyId.length === 0) return null;

  const scriptName = typeof p[4] === 'string' ? p[4] : undefined;
  const options =
    p[5] && typeof p[5] === 'object' && !Array.isArray(p[5]) ? p[5] : null;

  const meta = {};
  if (scriptName !== undefined) meta.scriptName = scriptName;

  if (options) {
    const pineId = options.pineId;
    const params = {};
    if (typeof pineId === 'string' && pineId.length > 0) {
      meta.pineId = pineId;
      for (const k of Object.keys(options)) {
        if (/^in_\d+$/.test(k)) params[k] = unwrapOptionValue(options[k]);
      }
    } else {
      for (const k of Object.keys(options)) {
        if (STUDY_OPTION_EXCLUDE.has(k) || k.startsWith('__')) continue;
        params[k] = unwrapOptionValue(options[k]);
      }
    }
    if (Object.keys(params).length > 0) meta.params = params;
  }

  return { kind: 'study_meta', studyId, meta };
}
globalThis.parseCreateStudy = parseCreateStudy;

/**
 * 解析下行 `du` 內非 `/^sds_/` 鍵的逐根 study 數值。
 * - 每根 `{i,v}`：**忽略 i**（歷史批為負 sentinel），一律以 `v[0]`（epoch 秒）為 key。
 * - 只收至少有一根有效值的 study（`st` 恆空者自動排除，非寫死清單）。
 *
 * @param {string|object} jsonTextOrObj
 * @returns {Array<{studyId:string, rows:number[][]}>|null}
 */
function parseDuStudies(jsonTextOrObj) {
  const root = coercePayloadObject(jsonTextOrObj);
  if (!root || root.m !== 'du') return null;
  const body = Array.isArray(root.p) ? root.p[1] : undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const out = [];
  for (const key of Object.keys(body)) {
    if (SDS_PREFIX_RE.test(key)) continue; // bar series，另有 classifyDu 處理
    const st = body[key] && body[key].st;
    if (!Array.isArray(st)) continue;
    const rows = [];
    for (const e of st) {
      if (!e || typeof e !== 'object') continue;
      const v = e.v;
      if (!Array.isArray(v) || v.length < 2) continue; // 需 time＋≥1 值
      const time = v[0];
      if (typeof time !== 'number' || !isFinite(time)) continue;
      rows.push(v.slice());
    }
    if (rows.length > 0) out.push({ studyId: key, rows });
  }
  return out.length > 0 ? out : null;
}
globalThis.parseDuStudies = parseDuStudies;
