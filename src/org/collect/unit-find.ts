// 검색 실패 보조 안내 · 단위 찾기(#4213 T12 #4744) — 조회. 판정(약한가 · 맞나 · 안내 문구)은 unit-find-plan.ts(순수).
//
//  ── 확정(상민님 2026-10-15 «검색 실패 트리거 결정» · «트리거 최종 확정») ──
//   · 순서: 지식 → 이미 모은 원문 자료 → 둘 다 없거나 약하면 질문한 사람이 볼 수 있는 단위 2~3개를 «가져올 곳» 으로(마지막 수집 시각과 함께).
//   · 세션이 그 사람 커넥터로 직접 찾을지는 세션이 판단한다(약한 권유) · 백그라운드 대기열은 없다.
//   · **응답에 싣는 단위는 질문한 사람이 그 단위의 확인된 구성원인 것뿐이다**(그 사람의 커넥터로 실제로 읽은 것이 확인된 곳) — 수집기 단위의
//     겉(coarse)이나 신고만 한 단위의 이름·설명이 남에게 새지 않게(설계 §6-3 필수 조건). 관리자라고 해서 자기가 속하지 않은 비공개 채널을
//     안내받지 않는다(principal v2 — AI 자동 안내가 잠긴 이름을 되뱉지 않게 · 리뷰 2026-10-17, 다온 판단 — 상민님 확인 전).
//     모으지 않기로 한 단위(excluded)는 권하지 않는다.
//   · 원문 자료도 **질문한 사람 자신의** 자료 공개범위로만 찾는다(특권 열람 신원으로 찾지 않는다).
//
//  게이트웨이 MCP: knowledge_search 응답의 collect_hint(약할 때만) · 새 도구 collect_unit_find(주제 → 볼 수 있는 단위).
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import { activeEmbeddingProvider, embedQuery } from "../../v6/search-util.js";
import { toVectorLiteral } from "../../v6/embedding-provider.js";
import { sourceVisWhere } from "../../v6/source-store.js";
import { parseQueryTerms, termAltPatterns, termPatterns } from "../../v6/query-terms.js";
import { knowledgeSearchStrength } from "../../v6/knowledge-search.js";
import { connectorOfApp } from "./unit-store.js";
import {
  HINT_SOURCES, HINT_UNITS, cleanQuery, knowledgeTermsNeeded, knowledgeWeak, termsNeeded, textMatchScore, unitHaystack, unitHintText, unitMatch,
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
  visibility: string; owner_member: string | null;
}

/** 후보 단위 상한 — 확인된 구성원인 단위만 싣는다(보통 수십~수백). 넘으면 최근에 글이 올라온 단위부터. */
const CANDIDATE_UNITS_MAX = 2000;
/** 원문 자료를 느슨하게 찾을 때 보는 자료 수(아직 지식이 안 된 것 가운데 최근에 들어온 것부터) · 본문 앞 글자 수 · 문장 시간 상한(ms). */
const LOOSE_SCAN_ROWS = 3000;
const LOOSE_BODY_CHARS = 4000;
const LOOSE_TIMEOUT_MS = 1200;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

/**
 * 이 사람이 **확인된 구성원**인 단위(그 사람이 비활성이 아니고) — 모으지 않기로 한 단위는 뺀다. 접근 판정을 SQL 에서 해 구성원 목록을
 *  통째로 싣지 않는다(리뷰 2026-10-17 — 수집기 단위 수천 개·구성원 수십만 줄을 JS 로 거르던 것).
 */
async function loadCandidates(member: string): Promise<UnitRowLite[]> {
  const r = await itemsPool.query(
    `SELECT u.id, u.app, u.kind, u.name, u.route, u.state, u.connector, u.description, u.meta, u.read_at, u.last_item_at, u.next_at,
            u.visibility, u.owner_member
       FROM collect_unit u
      WHERE u.state <> 'excluded'
        AND EXISTS (SELECT 1 FROM collect_unit_member m WHERE m.unit_id = u.id AND m.member_id = $1 AND m.verified_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM org_member om WHERE om.id = $1 AND om.state = 'inactive')
      ORDER BY u.last_item_at DESC NULLS LAST, u.id
      LIMIT $2`, [member, CANDIDATE_UNITS_MAX]);
  return (r.rows as Array<Record<string, any>>).map((x) => ({
    id: Number(x.id), app: String(x.app), kind: String(x.kind), name: x.name ?? null, route: String(x.route), state: String(x.state),
    connector: x.connector ?? null, description: x.description ?? null,
    meta: x.meta && typeof x.meta === "object" && !Array.isArray(x.meta) ? x.meta : null,
    read_at: iso(x.read_at), last_item_at: iso(x.last_item_at), next_at: iso(x.next_at),
    visibility: String(x.visibility ?? "viewers"), owner_member: x.owner_member ?? null,
  }));
}

