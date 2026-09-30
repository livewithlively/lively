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
//   파서 상태(codex 의 중복 가리기 등)도 커서에 싣는다 — 창을 넘어도 같은 결과가 나오게.
//
//  ── 지우기 ──
//   완전 삭제(purgeSessionLog)·보존기간 정리(reapSessionLogs)가 이 두 표도 함께 지운다(session-log-store.ts).
//   색인이 남으면 지운 대화가 검색으로 되살아난다.
import { itemsPool, withTx } from "../db/client.js";
import { readSessionLog } from "./session-log-store.js";
import { readAlignedWindow, prefetchReader, type ByteReader } from "../terminal/harness-io/window.js";
import { harnessIo } from "../terminal/harness-io/adapter.js";
import { parseJsonLines, type ChatLine, type ParseResult, type ParseState } from "../terminal/harness-io/chat-line.js";
import { extractConvMessages, rankConvSessions, type ConvMsg, type ConvRow, type ConvSessionHit, type ConvSort } from "./conv-search.js";
import { queryTerms } from "../terminal/terminal-transcript.js";
import { likeEscape } from "./search-util.js";
import { defaultWorkspaceId } from "../org/tenancy/registry.js";
import { sessionNameFromPrompt } from "../terminal/session-name.js";
import { currentTenant, withTenant } from "../org/tenant-context.js";

/** 한 번에 읽는 창. 한 줄이 이보다 길면(대개 거대한 도구 결과) 그 줄은 건너뛴다 — 사람 말·AI 말이 이만큼 긴 일은 없다. */
export const CONV_WINDOW = 8 * 1024 * 1024;
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

