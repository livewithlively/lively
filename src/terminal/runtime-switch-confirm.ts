// 이미 떠 있는 세션의 모델·추론강도를 바꿀 때 뜨는 **확인창을 눌러 준다** (#4772).
//
// ── 왜 ──────────────────────────────────────────────────────────────────────────
// Claude Code 2.1.29x+ 는 대화 기록이 있고 캐시가 따뜻한 세션에서 `/model`·`/effort` 를 치면 곧바로 바꾸지 않고
//  확인창을 띄운다(실측 2.1.300):
//    Switch model?              /  Change effort level?
//    This conversation is cached for the current model. Switching … means the full history gets re-read …
//    ❯ 1. Yes, switch to Opus 5.5
//      2. No, go back
//  POST …/runtime 은 `/model …` 을 제출하기만 하고 이 창을 안 눌러, **모델이 실제로 안 바뀌고**(원준 2026-10-16
//  «진짜 바꾸면 바로 바뀌게») 치워 둔 초안(runtimeDraftStash)이 창 뒤에 숨은 채로 남았다. 기본 하이라이트가
//  «❯ 1. Yes» 라 Enter 한 번이면 바뀌고, 그 직후 Claude Code 가 초안을 제자리에 돌려놓는다(«Draft restored», 실측).
//
// ── 안전 ─────────────────────────────────────────────────────────────────────────
// · 블라인드 Enter 금지(#3949 교훈 — 신뢰 대화상자 기본이 «No, exit» 라 블라인드 Enter 가 하네스를 껐다). 여기선
//   **화면을 읽어** 확인창이 떠 있고 «❯ 1. Yes» 가 하이라이트일 때만 Enter 한다. 미래 판이 기본을 «No» 로 바꾸면
//   `❯ 1. Yes` 가 안 잡혀 아무것도 안 누른다(종전 동작으로 안전하게 떨어진다).
// · 확인창이 **아닌데** Enter 를 누르면 복원된 초안이 제출돼 버린다 — 그래서 "done"(입력창이 돌아옴)이면 손대지 않는다.
//
// 순수 판정(`runtimeSwitchAction`)만 의존성 없이 두어 아웃박스(노드 번들)와 노드 라우트가 함께 쓴다.

/** 확인창 제목 — 모델·추론강도 두 가지. */
const SWITCH_TITLE = /Switch model\?|Change effort level\?/;
/** 기본 하이라이트가 «Yes» 인가(❯ 가 1번 줄 Yes 에). 아니면 누르지 않는다. */
const YES_DEFAULT = /❯\s*1\.\s*Yes\b/;
/** 입력창이 돌아왔나(아이들) — 이 꼴이면 전환이 끝났거나(직접 전환) 확인창이 애초에 없었다. */
const INPUT_READY = /\b(auto|manual|plan|accept edits|bypass permissions) mode on\b|\? for shortcuts|shift\+tab to cycle/i;

/** 화면 꼬리만 본다 — 윗쪽 스크롤백의 지난 전환 흔적("Set model to …")을 보지 않으려고. */
const TAIL_LINES = 16;
function tail(pane: string): string {
  return pane.split("\n").map((l) => l.replace(/\s+$/u, "")).filter((l) => l.trim() !== "").slice(-TAIL_LINES).join("\n");
}

/**
 * 제출 뒤 한 화면을 읽고 **무엇을 할지**(순수):
 *  · confirm — 확인창이 떠 있고 Yes 가 기본 → Enter 로 확인한다.
 *  · done    — 입력창이 돌아왔다 → 손대지 않는다(직접 전환됐거나 확인창이 없는 판).
 *  · wait    — 아직 처리 중(스피너 등) → 다시 읽는다.
 *  ⚠ confirm 을 done 보다 먼저 본다 — 확인창이 떠 있는 동안엔 아이들 푸터가 안 보이지만, 순서를 뒤집으면 위험하다.
 */
export function runtimeSwitchAction(pane: string): "confirm" | "done" | "wait" {
  const t = tail(pane);
  if (SWITCH_TITLE.test(t) && YES_DEFAULT.test(t)) return "confirm";
  if (INPUT_READY.test(t)) return "done";
  return "wait";
}

/** 화면을 읽고 Enter 를 누를 수 있는 최소 실행 인터페이스 — 아웃박스 exec 과 노드 RPC 어댑터가 모두 맞춘다. */
export interface SwitchExec {
  /** 화면 한 번(ok 면 pane 문자열) */
  peek(): Promise<{ ok: boolean; pane?: string }>;
  /** Enter 한 번(실패는 삼킨다) */
  enter(): Promise<void>;
}

export interface ConfirmClock {
  sleep: (ms: number) => Promise<void>;
}

/** 제출 직후 창이 그려지기까지 한 템포 기다렸다 본다. */
export const CONFIRM_INITIAL_MS = 400;
export const CONFIRM_POLL_MS = 250;
export const CONFIRM_MAX_POLLS = 16;   // ≈ 400 + 16×250 = 4.4s 상한

/**
 * 제출된 모델·추론강도 명령의 **확인창을 눌러 준다**. 결과:
 *  · "confirmed" — 창을 Enter 로 확인했다.
 *  · "none"      — 확인창이 없었다(직접 전환 또는 그런 창이 없는 판) — 할 일 없음.
 *  · "unknown"   — 화면을 못 읽었거나(세션 사라짐·미지원 노드) 상한까지 둘 다 못 봤다 — best-effort 로 포기.
 * 어느 쪽도 던지지 않는다(명령은 이미 나갔다 — 창 확인은 보조 단계다).
 */
export async function confirmRuntimeSwitch(
  exec: SwitchExec,
  clock: ConfirmClock,
  opts: { initialMs?: number; pollMs?: number; maxPolls?: number } = {},
): Promise<"confirmed" | "none" | "unknown"> {
  const initialMs = opts.initialMs ?? CONFIRM_INITIAL_MS;
  const pollMs = opts.pollMs ?? CONFIRM_POLL_MS;
  const maxPolls = opts.maxPolls ?? CONFIRM_MAX_POLLS;
  await clock.sleep(initialMs);
  for (let i = 0; i < maxPolls; i++) {
    const seen = await exec.peek().catch(() => ({ ok: false as const }));
    if (!seen.ok) return "unknown";
    const act = runtimeSwitchAction(seen.pane ?? "");
    if (act === "confirm") { await exec.enter(); return "confirmed"; }
    if (act === "done") return "none";
    await clock.sleep(pollMs);
  }
  return "unknown";
}
