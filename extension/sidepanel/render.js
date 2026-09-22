// sidepanel/render.js — Side Panel 的純函式渲染層。
// 契約（Task 08 C1/C3）：純 ESM、零 DOM、零 chrome.*、零 fetch；
// 只把 entry.last（lib/sw-core.js 的形狀）轉成 HTML 字串，app.js 負責掛載與綁事件。
// 可被 `node --test` 直接 import 斷言（tests/render.test.mjs）。

// 09e-2：門檻單一來源（protocol.js 為雙相容無 export，靠 side-effect 填充 globalThis）。
import '../lib/protocol.js';
const PREDICT_MIN_BARS = globalThis.PREDICT_MIN_BARS;
// §4.8.2：成本單價單一來源（USD / 1M input tokens）。
const COST_USD_PER_MTOK = globalThis.COST_USD_PER_MTOK;

/** 底部常駐免責固定語（§5.5）。 */
export const DISCLAIMER = '僅供研究參考，不構成投資建議';

/** 成本換算：$0.042 / 1M input tokens（引用 protocol.js 單一來源，前端重算防 last.cost 漂移）。 */
export const COST_PER_INPUT_TOKEN = COST_USD_PER_MTOK / 1e6;

/** F8：開啟擴充設定頁的共用 hook（app.js 以此 class 綁定單一 handler）。 */
export const OPEN_OPTIONS_CLASS = 'open-options';

/** F8：上述按鈕的 data-action 值（header 與 no_key CTA 共用同一識別）。 */
export const OPEN_OPTIONS_ACTION = 'open-options';

/** 方向 → CSS class。 */
export const DIRECTION_CLASS = {
  long: 'dir-long',
  neutral: 'dir-neutral',
  short: 'dir-short',
};

/** 方向 → 中文標籤。 */
export const DIRECTION_LABEL = {
  long: '做多',
  neutral: '觀望',
  short: '做空',
};

/** 機率條固定順序。 */
export const PROBABILITY_ORDER = ['long', 'neutral', 'short'];

/**
 * lib/jev-client.js 定義的 JevError.kind → 中文訊息。
 * 這份清單即「全 kind 覆蓋」的單一來源（tests/render.test.mjs 逐一比對）。
 */
export const ERROR_MESSAGES = {
  no_key: '尚未設定 API key，請開啟擴充設定（右鍵→選項）',
  auth_401: 'API key 已被拒絕（401）',
  rate_exhausted: 'Jev 限流，稍後再試',
  overloaded: 'Jev 過載，稍後再試',
  timeout: '請求逾時（10s）',
  offline: '離線或防火牆擋了 api.typesafe.ai',
  bad_request_422: '請求格式被拒絕（422）',
  offhost: 'API 回應異常',
  // 09e-1：資料不足被拒（門檻取自 protocol.js 單一來源）。
  insufficient_data: `K 棒不足（需 ≥${PREDICT_MIN_BARS} 根）`,
};

/** HTML escape（JSON / 符號等不可信任字串一律先過）。 */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 0..1 → 整數百分比；非有限數回 null。 */
function toPercent(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 100)
    : null;
}

/**
 * 未知 kind 的防呆 redact：先過疑似 key / Bearer 片段的檢查再顯示原文。
 * 已知 kind 一律回對照表中文字。
 *
 * @param {string} kind
 * @param {string} [rawMessage] 未知 kind 時可顯示的原文（sw-core 已 redact）
 * @returns {string}
 */
export function errorMsg(kind, rawMessage) {
  if (kind != null && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, kind)) {
    return ERROR_MESSAGES[kind];
  }
  const fallback =
    rawMessage != null && rawMessage !== ''
      ? String(rawMessage)
      : kind == null
        ? '未知錯誤'
        : String(kind);
  // 「先过 [redacted] 檢查」：疑似 token 的長英數串與 Bearer 標頭一律遮罩。
  return fallback
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, '[redacted]')
    .replace(/[A-Za-z0-9._\-]{20,}/g, '[redacted]');
}

