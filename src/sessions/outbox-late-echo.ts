// 늦은 에코(#4819) — «보냈지만 세션 기록에서 확인되지 않았어요» 를 보여 주기 직전에 기록과 다시 대조한다.
//
//  ── 왜 ──
//  아웃박스(session-outbox.ts)는 친 뒤 15초(+Enter 한 번 더 15초) 안에 대화 파일에서 그 말을 못 보면 'sent·echo-unconfirmed'
//   로 마감하고, 다시 보지 않는다. 그런데 그 창은 «하네스가 받았나» 를 재는 창이 못 된다 — Claude Code 는 사람 말을 대화 파일에
//   **UserPromptSubmit 훅이 끝난 뒤에야** 적는다. 실측(2026-10-16 매니지드, 회수된 세션 c3d46537 · Claude Code 2.1.301):
//   07:58:32 큐 → 07:59:07.361 제출(그 줄의 timestamp) → 훅 22.5초 → 07:59:29.828 훅 끝 → 07:59:29.856 아웃박스가 «미확인» 으로
//   마감(28ms 차) → 07:59:31.924 이후 그 user 줄이 파일에 적힘 → 답까지 끝남 → 회수. 다시 열면 대화엔 그 말과 답이 다 있는데
//   맨 아래에 같은 말이 «보냈지만 세션 기록에서 확인되지 않았어요 — 안 들어갔을 수 있어요» 로 또 그려졌다(상민님 신고).
//   하네스가 일하는 중에 친 말은 그 턴이 다음 틈을 낼 때(queued_command 줄)에야 적혀 창을 더 쉽게 넘긴다.
//  «미확인» 은 그 15초의 사실일 뿐이다. 사람에게 «안 들어갔을 수 있어요» 라고 말하기 전에 기록을 다시 본다.
//
//  ── 무엇 ──
//  · 화면이 큐를 읽는 자리(GET …/outbox — chat-routes)에서, 15초 창이 «못 봤다» 고만 말한 두 행 —
//    'sent·echo-unconfirmed' 과 'failed·send: host-unknown'(호스트가 쳤는지 모를 때 같은 창이 붙이는 이름) — 을 그 세션의
//    대화 파일과 대조한다. 행이 생긴 뒤에 적힌 **사람 말 줄**(user 의 text · 도는 중 끼워 넣은 queued_command)에 그 말이 있으면
//    'delivered·echo-late' 로 바꾸고 목록에서 뺀다(session-outbox.settleLateEcho).
//  · 파일 찾기는 대화창과 **같은 한 벌**(transcript-locate.resolveTranscript) — 화면이 보여 주는 바로 그 기록으로 판정한다.
//
//  ── 지키는 것 ──
//  · 거짓 «전달됨» 을 만들지 않는다 — ① 행보다 먼저 적힌 같은 말(같은 지시를 두 번 보낸 경우)은 시각으로 거른다(시계 차 5초만
//    허용) ② 도구 결과·AI 의 글·주입(isMeta)에 인용된 같은 글은 사람 말 줄이 아니라 안 센다 ③ 160자 이하는 전체가 같아야 하고
//    그보다 길면 머리 160자(에코 바늘 echoNeedle 과 같은 기준 — 긴 글은 TUI 를 지나며 꼬리가 뒤섞인다).
//  · 못 읽으면 그대로 둔다 — «미확인» 은 사람이 [다시 보내기]·[지우기]를 고를 수 있는 상태다. 모르는 채로 지우지 않는다.
//  · 비용 — 대화창은 이 목록을 **3초마다** 묻는다. 행마다 «어디까지 읽었나» 를 기억해 파일이 자란 만큼만 다시 읽고(같은 행은
//    5초에 한 번까지), 첫 대조만 꼬리부터 1MB 씩 거슬러 행이 생긴 시각 앞까지 읽는다(상한 8MB). 회수된 세션은 파일이 안 자라
//    첫 한 번으로 끝난다. 중계(매니지드)에선 1MB 창 하나가 원격 읽기 한 번이다.
//  · 이 모듈은 노드 번들 밖이다 — session-outbox.ts 는 노드 번들의 알려진 부채라(scripts/node-agent-known-debt.json) 대화 파일
//    찾기를 거기 들이면 멤버 PC 로 나가는 번들이 자란다(`await import()` 로도 안 빠진다 — node-agent-bundle-boundary.test).
import { listOutbox, settleLateEcho, type OutboxRow } from "./session-outbox.js";
import { readAlignedWindow, type ByteReader } from "../terminal/harness-io/window.js";
import { logger } from "../log.js";