/** 질의 벡터와 단위 설명 벡터의 거리 — 임베딩이 꺼졌거나 못 물었거나 벡터 칸이 없으면 빈 표(낱말만으로 맞춘다). */
async function unitSims(query: string, ids: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  try {
    const qe = await embedQuery(query);
    if (!qe.vec) return out;
    //  지금 모델로 만든 벡터끼리만 잰다(모델을 바꿨는데 옛 벡터가 남았으면 그 단위는 낱말로만 맞춘다).
    const model = (await activeEmbeddingProvider())?.model ?? null;
    const r = await itemsPool.query(
      `SELECT id, (1 - (embedding_vector <=> $1::vector))::float8 AS s FROM collect_unit
        WHERE id = ANY($2::int[]) AND embedding_vector IS NOT NULL AND ($3::text IS NULL OR embedding_model = $3)`,
      [toVectorLiteral(qe.vec), [...ids], model]);
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
export async function findUnitsFor(actor: { member: string; isAdmin: boolean }, query: string,
  opts: { limit?: number; now?: number; blocked?: boolean } = {}): Promise<UnitPointer[]> {
  const q = cleanQuery(query);
  if (!q || !actor.member) return [];
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 5), 1), 10);
  const now = opts.now ?? Date.now();
  const visible = await loadCandidates(actor.member);
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
      hint: unitHintText({ ...u, mineHidden: u.visibility === "me" && u.owner_member !== actor.member, blocked: !!opts.blocked }, now),
    };
  });
}

/**
 * 원문 자료를 느슨하게 찾는다 — 질의의 (군말·한 글자가 아닌) 낱말 가운데 **절반 이상**이 제목·본문 앞부분에 든 자료를, 많이 든 것 · 최근 것 순으로.
 *  source_list 의 q 는 낱말이 **전부** 들어야 맞아서, 세션이 자연어로 묻는 질의(낱말 다섯)로는 거의 늘 0건이다 — 그래서 따로 센다.
 *  · **아직 지식이 안 된 자료만**(지식의 근거로 묶인 자료는 지식 검색이 이미 봤다 — 안내 문구 «아직 지식이 안 된» 과 같다).
 *  · 그 가운데 **최근에 들어온**(id 역순) LOOSE_SCAN_ROWS 건만 — 먼저 id 만 그만큼 고르고(기본키를 거꾸로 읽다 멈춘다 · 넓은 행을 정렬하지
 *    않는다) 그 행에서만 본문 앞 LOOSE_BODY_CHARS 자를 풀어 소문자로 한 번 바꾼다. 문장 시간 상한(SET LOCAL statement_timeout).
 *    — 리뷰 2026-10-17 실측: 시각 순으로 자르면 본문을 다 푼 뒤에 정렬해(디스크 정렬) 30,000건에서 0.5~19초였다. 고친 뒤 같은 규모 합성
 *      자료(본문 20% 8,000자 · 30% 지식이 됨)에서 0.29~0.52초(디스크 정렬 약 92MB) → 0.036초(디스크 정렬 없음).
 *      id 역순은 «들어온 순서» 라 옛 날짜로 한꺼번에 옮겨 온 자료도 창에 든다.
 *  · 질문한 사람 자신의 자료 공개범위(sourceVisWhere — viewer 는 늘 그 사람이다).
 *  · deadline(ms 시각)이 지났으면 연결을 잡은 뒤 묻지 않고 던진다(풀이 찼을 때 연결을 기다리다 상한을 넘긴 경우).
 */
