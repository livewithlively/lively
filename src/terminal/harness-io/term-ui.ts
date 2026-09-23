// 웹 터미널(xterm)이 하네스를 다루는 데 필요한 **화면 사실** (#4135).
//
//  ── 왜 이 파일이 따로인가 ──
//  값은 각 하네스 어댑터(claude.ts·codex.ts…)가 갖고, 축의 정의는 adapter.ts 가 세운다. 그런데 어댑터들이
//  adapter.ts 를 다시 import 하면 순환이 된다(실측: `Cannot access 'TERM_UI_UNKNOWN' before initialization`).
//  그래서 **잎 모듈**로 뺀다 — chat-line.ts·chat-runtime-keys.ts 와 같은 자리다. adapter.ts 가 다시 내보내므로
//  쓰는 쪽은 종전대로 adapter.js 한 곳만 보면 된다.
//
//  ── 왜 이 축이 필요한가 ──
//  브라우저 터미널의 편의 기능들은 전부 «클로드 화면은 이렇게 생겼다» 는 실측 위에 세워졌고, 그 사실이
//  web/standalone/terminal.ts 에 글자로 박혀 있었다. 그래서 codex 세션에서는 화면이 조용히 틀린 짓을 했다 —
//  폰 키 줄의 선택지 숫자는 codex 에선 **아무것도 고르지 않고**(Enter 가 필요하다), 자동 전송은 codex 의
//  부팅 대화상자를 못 알아봐 첫 지시를 그 위에 쏟았다(둘 다 실측 2026-09-24, codex 0.153.4).
//  화면은 하네스를 모르는 채로 두고 **하네스가 자기 사실을 답하게** 한다 — 새 하네스는 여기 한 줄이면 된다.

/**
 * · appMouse         TUI 가 마우스를 쥐나(alt 화면 + 마우스 리포트). 쥐면 웹(xterm)이 그 선택을 못 봐서 ⌘C 를
 *                    ^C 로 다리 놓아야 하고(#972), 드래그엔 ⌥/⇧ 가 필요하다. 안 쥐면 브라우저 기본 선택이 그대로 된다.
 * · choiceNeedsEnter 선택지 번호가 Enter 를 요구하나. claude 는 숫자만으로 골라지고(#4160 그래서 Enter 를 안 붙인다),
 *                    codex 는 숫자만으론 커서도 안 움직인다 — Enter 까지 보내야 골라진다.
 * · pastePlaceholder 여러 줄 붙여넣기를 «[Pasted text +N lines]» 로 접나. 접으면 자동 전송의 «안착 확인» 이 그 표식을 본다.
 *                    codex 는 접지 않고 그대로 펼친다 — 본문 대조만이 안착의 증거다.
 * · startDialogRe    부팅 중 뜨는 **차단 대화상자**(신뢰·훅·업데이트). 이 화면 위에서 Enter 를 치면 그 Enter 를
 *                    대화상자가 먹고 첫 지시가 사라진다. null = 미실측(화면이 보수적으로 기다린다).
 * ⚠ 값은 **실측만** 적는다. 모르면 사고가 나지 않는 쪽(«아무 일도 안 일어난다»)으로 두고 미실측이라고 적는다 —
 *  추측한 true 는 엉뚱한 키를 흘려 다음 화면을 건드린다.
 */
export interface TermUi {
  appMouse: boolean;
  choiceNeedsEnter: boolean;
  pastePlaceholder: boolean;
  startDialogRe: RegExp | null;
}

/** 미실측 하네스의 화면 사실 — 전부 «사고가 안 나는 쪽». 실측이 생기면 그 어댑터에서 값을 덮어쓴다. */
export const TERM_UI_UNKNOWN: TermUi = { appMouse: false, choiceNeedsEnter: false, pastePlaceholder: false, startDialogRe: null };

/**
 * 브라우저로 보내는 모양 — 정규식은 source 만 실어 보낸다(플래그는 받는 쪽이 'i' 로 고정한다).
 * 화면이 이 값을 **하나의 출처**에서 받아야 서버와 갈리지 않는다(종전엔 web 에 사본이 박혀 있었다).
 */
export interface TermUiWire {
  appMouse: boolean;
  choiceNeedsEnter: boolean;
  pastePlaceholder: boolean;
  startDialog: string | null;
}

export function termUiWire(t: TermUi): TermUiWire {
  return {
    appMouse: t.appMouse,
    choiceNeedsEnter: t.choiceNeedsEnter,
    pastePlaceholder: t.pastePlaceholder,
    startDialog: t.startDialogRe ? t.startDialogRe.source : null,
  };
}
