// 중앙 박스 — 에이전트 실행 단계(phase) 관측·판정. terminal-sessions.ts 분할(#1313 R15).
//  두 출처가 있다: ① 하네스 훅 보고(#1221, @box_state — 주신호) ② 화면 스크래핑(스피너·capture-pane — 레거시 폴백).
//  우선순위는 resolveAgentPhase(순수 함수)가 표로 못박는다. 활동 시각 기록(markSessionActive)도 여기(보고 수신자).
import { touchSessionBusy } from "../sessions/session-state.js"; // #1059 E — 세션 desired-state DB 미러(재부팅 복원)
import { tmux, tmuxQuiet, getOpt, setLastBusy, getPaneWait, setPaneWait } from "./tmux-exec.js";

// pane_title(=Claude Code 가 써두는 '지금 하는 일' 요약) → 표시용 제목. 상태 글리프(✳/스피너 등) 제거, 기본 셸 타이틀(user@host:path)·셸 세션은 무시.
export function sessionActivityTitle(paneTitle: string, harness: string): string {
  if (!paneTitle || harness === "shell") return "";
  const raw = paneTitle.trim();
  if (/^[\w.-]+@[\w.-]+:/.test(raw)) return "";           // 기본 셸 프롬프트 타이틀 → 무시
  return raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();       // 앞의 상태 글리프·스피너·공백 제거 → 첫 글자(문자/숫자)부터
}

// 에이전트 실행 상태 판정(#req). busy 는 Claude Code 가 pane_title 앞에 그리는 '스피너 글리프'로 본다.
//  ⚠ CPU·session_activity 는 신뢰 불가 — CPU 는 API 왕복 중 0 으로 떨어져 작업중↔대기중 깜빡이고, activity 는 스피너를 활동으로 안 잡음.
//  Claude Code 는 턴 진행 내내 브라유 스피너(U+2801~28FF, ⠂⠙⣾…)를 타이틀에 애니메이션하고, 끝나 프롬프트로 돌아가면 정적 별 '✳'(U+2733) 로 바꾼다 → 이게 '진짜 작동중' 신호.
export const SHELL_CMDS = new Set(["sh", "-sh", "bash", "-bash", "zsh", "-zsh", "fish", "-fish", "dash", "-dash", "tcsh", "-tcsh", "ksh", "-ksh", "csh", "-csh", "login", "-login"]);
// 타이틀 첫 글자가 브라유(스피너)면 작업중. 공백 브라유(U+2800)는 제외. 정적 별(✳ U+2733)·문자면 아님.
export function isSpinning(paneTitle: string): boolean {
  const c = (paneTitle || "").replace(/^\s+/, "").codePointAt(0);
  return c !== undefined && c > 0x2800 && c <= 0x28ff;
}
// AI 미실행 = 포그라운드가 셸(하네스 종료)이거나 셸 하네스 세션 → offline.
// 이 세션이 AI 하네스로 만들어졌나(셸·미지정이 아닌가). 셸 세션은 AI 관측 대상이 아니다.
export function r_harnessIsAgent(harness: string): boolean { return !!harness && harness !== "shell"; }
export function isAgentOffline(harness: string, paneCmd: string): boolean {
  return !harness || harness === "shell" || SHELL_CMDS.has((paneCmd || "").trim());
}

// pane 화면 내용으로 '사용자 선택/승인 대기'(확인 필요) 감지. 2.5초 캐시(폴링 버스트 공유 — 캐시는 tmux-exec 에 은닉).
//
// ⚠ 화면 전체를 grep 하면 안 된다(#853 오탐). Claude Code 는 **과거 사용자 메시지도 '❯ ' 프리픽스로**
//   전사(transcript)에 그린다 → 사용자가 번호목록을 붙여넣은 세션엔 화면에 "❯ 1. 최근에 위키를…" 이
//   남아, 승인 메뉴 커서("❯ 1. Yes")와 구별되지 않아 이미 끝난 대화가 계속 '확인 필요' 빨강으로 떴다.
//
// 판정은 **하단 라이브 UI 영역**만 본다. 불변식: 다이얼로그(모달)가 뜨면 입력창이 감춰진다.
//   - 대기 아님(입력창 살아있음): "───" 틀 + "❯ " 입력줄 + 모드 푸터("⏵⏵ auto mode on …" / "⏸ manual mode on · ? for shortcuts")
//   - 승인 대기:  " Do you want to create hello.txt?" · " ❯ 1. Yes" · " Esc to cancel · Tab to amend"
//   - 질문 대기:  " ❯ 1. Red" · " Enter to select · ↑/↓ to navigate · Esc to cancel"
//   (승인 문구는 툴마다 다르다 — "Do you want to create X?" — 문구만 매칭하면 놓친다. 커서·힌트가 주신호.)
const TAIL_LINES = 14;                                      // 하단 라이브 UI 영역(입력창 또는 다이얼로그). 전사는 이 위에 있다.
const INPUT_BOX = /\b(auto|manual|plan|accept edits|bypass permissions) mode on\b|\? for shortcuts|shift\+tab to cycle/i;
const MENU_CURSOR = /^\s*[│┃|]?\s*❯\s*\d+[.)]\s/;           // 번호 선택지 위의 커서(다이얼로그 테두리 안일 수 있다)
const MENU_HINT = /Enter to select|↑\/↓ to navigate|Esc to cancel/i;
const APPROVE_PHRASE = /Do you want to |Would you like to proceed|Select (an|the) option|Choose an option/i;
export function detectAwaiting(pane: string): boolean {
  const lines = pane.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const tail = lines.slice(-TAIL_LINES);
  if (tail.some((l) => INPUT_BOX.test(l))) return false;    // 입력창이 떠 있다 = 모달 없음 = 대기 아님
  const tailText = tail.join("\n");
  return tail.some((l) => MENU_CURSOR.test(l)) || MENU_HINT.test(tailText) || APPROVE_PHRASE.test(tailText);
}
export async function paneAwaitingInput(sessionId: string): Promise<boolean> {
  const now = Date.now();
  const c = getPaneWait(sessionId);
  if (c && now - c.at < 2500) return c.waiting;
  let waiting = false;
  try { waiting = detectAwaiting(await tmux(["capture-pane", "-t", sessionId, "-p"])); } catch { /* 무시 → idle 취급 */ }
  setPaneWait(sessionId, { at: now, waiting });
  return waiting;
}

