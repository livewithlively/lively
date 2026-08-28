// 세션 아웃박스(#1719 #1753) — 프롬프트 전달을 fire-and-forget send-keys 에서 **큐 + 준비 판정 + 에코 확인**으로.
//
//  ── 왜 ──
//  send-keys 는 원래 ack 가 없는 통로다. 세션이 로그인·신뢰 대화상자에 멈춰 있으면 밀어 넣은 글자가 엉뚱한 화면에
//  흡수돼 **조용히 사라진다**(실측 2026-08-18: 홈에서 연 세션이 로그인 화면이었고, 로그인 후 새 대화로 열리며 그전에
//  보낸 프롬프트가 전부 유실 — 상민님 신고). 화면의 낙관 렌더는 새로고침에 사라져 복구 진입점조차 없었다.
//
//  ── 무엇 ──
//  · 보내기 = **큐에 넣고 끝**(org_session_outbox). 전달은 박스별 배달자가 세션당 seq 순서로 직렬.
//  · 배달자: ⓐ 준비 판정 — firstPromptStep(입력창 표식·신뢰 대화상자, session-first-prompt.ts 의 순수 함수 재사용)
//           ⓑ send-keys ⓒ **에코 확인** — 트랜스크립트(대화 파일)에 그 user 메시지가 나타나야 delivered.
//    '보냄상태'의 정본은 트랜스크립트 에코다 — send-keys 성공은 "tmux 가 받았다"일 뿐 "하네스가 받았다"가 아니다.
//  · 로그인 세션: 큐가 들고 있다가(NOT_READY_TTL 안) 입력창이 뜨면 자동 배달 — "로그인하면 다 날아감"이 없어진다.
//
//  ── 지키는 것 ──
//  · **재전송으로 중복을 만들지 않는다**: 준비 확인 후 보냈는데 에코만 못 봤으면(파일을 못 읽는 격리 홈 등) 'sent'
//    (미확인)로 끝낸다 — 다시 보내면 같은 지시가 두 번 간다. 재시도는 **보내기 전 단계**(준비 안 됨)에서만.
//  · 실패는 조용히 삼키지 않는다 — failed 행이 사유와 함께 남고, 화면이 그 자리에서 재시도·삭제를 준다.
//  · 노드(멤버 PC) 세션은 이 큐를 안 탄다(파일·tmux 가 그 컴퓨터에 있다) — 종전 릴레이 경로 그대로(후속).
//  · **전송수단은 하네스 모드가 정한다**(#2169) — codex app-server 세션의 pane 은 **codex TUI 가 아니다**
//    (#2055: TUI 와 app-server 가 같은 대화를 동시에 쥘 수 없어 pane 을 셸로 둔다). 거기에 글자를 넣으면
//    사람의 지시가 **셸에 타이핑된다**(실측 2026-08-26, 사용자 신고 "첫 프롬프트도 씹히고" — sessions.ts).
//    큐·재시도·화면은 그대로 쓰고 **나르는 수단만** 프로토콜로 바꾼다.
//
//  ── #2154 매니지드 첫 지시 유실 ──
//  실측 2026-08-27(상민님): 홈 컴포저로 세션을 열고 첫 지시만 준 뒤 자리를 비웠는데, 6시간 뒤 대화가 0개였다.
//   아웃박스 40건을 세어 보니 delivered 24 · echo-unreadable 5 · session-gone 6 · not-ready 4 · 채널없음 1.
//   두 갈래가 근본이었다:
//   ① **에코를 게이트웨이 로컬 fs 로 확인했다.** 매니지드(중앙 게이트웨이 1개)에서 대화 파일은 노드의 멤버 홈에
//      있어 늘 못 읽는다 → 실제로는 배달됐는데 `sent/echo-unreadable`(거짓 실패 상태). 복원의 정밀재개가 같은
//      이유로 죽어 있던 것(#1437 ②)과 **같은 클래스**다. → 대화창·복원과 **같은 관문**(transcriptFsFor)으로 읽는다.
//   ② **'세션에 못 닿음'을 '세션이 죽었다'로 단정했다.** waitReady 는 tmux 호출이 던지기만 하면 gone 을 돌려줬고,
//      배달자는 그 세션의 대기분을 **전부 failed** 로 버렸다. 노드 채널이 순간 비어 503 한 번이면(파킹 소켓 좀비)
//      첫 지시가 사라진다. → gone 은 #835 **확답**일 때만이고, 확답이어도 복원 가능한 세션이면 큐가 들고 있는다.
//   교훈은 #2120~#2122 와 같다: **판정 함수의 정확성과 그 함수가 불리는 조건은 별개의 결함 축이다.**
//
//  관련: session-first-prompt.ts(준비 판정의 원조 — 홈 첫 지시도 이제 이 큐를 탄다) · harness-io/locate.ts(에코 확인의
//  파일 찾기) · terminal/routes.ts(웹 보내기 → enqueue · 복원의 큐 승계) · web/session-chat.ts(대기·실패 상태 렌더).
import path from "node:path";
import { itemsPool } from "../db/client.js";
import { tmux, isSessionGoneError } from "../terminal/tmux-exec.js";
import { sendKeysToSession, sendKeyToSession, SendKeysNotStarted } from "../terminal/send-keys.js";
import { firstPromptStep } from "../terminal/session-first-prompt.js";
import { codexChatMode } from "../terminal/codex-chat-mode.js";
import { harnessIo } from "../terminal/harness-io/adapter.js";
import { locateTranscript, ownerHomes } from "../terminal/harness-io/locate.js";
import { localTranscriptFs, transcriptFsFor, type TranscriptFs } from "../terminal/harness-io/transcript-fs.js";
import { sessionOsUser } from "../terminal/profiles.js";
import { getSessionState, type SessionState } from "./session-state.js";
import { logger } from "../log.js";

