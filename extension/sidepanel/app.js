// sidepanel/app.js — Side Panel 的擴充 API 殼。
// 契約（Task 08 C1/C3）：全部 chrome.* 集中在這裡；零 fetch；render.js 負責產 HTML。
// 流程：GET_STATE（不帶 tabId，由 SW 的 lastActiveTabId 兜底）＋每 2s 輪詢；
//       RUN_PREDICTION → 收 PREDICTION_UPDATED（只認自己 tab）驅動狀態機。

// 09e-2：門檻單一來源（protocol.js side-effect 填充 globalThis，全案不得有第二份數字）。
import '../lib/protocol.js';
import {
  renderStatus,
  renderResult,
  renderLoading,
  renderError,
  renderCounters,
  renderRingLog,
  renderStudiesMeta,
  applyStudyNameEdit,
  normalizeStudyExclude,
  applyStudyExcludeAdd,
  applyStudyExcludeRemove,
  OPEN_OPTIONS_CLASS,
  STUDY_INPUT_CLASS,
  STUDY_REMOVE_CLASS,
  STUDY_RESTORE_CLASS,
} from './render.js';

// §4.8.4：panel 命令一律引用 protocol.js 的 MSG 常數（不得散落字串）。
const MSG = globalThis.MSG;
const POLL_MS = 2000;
const PREDICT_MIN_BARS = globalThis.PREDICT_MIN_BARS;
const NEED_MORE_HINT =
  '請重新整理 TradingView 分頁或移動圖表讓資料流入';

const statusEl = document.getElementById('status-line');
const predictBtn = document.getElementById('predict-btn');
const hintEl = document.getElementById('hint');
const resultEl = document.getElementById('result');
// §4.8.5：除錯區元素（缺元素時全部降級為 no-op，不得拋錯）。
const debugCountersEl = document.getElementById('debug-counters');
const ringLogEl = document.getElementById('ring-log');
const resyncBtn = document.getElementById('resync-btn');
// Task 14／F10：指標映射折疊區內容容器（缺元素時整段降級為 no-op）。
const studiesMapEl = document.getElementById('studies-map');

/** 目前已知的圖表 tab id（用來只認自己 tab 的 PREDICTION_UPDATED）。 */
let myTabId = null;
let currentState = { status: 'idle', count: 0 };
let predicting = false;
let loadingStartedAt = 0;
let loadingTicker = null;
let model = 'jev-latest';
// Task 14／F10：studyId→自訂名映射（storage 讀寫集中 app.js）。
let studyNameMap = {};
// Task 15／F11：被排除（不進 payload）的 studyId 陣列（storage 讀寫集中 app.js）。
let studyExclude = [];
// studiesSig 用偵測到的 id 清單＋排除集去重繪，避免輪詢時蓋掉輸入框焦點。
let studiesSig = null;

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
  const enough = count >= PREDICT_MIN_BARS;
  predictBtn.disabled = predicting || !enough;
  if (predicting) {
    hintEl.textContent = '';
  } else if (!enough) {
    hintEl.textContent = `K 棒不足（${count}/${PREDICT_MIN_BARS}）· ${NEED_MORE_HINT}`;
  } else {
    hintEl.textContent = '';
  }
}

function applyState(state) {
  if (!state || typeof state !== 'object') return;
  currentState = state;
  statusEl.innerHTML = renderStatus(state);
  // §4.8.5(a)：counters 一行（缺值顯示 0）。
  if (debugCountersEl) debugCountersEl.textContent = renderCounters(state.counters);
  renderStudiesMap(state);
  syncControls();
}

