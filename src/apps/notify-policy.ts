// 앱 알림의 **판정과 정규화**(#1891). 순수 — DB·시계·네트워크를 모르고, 부르는 쪽이 값을 넣어 준다.
//
// 왜 순수로 떼어 뒀나: 여기 담긴 규칙(권한 fail-closed · 외부 href 차단 · 전이에만 반응 · 중복 억제)은
//  전부 "안 되면 조용히 안 되는" 종류라 실행 경로에 묻어 두면 회귀를 눈으로 못 잡는다.
//  실제 발송·저장은 src/apps/notify.ts, 자동 알림 배선은 src/terminal/sessions.ts 가 한다.

/** 알림 배너 한 줄이 감당하는 길이 — 넘으면 자른다(거부하지 않는다). OS 배너는 어차피 더 짧게 줄인다. */
export const NOTIFY_TITLE_MAX = 120;
export const NOTIFY_BODY_MAX = 400;
/** 같은 dedupe_key 를 이 시간 안에 다시 쏘면 새 알림을 만들지 않는다(하네스 상태 떨림 방어). */
export const NOTIFY_DEDUPE_COOLDOWN_MS = 60_000;

export type NotifyDenial =
  | "notify-app-required"          // 앱 신원이 없다 — 알림은 앱이 보내는 것이다
  | "notify-permission-missing"    // 매니페스트에 permissions.notifications 가 없다
  | "notify-grant-missing"         // 그 멤버의 활성 grant 가 없다
  | "notify-title-required";       // 제목이 비었다

/**
 * 이 호출이 알림을 쏠 수 있나. 허용이면 null, 아니면 사유.
 *
 * ⚠ **fail-closed** — 셋 중 하나라도 없으면 거부한다. "권한은 나중에" 로 열어 두면 그 나중이 오지 않고,
 *  그동안 아무 앱이나 사용자 이름으로 배너를 띄울 수 있게 된다.
 */
export function decideNotifyAllowed(input: {
  appId: string | null | undefined;
  declaresNotifications: boolean;
  hasActiveGrant: boolean;
  /** 이 앱이 제품 자신인가(source.kind === "builtin"). 빌트인은 동의를 따로 받지 않는다 — 아래 참조. */
  isBuiltin?: boolean;
}): NotifyDenial | null {
  if (!input.appId) return "notify-app-required";
  if (!input.declaresNotifications) return "notify-permission-missing";
  // ★ 빌트인은 grant 를 요구하지 않는다(2026-08-26 결정).
  //  grant 가 답하는 질문은 "**남의 앱**이 내 이름으로 행동해도 되나" 다. ai-session 은 남의 앱이 아니라
  //  지금 내가 쓰고 있는 화면 자체다 — 세션을 여는 데 동의가 필요 없는데 그 세션이 나를 부르는 데만
  //  동의를 요구하는 건 앞뒤가 맞지 않는다.
  //  ⚠ 그리고 실제로 죽어 있었다: 동의 창은 **런치패드에서 앱을 열 때만** 뜨는데 세션은 그 경로로 열리지
  //   않는다 → 아무도 ai-session grant 를 가진 적이 없고, 그래서 알림 이력이 한 사람(수동 부여)에게만
  //   쌓였다(dev 실측 2026-08-26: 조직 전체 grant 4건이 전부 테스트로 만든 것).
  //  끄는 수단은 [내 정보 ▸ 알림] 토글이 이미 준다(#1842 — "끌 수단 없는 알림은 만들지 않는다").
  //  서드파티(installed·git·path)는 그대로 fail-closed 다.
  if (!input.isBuiltin && !input.hasActiveGrant) return "notify-grant-missing";
  return null;
}