async function looseSources(q: string, viewer: string, limit: number, deadline?: number): Promise<NonNullable<CollectHint["sources"]>> {
  const all = parseQueryTerms(q);
  const base = all.some((t) => !t.optional) ? all.filter((t) => !t.optional) : all;
  //  한 글자 낱말은 세지 않는다(단위 맞춤 textMatchScore 와 같은 규칙) — «것»·«때» 같은 낱말이 아무 자료나 맞게 하지 않게.
  const terms = base.filter((t) => t.quoted || [...t.stem].length >= 2).slice(0, 8);
  if (!terms.length) return [];
  const params: unknown[] = [];
  const hits = terms.map((term) => {
    const pats = [...termPatterns(term), ...termAltPatterns(term)].map((pat) => pat.toLowerCase());
    const ors = pats.map((pat) => { params.push(pat); return `x.hay LIKE $${params.length} ESCAPE '\\'`; });
    return `(CASE WHEN ${ors.join(" OR ")} THEN 1 ELSE 0 END)`;
  });
  const vis = await sourceVisWhere(viewer, params);
  params.push(termsNeeded(terms.length)); const needP = `$${params.length}`;
  params.push(Math.min(Math.max(limit, 1), 10)); const limP = `$${params.length}`;
  params.push(LOOSE_SCAN_ROWS); const scanP = `$${params.length}`;
  params.push(LOOSE_BODY_CHARS); const bodyP = `$${params.length}`;
  const sql =
    //  두 CTE 를 MATERIALIZED 로 막는다 — 막지 않으면 플래너가 낱말 맞춤(hay LIKE)을 source 전체 훑기의 필터로 내려 본문을 다 푼다
    //   (2026-10-17 실측: 30,000건에서 1.3초). w = id 만 3,000건(기본키 역순으로 읽다 멈춘다) · x = 그 행에서만 본문을 푼다.
    `WITH w AS MATERIALIZED (
       SELECT s.id FROM source s
        WHERE s.lifecycle = 'active' AND ${vis}
          AND NOT EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id)
        ORDER BY s.id DESC
        LIMIT ${scanP}
     ), x AS MATERIALIZED (
       SELECT s.id, s.title, s.external_system, s.fields->>'container_name' AS container, s.occurred_at,
              COALESCE(s.occurred_at, s.updated_at) AS at,
              lower(COALESCE(s.title, '') || ' ' || left(COALESCE(s.body_md, ''), ${bodyP}::int)) AS hay
         FROM source s WHERE s.id IN (SELECT id FROM w)
     )
     SELECT id, title, external_system, container, occurred_at FROM (
       SELECT x.id, x.title, x.external_system, x.container, x.occurred_at, x.at, (${hits.join(" + ")}) AS score FROM x
     ) y WHERE score >= ${needP}
     ORDER BY score DESC, at DESC NULLS LAST, id DESC LIMIT ${limP}`;
  const client = await itemsPool.connect();
  if (deadline != null && Date.now() > deadline) { client.release(); throw new Error("hint deadline passed"); }
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${LOOSE_TIMEOUT_MS}`);
    //  짧은 쿼리라 JIT 컴파일(수백 ms)이 득이 안 된다 — 추정 비용이 문턱을 넘어 JIT 가 켜지는 일을 막는다.
    await client.query("SET LOCAL jit = off");
    const r = await client.query(sql, params);
    await client.query("COMMIT");
    return (r.rows as Array<Record<string, unknown>>).map((x) => ({
      id: Number(x.id), title: (x.title as string | null) ?? null, system: (x.external_system as string | null) ?? null,
      container: (x.container as string | null) ?? null, occurred_at: iso(x.occurred_at ?? null),
    }));
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** 같은 경고를 1분에 한 번만 warn 으로(나머지는 debug) — 원문 자료 찾기가 상한에 자주 걸리는 워크스페이스에서 로그가 넘치지 않게. */
let lastWarnAt = 0;
function warnSometimes(msg: string, e: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt >= 60_000) { lastWarnAt = now; logger.warn({ err: (e as Error)?.message }, msg); }
  else logger.debug?.({ err: (e as Error)?.message }, msg);
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
  /** 원문 자료를 이번에 못 찾아봤다(시간 상한 · 오류) — 있으면 false. 이때 note 는 «원문 자료에 없다» 고 하지 않는다. */
  sources_checked?: false;
  note: string;
}

/**
 * 지식 검색 결과가 약하면 «가져올 곳» 을 만든다 — 약하지 않으면 null. **던지지 않는다**(검색 응답을 막지 않는다 — 못 만들면 null).
 *  · 원문 자료: 질의 낱말로 자료를 찾는다(source_list 의 q 와 같은 규칙 · 질문한 사람의 자료 공개범위 그대로).
 *  · 단위: 원문 자료도 없을 때만 — 그리고 이 워크스페이스가 구성원 Claude 커넥터를 허용할 때만(막았으면 «그 커넥터로 직접» 을 권하지 않는다).
 */
export async function collectHintFor(input: {
  q: string; names: readonly string[]; member: string | null; isAdmin: boolean; now?: number;
  /** 이 시각(ms)이 지나면 더 묻지 않는다 — 부르는 쪽(knowledge_search)이 기다리는 상한. 지나서 끝난 일은 버려지므로 미리 멈춘다. */
  deadline?: number;
}): Promise<CollectHint | null> {
  const q = cleanQuery(input.q);
  const late = () => input.deadline != null && Date.now() > input.deadline;
  //  안내는 질문한 사람의 것이다 — 사람이 없으면(내부 호출) 만들지 않는다. 자료·단위 모두 그 사람 자신의 공개범위로만 찾는다.
  if (!q || !input.member) return null;
  try {
    const strength = await knowledgeSearchStrength(q, input.names, knowledgeTermsNeeded);
    const w = knowledgeWeak({ count: input.names.length, topSim: strength.topSim, lexical: strength.lexical });
    if (!w.weak || !w.reason) return null;
    const base = { reason: w.reason, knowledge: { top_similarity: strength.topSim == null ? null : Math.round(strength.topSim * 1000) / 1000, lexical: strength.lexical } };
    if (late()) return null;
    let checked = true;
    const found = await looseSources(q, input.member, HINT_SOURCES, input.deadline).catch((e) => {
      checked = false;
      warnSometimes("[unit-find] 원문 자료를 못 찾아봤다(시간 상한 · 오류) — 단위로 넘어간다", e);
      return [] as NonNullable<CollectHint["sources"]>;
    });
    if (late()) return null;
    //  «약하다» 는 «질문의 낱말이 다 든 지식이 없다» 는 뜻이다(의미 거리로는 가를 수 없다 — WEAK_TOP_SIM 머리말). 결과가 맞을 수도 있으니
    //   단정하지 않는다 — «결과가 모자라면» 으로 권한다.
    const empty = w.reason === "empty";
    if (found.length) {
      return {
        ...base, sources: found,
        note: empty ? "지식에 맞는 것이 없습니다. 아직 지식이 안 된 원문 자료부터 보세요(source_get)."
          : "지식 결과에 질문의 낱말이 다 든 것이 없습니다. 결과가 모자라면 아직 지식이 안 된 원문 자료부터 보세요(source_get).",
      };
    }
    const { memberAiConnectorsPolicy } = await import("../store/member-ai-connectors.js");
    const allowed = (await memberAiConnectorsPolicy()) === "allowed";
    const units = allowed ? await findUnitsFor({ member: input.member, isAdmin: input.isAdmin }, q, { limit: HINT_UNITS, now: input.now }) : [];
    //  원문 자료를 못 찾아봤으면(시간 상한 · 오류) «원문 자료에도 없다» 고 하지 않는다 — source_list 로 직접 찾을 수 있다고 알린다.
    const head = checked
      ? (empty ? "지식·원문 자료에 맞는 것이 없습니다." : "지식 결과에 질문의 낱말이 다 든 것이 없고, 원문 자료에도 맞는 것이 없습니다.")
      : (empty ? "지식에 맞는 것이 없습니다(원문 자료는 이번에 찾아보지 못했습니다 — source_list 로 직접 찾을 수 있습니다)."
        : "지식 결과에 질문의 낱말이 다 든 것이 없습니다(원문 자료는 이번에 찾아보지 못했습니다 — source_list 로 직접 찾을 수 있습니다).");
    const extra = checked ? {} : { sources_checked: false as const };
    if (!units.length) return { ...base, ...extra, note: head };
    return {
      ...base, ...extra, units,
      note: `${head} ${empty ? "" : "결과가 모자라면 "}아래는 이 주제가 오갈 만한 곳입니다(마지막 수집 이후의 새 글은 아직 없을 수 있습니다) — ` +
        "필요하면 그 앱 커넥터(조직 연결 ext__* 가 있으면 그것, 없으면 mcp__claude_ai_<connector>__*)로 직접 한번 찾아보세요. 가져온 원문은 남깁니다.",
    };
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "[unit-find] 가져올 곳을 못 만들었다 — 검색 결과만 돌려준다");
    return null;
  }
}
