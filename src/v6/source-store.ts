// v6 source(자료) 데이터 접근 — #290. raw 입력(이메일·슬랙·회의 전사록/minutes·외부 미러)의 집.
//  ★지식(knowledge)과 별도 테이블 = recall(knowledge_search)이 자료를 자동 미포함(읽기경로 무수정).
//  증류물(지식)은 knowledge_source(knowledge-store.ts)로 인용 — 카파시 source→wiki citation 모델.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { auditOrgContent, type WriteCtx, restoreSnapshot } from "./content-audit.js";
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
//  categories(#1631): 이 자료의 분류 — **그 자료로 만든 지식의 분류**다. 결정(원준 2026-09-03):
//   *"자료가지고 지식 증류한게 들어가는 카테고리인걸로 하자. 증류도 안된 쓸모없는 자료까지 카테고리에
//   매핑할 필요가 없어."* 그래서 source 에 컬럼을 두지 않고 **파생으로만** 낸다 — 지식이 안 된 자료는 빈 배열.
//   한 자료가 여러 지식이 되고 축이 갈리면 중복 없이 여럿이 실린다.
export const SOURCE_CATEGORIES_SQL = `COALESCE((
     SELECT jsonb_agg(DISTINCT jsonb_build_object('key', c.key, 'name', c.name))
       FROM knowledge_source ks
       JOIN knowledge_category kc ON kc.name = ks.name AND kc.state <> 'rejected'
       JOIN category c ON c.id = kc.category_id AND c.state <> 'merged'
      WHERE ks.source_id = s.id), '[]'::jsonb)`;

export const S_LIST_SEL = `s.id, s.name, s.kind, s.title, s.provenance, s.external_system, s.external_url, s.occurred_at, s.updated_at, s.fields, s.parent_external_id, s.visibility,
   EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id) AS has_knowledge,
   ${SOURCE_CATEGORIES_SQL} AS categories`;

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
  /** 분류축(#1631) — 이 자료로 만든 지식이 그 축에 속하나. 지식이 안 된 자료는 어떤 값으로도 안 잡힌다. */
  categoryId?: number;
  container?: string;   // 채널·폴더·저장소(fields->>'container_name') — 표현식 인덱스가 이미 있다
  author?: string;      // 작성자·올린 사람(fields->>'author_name')
  root?: string;        // 올린 자리(fields->>'root') — 'personal' 개인 폴더 · 'project' 프로젝트 폴더 (#2423)
  linked?: boolean;     // true=지식이 붙은 것만 / false=아직 안 붙은 것만
  fold?: boolean;       // 답글 접기(#2423 v3.1) — 부모가 수집돼 있는 답글을 목록에서 뺀다(자료의 단위 = 대화)
}

// ── 자료의 단위(#2423 v3.1) — 대화 출처는 낱메시지가 아니라 **대화**가 한 건이다 ──
//  「ㅇㅋㅇㅋ」가 목록에 1급 행으로 서던 원인은 내용이 아니라 단위였다(실측: 슬랙·디스코드 20자 미만 47건 중
//  27건이 스레드 답글, 그중 37건엔 지식도 붙어 있었다 — 맥락 안에선 승인의 증거다). 그래서 지우지 않고 **접는다**:
//  ⚠ 부모가 실제로 수집돼 있는 답글만 접는다 — 부모 없는 답글을 접으면 그 자료는 영영 안 보인다(fail-open).
//
//  ⚠⚠ 아래 두 술어는 **모양이 곧 성능이다**(2026-09-14 전면 장애 · #936). 나무 집계·목록 총계처럼 LIMIT 이 없는
//   자리에서도 쓰이므로, 행마다 source 를 다시 훑는 모양이면 자료 전건에 곱해져 수백 초가 걸리고 그동안 공유
//   itemsPool(max 20)이 고갈돼 게이트웨이 전 API 가 굶는다. 6만 건 합성 실측(종전 모양): 나무 19.3초 · 목록 총계
//   14.8초 · «지식이 된 것» 총계 120초+ 타임아웃. 지금 모양: 수십 ms. 되돌리지 마라.
//
//  접기 — NULL 검사를 서브쿼리 **안**에 둔 NOT EXISTS 라야 PG 가 Hash Anti Join 으로 푼다. 종전의
//   `NOT (x IS NOT NULL AND EXISTS …)` 는 sublink 를 끌어올리지 못해 행마다 도는 SubPlan 이었다.
//   parent_external_id 가 NULL 이면 `p.external_id = NULL` 이 참일 수 없어 그대로 통과하므로 의미는 종전과 같다.
//   ⚠ WHERE 의 최상위 AND 항으로만 쓴다 — OR·NOT 안에 넣으면 다시 행마다 돈다.
const FOLD_REPLY = `NOT EXISTS (
  SELECT 1 FROM source p WHERE p.external_id = s.parent_external_id
    AND p.external_system IS NOT DISTINCT FROM s.external_system AND p.lifecycle='active')`;
