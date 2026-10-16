// Claude Code 의 «한도 자동 이어감» 대기를 대화 기록에서 읽는다 (#4810 · 프로젝트 #4690). 순수 — 파일·tmux 를 모른다.
//
// ── 왜 ──────────────────────────────────────────────────────────────────────────────────────────
//  Claude Code(2.1.301 실측)는 턴 도중 사용 한도에 닿으면 모델에게 «곧 끊기니 정리하라» 는 안내(isMeta · usageLimitNote "wrap_up")를
//  넣는다. 모델이 정리하고 턴을 **정상 종료**하면(Stop 훅이 뜬다) 하네스 **안에서** 한도가 풀리는 시각까지 기다렸다가 스스로 이어 간다
//  («Your claude.ai usage limit has reset. Continue the task …»). 우리 훅은 그 Stop 을 «쉼» 으로 보고하므로 하네스 종료 규칙이 «완료» 로
//  읽고 3분 뒤 껐다 — 끄면 그 대기도 함께 사라진다(Claude Code 문구: «Automatic continue cancelled · Claude Code exited during the wait …»).
//  실측 2026-10-16: 상민님 세션 5개가 «4:10pm 에 이어감» 을 띄운 채 16:02~16:04 에 꺼졌고, 다시 연 세션도 사람이 말을 보내야 움직였다.
//
// ── 무엇으로 읽나 — 대화 기록 줄의 흐름(오래된 순) ────────────────────────────────────────────────────
//  대기의 시작·끝은 `type:"system" · subtype:"informational"` 줄로 남는다(본체 문자열 — 2.1.301):
//   걸림   «Usage limit reached · continuing automatically at 4:10pm · esc to cancel»         (턴이 한도에 닿아 자동으로 걸림)
//          «Usage limit reached again · continuing automatically at 4:10pm · esc to cancel»   (대기 중 사람이 보낸 말이 다시 막힘)
//          + 사용자 줄 `<local-command-stdout>Claude Code will continue automatically at 4:10pm. … Press esc to cancel the wait.</…>`
//            (사람이 한도 대화상자에서 «기다리기» 를 골랐다 — 아래 #4821 ③)
//   이어 감 «Usage limit reset · continuing automatically» · «Usage limit available again · continuing now»
//          — 그 뒤 자동 이어감 메시지(origin auto-continuation)가 큐에 서서 새 턴이 돈다. **그 메시지 뒤의** 턴이 끝나면(turn_duration)
//            대기는 끝난 것이다(이어 감 메시지는 큐 뒤쪽에 서므로, 그 사이 끝난 작업 알림 턴의 끝은 세지 않는다 — 격리 리뷰).
//   접힘   «Usage limit has reset · press enter to continue» (늦게 깸 — 사람이 Enter 를 쳐야 이어진다)
//          «Automatic continue cancelled …» · «… was turned off …» · «… stopped …» · «… did not run …»
//  줄 없이 바뀌는 경우:
//   · 대기 중 **사람이 말을 보내면** Claude Code 가 대기를 조용히 접는다(manual_submit) — 그 말이 다시 막히면 위 «again» 줄이 새로 붙는다.
//     사람의 말은 `origin.kind:"human"` 으로 남는다(메타·사이드체인 줄은 아니다). 작업 알림(task-notification) 턴은 대기를 접지 않는다
//     (실측: 걸린 뒤 백그라운드 작업 알림이 와서 한 턴 돌고 끝나도 대기는 그대로였다).
//   · **이어 간 턴이 또 한도에 닿으면** 줄 없이 다시 걸린다(본체: 턴 끝 처리가 이어 가는 중이면 걸림 줄 없이 다시 건다 — 연달아 두 번까지,
//     그 너머는 «Automatic continue stopped …» 줄). 그 턴은 처음과 같은 정리 안내(wrap_up)로 끝나거나, 한도 오류 줄(assistant ·
//     isApiErrorMessage · apiError "usage_limit_reached" — 첫 요청부터 막혔거나 정리 유예가 다 돼 끊겼다)로 끝난다 — 자동 이어감 메시지 **뒤의** 둘 다 다시 걸림으로 읽는다
//     (그 메시지 전의 다른 턴 · 그 턴이 끝난 뒤의 다른 턴의 것은 아니다 — 격리 리뷰 3차). apiError 가 없는 오류(서버 스로틀 등 error "rate_limit"
//     만)는 계정 한도가 아니다 — 다시 걸림이 아니다. 이어 간 턴이 Esc 로 끊기면 턴 끝 줄이 안 남는다 — 그 뒤 다른 턴(작업 알림 등)이 오면
//     이어 간 턴은 끝난 것으로 본다.
//   · «앞선 한도 안내는 이제 무효» 쪽지(isMeta · usageLimitNote "release")는 대기를 바꾸지 않는다 — 정리 안내 뒤 한도가 풀린 다음 턴의 첫 요청에
//     붙는다(실측: 사람 말 4.7초 뒤 · 본체 코드상 자동 이어 간 턴에도 붙는다). 다시 띄운 하네스의 대기는 아래 «띄운 시각» 조건이 맡는다
//     (실측 복원 세 세션엔 relaunch 접힘 줄이 없었다 — 풀리는 시각 뒤에 다시 띄웠기 때문).
//  ── #4821 — #4810 이 못 읽던 셋(본체 2.1.301 코드: 줄을 남기는 건 자동 걸림 «auto-armed»·사람 말이 다시 막힘 «taken-over» 뿐이다) ──
//   ① **이어 간 턴이 읽는 창(대화 기록 끝 1MB · session-quota-wait.ts)보다 길 때** — 근거(이어 감 줄·이어감 메시지)는 그 턴의 맨 앞에, 증거
//     (정리 안내·한도 오류)는 맨 끝에 있다(실측 대화 기록은 시간당 2~35MB — 1MB ≈ 8분 작업). 정리 안내 줄엔 그 턴의 promptId 만 있고 출처
//     (origin·turnOrigin)는 그 턴의 첫 줄에만 있다. 그래서 창 맨 앞 턴(openTurnOf)을 «이어 간 턴» 으로 가정하면 다시 걸림이 나올 때만, 읽는 쪽이
//     그 턴의 첫 줄을 창 앞쪽으로 거슬러 찾아 출처를 넘긴다(quotaScan 의 openTurnKind). 거슬러 찾는 상한(128MB) 밖이면 종전처럼 못 본다.
//   ② **턴 시작에서 막힌 대기** — 걸림 줄은 남는다(실측: 한도 오류 줄 → 걸림 줄 → 턴 끝). 막힌 턴엔 Stop 대신 StopFailure 훅이 떠서 «작업 중»
//     보고만 남아 종료 규칙이 이 판정까지 오지 않던 것이 문제였다 — 작업 표시 훅이 StopFailure 도 «쉼» 으로 보고한다(kit/hooks/work-flag.mjs).
//     그 배선이 아직 없는 옛 키트의 세션은 종전대로다(«작업 중» 10분 → «예약 모름» → 옛 회수 시계).
//   ③ **사람이 한도 대화상자(/rate-limit-options)에서 «기다리기» 를 고른 대기** — 본체가 걸림 줄을 안 남기지만 명령 결과가 위 사용자 줄로
//     남는다(local-jsx 명령의 기본 표시 — 명령 줄·결과 줄엔 origin 이 없어 사람 말로 안 읽힌다). 그 줄을 걸림으로 본다. 이 대기는 24시간
//     너머의 풀림 시각도 기다리지만 여기선 같은 상한(QUOTA_WAIT_MAX_MS)을 건다.
//  «이어 감» 줄 뒤 이어 간 턴이 끝나기 전은 «막 이어 가는 중»(resuming)이다 — 한도가 풀린 순간과 종료 규칙의 판이 겹치면 이어 가기 시작한
//   하네스를 끌 수 있어서(격리 리뷰), 그 줄에서 `QUOTA_RESUME_GRACE_MS` 동안은 지킨다(예약 깨움의 WAKE_GRACE_SEC 와 같은 뜻).
//  ⚠ 걸림 문구는 Claude Code 가 원격 설정으로 바꿀 수 있다(본체: 문구 안에 «{when}» 만 있으면 받는다). 그러면 여기서 못 알아보고 종전처럼
//   끈다 — 지금보다 나빠지지는 않는다. 그래서 문구 전체가 아니라 «continuing automatically … esc to cancel» 두 조각만 본다.
//
// ── 상한 ────────────────────────────────────────────────────────────────────────────────────────
//  · 자동으로 걸리는 대기는 풀리는 시각이 24시간 안일 때뿐이다(그 너머는 Claude Code 가 «Automatic continue stopped · … more than 24 hours
//    out» 으로 접는다). 그래서 걸린 줄에서 `QUOTA_WAIT_MAX_MS` 가 지나면 대기로 보지 않는다 — 풀림 줄을 놓친 대기가 세션을 영영 붙잡지 않게.
//  · 줄 시각이 지금보다 `QUOTA_CLOCK_SKEW_MS` 넘게 앞서면(깨진 시계) 대기로 보지 않는다 — 미래 시각이면 상한이 영영 안 선다(phase.ts 의 같은 함정).
//  · 하네스를 다시 띄우면 그 전 프로세스의 대기는 사라진다(Claude Code 가 relaunch 로 접는다) — 하네스를 띄운 시각보다 앞선 줄은 안 본다.

