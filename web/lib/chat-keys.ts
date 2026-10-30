// lib/chat-keys.ts — 세션 대화창(tui)을 «터미널처럼» 쓰는 글쇠 판정 한 자리(#4797). DOM 을 모르는 잎 모듈이라 시험이 그대로 부른다.
//
//  상민님(2026-10-16): «그부분 눌렀을때만 거기에 입력되는게 아니라 그냥 항상 실제 터미널처럼 그 화면 활성화돼있을때 입력되게».
//  터미널은 창이 앞에 있으면 어디를 눌렀든 친 글자가 프롬프트로 간다. 대화창도 그렇게 — 이 화면이 보이는 동안 초점이 «아무 데도
//  아닌 곳»(문서 바탕 · 대화 글 · 사이드바 줄 같은 단추)에 있으면 글쇠를 입력칸으로 보낸다.
//  ⚠ 남의 글쇠는 뺏지 않는다: 다른 글칸(검색창 · 본문 편집 · 이름 바꾸기), 창·메뉴(대화상자 · 우클릭 메뉴 · 고르기 목록),
//   글쇠를 스스로 쓰는 칸(곁칸 — 파일 칸은 Space·Enter·Backspace 가 파인더 단축키다 · 다른 세션 화면), 액자(iframe) 안.
//  ⚠ 단추 위의 Space·Enter 는 그 단추를 누르는 키다 — 그대로 둔다. 수식키 조합(⌘K · Ctrl+O · ⌘C …)도 그대로 둔다.
//   예외 하나: ⌘V·Ctrl+V(붙여넣기)는 입력칸으로 — 터미널에서 붙여넣으면 프롬프트로 들어가는 것과 같다.

/** 판정에 쓰는 키 사실 — KeyboardEvent 의 이 칸들만 본다. */
export interface KeyLike {
  key: string; code?: string; keyCode?: number;
  ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean;
  isComposing?: boolean; defaultPrevented?: boolean;
}

/**
 * 지금 초점이 있는 자리 — DOM 에서 읽어 넘긴다(chat-view.ts focusSpot).
 *  · none        문서 바탕(body·html) — 아무것도 고르지 않았다
 *  · mine        이 대화창의 입력칸
 *  · editable    다른 글칸(input · textarea · select · contenteditable)
 *  · interactive 단추 · 링크 · 펼침(summary) — Space·Enter 가 그것을 누른다
 *  · other       그 밖(대화 글 · 칸 바탕처럼 초점만 받는 것)
 *  owned = 그 자리가 글쇠를 스스로 쓰는 영역 안이다(창 · 메뉴 · 곁칸 · 액자) — 그러면 무엇이든 손대지 않는다.
 */
export interface FocusSpot { kind: 'none' | 'mine' | 'editable' | 'interactive' | 'other'; owned: boolean }

/** focus = 입력칸에 초점을 주고 그 키는 브라우저가 입력칸에서 마저 처리하게 둔다 · enter = 입력칸의 보내기 · null = 손대지 않는다. */
export type KeyRoute = 'focus' | 'enter' | null;

export function routeKey(e: KeyLike, at: FocusSpot): KeyRoute {
  if (e.defaultPrevented || e.isComposing) return null;            // 누가 이미 썼다 · 다른 칸에서 한글을 조합하는 중이다
  if (at.owned || at.kind === 'mine' || at.kind === 'editable') return null;
  const k = String(e.key || '');
  if (e.ctrlKey || e.metaKey) {
    //  붙여넣기만 입력칸으로. 자판 위치(code)로도 본다 — 한글 입력기가 켜져 있으면 ⌘V 의 key 가 'ㅍ' 로 오는 브라우저가 있다.
    return !e.altKey && (e.code === 'KeyV' || k === 'v' || k === 'V') ? 'focus' : null;
  }
  if (k === 'Enter') return at.kind === 'interactive' ? null : e.shiftKey ? 'focus' : 'enter';
  if (k === ' ' || k === 'Spacebar') return at.kind === 'interactive' ? null : 'focus';
  if (k === 'Backspace') return 'focus';
  //  한글 입력기 — 조합을 시작하는 키는 key 가 'Process'(keyCode 229)로 온다.
  if (k === 'Process' || e.keyCode === 229) return 'focus';
  //  글자 한 자(한글 자모 · 기호 포함). 'ArrowUp' · 'Escape' · 'Tab' · 'F5' 같은 이름 있는 키는 여러 글자라 여기서 걸러진다.
  if ([...k].length === 1) return 'focus';
  return null;
}