export type OutboxStatus = "queued" | "sending" | "delivered" | "sent" | "failed";
/** prompt=사람이 보낸 말(대화창 말풍선) · control=설정 슬래시 명령(모델·추론강도 바꾸기, #1758 — 말풍선 아님·에코 없음). */
export type OutboxKind = "prompt" | "control";
export interface OutboxRow {
  id: number; session_id: string; seq: number; text: string; status: OutboxStatus; kind: OutboxKind;
  attempts: number; trust_ok: boolean; last_error: string | null;
  created_at: string; updated_at: string; delivered_at: string | null;
}

// ── 정책(순수 — 테스트가 표로 못박는다) ──────────────────────────────────────────
/** 준비(입력창)를 이 한 번의 시도에서 얼마나 기다리나. 로그인은 분 단위라 한 번에 다 기다리지 않고 짧게 보고 물러난다. */
export const READY_WINDOW_MS = 20_000;
/** 준비 안 됨 재시도 간격 — 시도 횟수에 따라 완만히 늘린다(로그인 화면을 10초마다 두드릴 이유가 없다). */
export function retryDelayMs(attempts: number): number { return Math.min(10_000 + attempts * 5_000, 30_000); }
/** 이 시간까지 입력창이 안 뜨면 포기(failed not-ready) — 로그인·오류 화면에 영영 멈춘 세션.
 *  ⚠ 30분이었다(#2154 로 상향). 큐가 들고 있는 목적이 바로 **사람이 로그인하고 돌아올 때까지**인데(파일 머리말
 *   "로그인하면 다 날아감이 없어진다"), 30분은 그 사람이 돌아오기 전에 지시를 버리는 길이였다.
 *   실측 2026-08-27 의 not-ready 4건은 전부 codex 세션 — app-server 를 못 열어(로그인 전) 아웃박스로 내려온
 *   첫 지시들이고, 로그인 뒤에야 입력창이 뜬다. 그 4건은 30분에 잘렸다.
 *   기다리는 비용은 30초에 한 번 tmux 폴 하나뿐이고, 화면은 60초부터 '터미널 열기'로 사람을 부른다. */
export const NOT_READY_TTL_MS = 2 * 60 * 60_000;
/** 세션에 **닿지 못하는** 동안 큐가 지시를 들고 있는 상한(#2154 ②) — 노드 재기동·복원 대기가 여기 걸린다.
 *  하루를 넘기면 그 세션은 사람이 잊은 것으로 본다(그때는 failed 로 남겨 화면이 재시도·삭제를 준다). */
export const UNREACHABLE_TTL_MS = 24 * 60 * 60_000;
/** 보낸 뒤 에코(트랜스크립트 등장)를 기다리는 시간. 하네스가 받았다면 user 줄은 수 초 안에 적힌다. */
export const ECHO_WINDOW_MS = 15_000;
/** 에코를 찾을 때 읽는 파일 꼬리 크기 — 중계에선 이 바이트가 그대로 네트워크를 탄다(작게 유지할 이유). */
export const ECHO_TAIL_BYTES = 256 * 1024;
/** 에코 폴 간격 — 로컬은 파일 한 번 읽기라 촘촘히, **중계는 폴마다 원격 프로세스 왕복**이라 성기게(#2154 ①).
 *  창(ECHO_WINDOW_MS)은 같으니 중계에서도 확인 기회가 여러 번 있고, 자라지 않은 파일은 아예 안 읽는다(아래 waitEcho). */
export const ECHO_POLL_LOCAL_MS = 700;
export const ECHO_POLL_RELAY_MS = 2_000;

/** 준비 판정의 결말(#2154 ②) — 종전엔 gone 하나가 '확답으로 죽음'과 '못 닿음'을 겸했다. 그게 유실의 통로였다. */
export type ReadyVerdict = "ready" | "not-ready" | "gone" | "unknown";

/**
 * 배달을 못 한 이 순간, 지시를 **버릴 것인가 들고 있을 것인가**(순수 — 표가 못박는다, #2154 ②).
 *
 *  · unknown(못 닿음: 노드 채널 503·중계 타임아웃·tmux 무응답) — 세션의 생사를 **모른다**. 버리면 살아 있는
 *    세션의 첫 지시를 순간 장애 하나로 잃는다. 상한(UNREACHABLE_TTL)까지 들고 있는다.
 *  · gone + 복원 가능 — tmux 는 확답으로 없다지만 desired-state 가 남아 '이어서 열기'가 가능하다. 그 복원이
 *    큐를 승계하므로(routes.ts), 들고 있으면 되살아난 세션에서 그대로 실행된다.
 *  · gone + 복원 불가 — 되살릴 자리가 없다. 종전대로 failed(화면이 사유와 함께 보여준다).
 *  · not-ready(입력창이 안 뜬다: 로그인·오류 화면) — 세션은 살아 있다. NOT_READY_TTL 까지 기다린다.
 */
