// scripts/live-jev.mjs — 對真实 TypeSafe API 打一次金標預測（架構師驗收專用，pi 不得執行）
// 金鑰解析順序：env JEV_API_KEY → ../jev-proxy/.env（就近復用既有鑰匙，絕不印出）
// 用法: node scripts/live-jev.mjs [--state tests/fixtures/expected-state.json]
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const loadKey = () => {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY.trim();
  const envPath = resolve(import.meta.dirname, '../../jev-proxy/.env');
  if (existsSync(envPath)) {
    const m = /^JEV_API_KEY=(.+)$/m.exec(readFileSync(envPath, 'utf8'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
};

const key = loadKey();
if (!key) { console.error('verdict: FAIL — 找不到 JEV_API_KEY（env 或 ../jev-proxy/.env）'); process.exit(1); }

const { evaluate, JevError } = await import('../extension/lib/jev-client.js');
const { QUESTIONS } = await import('../extension/lib/state-builder.js');
const stateArg = process.argv.indexOf('--state');
const statePath = stateArg >= 0 ? process.argv[stateArg + 1] : 'tests/fixtures/expected-state.json';
const state = JSON.parse(readFileSync(statePath, 'utf8'));

const t0 = Date.now();
try {
  const r = await evaluate({ apiKey: key, state, questions: QUESTIONS });
  const ms = Date.now() - t0;
  const a = r.answers ?? {};
  const ids = ['direction', 'up_10_bars', 'trend_strength'];
  const missing = ids.filter(i => !(i in a));
  console.log(JSON.stringify({ model: r.model, answers: a, usage: r.usage, ms }, null, 2));
  const cost = ((r.usage?.input_tokens ?? 0) * 0.042 + (r.usage?.output_tokens ?? 0) * 0) / 1e6;
  console.log(`cost=$${cost.toFixed(5)}  judge=${r.model}`);
  console.log(missing.length === 0 && a.direction?.choice && typeof a.direction?.confidence === 'number'
    ? `verdict: PASS (${ms}ms)` : `verdict: FAIL — 缺答案欄 ${missing.join(',') || 'shape 不對'}`);
  process.exit(missing.length === 0 ? 0 : 1);
} catch (e) {
  const kind = e instanceof JevError ? e.kind : 'unexpected';
  const msg = String(e?.message || e).replaceAll(key, '[redacted]');
  console.error(`verdict: FAIL — ${kind}: ${msg.slice(0, 300)}`);
  process.exit(1);
}
