// scripts/parse-evidence.mjs — 離線解析 ws 證據包並斷言協定假設（Task 01 驗收命令）
// 用法: node scripts/parse-evidence.mjs tests/fixtures/ws-evidence-*.json
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/parse-evidence.mjs <evidence.json>'); process.exit(2); }
const bundle = JSON.parse(readFileSync(file, 'utf8'));
const frames = bundle.frames ?? [];

let tsu = null;
const duTails = [];
let symbol = null;
for (const f of frames) {
  if (f.m === 'timescale_update') {
    let root = {};
    try { const p = typeof f.p === 'string' ? JSON.parse(f.p) : f.p; root = (Array.isArray(p) ? p[1] : p) || {}; }
    catch { continue; }
    const s = root.sds_1 && root.sds_1.s;
    if (s && s.length > (tsu?.s?.length ?? 0)) tsu = { s };
  }
  if (f.m === 'du' && f.b && f.b.sds_1 && f.b.sds_1.s) duTails.push(...f.b.sds_1.s);
  if (f.m === 'symbol_resolved') {
    const m = /"full_name":"([^"]+)"/.exec(f.p || '');
    if (m) symbol = m[1];
  }
}

const fails = [];
const ok = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg); if (!cond) fails.push(msg); };

ok(!!tsu && tsu.s.length >= 100, `timescale_update 整段歷史 ≥100 根（實得 ${tsu?.s?.length ?? 0}）`);
const v0 = tsu?.s?.[0]?.v ?? [];
ok(Array.isArray(v0) && v0.length === 6, `bar 欄位數=6 [time,o,h,l,c,vol]（實得 ${JSON.stringify(v0)}）`);
const times = tsu ? tsu.s.map(e => e.v[0]) : [];
ok(times.every((t, i) => i === 0 || (Number.isFinite(t) && t > times[i - 1])), 'time 秒級且單調遞增');
const dt = times.length > 1 ? times[1] - times[0] : 0;
console.log(`INFO  週期推定 = ${dt}s（timeframe 不在下行協定中，需由 URL/DOM 取得 → WS-NOTES）`);
for (const e of (tsu?.s ?? []).slice(0, 5).concat((tsu?.s ?? []).slice(-5))) {
  const [t, o, h, l, c] = e.v;
  ok(h >= Math.max(o, c) - 1e-9 && l <= Math.min(o, c) + 1e-9, `bar i=${e.i} OHLC 合法性 (h≥max(o,c), l≤min(o,c))`);
}
const lastBar = tsu.s[tsu.s.length - 1];
const firstTail = duTails[0];
const lastTail = duTails[duTails.length - 1];
ok(!!firstTail && firstTail.i === lastBar.i && firstTail.v[0] === lastBar.v[0],
   `最早 du 尾根與 tsu 快照最後一根指向同一根 bar（i=${lastBar.i}, time=${lastBar.v[0]}）`);
ok(!!lastTail && lastTail.v[4] !== firstTail.v[4], `最新 du close=${lastTail.v[4]}（快照後價格持續刷新，旁聽可拿到即時尾根）`);
ok(duTails.length > 0, `du 尾根串流幀數 = ${duTails.length}`);
ok(!!symbol, `symbol_resolved 符號 = ${symbol}`);
ok(tsu.s.length === 300 && tsu.s[0].i === 0 && tsu.s[299].i === 299, 's[].i 為 0..299 連續索引（300 根預設深度）');

console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