/** 거슬러 읽을 때 한 번에 읽는 창 — 중계에선 원격 읽기 한 번. */
export const LATE_ECHO_WINDOW_BYTES = 1024 * 1024;
/** 한 번의 대조에서 읽는 상한 — 보낸 뒤 쌓인 기록이 이보다 크면 그 앞은 못 본 채로 둔다(«미확인» 유지). */
export const LATE_ECHO_SCAN_BYTES = 8 * 1024 * 1024;
/** 행 시각(DB now())과 기록 시각(하네스가 도는 기계의 시계)의 차이 허용. 말은 큐에 들어간 **뒤에** 쳐지므로 이 정도면 된다. */
export const LATE_ECHO_SKEW_MS = 5_000;
/** 같은 행을 다시 재는 최소 간격 — 파일이 자라고 있어도(도는 세션) 3초 폴링마다 읽지 않는다. */
export const LATE_ECHO_MIN_GAP_MS = 5_000;
/** 기록을 못 찾았거나(매핑 없음) 못 읽었을 때(중계 실패) 다시 물어보기까지. */
export const LATE_ECHO_RETRY_MS = 30_000;
/** 같은 말 판정의 머리 길이 — session-outbox.echoNeedle 의 접두와 같다. */
export const LATE_ECHO_HEAD = 160;

/** (순수) 15초 창이 «못 봤다» 고만 말한 행인가 — 다시 대조할 대상. control(설정 명령)은 애초에 에코가 없다. */
export function lateEchoCandidate(row: Pick<OutboxRow, "status" | "last_error" | "kind">): boolean {
  if (row.kind !== "prompt") return false;
  return (row.status === "sent" && row.last_error === "echo-unconfirmed")
    || (row.status === "failed" && row.last_error === "send: host-unknown");
}

const norm = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * (순수) 기록 한 줄이 **사람이 보낸 말**이면 그 글, 아니면 null.
 *  · user 줄의 text 블록(또는 문자열 본문) — 주입(isMeta)·서브에이전트 가지(isSidechain)·도구 결과(tool_result 만 있는 줄)는 아니다.
 *  · 도는 중에 친 말 — Claude Code 는 그 턴의 다음 틈에 `{"type":"attachment","attachment":{"type":"queued_command","prompt":…}}`
 *    로 적는다(실측: commandMode 'prompt' · origin {kind:'human'}). 같은 줄 모양에 작업 끝 알림·세션 간 메시지도 실리지만 그 글은
 *    사람이 보낸 말과 같을 수 없어 아래 글 대조에서 걸러진다.
 */
export function promptTextOfLine(line: unknown): string | null {
  if (!line || typeof line !== "object") return null;
  const o = line as Record<string, any>;
  if (o.type === "user") {
    if (o.isMeta || o.isSidechain) return null;
    const c = o.message?.content;
    if (typeof c === "string") return c;
    if (!Array.isArray(c)) return null;
    const texts = c.filter((b: any) => b && b.type === "text").map((b: any) => String(b.text ?? ""));
    return texts.length ? texts.join("\n") : null;
  }
  if (o.type === "attachment" && o.attachment?.type === "queued_command" && typeof o.attachment.prompt === "string") {
    return o.attachment.prompt;
  }
  return null;
}

/** (순수) 같은 말인가 — 공백을 하나로 접은 뒤, 160자 이하면 전체가, 그보다 길면 머리 160자가 같아야 한다. */
export function samePrompt(said: string, line: string): boolean {
  const a = norm(said), b = norm(line);
  if (!a || !b) return false;
  if (a.length <= LATE_ECHO_HEAD) return a === b;
  return a.slice(0, LATE_ECHO_HEAD) === b.slice(0, LATE_ECHO_HEAD);
}

/**
 * (순수) 줄 묶음에서 그 말을 찾는다 — notBeforeMs 이후에 적힌 사람 말 줄만 본다.
 *  earliestMs = 이 묶음에서 가장 이른 시각 — 거슬러 읽기가 «행이 생기기 전» 까지 왔는지 판단하는 근거다(시각 없는 줄은 안 센다).
 */