/** 대화 기록 줄에서 읽은 마지막 대기 사건 — 시각과 무관한 부분(같은 파일이면 다시 읽지 않고 이것만 다시 잰다). */
export interface QuotaScan {
  /** armed = 걸려서 기다리는 중 · fired = 풀려서 이어 가는 턴이 아직 안 끝남 */
  kind: "armed" | "fired";
  /** 그 사건 줄의 시각(ms) */
  atMs: number;
  /** 그 줄 문구(로그·진단용 — «at 4:10pm» 이 들어 있다) */
  text: string;
  /** fired 만 — 자동 이어감 메시지가 이미 왔나(그 뒤의 턴 끝이 «이어 간 턴의 끝» 이다) */
  continued?: boolean;
}

/** 지금 지켜야 하는 대기. */
export interface QuotaWait {
  /** armed = 자동 이어감이 걸려 기다리는 중 · resuming = 막 풀려 이어 가는 중(풀림 줄 뒤 유예 안) */
  kind: "armed" | "resuming";
  atMs: number;
  text: string;
  /** 이 대기가 스스로 끝나는 시각(ms) — resuming 만(풀림 줄 + 유예). 걸림 줄은 풀리는 시각을 글(«at 4:10pm»)로만 준다. */
  untilMs?: number;
}

