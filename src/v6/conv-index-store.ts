// 세션 대화 색인·검색 저장 경로(#4517, 원준 2026-09-30) — 중앙 세션 기록(session_log_chunk)에서 사람 말·AI 말만 뽑아
//  session_msg 에 담고, ⌘K 가 그 표를 찾는다. 규칙(무엇을 뽑나·어떻게 순위를 매기나)은 conv-search.ts(순수)에 있다.
//
//  ── 왜 색인 표가 따로 있나 ──
//   종전 «세션 이력» 검색(GET /api/ui/terminal/prompts/search)은 **게이트웨이 디스크의 대화 파일**을 요청마다 훑었다.
//   매니지드는 대화가 세션 호스트·사람 PC 에 있어 게이트웨이 디스크에 없다 — 실측(2026-09-30, lively-46e3): «검색»·«슬랙»·
//   «고쳐줘» 모두 0건이었다(한 달 넘게 말한 낱말인데도). 중앙 기록은 어디서 돈 세션이든 한 곳에 있지만 zstd 로 눌린 원본
//   JSONL 이라(원준 한 사람 266개 세션 2.17GB) 요청마다 풀 수 없다. 그래서 **한 번 풀어 글만** 남긴다(원본의 약 0.3%).
//
//  ── 이어 읽기(커서) ──
//   session_msg_cursor.indexed_to = 이 바이트까지 **줄 단위로** 읽었다(늘 줄 경계). 새 청크가 오면 거기서부터 이어 읽는다.
//   커밋은 offset-CAS 다(UPDATE … WHERE indexed_to = 읽기 시작점) — 업로드 직후 색인과 주기 정비가 같은 세션을 동시에 잡아도
//   먼저 커밋한 쪽만 행을 넣고 나머지는 그대로 물러난다(세션 기록 append 와 같은 원리 — 락을 새로 들이지 않는다).
//   파서 상태(codex 의 중복 가리기 등)도 커서에 싣는다 — 창을 넘어도 같은 결과가 나오게. 뽑는 규칙이 바뀌면 판(ver)을 올린다 —
//   판이 다른 커서는 그 세션을 처음부터 다시 색인한다(이미 읽은 창에 새 규칙이 안 닿는 일을 막는다).
//
//  ── 게이트웨이를 지킨다 ──
//   색인은 이 프로세스에서 동시에 INDEX_SLOTS 개까지만 돈다(업로드 직후·정비 공통). 한 창은 2MB 라 압축 풀기·JSON 읽기가
//   이벤트 루프를 길게 쥐지 않고, 창 사이마다 루프를 돌려준다. 정비는 마감 시각을 창마다 잰다.
//
//  ── 지우기 ──
//   완전 삭제(purgeSessionLog)·보존기간 정리(reapSessionLogs)가 이 두 표도 함께 지운다(session-log-store.ts).
//   색인이 남으면 지운 대화가 검색으로 되살아난다.
import { itemsPool, withTx } from "../db/client.js";
import { readSessionLog, sessionWorkspaceWhere } from "./session-log-store.js";
import { readAlignedWindow, prefetchReader, type ByteReader } from "../terminal/harness-io/window.js";
import { harnessIo } from "../terminal/harness-io/adapter.js";
import { parseJsonLines, type ChatLine, type ParseResult, type ParseState } from "../terminal/harness-io/chat-line.js";
import { extractConvMessages, rankConvSessions, type ConvMsg, type ConvRow, type ConvSessionHit, type ConvSort } from "./conv-search.js";
import { queryTerms } from "../terminal/terminal-transcript.js";
import { likeEscape } from "./search-util.js";
import { hiddenProjects, type HiddenProjects } from "./visibility.js";
import { sessionVisible } from "../terminal/write-cap.js";
import { sessionNameFromPrompt } from "../terminal/session-name.js";
import { currentTenant, withTenant } from "../org/tenant-context.js";

