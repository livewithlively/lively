// 세션이 **왜 끝났나** (#4783) — 판(life)마다 하나, 끝낸 자리가 끄기 직전에 적는다.
//
// ── 왜 필요한가 ──────────────────────────────────────────────────────────────
//  #4690 의 규칙(하네스가 없으면 대화창 · 완료+안 봄 N분이면 끈다)에선 «박스가 꺼졌다» 가 사람에게 보일 사실이 아니다.
//  사람에게 보일 것은 **누가 끝냈나**다: 사람이 끝낸 세션(/exit·멈춤)은 «지난 세션» 이고, 시스템이 끈 세션은 끄기 직전
//  모습(확인 필요·작업 완료) 그대로여야 하고, 고장으로 끝난 세션은 «오류» 로 보여야 한다.
//  그런데 사유를 남기는 자리가 셋뿐이었다(T5 쪽지 · claude /exit 의 exited_at · 셀프호스트 OOM) — 나머지는 전부 사유 없는
//  «중단됨» 이 되어 사이드바가 하나같이 «지난 세션» 으로 접었다(상민님 2026-10-16 «회수된 거면 직전 상태를 보여 주는 게 맞지 않나»).
//
// ── 규칙 ────────────────────────────────────────────────────────────────────
//  · 판이 태어날 때(createSession 의 장부 upsert) `{v:1}` 을 찍는다 — «이 판은 사유를 적는 규칙 아래에서 태어났다».
//    v 가 없는 행은 옛 판이다(사유를 모른다 — 지어내지 않는다).
//  · 끝내는 자리가 **끄기 전에** 적는다. 그 판에서 **먼저 적은 쪽이 이긴다**(markSessionEnded) — 끄는 쪽이 적고 tmux 를
//    죽이면 하네스가 신호를 받고 끝나며 런처가 종료코드를 다시 보고하는데, 그 뒤늦은 보고가 앞의 사실을 덮으면 안 된다.
//  · 사유 없이 사라진 판은 게이트웨이가 **확답으로** 확인한 뒤에만 `lost` 로 적는다(session-end-lost.ts) — 못 본 것은 사라진 게 아니다.
//
// 이 모듈은 순수다(DB·tmux 없음) — 판정 표를 시험이 그대로 못박는다(session-end.test.ts).

/**
 * 끝난 사유.
 *  · reclaim       — 시스템이 껐다(하네스 종료 규칙 · 옛 회수 시계 · 멤버 비활성화 · 상시 세션 정리). 공용 끄기 reapCentralSession.
 *  · stop          — 사람이 멈췄다(세션 [종료]·보관 · 프로젝트 아카이브·정리 · 관리 화면 [회수] · 프로젝트 휴지통).
 *  · harness_exit  — 하네스가 스스로 정상 종료했다(종료코드 0 — /exit·Ctrl-D·/quit). 런처가 보고한다.
 *  · harness_crash — 한동안 돌던 하네스가 0 이 아닌 코드로 끝났다(크래시·메모리 상한 초과). 런처가 보고한다.
 *  · launch_fail   — 하네스가 뜨자마자 죽었다(자격 만료·실행 파일 없음 등). 런처가 보고하고 오류를 읽으라고 셸을 남긴다.
 *  · lost          — 위 어느 것도 적지 않았는데 사라졌다(노드·컨테이너 고장). 게이트웨이가 확답으로 확인한 뒤 적는다.
 */
export type SessionEndWhy = "reclaim" | "stop" | "harness_exit" | "harness_crash" | "launch_fail" | "lost";
export const SESSION_END_WHYS: readonly SessionEndWhy[] = ["reclaim", "stop", "harness_exit", "harness_crash", "launch_fail", "lost"];

/** org_session_state.end_note 의 모양. */
export interface SessionEndNote {
  /** 이 판이 사유를 적는 규칙 아래에서 태어났다(판 시작 표식). */
  v: 1;
  /** 끝난 시각(epoch초) — why 와 함께만 있다. */
  at?: number;
  /** 끝난 사유 — 없으면 아직 안 끝났다(또는 끝났는데 아무도 안 적었다 — lost 확인 전). */
  why?: SessionEndWhy;
  /** 하네스 종료코드(harness_exit·harness_crash·launch_fail). */
  code?: number;
  /** 멈춘 사람(stop). */
  by?: string;
  /**
   * 끌 때 마지막 결과를 사람이 이미 봤나(reclaim). false = 안 본 결과가 남은 채 꺼졌다 — 화면이 «작업 완료» 로 그린다.
   *  나중에 그 세션을 열어 보면 true 로 바뀐다(markSessionEndSeen). 없음 = 모름(점을 안 그린다).
   */
  seen?: boolean;
}

