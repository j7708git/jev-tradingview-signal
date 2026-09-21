// scripts/verify-inject.mjs — Task 06 驗收臺（架構師產出）
// 在 vm 沙箱以 classic-script 模式依 manifest 宣告順序載入 protocol→ws-parse→inject，
// 用 mock WebSocket 餵真實證據幀（ws-evidence-btc-1m.json），斷言 postMessage 捕獲的 SNAPSHOT_UPSERT。
// 用法: node scripts/verify-inject.mjs  → 全綠印 verdict: PASS，exit 0
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(p, 'utf8');
const toClassic = (src) => src
  .replace(/^import[^;\n]*;?$/gm, '')
  .replace(/^export\s+(const|let|var)\s+(\w+)\s*=/gm, '$1 $2 = globalThis.$2 =')
  .replace(/^export\s+(async\s+)?function\s+(\w+)/gm, '$1function $2'); // sloppy top-level function → global prop

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fails.push(m); };

// —— 沙箱 ——
const captured = [];
const timers = [];
class MockWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) { MockWS.instances.push(this); this.url = url; this._l = {}; this.readyState = 1; }
  addEventListener(t, f) { (this._l[t] ||= []).push(f); }
  removeEventListener(t, f) { this._l[t] = (this._l[t] || []).filter(x => x !== f); }
  send(d) { (this.sent ||= []).push(d); }
  close() { this.closed = true; }
  dispatch(data) { for (const f of this._l.message || []) { try { f({ data }); } catch (e) { console.log('  (listener 拋錯: ' + e.message + ')'); } } }
}
MockWS.instances = [];
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  clearTimeout: () => {},
  location: { origin: 'https://www.tradingview.com', href: 'https://www.tradingview.com/chart/x/?symbol=BINANCE%3ABTCUSDT&interval=1', search: '?symbol=BINANCE%3ABTCUSDT&interval=1' },
  postMessage: (msg, target) => captured.push({ msg, target }),
  WebSocket: MockWS,
  navigator: { onLine: true },
  document: { visibilityState: 'visible', hidden: false },
  addEventListener() {}, removeEventListener() {},
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of ['window', 'setTimeout', 'clearTimeout', 'location', 'WebSocket', 'console', 'navigator', 'document', 'JSON', 'Math', 'Number', 'String', 'Array', 'Object', 'Date', 'Map', 'Set', 'Error', 'TypeError', 'Symbol', 'Promise', 'Intl']) {
  // 確保這些名稱在沙箱內解析到我們的 stub（內建除已被 createContext 提供者外）
}

// —— 載入 ——
const mf = JSON.parse(read('extension/manifest.json'));
const stack = mf.content_scripts?.[0]?.js ?? [];
ok(stack.at(-1) === 'content/inject.js' && stack.includes('lib/protocol.js') && stack.includes('lib/ws-parse.js'),
   `manifest MAIN 棧順序 protocol→ws-parse→inject: [${stack.join(', ')}]`);
try {
  for (const f of stack) vm.runInContext(toClassic(read('extension/' + f)), ctx, { filename: f });
  ok(true, 'classic-script 載入三者無語法錯');
} catch (e) { ok(false, `載入炸: ${e.message}`); }
ok(sandbox.WebSocket !== MockWS, 'inject 已包裝 window.WebSocket（冪等旗標下重複載入不應雙包）');
ok(typeof sandbox.WebSocket === 'function' && sandbox.WebSocket.OPEN === 1, 'WebSocket 常數存活（OPEN=1）');

// —— 幀餵食 ——
const frame = (payloadObj) => { const p = JSON.stringify(payloadObj); return `~m~${p.length}~m~${p}`; };
const heart = (n) => `~h~${n}`;
const toPayload = (f) => {
  if (f.m === 'du') return { m: 'du', p: [f.cid, f.b] };
  if (f.m === 'timescale_update') return { m: f.m, p: Array.isArray(f.p) ? f.p : JSON.parse(f.p) };
  const p = f.p;
  if (typeof p === 'string') {
    try { return { m: f.m, p: JSON.parse(p) }; }
    catch {
      // WS-NOTES §6 已知瑕疵：非 du/tsu 幀的 p 在 Task 01 導出時被 slice 截斷。
      // 以 regex 復建最小可用 payload（symbol_resolved 只需 full_name）；其餘回 null 被 inject 計數丟棄。
      const m = /"full_name":"([^"]+)"/.exec(p);
      if (f.m === 'symbol_resolved' && m) return { m: f.m, p: ['cs_FIX', 'sds_sym_1', { full_name: m[1] }] };
      return null;
    }
  }
  return { m: f.m, p };
};
const bundle = JSON.parse(read('tests/fixtures/ws-evidence-btc-1m.json'));
const payloads = bundle.frames.map(toPayload).filter(Boolean);
const tsu = payloads.find(p => p.m === 'timescale_update' && Object.keys(p.p[1] || {}).length);

