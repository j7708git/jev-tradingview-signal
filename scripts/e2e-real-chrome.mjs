// scripts/e2e-real-chrome.mjs — 真端到端驗收（架構師執行，pi 不得跑）
// 前置：已有一個載入本擴充的 Chromium 開著 --remote-debugging-port=<port>
//       （branded Chrome 153 已移除 --load-extension；用 Playwright 的 Chromium）
// 流程：options 頁寫入金鑰（金鑰自 ../jev-proxy/.env 讀取，全程不印出）
//   → 開真 TradingView 圖表等 ws 旁聽 → 開 Side Panel 頁看是否顯示 buffer
//   → 按「預測」→ 讀回應與 DOM 結果 → 印出判定。
// 用法：node scripts/e2e-real-chrome.mjs [port]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.argv[2] || '9333';
const ROOT = join(import.meta.dirname, '..');

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
  constructor(wsUrl, label) { this.wsUrl = wsUrl; this.label = label; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    };
    await this.send('Runtime.enable');
    return this;
  }
  send(method, params = {}) {
    return new Promise((res) => { const i = ++this.id; this.pending.set(i, res); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
    return r.result?.result?.value;
  }
  async goto(url, waitMs = 2500) {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
    await sleep(waitMs);
  }
}

async function newTab(url) {
  const t = await http(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return t;
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const list = await http('/json/list');
let extId = null;
const swTarget = list.find((t) => t.type === 'service_worker' && (t.url || '').includes('/background/service-worker.js'));
if (swTarget) extId = new URL(swTarget.url).host;

if (!extId) {
  // SW 休眠中：用 chrome://extensions 反查未封裝擴充的 id（比對 manifest 名稱）
  const manifestName = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8')).name;
  const pageTarget = list.find((t) => t.type === 'page');
  const p = await new Target(pageTarget.webSocketDebuggerUrl, 'extmgr').open();
  await p.goto('chrome://extensions', 3000);
  const raw = await p.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 40 && !document.querySelector('extensions-manager'); i++) await wait(250);
    const mgr = document.querySelector('extensions-manager');
    if (!mgr) return 'NO_MANAGER';
    const items = [...mgr.shadowRoot.querySelector('extensions-item-list').shadowRoot.querySelectorAll('extensions-item')];
    return JSON.stringify(items.map(it => ({ id: it.id, name: (it.shadowRoot.querySelector('#name')?.textContent || '').trim() })));
  })()`);
  let items = [];
  try { items = JSON.parse(raw); } catch { console.log('extensions 頁解析失敗:', String(raw).slice(0, 120)); }
  const mine = items.find((it) => (it.name || '').includes(manifestName));
  if (!mine) {
    console.log('FATAL: chrome://extensions 找不到本擴充。清單：', JSON.stringify(items));
    process.exit(2);
  }
  extId = mine.id;
  console.log(`（SW 休眠中，已自 chrome://extensions 取得 id）`);
}
console.log('extension id:', extId);
check('擴充已載入（未封裝）', true, extId);

// ── Phase 1: 金鑰寫入（值不印出）
const key = readKey();
const optTabInfo = await newTab(`chrome-extension://${extId}/options/options.html`);
await sleep(1800);
const opt = await new Target(optTabInfo.webSocketDebuggerUrl, 'options').open();
const setRes = await opt.eval(`(async () => {
  await chrome.storage.local.set({ jevApiKey: ${JSON.stringify(key)}, jevModel: 'jev-latest', bars: 300, featuresOn: true });
  const got = await chrome.storage.local.get(['jevApiKey', 'jevModel', 'bars']);
  return { keyLen: (got.jevApiKey || '').length, model: got.jevModel, bars: got.bars };
})()`);
check('金鑰已寫入 chrome.storage.local', setRes && setRes.keyLen > 10 && setRes.model === 'jev-latest',
  `keyLen=${setRes?.keyLen} model=${setRes?.model} bars=${setRes?.bars}`);

