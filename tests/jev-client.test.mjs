import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JEV_ENDPOINT,
  JevError,
  evaluate,
} from '../extension/lib/jev-client.js';
import { QUESTIONS } from '../extension/lib/state-builder.js';

// 全程使用注入的 fake fetch + fake sleep，絕不觸及真實網路、絕不真等待。

const HERE = dirname(fileURLToPath(import.meta.url));
const OK_BODY = readFileSync(
  join(HERE, 'fixtures', 'jev-response-ok.json'),
  'utf8',
);
const BAD_422_BODY = readFileSync(
  join(HERE, 'fixtures', 'jev-response-422.json'),
  'utf8',
);

/** 可偵測的假 key：任何輸出路徑若未 redact，斷言就會抓到它。 */
const KEY = 'SECRET-KEY-123';

const STATE = { symbol: 'BTCUSD', resolution: '1D', bars: [] };

/** 最小 Response-like（只用 client 實際會碰的欄位）。 */
function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

/** 記錄每次 fetch 呼叫；handler(n, url, init) 回傳 Response-like。 */
function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(calls.length, url, init);
  };
  return { calls, fetchImpl };
}

/** 基本 evaluate 參數，預設注入 no-op sleep。 */
function args(overrides = {}) {
  return {
    apiKey: KEY,
    state: STATE,
    questions: QUESTIONS,
    sleep: () => {},
    ...overrides,
  };
}

/** 斷言錯誤的任何字串輸出不含假 key。 */
function assertNoLeak(err) {
  const dumped = `${err && err.message}${JSON.stringify(err)}`;
  assert.equal(
    dumped.includes(KEY),
    false,
    `apiKey 洩漏於錯誤輸出: ${dumped}`,
  );
}

// ─────────────────────────────────────────────────────────────
// 常數與錯誤型別契約
// ─────────────────────────────────────────────────────────────

test('JEV_ENDPOINT 為唯一外呼 URL 常數', () => {
  assert.equal(JEV_ENDPOINT, 'https://api.typesafe.ai/v1/systemone');
});

test('JevError: kind/message 掛實例；status/bodySnippet 可選', () => {
  const e = new JevError('x', 'y');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'JevError');
  assert.equal(e.kind, 'x');
  assert.equal(e.message, 'y');
  assert.equal('status' in e, false);
  assert.equal('bodySnippet' in e, false);

  const e2 = new JevError('a', 'b', { status: 422, bodySnippet: 'snip' });
  assert.equal(e2.status, 422);
  assert.equal(e2.bodySnippet, 'snip');
});

// ─────────────────────────────────────────────────────────────
// 成功路徑（§4.4 請求/回應 contract）
// ─────────────────────────────────────────────────────────────

test('成功路徑：URL/method/headers/body 全對，回三答案與 usage', async () => {
  const { calls, fetchImpl } = recorder(() => res(200, OK_BODY));
  const sleeps = [];

  const result = await evaluate(
    args({ fetch: fetchImpl, sleep: (ms) => sleeps.push(ms) }),
  );

  // 回應三欄原樣透傳
  assert.equal(result.model, 'jev-latest');
  assert.deepEqual(Object.keys(result.answers), [
    'direction',
    'up_10_bars',
    'trend_strength',
  ]);
  assert.equal(result.answers.direction.choice, 'long');
  assert.equal(result.answers.up_10_bars.noul, 0.58);
  assert.equal(result.answers.trend_strength.score, 'moderate');
  assert.deepEqual(result.usage, { input_tokens: 1234, output_tokens: 56 });

  // 請求完全正確
  assert.equal(calls.length, 1);
  assert.equal(sleeps.length, 0);
  const { url, init } = calls[0];
  assert.equal(url, JEV_ENDPOINT);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers['User-Agent'], 'jev-signal/0.1');
  const body = JSON.parse(init.body);
  assert.deepEqual(body, {
    model: 'jev-latest',
    state: STATE,
    questions: QUESTIONS,
  });
});

test('成功路徑：model 參數進入 body，回應 model 為準', async () => {
  const { calls, fetchImpl } = recorder(() => res(200, OK_BODY));
  const result = await evaluate(
    args({ model: 'jev-preview', fetch: fetchImpl }),
  );
  assert.equal(JSON.parse(calls[0].init.body).model, 'jev-preview');
  assert.equal(result.model, 'jev-latest'); // 來自 fixture 回應
});

test('no_key：空/未定義 apiKey 不發 fetch', async () => {
  for (const apiKey of [undefined, '', null]) {
    const { calls, fetchImpl } = recorder(() => res(200, OK_BODY));
    await assert.rejects(
      () => evaluate(args({ apiKey, fetch: fetchImpl })),
      (err) => {
        assert.ok(err instanceof JevError);
        assert.equal(err.kind, 'no_key');
        return true;
      },
    );
    assert.equal(calls.length, 0, 'no_key 不得發出任何請求');
  }
});

