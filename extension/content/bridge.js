// content/bridge.js — isolated world 橋接（classic script，無 import/export）。
// 本檔跑 isolated world：`chrome.*` 只准出現在這裡。
// 職責：
//   1. 監聽 MAIN 世界 inject.js 的 window.postMessage（SNAPSHOT_UPSERT）→ chrome.runtime.sendMessage 給 SW。
//   2. 監聽 SW 的 chrome.runtime.onMessage（REQ_SNAPSHOT）→ window.postMessage(JEV_PING) 喚醒 inject 立即補送。
(function () {
  'use strict';

  var TV_ORIGIN = 'https://www.tradingview.com';
  var V = 1;
  var SNAPSHOT_UPSERT = 'SNAPSHOT_UPSERT';
  var REQ_SNAPSHOT = 'REQ_SNAPSHOT';
  var JEV_PING = 'JEV_PING';

  function hasRuntime() {
    return (
      typeof chrome !== 'undefined' &&
      chrome &&
      chrome.runtime &&
      typeof chrome.runtime.sendMessage === 'function'
    );
  }

  // ── MAIN → isolated → SW ────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    // 三道校驗：來源視窗、origin、版本＋型別白名單。
    if (!(event.source === window)) return;
    if (event.origin !== TV_ORIGIN) return;

    var data = event.data;
    if (!data || typeof data !== 'object' || data.v !== V) return;
    if (data.type !== SNAPSHOT_UPSERT) return;

    if (!hasRuntime()) return;

    var out = {
      v: V,
      type: data.type,
      bars: data.bars,
      reset: data.reset,
      meta: data.meta,
    };

    try {
      var p = chrome.runtime.sendMessage(out);
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {
      // SW 未就緒等情況：吞掉，不讓 content script 拋錯。
    }
  });

  // ── SW → isolated → MAIN ────────────────────────────────────────────
  if (hasRuntime() && chrome.runtime.onMessage && chrome.runtime.onMessage.addListener) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || typeof msg !== 'object' || msg.type !== REQ_SNAPSHOT) return;
      // §4.7.2：full:true 要求 inject 清游標並全量重送；其餘維持增量補送。
      var ping = { v: V, type: JEV_PING };
      if (msg.full === true) ping.full = true;
      window.postMessage(ping, TV_ORIGIN);
    });
  }
})();