//  접힌 뒤의 «지식이 붙었나»는 스레드 단위다 — 답글에 붙은 지식이 머리 행의 민트 점으로 올라와야 접기가 정보를 안 잃는다.
//   판정 = «지식이 붙은 자료를 제 대화 머리로 올린 집합» 에 이 행이 있나. 부모가 수집된 답글이면 부모가, 아니면 자신이
//   머리다 — 종전 «자신 OR 직계 답글» 두 갈래와 같은 판정이고, 한 단계뿐인 것(답글의 답글은 안 올린다)·뷰어 술어를
//   안 거는 것도 같다. 비상관 IN 이라 집합을 한 번만 만들어 해시로 대조한다. COALESCE 라 NULL 이 없어 NOT IN 도 안전하다.
//   ⚠ 접힌 행(FOLD_REPLY 를 통과한 머리 행)에만 쓴다 — 접히는 답글 행에 대고 물으면 제 지식이 부모 쪽으로 올라가 있어
//    거짓이 된다. 지금 쓰는 자리(fold 목록·총계·나무)는 전부 FOLD_REPLY 와 함께 쓴다.
const THREAD_KN = `s.id IN (
  SELECT COALESCE(par.id, ks_s.id)
    FROM knowledge_source ks
    JOIN source ks_s ON ks_s.id = ks.source_id AND ks_s.lifecycle='active'
    LEFT JOIN source par ON par.external_id = ks_s.parent_external_id
         AND par.external_system IS NOT DISTINCT FROM ks_s.external_system AND par.lifecycle='active')`;

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
  //  올린 자리(#2423 열람실) — 'personal'(개인 폴더) / 'project'(프로젝트 폴더). ingest/local-file 이 fields.root 에 적는다.
  if (f.root) { params.push(f.root); wh.push(`s.fields->>'root'=$${params.length}`); }
  if (f.author) { params.push(f.author); wh.push(`s.fields->>'author_name'=$${params.length}`); }
  if (f.fold) wh.push(FOLD_REPLY);
  //  카테고리 축(#1631) — 자료를 «그 자료로 만든 지식의 분류» 로 좁힌다. 지식이 안 된 자료는 자연히 빠진다.
  if (f.categoryId != null) {
    params.push(f.categoryId);
    wh.push(`EXISTS (SELECT 1 FROM knowledge_source ks JOIN knowledge_category kc ON kc.name = ks.name
              AND kc.state <> 'rejected' WHERE ks.source_id = s.id AND kc.category_id = $${params.length})`);
  }
  if (f.linked !== undefined) {
    const kn = f.fold ? `(${THREAD_KN})` : `EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id=s.id)`;
    wh.push(`${f.linked ? "" : "NOT "}${kn}`);
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
  //  fold 목록엔 화면이 접기 판정에 쓰는 두 값을 더 싣는다: reply_n(행에 «답글 n») · body_len(한 줄짜리 잡음 판정 —
  //   목록은 본문을 안 싣는 규약이라 길이만 보낸다). 페이지당 60행이라 상관 서브쿼리 비용은 무시할 수준이다.
  const sel = !f.fold ? S_LIST_SEL
    : `${S_LIST_SEL.replace("EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id)", `(${THREAD_KN.replace(/\n/g, " ")})`)},
       length(coalesce(s.body_md,''))::int AS body_len,
       (SELECT count(*)::int FROM source r WHERE r.parent_external_id = s.external_id
         AND r.external_system IS NOT DISTINCT FROM s.external_system AND r.lifecycle='active') AS reply_n`;
  return q(itemsPool,
    `SELECT ${sel} FROM source s WHERE ${where} AND ${vis}
     ORDER BY COALESCE(s.occurred_at, s.updated_at) DESC LIMIT ${limP} OFFSET ${offP}`, params);
}

