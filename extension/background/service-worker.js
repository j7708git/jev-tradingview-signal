// background/service-worker.js — 薄殼：chrome.* 只在此；編排邏輯全在 lib/sw-core.js。
import '../lib/protocol.js';
import { createDb } from '../lib/sw-core.js';
import { evaluate } from '../lib/jev-client.js';
import { buildState, QUESTIONS, estimateTokens } from '../lib/state-builder.js';
import { ChartBuffer } from '../lib/chart-buffer.js';

// §4.6：protocol.js 為雙相容（無 export），符號掛在 globalThis；此處取 MSG 常數。
const { MSG } = globalThis;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const db = createDb({
  runtime: { sendMessage: (msg) => chrome.runtime.sendMessage(msg) },
  tabs: {
    sendMessage: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
    get: (tabId) => chrome.tabs.get(tabId),
    query: (q) => chrome.tabs.query(q),
  },
  storage: {
    local: { get: (keys) => chrome.storage.local.get(keys) },
    // §4.7.3：lastActiveTabId 由 sw-core 經此介面持久化（lib 不碰 chrome.*）。
    session: chrome.storage.session
      ? {
          get: (keys) => chrome.storage.session.get(keys),
          set: (obj) => chrome.storage.session.set(obj),
        }
      : undefined,
  },
  evaluate, ChartBuffer, buildState, QUESTIONS, estimateTokens,
});

// §4.8.4：panel 命令一律引用 protocol.js 的 MSG 常數（不得散落字串）。
const PANEL_CMDS = new Set([
  MSG.GET_STATE,
  MSG.RUN_PREDICTION,
  MSG.SET_ACTIVE_TAB,
  MSG.TEST_KEY,
  MSG.GET_RING_LOG,
  MSG.RESYNC,
]);

// 是否為本擴充的面板 UI（正式 side panel：sender.tab === undefined；以分頁開啟的
// sidepanel/options 頁：sender.tab 有值但 sender.url 指向 chrome-extension://.../）。
// 不可只靠 sender.tab，否則真機／自動化以分頁開啟的面板會被誤判為 content script。
function fromPanel(sender) {
  if (!sender || sender.tab === undefined) return true;
  const url = sender.url || '';
  const roots = [
    chrome.runtime.getURL('sidepanel/'),
    chrome.runtime.getURL('options/'),
  ];
  return roots.some((prefix) => url.startsWith(prefix));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const panel = fromPanel(sender);
  // SW 層正規化：面板 sender 一律以 tab:undefined 傳給 sw-core，維持其 isPanel 契約。
  const normalizedSender = panel ? { ...sender, tab: undefined } : sender;

  const dispatch = async () => {
    if (panel && msg?.tabId == null && PANEL_CMDS.has(msg?.type)) {
      // §4.7.3：由 sw-core（含 storage.session 還原）取 lastActiveTabId 補 tabId。
      const last = await db.handleRuntimeMessage(
        { v: 1, type: MSG.GET_LAST_TAB },
        normalizedSender,
      );
      if (last && last.tabId != null) {
        return db.handleRuntimeMessage({ ...msg, tabId: last.tabId }, normalizedSender);
      }
    }
    return db.handleRuntimeMessage(msg, normalizedSender);
  };

  const result = dispatch();
  if (result && typeof result.then === 'function') {
    result.then(sendResponse, () => sendResponse({ ok: false, error: 'internal' }));
    return true;
  }
  if (result === false) return false;
  sendResponse(result);
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => db.onTabClosed(tabId));