// ── 하네스 보고 상태(#1221) — 화면 스크래핑을 대체하는 주신호 ─────────────────────────────────
// 위의 두 관측(스피너·capture-pane)은 **게이트웨이가 Claude Code 화면을 훔쳐보는 휴리스틱**이다. 그래서 ① UI 가
//  바뀌면 조용히 깨지고(#853 오탐 이력 — 과거 사용자 메시지의 '❯ ' 를 승인 메뉴로 오인) ② 폴링 스냅샷이라 tick
//  사이의 짧은 상태 변화를 놓치고 ③ 하네스마다 다시 구현해야 한다(코덱스는 브라유 스피너를 안 그려 **busy 가
//  영영 안 잡힌다**). #1059 가 '활동 시각'을 훅 보고로 옮긴 것과 같은 경로로, 실행 단계 자체를 하네스가 알린다.
//  훅은 추측이 아니다 — 턴 시작(UserPromptSubmit)·승인 대기(Notification)·턴 종료(Stop)에 실제로 실행된다.
export type ReportedPhase = "busy" | "waiting" | "idle";
const PHASES = new Set<string>(["busy", "waiting", "idle"]);
export function isReportedPhase(v: unknown): v is ReportedPhase { return typeof v === "string" && PHASES.has(v); }

// 보고가 언제까지 유효한가. 훅은 데몬이 아니라 **이벤트가 나야 실행된다** — 도구 하나가 10분을 도는 동안엔 아무
//  이벤트도 없어 보고가 갱신되지 않는다. 그래서 TTL 은 넉넉해야 하고(짧으면 긴 도구 실행이 매번 만료된다),
//  그럼에도 무한이면 안 된다(Stop 훅이 못 뜬 세션이 영원히 '작업 중'으로 굳어 회수도 안 되고 색도 틀린다).
//  만료돼도 손실은 없다 — 아래 폴백(스피너·capture-pane)이 종전과 똑같이 답한다.
export const PHASE_TTL_SEC = 10 * 60;

// "<phase> <epoch초>" → 파싱. 형식이 깨졌거나 모르는 phase 면 null(= 보고 없음 = 폴백).
//  phase 와 시각을 **한 옵션에 묶은** 이유: 따로 쓰면 두 write 사이에 목록 조회가 끼어 '옛 상태 + 새 시각'이라는
//  있을 수 없는 조합이 나온다(그 조합은 만료 판정을 속인다). 한 문자열이면 원자적이다.
export function parseReportedPhase(raw: string): { phase: ReportedPhase; at: number } | null {
  const [p, t] = String(raw || "").trim().split(/\s+/);
  const at = Number(t);
  return isReportedPhase(p) && Number.isFinite(at) && at > 0 ? { phase: p, at } : null;
}
// ⚠ 미래 시각도 만료로 본다 — 노드(#869)의 훅은 **멤버 PC 시계**로 찍히므로 스큐가 있으면 now-at 이 음수가 되어
//  "영원히 신선한" 보고가 굳는다. 60초 여유는 정상 스큐 흡수용.
export function isPhaseFresh(r: { at: number } | null, nowSec: number): boolean {
  return !!r && r.at <= nowSec + 60 && nowSec - r.at <= PHASE_TTL_SEC;
}