/** 한 번에 읽는 창. 이보다 긴 한 줄은 그 줄만 따로 읽는다(LONG_LINE_MAX 까지). */
export const CONV_WINDOW = 2 * 1024 * 1024;
/** 따로 읽어 줄 한 줄의 상한. 스크린샷을 붙인 지시는 그림이 base64 로 그 줄에 실려 MB 단위가 된다(이 박스의 실제 대화 238개:
 *  그림 실린 줄 최대 1.37MB · 재검토가 2.5MB·5MB 줄에서 사람 말이 통째로 빠지는 것을 확인). API 가 그림 한 장을 5MB 로 막으므로
 *  16MB 면 그림 세 장까지 든다. 이보다 긴 줄(거대한 도구 결과)은 건너뛴다 — 동시 색인 2 × 이 크기가 게이트웨이 메모리의 상한이다. */
export const LONG_LINE_MAX = 16 * 1024 * 1024;
/** 뽑는 규칙의 판. extractConvMessages·하네스 파서가 바뀌어 옛 색인을 다시 만들어야 하면 올린다. */
export const CONV_INDEX_VER = 1;
const NL = 0x0a;

type Parser = (text: string, state: ParseState) => ParseResult;
/** 하네스 → 파서. 미보고(구 행, harness NULL)는 claude 원본으로 읽는다(대화창 렌더와 같은 판단 — session-log-routes).
 *  파서가 없는 하네스(opencode·셸)는 null — 색인할 글이 없다고 보고 커서만 끝으로 민다. */
export function convParserFor(harness: string | null | undefined): Parser | null {
  if (!harness) return (text, state) => ({ lines: parseJsonLines(text).filter((o) => !!o && typeof o === "object") as ChatLine[], state });
  const io = harnessIo(harness);
  return io?.parse ?? null;
}

/** DB 가 받지 못하는 글자(NUL)를 걷는다 — 하나만 섞여도 그 창의 커밋이 통째로 실패해 색인이 그 자리에서 멈춘다. */
const pgText = (s: string): string => s.replace(/\u0000/g, "");
/** ISO 로 읽히는 시각만 — 이상한 값 하나가 캐스트 오류로 창 커밋을 막지 않게. */
const pgTs = (s: string): string | null => { const n = s ? Date.parse(s) : NaN; return Number.isFinite(n) ? new Date(n).toISOString() : null; };
/** 파서 상태 → jsonb. JSONB 도 NUL(\u0000)을 못 받는다 — 상태에 사람 말이 실리는 하네스(codex)가 있어 같은 이유로 걷는다.
 *  ⚠ **인코딩하면서** 문자열 값의 NUL 만 걷는다. 인코딩이 끝난 JSON 에서 그 여섯 글자를 지우면, 사람이 «\u0000» 이라는 글자를
 *   그대로 친 경우(역슬래시가 하나 더 붙어 인코딩된다) 역슬래시 하나만 남아 JSON 이 깨지고 그 창이 영영 커밋되지 못한다. */
const pgState = (state: ParseState): string =>
  JSON.stringify(state ?? {}, (_k, v: unknown) => (typeof v === "string" ? v.replace(/\u0000/g, "") : v));

// ── 동시 실행 상한 — 이 프로세스의 색인은 INDEX_SLOTS 개까지만(업로드 직후·정비 공통) ──
//  배포 직후엔 살아 있는 세션마다 첫 업로드가 제 기록 전체를 색인하려 든다. 상한이 없으면 그 수만큼 동시에 풀고 읽는다.
const INDEX_SLOTS = 2;
let slotsBusy = 0;
const slotWaiters: Array<() => void> = [];
async function withIndexSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (slotsBusy >= INDEX_SLOTS) await new Promise<void>((r) => slotWaiters.push(r));
  slotsBusy++;
  try { return await fn(); } finally { slotsBusy--; slotWaiters.shift()?.(); }
}