/**
 * 方向徽章：long=做多（綠）／neutral=觀望（灰）／short=做空（紅）＋ confidence %。
 */
export function renderDirection(direction) {
  const d = direction || {};
  const choice = Object.prototype.hasOwnProperty.call(DIRECTION_CLASS, d.choice)
    ? d.choice
    : 'neutral';
  const conf = toPercent(d.confidence);
  const confHtml =
    conf == null ? '' : `<span class="badge-conf">${conf}%</span>`;
  return (
    `<div class="badge ${DIRECTION_CLASS[choice]}">` +
    `<span class="badge-label">${DIRECTION_LABEL[choice]}</span>${confHtml}</div>`
  );
}

/**
 * 三條機率條（寬度＝機率取整百分比，並標百分比文字）。
 */
export function renderProbabilities(probabilities) {
  const p = probabilities || {};
  const rows = PROBABILITY_ORDER.map((choice) => {
    const width = toPercent(p[choice]) ?? 0;
    return (
      `<div class="prob-row" data-choice="${choice}">` +
      `<span class="prob-name">${DIRECTION_LABEL[choice]}</span>` +
      `<span class="prob-track"><span class="prob-fill ${DIRECTION_CLASS[choice]}" style="width:${width}%"></span></span>` +
      `<span class="prob-value">${width}%</span></div>`
    );
  });
  return `<div class="prob-list">${rows.join('')}</div>`;
}

/**
 * score 趨勢：把 score 以答案附的 legend 映射成級名（score 可為索引或字串）。
 */
export function trendLevel(trend) {
  const t = trend || {};
  const legend = Array.isArray(t.legend) ? t.legend : null;
  if (legend) {
    if (typeof t.score === 'number' && Number.isFinite(t.score)) {
      const idx = Math.trunc(t.score);
      if (legend[idx] !== undefined) return String(legend[idx]);
    }
    if (typeof t.score === 'string' && legend.includes(t.score)) return t.score;
  }
  return t.score == null ? '—' : String(t.score);
}

/** 單列趨勢強度（label + legend 級名；缺資料時該列顯示「—」，不拋錯）。 */
export function renderTrendRow(label, trend) {
  const level = trendLevel(trend);
  const raw = trend && trend.score != null ? String(trend.score) : '—';
  const rawHtml =
    raw !== level ? `<span class="trend-raw">${escapeHtml(raw)}</span>` : '';
  return (
    `<div class="trend"><span class="trend-label">${escapeHtml(label)}</span>` +
    `<span class="trend-score">${escapeHtml(level)}</span>${rawHtml}</div>`
  );
}

/**
 * 趨勢強度（Task 09h）：新回應渲染「多頭趨勢強度／空頭趨勢強度」兩列；
 * 任一題缺漏時該列顯示「—」。舊回應若仍含 `trend_strength`，
 * 相容渲染單列「趨勢強度」。
 */
export function renderTrend(answers) {
  const a = answers || {};
  if (a.bull_trend !== undefined || a.bear_trend !== undefined) {
    return (
      renderTrendRow('多頭趨勢強度', a.bull_trend) +
      renderTrendRow('空頭趨勢強度', a.bear_trend)
    );
  }
  if (a.trend_strength !== undefined) {
    return renderTrendRow('趨勢強度', a.trend_strength);
  }
  return '';
}

/** up_10_bars.noul → 「未來 10 根上漲機率：NN%」。 */
export function renderUp10(up) {
  const value = up && typeof up.noul === 'number' ? up.noul : null;
  const percent = toPercent(value);
  const text = percent == null ? '—' : `${percent}%`;
  return (
    `<div class="up10">未來 10 根上漲機率：` +
    `<span class="up10-val">${text}</span></div>`
  );
}

/**
 * 成本列：「{input_tokens} tokens · $X.XXXX · {ms}ms · {model}」。
 * cost 一律由 usage.input_tokens 前端重算（顯示 4 位小數）。
 */
