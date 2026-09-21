// lib/jev-client.js — 全案唯一外呼出口（ARCHITECTURE §4.4 / §5）。
//
// 純 ESM、零依賴、不得引用 chrome.* 或任何 Node／瀏覽器專屬 API；
// 可直接在 Node `import` 以便以注入的 fake fetch 測試（不碰真實網路）。
//
// 對外契約：
//   JEV_ENDPOINT                     常數單點（唯一 URL 出口）
//   JevError                         統一錯誤型別 {kind, message, status?, bodySnippet?}
//   evaluate({...}) → { model, answers, usage }
//
// 安全紀律（§5）：
//   apiKey 只在本檔內短暫存在，於 fetch 瞬間組成 Authorization header；
//   任何拋出的 message / bodySnippet 一律先過 redact() 剝除 key 片段；
//   本檔不做任何 console 輸出，也不把請求物件（含 header）外流。

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** User-Agent 版本單點；與 manifest version 0.1.0 對齊。 */
export const USER_AGENT = 'jev-signal/0.1';

/** 429/529 退避序列（毫秒）；長度同時決定最大重試次數。 */
const RETRY_DELAYS = [500, 1000, 2000];
const MAX_RETRIES = RETRY_DELAYS.length; // 3 次重試 → 共 4 次嘗試

/** bodySnippet 截斷上限（字元）。 */
const SNIPPET_LIMIT = 200;

const REDACTED = '[redacted]';

/**
 * 統一錯誤型別。所有 evaluate() 的失敗路徑皆拋此型別。
 */
export class JevError extends Error {
  /**
   * @param {string} kind 正規化錯誤種類（no_key / auth_401 / ...）
   * @param {string} message 已 redact 的人類可讀訊息
   * @param {{status?: number, bodySnippet?: string}} [opts]
   */
  constructor(kind, message, { status, bodySnippet } = {}) {
    super(message);
    this.name = 'JevError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (bodySnippet !== undefined) this.bodySnippet = bodySnippet;
  }
}

/**
 * 私有：把字串中所有 apiKey 出現處剝成 [redacted]。
 * 使用 split/join 以避免 regex escaping 問題。
 * @param {unknown} value
 * @param {string} apiKey
 * @returns {string}
 */
function redact(value, apiKey) {
  let out = value == null ? '' : String(value);
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    out = out.split(apiKey).join(REDACTED);
  }
  return out;
}

/**
 * 私有：回應體 → 安全的 bodySnippet（先 redact、後截 200 字）。
 * @param {unknown} text
 * @param {string} apiKey
 * @returns {string}
 */
function makeSnippet(text, apiKey) {
  return redact(text, apiKey).slice(0, SNIPPET_LIMIT);
}

/**
 * 私有：盡可能讀出回應體文字；失敗時回空字串（不讓讀體錯誤蓋過正規化）。
 * @param {{text?: Function, json?: Function}} res
 * @returns {Promise<string>}
 */
async function readBody(res) {
  try {
    if (res && typeof res.text === 'function') return await res.text();
    if (res && typeof res.json === 'function') return JSON.stringify(await res.json());
  } catch {
    /* 讀體失敗一律視為空字串 */
  }
  return '';
}

/**
 * 私有：單次請求，含 timeoutMs 計時與網路錯誤正規化。
 * 以 Promise.race 實作逾時，因此即使注入的 fetch 不理會 AbortSignal 也能逾時。
 * @returns {Promise<object>} Response-like
 */
async function fetchOnce({ fetchImpl, init, timeoutMs, apiKey }) {
  const controller =
    typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (controller) controller.abort();
      reject(new JevError('timeout', `request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const requestPromise = Promise.resolve().then(() =>
    fetchImpl(JEV_ENDPOINT, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    }),
  );

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } catch (err) {
    if (err instanceof JevError) throw err; // 自家計時器
    if (timedOut || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
      throw new JevError('timeout', `request timed out after ${timeoutMs}ms`);
    }
    if (err instanceof TypeError) {
      // undici 網路錯典型為 TypeError；message 仍先 redact 再外拋。
      throw new JevError('offline', redact(`network error: ${err.message}`, apiKey));
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 呼叫 systemone 並回傳正規化結果。
 *
 * @param {object} args
 * @param {string} args.apiKey  API key（空/未定義 → no_key，且不發 fetch）
 * @param {string} [args.model='jev-latest']
 * @param {object} args.state   §4.4 state 物件
 * @param {object} args.questions §4.4 questions 物件（通常為 state-builder 的 QUESTIONS）
 * @param {Function} [args.fetch=globalThis.fetch] 可注入（測試用 fake）
 * @param {number} [args.timeoutMs=10000] 單次嘗試逾時
 * @param {Function} [args.sleep] 可注入的延遲函式（測試傳 () => {} 以跳過真等待）
 * @returns {Promise<{model: unknown, answers: unknown, usage: unknown}>}
 * @throws {JevError}
 */
export async function evaluate({
  apiKey,
  model = 'jev-latest',
  state,
  questions,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!apiKey) {
    throw new JevError('no_key', 'API key is not set');
  }

  const init = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ model, state, questions }),
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const res = await fetchOnce({ fetchImpl, init, timeoutMs, apiKey });
    const status = res.status;

    // —— 成功：解析 JSON；解析失敗視為 offhost（回應體仍先 redact）——
    if (res.ok) {
      const text = await readBody(res);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new JevError('offhost', `invalid JSON response (status ${status})`, {
          status,
          bodySnippet: makeSnippet(text, apiKey),
        });
      }
      if (data === null || typeof data !== 'object') {
        throw new JevError('offhost', `unexpected JSON payload (status ${status})`, {
          status,
          bodySnippet: makeSnippet(text, apiKey),
        });
      }
      return { model: data.model, answers: data.answers, usage: data.usage };
    }

    // —— 429 / 529：唯一可重試者 ——
    if (status === 429 || status === 529) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      const bodySnippet = makeSnippet(await readBody(res), apiKey);
      if (status === 429) {
        throw new JevError(
          'rate_exhausted',
          `rate limited: retries exhausted (status ${status})`,
          { status, bodySnippet },
        );
      }
      throw new JevError(
        'overloaded',
        `service overloaded: retries exhausted (status ${status})`,
        { status, bodySnippet },
      );
    }

    // —— 其餘錯誤：不重試，一次即拋 ——
    const bodySnippet = makeSnippet(await readBody(res), apiKey);

    if (status === 401 || status === 403) {
      throw new JevError('auth_401', `authentication failed (status ${status})`, {
        status,
        bodySnippet,
      });
    }
    if (status === 400 || status === 422) {
      throw new JevError('bad_request_422', `bad request (status ${status})`, {
        status,
        bodySnippet,
      });
    }
    throw new JevError('offhost', `unexpected response (status ${status})`, {
      status,
      bodySnippet,
    });
  }

  // 不可達：最後一次迭代必定 return 或 throw。
  throw new JevError('offhost', 'unreachable');
}
