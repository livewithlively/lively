// v6 source(자료) 데이터 접근 — #290. raw 입력(이메일·슬랙·회의 전사록/minutes·외부 미러)의 집.
//  ★지식(knowledge)과 별도 테이블 = recall(knowledge_search)이 자료를 자동 미포함(읽기경로 무수정).
//  증류물(지식)은 knowledge_source(knowledge-store.ts)로 인용 — 카파시 source→wiki citation 모델.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { auditOrgContent, type WriteCtx } from "./content-audit.js";
import { effectiveViewer, type Viewer } from "./visibility.js";
import { axisOn } from "./visibility-axes.js";
import { knowledgeVisWhere } from "./knowledge-store.js";

// 자료 1건의 가시성 술어(#1291) — 's' 별칭 기준. 지식(knowledgeVisSql)과 같은 모양이되 **컨테이너 참조 grant 가 없다**:
//  자료는 프로젝트가 아니라 외부 원본(슬랙·노션·전사록)에서 들어오므로 리스트에 매달 자연스러운 좌표가 없다.
//  → 대상 지정은 멤버·팀 직접 grant(source_member)뿐. 기본값은 'open' 이라 아무도 안 잠근 조직에선 항상 통과한다.
export const sourceVisSql = (p: number) => `(s.visibility IS DISTINCT FROM 'members'
  OR EXISTS(SELECT 1 FROM source_member sm WHERE sm.source_id=s.id
             AND ((sm.subject_kind='member' AND sm.member_id=$${p})
               OR (sm.subject_kind='team' AND EXISTS(SELECT 1 FROM team_member tm
                     WHERE tm.team_id::text=sm.member_id AND tm.member_id=$${p})))))`;

/** 이 뷰어로 자료를 필터해야 하나 — 필터가 필요 없으면 null(축 꺼짐·특권·긴급열람 전체 스코프).
 *  자기 Params 를 쓰는 쿼리 빌더(증류 인박스)가 **동기로** 술어를 끼워 넣을 수 있게 판정만 분리한 것이다. */
export async function resolveSourceViewer(viewer: Viewer | undefined): Promise<string | null> {
  if (!(await axisOn("source"))) return null;
  if (viewer === undefined) return null;
  return await effectiveViewer(viewer);
}

/** 자료 읽기 쿼리에 이어붙일 술어. 규약은 knowledgeVisWhere 와 동일(undefined=미배선·null=특권·"TRUE" 반환 가능). */
export async function sourceVisWhere(viewer: Viewer | undefined, params: unknown[]): Promise<string> {
  if (!(await axisOn("source"))) return "TRUE";   // 축 꺼짐(#1291) — 자료는 종전처럼 전원 공개
  if (viewer === undefined) return "TRUE";
  const eff = await effectiveViewer(viewer);
  if (eff === null) return "TRUE";
  params.push(eff);
  return sourceVisSql(params.length);
}

/** 자료 1건이 이 뷰어에게 보이나 — 스토어 밖(원본 페치·쓰기 게이트)에서 쓰는 단건 판정. */
export async function canSeeSource(id: number, viewer: Viewer): Promise<boolean> {
  if (viewer === null) return true;
  const params: unknown[] = [id];
  const vis = await sourceVisWhere(viewer, params);
  const row = await one(itemsPool, `SELECT (${vis}) AS ok FROM source s WHERE s.id=$1`, params);
  if (!row) return true;                     // 없는 자료 — 존재 판정은 호출부(404)의 몫
  return !!(row as { ok?: boolean }).ok;
}

const S_COLS =
  `id, name, kind, title, body_md, provenance, external_system, external_instance, external_id, external_url,
   occurred_at, last_synced_at, author, lifecycle, created_at, updated_at, updated_by, fields, parent_external_id, visibility`;
const S_SEL = S_COLS.split(",").map((c) => "s." + c.trim()).join(", ");
// 목록/그래프용 얕은 컬럼(본문 제외 — 자료는 28k+ 전사록이라 목록에 전문 싣지 않는다). parent_external_id=스레드/계층 관계(#735).
//  has_knowledge(#2423): 이 자료로 지식이 만들어졌나 — 목록의 민트 점 하나가 읽는 값. 건수가 아니라 유무다
//  (목록에서 필요한 건 «됐나/안 됐나» 뿐이고, 몇 건인지는 상세가 말한다).
export const S_LIST_SEL = `s.id, s.name, s.kind, s.title, s.provenance, s.external_system, s.external_url, s.occurred_at, s.updated_at, s.fields, s.parent_external_id, s.visibility,
   EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id) AS has_knowledge`;