export function stallAction(
  verdict: Exclude<ReadyVerdict, "ready">,
  o: { ageMs: number; restorable: boolean },
): { action: "requeue" | "fail"; reason: string } {
  if (verdict === "not-ready") return { action: o.ageMs >= NOT_READY_TTL_MS ? "fail" : "requeue", reason: "not-ready" };
  if (verdict === "gone" && !o.restorable) return { action: "fail", reason: "session-gone" };
  const reason = verdict === "gone" ? "session-gone-restorable" : "unreachable";
  return { action: o.ageMs >= UNREACHABLE_TTL_MS ? "fail" : "requeue", reason };
}

/**
 * 이 세션의 지시를 **무엇으로 나르나**(순수 — 표가 못박는다, #2169).
 *
 *  · `send-keys` — 화면에 글자를 넣고 트랜스크립트 에코로 확인한다(ack 없는 통로의 우회).
 *  · `codex-chat` — codex app-server 의 pane 은 **codex TUI 가 아니다**(#2055). 거기 넣은 글자는 그 대화에
 *    도달하지 못한다 — 프로토콜로 보내고 성공·실패를 **값으로** 받는다(에코 확인 불필요).
 *
 *  종전엔 수단이 하나뿐이라, app-server 폴백으로 큐에 들어온 지시가 **닿을 수 없는 곳으로 갔다.**
 */
export type DeliveryTransport = "send-keys" | "codex-chat";
export function deliveryTransport(harness: string, env: NodeJS.ProcessEnv = process.env): DeliveryTransport {
  return codexChatMode({ harness }, env) === "app-server" ? "codex-chat" : "send-keys";
}

/** 못 닿는 동안의 재시도 간격 — 입력창 대기(초 단위)와 달리 **분 단위** 사건이다(노드 재기동·사람의 복원). */
export function unreachableDelayMs(attempts: number): number { return Math.min(30_000 * (attempts + 1), 5 * 60_000); }

/**
 * tmux 호출이 던졌다 — 이 세션은 **죽은 것인가, 못 닿는 것인가**(#2154 ②).
 *
 *  종전 코드는 `catch { return "gone" }` 였다. 그래서 노드 채널이 순간 빈 503(파킹 소켓 좀비) 하나, 중계
 *  타임아웃 하나로 그 세션의 대기 지시가 전부 버려졌다. 판정의 정본은 #835 의 isSessionGoneError 다 —
 *  tmux 가 **응답해서** "그런 세션 없음"이라고 말했거나(중계면 tmux 서버 증발까지) 그때만 gone 이다.
 */
export function readyVerdictOnError(err: unknown): "gone" | "unknown" {
  return isSessionGoneError(err) ? "gone" : "unknown";
}

/** 에코 찾기용 바늘 — 트랜스크립트는 JSON 한 줄이라, 주입된 한 줄 텍스트를 JSON 문자열로 이스케이프한 형태로 찾는다.
 *  ⚠ **접두 160자만** 쓴다: 아주 긴 텍스트는 TUI 를 지나며 꼬리가 뒤섞일 수 있어(실측 2026-08-18, 3천자 프롬프트)
 *  전문 일치는 실제로 전달됐는데 'echo-unconfirmed' 로 오판한다. 접두 160자는 충분히 특정적이고 머리는 안 섞인다. */
export function echoNeedle(oneLine: string): string {
  return JSON.stringify(oneLine.slice(0, 160)).slice(1, -1);
}
/** send-keys 가 실제로 넣는 한 줄(send-keys.ts 규약 ① — 개행은 공백으로). 에코도 이 형태로 찾아야 한다. */
export const flatOneLine = (text: string): string => String(text ?? "").replace(/\s*\n\s*/g, " ").trim();

// ── 저장 ────────────────────────────────────────────────────────────────────────
export async function enqueuePrompt(sessionId: string, text: string, opts?: { trustOk?: boolean; kind?: OutboxKind }): Promise<{ id: number; seq: number }> {
  const r = await itemsPool.query(
    `INSERT INTO org_session_outbox(session_id, seq, text, trust_ok, kind)
     VALUES($1, COALESCE((SELECT MAX(seq) FROM org_session_outbox WHERE session_id=$1), 0) + 1, $2, $3, $4)
     RETURNING id, seq`,
    [sessionId, text, !!opts?.trustOk, opts?.kind ?? "prompt"]);
  kickOutbox(sessionId);
  return { id: Number(r.rows[0].id), seq: Number(r.rows[0].seq) };
}

/** 화면용 — 아직 끝나지 않은 것(queued·sending·failed)만. delivered/sent 는 트랜스크립트가 이미 보여준다.
 *  control(설정 명령)은 뺀다 — 대화창은 **사람이 보낸 말**의 큐이고, 거기 `/model opus` 가 말풍선으로 뜨면
 *  사람이 그렇게 말한 것처럼 보인다. 그 결말은 부른 쪽(POST …/runtime)이 waitOutboxSettled 로 그 자리에서 본다. */
// 화면용 — 미완(queued·sending·failed) + **에코 미확인**(sent·echo-unconfirmed). 후자를 숨기면 "보낸 걸로 떠서 영영
//  대답을 못 받는" 거짓 화면이 된다(antigravity 인증 거부 실측 2026-08-18) — 재시도·지우기를 사람 손에 준다.
//  (echo-unreadable 은 파일을 못 읽는 자리의 정상적 '모름' — 표시하지 않는다.)
export async function listOutbox(sessionId: string): Promise<OutboxRow[]> {
  const r = await itemsPool.query(
    `SELECT * FROM org_session_outbox WHERE session_id=$1 AND kind='prompt' AND
       (status IN ('queued','sending','failed') OR (status='sent' AND last_error='echo-unconfirmed')) ORDER BY seq`,
    [sessionId]);
  return r.rows.map(rowToOutbox);
}