/** 걸린 줄에서 이만큼 지나면 대기로 보지 않는다 — Claude Code 의 자동 대기 한도(24시간) + 풀리는 시각 뒤 이어 가기까지의 여유(30분). */
export const QUOTA_WAIT_MAX_MS = (24 * 60 + 30) * 60_000;
/** 풀림(이어 감) 줄 뒤 이만큼은 «막 이어 가는 중» 으로 지킨다 — 이어 간 턴은 보통 수 초 안에 «작업 중» 보고를 낸다. */
export const QUOTA_RESUME_GRACE_MS = 5 * 60_000;
/** 줄 시각이 지금보다 이만큼 넘게 앞서면 깨진 시계로 본다 — 세션 컨테이너와 게이트웨이의 시계 차이를 넉넉히 흡수한다. */
export const QUOTA_CLOCK_SKEW_MS = 5 * 60_000;

const ARMED = /\bcontinuing automatically\b.*\besc to cancel\b/i;
const FIRED = /^\s*usage limit (?:reset|available again)\b/i;
const RELEASED = /^\s*(?:usage limit has reset\b|automatic continue\b)/i;
const REARMED_WRAPUP = "이어 간 턴이 정리 안내로 끝났다(줄 없이 다시 걸림)";
const REARMED_ERROR = "이어 간 턴이 한도 오류로 끝났다(줄 없이 다시 걸림)";
/** 대화상자 «기다리기» 의 명령 결과(#4821 ③) — 본체 문구 «Claude Code will continue automatically at 4:10pm. … Press esc to cancel the wait.» 의 두 조각. */
const DIALOG = /\bcontinue automatically\b[\s\S]*\besc to cancel\b/i;
const STDOUT_OPEN = "<local-command-stdout>";
/** 창이 열릴 때 이미 돌던 «이어 간 턴» 의 출발 상태 문구(#4821 ① — 그 턴의 이어 감 줄은 창 앞이라 시각을 모른다). */
const OPEN_CONTINUED = "창 앞에서 시작한 이어 간 턴";