export interface SourceRow {
  id: number; name: string | null; kind: string; title: string | null; body_md: string;
  provenance: string; lifecycle: string; created_at: string; updated_at: string;
  [k: string]: unknown;
}

const auditSource = (key: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("source", key, op, before, after, ctx);

export interface SourceFilter {
  kind?: string; provenance?: string; q?: string; limit?: number; offset?: number;
  /** 출처 축(#2423 자료 앱) — 자료 목록을 «어디서 왔나» 로 좁힌다. */
  system?: string;      // external_system('slack'·'github'·'local'…). 'authored'=사람이 직접 적어 둔 것(external_system IS NULL)
  container?: string;   // 채널·폴더·저장소(fields->>'container_name') — 표현식 인덱스가 이미 있다
  author?: string;      // 작성자·올린 사람(fields->>'author_name')
  linked?: boolean;     // true=지식이 붙은 것만 / false=아직 안 붙은 것만
}

// listSources / countSources 공유 필터 — WHERE·params 를 한 곳에서(목록·총계가 항상 같은 조건).
function sourceListFilter(f: SourceFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const wh: string[] = [`s.lifecycle='active'`];
  if (f.kind) { params.push(f.kind); wh.push(`s.kind=$${params.length}`); }
  if (f.provenance) { params.push(f.provenance); wh.push(`s.provenance=$${params.length}`); }
  if (f.q) { params.push(`%${f.q}%`); wh.push(`(s.title ILIKE $${params.length} OR s.body_md ILIKE $${params.length})`); }
  //  '적어 둔 것'(전사록·회의록)은 커넥터가 아니라 사람·세션이 넣은 것이라 external_system 이 비어 있다.
  //   그 갈래도 나무의 한 가지이므로 예약어 하나로 고른다(빈 문자열은 필터 없음과 구분되지 않아 쓰지 않는다).
  if (f.system === "authored") wh.push(`s.external_system IS NULL`);
  else if (f.system) { params.push(f.system); wh.push(`s.external_system=$${params.length}`); }
  if (f.container) { params.push(f.container); wh.push(`s.fields->>'container_name'=$${params.length}`); }
  if (f.author) { params.push(f.author); wh.push(`s.fields->>'author_name'=$${params.length}`); }
  if (f.linked !== undefined) {
    wh.push(`${f.linked ? "" : "NOT "}EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id=s.id)`);
  }
  return { where: wh.join(" AND "), params };
}

// 목록 — kind/provenance/q(title·body ILIKE) 필터. 최신 발생/수정순. 본문 미포함(얕게). #709 limit·offset 페이지네이션.
export async function listSources(f: SourceFilter = {}, viewer?: Viewer): Promise<Record<string, unknown>[]> {
  const { where, params } = sourceListFilter(f);
  const vis = await sourceVisWhere(viewer, params);   // 공개범위(#1291) — 페이지 파라미터 앞에 넣는다
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const offset = Math.min(Math.max(Number(f.offset) || 0, 0), 1_000_000);
  params.push(limit); const limP = `$${params.length}`;
  params.push(offset); const offP = `$${params.length}`;
  return q(itemsPool,
    `SELECT ${S_LIST_SEL} FROM source s WHERE ${where} AND ${vis}
     ORDER BY COALESCE(s.occurred_at, s.updated_at) DESC LIMIT ${limP} OFFSET ${offP}`, params);
}

// #709 총계 — 같은 필터의 전체 자료 건수(페이징 메타 total/has_more 용). 목록과 같은 뷰어로 센다(has_more 정합).
export async function countSources(f: SourceFilter = {}, viewer?: Viewer): Promise<number> {
  const { where, params } = sourceListFilter(f);
  const vis = await sourceVisWhere(viewer, params);
  const row = await one(itemsPool, `SELECT count(*)::int AS n FROM source s WHERE ${where} AND ${vis}`, params);
  return Number((row as { n?: number } | undefined)?.n ?? 0);
}

// ── 출처 나무(#2423 자료 앱) — «어디서 왔나» 로 자료를 접는 집계. 화면 왼쪽 나무가 이 한 번의 조회로 선다. ──
//  가지 = (external_system, container_name) 한 쌍. 슬랙이면 채널, 깃허브면 저장소, 내 컴퓨터면 최상위 폴더,
//  '적어 둔 것'(external_system NULL)이면 종류(전사록·회의록)를 채널 자리에 놓는다 — 그래야 그 갈래도 가지를 갖는다.
//  뷰어 술어를 그대로 태우므로 **안 보이는 자료는 건수에도 안 잡힌다**(나무가 남의 개인 폴더 이름을 말하지 않는다).
export interface SourceTreeNode {
  system: string;            // 'slack'·'github'·'local'… 또는 'authored'
  container: string | null;  // 채널·폴더·저장소 이름(없을 수 있다)
  n: number;                 // 자료 수
  linked: number;            // 그중 지식이 붙은 것
  newest: string | null;     // 마지막으로 들어온 때
}
export async function listSourceTree(viewer?: Viewer): Promise<SourceTreeNode[]> {
  const params: unknown[] = [];
  const vis = await sourceVisWhere(viewer, params);
  const rows = await q(itemsPool,
    `SELECT COALESCE(s.external_system, 'authored') AS system,
            COALESCE(s.fields->>'container_name', CASE WHEN s.external_system IS NULL THEN s.kind ELSE NULL END) AS container,
            count(*)::int AS n,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id))::int AS linked,
            max(COALESCE(s.occurred_at, s.updated_at)) AS newest
       FROM source s
      WHERE s.lifecycle='active' AND ${vis}
      GROUP BY 1, 2
      ORDER BY 3 DESC`, params);
  return rows as unknown as SourceTreeNode[];
}

// distill 대상 — 아직 지식으로 증류되지 않은 자료(knowledge_source 링크가 하나도 없는 active source). 최근 발생순.
//  distill 세션(스케줄러 distill_sources)이 이걸로 지식화 대상을 가져온다. 지식화하면 source_link_knowledge 가 생겨
//  다음 조회에서 빠진다(멱등 수렴). 본문 미포함(source_get 으로 전문). #541.
//  viewer(#1291): 증류 크론은 특권(null)으로 부른다 — 못 보면 그 자료는 영영 지식이 안 된다. 사람·에이전트가
//   목록을 열 때는 자기 뷰어로 걸러 제목이 새지 않게 한다(listUnmappedKnowledge 와 같은 갈래).
export async function listUndistilledSources(limit = 50, viewer?: Viewer): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [Math.min(limit, 500)];
  const vis = await sourceVisWhere(viewer, params);
  return q(itemsPool,
    `SELECT ${S_LIST_SEL} FROM source s
     WHERE s.lifecycle='active'
       AND NOT EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id)
       AND ${vis}
     ORDER BY COALESCE(s.occurred_at, s.updated_at) DESC LIMIT $1`,
    params);
}

