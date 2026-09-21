// sidepanel/app.js — Side Panel 的擴充 API 殼。
// 契約（Task 08 C1/C3）：全部 chrome.* 集中在這裡；零 fetch；render.js 負責產 HTML。
// 流程：GET_STATE（不帶 tabId，由 SW 的 lastActiveTabId 兜底）＋每 2s 輪詢；
//       RUN_PREDICTION → 收 PREDICTION_UPDATED（只認自己 tab）驅動狀態機。

import {
  renderStatus,
  renderResult,
  renderLoading,
  renderError,
} from './render.js';

const POLL_MS = 2000;
const MIN_BARS_FOR_PREDICT = 10;
const NEED_MORE_HINT =
  '請重新整理 TradingView 分頁或移動圖表讓資料流入';

const statusEl = document.getElementById('status-line');
const predictBtn = document.getElementById('predict-btn');
const hintEl = document.getElementById('hint');
const resultEl = document.getElementById('result');

/** 目前已知的圖表 tab id（用來只認自己 tab 的 PREDICTION_UPDATED）。 */
let myTabId = null;
let currentState = { status: 'idle', count: 0 };
let predicting = false;
let loadingStartedAt = 0;
let loadingTicker = null;
let model = 'jev-latest';

/** 以 callback 包 chrome.runtime.sendMessage，避開未處理的 promise rejection。 */
function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(undefined);
          return;
        }
        resolve(response);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function readModel() {
  try {
    chrome.storage.local.get('jevModel', (got) => {
      if (got && typeof got.jevModel === 'string' && got.jevModel) {
        model = got.jevModel;
      }
    });
  } catch {
    /* 讀不到就用預設 model */
  }
}

function stopLoadingTicker() {
  if (loadingTicker != null) {
    clearInterval(loadingTicker);
    loadingTicker = null;
  }
}

function startLoading() {
  predicting = true;
  loadingStartedAt = Date.now();
  stopLoadingTicker();
  const tick = () => {
    const seconds = (Date.now() - loadingStartedAt) / 1000;
    resultEl.innerHTML = renderLoading(seconds);
  };
  tick();
  loadingTicker = setInterval(tick, 250);
  syncControls();
}

function finishLoading() {
  predicting = false;
  stopLoadingTicker();
  syncControls();
}

function syncControls() {
  const count = Number(currentState && currentState.count) || 0;
  const enough = count >= MIN_BARS_FOR_PREDICT;
  predictBtn.disabled = predicting || !enough;
  if (predicting) {
    hintEl.textContent = '';
  } else if (!enough) {
    hintEl.textContent = NEED_MORE_HINT;
  } else {
    hintEl.textContent = '';
  }
}

function applyState(state) {
  if (!state || typeof state !== 'object') return;
  currentState = state;
  statusEl.innerHTML = renderStatus(state);
  syncControls();
}

async function refresh() {
  // 讓「只認自己 tab」保持最新：SW 的 lastActiveTabId 隨 SNAPSHOT_UPSERT 更新。
  const tab = await send({ v: 1, type: 'GET_LAST_TAB' });
  if (tab && tab.tabId != null) myTabId = tab.tabId;
  const state = await send({ v: 1, type: 'GET_STATE' });
  applyState(state);
}

function isOwnUpdate(message) {
  if (!message || message.v !== 1 || message.type !== 'PREDICTION_UPDATED') return false;
  if (myTabId == null || message.tabId == null) return true;
  return message.tabId === myTabId;
}

async function showDoneFromState() {
  const state = await send({ v: 1, type: 'GET_STATE' });
  applyState(state);
  const last = state && state.last;
  if (!last) return;
  if (last.status === 'error') {
    resultEl.innerHTML = renderError(last.kind, last.message);
  } else if (last.status === 'done') {
    resultEl.innerHTML = renderResult(last, { model });
    bindCopyButtons();
  }
}

function bindCopyButtons() {
  const buttons = resultEl.querySelectorAll('.copy-btn');
  for (const button of buttons) {
    button.addEventListener('click', async () => {
      const target = button.getAttribute('data-copy-target');
      const pre = target ? resultEl.querySelector(`#${target}`) : null;
      const text = pre ? pre.textContent : '';
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = '已複製';
        setTimeout(() => {
          button.textContent = '複製';
        }, 1200);
      } catch (err) {
        // 降級：clipboard 不可用時只記錄，不讓 UI 崩。
        console.log('copy failed', err);
      }
    });
  }
}

async function onPredict() {
  if (predicting) return;
  startLoading();
  const response = await send({ v: 1, type: 'RUN_PREDICTION' });
  // busy 不是 error kind：保持 disabled，等 PREDICTION_UPDATED 廣播收尾。
  if (response && response.error === 'busy') return;
  if (response && response.ok && response.result) {
    finishLoading();
    resultEl.innerHTML = renderResult(response.result, { model });
    bindCopyButtons();
    return;
  }
  if (response && response.error && response.result) {
    finishLoading();
    resultEl.innerHTML = renderError(response.error, response.result.message);
    return;
  }
  // 沒有直接回應時，交給 PREDICTION_UPDATED 廣播收尾。
}

chrome.runtime.onMessage.addListener((message) => {
  if (!isOwnUpdate(message)) return;
  if (message.state === 'loading') {
    startLoading();
  } else if (message.state === 'done') {
    finishLoading();
    void showDoneFromState();
  } else if (message.state === 'error') {
    finishLoading();
    void showDoneFromState();
  }
  return false;
});

predictBtn.addEventListener('click', () => {
  void onPredict();
});

// 開啟：先讀 model，再立即 GET_STATE，之後每 2s 輪詢。
readModel();
void refresh();
setInterval(() => {
  void refresh();
}, POLL_MS);
