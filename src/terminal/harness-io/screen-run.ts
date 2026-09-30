// #4502 — 화면 판정(screen)의 busy 를 «턴이 돈다»(ScreenRun turn)로 쓰는 하네스들의 공용 규칙. 잎 모듈이다(어댑터 파일들이
//  import 한다 — adapter.ts 에 두면 adapter.ts ↔ codex.ts 순환이 된다. 타입만 adapter.ts 에서 받는다).
//
//  ⚠ 꼬리를 **맨 아래 몇 줄로** 줄여서 묻는다. codex·antigravity·grok·opencode 의 screen 은 꼬리 전체를 문자열로 훑는다
//   («esc to interrupt» 가 어디 있든 busy). 그 판정은 원래 «지금 글자를 넣어도 되나» 만 가렸다 — 틀려도 입력이 잠깐 기다릴 뿐이다.
//   run 은 그 답으로 파란 점·마지막 작업 시각·회수 무상한 보호를 준다. 대화 본문(도구 출력·AI 답)에 같은 문구가 있으면
//   멈춘 세션이 영영 «방금 일함» 으로 굳는다(격리 리뷰 재현: 14줄 위 `rg 'esc to interrupt'` 출력 → turn).
//   도는 표시는 네 하네스 모두 화면 맨 아래 몇 줄에 선다(실측 fixture — contract.test FIXTURES): codex «• Working (… esc to
//   interrupt)» 는 컴포저 바로 위, 나머지 셋은 푸터(맨 끝 줄). 컴포저에 여러 줄을 쳐 두면 창 밖으로 밀려 못 볼 수 있다 — 그건
//   «모른다»(점 없음)로 떨어질 뿐 거짓 «작업 중» 은 아니다.
import type { ScreenRun, ScreenState } from "./adapter.js";

export const RUN_FROM_SCREEN_LINES = 6;

export function turnFromScreen(screen: ((tail: string[]) => ScreenState | null) | null, tail: string[]): ScreenRun | null {
  return screen?.(tail.slice(-RUN_FROM_SCREEN_LINES)) === "busy" ? "turn" : null;
}
