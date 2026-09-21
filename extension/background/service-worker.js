// background/service-worker.js — 薄殼：chrome.* 只在此；編排邏輯全在 lib/sw-core.js。
import '../lib/protocol.js';
import { createDb } from '../lib/sw-core.js';
import { evaluate } from '../lib/jev-client.js';
import { buildState, QUESTIONS, estimateTokens } from '../lib/state-builder.js';
import { ChartBuffer } from '../lib/chart-buffer.js';

let lastActiveTabId = null;
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const db = createDb({
  runtime: { sendMessage: (msg) => chrome.runtime.sendMessage(msg) },
  tabs: {
    sendMessage: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
    get: (tabId) => chrome.tabs.get(tabId),
    query: (q) => chrome.tabs.query(q),
  },
  storage: { local: { get: (keys) => chrome.storage.local.get(keys) } },
  evaluate, ChartBuffer, buildState, QUESTIONS, estimateTokens,
});

const PANEL_CMDS = new Set(['GET_STATE', 'RUN_PREDICTION', 'SET_ACTIVE_TAB', 'TEST_KEY']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'SNAPSHOT_UPSERT' && sender?.tab?.id != null) lastActiveTabId = sender.tab.id;
  if (msg?.v === 1 && msg.type === 'GET_LAST_TAB') {
    sendResponse({ v: 1, type: 'GET_LAST_TAB', tabId: lastActiveTabId });
    return false;
  }
  const patched =
    sender?.tab === undefined && msg?.tabId == null && PANEL_CMDS.has(msg?.type)
      ? { ...msg, tabId: lastActiveTabId }
      : msg;
  const result = db.handleRuntimeMessage(patched, sender);
  if (result && typeof result.then === 'function') {
    result.then(sendResponse, () => sendResponse({ ok: false, error: 'internal' }));
    return true;
  }
  if (result === false) return false;
  sendResponse(result);
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => db.onTabClosed(tabId));