// 단건 + 파생 지식(knowledge_source 역방향) + 스레드/계층 관계(부모·답글/자식) — 자료 상세용.
//  viewer(#1291): 전문이 나가는 자리라 **본문을 읽기 전에** 막는다 — 안 보이면 undefined(호출부가 '없음' 404).
//   파생 지식 목록도 같이 거른다(자료는 보이는데 그 자료로 만든 비공개 지식의 제목이 딸려 나가면 안 된다).
//   부모·답글(같은 external 좌표)은 별도 자료 행이므로 각자 자기 술어를 탄다.
export async function getSource(id: number, viewer?: Viewer): Promise<(SourceRow & { knowledge: unknown[] }) | undefined> {
  const selfParams: unknown[] = [id];
  const selfVis = await sourceVisWhere(viewer, selfParams);
  const s = await one(itemsPool, `SELECT ${S_SEL} FROM source s WHERE s.id=$1 AND ${selfVis}`, selfParams) as SourceRow | undefined;
  if (!s) return undefined;
  const kParams: unknown[] = [id];
  const kVis = await knowledgeVisWhere(viewer, kParams);
  const knowledge = await q(itemsPool,
    `SELECT ks.name, ks.relation, k.title FROM knowledge_source ks JOIN knowledge k ON k.name=ks.name
     WHERE ks.source_id=$1 AND k.lifecycle='active' AND ${kVis} ORDER BY ks.relation`, kParams);
  // #735 스레드/계층 관계 — 부모(스레드 루트·부모 페이지) + 이 자료를 부모로 갖는 답글/자식(같은 external 좌표 결정적 조인).
  //  parent_external_id/external_id 로 잇는다(resolution 불요 — 부모 미수집이면 parent=null, 안전).
  const sys = s.external_system as string | null;
  const inst = (s.external_instance ?? null) as string | null;
  const parentExt = s.parent_external_id as string | null;
  const selfExt = s.external_id as string | null;
  let parent: unknown = null;
  if (sys && parentExt) {
    const pParams: unknown[] = [sys, inst, parentExt];
    const pVis = await sourceVisWhere(viewer, pParams);
    parent = await one(itemsPool,
      `SELECT ${S_LIST_SEL} FROM source s WHERE s.external_system=$1 AND s.external_instance IS NOT DISTINCT FROM $2
         AND s.external_id=$3 AND s.lifecycle='active' AND ${pVis}`, pParams) ?? null;
  }
  let replies: unknown[] = [];
  if (sys && selfExt) {
    const rParams: unknown[] = [sys, inst, selfExt];
    const rVis = await sourceVisWhere(viewer, rParams);
    replies = await q(itemsPool,
      `SELECT ${S_LIST_SEL} FROM source s WHERE s.external_system=$1 AND s.external_instance IS NOT DISTINCT FROM $2
         AND s.parent_external_id=$3 AND s.lifecycle='active' AND ${rVis}
       ORDER BY COALESCE(s.occurred_at, s.updated_at) ASC LIMIT 200`, rParams);
  }
  return { ...(s as SourceRow), knowledge, parent, replies, reply_count: replies.length };
}