/**
 * 이 행들이 **끝날 때까지** 잠깐 기다린다(부른 쪽이 그 자리에서 결말을 말할 수 있게, #1758 모델 바꾸기).
 *  settled=전부 큐를 떠났다(sent·delivered) · failed=사유(하나라도 실패) · 시간 안에 안 끝나면 settled=false
 *  (실패가 아니다 — 로그인 화면에 멈춘 세션은 큐가 들고 있다가 입력창이 뜨면 넣는다).
 */
export async function waitOutboxSettled(ids: number[], maxMs: number): Promise<{ settled: boolean; failed: string | null }> {
  if (!ids.length) return { settled: true, failed: null };
  const t0 = Date.now();
  for (;;) {
    const r = await itemsPool.query(
      `SELECT status, last_error FROM org_session_outbox WHERE id = ANY($1::bigint[])`, [ids]);
    const rows = r.rows as Array<{ status: string; last_error: string | null }>;
    const bad = rows.find((x) => x.status === "failed");
    if (bad) return { settled: true, failed: bad.last_error || "알 수 없는 이유" };
    if (rows.every((x) => x.status === "sent" || x.status === "delivered")) return { settled: true, failed: null };
    if (Date.now() - t0 >= maxMs) return { settled: false, failed: null };
    await sleep(300);
  }
}

export async function retryOutbox(sessionId: string, id: number): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE org_session_outbox SET status='queued', attempts=0, last_error=NULL, created_at=now(), updated_at=now()
     WHERE session_id=$1 AND id=$2 AND (status='failed' OR (status='sent' AND last_error='echo-unconfirmed'))`,
    [sessionId, id]);
  if ((r.rowCount ?? 0) > 0) { kickOutbox(sessionId); return true; }
  return false;
}

/**
 * 복원 승계(#2154 ②) — 옛 세션의 **아직 배달 안 된** 지시를 새 세션 id 로 옮긴다.
 *
 *  왜 필요한가: 복원은 새 id 로 세션을 다시 만든다. 큐의 라우팅 키는 session_id 라, 옮기지 않으면 '보존한' 지시가
 *   죽은 id 에 묶여 **영영 못 나간다** — 그러면 stallAction 의 '복원 가능하면 들고 있는다'가 말만 남는다.
 *   #2122 의 대화 매핑 승계와 같은 자리·같은 이유(옛 행이 유일한 사본이다).
 *
 *  · 옮기는 것: queued·sending·failed = **하네스가 받았다는 증거가 없는** 것들. seq 는 새 세션 뒤에 이어 붙인다.
 *  · 안 옮기는 것: delivered·sent — 이미 갔거나 갔을 수 있다. 옮겨서 다시 넣으면 **같은 지시가 두 번** 실행된다
 *    (이 파일 머리말의 '재전송으로 중복을 만들지 않는다').
 *  · 상태는 **보존한다**: queued 는 queued(배달자가 곧 집는다), failed 는 failed(사람이 화면에서 재시도·삭제를
 *    고른다 — 사람이 이미 결말을 본 것을 복원이 몰래 실행하지 않는다). sending 은 죽은 배달자의 잔재라 queued 로.
 *  반환 = 옮긴 행 수.
 */
export async function carryOutbox(oldId: string, newId: string): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE org_session_outbox o
        SET session_id = $2,
            seq = COALESCE((SELECT MAX(seq) FROM org_session_outbox WHERE session_id=$2), 0) + o.seq,
            status = CASE WHEN o.status='sending' THEN 'queued' ELSE o.status END,
            updated_at = now()
      WHERE o.session_id = $1 AND o.status IN ('queued','sending','failed')`,
    [oldId, newId]);
  const moved = r.rowCount ?? 0;
  if (moved) kickOutbox(newId);
  return moved;
}

export async function discardOutbox(sessionId: string, id: number): Promise<boolean> {
  const r = await itemsPool.query(
    `DELETE FROM org_session_outbox WHERE session_id=$1 AND id=$2 AND (status IN ('queued','failed') OR (status='sent' AND last_error='echo-unconfirmed'))`,
    [sessionId, id]);
  return (r.rowCount ?? 0) > 0;
}

function rowToOutbox(r: Record<string, any>): OutboxRow {
  return {
    id: Number(r.id), session_id: String(r.session_id), seq: Number(r.seq), text: String(r.text),
    status: r.status as OutboxStatus, kind: (r.kind === "control" ? "control" : "prompt") as OutboxKind,
    attempts: Number(r.attempts || 0), trust_ok: !!r.trust_ok,
    last_error: (r.last_error as string | null) ?? null,
    created_at: new Date(r.created_at).toISOString(), updated_at: new Date(r.updated_at).toISOString(),
    delivered_at: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
  };
}

