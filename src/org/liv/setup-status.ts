// 처음 설정 뒤 «올린 파일이 지식이 되기까지» 의 단계(#5167) — 순수. 화면(진행 띠)과 증류 잡이 같은 판정을 읽는다.
//
//  ── 왜 ──
//  처음 설정에서 파일을 올리고 넘어간 사람은 그 뒤 무슨 일이 일어나는지 볼 길이 없었다(2026-10-30 lively-agent-5·-2 실측).
//   업로드 띠는 «다 올렸어요» 를 8초 보이고 사라지고, 리브 세션은 0~5분 뒤(매니지드 정비 주기) 말없이 열리고,
//   정리 잡이 자격 없음으로 멈춰도 화면엔 아무것도 없었다. 사람은 «언제까지 기다리나 · 되고 있나» 를 모른다.
//   그래서 서버가 이미 아는 표식(welcome)·자격 실패·남은 자료 수로 지금 단계를 하나 정하고, 화면은 그것을 말만 한다.
//
//  ── 리브보다 먼저 정리하지 않는다 ──
//  처음 설정이 끝나면 기본 증류(default — 카테고리 없음·모든 자료)가 30분마다 돈다. 리브가 카테고리·정리 규칙을 세우기 전에
//   그게 올린 파일을 집으면 지식이 카테고리 없이 쌓이고(검색·주입에서 소환되지 않는다), 집힌 자료는 링크가 생겨 리브가 세운
//   레인의 인박스에서 영구히 빠진다(liv-distill ⛔). 자격이 없던 동안엔 우연히 막혀 있었을 뿐이다 — 처음 설정에서 자격을 받게
//   되면서(#5167) 그 우연이 사라진다. 그래서 리브가 증류 지시를 받기 전까지는 정리 잡을 쉬게 한다(setupHoldsDistill).
import { SECOND_TURN_STALE_MS } from "./second-turn.js";

/** welcome 표식 중 이 판정이 읽는 칸. */
export interface SetupWelcome {
  done_at?: string | null;
  flow?: string | null;
  upload_started_at?: string | null;
  upload_done_at?: string | null;
  distill_at?: string | null;
  distill_gave_up_at?: string | null;
  distill_note?: string | null;
  collect_done_at?: string | null;
  session_id?: string | null;
}

/**
 * 지금 단계.
 *  · uploading — 화면이 아직 올리는 중(서버는 끝 신호를 못 받았다).
 *  · waiting   — 다 올렸고 리브가 곧 연다(파일 갈래) · 연결 대화를 끝내면 시작한다(연결 갈래 — connecting).
 *  · working   — 리브가 정리 규칙을 세우는 중(켜진 정리가 아직 없다).
 *  · organizing— 켜진 정리가 자료를 지식으로 바꾸는 중(남은 수 backlog).
 *  · needs-ai  — 정리 잡이 자격 없음·인증 실패로 멈췄다. 사람이 [내 AI 계정]에서 승인해야 이어진다.
 *  · done      — 남은 자료가 없다.
 *  · stopped   — 리브가 끝내 시작하지 못했다(세션을 못 열었다 · 하루가 지났다).
 */
export type SetupPhase = "uploading" | "waiting" | "connecting" | "working" | "organizing" | "needs-ai" | "done" | "stopped";

export interface SetupStatus {
  phase: SetupPhase;
  /** 리브 세션(있으면) — 화면이 [리브 대화 보기]로 잇는다. */
  session_id: string | null;
  /** 켜진 정리가 아직 안 본 자료 수. 켜진 정리가 없으면 null(셀 것이 없다 — 0 과 다르다). */
  backlog: number | null;
  /** stopped 의 사유(welcome.distill_note). */
  note: string | null;
}

/**
 * (순수) 처음 설정에서 파일을 올린 사람의 지금 단계. 올리지 않았거나 처음 설정이 안 끝났으면 null — 화면이 말할 것이 없다.
 *  리브가 오지 않는 갈래(flow 없음 — 관리 권한 없음 · 서버 AI 없음)도 null 이다: 처음 설정 마지막 화면이 이미 그 사실을 말했다.
 */
export function setupStatus(i: {
  welcome: SetupWelcome | null | undefined;
  /** 올린 파일을 받는 켜진 정리들의 남은 자료 합. 그런 정리가 아직 없으면 null — 다른 자료(슬랙 등)의 정리가 비었다고 «끝» 이 아니다. */
  backlog: number | null;
  /** 정리 잡이 이 사람 자격 때문에 멈춘 흔적이 있고, 그 뒤로 되살린 자격이 없다. */
  credentialBlocked: boolean;
}): SetupStatus | null {
  const w = i.welcome;
  if (!w || !w.done_at || !w.upload_started_at) return null;
  const base = { session_id: w.session_id ?? null, backlog: i.backlog, note: null };
  //  리브가 오지 않는 갈래면 어느 단계든 말하지 않는다 — 올리는 중이라도 «곧 정리를 시작해요» 는 지킬 수 없는 약속이다(격리 리뷰 2026-10-30).
  if (w.flow !== "files" && w.flow !== "connect") return null;
  if (w.distill_gave_up_at) return { ...base, phase: "stopped", note: w.distill_note ?? null };
  if (!w.upload_done_at) return { ...base, phase: "uploading" };
  if (!w.distill_at) return { ...base, phase: w.flow === "files" ? "waiting" : "connecting" };
  if (i.credentialBlocked) return { ...base, phase: "needs-ai" };
  if (i.backlog == null) return { ...base, phase: "working" };
  return { ...base, phase: i.backlog > 0 ? "organizing" : "done" };
}

/**
 * (순수) 이 사람의 처음 설정이 정리 잡을 쉬게 하나 — 리브가 증류 지시를 받기 전(리브 2턴 후보인 동안).
 *  · 처음 설정에서 **파일을 올렸고**, 갈래가 files·connect 이고, 처음 설정이 끝났고, 아직 증류 지시도 포기도 없다.
 *    파일을 안 올린 연결 갈래는 쉬지 않는다 — 막을 것(올린 파일을 카테고리 없이 집기)이 없는데 워크스페이스 정리를 세울 까닭이 없다.
 *  · 하루가 지나면 풀린다 — 2턴이 그때 포기한다(SECOND_TURN_STALE_MS). 표식이 어떤 이유로 안 찍혀도 정리가 영영 멈추지 않게 같은 상한을 쓴다.
 */
export function setupHoldsDistill(w: SetupWelcome | null | undefined, now: number): boolean {
  if (!w || !w.done_at || !w.upload_started_at) return false;
  if (w.flow !== "files" && w.flow !== "connect") return false;
  if (w.distill_at || w.distill_gave_up_at) return false;
  const done = Date.parse(w.done_at);
  return Number.isFinite(done) && now - done < SECOND_TURN_STALE_MS;
}
