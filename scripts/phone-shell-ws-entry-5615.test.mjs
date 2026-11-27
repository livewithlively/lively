// #5615 — 폰(≤640) 셸에서 워크스페이스 메뉴·설정에 닿는 길이 있어야 한다.
//  종전(#4088)엔 폰에서 레일을 걷으며 레일에만 있던 워크스페이스 메뉴(설정 · 전환 · 추가 · 받은 초대)를 옮기지 않아
//  폰에선 워크스페이스 설정에 갈 길이 0이었다. 이 시험은 그 문 셋(맨 윗줄 타일 · [나] 판의 두 줄)을 소스에서 지킨다.
//  화면 실측은 프리뷰에서 했다(390×664 · 360×616 · 768 · 1440) — 여기는 배선이 빠지면 빨갛게 되는 자리만.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = process.env.LIVELY_SRC_ROOT || fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(root + '/' + p, 'utf8');
const phoneBlock = (css) => css.slice(css.indexOf('@media (max-width: 640px)'));

test('폰 맨 윗줄 워크스페이스 타일이 워크스페이스 메뉴를 연다', () => {
  const m = read('web/v2/mobile.ts');
  assert.match(m, /class: 'v2-mbar-btn v2-mws'/);
  assert.match(m, /openWorkspaceMenu\(wsBtn\)/);
  const main = read('web/v2/main.ts');
  assert.match(main, /webTopbar\.append\(mobile\.wsBtn, mobile\.appsBtn, mobile\.bellBtn\)/, '타일·[모든 앱](#5820)·종이 브라우저 맨 윗줄에 붙어야 한다');
  const css = read('public/styles/50-mobile.css');
  assert.match(phoneBlock(css), /\.v2-topbar > \.v2-mws \{ display: inline-flex !important;/, '폰 블록에서 타일이 보여야 한다');
  assert.match(css, /^\.v2-mws, \.v2-mbar-bell, \.v2-mbar-apps \{ display: none !important; \}/m, '폰 밖에선 숨는다');
});

test('[나] 판에 워크스페이스 메뉴 · 워크스페이스 설정 줄이 있고 [더보기] 는 없다', () => {
  const m = read('web/v2/mobile.ts');
  assert.match(m, /openWorkspaceSettingsNow\(\)/);
  assert.match(m, /'워크스페이스 설정'/);
  assert.doesNotMatch(m, /text: '더보기'/);
  const rail = read('web/v2/rail.ts');
  assert.match(rail, /export function openWorkspaceSettingsNow\(\): void \{ closePopover\(\); openCurrentWsSettings\(wsMenuRows\(\)/);
});

test('폰에선 워크스페이스 메뉴가 화면 아래 판으로 선다', () => {
  const css = read('public/styles/50-mobile.css');
  assert.match(phoneBlock(css), /\.v2-wspop \{ left: 0 !important; right: 0 !important; top: auto !important; bottom: 0 !important;/);
});