/** 개행·탭·제어문자를 공백 한 칸으로 접는다 — OS 알림 배너가 여러 줄을 만나면 깨진다. */
function flatten(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 알림 클릭이 향할 곳 — **우리 화면 안**만 받는다.
 *
 * ⚠ 외부 URL 을 그대로 두면 알림이 곧 피싱 경로가 된다("작업이 끝났어요" 배너를 누르면 남의 사이트).
 *  `//evil.tld`(스킴 상대)와 `javascript:` 도 같은 이유로 버린다. 버릴 때 **알림 자체는 살린다** —
 *  링크가 없다고 알림이 안 오는 건 사용자에게 더 나쁘다.
 */
export function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const h = href.trim();
  if (!h) return null;
  if (h.startsWith("//")) return null;                 // 스킴 상대 = 외부
  if (!h.startsWith("#/") && !h.startsWith("/")) return null;  // 절대 URL·javascript: 등 전부 여기서 걸린다
  return h;
}

export interface NormalizedNotification {
  title: string;
  body: string | null;
  href: string | null;
  dedupeKey: string | null;
}

/** 저장 직전 모양으로 다듬는다. 제목이 비면 거부(사유), 그 밖엔 잘라서라도 살린다. */
export function normalizeNotification(input: {
  title?: unknown; body?: unknown; href?: unknown; dedupe_key?: unknown;
}): { ok: true; value: NormalizedNotification } | { ok: false; denial: NotifyDenial } {
  const title = flatten(typeof input.title === "string" ? input.title : "").slice(0, NOTIFY_TITLE_MAX);
  if (!title) return { ok: false, denial: "notify-title-required" };
  const bodyRaw = flatten(typeof input.body === "string" ? input.body : "").slice(0, NOTIFY_BODY_MAX);
  const key = typeof input.dedupe_key === "string" ? input.dedupe_key.trim().slice(0, 200) : "";
  return {
    ok: true,
    value: { title, body: bodyRaw || null, href: safeHref(input.href), dedupeKey: key || null },
  };
}

/**
 * 중복 억제 — 같은 key 의 직전 알림이 쿨다운 **안**이면 새로 만들지 않는다.
 *
 * 경계는 "정확히 쿨다운만큼 지났으면 허용"이다(`>=`). key 가 없으면 억제하지 않는다 —
 *  호출자가 억제를 원하지 않는다고 명시한 것으로 본다.
 */
export function shouldSuppressDuplicate(
  dedupeKey: string | null,
  lastSentAtMs: number | null,
  nowMs: number,
  cooldownMs: number = NOTIFY_DEDUPE_COOLDOWN_MS,
): boolean {
  if (!dedupeKey || lastSentAtMs === null) return false;
  return nowMs - lastSentAtMs < cooldownMs;
}

/**
 * ai-session 자동 알림(#1891) — "유저의 액션을 필요로 하는 상태"로 **전이**한 세션만 고른다.
 *
 * @param previous 직전 관측(세션 id → awaiting 이었나)
 * @param observed 이번 관측 — **이번에 보인 세션만** 담는다
 * @returns notify: 알림 보낼 세션 id · next: 다음 비교에 쓸 상태
 *
 * ⚠ 규칙 둘:
 *  · **전이에만 반응한다.** awaiting 이 유지되는 동안 매 폴링마다 쏘면 1분에 세 번 울린다.
 *  · **관측에서 사라진 세션의 상태는 지우지 않는다.** 잠깐 목록에 안 잡힌 것과 "사용자가 답을 했다"를
 *    구분할 수 없다. 지워 버리면 다시 나타날 때 false→true 로 읽혀 **알림이 중복**된다.
 *    (첫 관측에서 이미 awaiting 인 세션은 전이로 본다 — 그게 사용자가 놓친 알림이다.)
 */
export function pickAwaitingTransitions(
  previous: ReadonlyMap<string, boolean>,
  observed: ReadonlyArray<{ id: string; awaiting: boolean }>,
): { notify: string[]; next: Map<string, boolean> } {
  const next = new Map(previous);
  const notify: string[] = [];
  for (const s of observed) {
    const was = previous.get(s.id) ?? false;
    if (s.awaiting && !was) notify.push(s.id);
    next.set(s.id, s.awaiting);
  }
  return { notify, next };
}