export async function upsertSource(
  input: { id?: number; name?: string | null; kind?: string; title?: string | null; body_md?: string;
    provenance?: string; external_system?: string | null; external_instance?: string | null;
    external_id?: string | null; external_url?: string | null; occurred_at?: string | null; author?: string | null },
  ctx?: WriteCtx,
): Promise<SourceRow> {
  if (input.id) {
    const before = await one(itemsPool, `SELECT ${S_SEL} FROM source s WHERE s.id=$1`, [input.id]);
    if (!before) throw new Error(`자료 #${input.id} 없음`);
    const after = await one(itemsPool,
      `UPDATE source SET title=COALESCE($2,title), body_md=COALESCE($3,body_md), kind=COALESCE($4,kind),
         provenance=COALESCE($5,provenance), occurred_at=COALESCE($6,occurred_at), author=COALESCE($7,author),
         updated_at=now(), updated_by=$8 WHERE id=$1 RETURNING ${S_COLS}`,
      [input.id, input.title ?? null, input.body_md ?? null, input.kind ?? null, input.provenance ?? null,
        input.occurred_at ?? null, input.author ?? null, ctx?.actor ?? null]);
    await auditSource(String(input.id), "update", before, after, ctx);
    return after as SourceRow;
  }
  const after = await one(itemsPool,
    `INSERT INTO source(name, kind, title, body_md, provenance, external_system, external_instance, external_id, external_url, occurred_at, author, updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${S_COLS}`,
    [input.name ?? null, input.kind ?? "other", input.title ?? null, input.body_md ?? "", input.provenance ?? "observed",
      input.external_system ?? null, input.external_instance ?? null, input.external_id ?? null, input.external_url ?? null,
      input.occurred_at ?? null, input.author ?? null, ctx?.actor ?? null]);
  await auditSource(String((after as SourceRow).id), "insert", null, after, ctx);
  return after as SourceRow;
}

// 삭제 — 감사 스냅샷(before)에 전문 보존. knowledge_source 는 FK CASCADE 로 동반 정리(인용만 끊김, 지식은 생존).
export async function deleteSource(id: number, ctx?: WriteCtx): Promise<SourceRow> {
  const before = await one(itemsPool, `SELECT ${S_SEL} FROM source s WHERE s.id=$1`, [id]);
  if (!before) throw new Error(`자료 #${id} 없음`);
  await itemsPool.query(`DELETE FROM source WHERE id=$1`, [id]);
  await auditSource(String(id), "delete", before, null, ctx);
  return before as SourceRow;
}
