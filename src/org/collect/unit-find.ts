// 검색 실패 보조 안내 · 단위 찾기(#4213 T12 #4744) — 조회. 판정(약한가 · 맞나 · 안내 문구)은 unit-find-plan.ts(순수).
//
//  ── 확정(상민님 2026-10-15 «검색 실패 트리거 결정» · «트리거 최종 확정») ──
//   · 순서: 지식 → 이미 모은 원문 자료 → 둘 다 없거나 약하면 질문한 사람이 볼 수 있는 단위 2~3개를 «가져올 곳» 으로(마지막 수집 시각과 함께).
//   · 세션이 그 사람 커넥터로 직접 찾을지는 세션이 판단한다(약한 권유) · 백그라운드 대기열은 없다.
//   · **응답에 싣는 단위는 질문한 사람이 다 보는 단위(unit-plan.unitAccess === "full")뿐이다** — 수집기 단위의 겉(coarse)이나
//     신고만 한 단위의 이름·설명이 남에게 새지 않게(설계 §6-3 필수 조건). 모으지 않기로 한 단위(excluded)는 권하지 않는다.
//
//  게이트웨이 MCP: knowledge_search 응답의 collect_hint(약할 때만) · 새 도구 collect_unit_find(주제 → 볼 수 있는 단위).
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import { embedQuery } from "../../v6/search-util.js";
import { toVectorLiteral } from "../../v6/embedding-provider.js";
import { sourceVisWhere } from "../../v6/source-store.js";
import { parseQueryTerms, termAltPatterns, termPatterns } from "../../v6/query-terms.js";
import type { Viewer } from "../../v6/visibility.js";
import { knowledgeSearchStrength } from "../../v6/knowledge-search.js";
import { unitAccess, type CollectRoute } from "./unit-plan.js";
import { connectorOfApp } from "./unit-store.js";
import {
  HINT_SOURCES, HINT_UNITS, knowledgeWeak, termsNeeded, textMatchScore, unitHaystack, unitHintText, unitMatch,
} from "./unit-find-plan.js";

/** «가져올 곳» 한 줄 — 질문한 사람이 다 보는 단위만. 설명은 짧게(400자). */
export interface UnitPointer {
  id: number; app: string; kind: string; name: string | null;
  /** 이 단위를 읽는 커넥터 이름(claude.ai «Slack» · «Gmail» …) — 세션은 mcp__claude_ai_<이름>__* 로 찾는다. */
  connector: string;
  /** lively_collector · liv_direct(라이블리가 모은다 — 조직 연결 ext__* 가 먼저) · member_ai(구성원 Claude 커넥터). */
  route: string;
  state: string;
  description: string | null;
  /** 마지막으로 이 단위를 읽은 시각 · 그 단위 마지막 글 시각 · 다음 수집 예정. */
  last_collected_at: string | null; last_item_at: string | null; next_at: string | null;
  /** 질문한 사람의 그 커넥터 상태(connected · needs-auth · failed …) — 기록이 없으면 null(모른다). */
  my_connector: string | null;
  match: { score: number; by: "vector" | "text" | "both" };
  hint: string;
}

interface UnitRowLite {
  id: number; app: string; kind: string; name: string | null; route: string; state: string; connector: string | null;
  description: string | null; meta: Record<string, unknown> | null;
  read_at: string | null; last_item_at: string | null; next_at: string | null;
  members: Array<{ member_id: string; verified: boolean; active: boolean }>;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

/** 이 사람에게 보일 수 있는 단위(수집기 경로이거나 이 사람이 후보인 단위) — collect_units 와 같은 첫 거름. 모으지 않기로 한 단위는 뺀다. */
async function loadCandidates(member: string): Promise<UnitRowLite[]> {
  const r = await itemsPool.query(
    `SELECT u.id, u.app, u.kind, u.name, u.route, u.state, u.connector, u.description, u.meta, u.read_at, u.last_item_at, u.next_at,
            COALESCE(json_agg(json_build_object('member_id', m.member_id, 'verified', m.verified_at IS NOT NULL,
                     'inactive', EXISTS (SELECT 1 FROM org_member om WHERE om.id = m.member_id AND om.state = 'inactive')))
                     FILTER (WHERE m.member_id IS NOT NULL), '[]') AS members
       FROM collect_unit u LEFT JOIN collect_unit_member m ON m.unit_id = u.id
      WHERE u.state <> 'excluded'
        AND (u.route IN ('lively_collector','liv_direct') OR EXISTS (SELECT 1 FROM collect_unit_member x WHERE x.unit_id = u.id AND x.member_id = $1))
      GROUP BY u.id
      LIMIT 5000`, [member]);
  return (r.rows as Array<Record<string, any>>).map((x) => ({
    id: Number(x.id), app: String(x.app), kind: String(x.kind), name: x.name ?? null, route: String(x.route), state: String(x.state),
    connector: x.connector ?? null, description: x.description ?? null,
    meta: x.meta && typeof x.meta === "object" && !Array.isArray(x.meta) ? x.meta : null,
    read_at: iso(x.read_at), last_item_at: iso(x.last_item_at), next_at: iso(x.next_at),
    members: (Array.isArray(x.members) ? x.members : []).map((m: Record<string, unknown>) => ({
      member_id: String(m.member_id), verified: m.verified === true, active: m.inactive !== true,
    })),
  }));
}

/** 질의 벡터와 단위 설명 벡터의 거리 — 임베딩이 꺼졌거나 못 물었거나 벡터 칸이 없으면 빈 표(낱말만으로 맞춘다). */
async function unitSims(query: string, ids: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  try {
    const qe = await embedQuery(query);
    if (!qe.vec) return out;
    const r = await itemsPool.query(
      `SELECT id, (1 - (embedding_vector <=> $1::vector))::float8 AS s FROM collect_unit WHERE id = ANY($2::int[]) AND embedding_vector IS NOT NULL`,
      [toVectorLiteral(qe.vec), [...ids]]);
    for (const x of r.rows as Array<{ id: number; s: number }>) out.set(Number(x.id), Number(x.s));
  } catch (e) {
    //  벡터 칸이 아직 없는 DB(임베딩 스키마 전) · 차원이 다른 질의 — 낱말만으로 맞춘다.
    logger.debug?.({ err: (e as Error)?.message }, "[unit-find] 단위 설명 벡터로 못 쟀다 — 낱말만으로 맞춘다");
  }
  return out;
}

/** 질문한 사람의 claude.ai 커넥터 상태(앱 이름 → 상태). 못 읽으면 빈 표. */
async function myConnectors(member: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const r = await itemsPool.query(`SELECT app, status FROM member_ai_connector WHERE member_id = $1 AND provider = 'claude'`, [member]);
    for (const x of r.rows as Array<{ app: string; status: string }>) out.set(String(x.app).toLowerCase(), String(x.status));
  } catch { /* 표가 없는 DB — 모른다 */ }
  return out;
}