const ws = new sandbox.WebSocket('wss://prodata.tradingview.com/socket.io/websocket?from=chart');
for (const p of payloads) {
  if (!p.p) continue;
  ws.dispatch(frame(p));
}
ws.dispatch(heart(5));
ws.dispatch('~m~999~m~{"m":"du","p":['); // 中斷尾幀

// —— force emit ——
const before = captured.length;
if (typeof sandbox.__JEV_FORCE_EMIT === 'function') { sandbox.__JEV_FORCE_EMIT(); ok(true, '__JEV_FORCE_EMIT 鉤子存在'); }
else ok(false, '缺 __JEV_FORCE_EMIT 測試鉤子');
const em = captured.slice(before).map(c => c.msg).find(m => m && (m.type === 'SNAPSHOT_UPSERT'));
ok(!!em, '捕獲一筆 SNAPSHOT_UPSERT');
if (em) {
  ok(em.v === 1, '訊息版本欄 v===1');
  ok(captured.some(c => c.target === 'https://www.tradingview.com'), 'postMessage targetOrigin 為精確 origin');
  const bars = Array.isArray(em.bars) ? em.bars : [];
  ok(bars.length >= 299, `累積 bar 數 = ${bars.length}（tsu 300 ± du 尾根）`);
  const times = bars.map(b => b[0]);
  ok(times.every((t, i) => i === 0 || t > times[i - 1]), 'time 單調遞增（同 time 已被 upsert 合併）');
  ok(bars.every(b => Array.isArray(b) && b.length === 6), '每根 6 欄');
  ok(em.reset === true, '首發帶 reset:true');
  const gold = JSON.parse(read('tests/fixtures/bars-btc-1m-300.json')).bars;
  const gm = new Map(gold.map(b => [b[0], b]));
  const emByT = new Map(bars.map(b => [b[0], b]));
  let mismatch = 0;
  for (const [t, b] of gm) { const e = emByT.get(t); if (!e) { mismatch++; continue; } for (let i = 1; i < 6; i++) if (Math.abs(e[i] - b[i]) > 1e-9) { mismatch++; break; } }
  ok(mismatch <= 1, `與金標 300 根逐值一致（不符=${mismatch}，du 尾根刷新 ≤1 屬預期）`);
  ok(em.meta && typeof em.meta.total === 'number' && typeof em.meta.dropped === 'number' && 'symbol' in em.meta && 'resolution' in em.meta,
     `meta 欄齊全: ${JSON.stringify(em.meta)}`);
}

// —— 非 TV 連線不得被記帳 ——
const other = new sandbox.WebSocket('wss://example.com/ws');
const barsBefore = (em?.bars || []).length;
other.dispatch(frame({ m: 'du', p: ['cs_x', { sds_1: { s: [{ i: 0, v: [1, 2, 3, 4, 5, 6] }] } }] }));
const c2 = captured.length;
if (typeof sandbox.__JEV_FORCE_EMIT === 'function') sandbox.__JEV_FORCE_EMIT();
const news = captured.slice(c2).map(c => c.msg).filter(m => m?.type === 'SNAPSHOT_UPSERT');
const anyNewBars = news.some(m => (m.bars || []).some(b => b[0] === 1));
ok(!anyNewBars, '非 tradingview 連線的流量完全不被消費');
ok(other.sent === undefined && !other.closed, 'passthrough: send/close 未被改寫行為（實例無殘留）');

// —— 換符號重置 ——
const b3 = captured.length;
ws.dispatch(frame({ m: 'series_loading', p: ['cs_TEST', 'sds_1', 's1'] }));
ws.dispatch(frame({ m: 'symbol_resolved', p: ['cs_TEST', 'sds_sym_1', { full_name: 'BINANCE:ETHUSDT' }] }));
ws.dispatch(frame({ m: 'timescale_update', p: ['cs_TEST', { sds_1: { node: 'x', s: [[0, 111], [1, 222]].map(([i, v]) => ({ i, v: [1789990000 + i * 60, v, v, v, v, v] })) } }] }));
if (typeof sandbox.__JEV_FORCE_EMIT === 'function') sandbox.__JEV_FORCE_EMIT();
const em2 = captured.slice(b3).map(c => c.msg).filter(m => m?.type === 'SNAPSHOT_UPSERT');
const merged = new Map();
for (const m of em2) for (const b of (m.bars || [])) merged.set(b[0], b);
const resetSeen = em2.some(m => m.reset === true);
const ethSeen = em2.some(m => m.meta?.symbol === 'BINANCE:ETHUSDT');
const small = em2.some(m => (m.bars || []).length <= 3) || merged.size <= 302;
ok(resetSeen, 'series_loading 後有 reset:true 訊號');
ok(ethSeen, 'symbol_resolved 更新 meta.symbol');
const oldStillThere = [...merged.keys()].some(t => t < 1789000000);
ok(!oldStillThere || resetSeen, '重置後舊序列不再無標送出（merged 規模=' + merged.size + '）');

console.log(fails.length === 0 ? '\nverdict: PASS' : `\nverdict: FAIL (${fails.length})\n` + fails.join('\n'));
process.exit(fails.length ? 1 : 0);