/** 사람이 친 말인가 — 2.1.301 은 `origin.kind`(·`turnOrigin`)를 남긴다. 표식이 없거나 메타 줄이면 사람의 말로 보지 않는다(대기를 접지 않는 쪽). */
function humanPrompt(l: Record<string, unknown>): boolean {
  if (l.isMeta === true) return false;
  const o = l.origin;
  return (!!o && typeof o === "object" && (o as { kind?: unknown }).kind === "human") || l.turnOrigin === "human";
}
const originKind = (l: Record<string, unknown>): unknown => (l.origin && typeof l.origin === "object" ? (l.origin as { kind?: unknown }).kind : undefined);

/** 대화상자 «기다리기» 의 결과 줄이면 그 문구(태그를 뗀 것), 아니면 null — 사용자 줄 본문이 `<local-command-stdout>` 로 시작하고 두 조각을 함께 담을 때만. */
function dialogArmText(l: Record<string, unknown>): string | null {
  const c = (l.message && typeof l.message === "object" ? (l.message as { content?: unknown }).content : undefined);
  const body = typeof c === "string" ? c
    : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("")
    : "";
  const t = body.trimStart();
  if (!t.startsWith(STDOUT_OPEN) || !DIALOG.test(t)) return null;
  return t.slice(STDOUT_OPEN.length).replace(/<\/local-command-stdout>\s*$/, "").trim().slice(0, 200);
}

/**
 * (순수) 창이 열릴 때 이미 돌던 턴의 promptId — 창 안에서 promptId 가 있는 첫 줄(사이드체인 제외)의 것. 그 줄이 턴의 첫 줄(출처 origin 이
 *  있다)이면 null: 창은 턴 경계에서 열렸거나, 그 앞 턴의 줄엔 promptId 가 없어(모델 답·시스템 줄뿐) 어느 턴인지 모른다. (#4821 ① — 읽는 쪽이
 *  이 턴의 첫 줄을 창 앞쪽으로 거슬러 찾아 출처를 quotaScan 에 넘긴다.)
 */
export function openTurnOf(lines: ReadonlyArray<unknown>): string | null {
  for (const raw of lines) {
    if (!raw || typeof raw !== "object") continue;
    const l = raw as Record<string, unknown>;
    if (l.isSidechain === true || typeof l.promptId !== "string" || !l.promptId) continue;
    return originKind(l) !== undefined ? null : l.promptId;
  }
  return null;
}

/**
 * (순수) 대화 기록 줄(오래된 순)에서 마지막 대기 사건을 읽는다 — 없으면 null. 시각 조건(상한·띄운 시각)은 quotaBound 가 건다.
 *  @param openTurnKind  창이 열릴 때 이미 돌던 턴(openTurnOf)의 첫 줄 출처 — 그 첫 줄은 창 앞이라 읽는 쪽이 찾아 넘긴다. "auto-continuation" 이면
 *                       그 턴은 «이어 감 + 이어감 메시지» 뒤에서 시작한다(#4821 ①). 시각 0: 그 턴이 안 끝난 채 창이 끝나도 «막 이어 가는 중»
 *                       유예를 주지 않는다(이어 감 줄의 진짜 시각을 모른다 — 다시 걸림만 본다).
 */