/** 창 하나를 커밋한다 — 커서가 from 에 있을 때만(CAS). 성공하면 true. */
async function commitWindow(nodeId: string, sessionId: string, from: number, to: number, msgs: ConvMsg[], state: ParseState): Promise<boolean> {
  return withTx(async (client) => {
    const u = await client.query(
      `UPDATE session_msg_cursor SET indexed_to = $4, state = $5::jsonb, updated_at = now()
        WHERE node_id = $1 AND session_id = $2 AND indexed_to = $3`,
      [nodeId, sessionId, from, to, pgState(state)]);
    if (u.rowCount !== 1) return false;   // 다른 색인기가 먼저 옮겼다 — 이 창은 그쪽 몫이다
    if (msgs.length) {
      await client.query(
        `INSERT INTO session_msg(node_id, session_id, at_offset, idx, role, ts, body)
         SELECT $1, $2, $3, x.idx, x.role, x.ts::timestamptz, x.body
           FROM unnest($4::int[], $5::text[], $6::text[], $7::text[]) AS x(idx, role, ts, body)`,
        [nodeId, sessionId, from,
          msgs.map((_, i) => i), msgs.map((m) => m.role), msgs.map((m) => pgTs(m.ts)), msgs.map((m) => pgText(m.text))]);
    }
    return true;
  });
}

/** from 뒤 첫 개행의 다음 자리 — 창보다 긴 한 줄을 건너뛸 때. 개행이 아직 안 왔으면(쓰는 중) -1. */
async function nextLineStart(reader: ByteReader, total: number, from: number): Promise<number> {
  const STEP = 1024 * 1024;
  for (let at = from; at < total; at += STEP) {
    const buf = await reader.read(at, Math.min(total, at + STEP));
    if (!buf.length) return -1;
    const i = buf.indexOf(NL);
    if (i >= 0) return at + i + 1;
  }
  return -1;
}

/** 이 세션의 색인을 처음부터 다시 — 커서가 기록보다 앞서 있거나(기록이 새로 시작됐다) 판이 다르면 옛 색인은 버린다. */
async function resetConvIndex(nodeId: string, sessionId: string): Promise<void> {
  await withTx(async (client) => {
    await client.query(`DELETE FROM session_msg WHERE node_id = $1 AND session_id = $2`, [nodeId, sessionId]);
    await client.query(`DELETE FROM session_msg_cursor WHERE node_id = $1 AND session_id = $2`, [nodeId, sessionId]);
  });
}

export interface IndexOpts {
  /** 이번에 읽을 원본 바이트 상한(다음 호출이 이어 간다). */
  maxBytes?: number;
  /** 이 시각(ms)을 넘으면 창 사이에서 멈춘다. */
  deadline?: number;
  /** 한 번에 읽는 창 — 시험이 «창보다 긴 한 줄» 을 싸게 만들려고 줄인다. */
  window?: number;
  /** 따로 읽어 줄 한 줄의 상한(기본 LONG_LINE_MAX) — 시험이 줄인다. */
  longLineMax?: number;
}

/** 한 세션을 이어 색인한다. 반환: 이번에 읽은 바이트 · 끝까지 따라잡았나. 동시 실행 상한(INDEX_SLOTS) 안에서 돈다. */
export function indexConvSession(nodeId: string, sessionId: string, opts: IndexOpts = {}): Promise<{ read: number; done: boolean }> {
  return withIndexSlot(() => indexConvSessionNow(nodeId, sessionId, opts));
}