// ─────────────────────────────────────────────────────────────
// 429 / 529 退避重試
// ─────────────────────────────────────────────────────────────

test('429 序列 fail,fail,ok → 成功、fetch=3、sleep=[500,1000]', async () => {
  const seq = [429, 429, 200];
  const { calls, fetchImpl } = recorder((n) =>
    seq[n - 1] === 200
      ? res(200, OK_BODY)
      : res(429, `{"detail":"slow down ${KEY}"}`),
  );
  const sleeps = [];

  const result = await evaluate(
    args({ fetch: fetchImpl, sleep: (ms) => sleeps.push(ms) }),
  );

  assert.equal(result.answers.direction.choice, 'long');
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('429×4 → rate_exhausted、fetch=4、sleep=[500,1000,2000]、無洩鑰', async () => {
  const { calls, fetchImpl } = recorder(() =>
    res(429, `{"detail":"rate limited for ${KEY}"}`),
  );
  const sleeps = [];

  await assert.rejects(
    () =>
      evaluate(args({ fetch: fetchImpl, sleep: (ms) => sleeps.push(ms) })),
    (err) => {
      assert.ok(err instanceof JevError);
      assert.equal(err.kind, 'rate_exhausted');
      assert.equal(err.status, 429);
      assert.ok(err.bodySnippet.includes('[redacted]'));
      assertNoLeak(err);
      return true;
    },
  );

  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [500, 1000, 2000]);
});

test('529×4 → overloaded、fetch=4、sleep 三次', async () => {
  const { calls, fetchImpl } = recorder(() =>
    res(529, `{"detail":"overloaded ${KEY}"}`),
  );
  const sleeps = [];

  await assert.rejects(
    () =>
      evaluate(args({ fetch: fetchImpl, sleep: (ms) => sleeps.push(ms) })),
    (err) => {
      assert.ok(err instanceof JevError);
      assert.equal(err.kind, 'overloaded');
      assert.equal(err.status, 529);
      assertNoLeak(err);
      return true;
    },
  );

  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [500, 1000, 2000]);
});

test('529 序列後成功 → 不拋、fetch=2、sleep=[500]', async () => {
  const seq = [529, 200];
  const { calls, fetchImpl } = recorder((n) =>
    seq[n - 1] === 200 ? res(200, OK_BODY) : res(529, '{"detail":"busy"}'),
  );
  const sleeps = [];

  const result = await evaluate(
    args({ fetch: fetchImpl, sleep: (ms) => sleeps.push(ms) }),
  );

  assert.equal(result.model, 'jev-latest');
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [500]);
});

// ─────────────────────────────────────────────────────────────
// 非重試錯誤：一次即拋
// ─────────────────────────────────────────────────────────────