// ── 배달자 — 세션당 한 루프(직렬·순서 보장). 인메모리 표식 + DB 상태(재기동은 resumeOutbox 가 잇는다). ──
const running = new Set<string>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function kickOutbox(sessionId: string): void {
  if (running.has(sessionId)) return;
  const t = retryTimers.get(sessionId);
  if (t) { clearTimeout(t); retryTimers.delete(sessionId); }
  running.add(sessionId);
  void deliverLoop(sessionId)
    .catch((e) => logger.warn({ err: e, sessionId }, "outbox: 배달 루프 오류(다음 kick 에서 재개)"))
    .finally(() => running.delete(sessionId));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function deliverLoop(sessionId: string): Promise<void> {
  for (;;) {
    const q = await itemsPool.query(
      `SELECT * FROM org_session_outbox WHERE session_id=$1 AND status='queued' ORDER BY seq LIMIT 1`, [sessionId]);
    if (!q.rows[0]) return;
    const row = rowToOutbox(q.rows[0]);
    // ⚠ 조회 실패(DB 순간 장애)와 '행이 없다'를 구별한다 — 아래 복원 가능 판정이 그 차이로 갈린다(#2154 ②).
    let st: SessionState | undefined; let stateKnown = true;
    try { st = await getSessionState(sessionId); } catch { stateKnown = false; }
    const harness = st?.harness || "claude";
    //  '이어서 열기'가 가능한가 = desired-state 행이 남아 있고 좌표를 아는가(#2022 discovered 행은 되살릴 수 없다).
    //  모르면(DB 장애) **보존 쪽**으로 — 판정 불가를 이유로 사람의 지시를 버리지 않는다.
    const restorable = stateKnown ? !!st && !st.discovered : true;

    //  배달을 못 한 순간의 처분을 **한 자로** 재고 실행한다(#2154 ②) — 준비 판정에서 막힌 것이든, 글자를
    //   싣기 전에 못 닿은 것이든 같은 사실(아직 아무것도 안 갔다)이므로 같은 규칙이어야 한다.
    //   반환 true = 루프를 내려놓았다(타이머·전량실패로 끝냈다) · false = 이 행을 실패로 마감했으니 다음 행으로.
    const settleStall = async (verdict: Exclude<ReadyVerdict, "ready">): Promise<boolean> => {
      const { action, reason } = stallAction(verdict, { ageMs: Date.now() - Date.parse(row.created_at), restorable });
      if (action === "fail") {
        if (verdict === "gone" && !restorable) {
          // 확답으로 사라졌고 되살릴 자리도 없다 — 나이와 무관하게 같은 결말이니 대기분 전부 실패로(종전과 같다).
          //  ⚠ 나이로 갈리는 실패(TTL 초과)는 여기 오면 안 된다 — 아직 어린 뒷줄까지 같이 버리게 된다.
          await itemsPool.query(
            `UPDATE org_session_outbox SET status='failed', last_error=$2, updated_at=now()
             WHERE session_id=$1 AND status IN ('queued','sending')`, [sessionId, reason]);
          return true;
        }
        await mark(row.id, "failed", reason);   // 입력창이 끝내 안 떴다·끝내 못 닿았다 — 화면이 사유와 함께 보여준다
        return false;                           // 다음 행은 다음 준비 판정에서 다시 본다(같은 벽이면 곧 같은 결말)
      }
      await itemsPool.query(`UPDATE org_session_outbox SET status='queued', attempts=attempts+1, last_error=$2, updated_at=now() WHERE id=$1`, [row.id, reason]);
      const delay = verdict === "not-ready" ? retryDelayMs(row.attempts + 1) : unreachableDelayMs(row.attempts);
      retryTimers.set(sessionId, setTimeout(() => { retryTimers.delete(sessionId); kickOutbox(sessionId); }, delay));
      return true;                              // 루프를 내려놓는다 — 타이머가 다시 kick
    };

    await mark(row.id, "sending");

    // ── 전송수단 갈림(#2169) — codex app-server 는 화면이 아니라 **프로토콜**로 받는다. ──
    //  왜 여기서 갈리나: 그 세션의 pane 은 **codex TUI 가 아니다**(#2055 — TUI 와 app-server 가 같은 대화를
    //  동시에 쥘 수 없어 pane 을 셸로 둔다). 그래서 send-keys 로는 **그 대화에 닿는 길이 아예 없다.**
    //  닿지 못하는 방식이 둘인데 어느 쪽도 배달이 아니다:
    //   · 준비 판정이 send 를 주면 → 사람의 첫 문장이 **셸에 타이핑된다**(명령으로 실행되거나 사라진다).
    //     실측 2026-08-26, 사용자 신고 "첫 프롬프트도 씹히고"(sessions.ts 의 app-server 분기 머리말).
    //   · 준비 판정이 끝내 send 를 안 주면 → TTL 까지 기다렸다 failed/not-ready.
    //  ⚠ 어느 쪽이 나는지는 그때 pane 에 달렸다 — 실측 2026-08-27 의 not-ready 4건이 어느 경로였는지는
    //   **모른다**(그때 pane 이 남아 있지 않다). 고치는 근거는 그 통계가 아니라 **구조**다: 이 전송수단은
    //   이 세션의 대화에 도달할 수 없다.
    //  이 폴백의 의도는 원래 "로그인 전이라 서버를 못 여는 경우에도 지시가 큐에 남는다"(sessions.ts)인데,
    //  나르는 수단이 send-keys 하나뿐이라 그 의도가 성립한 적이 없다. 수단을 하나 더 준다.
    //  ⚠ control(설정 슬래시 명령)은 여기 올 수 없다 — codex 는 runtimeCmd 가 없어 /runtime 이 409 로 막는다.
    // 갈린 **결과**를 한 줄 남긴다 — 나중에 "이 지시가 왜 저쪽으로 갔나"를 묻게 될 자리다(#2169).
    //  ⚠ 이 로그가 없어서 codex 배달은 **성공 시 무음**이었다: 세션이 열려도 `docker logs` 에 아무것도
    //   안 뜨고, 어디로 갔는지는 DB 를 읽어 추론해야 했다(실측 2026-08-27 — 그 경로를 쓴 내가 몰랐다).
    //  일반화: **경로가 갈리는 자리(분기·폴백·전송수단 선택)에는 갈린 결과를 남긴다.** 산출물이 '행위'인
    //   수정은 스스로를 증명하지 못해 사람이 재현해 줄 때까지 기다리는데, 이 한 줄이 그 성질을 바꾼다.
    //  볼륨: 사람이 친 프롬프트 단위라 핫패스가 아니다(control 포함해도 세션당 수십 건/일).
    const transport = deliveryTransport(harness);
    logger.info({ sessionId, seq: row.seq, harness, transport }, "outbox: 전송수단");
    if (transport === "codex-chat") {
      if (await deliverViaCodexChat(sessionId, st, row, settleStall)) return;
      continue;
    }

    const ready = await waitReady(sessionId, harness, row.trust_ok);
    if (ready !== "ready") {
      if (await settleStall(ready)) return;
      continue;
    }

    // 준비 확인됨 — 보낸다. 여기서부터는 **재전송하지 않는다**(중복 위험 — 파일 머리말).
    const oneLine = flatOneLine(row.text);
    try { await sendKeysToSession(sessionId, row.text); }
    catch (e) {
      // ⚠ **글자를 싣기 전에** 죽은 경우(SendKeysNotStarted = has-session 실패)만 되돌릴 수 있다 — 한 글자도
      //  안 갔으니 중복 위험이 없다. 실측 2026-08-27: 진짜 유실 5건 중 하나가 정확히 여기였다(`send:
      //  … has-session … node channel unavailable` → failed). 순간 장애 하나로 사람의 지시를 버리지 않는다.
      //  글자를 싣기 시작한 뒤의 실패는 종전대로 failed — 입력칸에 반쪽이 남아 있을 수 있다.
      if (e instanceof SendKeysNotStarted) {
        if (await settleStall(readyVerdictOnError(e.cause))) return;
        continue;
      }
      await mark(row.id, "failed", `send: ${(e as Error)?.message ?? e}`.slice(0, 300));
      continue;
    }
    // 설정 명령(#1758)은 에코로 확인할 수 없다 — 슬래시 명령은 트랜스크립트에 친 글자 그대로가 아니라
    //  `<command-name>` 형태로 적혀 이 바늘엔 영영 안 걸린다. 15초를 헛되이 기다리고 빈 Enter 를 덧보내는 대신
    //  '보냄(미확인)'으로 마감한다 — 실제 적용 여부는 화면이 다음 턴의 model/effort 관측으로 스스로 안다.
    if (row.kind === "control") { await mark(row.id, "sent", "control-no-echo"); continue; }
    let echoed = await waitEcho(sessionId, st, oneLine);
    if (needsSubmitRetry(echoed, harness)) {
      // 미제출 방어(send-keys 규약 ② — TUI 가 글자를 다 받기 전에 Enter 가 닿으면 입력칸에 글만 남는다, 실측 2026-08-18).
      //  판정 근거는 needsSubmitRetry 머리말 — **에코를 못 읽은 경우(unreadable)도 포함**한다(#1867).
      await sendKeyToSession(sessionId, "Enter").catch(() => { /* 다음 에코 창에서 판정 */ });
      echoed = await waitEcho(sessionId, st, oneLine);
    }
    if (echoed === "confirmed") await mark(row.id, "delivered");
    else await mark(row.id, "sent", echoed === "unreadable" ? "echo-unreadable" : "echo-unconfirmed");
  }
}

/**
 * codex app-server 배달(#2169) — 화면에 글자를 넣는 대신 **프로토콜로 보낸다**.
 *
 *  에코 확인이 없다: 여기서는 성공·실패가 **값으로 온다**(turn/start 의 응답). 트랜스크립트를 뒤져
 *  "적혔나"를 물을 이유가 없다 — 그건 ack 없는 통로(send-keys)를 쓸 때만 필요한 우회다.
 *
 *  ⚠ **스레드 좌표를 남긴다**(rememberCodexThread). 안 남기면 답은 파일에 멀쩡히 있는데 **화면이 그 파일을
 *   못 찾는다** — sessions.ts 가 같은 함정을 밟고 한 함수로 묶어 둔 자리다.
 *
 *  반환 true = 루프를 내려놓았다(타이머·전량실패) · false = 이 행은 끝났으니 다음 행으로.
 */
async function deliverViaCodexChat(
  sessionId: string,
  st: SessionState | undefined,
  row: OutboxRow,
  settleStall: (v: Exclude<ReadyVerdict, "ready">) => Promise<boolean>,
): Promise<boolean> {
  const osUser = await sessionOsUser(sessionId).catch(() => null);
  try {
    const { sendCodexChat } = await import("../terminal/harness-io/codex-chat-runtime.js");
    const r = await sendCodexChat({
      sessionId, text: row.text, cwd: st?.dir || "", osUser,
      threadId: st?.claude_session_id || null,
    });
    const { rememberCodexThread } = await import("../terminal/codex-chat-thread.js");
    await rememberCodexThread({
      sessionId, threadId: r.threadId, owner: st?.owner || "", osUser,
      knownThreadId: st?.claude_session_id, knownPath: st?.transcript_path,
    }).catch((e) => logger.warn({ err: e, sessionId }, "outbox: codex 스레드 좌표 기록 실패(비치명)"));
    await mark(row.id, "delivered");
    return false;
  } catch (e) {
    // ⚠ **한 글자도 안 갔을 때만 되돌린다**(#2154 SendKeysNotStarted 와 같은 축). app-server 를 못 띄운
    //  경우(로그인 전이 대표)가 그것이고, 그때는 큐가 들고 있다가 로그인되면 그대로 들어간다 —
    //  이 폴백이 원래 하려던 일이 비로소 성립한다. startTurn 이 던진 경우는 이미 갔을 수 있어 안 되돌린다.
    const notStarted = (e as { notStarted?: boolean })?.notStarted !== false;
    if (notStarted) return settleStall("unknown");
    await mark(row.id, "failed", `codex: ${(e as Error)?.message ?? e}`.slice(0, 300));
    return false;
  }
}

async function mark(id: number, status: OutboxStatus, err?: string): Promise<void> {
  await itemsPool.query(
    `UPDATE org_session_outbox SET status=$2, last_error=$3, updated_at=now(),
       delivered_at=CASE WHEN $2='delivered' THEN now() ELSE delivered_at END
     WHERE id=$1`,
    [id, status, err ?? null]);
}

/** 준비 판정 — 입력창이 뜰 때까지 READY_WINDOW_MS 안에서 폴링. 신뢰 대화상자는 trust_ok 일 때만 대신 누른다.
 *  ⚠ tmux 가 던졌다고 'gone' 이 아니다(#2154 ② · #835 와 같은 교리): 확답("그런 세션 없음"·중계 tmux 서버 증발)만
 *   gone 이고, 나머지(노드 채널 503·중계 타임아웃·도커 일시장애)는 **모름**이다. 종전엔 둘이 한 값이라, 순간 장애
 *   하나가 그 세션의 대기 지시를 전부 버리게 했다. */
async function waitReady(sessionId: string, harness: string, trustOk: boolean): Promise<ReadyVerdict> {
  const t0 = Date.now();
  let acceptedTrust = false;
  for (;;) {
    let pane = ""; let paneCmd = "";
    try {
      [pane, paneCmd] = await Promise.all([
        tmux(["capture-pane", "-t", sessionId, "-p"]),
        tmux(["display-message", "-p", "-t", sessionId, "#{pane_current_command}"]).then((s) => s.trim()),
      ]);
    } catch (e) { return readyVerdictOnError(e); }
    const step = firstPromptStep({ pane, paneCmd, harness, elapsedMs: Date.now() - t0, maxMs: READY_WINDOW_MS, trustOk });
    if (step === "send") return "ready";
    if (step === "give-up") return "not-ready";
    if (step === "accept-trust" && !acceptedTrust) {
      await sendKeyToSession(sessionId, "Enter").catch(() => { /* 다음 폴에서 다시 본다 */ });
      acceptedTrust = true;
    }
    await sleep(500);
  }
}

/**
 * 에코 확인 — 보낸 한 줄이 트랜스크립트에 user 메시지로 적혔나.
 *  파일 찾기: 훅 보고 경로 → 규약(locateTranscript). 매핑이 아직 없으면(방금 뜬 세션) 그 폴더의 **보낸 뒤 자란 파일**을 훑는다.
 *  파일을 아예 못 읽는 자리(미지원 하네스)는 'unreadable' — 보냈다는 사실만 남긴다(재전송 금지).
 *
 *  ⚠ #2154 ① — 읽는 자리는 **세션 소유자의 실행환경**이다(transcriptFsFor). 종전엔 게이트웨이 로컬 fs 를 직독해,
 *   매니지드(중앙 게이트웨이·마운트 0)에서는 대화 파일이 노드의 멤버 홈에 있어 **늘** unreadable 이었다 —
 *   실제로 배달된 지시가 `sent/echo-unreadable` 로 남아 delivered_at 이 영영 안 찍혔다(거짓 실패 상태 + 진짜
 *   실패와 구별 불가). 대화창(chat-routes)·복원(transcriptResumable)이 이미 지나는 그 관문을 여기서도 쓴다.
 */
/**
 * 순수 — 에코 판정 뒤 **Enter 를 한 번 더 눌러야 하는가**(미제출 방어, send-keys 규약 ②).
 *
 *  ⚠ `timeout` 뿐 아니라 **`unreadable` 에서도 눌러야 한다**(#1867 실측 2026-08-25, dev):
 *   첫 지시로 프로젝트를 만드는 경로가 생기면서 세션이 **방금 만든 빈 폴더**에서 시작한다 → 그 폴더엔 대화 파일이
 *   아직 없어 에코를 읽을 자리 자체가 없다(`unreadable`). 종전 조건(timeout 만)은 그때 Enter 를 안 눌러
 *   **첫 지시가 입력칸에 그대로 남았다**(아웃박스 기록: `sent / echo-unreadable`, 사람이 직접 Enter 를 눌러야 했다).
 *  이미 제출됐다면 빈 입력칸 Enter 라 무해하다 — 텍스트 재전송이 아니므로 중복 발화가 없다.
 *  claude 외 하네스는 입력칸 문법을 모르므로 누르지 않는다(종전과 같다).
 */
export function needsSubmitRetry(echoed: "confirmed" | "timeout" | "unreadable", harness: string): boolean {
  return echoed !== "confirmed" && harness === "claude";
}

async function waitEcho(sessionId: string, st: SessionState | undefined, oneLine: string): Promise<"confirmed" | "timeout" | "unreadable"> {
  const io = harnessIo(st?.harness || "claude");
  if (!io || !io.parse) return "unreadable";
  const tfs = transcriptFsFor(await sessionOsUser(sessionId).catch(() => null));
  const pollMs = tfs === localTranscriptFs ? ECHO_POLL_LOCAL_MS : ECHO_POLL_RELAY_MS;
  const needle = echoNeedle(oneLine);
  const sentAt = Date.now();
  const cwd = st?.dir || "";
  //  같은 바이트를 다시 읽지 않는다 — 파일이 **자랐을 때만** 꼬리를 본다(중계에선 이 읽기가 네트워크를 탄다).
  let seenFile = ""; let seenSize = -1;
  for (;;) {
    let file: string | null = null; let size = -1;
    if (st) {
      const found = await locateTranscript(io, { cwd, convId: st.claude_session_id || "", owner: st.owner || "", reportedPath: st.transcript_path }, tfs.stat).catch(() => null);
      if (found) { file = found.file; size = found.size; }        // locate 가 이미 stat 했다 — 다시 묻지 않는다
    }
    if (!file && cwd && st) file = await newestGrownFile(tfs, io, cwd, st.owner || "", sentAt - 10_000);
    if (file) {
      if (size < 0) size = (await tfs.stat(file).catch(() => null)) ?? -1;
      if (size < 0) return "unreadable";
      if (file !== seenFile || size !== seenSize) {
        seenFile = file; seenSize = size;
        const hit = await tailContains(tfs, file, size, needle).catch(() => null);
        if (hit === null) return "unreadable";
        if (hit) return "confirmed";
      }
    }
    if (Date.now() - sentAt >= ECHO_WINDOW_MS) return file ? "timeout" : "unreadable";
    await sleep(pollMs);
  }
}

/** 매핑이 없을 때의 폴백 — **claude 한정**(대화 폴더 = pathFor 의 dirname 이 conv 무관). 홈 첫 지시의 실제 케이스가 이것이다:
 *  방금 뜬 세션은 훅이 아직 uuid 를 보고하기 전이라 매핑이 없다. 다른 하네스는 폴더 규약에 conv-id 가 끼어 훑을 수 없다 — unreadable. */
const DUMMY_CONV = "00000000-0000-0000-0000-000000000000";
async function newestGrownFile(tfs: TranscriptFs, io: NonNullable<ReturnType<typeof harnessIo>>, cwd: string, owner: string, sinceMs: number): Promise<string | null> {
  if (io.key !== "claude" || !io.pathFor) return null;
  let best: { file: string; m: number } | null = null;
  for (const root of io.roots(ownerHomes(owner), owner)) {
    const sample = io.pathFor(root, { cwd, convId: DUMMY_CONV });
    if (!sample) continue;
    const dir = path.dirname(sample);
    for (const e of await tfs.listDir(dir)) {
      if (!io.filePattern.test(e.name)) continue;
      if (e.mtimeMs >= sinceMs && (!best || e.mtimeMs > best.m)) best = { file: path.join(dir, e.name), m: e.mtimeMs };
    }
  }
  return best?.file ?? null;
}

/** 파일 꼬리(ECHO_TAIL_BYTES)에 바늘이 있나. size 는 부른 쪽이 방금 잰 값. 읽기 실패는 null(못 읽는 자리 — 재전송 금지 신호). */
async function tailContains(tfs: TranscriptFs, file: string, size: number, needle: string): Promise<boolean | null> {
  if (size <= 0) return false;
  const from = Math.max(0, size - ECHO_TAIL_BYTES);
  try {
    return await tfs.read(file, size, async (r) => (await r.read(from, size)).toString("utf8").includes(needle));
  } catch { return null; }
}

/** 부팅 재개 — 죽는 순간 'sending' 이던 행을 queued 로 되돌리고, 대기분이 있는 세션들을 다시 돌린다.
 *  ⚠ sending 중 재기동이면 실제로는 이미 전달됐을 수 있다 — 재전송 중복 위험이 있지만, 재기동은 드물고
 *   에코 확인이 그 창을 좁힌다(이미 적혔으면 배달자가 준비 판정→send 전에 … 아니, 여기선 알 수 없다).
 *   보수적으로 attempts 를 올려 두 번째 재기동에선 failed 로 떨어지게 한다. */
export async function resumeOutbox(): Promise<void> {
  // 끝난 행 청소(하루) — 진행 중(queued·failed)은 남긴다: failed 는 사람이 봐야 할 사실이다.
  await itemsPool.query(`DELETE FROM org_session_outbox WHERE status IN ('delivered','sent') AND updated_at < now() - interval '1 day'`);
  // ⚠ 'sending' 을 무조건 되돌리면 **지금 배달 중인** 행을 건드린다(5분 sweep 에서도 불린다) — 준비 판정+에코까지 한 행이
  //  2분을 넘지 않으므로(READY_WINDOW 20s + ECHO 15s + 여유), 2분 넘게 sending 인 것만 '죽은 배달자의 잔재'로 본다.
  await itemsPool.query(`UPDATE org_session_outbox SET status='queued', attempts=attempts+1, updated_at=now()
    WHERE status='sending' AND updated_at < now() - interval '2 minutes'`);
  const r = await itemsPool.query(`SELECT DISTINCT session_id FROM org_session_outbox WHERE status='queued'`);
  for (const row of r.rows) kickOutbox(String(row.session_id));
}
