// tests/content-scripts.test.mjs — content scripts 的靜態契約斷言（classic script、零外呼）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const inject = readFileSync('extension/content/inject.js', 'utf8');
const bridge = readFileSync('extension/content/bridge.js', 'utf8');

test('content scripts 為 classic script（無 ESM import/export）', () => {
  for (const [name, src] of [
    ['inject.js', inject],
    ['bridge.js', bridge],
  ]) {
    assert.doesNotMatch(src, /^\s*import\s/m, `${name} 不應有 import`);
    assert.doesNotMatch(src, /^\s*export\s/m, `${name} 不應有 export`);
  }
});

test('inject.js 零 fetch、零 chrome.*、具冪等旗標與強制 flush 鉤子', () => {
  assert.doesNotMatch(inject, /\bfetch\s*\(/);
  assert.doesNotMatch(inject, /chrome\.[A-Za-z]/);
  assert.match(inject, /__JEV_HOOK/);
  assert.match(inject, /__JEV_FORCE_EMIT/);
  assert.match(inject, /parseFrames/);
  assert.match(inject, /classifyPayload/);
});

test('bridge.js 為 isolated 唯一 chrome.* 使用者，且零 fetch', () => {
  assert.match(bridge, /chrome\.runtime\.sendMessage/);
  assert.match(bridge, /chrome\.runtime\.onMessage/);
  assert.match(bridge, /event\.source\s*===\s*window/);
  assert.doesNotMatch(bridge, /\bfetch\s*\(/);
});