async function indexConvSessionNow(nodeId: string, sessionId: string, opts: IndexOpts): Promise<{ read: number; done: boolean }> {
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
  const window = opts.window ?? CONV_WINDOW;
  const longLineMax = opts.longLineMax ?? LONG_LINE_MAX;
  const head = await itemsPool.query(
    `SELECT l.bytes, s.harness, c.indexed_to, c.state, c.ver
       FROM session_log l
       JOIN session s ON s.node_id = l.node_id AND s.session_id = l.session_id
       LEFT JOIN session_msg_cursor c ON c.node_id = l.node_id AND c.session_id = l.session_id
      WHERE l.node_id = $1 AND l.session_id = $2`, [nodeId, sessionId]);
  const row = head.rows[0] as { bytes: string | number; harness: string | null; indexed_to: string | number | null; state: ParseState | null; ver: number | null } | undefined;
  if (!row) return { read: 0, done: true };
  const total = Number(row.bytes) || 0;
  let at = row.indexed_to == null ? 0 : Number(row.indexed_to);
  let state: ParseState = (row.state && typeof row.state === "object") ? row.state : {};
  let fresh = row.indexed_to == null;
  if (!fresh && (at > total || Number(row.ver) !== CONV_INDEX_VER)) { await resetConvIndex(nodeId, sessionId); at = 0; state = {}; fresh = true; }
  if (fresh) {
    await itemsPool.query(`INSERT INTO session_msg_cursor(node_id, session_id, ver) VALUES($1, $2, $3) ON CONFLICT DO NOTHING`, [nodeId, sessionId, CONV_INDEX_VER]);
  }
  const parse = convParserFor(row.harness);
  if (!parse) {
    //  읽을 수 없는 하네스 — 글이 없다. 커서만 끝으로(다음 정비가 다시 집지 않게).
    if (at < total) await commitWindow(nodeId, sessionId, at, total, [], state);
    return { read: total - at, done: true };
  }
  let read = 0;
  while (at < total && read < maxBytes && !(opts.deadline && Date.now() >= opts.deadline)) {
    const end = Math.min(total, at + window);
    const reader = prefetchReader((s, e) => readSessionLog(nodeId, sessionId, s, e).then((r) => r.data), total);
    const w = await readAlignedWindow(reader, total, at, end, false);
    let next = at;
    let msgs: ConvMsg[] = [];
    let nextState = state;
    if (w.to > w.from) {
      const r = parse(w.data.toString("utf8"), state);
      msgs = extractConvMessages(r.lines);
      nextState = r.state ?? {};
      next = w.to;
    } else {
      if (end >= total) break;                                   // 끝의 반 줄 — 쓰는 중이다. 다음에 이어 읽는다
      const lineEnd = await nextLineStart(reader, total, end);   // 창보다 긴 한 줄 — 어디서 끝나나
      if (lineEnd <= at) break;                                  // 개행이 아직 안 왔다(쓰는 중)
      if (lineEnd - at <= longLineMax) {
        //  그 줄만 따로 읽어 글을 뽑는다 — 대개 스크린샷을 붙인 지시다(그림은 버리고 글만 남는다).
        const one = (await readSessionLog(nodeId, sessionId, at, lineEnd)).data;
        const r = parse(one.toString("utf8"), state);
        msgs = extractConvMessages(r.lines);
        nextState = r.state ?? {};
      }
      next = lineEnd;                                            // 상한보다 길면(거대한 도구 결과) 글 없이 건너뛴다
    }
    if (!(await commitWindow(nodeId, sessionId, at, next, msgs, nextState))) return { read, done: false };
    read += next - at;
    at = next;
    state = nextState;
    await new Promise<void>((r) => setImmediate(r));             // 큰 기록을 풀 때 이벤트 루프를 잠깐씩 돌려준다
  }
  return { read, done: at >= total };
}

// ── 주기 정비 — 밀린 세션을 최근 것부터 ──────────────────────────────────────────────
//  한 번에 SWEEP_MAX_BYTES 또는 SWEEP_MAX_MS 까지(마감은 창마다 잰다). 매니지드는 요청에 얹힌 정비표(outbox-request-sweep)가,
//   셀프호스트는 하우스키핑이 부른다. 같은 테넌트의 정비가 겹치면(앞 판이 아직 도는데 다음 판이 옴) 뒤 판은 그냥 돌아간다.
export const SWEEP_MAX_BYTES = 256 * 1024 * 1024;
export const SWEEP_MAX_MS = 8_000;
const sweeping = new Set<string>();
const tenantKey = (): string => currentTenant()?.id ?? "-";

/** 색인이 밀린 세션(판이 다른 것 포함) — 서브에이전트·작업 상자 세션은 검색에서 빠지므로 색인도 하지 않는다. */
async function pendingSessions(limit: number): Promise<Array<{ node_id: string; session_id: string }>> {
  const r = await itemsPool.query(
    `SELECT l.node_id, l.session_id
       FROM session_log l
       JOIN session s ON s.node_id = l.node_id AND s.session_id = l.session_id
       LEFT JOIN session_msg_cursor c ON c.node_id = l.node_id AND c.session_id = l.session_id
      WHERE (l.bytes > COALESCE(c.indexed_to, 0) OR (c.session_id IS NOT NULL AND c.ver IS DISTINCT FROM $2))
        AND s.parent_session_id IS NULL AND s.run_kind IS DISTINCT FROM 'task'
      ORDER BY l.updated_at DESC
      LIMIT $1`, [limit, CONV_INDEX_VER]);
  return r.rows as Array<{ node_id: string; session_id: string }>;
}