export function quotaScan(lines: ReadonlyArray<unknown>, openTurnKind?: string): QuotaScan | null {
  let st: QuotaScan | null = openTurnKind === "auto-continuation" ? { kind: "fired", atMs: 0, text: OPEN_CONTINUED, continued: true } : null;
  //  시각이 없는 사건 줄은 상한을 잴 수 없다 — 대기로 보지 않는다(세션을 영영 붙잡는 쪽보다 종전처럼 끄는 쪽).
  const event = (kind: "armed" | "fired", l: Record<string, unknown>, text: string): QuotaScan | null => {
    const t = Date.parse(String(l.timestamp ?? ""));
    return Number.isFinite(t) ? (kind === "fired" ? { kind, atMs: t, text, continued: false } : { kind, atMs: t, text }) : null;
  };
  for (const raw of lines) {
    if (!raw || typeof raw !== "object") continue;
    const l = raw as Record<string, unknown>;
    if (l.isSidechain === true) continue;   // 서브에이전트의 대화 — 본 대화의 대기와 무관하다
    if (l.type === "system") {
      if (l.subtype === "informational" && typeof l.content === "string") {
        if (FIRED.test(l.content)) st = event("fired", l, l.content);
        else if (RELEASED.test(l.content)) st = null;
        else if (ARMED.test(l.content)) st = event("armed", l, l.content);
      } else if (l.subtype === "turn_duration" && st?.kind === "fired" && st.continued) {
        st = null;   // 이어 간 턴이 끝났다 — 대기는 끝났고 이제 평범한 완료다
      }
      continue;
    }
    if (l.type === "user") {
      if (humanPrompt(l)) { st = null; continue; }
      const dialog = dialogArmText(l);
      if (dialog !== null) st = event("armed", l, dialog);   // #4821 ③ — 사람이 대화상자에서 «기다리기» 를 골랐다(본체가 걸림 줄을 안 쓴다)
      else if (st?.kind === "fired") {
        const k = originKind(l);
        if (k === "auto-continuation") st = { ...st, continued: true };
        else if (st.continued && k !== undefined) st = null;   // 이어 간 턴 뒤에 다른 턴이 시작됐다 — 그 턴은 끝났다(Esc 로 끊기면 턴 끝 줄이 없다)
        else if (st.continued && l.usageLimitNote === "wrap_up") st = event("armed", l, REARMED_WRAPUP);   // 이어 간 턴이 정리 안내로 끝난다 → 조용히 다시 걸림
      }
      continue;
    }
    if (l.type === "assistant" && st?.kind === "fired" && st.continued && l.isApiErrorMessage === true && l.apiError === "usage_limit_reached") {
      st = event("armed", l, REARMED_ERROR);   // 이어 간 턴이 한도 오류로 끝났다(첫 요청부터 · 정리 유예 소진) → 조용히 다시 걸림
    }
  }
  return st;
}

/**
 * (순수) 마지막 대기 사건에 시각 조건을 건다.
 *  @param launchedAtMs  하네스(tmux 세션)를 띄운 시각 — 이보다 앞선 사건은 그 전 프로세스의 것이다. 0 이면 보지 않는다.
 *  @param nowMs         지금
 */
export function quotaBound(s: QuotaScan | null, at: { launchedAtMs: number; nowMs: number }): QuotaWait | null {
  if (!s) return null;
  if (s.atMs > at.nowMs + QUOTA_CLOCK_SKEW_MS) return null;
  if (at.launchedAtMs > 0 && s.atMs < at.launchedAtMs) return null;
  if (s.kind === "armed") return at.nowMs - s.atMs > QUOTA_WAIT_MAX_MS ? null : { kind: "armed", atMs: s.atMs, text: s.text };
  const untilMs = s.atMs + QUOTA_RESUME_GRACE_MS;
  return at.nowMs > untilMs ? null : { kind: "resuming", atMs: s.atMs, text: s.text, untilMs };
}

/** (순수) 대화 기록 줄에서 지금 지켜야 하는 대기 — quotaScan 다음 quotaBound. openTurnKind 는 quotaScan 과 같다. */
export function quotaWaitOf(lines: ReadonlyArray<unknown>, at: { launchedAtMs: number; nowMs: number }, openTurnKind?: string): QuotaWait | null {
  return quotaBound(quotaScan(lines, openTurnKind), at);
}
