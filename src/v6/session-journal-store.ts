// 세션 이력 앱 «작업 일지» 저장 경로(#4553, 원준 2026-10-04) — 내 세션마다 «한 일» 과 «남긴 것» 을 한 번에 읽는다.
//
//  ── 왜 따로 있나 ──
//   세션 목록(listSessionsForOwner)은 이름·프로젝트·시각뿐이라 «그 세션에서 뭘 했나» 를 못 말한다. 세션이 남긴 것을 세는
//   sessionFootprint 는 **지울 범위**를 정하는 자(완전 삭제 확인창)라 세션 하나에 질의 여섯 번이고, 시간 창으로 «그때 주인이
//   만든 것» 까지 끌어온다 — 같은 때 도는 세션이 여럿이면 같은 지식이 여러 세션에 선다. 일지는 수십~수백 줄을 한 번에 그리므로
//   **세션이 스스로 남긴 연결**만 읽는다:
//    · 한 일 — 그 세션이 적은 작업 기록(activity.session_id = 박스 id). 어느 대화의 것인지는 session-journal.ts 가 정한다.
//    · 지식 — 그 작업 기록이 산출(produced)로 이은 지식(activity_knowledge).
//    · 태스크 — 그 박스가 맡은 태스크(execution_session.task_id · execution_session_task).
//    · 질문 수 · 고친 파일 수 — 대화 색인(session_msg)에서 센다.
//   질의는 줄 수와 무관하게 일곱 번이다(배열 한 번씩). 전부 한 연결에서 시간 상한(JOURNAL_QUERY_TIMEOUT_MS)을 걸고 돈다 —
//   대화 검색(conv-index-store boundedQuery)과 같은 까닭이다: 공유 풀을 오래 쥐지 않는다(#936). 넘으면 57014 → 라우트가 503.
//
//  ── 기간과 «한 일» ──
//   줄은 **마지막 활동이 그 기간에 든 세션**이고, 줄에 싣는 작업 기록은 **그 기간에 적은 것**이다. 지난주부터 이어진 세션의
//   지난주 기록을 이번 주 합계·요약에 섞지 않는다(격리 리뷰). 기간보다 앞서 적은 기록은 수(activities_before)로만 준다 —
//   화면이 «기록된 작업 없음» 이라고 틀리게 말하지 않게.
//
//  ── 누가 보나 ──
//   **세션 주인만**(owner = 요청자) — 일지는 «내가 한 일» 이다. 워크스페이스 격리는 세션 목록과 같은 한 벌(sessionWorkspaceWhere),
//   휴지통에 있는 세션은 뺀다(대화 uuid 표식 · 그 대화를 돌린 박스 id 표식 둘 다 — session-trash-ops resolveMine 과 같은 뜻).
//   지식은 지식의 공개범위(knowledgeVisWhere)를, 프로젝트·태스크는 가려진 프로젝트(hiddenProjects)를 다시 잰다 — 내 세션이 만든
//   것이어도 그 뒤에 잠겼으면 제목을 싣지 않는다.
import { withTx } from "../db/client.js";
import { convProjectIdSql, sessionWorkspaceWhere, withNamedLabels } from "./session-log-store.js";
import { assignActivities, clampJournalLimit, inJournalRange, JOURNAL_QUERY_TIMEOUT_MS, JOURNAL_ACTIVITY_MAX, type JournalBoxLink } from "./session-journal.js";
import { knowledgeVisWhere } from "./knowledge-common.js";
import { hiddenProjects } from "./visibility.js";
import { sessionNameFromPrompt } from "../terminal/session-name.js";

