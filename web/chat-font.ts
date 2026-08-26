// 대화창 글자 크기 (#2055) — **순수**(DOM·네트워크를 모른다. 저장소는 인자로 받는다).
//
//  ── 왜 이 화면만 키우는 손잡이가 필요한가 ──
//  대화창은 무엇보다 **읽는 화면**이다. 본문·코드 블록·도구 원문이 한 화면에 섞여 있어 알맞은 밀도가
//  사람마다 다른데, 브라우저 확대는 사이드바·터미널까지 같이 키워 이 화면만 키울 수단이 없었다(실측 신고).
//
//  ── 왜 순수 모듈로 떼어냈나 ──
//  값이 **localStorage 에서 온다** = 사람이 손댈 수 있고, 옛 버전이 남긴 값도 그대로 들어온다. 범위를
//  안 지키면 배율이 0·NaN 이 되어 대화창이 통째로 빈 화면이 된다 — 그건 '버그'로 안 읽히고 원인도 안 보인다.
//  chat-view.ts 는 전역(document·location)을 잡아 테스트가 못 붙으므로, 지켜야 할 규칙만 여기로 내린다
//  (chat-tool-group.ts·chat-diff.ts 와 같은 결).

export const CHAT_FONT_KEY = 'lively_chat_fontsize';

/** 배율표. 본문·코드·도구 원문이 **한 배율로** 함께 움직인다 — 일부만 커지면 위계가 깨진다. */
export const CHAT_FONT_SCALES = [0.88, 1, 1.14, 1.3] as const;
export const CHAT_FONT_LABELS = ['작게', '보통', '크게', '아주 크게'];

/**
 * (순수) 저장된 값 → 단계. 모르는 값·범위 밖은 전부 '보통'(1)으로 접는다.
 *  ⚠ 빈 값을 먼저 걸러야 한다 — `Number(null)`·`Number('')`·`Number(' ')` 는 전부 **0**(= '작게')이라,
 *   그냥 Number 로 받으면 **저장된 적 없는 브라우저가 처음부터 작은 글씨로** 열린다(테스트가 잡았다).
 */
export function parseFontStep(raw: string | null | undefined): number {
  const s = String(raw ?? '').trim();
  if (!s) return 1;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n < CHAT_FONT_SCALES.length ? n : 1;
}

/** (순수) 다음 단계로 한 칸 — 메뉴가 이걸로 순환한다(끝에서 처음으로 돌아온다). */
export function nextFontStep(step: number): number {
  return (parseFontStep(String(step)) + 1) % CHAT_FONT_SCALES.length;
}

/** (순수) 단계 → CSS 배율. 범위 밖이면 1(글자가 사라지는 배율을 절대 만들지 않는다). */
export function fontScale(step: number): number {
  return CHAT_FONT_SCALES[parseFontStep(String(step))] ?? 1;
}