export function scanLinesForPrompt(lines: readonly unknown[], said: string, notBeforeMs: number):
  { found: boolean; at: string | null; earliestMs: number | null } {
  let earliest: number | null = null;
  for (const l of lines) {
    const raw = (l as { timestamp?: unknown } | null)?.timestamp;
    const ts = typeof raw === "string" ? Date.parse(raw) : NaN;
    if (!Number.isFinite(ts)) continue;
    if (earliest === null || ts < earliest) earliest = ts;
    if (ts < notBeforeMs) continue;
    const text = promptTextOfLine(l);
    if (text !== null && samePrompt(said, text)) return { found: true, at: new Date(ts).toISOString(), earliestMs: earliest };
  }
  return { found: false, at: null, earliestMs: earliest };
}

/** 대조할 기록 — 파일 하나의 크기·읽기·해석. 실제는 resolveTranscript 가, 시험은 메모리 버퍼가 채운다(둘 다 alignedSource). */
export interface EchoSource {
  file: string;
  size: number;
  /**
   * [start,end) 를 줄 경계에 맞춰 읽고 해석한 줄 — from/to 는 맞춘 경계(readAlignedWindow 와 같은 뜻).
   *  bytes = 이 창을 맞추느라 **실제로 읽은** 바이트(긴 한 줄을 지날 땐 창보다 훨씬 클 수 있다 — 읽기 상한은 이 값으로 센다).
   */
  window(start: number, end: number): Promise<{ from: number; to: number; lines: unknown[]; bytes: number }>;
}

/**
 * 바이트 읽기 + 해석기 → 대조할 기록. 줄 경계 맞춤은 대화창 창과 같은 규칙(readAlignedWindow)이고, 끝은 늘 «명시» 로 맞춘다 —
 *  거슬러 읽을 때 다음 창의 끝이 앞 창의 시작(줄 경계)과 정확히 만나고, 파일 끝의 쓰는 중인 반 줄은 잘라 낸다(window.ts 끝 정렬 ①②).
 * @param read 파일을 열어 ByteReader 로 fn 을 돌린다(로컬 fs 또는 멤버 중계 — transcript-fs).
 */
export function alignedSource(
  file: string, size: number,
  read: <T>(fn: (r: ByteReader) => Promise<T>) => Promise<T>,
  parse: (text: string) => unknown[],
): EchoSource {
  return {
    file, size,
    async window(start, end) {
      let bytes = 0;
      const w = await read((r) => readAlignedWindow({
        async read(s, e) { const b = await r.read(s, e); bytes += b.length; return b; },
      }, size, start, end, true));
      return { from: w.from, to: w.to, lines: w.data.length ? parse(w.data.toString("utf8")) : [], bytes };
    },
  };
}

/** 한 행에 대해 «어디까지 읽었나» — 다음엔 그 뒤만 읽는다. */
export interface EchoMemo { file: string; scannedTo: number; at: number }

/**
 * 그 말이 기록에 있나 — 메모가 없으면 꼬리부터 거슬러(행이 생긴 시각 앞까지·상한까지), 있으면 메모 뒤에 자란 만큼만 앞으로.
 *  scannedTo = 다음 대조가 이어 읽을 자리(줄 경계). 파일이 바뀌었으면(맥락 압축으로 새 파일) 처음부터 다시 거슬러 읽는다.
 */