/** 창 하나를 커밋한다 — 커서가 from 에 있을 때만(CAS). 성공하면 true. */
async function commitWindow(nodeId: string, sessionId: string, from: number, to: number, msgs: ConvMsg[], state: ParseState): Promise<boolean> {
  return withTx(async (client) => {
    const u = await client.query(
      `UPDATE session_msg_cursor SET indexed_to = $4, state = $5::jsonb, updated_at = now()
        WHERE node_id = $1 AND session_id = $2 AND indexed_to = $3`,
      [nodeId, sessionId, from, to, JSON.stringify(state ?? {})]);
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

/** 이 세션의 색인을 처음부터 다시 — 커서가 기록보다 앞서 있으면(기록이 새로 시작됐다) 옛 색인은 다른 대화의 것이다. */
async function resetConvIndex(nodeId: string, sessionId: string): Promise<void> {
  await withTx(async (client) => {
    await client.query(`DELETE FROM session_msg WHERE node_id = $1 AND session_id = $2`, [nodeId, sessionId]);
    await client.query(`DELETE FROM session_msg_cursor WHERE node_id = $1 AND session_id = $2`, [nodeId, sessionId]);
  });
}

/**
 * 한 세션을 이어 색인한다 — maxBytes 만큼 읽고 멈춘다(다음 호출이 이어 간다).
 * 반환: 이번에 읽은 바이트 · 끝까지 따라잡았나. window 는 한 번에 읽는 창(시험이 «창보다 긴 한 줄» 을 싸게 만들려고 줄인다).
 */
export async function indexConvSession(nodeId: string, sessionId: string, maxBytes = 64 * 1024 * 1024, window = CONV_WINDOW): Promise<{ read: number; done: boolean }> {
  const head = await itemsPool.query(
    `SELECT l.bytes, s.harness, c.indexed_to, c.state
       FROM session_log l
       JOIN session s ON s.node_id = l.node_id AND s.session_id = l.session_id
       LEFT JOIN session_msg_cursor c ON c.node_id = l.node_id AND c.session_id = l.session_id
      WHERE l.node_id = $1 AND l.session_id = $2`, [nodeId, sessionId]);
  const row = head.rows[0] as { bytes: string | number; harness: string | null; indexed_to: string | number | null; state: ParseState | null } | undefined;
  if (!row) return { read: 0, done: true };
  const total = Number(row.bytes) || 0;
  let at = row.indexed_to == null ? 0 : Number(row.indexed_to);
  let state: ParseState = (row.state && typeof row.state === "object") ? row.state : {};
  if (at > total) { await resetConvIndex(nodeId, sessionId); at = 0; state = {}; }
  if (row.indexed_to == null || at === 0) {
    await itemsPool.query(`INSERT INTO session_msg_cursor(node_id, session_id) VALUES($1, $2) ON CONFLICT DO NOTHING`, [nodeId, sessionId]);
  }
  const parse = convParserFor(row.harness);
  if (!parse) {
    //  읽을 수 없는 하네스 — 글이 없다. 커서만 끝으로(다음 정비가 다시 집지 않게).
    if (at < total) await commitWindow(nodeId, sessionId, at, total, [], state);
    return { read: total - at, done: true };
  }
  let read = 0;
  while (at < total && read < maxBytes) {
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
      const skip = await nextLineStart(reader, total, end);      // 창보다 긴 한 줄 — 그 줄을 건너뛴다
      if (skip <= at) break;
      next = skip;
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
//  한 번에 SWEEP_MAX_BYTES 또는 SWEEP_MAX_MS 까지. 매니지드는 요청에 얹힌 정비표(outbox-request-sweep)가, 셀프호스트는
//   하우스키핑이 부른다. 같은 테넌트의 정비가 겹치면(앞 판이 아직 도는데 다음 판이 옴) 뒤 판은 그냥 돌아간다.
export const SWEEP_MAX_BYTES = 256 * 1024 * 1024;
export const SWEEP_MAX_MS = 8_000;
const sweeping = new Set<string>();
const tenantKey = (): string => currentTenant()?.id ?? "-";

/** 색인이 밀린 세션 — 서브에이전트·작업 상자 세션은 검색에서 빠지므로 색인도 하지 않는다. */
async function pendingSessions(limit: number): Promise<Array<{ node_id: string; session_id: string }>> {
  const r = await itemsPool.query(
    `SELECT l.node_id, l.session_id
       FROM session_log l
       JOIN session s ON s.node_id = l.node_id AND s.session_id = l.session_id
       LEFT JOIN session_msg_cursor c ON c.node_id = l.node_id AND c.session_id = l.session_id
      WHERE l.bytes > COALESCE(c.indexed_to, 0)
        AND s.parent_session_id IS NULL AND s.run_kind IS DISTINCT FROM 'task'
      ORDER BY l.updated_at DESC
      LIMIT $1`, [limit]);
  return r.rows as Array<{ node_id: string; session_id: string }>;
}

export async function sweepConvIndex(opts: { maxBytes?: number; maxMs?: number } = {}): Promise<{ sessions: number; read: number }> {
  const key = tenantKey();
  if (sweeping.has(key)) return { sessions: 0, read: 0 };
  sweeping.add(key);
  const t0 = Date.now();
  const maxBytes = opts.maxBytes ?? SWEEP_MAX_BYTES;
  const maxMs = opts.maxMs ?? SWEEP_MAX_MS;
  let read = 0, sessions = 0;
  try {
    for (const s of await pendingSessions(40)) {
      if (read >= maxBytes || Date.now() - t0 >= maxMs) break;
      try {
        const r = await indexConvSession(s.node_id, s.session_id, maxBytes - read);
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
//  세션 기록 append(POST /api/ui/v6/sessions/:id/log)가 부른다. 같은 세션의 연속 업로드는 한 번으로 모은다(2초).
//  ⚠ 테넌트 컨텍스트를 **붙잡아 둔다** — 타이머 콜백에서 그 워크스페이스의 표를 봐야 한다.
const DEBOUNCE_MS = 2_000;
const scheduled = new Map<string, ReturnType<typeof setTimeout>>();
export function scheduleConvIndex(nodeId: string, sessionId: string): void {
  const t = currentTenant();
  const key = `${t?.id ?? "-"}\u0001${nodeId}\u0001${sessionId}`;
  const prev = scheduled.get(key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    scheduled.delete(key);
    const run = (): Promise<unknown> => indexConvSession(nodeId, sessionId).catch((e) => {
      console.warn(`[conv-index] ${sessionId} 업로드 직후 색인 실패(비치명 — 주기 정비가 다시 집는다):`, (e as Error)?.message ?? e);
    });
    void (t ? withTenant(t, run) : run());
  }, DEBOUNCE_MS);
  timer.unref?.();
  scheduled.set(key, timer);
}

// ── 검색 ───────────────────────────────────────────────────────────────────────
/** 한 번에 모으는 메시지 상한 — 흔한 낱말(«the»)이면 여기서 잘린다. 잘렸는지는 응답의 capped 로 말한다. */
export const CONV_ROW_CAP = 3000;
/** 색인이 이만큼보다 밀린 세션을 «아직 색인 중» 으로 센다 — 도는 세션의 쓰는 중인 꼬리는 세지 않는다. */
export const PENDING_GAP_BYTES = 256 * 1024;

export interface ConvSearchInput {
  requester: string;
  q: string;
  sort: ConvSort;
  /** 이 시각(ISO) 이후의 말만 — 화면의 «기간». */
  since?: string | null;
  limit: number;
  /** 세션 목록과 같은 워크스페이스 격리(#1875) — listSessionsForOwner 와 같은 규칙. */
  workspaceId?: string | null;
  /** 세션 공유 view_policy — attach 면 초대받은 세션도 찾는다(대화록 열람 게이트와 같은 축). */
  attach: boolean;
  nowMs?: number;
}
export interface ConvSearchResult extends ConvSessionHit {
  name: string | null; title: string | null; owner_name: string | null;
  project_id: number | null; project_name: string | null; harness: string | null;
}

/** 볼 수 있는 세션 술어(별칭 s) — 대화록 열람 게이트(checkViewGate · sessionInvitesMember)와 같은 축: 주인 + 초대받은 사람. */
function visibleWhere(params: unknown[], input: Pick<ConvSearchInput, "requester" | "attach" | "workspaceId">): string {
  params.push(input.requester); const me = `$${params.length}`;
  params.push(!!input.attach); const att = `$${params.length}`;
  const wh = [
    `s.parent_session_id IS NULL`, `s.run_kind IS DISTINCT FROM 'task'`,
    `(s.owner = ${me} OR (${att}::boolean AND EXISTS (
        SELECT 1 FROM org_session_state st
         WHERE (st.id = s.session_id OR st.id IN (SELECT box_id FROM org_session_conv WHERE conv_uuid = s.session_id))
           AND st.invites @> to_jsonb(ARRAY[${me}::text]))))`,
  ];
  if (input.workspaceId) {
    params.push(input.workspaceId, defaultWorkspaceId(input.workspaceId));
    const cur = `$${params.length - 1}`, dflt = `$${params.length}`;
    wh.push(`COALESCE(
        (SELECT m.workspace_id::text FROM gw_session_map m
           LEFT JOIN gw_workspace w ON w.id = m.workspace_id
          WHERE m.session_id = s.session_id AND (w.id IS NULL OR w.state = 'active')),
        ${dflt}) = ${cur}`);
  }
  return wh.join(" AND ");
}

/** 볼 수 있는 세션 중 색인이 밀린 수 — 화면이 «아직 못 찾을 수 있다» 를 정직하게 말할 근거. */
export async function convIndexPending(input: Pick<ConvSearchInput, "requester" | "attach" | "workspaceId">): Promise<number> {
  const params: unknown[] = [];
  const vis = visibleWhere(params, input);
  params.push(PENDING_GAP_BYTES);
  const r = await itemsPool.query(
    `SELECT count(*)::int AS n
       FROM session s
       JOIN session_log l ON l.node_id = s.node_id AND l.session_id = s.session_id
       LEFT JOIN session_msg_cursor c ON c.node_id = s.node_id AND c.session_id = s.session_id
      WHERE l.bytes - COALESCE(c.indexed_to, 0) > $${params.length} AND ${vis}`, params);
  return Number(r.rows[0]?.n ?? 0);
}

export async function searchConversations(input: ConvSearchInput): Promise<{ results: ConvSearchResult[]; capped: boolean }> {
  const terms = queryTerms(input.q);
  if (!terms.length || !input.requester) return { results: [], capped: false };
  const params: unknown[] = [];
  const match = terms.map((t) => { params.push(`%${likeEscape(t)}%`); return `m.body ILIKE $${params.length} ESCAPE '\\'`; }).join(" AND ");
  const wh = [match];
  const sinceMs = input.since ? Date.parse(input.since) : NaN;
  if (Number.isFinite(sinceMs)) { params.push(new Date(sinceMs).toISOString()); wh.push(`m.ts >= $${params.length}::timestamptz`); }
  wh.push(visibleWhere(params, input));
  params.push(CONV_ROW_CAP);
  const r = await itemsPool.query(
    `SELECT m.node_id, m.session_id, m.role, m.ts, m.body, s.owner
       FROM session_msg m
       JOIN session s ON s.node_id = m.node_id AND s.session_id = m.session_id
       JOIN session_log l ON l.node_id = m.node_id AND l.session_id = m.session_id AND l.bytes > 0
      WHERE ${wh.join(" AND ")}
      ORDER BY m.ts DESC NULLS LAST
      LIMIT $${params.length}`, params);
  const rows: ConvRow[] = r.rows.map((x) => ({
    node_id: String(x.node_id ?? ""), session_id: String(x.session_id),
    role: x.role === "assistant" ? "assistant" : "user",
    ts: x.ts ? new Date(x.ts as string).toISOString() : null,
    body: String(x.body ?? ""), owner: (x.owner as string | null) ?? null,
  }));
  const ranked = rankConvSessions(rows, { q: input.q, sort: input.sort, nowMs: input.nowMs ?? Date.now(), requester: input.requester, limit: input.limit });
  return { results: await withSessionFaces(ranked), capped: r.rows.length >= CONV_ROW_CAP };
}

/** 줄에 걸 이름·프로젝트·주인 이름 — 세션 목록(listSessionsForOwner)과 같은 규칙으로 한 번의 조회로. */
async function withSessionFaces(hits: ConvSessionHit[]): Promise<ConvSearchResult[]> {
  if (!hits.length) return [];
  const nodes = hits.map((h) => h.node_id), ids = hits.map((h) => h.session_id);
  const r = await itemsPool.query(
    `SELECT v.node_id, v.session_id, s.title, s.harness, mb.display_name AS owner_name, proj.project_id, proj.project_name, nm.label
       FROM unnest($1::text[], $2::text[]) AS v(node_id, session_id)
       JOIN session s ON s.node_id = v.node_id AND s.session_id = v.session_id
       LEFT JOIN org_member mb ON mb.id = s.owner
       LEFT JOIN LATERAL (
         SELECT p.id AS project_id, p.name AS project_name
           FROM (SELECT sp.project_id FROM session_project sp
                  WHERE sp.session_id = s.session_id ORDER BY sp.valid_from DESC LIMIT 1) last
           JOIN project p ON p.id = last.project_id
       ) proj ON true
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
      ...h,
      title,
      name: label || sessionNameFromPrompt(String(title ?? "")) || null,
      owner_name: (f.owner_name as string | null) ?? null,
      project_id: f.project_id != null ? Number(f.project_id) : null,
      project_name: (f.project_name as string | null) ?? null,
      harness: (f.harness as string | null) ?? null,
    };
  });
}
