// scripts/ui-preview-server.mjs — 本地 UI 試飛伺服器（架構師診斷工具，Task 09）
// 把「真正的」sidepanel/options 頁面掛上 chrome stub 供稿，人眼＋CDP 驅動驗證渲染。
// 用法: node scripts/ui-preview-server.mjs  → http://127.0.0.1:8777/panel.html · /options.html
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };

function wrapPage(htmlPath, sub, { stubName = 'ui-stub' } = {}) {
  let html = readFileSync(htmlPath, 'utf8');
  // 相對資源改指 /ext/<sub>/... 服務路徑
  html = html.replace(/(src|href)="(?!\/|https?:)([^"]+)"/g, `$1="/ext/${sub}/$2"`);
  const stub = `<script src="/scratch/${stubName}.js"></script>`;
  const bar = `<div id="hostbar" style="position:sticky;top:0;z-index:9999;background:#222;color:#eee;font:12px monospace;padding:4px 8px;display:flex;gap:8px;align-items:center">
    <b>UI-STUB</b>
    <button onclick="window.__set && window.__set('idle')">idle</button>
    <button onclick="window.__set && window.__set('loading')">loading</button>
    <button onclick="window.__set && window.__set('done')">done</button>
    <button onclick="window.__set && window.__set('error')">error</button>
    <span id="hostlog"></span></div>
    <script>
      window.__JEV_UI_ERR = null;
      window.__set = (s) => { window.__STATE = s;
        (window.__JEV_LISTENERS||[]).forEach(f => f({v:1,type:'PREDICTION_UPDATED',tabId:window.__JEV_UI_TAB,status:s, last: s==='done'?window.__JEV_UI_LAST:(s==='error'?{kind:'rate_exhausted',message:'stub'}:null)}, {id:'sw'}));
        location.search.includes('stay') && 0; };
    </script>`;
  // 把 stub 的 listeners 暴露給 hostbar
  html = html.replace('</head>', stub + '\n<script>window.__JEV_LISTENERS = []; const _al = chrome.runtime.onMessage.addListener; chrome.runtime.onMessage.addListener = f => { _al(f); window.__JEV_LISTENERS.push(f); };</script></head>');
  return html.replace(/<body([^>]*)>/i, '<body$1>' + bar);
}

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type || 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(body); };
  try {
    if (url === '/' || url === '/panel.html') return send(200, wrapPage(join(ROOT, 'extension/sidepanel/sidepanel.html'), 'sidepanel'));
    if (url === '/options.html') return send(200, wrapPage(join(ROOT, 'extension/options/options.html'), 'options'));
    if (url.startsWith('/scratch/')) {
      const p = join(ROOT, decodeURIComponent(url));
      if (!existsSync(p)) return send(404, 'nf', 'text/plain');
      return send(200, readFileSync(p), MIME[extname(p)] || 'application/octet-stream');
    }
    if (url.startsWith('/ext/')) {
      const p = join(ROOT, 'extension', decodeURIComponent(url.slice(4)));
      if (!existsSync(p)) return send(404, 'nf: ' + p, 'text/plain');
      return send(200, readFileSync(p), MIME[extname(p)] || 'application/octet-stream');
    }
    send(404, 'nf', 'text/plain');
  } catch (e) { send(500, String(e), 'text/plain'); }
});
server.listen(8777, '127.0.0.1', () => console.log('ui-preview on http://127.0.0.1:8777/panel.html · /options.html'));
