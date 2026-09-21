// scripts/ui-static-export.mjs — 產出自含式 UI 試飛檔（file:// 可開，Task 09 診斷工具）
// 手法：機械拼接（browserify 式）——import/export 行成對剝除，chunk 依序包進單一 IIFE，
// 頂層宣告天然共享作用域。產品碼零改寫（僅外殼），驗證的是「真實的」app/render 邏輯。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'scratch/preview');
mkdirSync(OUT, { recursive: true });
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const strip = (src, file) => {
  return src
    .replace(/^import\s*\(\s*['"][^'"]+['"]\s*\)\s*;?/gm, '/*dyn*/')
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm, (m) => `/* import stripped: ${m.replace(/\s+/g, ' ').trim().slice(0, 60)} */`)
    .replace(/^import\s+['"][^'"]+['"]\s*;?/gm, (m) => `/* side-effect import stripped */`)
    .replace(/^export\s+default\s+/gm, 'var __default = ')
    .replace(/^export\s+(async\s+function|function|class|const|let|var)\s+/gm, '$1 ')
    .replace(/^export\s*\{[\s\S]*?\}\s*;?/gm, '/* export list stripped */');
};

function bundle(files) {
  return files.map(f => `\n// ======== ${f} ========\n` + strip(read(f), f)).join('\n');
}

function page(htmlPath, jsFiles, outName, stubExtra = '') {
  let html = read(htmlPath);
  const cssMimes = [];
  html = html.replace(/(href)="([^"]+\.css)"/g, (m, a, b) =>
    `${a}="data:text/css,${encodeURIComponent(read(htmlPath.replace(/[^/]+$/, '') + b))}"`);
  html = html.replace(/<script type="module" src="[^"]*">[\s\S]*?<\/script>/,
    `<script>\n${read('scratch/ui-stub.js')}\ntry { (async function(){\n${bundle(jsFiles)}\n})(); } catch(e) { (window.__ERR=window.__ERR||[]).push('BUNDLE: '+e.message); }\n</script>`);
  const bar = `<div style="position:sticky;top:0;background:#222;color:#eee;font:12px monospace;padding:4px 8px;display:flex;gap:8px"><b>UI-STUB</b>
    <button onclick="__set('idle')">idle</button><button onclick="__set('loading')">loading</button>
    <button onclick="__set('done')">done</button><button onclick="__set('error')">error</button></div>
    <script>window.__JEV_LISTENERS=[];{const al=chrome.runtime.onMessage.addListener;chrome.runtime.onMessage.addListener=f=>{al(f);window.__JEV_LISTENERS.push(f);};}
    window.__set=(s)=>{window.__STATE=s;(window.__JEV_LISTENERS||[]).forEach(f=>f({v:1,type:'PREDICTION_UPDATED',tabId:window.__JEV_UI_TAB,status:s,last:s==='done'?window.__JEV_UI_LAST:(s==='error'?{kind:'rate_exhausted',message:'stub'}:null)},{id:'sw'}));};</script>`;
  html = html.replace(/<\/body>/i, bar + '</body>');
  writeFileSync(join(OUT, outName), html);
  const importCount = (html.match(/import/g) || []).length;
  console.log(outName, 'written, bytes:', html.length, '（拼接後 import 關鍵字殘留=' + importCount + '）');
}

page('extension/sidepanel/sidepanel.html', ['extension/sidepanel/render.js', 'extension/sidepanel/app.js'], 'panel-preview.html');
page('extension/options/options.html', ['extension/options/render.js', 'extension/options/app.js'], 'options-preview.html');
