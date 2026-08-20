// web/lib/session-open.ts — 세션 터미널로 가는 **단 하나의 문** (#1820).
//
// 왜 한 곳인가 — 세션으로 가는 길은 계속 늘어난다: 대시보드 카드 · AI 세션 탭 · 프로젝트 상세 · 활동 로그 ·
//  질문 검색 결과 · 그리드 셀 · 하단 선택바 · 태스크 위임 · 세션 만들고 입장…. 그 길마다 "죽었으면 먼저
//  되살린다"를 손으로 넣는 방식은 **새 화면이 생길 때마다 빠졌다**(#1820 전수조사: 절반 이상이 그냥 링크만
//  열고 있었고, 그래서 열면 '종료됨' 배너로 끝났다).
//
// 그래서 뒤집었다 — **트리거가 아니라 도착지가 복원을 책임진다.** 이 함수가 만드는 주소(terminal.html)가 그
//  도착지이고, 그 페이지는 뜨자마자 복원 게이트를 지난다(web/standalone/terminal.ts `maybeRestoreOnOpen`).
//  세션 화면(#/s/<id>)도 같은 규칙을 자기 자리에서 지킨다(web/session-chat.ts `autoResume`).
//  ⇒ **새 트리거가 할 일은 이 함수를 부르는 것뿐이다.** 복원을 따로 챙길 필요가 없다.
//
// 직접 `terminal.html?session=` 문자열을 조립하면 scripts/session-open-restore.test.mjs 가 실패한다(가드).
'use strict';

import { appUrl } from './net.js';

export interface SessionOpenOpts {
  /** 화면 제목 프리필 — 서버 메타가 오기 전 잠깐 쓰인다(없으면 '터미널'). */
  label?: string | null;
  /** 노드 세션(#869) — WS 릴레이 대상 노드. */
  node?: string | null;
  /** 세션 화면 안 프레임으로 실릴 때(#1744) — 크롬 없이 터미널만. */
  embed?: boolean;
  /** 복원으로 열린 페이지 표식(#1059) — 이 표식이 있으면 다시 자동 복원하지 않는다(루프 차단). */
  restored?: boolean;
  /** 태스크 위임 등에서 첫 지시를 자동 전송. */
  autosend?: boolean;
  /** 따라하기 투어에서 온 첫 세션. */
  welcome?: boolean;
}

/** 세션 하나의 터미널 페이지 주소. 프리뷰(/preview/<id>/…) 아래에서도 그 접두사를 유지한다(appUrl). */
export function sessionTermUrl(id: string, opts: SessionOpenOpts = {}): string {
  return appUrl('/ui/terminal.html?session=' + encodeURIComponent(id)
    + '&label=' + encodeURIComponent(opts.label || '')
    + (opts.node ? '&node=' + encodeURIComponent(opts.node) : '')
    + (opts.embed ? '&embed=1' : '')
    + (opts.restored ? '&restored=1' : '')
    + (opts.autosend ? '&autosend=1' : '')
    + (opts.welcome ? '&welcome=1' : ''));
}

/**
 * 그 세션의 터미널 탭을 연다.
 *
 * 창 이름은 `lively-term-<세션id>` 로 고정한다 — **한 세션 = 터미널 탭 하나**(#1598). 이미 열려 있으면
 *  브라우저가 그 탭을 재사용하므로, 어느 화면에서 열든 같은 탭으로 간다('_blank' 로 열면 이름이 빈 문자열이라
 *  다음에 어디서도 못 찾아 탭이 무한히 늘어난다).
 *
 * ⚠ 팝업 차단 — 여러 개를 연달아 열 때는 **사용자 제스처 안에서 동기로** 호출해야 한다(await·setTimeout 을
 *  끼우면 전부 막힌다). 반환값이 null 이면 차단된 것이니 호출부가 세어서 안내한다.
 */
export function openSessionWindow(id: string, opts: SessionOpenOpts = {}): Window | null {
  const w = window.open(sessionTermUrl(id, opts), 'lively-term-' + id);
  try { w && w.focus(); } catch { /* 팝업 차단·크로스오리진 — 열기는 됐으니 무시 */ }
  return w;
}