export async function findPromptInTranscript(
  src: EchoSource, said: string, notBeforeMs: number, memo: EchoMemo | null,
  o: { windowBytes?: number; scanBytes?: number } = {},
): Promise<{ found: boolean; at: string | null; scannedTo: number }> {
  const W = o.windowBytes ?? LATE_ECHO_WINDOW_BYTES;
  let budget = o.scanBytes ?? LATE_ECHO_SCAN_BYTES;
  if (memo && memo.file === src.file && memo.scannedTo <= src.size) {
    // 앞으로 — 지난번 끝(줄 경계)부터 지금 끝까지. 끝이 쓰는 중인 반 줄이면 window 가 그 앞에서 멈춘다(다음 대조가 잇는다).
    let pos = memo.scannedTo;
    while (pos < src.size && budget > 0) {
      const w = await src.window(pos, Math.min(src.size, pos + W));
      if (w.to <= pos) break;                        // 온전한 줄이 아직 없다(쓰는 중) — 다음에
      const r = scanLinesForPrompt(w.lines, said, notBeforeMs);
      if (r.found) return { found: true, at: r.at, scannedTo: w.to };
      budget -= w.bytes; pos = w.to;
    }
    return { found: false, at: null, scannedTo: pos };
  }
  // 거슬러 — 꼬리 창부터. 첫 창의 끝(마지막 온전한 줄 뒤)이 다음 대조의 시작이다.
  let end = src.size; let scannedTo = -1;
  while (end > 0 && budget > 0) {
    const start = Math.max(0, end - W);
    const w = await src.window(start, end);
    if (scannedTo < 0) scannedTo = w.to;
    const r = scanLinesForPrompt(w.lines, said, notBeforeMs);
    if (r.found) return { found: true, at: r.at, scannedTo };
    if (r.earliestMs !== null && r.earliestMs < notBeforeMs) break;   // 행이 생기기 전까지 다 봤다 — 그 앞엔 이 말이 있을 수 없다
    budget -= w.bytes;                                                 // 실제로 읽은 만큼 — 긴 줄을 지나며 늘려 읽은 것까지
    if (start === 0) break;
    //  다음 창은 이 창이 시작한 줄 경계에서 끝난다. 이 구간 전체가 긴 한 줄 안이면(시작 경계를 못 찾음) 날 경계로 물러난다 —
    //   다음 창의 끝은 줄 끝까지 늘려 읽히므로(readAlignedWindow 끝 정렬 ①) 그 긴 줄도 빠지지 않는다.
    end = w.from < end ? w.from : start;
  }
  return { found: false, at: null, scannedTo: Math.max(0, scannedTo) };
}

// ── 대조 운전(행마다 기억 · 겹침 막기) ─────────────────────────────────────────────
//  기억은 게이트웨이 프로세스 안에만 있다(롤·재기동이면 다음 대조가 다시 거슬러 읽는다 — 틀린 답이 아니라 한 번 더 읽을 뿐이다).
//  열쇠는 행 id — 매니지드 공용 DB 에서도 한 표의 bigserial 이라 워크스페이스끼리 겹치지 않는다.
interface RowMemo extends EchoMemo {
  /** 다음 대조까지 기다릴 간격 — 파일이 그대로면 늘린다(최대 1분), 자라면 처음 간격으로. */
  gap: number;
  /** 지난번에 기록을 못 찾았나·못 읽었나(LATE_ECHO_RETRY_MS 뒤 다시) */
  failed?: boolean;
  size?: number;
}
const memos = new Map<number, RowMemo>();
const inflight = new Set<number>();
const MEMO_TTL_MS = 60 * 60_000;
const MEMO_MAX = 2_000;
const GAP_MAX_MS = 60_000;

/** (순수) 이 행을 지금 다시 잴 때인가. */
export function lateEchoDue(memo: Pick<RowMemo, "at" | "gap" | "failed"> | undefined, now: number): boolean {
  if (!memo) return true;
  return now - memo.at >= (memo.failed ? LATE_ECHO_RETRY_MS : memo.gap);
}

export interface ReconcileDeps {
  /** 큐 목록 — 기본은 session-outbox.listOutbox(화면용 목록). */
  list(sessionId: string): Promise<OutboxRow[]>;
  /** 이 세션의 대화 기록 — 못 찾으면 null(매핑 없음·못 읽는 하네스), 중계 실패는 throw. */
  source(sessionId: string): Promise<EchoSource | null>;
  /** 찾은 행을 'delivered·echo-late' 로 — 그새 사람이 다른 것을 골랐으면 false. */
  settle(sessionId: string, id: number, at: string | null): Promise<boolean>;
  now(): number;
}

async function transcriptSource(sessionId: string): Promise<EchoSource | null> {
  const { resolveTranscript } = await import("../terminal/transcript-locate.js");
  const t = await resolveTranscript(sessionId);
  if (!t.ok) return null;
  const { io, tfs, found } = t;
  return alignedSource(found.file, found.size, (fn) => tfs.read(found.file, found.size, fn), (text) => io.parse(text, {}).lines);
}

const defaultDeps: ReconcileDeps = { list: listOutbox, source: transcriptSource, settle: settleLateEcho, now: Date.now };

/**
 * 이 세션의 «미확인» 행들을 기록과 대조해, 기록에 있던 것을 'delivered·echo-late' 로 바로잡는다. 반환 = 바로잡은 행 id.
 *  같은 행을 동시에 두 번 재지 않는다(화면 두 탭·느린 중계 — 늦은 쪽은 이번엔 건너뛴다).
 */