export interface JournalKnowledge { name: string; title: string | null }
export interface JournalActivity {
  id: number; type: string; title: string; summary: string | null;
  at: string | null;
  /** 커밋을 남긴 작업인가(commit_sha 유무 — 값은 싣지 않는다). */
  commit: boolean;
  knowledge: JournalKnowledge[];
}
export interface JournalTask { id: number; name: string; status: string | null; project_id: number | null }
export interface JournalRow {
  node_id: string; session_id: string;
  name: string | null; title: string | null; harness: string | null;
  first_seen: string; last_seen: string; bytes: number;
  project_id: number | null; project_name: string | null;
  /** 이 대화를 돌린 박스(가장 늦게 본 것) — 화면이 세션을 여는 id. 모르면 null. */
  box_id: string | null;
  /** 사람 말 수 · 고친 파일 수(대화 색인 기준 — 색인이 밀려 있으면 적게 나온다). */
  asks: number;
  edits: number;
  /** 이 기간에 적은 작업 기록(시각 순). 기간이 없으면(세션 하나만 물을 때) 전부. */
  activities: JournalActivity[];
  /** 기간보다 **앞서** 적은 작업 기록 수 — 지난 기간부터 이어진 세션. */
  activities_before: number;
  /** 이 세션의 (이 기간) 작업 기록이 산출로 이은 지식(겹치지 않게). */
  knowledge: JournalKnowledge[];
  tasks: JournalTask[];
}
export interface JournalInput {
  owner: string;
  workspaceId?: string | null;
  /** since ≤ 마지막 활동 < until (ISO). */
  since?: string | null;
  until?: string | null;
  limit?: number;
  /** 세션 하나만 — 기간·상한을 보지 않는다. */
  only?: { nodeId: string; sessionId: string } | null;
  /** 문장 하나의 시간 상한(기본 JOURNAL_QUERY_TIMEOUT_MS) — 시험이 줄여 «상한이 실제로 걸리는가» 를 잰다. */
  timeoutMs?: number;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isoOrNull = (v: unknown): string | null => {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

export async function sessionJournal(input: JournalInput): Promise<{ rows: JournalRow[]; truncated: boolean }> {
  if (!input.owner) return { rows: [], truncated: false };
  //  한 연결 · 문장마다 시간 상한. 읽기뿐이라 트랜잭션은 SET LOCAL 을 담는 그릇이다.
  return withTx(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(input.timeoutMs ?? JOURNAL_QUERY_TIMEOUT_MS))}`);
    return journalWith((sql, params) => client.query(sql, params as unknown[]) as unknown as ReturnType<Query>, input);
  });
}

async function journalWith(query: Query, input: JournalInput): Promise<{ rows: JournalRow[]; truncated: boolean }> {
  const want = clampJournalLimit(input.limit);

  // ① 내 세션 — 목록과 같은 조건(내용 있음 · 서브에이전트 아님 · 자동 실행 아님 · 이 워크스페이스) + 휴지통 제외.
  const params: unknown[] = [input.owner];
  //  ★ 휴지통은 **집합으로 한 번** 셈한다(WITH trashed) — 세션마다 «이 대화를 돌린 박스가 버려졌나» 를 하위 질의로 다시 재면
  //   세션 수 × 표식 수 × 대화 사슬 표 전체로 늘어난다(대화 검색 visibleSql 이 같은 자리에서 4초 상한에 걸렸던 그 모양, #4517).
  const trashedCte = `trashed AS (
       SELECT t.session_id AS sid FROM org_session_trash t WHERE t.owner = $1
       UNION SELECT c.conv_uuid FROM org_session_trash t JOIN org_session_conv c ON c.box_id = t.session_id WHERE t.owner = $1)`;
  const wh = [
    `s.owner = $1`, `l.bytes > 0`, `s.parent_session_id IS NULL`, `s.run_kind IS DISTINCT FROM 'task'`,
    `NOT EXISTS (SELECT 1 FROM trashed x WHERE x.sid = s.session_id)`,
  ];
  if (input.workspaceId) wh.push(sessionWorkspaceWhere(params, input.workspaceId));
  if (input.only) {
    params.push(input.only.nodeId, input.only.sessionId);
    wh.push(`s.node_id = $${params.length - 1}`, `s.session_id = $${params.length}`);
  } else {
    if (input.since) { params.push(input.since); wh.push(`s.last_seen >= $${params.length}::timestamptz`); }
    if (input.until) { params.push(input.until); wh.push(`s.last_seen < $${params.length}::timestamptz`); }
  }
  params.push(input.only ? 1 : want + 1); const limP = `$${params.length}`;
  const sr = await query(
    `WITH ${trashedCte}
     SELECT s.node_id, s.session_id, s.harness, s.title, s.first_seen, s.last_seen, COALESCE(l.bytes, 0)::bigint AS bytes,
            proj.project_id, proj.project_name
       FROM session s
       JOIN session_log l ON l.node_id = s.node_id AND l.session_id = s.session_id
       LEFT JOIN LATERAL (
         -- 기록 목록과 같은 한 벌(convProjectIdSql) — 같은 세션이 일지와 목록에서 다른 프로젝트 밑에 서지 않게.
         SELECT p.id AS project_id, p.name AS project_name
           FROM project p WHERE p.id = ${convProjectIdSql("$1")}
       ) proj ON true
      WHERE ${wh.join(" AND ")}
      ORDER BY s.last_seen DESC
      LIMIT ${limP}`, params);
  const truncated = !input.only && sr.rows.length > want;
  let hidden: Set<number>;
  //  가려진 프로젝트를 못 재면 프로젝트·태스크 이름을 싣지 않는다(fail-closed) — 세션 줄 자체는 내 것이라 그대로 선다.
  let hiddenKnown = true;
  try { hidden = (await hiddenProjects(input.owner)).ids; } catch { hidden = new Set(); hiddenKnown = false; }
  const projOk = (id: number | null): boolean => id != null && hiddenKnown && !hidden.has(id);

  let rows: JournalRow[] = sr.rows.slice(0, input.only ? 1 : want).map((x) => {
    const pid = x.project_id == null ? null : Number(x.project_id);
    return {
      node_id: String(x.node_id ?? ""), session_id: String(x.session_id),
      name: sessionNameFromPrompt(String(x.title ?? "")) || null, title: (x.title as string | null) ?? null,
      harness: (x.harness as string | null) ?? null,
      first_seen: iso(x.first_seen), last_seen: iso(x.last_seen), bytes: Number(x.bytes) || 0,
      project_id: projOk(pid) ? pid : null, project_name: projOk(pid) ? ((x.project_name as string | null) ?? null) : null,
      box_id: null, asks: 0, edits: 0, activities: [], activities_before: 0, knowledge: [], tasks: [],
    };
  });
  if (!rows.length) return { rows, truncated };
  rows = await withNamedLabels(rows, input.owner);
  const convIds = [...new Set(rows.map((r) => r.session_id))];
  const convSet = new Set(convIds);
  const byConv = new Map<string, JournalRow[]>();
  for (const r of rows) { const a = byConv.get(r.session_id) ?? []; a.push(r); byConv.set(r.session_id, a); }

  // ② 박스 ↔ 대화 — 이 대화들을 돌린 박스의 **모든** 대화(목록 밖 형제 대화까지: 그 대화의 기록을 형제에게 싣지 않으려면 알아야 한다)
  //    + 박스의 «지금 대화» 폴백(대화 사슬 표가 생기기 전 세션). owner 로 잠근다.
  const lr = await query(
    `SELECT c.box_id, c.conv_uuid, c.first_seen, c.last_seen
       FROM org_session_conv c
      WHERE c.owner = $1 AND c.box_id IN (SELECT c2.box_id FROM org_session_conv c2 WHERE c2.owner = $1 AND c2.conv_uuid = ANY($2::text[]))
     UNION ALL
     SELECT st.id, st.claude_session_id, NULL, st.last_seen
       FROM org_session_state st
      WHERE st.owner = $1 AND st.claude_session_id = ANY($2::text[])`, [input.owner, convIds]);
  const links: JournalBoxLink[] = [];
  const boxSeen = new Map<string, { box: string; at: number }>();   // 대화 → 가장 늦게 본 박스
  for (const x of lr.rows) {
    const box = String(x.box_id), conv = String(x.conv_uuid);
    links.push({ box_id: box, conv_uuid: conv, first_seen: isoOrNull(x.first_seen) });
    const at = x.last_seen ? new Date(x.last_seen as string).getTime() : 0;
    const cur = boxSeen.get(conv);
    if (!cur || at > cur.at) boxSeen.set(conv, { box, at });
  }
  for (const r of rows) r.box_id = boxSeen.get(r.session_id)?.box ?? null;
  const boxIds = [...new Set(links.map((l) => l.box_id))];

  // ③ 작업 기록 — 박스 id 로도, 대화 uuid 로도 적힐 수 있다. **늦은 것부터** 상한까지 읽는다 — 오래 산 박스에 기록이 많이
  //    쌓여도 잘리는 쪽은 옛 기록이다(이른 것부터 읽으면 새 기록이 잘리고 «가장 늦은 기록» 이 틀린다, 격리 리뷰).
  const ar = await query(
    `SELECT a.id, a.type, a.title, a.summary, a.session_id, a.commit_sha, a.created_at
       FROM activity a
      WHERE a.session_id = ANY($1::text[])
      ORDER BY a.created_at DESC NULLS LAST, a.id DESC
      LIMIT $2`, [[...boxIds, ...convIds], JOURNAL_ACTIVITY_MAX]);
  const acts = [...ar.rows].reverse();   // 시각 순(이른 것부터)
  const assigned = assignActivities(links, acts.map((x) => ({ id: Number(x.id), box: String(x.session_id), at: isoOrNull(x.created_at) })), convSet);
  const range = input.only ? { since: null, until: null } : { since: input.since ?? null, until: input.until ?? null };
  const actById = new Map<number, JournalActivity>();
  const actConv = new Map<number, string>();
  for (const x of acts) {
    const id = Number(x.id);
    const conv = assigned.get(id);
    if (!conv || !convSet.has(conv)) continue;   // 목록에 없는 대화의 기록 — 버린다
    const at = isoOrNull(x.created_at);
    const where = inJournalRange(at, range.since, range.until);
    if (where === "before") { for (const r of byConv.get(conv) ?? []) r.activities_before++; continue; }
    if (where === "after") continue;             // 이 기간 뒤에 적은 기록 — 그 기간의 일지에 선다
    actById.set(id, {
      id, type: String(x.type ?? "other"), title: String(x.title ?? ""), summary: (x.summary as string | null) ?? null,
      at, commit: !!x.commit_sha, knowledge: [],
    });
    actConv.set(id, conv);
  }

  // ④ 산출 지식 — 지식의 공개범위를 다시 잰다.
  if (actById.size) {
    const kp: unknown[] = [[...actById.keys()]];
    const vis = await knowledgeVisWhere(input.owner, kp);
    const kr = await query(
      `SELECT ak.activity_id, k.name, k.title
         FROM activity_knowledge ak
         JOIN knowledge k ON k.name = ak.name
        WHERE ak.activity_id = ANY($1::int[]) AND ak.relation = 'produced' AND ${vis}
        ORDER BY ak.activity_id, ak.id`, kp);
    for (const x of kr.rows) actById.get(Number(x.activity_id))?.knowledge.push({ name: String(x.name), title: (x.title as string | null) ?? null });
  }
  for (const [id, a] of actById) {
    for (const r of byConv.get(actConv.get(id)!) ?? []) {
      r.activities.push(a);
      for (const k of a.knowledge) if (!r.knowledge.some((y) => y.name === k.name)) r.knowledge.push(k);
    }
  }

  // ⑤ 맡은 태스크 — 박스의 «지금 태스크» + 순서 목록. 태스크가 속한 프로젝트가 가려져 있으면 뺀다.
  if (boxIds.length) {
    const tr = await query(
      `WITH tk AS (
         SELECT es.id AS box, es.task_id, 0 AS pos FROM execution_session es WHERE es.id = ANY($1::text[]) AND es.task_id IS NOT NULL
         UNION
         SELECT et.session_id, et.task_id, et.pos FROM execution_session_task et WHERE et.session_id = ANY($1::text[]))
       SELECT tk.box, min(tk.pos) AS pos, t.id, t.name, t.status,
              CASE WHEN t.level = 'subtask' THEN par.parent_id WHEN t.level = 'task' THEN t.parent_id ELSE t.id END AS project_id
         FROM tk
         JOIN project t ON t.id = tk.task_id
         LEFT JOIN project par ON par.id = t.parent_id
        GROUP BY tk.box, t.id, t.name, t.status, t.level, t.parent_id, par.parent_id
        ORDER BY tk.box, min(tk.pos), t.id`, [boxIds]);
    const convsOfBox = new Map<string, Set<string>>();
    for (const l of links) { const s = convsOfBox.get(l.box_id) ?? new Set<string>(); s.add(l.conv_uuid); convsOfBox.set(l.box_id, s); }
    for (const x of tr.rows) {
      const pid = x.project_id == null ? null : Number(x.project_id);
      if (pid != null && !projOk(pid)) continue;
      const task: JournalTask = { id: Number(x.id), name: String(x.name ?? ""), status: (x.status as string | null) ?? null, project_id: pid };
      for (const conv of convsOfBox.get(String(x.box)) ?? []) {
        for (const r of byConv.get(conv) ?? []) if (!r.tasks.some((y) => y.id === task.id)) r.tasks.push(task);
      }
    }
  }

  // ⑥ 질문 수 · 고친 파일 수 — 대화 색인에서.
  const cr = await query(
    `SELECT m.node_id, m.session_id,
            count(*) FILTER (WHERE m.role = 'user')::int AS asks,
            count(DISTINCT m.body) FILTER (WHERE m.role = 'edit')::int AS edits
       FROM unnest($1::text[], $2::text[]) AS v(node_id, session_id)
       JOIN session_msg m ON m.node_id = v.node_id AND m.session_id = v.session_id
      WHERE m.role IN ('user', 'edit')
      GROUP BY m.node_id, m.session_id`, [rows.map((r) => r.node_id), rows.map((r) => r.session_id)]);
  const counts = new Map<string, { asks: number; edits: number }>();
  for (const x of cr.rows) counts.set(String(x.node_id ?? "") + "\u0001" + String(x.session_id), { asks: Number(x.asks) || 0, edits: Number(x.edits) || 0 });
  for (const r of rows) {
    const c = counts.get(r.node_id + "\u0001" + r.session_id);
    if (c) { r.asks = c.asks; r.edits = c.edits; }
  }
  return { rows, truncated };
}