export async function sweepConvIndex(opts: { maxBytes?: number; maxMs?: number } = {}): Promise<{ sessions: number; read: number }> {
  const key = tenantKey();
  if (sweeping.has(key)) return { sessions: 0, read: 0 };
  sweeping.add(key);
  const deadline = Date.now() + (opts.maxMs ?? SWEEP_MAX_MS);
  const maxBytes = opts.maxBytes ?? SWEEP_MAX_BYTES;
  let read = 0, sessions = 0;
  try {
    for (const s of await pendingSessions(40)) {
      if (read >= maxBytes || Date.now() >= deadline) break;
      try {
        const r = await indexConvSession(s.node_id, s.session_id, { maxBytes: maxBytes - read, deadline });
        read += r.read; sessions++;
      } catch (e) {
        //  한 세션이 막혀도 나머지는 간다 — 다음 판이 다시 집는다.
        console.warn(`[conv-index] ${s.session_id} 색인 실패(비치명):`, (e as Error)?.message ?? e);
      }
    }
  } finally {
    sweeping.delete(key);
  }
  return { sessions, read };
}

// ── 업로드 직후 색인 — 방금 한 말이 곧바로 찾아지게 ────────────────────────────────────
//  세션 기록 append(POST /api/ui/v6/sessions/:id/log)가 부른다. 같은 세션의 연속 업로드는 한 번으로 모은다(2초) — 단 계속
//   올라오는 세션도 10초 안에는 한 번 돈다(모으기만 하다 영영 안 도는 일이 없게). 한 번에 16MB 까지만 — 밀린 옛 기록은 정비 몫.
//  ⚠ 테넌트 컨텍스트를 **붙잡아 둔다** — 타이머 콜백에서 그 워크스페이스의 표를 봐야 한다.
const DEBOUNCE_MS = 2_000;
const DEBOUNCE_MAX_WAIT_MS = 10_000;
const UPLOAD_INDEX_BYTES = 16 * 1024 * 1024;
const scheduled = new Map<string, { timer: ReturnType<typeof setTimeout>; first: number }>();
export function scheduleConvIndex(nodeId: string, sessionId: string): void {
  const t = currentTenant();
  const key = `${t?.id ?? "-"}\u0001${nodeId}\u0001${sessionId}`;
  const prev = scheduled.get(key);
  const first = prev ? prev.first : Date.now();
  if (prev) clearTimeout(prev.timer);
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, first + DEBOUNCE_MAX_WAIT_MS - Date.now()));
  const timer = setTimeout(() => {
    scheduled.delete(key);
    const run = (): Promise<unknown> => indexConvSession(nodeId, sessionId, { maxBytes: UPLOAD_INDEX_BYTES }).catch((e) => {
      console.warn(`[conv-index] ${sessionId} 업로드 직후 색인 실패(비치명 — 주기 정비가 다시 집는다):`, (e as Error)?.message ?? e);
    });
    void (t ? withTenant(t, run) : run());
  }, wait);
  timer.unref?.();
  scheduled.set(key, { timer, first });
}

// ── 검색 ───────────────────────────────────────────────────────────────────────
/** 한 번에 모으는 메시지 상한 — 흔한 낱말이면 여기서 잘린다. 잘렸는지는 응답의 capped 로 말한다. */
export const CONV_ROW_CAP = 2000;
/** 검색 한 번의 SQL 시간 상한 — 공유 풀(최대 20)을 오래 쥐지 않는다(#936 자료 검색이 풀을 말린 사고와 같은 자리). */
export const CONV_QUERY_TIMEOUT_MS = 4_000;
/** 색인이 이만큼보다 밀린 세션을 «아직 색인 중» 으로 센다 — 도는 세션의 쓰는 중인 꼬리는 세지 않는다. */
export const PENDING_GAP_BYTES = 256 * 1024;

