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
//
//  관련: session-first-prompt.ts(준비 판정의 원조 — 홈 첫 지시도 이제 이 큐를 탄다) · harness-io/locate.ts(에코 확인의
//  파일 찾기) · terminal/routes.ts(웹 보내기 → enqueue) · web/session-chat.ts(대기·실패 상태 렌더).
import path from "node:path";
import fsp from "node:fs/promises";
import { itemsPool } from "../db/client.js";
import { tmux } from "../terminal/tmux-exec.js";
import { sendKeysToSession, sendKeyToSession } from "../terminal/send-keys.js";
import { firstPromptStep } from "../terminal/session-first-prompt.js";
import { harnessIo } from "../terminal/harness-io/adapter.js";
import { locateTranscript, ownerHomes } from "../terminal/harness-io/locate.js";
import { getSessionState } from "./session-state.js";
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
/** 이 시간까지 입력창이 안 뜨면 포기(failed not-ready) — 로그인·오류 화면에 영영 멈춘 세션. */
export const NOT_READY_TTL_MS = 30 * 60_000;
/** 보낸 뒤 에코(트랜스크립트 등장)를 기다리는 시간. 하네스가 받았다면 user 줄은 수 초 안에 적힌다. */
export const ECHO_WINDOW_MS = 15_000;

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
export async function listOutbox(sessionId: string): Promise<OutboxRow[]> {
  const r = await itemsPool.query(
    `SELECT * FROM org_session_outbox WHERE session_id=$1 AND kind='prompt' AND status IN ('queued','sending','failed') ORDER BY seq`,
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
     WHERE session_id=$1 AND id=$2 AND status='failed'`,
    [sessionId, id]);
  if ((r.rowCount ?? 0) > 0) { kickOutbox(sessionId); return true; }
  return false;
}

export async function discardOutbox(sessionId: string, id: number): Promise<boolean> {
  const r = await itemsPool.query(
    `DELETE FROM org_session_outbox WHERE session_id=$1 AND id=$2 AND status IN ('queued','failed')`,
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
    const st = await getSessionState(sessionId).catch(() => undefined);
    const harness = st?.harness || "claude";

    await mark(row.id, "sending");
    const ready = await waitReady(sessionId, harness, row.trust_ok);
    if (ready === "gone") {
      // 세션 자체가 사라졌다(닫힘·죽음) — 이 세션의 대기분 전부 실패로. 되살리면(복원) 사람이 재시도한다.
      await itemsPool.query(
        `UPDATE org_session_outbox SET status='failed', last_error='session-gone', updated_at=now()
         WHERE session_id=$1 AND status IN ('queued','sending')`, [sessionId]);
      return;
    }
    if (ready === "not-ready") {
      const age = Date.now() - Date.parse(row.created_at);
      if (age >= NOT_READY_TTL_MS) {
        await mark(row.id, "failed", "not-ready");   // 입력창이 끝내 안 떴다(로그인·오류 화면) — 화면이 사유와 함께 보여준다
        continue;                                    // 다음 행은 다음 준비 판정에서 다시 본다(같은 벽이면 곧 같은 결말)
      }
      await itemsPool.query(`UPDATE org_session_outbox SET status='queued', attempts=attempts+1, last_error='not-ready', updated_at=now() WHERE id=$1`, [row.id]);
      const delay = retryDelayMs(row.attempts + 1);
      retryTimers.set(sessionId, setTimeout(() => { retryTimers.delete(sessionId); kickOutbox(sessionId); }, delay));
      return;                                        // 루프를 내려놓는다 — 타이머가 다시 kick
    }

    // 준비 확인됨 — 보낸다. 여기서부터는 **재전송하지 않는다**(중복 위험 — 파일 머리말).
    const oneLine = flatOneLine(row.text);
    try { await sendKeysToSession(sessionId, row.text); }
    catch (e) {
      await mark(row.id, "failed", `send: ${(e as Error)?.message ?? e}`.slice(0, 300));
      continue;
    }
    // 설정 명령(#1758)은 에코로 확인할 수 없다 — 슬래시 명령은 트랜스크립트에 친 글자 그대로가 아니라
    //  `<command-name>` 형태로 적혀 이 바늘엔 영영 안 걸린다. 15초를 헛되이 기다리고 빈 Enter 를 덧보내는 대신
    //  '보냄(미확인)'으로 마감한다 — 실제 적용 여부는 화면이 다음 턴의 model/effort 관측으로 스스로 안다.
    if (row.kind === "control") { await mark(row.id, "sent", "control-no-echo"); continue; }
    let echoed = await waitEcho(st, oneLine);
    if (echoed === "timeout" && harness === "claude") {
      // 미제출 방어(send-keys 규약 ② — TUI 가 글자를 다 받기 전에 Enter 가 닿으면 입력칸에 글만 남는다, 실측 2026-08-18):
      //  에코가 안 보이면 Enter 만 한 번 더 — 이미 제출됐다면 빈 입력칸 Enter 라 무해하고, 남아 있었다면 그때 제출된다.
      //  텍스트 재전송이 아니다(중복 없음). 종전엔 화면(클라)이 5초 뒤에 하던 일을 배달자가 이어받았다.
      await sendKeyToSession(sessionId, "Enter").catch(() => { /* 다음 에코 창에서 판정 */ });
      echoed = await waitEcho(st, oneLine);
    }
    if (echoed === "confirmed") await mark(row.id, "delivered");
    else await mark(row.id, "sent", echoed === "unreadable" ? "echo-unreadable" : "echo-unconfirmed");
  }
}

async function mark(id: number, status: OutboxStatus, err?: string): Promise<void> {
  await itemsPool.query(
    `UPDATE org_session_outbox SET status=$2, last_error=$3, updated_at=now(),
       delivered_at=CASE WHEN $2='delivered' THEN now() ELSE delivered_at END
     WHERE id=$1`,
    [id, status, err ?? null]);
}

/** 준비 판정 — 입력창이 뜰 때까지 READY_WINDOW_MS 안에서 폴링. 신뢰 대화상자는 trust_ok 일 때만 대신 누른다. */
async function waitReady(sessionId: string, harness: string, trustOk: boolean): Promise<"ready" | "not-ready" | "gone"> {
  const t0 = Date.now();
  let acceptedTrust = false;
  for (;;) {
    let pane = ""; let paneCmd = "";
    try {
      [pane, paneCmd] = await Promise.all([
        tmux(["capture-pane", "-t", sessionId, "-p"]),
        tmux(["display-message", "-p", "-t", sessionId, "#{pane_current_command}"]).then((s) => s.trim()),
      ]);
    } catch { return "gone"; }
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
 *  파일을 아예 못 읽는 자리(격리 홈·미지원 하네스)는 'unreadable' — 보냈다는 사실만 남긴다(재전송 금지).
 */
async function waitEcho(st: Awaited<ReturnType<typeof getSessionState>>, oneLine: string): Promise<"confirmed" | "timeout" | "unreadable"> {
  const io = harnessIo(st?.harness || "claude");
  if (!io || !io.parse) return "unreadable";
  const needle = echoNeedle(oneLine);
  const sentAt = Date.now();
  const cwd = st?.dir || "";
  for (;;) {
    let file: string | null = null;
    if (st) {
      const found = await locateTranscript(io, { cwd, convId: st.claude_session_id || "", owner: st.owner || "", reportedPath: st.transcript_path }).catch(() => null);
      if (found) file = found.file;
    }
    if (!file && cwd && st) file = await newestGrownFile(io, cwd, st.owner || "", sentAt - 10_000);
    if (file) {
      const hit = await tailContains(file, needle).catch(() => null);
      if (hit === null) return "unreadable";
      if (hit) return "confirmed";
    }
    if (Date.now() - sentAt >= ECHO_WINDOW_MS) return file ? "timeout" : "unreadable";
    await sleep(700);
  }
}

/** 매핑이 없을 때의 폴백 — **claude 한정**(대화 폴더 = pathFor 의 dirname 이 conv 무관). 홈 첫 지시의 실제 케이스가 이것이다:
 *  방금 뜬 세션은 훅이 아직 uuid 를 보고하기 전이라 매핑이 없다. 다른 하네스는 폴더 규약에 conv-id 가 끼어 훑을 수 없다 — unreadable. */
const DUMMY_CONV = "00000000-0000-0000-0000-000000000000";
async function newestGrownFile(io: NonNullable<ReturnType<typeof harnessIo>>, cwd: string, owner: string, sinceMs: number): Promise<string | null> {
  if (io.key !== "claude" || !io.pathFor) return null;
  let best: { file: string; m: number } | null = null;
  for (const root of io.roots(ownerHomes(owner), owner)) {
    const sample = io.pathFor(root, { cwd, convId: DUMMY_CONV });
    if (!sample) continue;
    const dir = path.dirname(sample);
    let names: string[] = [];
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!io.filePattern.test(n)) continue;
      const f = path.join(dir, n);
      try {
        const s = await fsp.stat(f);
        if (s.isFile() && s.mtimeMs >= sinceMs && (!best || s.mtimeMs > best.m)) best = { file: f, m: s.mtimeMs };
      } catch { /* 사라짐 — 다음 */ }
    }
  }
  return best?.file ?? null;
}

/** 파일 꼬리(256KB)에 바늘이 있나. 읽기 실패는 null(못 읽는 자리 — 재전송 금지 신호). */
async function tailContains(file: string, needle: string): Promise<boolean | null> {
  try {
    const st = await fsp.stat(file);
    const from = Math.max(0, st.size - 256 * 1024);
    const fh = await fsp.open(file, "r");
    try {
      const buf = Buffer.alloc(st.size - from);
      const r = await fh.read(buf, 0, buf.length, from);
      return buf.subarray(0, r.bytesRead).toString("utf8").includes(needle);
    } finally { await fh.close(); }
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
