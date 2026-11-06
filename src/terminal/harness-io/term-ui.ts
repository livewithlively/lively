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
 * · pastePlaceholder 긴 붙여넣기를 표식으로 접나 — 클로드 «[Pasted text #N +M lines]», codex «[Pasted Content N chars]»
 *                    (1000자 넘게, #5332 실측 0.157.1·0.166.0). 접으면 자동 전송의 «안착 확인» 이 본문 대신 그 표식을 본다
 *                    (본문만 대조하면 접힌 화면을 «안 들어갔다» 로 보고 다시 붙여 넣는다 — 중복 전송).
 * · startDialogRe    부팅 중 뜨는 **차단 대화상자**(신뢰·훅·업데이트). 이 화면 위에서 Enter 를 치면 그 Enter 를
 *                    대화상자가 먹고 첫 지시가 사라진다. null = 미실측(화면이 보수적으로 기다린다).
 * · copyBridge       ⌘C→^C 다리(#972)를 놓아도 되나 = 그 TUI 는 **제 마우스 선택을 ^C 로 복사**한다. 거짓이면 ^C 는 그 앱에서
 *                    중단·종료다(#5332 codex: 빈 입력칸의 Ctrl+C 는 codex 를 끈다) — 웹은 ⌘C·우클릭 [복사]로 \x03 을 보내지 않는다.
 * · pasteBurst       괄호 표지 없이 **한 번에 읽힌 글**을 붙여넣기로 치나. 참이면 그 안의 CR 은 제출이 아니라 줄바꿈이 되고
 *                    (#5332 codex 실측: 글+CR 한 덩어리 → 줄바꿈), 긴 글은 읽힘 단위(1024B)로 쪼개져 접힌다 — 그래서 웹은
 *                    한 줄짜리 붙여넣기·폰 보내기도 괄호 표지(\e[200~…\e[201~)로 감싼다(감싼 글 + CR 은 곧바로 제출된다).
 * · permModes        상태 줄의 권한 모드를 Shift+Tab 으로 돌리는 화면인가(클로드). 폰의 «모드» 단추가 그 목록을 보여 준다 —
 *                    거짓이면 단추를 감춘다(codex 엔 그 모드가 없다).
 * ⚠ 값은 **실측만** 적는다. 모르면 사고가 나지 않는 쪽(«아무 일도 안 일어난다»)으로 두고 미실측이라고 적는다 —
 *  추측한 true 는 엉뚱한 키를 흘려 다음 화면을 건드린다.
 */
export interface TermUi {
  appMouse: boolean;
  choiceNeedsEnter: boolean;
  pastePlaceholder: boolean;
  startDialogRe: RegExp | null;
  copyBridge: boolean;
  pasteBurst: boolean;
  permModes: boolean;
}

/** 미실측 하네스의 화면 사실 — 전부 «사고가 안 나는 쪽». 실측이 생기면 그 어댑터에서 값을 덮어쓴다.
 *  copyBridge=false — 모르는 앱에 ^C 를 «복사» 라고 보내지 않는다(끄는 키일 수 있다). 드래그는 Shift/⌥ 로 웹이 직접 고른다. */
export const TERM_UI_UNKNOWN: TermUi = {
  appMouse: false, choiceNeedsEnter: false, pastePlaceholder: false, startDialogRe: null,
  copyBridge: false, pasteBurst: false, permModes: false,
};

/**
 * 브라우저로 보내는 모양 — 정규식은 source 만 실어 보낸다(플래그는 받는 쪽이 'i' 로 고정한다).
 * 화면이 이 값을 **하나의 출처**에서 받아야 서버와 갈리지 않는다(종전엔 web 에 사본이 박혀 있었다).
 */
export interface TermUiWire {
  appMouse: boolean;
  choiceNeedsEnter: boolean;
  pastePlaceholder: boolean;
  startDialog: string | null;
  //  #5332 — 구 화면(이 필드를 모르는 번들)은 그냥 무시한다. 새 화면은 필드가 없으면(구 서버) 종전 동작으로 간다.
  copyBridge: boolean;
  pasteBurst: boolean;
  permModes: boolean;
}

export function termUiWire(t: TermUi): TermUiWire {
  return {
    appMouse: t.appMouse,
    choiceNeedsEnter: t.choiceNeedsEnter,
    pastePlaceholder: t.pastePlaceholder,
    startDialog: t.startDialogRe ? t.startDialogRe.source : null,
    copyBridge: t.copyBridge,
    pasteBurst: t.pasteBurst,
    permModes: t.permModes,
  };
}