// ── Phase 2: 真 TradingView 圖表
const tvTabInfo = await newTab('https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT&interval=15');
await sleep(16000);
const tv = await new Target(tvTabInfo.webSocketDebuggerUrl, 'tv').open();
const tvInfo = await tv.eval(`JSON.stringify({ url: location.href.slice(0, 70), title: document.title.slice(0, 50), canvases: document.querySelectorAll('canvas').length })`);
check('TradingView 圖表已載入', /canvases":\d+/.test(tvInfo || '') && !/canvases":0/.test(tvInfo || ''), String(tvInfo).slice(0, 120));

// ── Phase 3: Side Panel 頁（真 chrome.* 路徑）
// MV3 SW 可能剛被回收，恢復需 1–3 秒（尾根 upsert → 首觸全量重送）；耐心輪詢到根數足夠。
const panelTabInfo = await newTab(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
await sleep(3500);
const panel = await new Target(panelTabInfo.webSocketDebuggerUrl, 'panel').open();
const readStatus = () => panel.eval(`(function(){const s=document.getElementById('status-line');const b=document.getElementById('predict-btn');return JSON.stringify({status:s?s.textContent:null, disabled:b?b.disabled:null});})()`);
const getCount = async () => {
  const raw = await panel.eval(`new Promise(function(res){chrome.runtime.sendMessage({v:1,type:'GET_STATE'},function(r){res(JSON.stringify({count:(r&&r.count)||0,symbol:r&&r.symbol,resolution:r&&r.resolution}));});setTimeout(function(){res('TIMEOUT')},6000)})`);
  try { return JSON.parse(raw); } catch { return { count: 0, raw: String(raw).slice(0, 80) }; }
};
let st = {};
let count = 0;
let waited = 0;
for (let i = 0; i < 15; i++) {
  st = JSON.parse((await readStatus()) || '{}');
  const s = await getCount();
  count = s.count || 0;
  if (count >= 50) break;
  await sleep(2000);
  waited += 2;
}
console.log(`（快照等待 ${waited}s；最終 count=${count}），status="${st.status}"`);
check('Side Panel 讀到圖表快照（content→SW→panel 全鏈）', count >= 50, String(st.status).slice(0, 140));
check('快照為單一主圖 series（≈300±尾根，666＝污染）', count >= 250 && count <= 400, `count=${count}`);
check('預測按鈕已啟用（快照足夠）', st.disabled === false, `count=${count} disabled=${st.disabled}`);

// ── Phase 4: 按下預測（真打 TypeSafe API）
const runRes = await panel.eval(`new Promise((resolve) => {
  const t0 = Date.now();
  chrome.runtime.sendMessage({ v: 1, type: 'RUN_PREDICTION' }, (resp) => {
    resolve(JSON.stringify({ ms: Date.now() - t0, ok: !!(resp && resp.ok), err: resp && resp.error ? (resp.error.kind || resp.error) : null, hasResult: !!(resp && resp.result), model: resp && resp.result && resp.result.model, answerKeys: resp && resp.result && resp.result.answer ? Object.keys(resp.result.answer) : null }));
  });
  setTimeout(() => resolve('TIMEOUT'), 90000);
})`, true);
console.log('RUN_PREDICTION 回應:', String(runRes).slice(0, 300));
let run = {};
try { run = JSON.parse(runRes); } catch {}
check('RUN_PREDICTION 成功（真 TypeSafe API 往返）', run.ok === true && run.hasResult === true, `${run.ms}ms model=${run.model}`);
await sleep(1200);
const dom = await panel.eval(`(function(){const r=document.getElementById('result');return r? r.innerText.slice(0, 400) : null;})()`);
check('結果已渲染進 Side Panel DOM', !!dom && dom.length > 20, String(dom).replace(/\n/g, ' | ').slice(0, 220));

console.log('\n===== 摘要 =====');
const fails = results.filter((r) => !r.ok);
console.log(`${results.length - fails.length}/${results.length} PASS`);
if (fails.length) console.log('未過：', fails.map((f) => f.name).join('、'));
process.exit(fails.length ? 1 : 0);