/** 판 시작 표식 — createSession 의 장부 upsert 가 찍는다. */
export const END_NOTE_LIFE_MARK = '{"v":1}';

/** 끝낸 자리가 넘기는 것(시각·표식은 적는 함수가 채운다). */
export interface SessionEndInput {
  why: SessionEndWhy;
  code?: number;
  by?: string;
  seen?: boolean;
}

/** DB 값을 읽는다 — 모양이 틀리면 null(손으로 넣은 값·깨진 행이 화면에 새지 않게). */
export function endNoteOf(v: unknown): SessionEndNote | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const n = v as Record<string, unknown>;
  if (n.v !== 1) return null;
  const out: SessionEndNote = { v: 1 };
  if (n.why !== undefined) {
    if (!SESSION_END_WHYS.includes(n.why as SessionEndWhy)) return null;
    if (typeof n.at !== "number" || !Number.isFinite(n.at)) return null;
    out.why = n.why as SessionEndWhy;
    out.at = n.at;
  }
  if (typeof n.code === "number" && Number.isInteger(n.code)) out.code = n.code;
  if (typeof n.by === "string" && n.by) out.by = n.by;
  if (typeof n.seen === "boolean") out.seen = n.seen;
  return out;
}

/** 적을 값을 만든다(순수 — markSessionEnded 가 그대로 jsonb 로 넣는다). */
export function buildEndNote(e: SessionEndInput, nowSec: number): SessionEndNote {
  const out: SessionEndNote = { v: 1, at: Math.floor(nowSec), why: e.why };
  if (typeof e.code === "number" && Number.isInteger(e.code)) out.code = e.code;
  if (e.by) out.by = e.by;
  if (typeof e.seen === "boolean") out.seen = e.seen;
  return out;
}

/** SIGHUP(129) — tmux 가 판을 죽일 때 하네스가 받는 신호. 그 끝은 **죽인 쪽이** 이미 적었다(보고를 사유로 읽지 않는다). */
export const HANGUP_EXIT_CODE = 129;

/**
 * 런처 보고(POST …/sessions/:id/ended) → 적을 사유. 순수.
 *  body = { code: 0~255 정수, quick: 기동 직후였나(0|1|bool), t0: 하네스를 띄운 시각(epoch초) }.
 *  null = 받지 않는다(모양이 틀림 · 신호로 죽음 — 아래).
 *  · code 0 → harness_exit(정상 종료 — 사람이 끝냈다) · 0 이 아님: 기동 직후면 launch_fail, 아니면 harness_crash.
 *  · code 129(SIGHUP) 는 받지 않는다 — tmux 가 판을 닫을 때 생기는 코드다. 그 판을 닫은 자리(끄기·멈춤)가 이미 사유를 적었다.
 */
export function harnessEndVerdict(body: unknown): { why: SessionEndWhy; code: number; t0: number } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const code = typeof b.code === "number" ? b.code : typeof b.code === "string" && /^\d{1,3}$/.test(b.code) ? Number(b.code) : NaN;
  if (!Number.isInteger(code) || code < 0 || code > 255) return null;
  if (code === HANGUP_EXIT_CODE) return null;
  const t0 = typeof b.t0 === "number" ? b.t0 : typeof b.t0 === "string" && /^\d{1,12}$/.test(b.t0) ? Number(b.t0) : NaN;
  if (!Number.isInteger(t0) || t0 <= 0) return null;
  const quick = b.quick === true || b.quick === 1 || b.quick === "1";
  const why: SessionEndWhy = code === 0 ? "harness_exit" : quick ? "launch_fail" : "harness_crash";
  return { why, code, t0 };
}

/** 판 경계 여유(초) — 런처 시계(컨테이너)와 장부 시계(게이트웨이)가 다른 기계라 조금 어긋날 수 있다. */
export const END_REPORT_CLOCK_SLACK_SEC = 60;