export function renderCost(last, model) {
  const usage = (last && last.usage) || {};
  const rawTokens = Number(usage.input_tokens);
  const inputTokens = Number.isFinite(rawTokens) ? rawTokens : 0;
  const rawMs = Number(last && last.ms);
  const ms = Number.isFinite(rawMs) ? rawMs : 0;
  const resolvedModel = model || (last && last.model) || 'jev-latest';
  const cost = inputTokens * COST_PER_INPUT_TOKEN;
  return (
    `<div class="cost">` +
    `<span class="cost-tokens">${inputTokens} tokens</span> · ` +
    `<span class="cost-usd">$${cost.toFixed(4)}</span> · ` +
    `<span class="cost-ms">${ms}ms</span> · ` +
    `<span class="cost-model">${escapeHtml(resolvedModel)}</span></div>`
  );
}

/**
 * 兩個折疊 <details>：payload(state) 與 answer(answers+usage)，各附複製鈕。
 */
export function renderDetails(last) {
  const payload = JSON.stringify((last && last.state) ?? null, null, 2);
  const answer = JSON.stringify(
    {
      answers: (last && last.answers) ?? null,
      usage: (last && last.usage) ?? null,
    },
    null,
    2,
  );
  return (
    `<details class="json-block">` +
    `<summary>原始 payload（state）</summary>` +
    `<pre id="payload-json" class="json-pre">${escapeHtml(payload)}</pre>` +
    `<button type="button" class="copy-btn" data-copy-target="payload-json">複製</button>` +
    `</details>` +
    `<details class="json-block">` +
    `<summary>原始回應（answers + usage）</summary>` +
    `<pre id="answer-json" class="json-pre">${escapeHtml(answer)}</pre>` +
    `<button type="button" class="copy-btn" data-copy-target="answer-json">複製</button>` +
    `</details>`
  );
}

/** done 狀態完整 HTML（徽章／機率條／up10／趨勢／成本／JSON／免責）。 */
export function renderResult(last, opts = {}) {
  if (!last) return '';
  const answers = last.answers || {};
  const direction = answers.direction || {};
  return (
    `<div class="result-body">` +
    renderDirection(direction) +
    renderProbabilities(direction.probabilities) +
    renderUp10(answers.up_10_bars) +
    renderTrend(answers) +
    renderCost(last, opts.model) +
    renderDetails(last) +
    `<p class="disclaimer">${DISCLAIMER}</p>` +
    `</div>`
  );
}

/** loading 狀態（含秒級計時器插槽）。 */
export function renderLoading(seconds = 0) {
  const secs = Number.isFinite(Number(seconds)) ? Math.max(0, Math.floor(seconds)) : 0;
  return (
    `<div class="loading"><span class="spinner" aria-hidden="true"></span>` +
    `<span>預測中</span> <span class="loading-timer">${secs}s</span></div>`
  );
}

/** F8：設定入口按鈕（header 與 no_key CTA 共用同一 class／data-action hook）。 */
export function renderOpenOptionsButton(label) {
  return (
    `<button type="button" class="ghost ${OPEN_OPTIONS_CLASS}" ` +
    `data-action="${OPEN_OPTIONS_ACTION}">${escapeHtml(label)}</button>`
  );
}

/** error 狀態（kind → 中文訊息，未知 kind 先過 redact 檢查）。 */
export function renderError(kind, message) {
  const safeKind = kind == null ? 'error' : String(kind);
  // F8：僅 no_key 錯誤態提供設定入口 CTA；其餘 kind 不得出現。
  const cta = safeKind === 'no_key' ? renderOpenOptionsButton('去設定 API key') : '';
  return (
    `<div class="error-box">` +
    `<div class="error-title">預測失敗</div>` +
    `<div class="error-kicker">${escapeHtml(safeKind)}</div>` +
    `<div class="error-msg">${escapeHtml(errorMsg(kind, message))}</div>` +
    cta +
    `<p class="disclaimer">${DISCLAIMER}</p></div>`
  );
}

/**
 * §4.8.5(a)：除錯區 counters 一行：`dropped=X · ignoredSeriesFrames=Y`。
 * 缺值／非數值一律顯示 0，不得拋錯。
 * @returns {string} 純文字（呼叫端用 textContent 掛載）
 */