/** Task 14／F10：自 storage 讀 studyNameMap（讀不到／壞型別一律空物件）。 */
async function readStudyNameMap() {
  try {
    const got = await chrome.storage.local.get('studyNameMap');
    const m = got && got.studyNameMap;
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

/** Task 14／F10：只寫 studyNameMap 一個鍵（不動 storage 其他鍵）。 */
async function saveStudyNameMap() {
  try {
    await chrome.storage.local.set({ studyNameMap });
  } catch {
    /* 儲存失敗不讓 UI 崩（下次失焦可重試） */
  }
}

/** Task 14／F10：把當前 studiesMeta 清單的 id 串成簽章（順序敏感）。
 *  Task 15／F11：一併納入排除集，排除狀態變更時強制重繪。 */
function studiesSignature(list) {
  const ids = list
    .map((s) => (s && s.id != null ? String(s.id) : ''))
    .join('\u0000');
  return `${ids}\u0001${studyExclude.join('\u0000')}`;
}

/** Task 14／F10：為映射輸入框綁失焦即存（沿用既有重新綁定模式）。 */
function bindStudyInputs() {
  if (!studiesMapEl) return;
  const inputs = studiesMapEl.querySelectorAll(`.${STUDY_INPUT_CLASS}`);
  for (const input of inputs) {
    input.addEventListener('blur', onStudyNameBlur);
  }
}

/** Task 15／F11：為「✕」刪除鈕與「復原」鈕綁事件（每次重繪後重綁）。 */
function bindStudyExcludeButtons() {
  if (!studiesMapEl) return;
  for (const btn of studiesMapEl.querySelectorAll(`.${STUDY_REMOVE_CLASS}`)) {
    btn.addEventListener('click', onStudyRemoveClick);
  }
  for (const btn of studiesMapEl.querySelectorAll(`.${STUDY_RESTORE_CLASS}`)) {
    btn.addEventListener('click', onStudyRestoreClick);
  }
}

/** Task 14／F10：失焦即存；trim 後空字串＝刪鍵並回到自動名。 */
async function onStudyNameBlur(event) {
  const input = event && event.target;
  if (!input) return;
  const id = input.getAttribute('data-study-id') || '';
  const autoName = input.getAttribute('data-auto-name') || '';
  const trimmed = String(input.value == null ? '' : input.value).trim();
  input.value = trimmed === '' ? autoName : trimmed;
  studyNameMap = applyStudyNameEdit(studyNameMap, id, trimmed);
  await saveStudyNameMap();
}

/** Task 14／F10：依 GET_STATE.studiesMeta 渲染映射區（id 清單／排除集未變則不重繪）。
 *  Task 15／F11：被排除者不進主列表，改列於「已排除（N）」小區。 */
function renderStudiesMap(state) {
  if (!studiesMapEl) return;
  const list = state && Array.isArray(state.studiesMeta) ? state.studiesMeta : [];
  const sig = studiesSignature(list);
  if (sig === studiesSig) return;
  studiesSig = sig;
  studiesMapEl.innerHTML = renderStudiesMeta(list, studyNameMap, studyExclude);
  bindStudyInputs();
  bindStudyExcludeButtons();
}

/** Task 15／F11：自 storage 讀 studyExclude（壞型別→[]；只讀這一個鍵）。 */
async function readStudyExclude() {
  try {
    const got = await chrome.storage.local.get('studyExclude');
    return normalizeStudyExclude(got && got.studyExclude);
  } catch {
    return [];
  }
}

/** Task 15／F11：只寫 studyExclude 一個鍵（不動 storage 其他鍵）。 */
async function saveStudyExclude() {
  try {
    await chrome.storage.local.set({ studyExclude });
  } catch {
    /* 儲存失敗不讓 UI 崩（下次操作可重試） */
  }
}

/** Task 15／F11：點「✕」→ 該 studyId 進排除集並持久化；自訂名不受影響。 */
async function onStudyRemoveClick(event) {
  const btn = event && event.target;
  if (!btn) return;
  if (typeof event.preventDefault === 'function') event.preventDefault();
  const id = btn.getAttribute('data-study-id') || '';
  studyExclude = applyStudyExcludeAdd(studyExclude, id);
  await saveStudyExclude();
  renderStudiesMap(currentState);
}

/** Task 15／F11：點「復原」→ 移出排除集並持久化；回主列表。 */
async function onStudyRestoreClick(event) {
  const btn = event && event.target;
  if (!btn) return;
  if (typeof event.preventDefault === 'function') event.preventDefault();
  const id = btn.getAttribute('data-study-id') || '';
  studyExclude = applyStudyExcludeRemove(studyExclude, id);
  await saveStudyExclude();
  renderStudiesMap(currentState);
}

/** §4.8.5(b)：取回 ring log 並渲染（新→舊；失敗降級不拋錯）。 */
async function refreshRingLog() {
  if (!ringLogEl) return;
  const ring = await send({ v: 1, type: MSG.GET_RING_LOG });
  if (ring && ring.ok) ringLogEl.innerHTML = renderRingLog(ring.entries);
}

async function refresh() {
  // 讓「只認自己 tab」保持最新：SW 的 lastActiveTabId 隨 SNAPSHOT_UPSERT 更新。
  const tab = await send({ v: 1, type: MSG.GET_LAST_TAB });
  if (tab && tab.tabId != null) myTabId = tab.tabId;
  const state = await send({ v: 1, type: MSG.GET_STATE });
  applyState(state);
  await refreshRingLog();
}

function isOwnUpdate(message) {
  if (!message || message.v !== 1 || message.type !== MSG.PREDICTION_UPDATED) return false;
  if (myTabId == null || message.tabId == null) return true;
  return message.tabId === myTabId;
}

async function showDoneFromState() {
  const state = await send({ v: 1, type: MSG.GET_STATE });
  applyState(state);
  const last = state && state.last;
  if (!last) return;
  if (last.status === 'error') {
    resultEl.innerHTML = renderError(last.kind, last.message);
    bindOpenOptionsButtons(resultEl);
  } else if (last.status === 'done') {
    resultEl.innerHTML = renderResult(last, { model });
    bindCopyButtons();
  }
}

/** F8：開啟擴充設定頁；失敗一律靜默降級，不得拋錯（含 Promise rejection）。 */
function openOptionsPageSafe() {
  try {
    const result = chrome.runtime.openOptionsPage();
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch {
    /* 極端情況下無法開啟時不讓 UI 崩 */
  }
}

/** F8：沿用 bindCopyButtons 模式，為 root 內所有 .open-options 綁同一 handler。 */
function bindOpenOptionsButtons(root = document) {
  const buttons = root.querySelectorAll(`.${OPEN_OPTIONS_CLASS}`);
  for (const button of buttons) {
    button.addEventListener('click', openOptionsPageSafe);
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

async function onResync() {
  if (resyncBtn) resyncBtn.disabled = true;
  try {
    const res = await send({ v: 1, type: MSG.RESYNC });
    // §4.8.3：成功後更新狀態列根數（直接刷新整塊狀態）。
    if (res && res.ok) await refresh();
  } finally {
    if (resyncBtn) resyncBtn.disabled = false;
  }
}

async function onPredict() {
  if (predicting) return;
  startLoading();
  const response = await send({ v: 1, type: MSG.RUN_PREDICTION });
  // busy 不是 error kind：保持 disabled，等 PREDICTION_UPDATED 廣播收尾。
  if (response && response.error === 'busy') return;
  if (response && response.ok && response.result) {
    finishLoading();
    resultEl.innerHTML = renderResult(response.result, { model });
    bindCopyButtons();
    return;
  }
  if (response && response.error) {
    // error 可能是字串（既有 kind）或物件（09e-1 insufficient_data）。
    const error = response.error;
    const kind = typeof error === 'string' ? error : error && error.kind;
    const message =
      typeof error === 'string'
        ? response.result && response.result.message
        : error && error.message;
    finishLoading();
    resultEl.innerHTML = renderError(kind, message);
    bindOpenOptionsButtons(resultEl);
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

if (resyncBtn) {
  resyncBtn.addEventListener('click', () => {
    void onResync();
  });
}

// F8：header「⚙ 設定」與 no_key CTA 共用同一 handler（header 於此綁定一次）。
bindOpenOptionsButtons();

// 開啟：先讀 model，再讀映射／排除集，之後每 2s 輪詢。
readModel();
void (async () => {
  studyNameMap = await readStudyNameMap();
  studyExclude = await readStudyExclude();
  // 映射／排除集載入後強制重繪一次（即使先前已用空狀態畫過）。
  studiesSig = null;
  await refresh();
})();
setInterval(() => {
  void refresh();
}, POLL_MS);