export async function reconcileLateEchoes(sessionId: string, rows: readonly OutboxRow[], deps: ReconcileDeps = defaultDeps): Promise<Set<number>> {
  const settled = new Set<number>();
  const now = deps.now();
  const due = rows.filter((r) => lateEchoCandidate(r) && !inflight.has(r.id) && lateEchoDue(memos.get(r.id), now));
  if (!due.length) return settled;
  for (const r of due) inflight.add(r.id);
  try {
    let src: EchoSource | null = null;
    try { src = await deps.source(sessionId); }
    catch (e) { logger.warn({ err: e, sessionId }, "outbox: 늦은 에코 — 대화 기록을 못 읽었다(다음에 다시)"); }
    if (!src) {
      for (const r of due) memos.set(r.id, { file: memos.get(r.id)?.file ?? "", scannedTo: memos.get(r.id)?.scannedTo ?? 0, at: now, gap: LATE_ECHO_MIN_GAP_MS, failed: true });
      return settled;
    }
    for (const r of due) {
      const prev = memos.get(r.id);
      const notBefore = Date.parse(r.created_at) - LATE_ECHO_SKEW_MS;
      try {
        const got = await findPromptInTranscript(src, r.text, notBefore, prev && !prev.failed ? prev : null);
        if (got.found && await deps.settle(sessionId, r.id, got.at)) {
          settled.add(r.id); memos.delete(r.id);
          //  사람이 쓴 글은 싣지 않는다(outbox-measure 와 같은 규약). lateMs = 큐에 들어간 뒤 기록에 그 말이 적힌 시각까지.
          logger.info({ sessionId, id: r.id, seq: r.seq, was: `${r.status}/${r.last_error}`,
            lateMs: got.at ? Date.parse(got.at) - Date.parse(r.created_at) : null }, "outbox: 늦은 에코 — 기록에 있던 말을 전달됨으로 바로잡았다(#4819)");
          continue;
        }
        const grew = !prev || prev.failed || prev.file !== src.file || (prev.size ?? -1) !== src.size;
        memos.set(r.id, { file: src.file, scannedTo: got.scannedTo, size: src.size, at: now,
          gap: grew ? LATE_ECHO_MIN_GAP_MS : Math.min(GAP_MAX_MS, (prev?.gap ?? LATE_ECHO_MIN_GAP_MS) * 2) });
      } catch (e) {
        memos.set(r.id, { file: prev?.file ?? "", scannedTo: prev?.scannedTo ?? 0, size: prev?.size, at: now, gap: LATE_ECHO_MIN_GAP_MS, failed: true });
        logger.warn({ err: e, sessionId, id: r.id }, "outbox: 늦은 에코 — 대조 실패(다음에 다시)");
      }
    }
  } finally {
    for (const r of due) inflight.delete(r.id);
    pruneMemos(now);
  }
  return settled;
}

function pruneMemos(now: number): void {
  for (const [id, m] of memos) if (now - m.at > MEMO_TTL_MS) memos.delete(id);
  while (memos.size > MEMO_MAX) { const first = memos.keys().next().value; if (first === undefined) break; memos.delete(first); }
}

/** 시험 전용 — 행 기억을 비운다(시험끼리 섞이지 않게). */
export function resetLateEchoMemoForTest(): void { memos.clear(); inflight.clear(); }

/**
 * 화면이 큐를 읽는 자리(GET …/outbox) — listOutbox 에서 **기록에 이미 있는 말**을 바로잡아 뺀 목록.
 *  대조가 실패해도 목록은 나간다(종전 그대로 — 화면의 대기·실패 말풍선은 이 목록이 유일한 근거다).
 */
export async function listOutboxReconciled(sessionId: string, deps: ReconcileDeps = defaultDeps): Promise<OutboxRow[]> {
  const rows = await deps.list(sessionId);
  if (!rows.some(lateEchoCandidate)) return rows;
  const settled = await reconcileLateEchoes(sessionId, rows, deps).catch((e) => {
    logger.warn({ err: e, sessionId }, "outbox: 늦은 에코 — 대조를 건너뛰었다");
    return new Set<number>();
  });
  return settled.size ? rows.filter((r) => !settled.has(r.id)) : rows;
}
