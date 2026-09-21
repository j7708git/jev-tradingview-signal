// options/app.js — Options 頁的擴充 API 殼。
// 契約（Task 08 C2/C3）：零 fetch；金鑰只經 chrome.storage.local；
// 測試連線走 chrome.runtime.sendMessage({v:1,type:'TEST_KEY'})（SW 單點外呼）。

import { normalizeSettings, keyHint } from './render.js';
import { errorMsg } from '../sidepanel/render.js';

const keyInput = document.getElementById('jevApiKey');
const keyHintEl = document.getElementById('key-hint');
const toggleKeyBtn = document.getElementById('toggle-key');
const modelSelect = document.getElementById('jevModel');
const barsInput = document.getElementById('bars');
const featuresInput = document.getElementById('featuresOn');
const saveBtn = document.getElementById('save');
const testBtn = document.getElementById('test');
const testMsg = document.getElementById('test-msg');
const toastEl = document.getElementById('toast');

let toastTimer = null;

/** callback 包裝，避免未處理 rejection。 */
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

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  if (toastTimer != null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 1600);
}

/** 從表單讀值並正規化（寫入前的最後一道）。 */
function readForm() {
  return normalizeSettings({
    jevApiKey: keyInput.value,
    jevModel: modelSelect.value,
    bars: barsInput.value,
    featuresOn: featuresInput.checked,
  });
}

function applyToForm(settings) {
  // 金鑰只寫 input.value（DOM property），永不進 innerHTML / 文字節點。
  keyInput.value = settings.jevApiKey;
  keyHintEl.textContent = keyHint(settings.jevApiKey);
  modelSelect.value = settings.jevModel;
  barsInput.value = String(settings.bars);
  featuresInput.checked = settings.featuresOn;
}

async function loadSettings() {
  try {
    const raw = await chrome.storage.local.get([
      'jevApiKey',
      'jevModel',
      'bars',
      'featuresOn',
    ]);
    applyToForm(normalizeSettings(raw));
  } catch {
    applyToForm(normalizeSettings({}));
  }
}

async function saveSettings({ toast = true } = {}) {
  const settings = readForm();
  await chrome.storage.local.set(settings);
  applyToForm(settings);
  if (toast) showToast('已儲存');
}

toggleKeyBtn.addEventListener('click', () => {
  const revealing = keyInput.type === 'password';
  keyInput.type = revealing ? 'text' : 'password';
  toggleKeyBtn.textContent = revealing ? '隱藏' : '顯示';
});

saveBtn.addEventListener('click', () => {
  void saveSettings();
});

testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  testMsg.textContent = '測試中…';
  testMsg.className = 'test-msg';
  try {
    // 先落地目前表單（TEST_KEY 的 key/model 來自 storage），再單點外呼。
    await saveSettings({ toast: false });
    const response = await send({ v: 1, type: 'TEST_KEY' });
    if (response && response.ok) {
      testMsg.textContent = '連線成功';
      testMsg.className = 'test-msg ok';
    } else {
      const kind =
        response && (response.kind || (response.error && response.error.kind));
      testMsg.textContent = `連線失敗：${errorMsg(kind)}`;
      testMsg.className = 'test-msg err';
    }
  } finally {
    testBtn.disabled = false;
  }
});

void loadSettings();
