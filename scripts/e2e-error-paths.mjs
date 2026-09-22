// scripts/e2e-error-paths.mjs — Task 09 清單⑤：錯誤路徑真機驗收（架構師執行，pi 不得跑）
// 情境 A：偽 key → RUN_PREDICTION 應回 auth_401 → Panel DOM 顯示中文 auth 提示
// 情境 B：斷網   → RUN_PREDICTION 應回 offline   → Panel DOM 顯示中文 offline 提示
// 情境 C：換回真 key → 回復正常（ok:true），確認錯誤狀態沒有卡死面板
// 斷網模擬：CDP attach SW target，Network.emulateNetworkConditions{offline}＋Fetch.failRequest 雙重保證
//         （兩者任一生效即真 TypeError → jev-client 正規化為 offline）。
// 前置：已有一個載入本擴充的 Chromium 開著 --remote-debugging-port=<port>（Playwright Chromium）。
// 用法：node scripts/e2e-error-paths.mjs [port] [--only bad-key|offline|recover]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const PORT = (args.find((a) => /^\d+$/.test(a)) || '9333');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const ROOT = join(import.meta.dirname, '..');
const BAD_KEY = 'jev-09c5-bogus-key-not-real-000';

function readKey() {
  const envPath = join(ROOT, '..', 'jev-proxy', '.env');
  const txt = readFileSync(envPath, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*JEV_API_KEY\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  throw new Error('JEV_API_KEY not found in jev-proxy/.env');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = async (path, init) => (await fetch(`http://127.0.0.1:${PORT}${path}`, init)).json();

class Target {
  constructor(wsUrl, label) { this.wsUrl = wsUrl; this.label = label; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      else if (m.method && this.handlers.has(m.method)) for (const fn of this.handlers.get(m.method)) fn(m.params || {});
    };
    await this.send('Runtime.enable');
    return this;
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
  send(method, params = {}) {
    return new Promise((res) => { const i = ++this.id; this.pending.set(i, res); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
    return r.result?.result?.value;
  }
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const want = (s) => !ONLY || ONLY === s;

// ── 探測擴充 ──────────────────────────────────────────────────────────
const list = await http('/json/list');
let extId = null;
const swTarget = list.find((t) => t.type === 'service_worker' && (t.url || '').includes('/background/service-worker.js'));
if (swTarget) extId = new URL(swTarget.url).host;
if (!extId) {
  const manifestName = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8')).name;
  const pageTarget = list.find((t) => t.type === 'page');
  const p = await new Target(pageTarget.webSocketDebuggerUrl, 'extmgr').open();
  await p.send('Page.enable'); await p.send('Page.navigate', { url: 'chrome://extensions' }); await sleep(3000);
  const raw = await p.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 40 && !document.querySelector('extensions-manager'); i++) await wait(250);
    const mgr = document.querySelector('extensions-manager');
    if (!mgr) return 'NO_MANAGER';
    const items = [...mgr.shadowRoot.querySelector('extensions-item-list').shadowRoot.querySelectorAll('extensions-item')];
    return JSON.stringify(items.map(it => ({ id: it.id, name: (it.shadowRoot.querySelector('#name')?.textContent || '').trim() })));
  })()`);
  let items = [];
  try { items = JSON.parse(raw); } catch {}
  const mine = items.find((it) => (it.name || '').includes(manifestName));
  if (!mine) { console.log('FATAL: 找不到本擴充', JSON.stringify(items)); process.exit(2); }
  extId = mine.id;
}
console.log('extension id:', extId);
check('擴充已載入（未封裝）', true, extId);

// ── Panel（沿用 09fix：擴充頁 sender 走 panel 分支）────────────────────
const panelTabInfo = await http(`/json/new?${encodeURIComponent(`chrome-extension://${extId}/sidepanel/sidepanel.html`)}`, { method: 'PUT' });
await sleep(3000);
const panel = await new Target(panelTabInfo.webSocketDebuggerUrl, 'panel').open();
const setKey = (k) => panel.eval(`(async () => { await chrome.storage.local.set({ jevApiKey: ${JSON.stringify(k)}, jevModel: 'jev-latest', bars: 300, featuresOn: true }); const g = await chrome.storage.local.get(['jevApiKey']); return (g.jevApiKey || '').length; })()`);
const getCount = async () => {
  const raw = await panel.eval(`new Promise(function(res){chrome.runtime.sendMessage({v:1,type:'GET_STATE'},function(r){res(JSON.stringify({count:(r&&r.count)||0,symbol:r&&r.symbol}));});setTimeout(function(){res('TIMEOUT')},6000)})`);
  try { return JSON.parse(raw); } catch { return { count: 0 }; }
};
const runPredict = () => panel.eval(`new Promise((resolve) => {
  const t0 = Date.now();
  chrome.runtime.sendMessage({ v: 1, type: 'RUN_PREDICTION' }, (resp) => {
    resolve(JSON.stringify({ ms: Date.now() - t0, ok: !!(resp && resp.ok), err: resp && resp.error ? (resp.error.kind || resp.error) : null }));
  });
  setTimeout(() => resolve('TIMEOUT'), 90000);
})`, true);
const readResultDom = () => panel.eval(`(function(){const r=document.getElementById('result');return r? r.innerText : null;})()`);

// ── 準備：真 TV 快照（錯誤路徑也需 ≥50 根才會走到 API）────────────────
if (want('bad-key') || want('offline')) {
  await setKey(want('bad-key') ? BAD_KEY : readKey()); // offline 情境用真/偽皆可，fetch 都會斷
  await http(`/json/new?${encodeURIComponent('https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT&interval=15')}`, { method: 'PUT' });
  console.log('（等待 TradingView 載入＋ws 旁聽… 16s）');
  await sleep(16000);
  let count = 0;
  for (let i = 0; i < 15; i++) {
    const s = await getCount();
    count = s.count || 0;
    if (count >= 50) break;
    await sleep(2000);
  }
  check('快照已就緒（count≥50，250–400 反污染）', count >= 50 && count <= 400, `count=${count}`);
}

// ── 情境 A：錯 key → auth_401 ─────────────────────────────────────────
if (want('bad-key')) {
  const setLen = await setKey(BAD_KEY);
  check('偽金鑰已寫入 storage', setLen === BAD_KEY.length, `len=${setLen}`);
  const raw = String(await runPredict());
  let run = {};
  try { run = JSON.parse(raw); } catch {}
  check('A1 RUN_PREDICTION 回 ok:false / kind=auth_401', run.ok === false && run.err === 'auth_401', `${run.ms}ms err=${run.err}`);
  check('A2 回應序列化不含金鑰字串（redact）', !raw.includes(BAD_KEY), `raw.len=${raw.length}`);
  await sleep(1200);
  const dom = String((await readResultDom()) || '');
  check('A3 Panel DOM 顯示「預測失敗」＋kind=auth_401', dom.includes('預測失敗') && dom.includes('auth_401'), dom.replace(/\n/g, ' | ').slice(0, 160));
  check('A4 中文提示逐字正確', dom.includes('API key 已被拒絕（401）'), '');
  check('A5 免責固定語在場', dom.includes('不構成投資建議'), '');
  check('A6 DOM 不含金鑰字串', !dom.includes(BAD_KEY), '');
}

// ── 情境 B：斷網 → offline（CDP 對 SW target 雙重模擬）────────────────
if (want('offline')) {
  // 先叫醒 SW 並取得其 target
  await getCount();
  await sleep(800);
  const l2 = await http('/json/list');
  const swt = l2.find((t) => t.type === 'service_worker' && (t.url || '').includes('/background/service-worker.js'));
  check('B0 SW target 可 attach', !!swt, swt ? 'found' : 'missing');
  let blocked = false;
  if (swt) {
    const sw = await new Target(swt.webSocketDebuggerUrl, 'sw').open();
    sw.on('Fetch.requestPaused', async (ev) => {
      try { await sw.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'Failed' }); } catch {}
    });
    await sw.send('Fetch.enable', { patterns: [{ urlPattern: '*api.typesafe.ai*', requestStage: 'Request' }] });
    await sw.send('Network.enable');
    await sw.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none' });
    blocked = true;
    console.log('（已對 SW target 啟用 offline＋Fetch.failRequest 雙重阻斷）');
    const raw = String(await runPredict());
    let run = {};
    try { run = JSON.parse(raw); } catch {}
    check('B1 RUN_PREDICTION 回 ok:false / kind=offline', run.ok === false && run.err === 'offline', `${run.ms}ms err=${run.err}`);
    await sleep(1200);
    const dom = String((await readResultDom()) || '');
    check('B2 Panel DOM 顯示「預測失敗」＋kind=offline', dom.includes('預測失敗') && dom.includes('offline'), dom.replace(/\n/g, ' | ').slice(0, 160));
    check('B3 中文提示逐字正確', dom.includes('離線或防火牆擋了 api.typesafe.ai'), '');
    // 解除阻斷
    await sw.send('Fetch.disable');
    await sw.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }
  if (!blocked) check('B1 RUN_PREDICTION 回 ok:false / kind=offline', false, '無法 attach SW，改用 --host-resolver-rules 重跑');
}

// ── 情境 C：換回真 key → 回復正常 ─────────────────────────────────────
if (want('recover')) {
  const setLen = await setKey(readKey());
  check('C0 真金鑰已寫回', setLen > 10, `len=${setLen}`);
  const raw = String(await runPredict());
  let run = {};
  try { run = JSON.parse(raw); } catch {}
  check('C1 RUN_PREDICTION 回 ok:true（錯誤後未卡死）', run.ok === true, `${run.ms}ms`);
  check('C2 回應序列化不含真金鑰', !raw.includes(readKey()), `raw.len=${raw.length}`);
  await sleep(1200);
  const dom = String((await readResultDom()) || '');
  check('C3 Panel DOM 回到正常結果渲染', dom.length > 20 && !dom.includes('預測失敗'), dom.replace(/\n/g, ' | ').slice(0, 160));
}

console.log('\n===== 摘要 =====');
const fails = results.filter((r) => !r.ok);
console.log(`${results.length - fails.length}/${results.length} PASS`);
if (fails.length) console.log('未過：', fails.map((f) => f.name).join('、'));
process.exit(fails.length ? 1 : 0);