// ── 휴지통의 파일 자료(#3778) — 파일을 지워 `.lively/trash` 로 옮겨 둔 자료들(ingest/local-file.ts 의 도장 fields.trash). ──
//  프로젝트를 가로질러 한 번에 읽는다(휴지통 「자료」 탭). 본문은 안 싣는다 — 목록 규약 그대로. 뷰어 술어를 태워
//  안 보이는 자료는 휴지통에서도 안 보인다.
//  ★ 남의 **개인 폴더**에서 버린 파일은 세우지 않는다(#3778 후속) — 자료 자체는 보일 수 있어도(«팀원 모두» 로 올린 것) 되살리기·완전 삭제는
//   그 폴더 주인만 한다(브라우즈 라우트가 남에게는 404). 누를 수 없는 줄을 세우지 않는다. personalMember = 내 개인 루트의 주인 키
//   (ingest/local-file personalRootMember) — 없으면 개인 폴더 것은 전부 뺀다. 옛 도장(root 없음 = 프로젝트 파일)은 그대로 선다.
function trashedFileWhere(params: unknown[], personalMember?: string | null): string {
  params.push(personalMember ? `personal:${personalMember}` : "");
  return `s.lifecycle='superseded' AND s.fields ? 'trash'
        AND (COALESCE(s.fields->'trash'->>'root', '') NOT LIKE 'personal:%' OR s.fields->'trash'->>'root' = $${params.length})`;
}
export async function listTrashedFileSources(viewer?: Viewer, limit = 500, personalMember?: string | null): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  const vis = await sourceVisWhere(viewer, params);
  const where = trashedFileWhere(params, personalMember);
  params.push(Math.min(Math.max(Number(limit) || 500, 1), 500));
  return q(itemsPool,
    `SELECT s.id, s.kind, s.title, s.name, s.updated_at, s.fields, s.visibility,
            EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id) AS has_knowledge
       FROM source s
      WHERE ${where} AND ${vis}
      ORDER BY (s.fields->'trash'->>'at') DESC NULLS LAST
      LIMIT $${params.length}`, params);
}

/** 그 목록의 개수만(#3778 — 사이드바 「휴지통 N」). listTrashedFileSources 와 같은 술어·같은 뷰어·같은 상한. */
export async function countTrashedFileSources(viewer?: Viewer, cap = 500, personalMember?: string | null): Promise<number> {
  const params: unknown[] = [];
  const vis = await sourceVisWhere(viewer, params);
  const where = trashedFileWhere(params, personalMember);
  params.push(Math.min(Math.max(Number(cap) || 500, 1), 500));
  const row = await one(itemsPool,
    `SELECT LEAST(count(*), $${params.length})::int AS n FROM source s WHERE ${where} AND ${vis}`, params);
  return Number((row as { n?: number } | undefined)?.n ?? 0);
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
    //  나무도 **대화 단위**로 센다(#2423 v3.1) — 목록이 fold 로 접는데 나무만 낱메시지로 세면 «슬랙 68»을 눌렀는데
    //   35건이 나온다(같은 화면의 두 숫자가 서로 거짓말). linked 도 스레드 단위로 올린다.
    //  ⚠ 목록·총계와 **같은 술어**(FOLD_REPLY·THREAD_KN)를 쓴다 — 나무의 숫자와 그 가지를 눌렀을 때의 목록 총계가
    //   한 정의에서 나와야 서로 맞는다. LIMIT 없는 집계라 술어 모양이 곧 성능이다(2026-09-14 전면 장애: 종전 모양은
    //   행마다 source 를 다시 훑어 수백 초 → itemsPool 고갈 → 게이트웨이 전 API 가 굶었다). 두 상수 머리말의 ⚠ 를 지킨다.
    `SELECT COALESCE(s.external_system, 'authored') AS system,
            COALESCE(s.fields->>'container_name', CASE WHEN s.external_system IS NULL THEN s.kind ELSE NULL END) AS container,
            count(*)::int AS n,
            count(*) FILTER (WHERE ${THREAD_KN})::int AS linked,
            max(COALESCE(s.occurred_at, s.updated_at)) AS newest
       FROM source s
      WHERE s.lifecycle='active' AND ${FOLD_REPLY} AND ${vis}
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
  const s = await one(itemsPool,
    `SELECT ${S_SEL}, ${SOURCE_CATEGORIES_SQL} AS categories FROM source s WHERE s.id=$1 AND ${selfVis}`,
    selfParams) as SourceRow | undefined;
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

// 복원(#3778) — 마지막 delete 의 before 스냅샷(전문 1행)을 원래 id 로 재적재한다. knowledge/project/category 복원과 같은 골격.
//  knowledge_source(인용)·source_member(공개범위 grant)는 삭제 때 CASCADE 됐으므로 돌아오지 않는다(자료 본체만) — 화면이 그 사실을 말한다.
//  ⚠ 커넥터가 그새 같은 원본을 다시 들여왔으면(외부 좌표 유니크) 재적재가 충돌한다 — 그건 «이미 돌아와 있다»는 뜻이라 그대로 알린다.
export async function restoreSource(before: Record<string, unknown>, ctx?: WriteCtx): Promise<SourceRow> {
  let after: SourceRow;
  try { after = await restoreSnapshot<SourceRow>("source", S_COLS, "id", before); }
  catch (e) {
    if ((e as { code?: string })?.code === "23505") throw new Error("같은 원본의 자료가 이미 다시 들어와 있어요 — 되살릴 필요가 없습니다");
    throw e;
  }
  await auditSource(String(after.id), "restore", null, after, ctx);
  return after;
}
