// Claude Code 의 «한도 자동 이어감» 대기를 대화 기록에서 읽는다 (#4810 · 프로젝트 #4690). 순수 — 파일·tmux 를 모른다.
//
// ── 왜 ──────────────────────────────────────────────────────────────────────────────────────────
//  Claude Code(2.1.301 실측)는 턴 도중 사용 한도에 닿으면 모델에게 «곧 끊기니 정리하라» 는 안내(isMeta · usageLimitNote "wrap_up")를
//  넣는다. 모델이 정리하고 턴을 **정상 종료**하면(Stop 훅이 뜬다) 하네스 **안에서** 한도가 풀리는 시각까지 기다렸다가 스스로 이어 간다
//  («Your claude.ai usage limit has reset. Continue the task …»). 우리 훅은 그 Stop 을 «쉼» 으로 보고하므로 하네스 종료 규칙이 «완료» 로
//  읽고 3분 뒤 껐다 — 끄면 그 대기도 함께 사라진다(Claude Code 문구: «Automatic continue cancelled · Claude Code exited during the wait …»).
//  실측 2026-10-16: 상민님 세션 5개가 «4:10pm 에 이어감» 을 띄운 채 16:02~16:04 에 꺼졌고, 다시 연 세션도 사람이 말을 보내야 움직였다.
//
// ── 무엇으로 읽나 ─────────────────────────────────────────────────────────────────────────────────
//  대기의 시작과 끝은 대화 기록에 `type:"system" · subtype:"informational"` 줄로 남는다(본체 문자열 — 2.1.301):
//   걸림  «Usage limit reached · continuing automatically at 4:10pm · esc to cancel»         (턴이 한도에 닿아 자동으로 걸림)
//         «Usage limit reached again · continuing automatically at 4:10pm · esc to cancel»   (대기 중 사람이 보낸 말이 다시 막힘)
//   풀림  «Usage limit reset · continuing automatically» · «Usage limit available again · continuing now» (이어 감)
//         «Usage limit has reset · press enter to continue» (늦게 깸 — 사람이 Enter 를 쳐야 이어진다)
//         «Automatic continue cancelled …» · «… was turned off …» · «… stopped …» · «… did not run …» (접힘)
//  줄 없이 풀리는 경우가 둘 있다:
//   · 대기 중 **사람이 말을 보내면** Claude Code 가 대기를 조용히 접는다(manual_submit) — 그 말이 다시 막히면 위 «again» 줄이 새로 붙는다.
//     사람의 말은 `origin.kind:"human"` 으로 남는다. 작업 알림(task-notification)·자동 이어감(auto-continuation) 턴은 대기를 접지 않는다
//     (실측: 걸린 뒤 백그라운드 작업 알림이 와서 한 턴 돌고 끝나도 대기는 그대로였다).
//   · 한도가 풀린 뒤 다시 띄운 하네스가 «앞선 한도 안내는 이제 무효» 쪽지(isMeta · usageLimitNote "release")를 넣는다.
//  ⚠ 줄 없이 **다시 걸리는** 경우(이어 간 턴이 또 막힘 · 사람이 대화상자로 «기다리기» 를 고름)는 여기서 못 읽는다 — 그 턴은 API 거절로
//   끝나 Stop 훅이 안 뜨고 «작업 중» 보고가 남아, 종료 규칙이 이미 «작업 중» 으로 지킨다.
//  ⚠ 걸림 문구는 Claude Code 가 원격 설정으로 바꿀 수 있다(본체: 문구 안에 «{when}» 만 있으면 받는다). 그러면 여기서 못 알아보고 종전처럼
//   끈다 — 지금보다 나빠지지는 않는다. 그래서 문구 전체가 아니라 «continuing automatically … esc to cancel» 두 조각만 본다.
//
// ── 상한 ────────────────────────────────────────────────────────────────────────────────────────
//  · 자동으로 걸리는 대기는 풀리는 시각이 24시간 안일 때뿐이다(그 너머는 Claude Code 가 «Automatic continue stopped · … more than 24 hours
//    out» 으로 접는다). 그래서 걸린 줄에서 `QUOTA_WAIT_MAX_MS` 가 지나면 대기로 보지 않는다 — 풀림 줄을 놓친 대기가 세션을 영영 붙잡지 않게.
//  · 하네스를 다시 띄우면 그 전 프로세스의 대기는 사라진다(Claude Code 가 relaunch 로 접는다) — 하네스를 띄운 시각보다 앞선 줄은 안 본다.

/** 대화 기록이 말하는 «지금 걸려 있는 자동 이어감». */
export interface QuotaWait {
  /** 걸림 줄의 시각(ms) */
  armedAtMs: number;
  /** 걸림 줄 문구 그대로(로그·진단용 — «at 4:10pm» 이 들어 있다) */
  text: string;
}

/** 걸린 줄에서 이만큼 지나면 대기로 보지 않는다 — Claude Code 의 자동 대기 한도(24시간) + 풀리는 시각 뒤 이어 가기까지의 여유(30분). */
export const QUOTA_WAIT_MAX_MS = (24 * 60 + 30) * 60_000;

const ARMED = /\bcontinuing automatically\b.*\besc to cancel\b/i;
const RELEASED = /^\s*(?:usage limit (?:reset|available again|has reset)\b|automatic continue\b)/i;

/** 사람이 친 말인가 — 2.1.301 은 `origin.kind`(·`turnOrigin`)를 남긴다. 표식이 없으면 사람의 말로 보지 않는다(대기를 접지 않는 쪽). */
function humanPrompt(l: Record<string, unknown>): boolean {
  const o = l.origin;
  return (!!o && typeof o === "object" && (o as { kind?: unknown }).kind === "human") || l.turnOrigin === "human";
}

/**
 * (순수) 대화 기록 줄(오래된 순)에서 지금 걸려 있는 자동 이어감을 찾는다 — 없으면 null.
 *  @param sinceMs  하네스(tmux 세션)를 띄운 시각 — 이보다 앞선 걸림 줄은 그 전 프로세스의 것이다. 0 이면 보지 않는다.
 *  @param nowMs    지금
 */
export function quotaWaitOf(lines: ReadonlyArray<unknown>, at: { sinceMs: number; nowMs: number }): QuotaWait | null {
  let w: QuotaWait | null = null;
  for (const raw of lines) {
    if (!raw || typeof raw !== "object") continue;
    const l = raw as Record<string, unknown>;
    if (l.type === "system" && l.subtype === "informational" && typeof l.content === "string") {
      if (RELEASED.test(l.content)) w = null;
      else if (ARMED.test(l.content)) {
        //  시각이 없는 걸림 줄은 상한을 잴 수 없다 — 대기로 보지 않는다(세션을 영영 붙잡는 쪽보다 종전처럼 끄는 쪽).
        const t = Date.parse(String(l.timestamp ?? ""));
        w = Number.isFinite(t) ? { armedAtMs: t, text: l.content } : null;
      }
      continue;
    }
    if (l.type === "user" && (humanPrompt(l) || l.usageLimitNote === "release")) w = null;
  }
  if (!w) return null;
  if (at.sinceMs > 0 && w.armedAtMs < at.sinceMs) return null;
  if (at.nowMs - w.armedAtMs > QUOTA_WAIT_MAX_MS) return null;
  return w;
}
