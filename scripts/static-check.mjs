// scripts/static-check.mjs — 架構守門（Task 02+ 通用驗收工具，架構師維護）
// 用法: node scripts/static-check.mjs task02 | task06 | task07 | task08
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2] || 'task02';
const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fails.push(m); };

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

// —— 全模式共通：零依賴 ——
const pkg = existsSync('package.json') ? readJSON('package.json') : null;
ok(!!pkg, 'package.json 存在');
if (pkg) {
  ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, '無 dependencies');
  ok(!pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0, '無 devDependencies');
  ok(pkg.type === 'module', 'package.json type=module');
  ok(pkg.scripts && /node --test/.test(pkg.scripts.test || '') && !/--test\s+\S/.test(pkg.scripts.test), 'test script 為裸 `node --test`（Windows 尾斜線陷阱）');
}

if (mode === 'task02') {
  const mf = readJSON('extension/manifest.json');
  ok(mf.manifest_version === 3, 'manifest: MV3');
  ok(mf.permissions?.includes('storage') && mf.permissions.includes('sidePanel')
     && mf.permissions.includes('activeTab') && !mf.permissions.includes('scripting'),
     'manifest: permissions = {storage,sidePanel,activeTab}（無 scripting，靜態註冊）');
  ok(mf.host_permissions?.length === 2
     && mf.host_permissions.includes('https://www.tradingview.com/*')
     && mf.host_permissions.includes('https://api.typesafe.ai/*'),
     'manifest: host_permissions 恰好 tradingview + api.typesafe 兩條');
  ok(mf.background?.service_worker === 'background/service-worker.js' && mf.background.type === 'module',
     'manifest: ESM service worker');
  ok(mf.content_scripts?.[0]?.world === 'MAIN' && mf.content_scripts[0].run_at === 'document_start'
     && mf.content_scripts[0].js?.at(-1) === 'content/inject.js'
     && mf.content_scripts[0].js?.includes('lib/protocol.js') && mf.content_scripts[0].js?.includes('lib/ws-parse.js'),
     'content_scripts[0]: MAIN 棧 protocol→ws-parse→inject @ document_start');
  ok(mf.content_scripts?.[1]?.js?.includes('content/bridge.js') && mf.content_scripts[1].world !== 'MAIN',
     'content_scripts[1]: bridge.js @ isolated（預設）');
  ok(mf.content_scripts[0].matches?.[0] === 'https://www.tradingview.com/chart/*' && mf.action, 'manifest: matches + action 存在');
  // lib 不得 import chrome
  for (const f of readdirSync('extension/lib')) {
    const src = readFileSync(join('extension/lib', f), 'utf8');
    ok(!/chrome\.[a-zA-Z]/.test(src), `lib/${f} 無 chrome.* 引用`);
  }
}

if (mode === 'task06') {
  const inj = readFileSync('extension/content/inject.js', 'utf8');
  const brg = readFileSync('extension/content/bridge.js', 'utf8');
  ok(!/\.send\s*=|prototype\.send/.test(inj), 'inject: 未覆寫 WebSocket send');
  ok(!/\bfetch\s*\(/.test(inj + brg), 'inject/bridge: 零 fetch（外呼只准在 SW 經 jev-client）');
  ok(/__JEV_HOOK/.test(inj), 'inject: 冪等旗標');
  ok(/location\.origin/.test(inj), 'inject: 出站 postMessage 帶精確 targetOrigin');
  ok(/parseFrames|classifyPayload/.test(inj), 'inject: 復用 ws-parse 而非自行解析');
  ok(/v\s*[:=]\s*1|PROTOCOL_VERSION/.test(inj), 'inject: 協議版本欄位');
  ok(!/^(import|export)\b/m.test(inj) || /const/.test(inj), 'inject: 無 ESM import（classic script）');
  ok(/event\.source\s*===?\s*window/.test(brg), 'bridge: 校驗 event.source===window');
  ok(/['"]https:\/\/www\.tradingview\.com['"]/.test(brg), 'bridge: 校驗 origin 常量');
  ok(/chrome\.runtime\.onMessage/.test(brg), 'bridge: 收 SW 指令');
}

if (mode === 'task07') {
  for (const f of ['extension/background/service-worker.js', 'extension/lib/sw-core.js']) {
    const src = readFileSync(f, 'utf8');
    ok(!/fetch\s*\(\s*['"`]https:/.test(src), `${f}: 無直接外網 fetch（須經 lib/jev-client.js）`);
    ok(/import .*jev-client/.test(src), `${f}: 經 import jev-client 出口`);
  }
  const core = readFileSync('extension/lib/sw-core.js', 'utf8');
  ok(!/\bchrome\s*\./.test(core), 'sw-core: 零 chrome.*（DI 可測性）');
  const sw = readFileSync('extension/background/service-worker.js', 'utf8');
  ok(/createDb|sw-core/.test(sw) && /sidePanel/.test(sw), 'SW: 掛 sw-core 且設定 sidePanel 行為');
}

if (mode === 'task08') {
  for (const f of ['extension/sidepanel/sidepanel.html', 'extension/options/options.html']) {
    const src = readFileSync(f, 'utf8');
    ok(!/<script(?![^>]*src=)/.test(src), `${f}: 無 inline script`);
    ok(!/https?:\/\//.test(src.replace(/<\/?html[^>]*>/g, '').replace(/xmlns="[^"]*"/g, '')), `${f}: 無外部資源引用`);
  }
  const jsAll = ['extension/sidepanel/app.js', 'extension/options/app.js', 'extension/sidepanel/render.js', 'extension/options/render.js']
    .filter(f => existsSync(f)).map(f => readFileSync(f, 'utf8')).join('\n');
  ok(/\bfetch\s*\(/.test(jsAll) === false, 'panel/options JS: 零 fetch（一律經 SW，TEST_KEY 走 runtime message）');
  ok(/chrome\.storage\.local\.(get|set)/.test(jsAll), 'options: 經 storage.local 讀寫設定');
  ok(/僅供研究參考/.test(jsAll + readFileSync('extension/sidepanel/sidepanel.html', 'utf8')), '免責語常駐');
}

console.log(fails.length === 0 ? `\nALL PASS (${mode})` : `\n${fails.length} FAILED (${mode})`);
process.exit(fails.length ? 1 : 0);