/**
 * 단위 찾기 — 주제(질의)와 맞는, **이 사람이 다 보는** 단위를 맞음 점수 순으로. 맞는 것이 없으면 빈 목록이다(아무 단위나 권하지 않는다).
 *  같은 점수면 최근에 글이 올라온 단위 먼저.
 */
export async function findUnitsFor(actor: { member: string; isAdmin: boolean }, query: string, opts: { limit?: number; now?: number } = {}): Promise<UnitPointer[]> {
  const q = String(query ?? "").trim();
  if (!q || !actor.member) return [];
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 5), 1), 10);
  const now = opts.now ?? Date.now();
  const visible = (await loadCandidates(actor.member)).filter((u) => unitAccess(
    { route: u.route as CollectRoute, members: u.members.map((m) => ({ member_id: m.member_id, verified: m.verified, active: m.active })) },
    actor.member, actor.isAdmin) === "full");
  if (!visible.length) return [];
  const [sims, mine] = await Promise.all([unitSims(q, visible.map((u) => u.id)), myConnectors(actor.member)]);
  const scored = visible.map((u) => {
    const m = unitMatch(sims.get(u.id) ?? null, textMatchScore(q, unitHaystack(u), u.name));
    return { u, m };
  }).filter((x) => x.m.score > 0 && x.m.by);
  scored.sort((a, b) => b.m.score - a.m.score
    || (Date.parse(b.u.last_item_at ?? "") || 0) - (Date.parse(a.u.last_item_at ?? "") || 0) || a.u.id - b.u.id);
  return scored.slice(0, limit).map(({ u, m }) => {
    const connector = u.connector ?? connectorOfApp(u.app);
    return {
      id: u.id, app: u.app, kind: u.kind, name: u.name, connector, route: u.route, state: u.state,
      description: u.description ? u.description.slice(0, 400) : null,
      last_collected_at: u.read_at, last_item_at: u.last_item_at, next_at: u.next_at,
      my_connector: mine.get(connector.toLowerCase()) ?? null,
      match: { score: m.score, by: m.by! },
      hint: unitHintText(u, now),
    };
  });
}

/**
 * 원문 자료를 느슨하게 찾는다 — 질의의 (군말이 아닌) 낱말 가운데 **절반 이상**이 제목·본문에 든 자료를, 많이 든 것 · 최근 것 순으로.
 *  source_list 의 q 는 낱말이 **전부** 들어야 맞아서, 세션이 자연어로 묻는 질의(낱말 다섯)로는 거의 늘 0건이다 — 그래서 따로 센다.
 *  질문한 사람의 자료 공개범위 그대로(sourceVisWhere). 낱말 맞춤 규칙은 query-terms(조사를 뗀 꼴 · 같은 뜻 표기)와 같다.
 */