/**
 * «사유 없이 사라졌나» 를 확인할 후보인가 (session-end-lost.ts). 순수 — 확답(has-session)은 부르는 쪽이 구한다.
 *  ⚠ 여기서 걸리는 것은 **후보**일 뿐이다. 목록에 없다는 것은 사라졌다는 근거가 아니다(#2108·#3846) — 부르는 쪽이
 *   tmux 확답(sessionGoneVerdict === true)을 받은 것만 lost 로 적는다.
 */
export interface LostCandidateFacts {
  id: string;
  kind?: string | null;
  created: number | null;
  exited_at: string | null;
  superseded_by?: string | null;
  discovered?: boolean;
  node_id?: string | null;
  end_note?: SessionEndNote | null;
}
export function isLostCandidate(s: LostCandidateFacts, ctx: { liveIds: ReadonlySet<string>; managedIds: ReadonlySet<string>; nowSec: number; graceSec: number }): boolean {
  const n = s.end_note;
  if (!n || n.v !== 1) return false;               // 옛 판 — 사유를 적는 규칙 전에 태어났다(지어내지 않는다)
  if (n.why) return false;                          // 이미 적혔다
  if (s.exited_at) return false;                    // 사람이 /exit 했다(claude SessionEnd)
  if (s.superseded_by) return false;                // 이어진 세션의 옛 id
  if (s.discovered) return false;                   // 노드에서 발견한 행 — 이 게이트웨이가 띄운 판이 아니다
  if (s.node_id) return false;                      // 멤버 PC 세션 — PC 가 꺼진 것은 사라진 게 아니다
  if ((s.kind ?? "human") !== "human") return false; // 기계 세션(위탁·앱·로그인)은 제 수명 규칙이 있다
  if (ctx.managedIds.has(s.id)) return false;       // 상시 세션
  if (ctx.liveIds.has(s.id)) return false;          // 목록에 있다(관측했든 «모름» 이든)
  const created = Number(s.created) || 0;
  if (!created) return false;
  return ctx.nowSec - created >= ctx.graceSec;      // 갓 만든(또는 방금 되살린) 판은 아직 목록에 안 잡혔을 수 있다
}

/** 화면에 싣는 모양(목록 행·단건 메타) — 판 표식·멈춘 사람은 안 싣는다. why 가 없으면(안 끝남·모름) 싣지 않는다. */
export interface SessionEndForRow { why: SessionEndWhy; at: number; code?: number; seen?: boolean }
export function endNoteForRow(n: SessionEndNote | null | undefined): SessionEndForRow | undefined {
  if (!n || !n.why || typeof n.at !== "number") return undefined;
  const out: SessionEndForRow = { why: n.why, at: n.at };
  if (typeof n.code === "number") out.code = n.code;
  if (typeof n.seen === "boolean") out.seen = n.seen;
  return out;
}

/**
 * #4783 — 끄기 직전에 **마지막 결과를 사람이 봤나** 를 잰다(순수 — 재료는 tmux 세 값). 화면의 «작업 완료» 판정과 같은 자다
 *  (web/session-status.ts isUnreadDone: 마지막 작업 > max(마지막 붙음, 마지막 열람 도장) 이면 안 본 결과).
 *  한 번도 작업하지 않았으면 볼 결과가 없다 — 본 것으로 친다. 값을 못 읽으면 undefined(모름 — 화면은 점을 안 그린다).
 */
//  ⚠ 칸은 «|» 로 가른다 — 안 찍힌 옵션은 빈 문자열이라 공백으로 가르면 칸이 당겨져 다른 값을 읽는다.
export function lastResultSeenFrom(raw: string): boolean | undefined {
  const parts = String(raw ?? "").trim().split("|");
  if (parts.length !== 3) return undefined;
  const [attached, viewed, busy] = parts.map((x) => (/^\d{1,12}$/.test(x.trim()) ? Number(x.trim()) : 0));
  if (!busy) return true;
  return busy <= Math.max(attached, viewed);
}
/** lastResultSeenFrom 이 읽는 tmux 형식 — 세 칸(붙은 시각 · 열람 도장 · 마지막 작업). */
export const LAST_RESULT_SEEN_FMT = "#{session_last_attached}|#{@box_last_seen}|#{@box_last_busy}";