test('401 → auth_401、fetch=1、不重試、bodySnippet redact', async () => {
  const { calls, fetchImpl } = recorder(() =>
    res(401, `{"detail":"invalid key ${KEY}"}`),
  );
  const sleeps = [];

  await assert.rejects(
    () =>
      evaluate(args({ fetch: fetchImpl, sleep: (ms) => sleeps.push(ms) })),
    (err) => {
      assert.ok(err instanceof JevError);
      assert.equal(err.kind, 'auth_401');
      assert.equal(err.status, 401);
      assert.ok(err.bodySnippet.includes('[redacted]'));
      assert.equal(err.bodySnippet.includes(KEY), false);
      assertNoLeak(err);
      return true;
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('403 → auth_401（同 401 處理）', async () => {
  const { calls, fetchImpl } = recorder(() => res(403, `{"detail":"${KEY}"}`));
  await assert.rejects(
    () => evaluate(args({ fetch: fetchImpl })),
    (err) => {
      assert.equal(err.kind, 'auth_401');
      assert.equal(err.status, 403);
      assertNoLeak(err);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test('422 → bad_request_422，bodySnippet 含 detail 前段', async () => {
  const { calls, fetchImpl } = recorder(() => res(422, BAD_422_BODY));
  const sleeps = [];

  await assert.rejects(
    () =>
      evaluate(args({ fetch: fetchImpl, sleep: (ms) => sleeps.push(ms) })),
    (err) => {
      assert.ok(err instanceof JevError);
      assert.equal(err.kind, 'bad_request_422');
      assert.equal(err.status, 422);
      assert.ok(err.bodySnippet.includes('"detail"'));
      assert.ok(err.bodySnippet.includes('field required'));
      return true;
    },
  );

  assert.equal(calls.length, 1, '422 不得重試');
  assert.deepEqual(sleeps, []);
});

test('400 → bad_request_422（status 帶實際碼 400）', async () => {
  const { calls, fetchImpl } = recorder(() => res(400, '{"detail":"bad"}'));
  await assert.rejects(
    () => evaluate(args({ fetch: fetchImpl })),
    (err) => {
      assert.equal(err.kind, 'bad_request_422');
      assert.equal(err.status, 400);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test('500 → offhost、fetch=1、無洩鑰', async () => {
  const { calls, fetchImpl } = recorder(() =>
    res(500, `{"detail":"boom ${KEY}"}`),
  );
  const sleeps = [];

  await assert.rejects(
    () =>
      evaluate(args({ fetch: fetchImpl, sleep: (ms) => sleeps.push(ms) })),
    (err) => {
      assert.ok(err instanceof JevError);
      assert.equal(err.kind, 'offhost');
      assert.equal(err.status, 500);
      assertNoLeak(err);
      return true;
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('429 後遇 422 → 重試一次後即拋 bad_request_422（非 429/529 不續重試）', async () => {
  const seq = [429, 422];
  const { calls, fetchImpl } = recorder((n) =>
    seq[n - 1] === 429 ? res(429, '{"detail":"slow"}') : res(422, BAD_422_BODY),
  );
  const sleeps = [];

  await assert.rejects(
    () =>
      evaluate(args({ fetch: fetchImpl, sleep: (ms) => sleeps.push(ms) })),
    (err) => {
      assert.equal(err.kind, 'bad_request_422');
      assert.equal(err.status, 422);
      return true;
    },
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [500]);
});

// ─────────────────────────────────────────────────────────────
// 網路 / 逾時 / 非 JSON
// ─────────────────────────────────────────────────────────────

test('fetch 拋 TypeError → offline、fetch=1、message redact', async () => {
  const { calls, fetchImpl } = recorder(() => {
    throw new TypeError(`fetch failed for ${KEY} (undici)`);
  });

  await assert.rejects(
    () => evaluate(args({ fetch: fetchImpl })),
    (err) => {
      assert.ok(err instanceof JevError);
      assert.equal(err.kind, 'offline');
      assert.ok(err.message.includes('[redacted]'));
      assertNoLeak(err);
      return true;
    },
  );

  assert.equal(calls.length, 1);
});

test('timeout：fetch 掛起 + timeoutMs 觸發 → timeout、無洩鑰', async () => {
  const { calls, fetchImpl } = recorder(() => new Promise(() => {}));

  await assert.rejects(
    () => evaluate(args({ fetch: fetchImpl, timeoutMs: 15 })),
    (err) => {
      assert.ok(err instanceof JevError);
      assert.equal(err.kind, 'timeout');
      assert.match(err.message, /timed out after 15ms/);
      assertNoLeak(err);
      return true;
    },
  );

  assert.equal(calls.length, 1);
});

test('timeout：fetch 依 AbortSignal 拒絕（AbortError）→ timeout', async () => {
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });

  await assert.rejects(
    () => evaluate(args({ fetch: fetchImpl, timeoutMs: 10 })),
    (err) => {
      assert.equal(err.kind, 'timeout');
      return true;
    },
  );
});

test('非 JSON 200 回應 → offhost，bodySnippet 已 redact', async () => {
  const { calls, fetchImpl } = recorder(() =>
    res(200, `<html><body>gateway error ${KEY}</body></html>`),
  );

  await assert.rejects(
    () => evaluate(args({ fetch: fetchImpl })),
    (err) => {
      assert.ok(err instanceof JevError);
      assert.equal(err.kind, 'offhost');
      assert.equal(err.status, 200);
      assert.equal(err.bodySnippet.includes(KEY), false);
      assert.ok(err.bodySnippet.includes('[redacted]'));
      assertNoLeak(err);
      return true;
    },
  );

  assert.equal(calls.length, 1);
});

test('200 但 JSON 為 null → offhost（非物件 payload）', async () => {
  const { fetchImpl } = recorder(() => res(200, 'null'));
  await assert.rejects(
    () => evaluate(args({ fetch: fetchImpl })),
    (err) => {
      assert.equal(err.kind, 'offhost');
      assert.equal(err.status, 200);
      return true;
    },
  );
});

test('bodySnippet 截 200 字且先 redact', async () => {
  const longTail = 'x'.repeat(250) + KEY;
  const { fetchImpl } = recorder(() => res(500, longTail));

  await assert.rejects(
    () => evaluate(args({ fetch: fetchImpl })),
    (err) => {
      assert.equal(err.kind, 'offhost');
      assert.ok(err.bodySnippet.length <= 200);
      assert.equal(err.bodySnippet.includes(KEY), false);
      assertNoLeak(err);
      return true;
    },
  );
});
