// scripts/static-check.mjs — 架構守門（Task 02+ 通用驗收工具，架構師維護）
// 用法: node scripts/static-check.mjs task02 | task06 | task07 | task08
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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
     && mf.content_scripts[0].js?.includes('content/inject.js'),
     'content_scripts[0]: inject.js @ world:MAIN @ document_start');
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
  const src = readFileSync('extension/content/inject.js', 'utf8');
  ok(!/\.send\s*=|prototype\.send/.test(src), 'inject: 未覆寫 WebSocket.prototype.send / .send');
  ok(/event\.source\s*===\s*window/.test(src), 'inject: postMessage 校驗 event.source===window');
  ok(/['"]https:\/\/www\.tradingview\.com['"]/.test(src) || /origin/.test(src), 'inject: origin 校驗存在');
  ok(/__JEV_HOOK/.test(src), 'inject: 冪等旗標存在');
  ok(/v\s*[:=]\s*1|PROTOCOL_VERSION/.test(src), 'inject: 協議版本欄位');
}

if (mode === 'task07') {
  const files = ['extension/background/service-worker.js'];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    ok(!/fetch\s*\(\s*['"`]https:/.test(src), `${f}: 無直接外網 fetch（須經 lib/jev-client.js）`);
    ok(/import .*jev-client/.test(src), `${f}: 經 import jev-client 出口`);
  }
}

if (mode === 'task08') {
  for (const f of ['extension/sidepanel/sidepanel.html', 'extension/options/options.html']) {
    const src = readFileSync(f, 'utf8');
    ok(!/<script(?![^>]*src=)/.test(src), `${f}: 無 inline script`);
    ok(!/https?:\/\/(?!www\.tradingview\.com|api\.typesafe\.ai)/.test(src.replace(/<\/?html[^>]*>/g,'')), `${f}: 無外部資源引用`);
  }
}

console.log(fails.length === 0 ? `\nALL PASS (${mode})` : `\n${fails.length} FAILED (${mode})`);
process.exit(fails.length ? 1 : 0);