export interface ConvSearchInput {
  requester: string;
  q: string;
  sort: ConvSort;
  /** 이 시각(ISO) 이후의 말만 — 화면의 «기간». */
  since?: string | null;
  limit: number;
  /** 세션 목록과 같은 워크스페이스 격리(#1875) — sessionWorkspaceWhere 한 벌. */
  workspaceId?: string | null;
  /** 세션 공유 view_policy — attach 면 초대받은 세션도 찾는다(대화록 열람 게이트와 같은 축). */
  attach: boolean;
  nowMs?: number;
}
/** 화면이 그리는 것만 싣는다 — 프로젝트·주인·점수 같은 메타는 안 싣는다(화면이 안 쓰고, 실으면 그것만으로 새는 정보가 된다). */
export interface ConvSearchResult {
  node_id: string; session_id: string;
  name: string | null; title: string | null;
  hits: number; at: string | null;
  best: ConvSessionHit["best"];
}

/**
 * 볼 수 있는 세션(별칭 s) — 대화록 열람 게이트(checkViewGate · sessionInvitesMember)와 같은 축: 주인 + 초대받은 사람.
 *  여기에 워크스페이스 격리(sessionWorkspaceWhere) · 주인의 휴지통 제외를 더한다. 초대받은 세션은 SQL 뒤에 목록·입장과 같은
 *  판정(sessionVisible — 그 프로젝트가 나에게 가려져 있으면 안 보인다)을 한 번 더 거친다(allowedInvites).
 *  ★ 초대·휴지통은 **집합으로 한 번** 셈한다(WITH). 세션마다 «이 세션을 돌린 박스가 나를 초대했나 · 버렸나» 를 하위 질의로 다시 재면
 *   세션 수 × 박스 수로 늘어난다 — 재검토 실측(세션 6천 · 메시지 30만, Postgres 17): 검색이 4초 상한에 걸려 503, 밀린 수 세기 10초.
 *  ⚠ 휴지통 표식은 주인의 것이다(t.owner = s.owner) — 주인이 버린 세션은 초대받은 사람의 검색에서도 빠진다(지운 것으로 다룬다).
 *   표식은 대화 uuid 로도, 그 대화를 돌린 박스 id 로도 붙는다(session-trash-ops resolveMine).
 */
function visibleSql(params: unknown[], input: Pick<ConvSearchInput, "requester" | "attach" | "workspaceId">): { ctes: string; where: string } {
  params.push(input.requester); const me = `$${params.length}`;
  params.push(!!input.attach); const att = `$${params.length}`;
  const ctes = `inv AS (
       SELECT st.id AS box FROM org_session_state st
        WHERE ${att}::boolean AND st.invites @> to_jsonb(ARRAY[${me}::text])),
     invc AS (
       SELECT box AS conv FROM inv
       UNION SELECT c.conv_uuid FROM org_session_conv c JOIN inv ON c.box_id = inv.box),
     trashed AS (
       SELECT t.owner, t.session_id AS sid FROM org_session_trash t
       UNION SELECT t.owner, c.conv_uuid FROM org_session_trash t JOIN org_session_conv c ON c.box_id = t.session_id)`;
  const wh = [
    `s.parent_session_id IS NULL`, `s.run_kind IS DISTINCT FROM 'task'`,
    `(s.owner = ${me} OR s.session_id IN (SELECT conv FROM invc))`,
    `NOT EXISTS (SELECT 1 FROM trashed x WHERE x.owner = s.owner AND x.sid = s.session_id)`,
  ];
  if (input.workspaceId) wh.push(sessionWorkspaceWhere(params, input.workspaceId));
  return { ctes, where: wh.join(" AND ") };
}

/** 시간 상한을 건 읽기 — 공유 풀(최대 20)을 오래 쥐지 않는다(#936 자료 검색이 풀을 말린 사고와 같은 자리).
 *  넘으면 Postgres 가 끊고(57014) 라우트가 503 «끝까지 못 봤다» 로 돌려준다. */