async function looseSources(q: string, viewer: Viewer | null, limit: number): Promise<NonNullable<CollectHint["sources"]>> {
  const all = parseQueryTerms(q);
  const terms = (all.some((t) => !t.optional) ? all.filter((t) => !t.optional) : all).slice(0, 8);
  if (!terms.length) return [];
  const params: unknown[] = [];
  const hits = terms.map((term) => {
    const pats = [...termPatterns(term), ...termAltPatterns(term)];
    const ors = pats.flatMap((pat) => { params.push(pat); return [`s.title ILIKE $${params.length} ESCAPE '\\'`, `s.body_md ILIKE $${params.length} ESCAPE '\\'`]; });
    return `(CASE WHEN ${ors.join(" OR ")} THEN 1 ELSE 0 END)`;
  });
  const vis = await sourceVisWhere(viewer ?? undefined, params);
  params.push(termsNeeded(terms.length)); const needP = `$${params.length}`;
  params.push(Math.min(Math.max(limit, 1), 10)); const limP = `$${params.length}`;
  const r = await itemsPool.query(
    `SELECT id, title, external_system, fields->>'container_name' AS container, occurred_at, score FROM (
       SELECT s.id, s.title, s.external_system, s.fields, s.occurred_at, s.updated_at, (${hits.join(" + ")}) AS score
         FROM source s WHERE s.lifecycle = 'active' AND ${vis}
     ) x WHERE score >= ${needP}
     ORDER BY score DESC, COALESCE(occurred_at, updated_at) DESC LIMIT ${limP}`, params);
  return (r.rows as Array<Record<string, unknown>>).map((x) => ({
    id: Number(x.id), title: (x.title as string | null) ?? null, system: (x.external_system as string | null) ?? null,
    container: (x.container as string | null) ?? null, occurred_at: iso(x.occurred_at ?? null),
  }));
}

/** knowledge_search 응답에 붙는 «가져올 곳» — 지식이 약할 때만. */
export interface CollectHint {
  reason: "empty" | "weak";
  /** 지식 결과의 세기 — 의미 거리 최고값(못 쟀으면 null) · 낱말이 다 든 지식이 있었나. */
  knowledge: { top_similarity: number | null; lexical: boolean };
  /** 아직 지식이 안 됐을 수 있는 원문 자료(낱말로 찾은 것) — source_get 으로 본다. */
  sources?: Array<{ id: number; title: string | null; system: string | null; container: string | null; occurred_at: string | null }>;
  /** 원문 자료에도 없을 때 — 질문한 사람이 다 보는 단위(마지막 수집 시각과 함께). */
  units?: UnitPointer[];
  note: string;
}

/**
 * 지식 검색 결과가 약하면 «가져올 곳» 을 만든다 — 약하지 않으면 null. **던지지 않는다**(검색 응답을 막지 않는다 — 못 만들면 null).
 *  · 원문 자료: 질의 낱말로 자료를 찾는다(source_list 의 q 와 같은 규칙 · 질문한 사람의 자료 공개범위 그대로).
 *  · 단위: 원문 자료도 없을 때만 — 그리고 이 워크스페이스가 구성원 Claude 커넥터를 허용할 때만(막았으면 «그 커넥터로 직접» 을 권하지 않는다).
 */
export async function collectHintFor(input: {
  q: string; names: readonly string[]; member: string | null; isAdmin: boolean; viewer: Viewer | null; now?: number;
}): Promise<CollectHint | null> {
  const q = String(input.q ?? "").trim();
  if (!q) return null;
  try {
    const strength = await knowledgeSearchStrength(q, input.names);
    const w = knowledgeWeak({ count: input.names.length, topSim: strength.topSim, lexical: strength.lexical });
    if (!w.weak || !w.reason) return null;
    const base = { reason: w.reason, knowledge: { top_similarity: strength.topSim == null ? null : Math.round(strength.topSim * 1000) / 1000, lexical: strength.lexical } };
    const found = await looseSources(q, input.viewer, HINT_SOURCES).catch((e) => {
      logger.warn({ err: (e as Error)?.message }, "[unit-find] 원문 자료를 못 찾아봤다 — 단위로 넘어간다");
      return [] as NonNullable<CollectHint["sources"]>;
    });
    if (found.length) {
      return { ...base, sources: found, note: "지식에는 맞는 것이 약합니다. 아직 지식이 안 된 원문 자료가 있습니다 — source_get 으로 먼저 보세요." };
    }
    if (!input.member) return { ...base, note: "지식·원문 자료 모두 맞는 것이 약합니다." };
    const { memberAiConnectorsPolicy } = await import("../store/member-ai-connectors.js");
    const allowed = (await memberAiConnectorsPolicy()) === "allowed";
    const units = allowed ? await findUnitsFor({ member: input.member, isAdmin: input.isAdmin }, q, { limit: HINT_UNITS, now: input.now }) : [];
    if (!units.length) return { ...base, note: "지식·원문 자료 모두 맞는 것이 약합니다." };
    return {
      ...base, units,
      note: "지식·원문 자료 모두 맞는 것이 약합니다. 아래는 이 주제가 오갈 만한 곳입니다(마지막 수집 이후의 새 글은 아직 없을 수 있습니다) — " +
        "필요하면 그 앱 커넥터(조직 연결 ext__* 가 있으면 그것, 없으면 mcp__claude_ai_<connector>__*)로 직접 한번 찾아보세요. 가져온 원문은 남깁니다.",
    };
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "[unit-find] 가져올 곳을 못 만들었다 — 검색 결과만 돌려준다");
    return null;
  }
}