export function renderCounters(counters) {
  const c = counters || {};
  const droppedRaw = Number(c.dropped);
  const ignoredRaw = Number(c.ignoredSeriesFrames);
  const dropped = Number.isFinite(droppedRaw) ? droppedRaw : 0;
  const ignored = Number.isFinite(ignoredRaw) ? ignoredRaw : 0;
  return `dropped=${dropped} · ignoredSeriesFrames=${ignored}`;
}

/** 把 epoch 毫秒格式成 `HH:MM`（本地時區）；無效值回「—」。 */
export function formatClock(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * §4.8.5(b)：ring log 單筆一行。
 * 成功：`HH:MM symbol 方向 機率 · 多X/空Y · ms · tokens · $cost`；
 * 錯誤：`HH:MM symbol 錯誤 kind · ms · tokens · $cost`。缺值降級「—」，不得拋錯。
 */
export function renderRingLogRow(entry) {
  const e = entry || {};
  const at = formatClock(e.at);
  const symbol = e.symbol ? String(e.symbol) : '—';
  const msRaw = Number(e.ms);
  const ms = Number.isFinite(msRaw) ? `${msRaw}ms` : '—';
  const tokensRaw = Number(e.inputTokens);
  const tokens = Number.isFinite(tokensRaw) ? tokensRaw : 0;
  const costRaw = Number(e.costUsd);
  const cost = Number.isFinite(costRaw) ? costRaw : 0;
  const tail = `${ms} · ${tokens} tokens · $${cost.toFixed(4)}`;

  let head;
  if (e.ok === true) {
    const label = Object.prototype.hasOwnProperty.call(DIRECTION_LABEL, e.direction)
      ? DIRECTION_LABEL[e.direction]
      : '—';
    const probs = e.probs || {};
    const pRaw = Number(probs[e.direction]);
    const pct = Number.isFinite(pRaw) ? `${Math.round(pRaw * 100)}%` : '—';
    const bull = e.bull == null ? '—' : String(e.bull);
    const bear = e.bear == null ? '—' : String(e.bear);
    head = `${escapeHtml(label)} ${escapeHtml(pct)} · 多${escapeHtml(bull)}/空${escapeHtml(bear)}`;
  } else {
    const kind = e.kind == null ? '—' : String(e.kind);
    head = `錯誤 ${escapeHtml(kind)}`;
  }

  return (
    `<li class="ring-row">` +
    `<span class="ring-time">${escapeHtml(at)}</span> ` +
    `<span class="ring-symbol">${escapeHtml(symbol)}</span> ` +
    `<span class="ring-head">${head}</span> ` +
    `<span class="ring-tail">${escapeHtml(tail)}</span>` +
    `</li>`
  );
}

/** §4.8.5(b)：ring log 清單（新→舊，呼叫端已排序）；空清單降級「—」。 */
export function renderRingLog(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return `<p class="ring-empty">—</p>`;
  return `<ol class="ring-list">${list.map(renderRingLogRow).join('')}</ol>`;
}

/**
 * 連線狀態列：`圖表：{symbol|等待中} · {resolution} · {count} 根 · buffer total {total}`。
 * count 為送給 Jev 的視窗根數（無 last 時＝buffer 根數），total 為 buffer 總數。
 */
export function renderStatus(state) {
  const s = state || {};
  const symbol = s.symbol ? String(s.symbol) : '等待中';
  const resolution = s.resolution ? String(s.resolution) : '—';
  const totalRaw = Number(s.count);
  const total = Number.isFinite(totalRaw) ? totalRaw : 0;
  const winRaw = s.last && s.last.state ? Number(s.last.state.barsWindow) : NaN;
  const windowBars = Number.isFinite(winRaw) ? winRaw : total;
  return (
    `圖表：${escapeHtml(symbol)} · ${escapeHtml(resolution)} · ` +
    `${windowBars} 根 · buffer total ${total}`
  );
}