async function boundedQuery(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
  return withTx(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${CONV_QUERY_TIMEOUT_MS}`);
    return client.query(sql, params);
  });
}

/** 볼 수 있는 세션 중 색인이 밀린 수 — 화면이 «아직 못 찾을 수 있다» 를 정직하게 말할 근거.
 *  아직 한 번도 색인하지 않은 세션(커서 없음)은 꼬리가 작아도 센다 — 그 세션의 말은 지금 하나도 안 찾아진다.
 *  초대받은 세션은 검색과 같은 2차 판정(가려진 프로젝트)을 거친 뒤에 센다 — 감춘 세션을 수로도 드러내지 않는다. */
export async function convIndexPending(input: Pick<ConvSearchInput, "requester" | "attach" | "workspaceId">): Promise<number> {
  const params: unknown[] = [];
  const v = visibleSql(params, input);
  params.push(PENDING_GAP_BYTES); const gap = `$${params.length}`;
  params.push(CONV_INDEX_VER); const ver = `$${params.length}`;
  const r = await boundedQuery(
    `WITH ${v.ctes}
     SELECT s.session_id, s.owner
       FROM session s
       JOIN session_log l ON l.node_id = s.node_id AND l.session_id = s.session_id
       LEFT JOIN session_msg_cursor c ON c.node_id = s.node_id AND c.session_id = s.session_id
      WHERE l.bytes > 0
        AND (c.session_id IS NULL OR c.ver IS DISTINCT FROM ${ver} OR l.bytes - c.indexed_to > ${gap})
        AND ${v.where}`, params);
  const rows = r.rows.map((x) => ({ session_id: String(x.session_id), owner: (x.owner as string | null) ?? null }));
  const ok = await allowedInvites([...new Set(rows.filter((x) => x.owner !== input.requester).map((x) => x.session_id))], input.requester);
  return rows.filter((x) => x.owner === input.requester || ok.has(x.session_id)).length;
}

export async function searchConversations(input: ConvSearchInput): Promise<{ results: ConvSearchResult[]; capped: boolean }> {
  const terms = queryTerms(input.q);
  if (!terms.length || !input.requester) return { results: [], capped: false };
  const params: unknown[] = [];
  const v = visibleSql(params, input);
  const wh = terms.map((t) => { params.push(`%${likeEscape(t)}%`); return `m.body ILIKE $${params.length} ESCAPE '\\'`; });
  const sinceMs = input.since ? Date.parse(input.since) : NaN;
  if (Number.isFinite(sinceMs)) { params.push(new Date(sinceMs).toISOString()); wh.push(`m.ts >= $${params.length}::timestamptz`); }
  params.push(CONV_ROW_CAP);
  //  볼 수 있는 세션을 먼저 굳히고(MATERIALIZED) 그 세션들의 말만 훑는다 — 말마다 권한을 다시 재지 않는다.
  const r = await boundedQuery(
    `WITH ${v.ctes},
     vis AS MATERIALIZED (
       SELECT s.node_id, s.session_id, s.owner
         FROM session s
         JOIN session_log l ON l.node_id = s.node_id AND l.session_id = s.session_id AND l.bytes > 0
        WHERE ${v.where})
     SELECT m.node_id, m.session_id, m.role, m.ts, m.body, vis.owner
       FROM vis
       JOIN session_msg m ON m.node_id = vis.node_id AND m.session_id = vis.session_id
      WHERE ${wh.join(" AND ")}
      ORDER BY m.ts DESC NULLS LAST
      LIMIT $${params.length}`, params);
  let rows: ConvRow[] = r.rows.map((x) => ({
    node_id: String(x.node_id ?? ""), session_id: String(x.session_id),
    role: x.role === "assistant" ? "assistant" : "user",
    ts: x.ts ? new Date(x.ts as string).toISOString() : null,
    body: String(x.body ?? ""), owner: (x.owner as string | null) ?? null,
  }));
  const ok = await allowedInvites([...new Set(rows.filter((x) => x.owner !== input.requester).map((x) => x.session_id))], input.requester);
  rows = rows.filter((x) => x.owner === input.requester || ok.has(x.session_id));
  const ranked = rankConvSessions(rows, { q: input.q, sort: input.sort, nowMs: input.nowMs ?? Date.now(), requester: input.requester, limit: input.limit });
  return { results: await withSessionFaces(ranked), capped: r.rows.length >= CONV_ROW_CAP };
}

/**
 * 초대받은 세션(내가 주인이 아닌 것) 중 **목록·입장과 같은 판정**(sessionVisible, write-cap.ts)을 통과하는 대화 id — 초대를 받았어도
 *  그 세션의 프로젝트가 나에게 가려져 있으면(#1291) 안 보인다. 세션 화면엔 그 프로젝트의 대화가 그대로 흐르므로, 목록에서 감춘 세션을
 *  대화 검색이 내용으로 찾아 주면 감춤이 무의미하다. 판정 재료는 그 대화를 돌린 박스의 desired-state(dir · invites · project_id) —
 *  목록이 쓰는 바로 그 행이다. 가려진 프로젝트 조회가 실패하면 sessionVisible 이 초대받은 사람에게 닫는다(fail-closed).
 */
async function allowedInvites(convIds: string[], me: string): Promise<Set<string>> {
  const ok = new Set<string>();
  if (!convIds.length) return ok;
  let hidden: HiddenProjects | undefined;
  try { hidden = await hiddenProjects(me); } catch { hidden = undefined; }
  //  대화 → 그 대화를 돌린 박스(들)를 **집합으로** 먼저 펴고 박스 표에 붙인다. 조인 조건에 «id = 대화 OR id IN (하위 질의)» 를
  //   쓰면 Postgres 가 대화 × 박스 전부를 돌며 하위 질의를 다시 돈다 — 실측(박스 6천): 대화 41개에 12.9초 · 2천 개에 44초.
  const boxes = await itemsPool.query(
    `WITH x AS (SELECT DISTINCT unnest($1::text[]) AS conv),
          b AS (SELECT x.conv, x.conv AS box FROM x
                UNION SELECT x.conv, c.box_id FROM x JOIN org_session_conv c ON c.conv_uuid = x.conv)
     SELECT b.conv, st.owner, st.dir, st.invites, st.project_id
       FROM b JOIN org_session_state st ON st.id = b.box`, [convIds]);
  for (const b of boxes.rows as Array<{ conv: string; owner: string | null; dir: string | null; invites: unknown; project_id: number | null }>) {
    const invites = Array.isArray(b.invites) ? b.invites.map(String) : [];
    if (sessionVisible({ owner: b.owner, dir: b.dir, invites, projectId: b.project_id }, me, hidden)) ok.add(String(b.conv));
  }
  return ok;
}

/** 줄에 걸 이름 — 세션 목록(listSessionsForOwner)과 같은 규칙: 사람·에이전트가 지은 이름 → 첫 지시에서 지은 이름. */
async function withSessionFaces(hits: ConvSessionHit[]): Promise<ConvSearchResult[]> {
  if (!hits.length) return [];
  const nodes = hits.map((h) => h.node_id), ids = hits.map((h) => h.session_id);
  const r = await itemsPool.query(
    `SELECT v.node_id, v.session_id, s.title, nm.label
       FROM unnest($1::text[], $2::text[]) AS v(node_id, session_id)
       JOIN session s ON s.node_id = v.node_id AND s.session_id = v.session_id
       LEFT JOIN LATERAL (
         -- 사람·에이전트가 **지은** 이름이 있으면 그게 정본이다(withNamedLabels #2251 과 같은 규칙 · 같은 주인의 행만).
         SELECT st.label FROM org_session_state st
          WHERE st.claude_session_id = s.session_id AND st.owner = s.owner
            AND st.label_source IN ('human','agent') AND st.label IS NOT NULL AND btrim(st.label) <> ''
          LIMIT 1
       ) nm ON true`, [nodes, ids]);
  const face = new Map<string, Record<string, unknown>>(r.rows.map((x) => [String(x.node_id) + "\u0001" + String(x.session_id), x]));
  return hits.map((h) => {
    const f = face.get(h.node_id + "\u0001" + h.session_id) ?? {};
    const title = (f.title as string | null) ?? null;
    const label = typeof f.label === "string" && f.label.trim() ? f.label.trim() : "";
    return {
      node_id: h.node_id, session_id: h.session_id,
      name: label || sessionNameFromPrompt(String(title ?? "")) || null,
      title, hits: h.hits, at: h.at, best: h.best,
    };
  });
}