// 실행 단계 판정 — **보고와 스크래핑 두 출처의 우선순위표**. 순수 함수라 표 자체를 테스트로 못박는다.
//  ⚠ 지금은 보고가 스크래핑을 **덮지 않고 더한다**(3·4번 규칙이 살아 있다). 훅 배선이 전 세션에 퍼지기 전까진
//   보고가 없는 세션(구 세션·incognito=LIVELY_OFF·훅 비활성)이 남고, 그 세션들은 종전 판정 그대로여야 하기 때문이다.
//   보고 경로가 실증되면 3·4번을 지우는 것으로 스크래핑을 은퇴시킨다(이 함수 밖은 손댈 필요 없다).
//  1) 신선한 waiting 보고 — **가장 단단한 사실**(승인 다이얼로그가 떴다고 하네스가 직접 말했다). 스피너보다 위에
//     두는 이유: 스피너는 글리프 추측이고, 이건 이벤트다.
//  2) 신선한 busy 보고 — 이게 스크래핑 waiting 보다 위라 #853 류 오탐(전사에 남은 '❯ ')이 턴 진행 중엔 무력화된다.
//  3) 스피너(레거시) — 보고가 없거나 만료됐을 때. 보고가 idle 이어도 스피너가 돌면 스피너를 믿는다(스피너가
//     돈다는 건 지금 실제로 돌고 있다는 강한 양성 신호다 — Stop 훅을 놓친 세션을 구제한다).
//  4) capture-pane 대기(레거시) — 위 어느 것도 아닐 때.
//  5) idle.
export function resolveAgentPhase(i: {
  reported: { phase: ReportedPhase; at: number } | null; nowSec: number; spinning: boolean; scrapedWaiting: boolean;
}): ReportedPhase {
  const fresh = isPhaseFresh(i.reported, i.nowSec) ? i.reported : null;
  if (fresh?.phase === "waiting") return "waiting";
  if (fresh?.phase === "busy") return "busy";
  if (i.spinning) return "busy";
  if (i.scrapedWaiting) return "waiting";
  return "idle";
}

// 이 보고가 '일이 진행됐다'인가 — 활동 시각(lastActive)을 올릴지의 유일한 판정. 순수 함수로 뽑아 표를 고정한다.
//  lastActive 는 회수(idle TTL)와 '작업 완료(안 본 채 끝난 작업)' 배지가 **함께** 보는 값이라, 잘못 올리면 둘이
//  같이 망가진다 — 방치된 세션이 영원히 '방금 작업함'이 되어 회수도 안 되고 배지도 늘 켜져 있다.
//  · busy = 지금 돌고 있다 → 반복이어도 진행이다.
//  · 상태가 바뀐 순간 = 진행. **busy→idle 이 특히 중요하다**: 방금 턴이 끝난 그 시각이고, '작업 완료' 판정이
//    정확히 그 시각을 봐야 한다(종전엔 5분 폴링이 마지막으로 스피너를 본 때가 대신 찍혀 최대 5분 어긋났다).
//  · 같은 상태의 하트비트(idle→idle, waiting→waiting)는 진행이 아니다.
//  · phase 없음 = 구 훅의 활동 보고 → 종전 동작 그대로 올린다.
export function isActivityProgress(phase: ReportedPhase | undefined, prev: ReportedPhase | null): boolean {
  if (!phase) return true;
  return phase === "busy" || phase !== prev;
}

// #1059 — 이 세션이 **지금 활동했다**고 기록한다(하네스 훅 보고용). 회수 판정의 활동 시각은 tmux
//  `@box_last_busy` 가 SoT 다(reaper 가 보는 SessionInfo.lastActive 가 여기서 온다) — DB 만 갱신하면
//  reaper 가 못 본다. 그래서 tmux 메타 + DB 미러 둘 다 쓴다.
//  왜 훅이 필요한가: 종전 활동 관측은 게이트웨이가 5분마다 pane 제목 스피너를 훔쳐보는 방식이라
//   ① tick 사이에 짧게 끝나는 작업을 놓치고 ② Claude Code UI 가 바뀌면 조용히 깨진다(#853 오탐 이력).
//   훅은 툴을 쓸 때마다 실제로 실행되므로 추측이 아니다.
//  #1221 — phase 를 함께 받으면 실행 단계(busy·waiting·idle)도 tmux 메타에 싣는다. phase 없이 부르면 종전 그대로
//   활동 시각만 갱신한다(구 훅 호환 — 새 게이트웨이 + 구 훅 조합에서 무회귀).
export async function markSessionActive(id: string, phase?: ReportedPhase, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  let prev: ReportedPhase | null = null;
  if (phase) {
    prev = parseReportedPhase(await getOpt(id, "@box_state"))?.phase ?? null;   // 전이 여부 판정용(아래)
    await tmuxQuiet(["set-option", "-t", id, "@box_state", `${phase} ${nowSec}`]);
  }
  if (!isActivityProgress(phase, prev)) return;   // 하트비트는 활동 시각을 올리지 않는다(위 표 참조)
  setLastBusy(id, nowSec);                                        // 이 프로세스 관측치도 함께 올린다
  await tmuxQuiet(["set-option", "-t", id, "@box_last_busy", String(nowSec)]);
  await touchSessionBusy(id, nowSec).catch(() => { /* 비치명 — 레코드 없음·DB 다운 */ });
}
