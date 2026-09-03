// v6 category 데이터 접근 — 구 domain 일반화(repo 분리). itemsPool 직접 + q/one 헬퍼(domainmap/db) 재사용.
//  ⚠ 2026-09-02(#1631) space 폐기 — 분류축 위의 고정 서랍장(business/product/system)을 걷었다. key 가 단독 유일하다.
//   코드 앵커(mapping/debt/엣지)를 가진 축을 종전엔 '도메인'이라 부르며 space='product' 로 갈랐는데, 앵커는
//   **있으면 붙는 것**이지 축의 부류가 아니다 — 도메인맵은 이제 전 분류축을 그린다.
//  감사는 org_content_audit(entity='category') — knowledge/domain 과 동일 append-only 패턴.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { auditOrgContent, restoreSnapshot, type WriteCtx } from "./content-audit.js";
import { embeddingInputText } from "./embedding-provider.js";
import { markEmbeddingPending, CATEGORY_TARGET } from "./embedding-backfill.js";
import { knowledgeVisWhere } from "./knowledge-store.js";
import type { Viewer } from "./visibility.js";

// entry_name·view_mode(#592) 포함 — 지식탭 카테고리 뷰(list|table|entry)가 목록/상세에서 바로 읽는다.
//  구 delete 스냅샷(두 컬럼 부재)의 복원은 restoreSnapshot 이 부재 키를 생략해 DB DEFAULT 로 수렴(v6/content-audit.ts).
const CATEGORY_COLS =
  `id, key, name, description, should, cross_cutting, origin, status, state, entry_name, view_mode, created_at, updated_at`;

export interface CategoryRow {
  id: number; key: string; name: string | null;
  description: string | null; should: string | null; cross_cutting: boolean;
  origin: string | null; status: string; state: string;
  entry_name: string | null; view_mode: string;
  created_at: string; updated_at: string;
  // 오너 팀(team_category relation='owner') — listCategories 만 채운다(LEFT JOIN). 쓰기/감사 경로는 base 컬럼만.
  owner_team_id?: number | null; owner_team_key?: string | null; owner_team_name?: string | null;
  // 이 카테고리에 매핑된 active 지식 수 — listCategories 만 채운다(WIKI 사이드바 개수 뱃지).
  knowledge_count?: number;
  // 정의-내용 불일치(#1153) — 이 분류의 **정의(should)** 벡터에서 먼 소속 지식 수. listCategories 만 채운다.
  //  분류체계 탭이 드러내는 것: 코드 부채도, '시간이 지났다'도 아니라 **정의와 실제 내용의 어긋남**이다.
  //  (초안은 '정의 수정 이후 쌓인 지식 수'라는 시간 프록시였다. 그건 정의가 낡았을 *가능성*만 말하고 —
  //   276건이 전부 정의에 맞을 수도, 3건이 완전히 벗어날 수도 있다 — 무엇을 해야 하는지도 안 알려준다.
  //   반면 '이 5건이 정의와 멀다'는 정의를 넓히거나 지식을 옮기는 행동으로 바로 이어진다. 윤상민 지적, 2026-07-27.)
  mismatch_count?: number;
  // 정의 벡터를 아직 못 구한 상태(임베딩 off · should 공란 · 백필 대기) — 숫자 0 과 구분해야 한다.
  //  0 은 '어긋난 게 없다'이고 null 은 '재지 못했다'다. 이 둘을 뭉개면 화면이 거짓 초록불을 준다.
  mismatch_measurable?: boolean;
  // 분류기(LLM)가 이 분류로 판정하며 남긴 확신도 평균·저확신 건수 — 추가 계산 0(이미 저장된 값).
  //  should 가 모호하면 분류기가 확신을 못 한다(실측: should 공란인 GTM 은 평균 0.642·대기 12건).
  avg_confidence?: number | null;
  proposed_count?: number;
  // 명시 매핑된 레포 이름들(category_repo) — 파생(스캔 역산)이 아니라 사람이 선언한 것. listCategories 만 채운다.
  repos?: string[];
}

// 정의-내용 불일치 판정(#1153) — **절대 거리가 아니라 상대 비교**다.
//  어떤 지식이 자기 분류의 정의보다 **다른 분류의 정의에 더 가까우면** 어긋난 것으로 본다.
//
//  왜 절대 임계를 버렸나(실측 2026-07-27): 정의 벡터와 지식 벡터의 거리는 카테고리마다 기준선이 다르다 —
//   컨텍스트 저장소 중앙값 0.490 · AI 워크플로 0.466 · 도메인 맵 0.294. should 의 길이·추상도가 다르기 때문이다.
//   임계 0.5 를 쓰면 컨텍스트 저장소의 절반이 '어긋남'이 됐다(쓸모없는 신호). 하나의 절대 임계로는 성립하지 않는다.
//
//  상대 비교의 잔여 편향(정직히): **넓은 정의는 벡터가 흐릿하고 좁은 정의는 선명하다.** 그래서 넓은 분류의
//   지식이 좁은 분류 쪽으로 끌려간다(실측: 단순 '더 가까움'만 보면 309건 중 279건이 걸렸다). margin 을 요구해
//   간발의 차이를 걸러낸다 — 0.1 이면 407건 중 29건(7%)으로, 실제로 검토할 만한 것만 남았다.
//  ⚠ 비교군은 **정의(should)가 있는 분류들뿐**이다. 정의가 없는 분류는 비교에 못 들어가므로, 정의를 채울수록
//   이 신호가 정확해진다(정의 없음을 먼저 해결하라는 유인이기도 하다).
export const MISMATCH_MARGIN = 0.1;

// "자기 정의 거리 − 가장 가까운 다른 정의 거리" — 양수가 클수록 남의 분류에 더 어울린다는 뜻.
//  <alias> 는 지식 행 별칭, <own> 은 그 지식이 속한 카테고리 행 별칭.
const mismatchMarginSql = (alias: string, own: string) =>
  `((${alias}.embedding_vector <=> ${own}.embedding_vector) - (
      SELECT (${alias}.embedding_vector <=> oc.embedding_vector) FROM category oc
       WHERE oc.embedding_vector IS NOT NULL AND oc.id <> ${own}.id
       ORDER BY (${alias}.embedding_vector <=> oc.embedding_vector) LIMIT 1))`;

// 판정에서 빼는 행 — 대문 문서·폴더는 목차·색인이라 어떤 정의에서도 구조적으로 멀다(거짓 양성 고정 발생원).
const MISMATCH_EXCLUDE = `COALESCE(k.is_folder,false)=false AND k.name <> ('category-home-' || c.key)`;

// 읽기 전용 SELECT(목록) — base 컬럼 + 오너 팀 조인 + 지식 수 + 정의-내용 불일치 + 명시 레포.
//  쓰기 RETURNING/restoreSnapshot 은 CATEGORY_COLS(base)만 사용.
//  knowledge_count(#req WIKI 사이드바 개수 뱃지) — 목록 화면(listKnowledge)과 동일 의미: active 지식 × rejected 아닌 매핑.
//  mismatch_count(#1153) — 정의 벡터에서 코사인 거리가 임계를 넘는 소속 지식 수(아래 MISMATCH_DISTANCE).
//  ⚠ 대문 문서(is_folder / category-home-*)는 제외한다 — 목차·색인이라 어떤 정의에서도 구조적으로 멀다(거짓 양성).
//  공개범위(#1291) — 이 집계들은 전부 **지식을 세는 숫자**라 뷰어 술어(vis)를 그대로 받는다.
//   숫자만 남기고 안 걸면 "내가 못 보는 문서가 이 분류에 N 건 있다"가 그대로 드러나고(있는 줄도 몰라야 한다),
//   검토 배지·불일치 배지가 절대 열 수 없는 문서를 가리키며 영영 안 줄어드는 거짓 할 일이 된다.
//   vis 는 knowledgeVisWhere 규약대로 별칭 k 기준 — 아래 서브쿼리들이 전부 knowledge 를 k 로 조인하는 이유다.
const categorySel = (vis: string) =>
  `${CATEGORY_COLS.split(",").map((c) => "c." + c.trim()).join(", ")},
   tco.team_id AS owner_team_id, tot.key AS owner_team_key, tot.name AS owner_team_name,
   (SELECT COUNT(*)::int FROM knowledge_category kc JOIN knowledge k ON k.name=kc.name AND k.lifecycle='active'
    WHERE kc.category_id=c.id AND kc.state<>'rejected' AND ${vis}) AS knowledge_count,
   (c.embedding_vector IS NOT NULL) AS mismatch_measurable,
   CASE WHEN c.embedding_vector IS NULL THEN NULL ELSE (
     SELECT COUNT(*)::int FROM knowledge_category kc
       JOIN knowledge k ON k.name=kc.name AND k.lifecycle='active' AND k.embedding_vector IS NOT NULL
      WHERE kc.category_id=c.id AND kc.state<>'rejected' AND ${MISMATCH_EXCLUDE} AND ${vis}
        AND ${mismatchMarginSql("k", "c")} > ${MISMATCH_MARGIN}
   ) END AS mismatch_count,
   (SELECT AVG(kc.confidence)::real FROM knowledge_category kc JOIN knowledge k ON k.name=kc.name AND k.lifecycle='active'
    WHERE kc.category_id=c.id AND kc.state<>'rejected' AND kc.confidence IS NOT NULL AND ${vis}) AS avg_confidence,
   (SELECT COUNT(*)::int FROM knowledge_category kc JOIN knowledge k ON k.name=kc.name AND k.lifecycle='active'
    WHERE kc.category_id=c.id AND kc.state='proposed' AND ${vis}) AS proposed_count,
   COALESCE((SELECT ARRAY_AGG(cr.repo ORDER BY cr.sort, cr.repo) FROM category_repo cr
    WHERE cr.category_id=c.id), ARRAY[]::TEXT[]) AS repos`;
const CATEGORY_OWNER_JOIN =
  `LEFT JOIN team_category tco ON tco.category_id=c.id AND tco.relation='owner'
   LEFT JOIN team tot ON tot.id=tco.team_id`;

export interface CategoryEdgeRow {
  id: number; from_category_id: number; to_category_id: number;
  axis: string; relation: string; origin: string | null; weight: number | null;
  from_key?: string; to_key?: string; from_name?: string | null; to_name?: string | null;
}

// append-only 감사(org_content_audit, entity='category') — 공유 헬퍼 위임.
const auditCategory = (entityKey: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("category", entityKey, op, before, after, ctx);

//  카테고리 행 자체는 거르지 않는다(분류체계는 조직의 뼈대 — 가시성 주체가 아니다). 잠기는 건 그 안의 지식이고,
//  그래서 위 집계만 뷰어 기준으로 센다(materialize.categoryMapForIndex 와 같은 판단).
//  정렬: 교차관심사 먼저(여러 축에 걸친 것이 위) → 이름. 종전의 space 우선 정렬은 축과 함께 사라졌다.
export async function listCategories(viewer?: Viewer): Promise<CategoryRow[]> {
  const params: unknown[] = [];
  const sel = categorySel(await knowledgeVisWhere(viewer, params));
  return q(itemsPool,
    `SELECT ${sel} FROM category c ${CATEGORY_OWNER_JOIN}
     WHERE c.state<>'merged' ORDER BY c.cross_cutting DESC, c.name NULLS LAST, c.key`, params);
}

export async function getCategory(id: number): Promise<CategoryRow | undefined> {
  return one(itemsPool, `SELECT ${CATEGORY_COLS} FROM category WHERE id=$1`, [id]);
}

// ── 카테고리↔레포 명시 매핑(#1153) — setProjectRepos 와 동형(전체 교체·최대 50·중복 제거·감사). ──
//  repo 이름은 FK 없이 TEXT(레포 레지스트리 rename 을 여기서 강제하지 않는다 — project_repo 와 같은 관례).
export async function getCategoryRepos(categoryId: number): Promise<string[]> {
  const rows = await q(itemsPool,
    `SELECT repo FROM category_repo WHERE category_id=$1 ORDER BY sort, repo`, [categoryId]);
  return rows.map((r: { repo: string }) => r.repo);
}

export async function setCategoryRepos(categoryId: number, repos: string[], ctx?: WriteCtx): Promise<string[]> {
  const clean = [...new Set((repos || []).map((r) => String(r).trim()).filter(Boolean))].slice(0, 50);
  const before = await getCategoryRepos(categoryId);
  const cat = await getCategory(categoryId);
  await itemsPool.query(`DELETE FROM category_repo WHERE category_id=$1`, [categoryId]);
  for (let i = 0; i < clean.length; i++) {
    await itemsPool.query(`INSERT INTO category_repo(category_id, repo, sort) VALUES($1,$2,$3)`, [categoryId, clean[i], i]);
  }
  await auditCategory(cat ? cat.key : String(categoryId),
    "set_repos", { repos: before }, { repos: clean }, ctx);
  return clean;
}

// ── 정의와 어긋나는 지식 목록(#1153) — 배지의 숫자를 **행동 가능한 것**으로 만드는 부분. ──
//  사람은 이 목록을 보고 둘 중 하나를 한다: 정의를 넓히거나, 그 지식을 맞는 분류로 옮기거나.
//  숫자만으론 어느 쪽도 못 정한다 — 그래서 상세에는 반드시 '무엇이' 어긋났는지가 있어야 한다.
//  정의 벡터가 없으면(임베딩 off · should 공란 · 백필 대기) 빈 배열이 아니라 null 을 준다(0 과 구분).
export interface CategoryMismatch {
  name: string; title: string | null;
  margin: number;                    // 얼마나 더 남의 분류에 어울리는가(클수록 뚜렷)
  nearest_key: string | null;        // 더 가까운 분류 — 이게 있어야 '어디로 옮길지'가 화면에서 답이 된다
  nearest_name: string | null;
}

//  viewer(#1291): 여기는 지식 **제목**이 그대로 나가는 자리라 배지 숫자보다 더 엄격히 걸러야 한다.
export async function listCategoryMismatches(
  categoryId: number, limit = 12, viewer?: Viewer,
): Promise<CategoryMismatch[] | null> {
  const cat = await one(itemsPool,
    `SELECT (embedding_vector IS NOT NULL) AS has_vec FROM category WHERE id=$1`, [categoryId]);
  if (!cat || !cat.has_vec) return null;
  const params: unknown[] = [categoryId, MISMATCH_MARGIN, Math.max(1, Math.min(50, limit))];
  const vis = await knowledgeVisWhere(viewer, params);
  const rows = await q(itemsPool,
    `SELECT k.name, k.title, ${mismatchMarginSql("k", "c")} AS margin,
            (SELECT oc.key FROM category oc WHERE oc.embedding_vector IS NOT NULL AND oc.id <> c.id
              ORDER BY (k.embedding_vector <=> oc.embedding_vector) LIMIT 1) AS nearest_key,
            (SELECT oc.name FROM category oc WHERE oc.embedding_vector IS NOT NULL AND oc.id <> c.id
              ORDER BY (k.embedding_vector <=> oc.embedding_vector) LIMIT 1) AS nearest_name
       FROM knowledge_category kc
       JOIN knowledge k ON k.name=kc.name AND k.lifecycle='active' AND k.embedding_vector IS NOT NULL
       JOIN category c ON c.id=kc.category_id
      WHERE kc.category_id=$1 AND kc.state<>'rejected' AND ${MISMATCH_EXCLUDE} AND ${vis}
        AND ${mismatchMarginSql("k", "c")} > $2
      ORDER BY margin DESC LIMIT $3`,
    params);
  return rows.map((r: CategoryMismatch) => ({
    name: r.name, title: r.title,
    margin: Math.round(Number(r.margin) * 1000) / 1000,
    nearest_key: r.nearest_key, nearest_name: r.nearest_name,
  }));
}

// ── 저장 시점 분류 점검(#1153) — 오분류를 **그 자리에서** 잡는다. ──
//  왜 여기인가: 분류 판단이 필요한 순간은 지식을 저장할 때뿐이다. 그 비용을 세션 주입으로 항상 물리는 건 낭비고
//   (온톨로지 원칙 "전부 미리 읽지 않는다"에도 역행), 사람이 나중에 분류체계 탭에서 발견해 고치는 것보다
//   저장하는 LLM 이 그 자리에서 고치는 게 훨씬 빠른 루프다 — 그 LLM 은 방금 쓴 내용을 알고 있다. (윤상민 판단)
//
//  ⚠ 거리 비교는 **자주 불가능하다**: 저장은 임베딩을 비동기로 돌리고(markEmbeddingPending 이 벡터를 NULL 로
//   비운다) 백그라운드 스윕이 나중에 채운다. 그래서 신규 저장·본문 변경 직후엔 벡터가 없다.
//   → 주된 값은 **정의(should) 자체를 응답에 실어 LLM 이 대조하게 하는 것**이다. 이건 벡터가 필요 없고,
//     임베딩이 못 잡는 규칙 위반("이 분류엔 ~는 두지 않는다")까지 판단할 수 있다. 거리는 있으면 덤으로 붙인다.
const SHOULD_HINT_CAP = 500;   // 저장 응답에 싣는 정의 길이 상한(저장 1회 비용이라 넉넉하되 무한은 아니게)

export interface ClassificationCheck {
  category: { key: string; name: string | null; should: string | null; should_truncated?: boolean };
  nearer: { key: string; name: string | null; margin: number } | null;
  note: string;
}

export async function checkKnowledgeClassification(knowledgeName: string): Promise<ClassificationCheck | null> {
  const row = await one(itemsPool,
    `SELECT c.id, c.key, c.name, c.should, (c.embedding_vector IS NOT NULL) AS cat_vec,
            (k.embedding_vector IS NOT NULL) AS kn_vec
       FROM knowledge_category kc
       JOIN category c ON c.id=kc.category_id
       JOIN knowledge k ON k.name=kc.name
      WHERE kc.name=$1 AND kc.state<>'rejected'
      ORDER BY (kc.state='confirmed') DESC LIMIT 1`, [knowledgeName]);
  if (!row) return null;   // 미분류 — 분류 인박스가 따로 처리한다(여기서 말할 게 없다)

  const shouldRaw = (row.should ?? "").trim();
  const truncated = shouldRaw.length > SHOULD_HINT_CAP;
  const should = truncated ? shouldRaw.slice(0, SHOULD_HINT_CAP - 1) + "…" : (shouldRaw || null);

  // 벡터가 양쪽 다 있을 때만 거리 비교(대개 신규·본문변경 직후엔 못 한다 — 위 주석).
  let nearer: ClassificationCheck["nearer"] = null;
  if (row.cat_vec && row.kn_vec) {
    const n = await one(itemsPool,
      `SELECT oc.key, oc.name,
              ((k.embedding_vector <=> c.embedding_vector) - (k.embedding_vector <=> oc.embedding_vector)) AS margin
         FROM knowledge k, category c, category oc
        WHERE k.name=$1 AND c.id=$2 AND oc.embedding_vector IS NOT NULL AND oc.id <> c.id
        ORDER BY (k.embedding_vector <=> oc.embedding_vector) LIMIT 1`, [knowledgeName, row.id]);
    if (n && Number(n.margin) > MISMATCH_MARGIN) {
      nearer = { key: n.key, name: n.name, margin: Math.round(Number(n.margin) * 1000) / 1000 };
    }
  }

  const catLabel = row.name || row.key;
  const note = nearer
    ? `⚠ 이 지식은 [${catLabel}] 보다 [${nearer.name || nearer.key}] 의 정의에 더 가깝습니다(+${nearer.margin}). `
      + `분류가 맞는지 확인하세요 — 아니면 knowledge_link_category 로 옮기고, [${catLabel}] 의 정의가 이 지식을 품어야 한다면 category_update 로 정의를 넓히세요.`
    : should
      ? `저장된 분류 [${catLabel}] 의 정의입니다. 방금 쓴 내용이 이 정의에 맞는지 확인하세요 — 어긋나면 knowledge_link_category 로 옮기거나, 정의가 현실을 못 따라간 것이면 category_update 로 넓히세요.`
      : `⚠ 분류 [${catLabel}] 에는 정의(should)가 없습니다 — 무엇이 여기 속하는지 판단할 근거가 조직에 없다는 뜻입니다. `
        + `category_update 로 정의·범위를 채워 두면 이후 분류가 정확해지고, 분류체계 탭이 어긋난 지식을 잡아낼 수 있습니다.`;

  return { category: { key: row.key, name: row.name, should, ...(truncated ? { should_truncated: true } : {}) }, nearer, note };
}

// (제품) is 요약(#1153) — 부채 판정이 아니라 **라우팅 인덱스의 신선도**를 보여주는 읽기 전용 수치.
//  units = 이 카테고리에 매핑된 active code_unit 수, last_scan_at = 그 유닛들이 속한 레포의 마지막 스캔 시각.
export async function getCategoryIsSummary(categoryId: number): Promise<{ units: number; last_scan_at: string | null }> {
  const row = await one(itemsPool,
    `SELECT COUNT(*)::int AS units, MAX(r.last_scan_at) AS last_scan_at
       FROM mapping m
       JOIN code_unit cu ON cu.id=m.target_id
       LEFT JOIN repo r ON r.id=cu.repo_id
      WHERE m.category_id=$1 AND m.target_kind='code_unit' AND m.status<>'rejected'
        AND COALESCE(cu.state,'active')='active'`, [categoryId]);
  return { units: row?.units ?? 0, last_scan_at: row?.last_scan_at ?? null };
}

export async function getCategoryByKey(key: string): Promise<CategoryRow | undefined> {
  return one(itemsPool,
    `SELECT ${CATEGORY_COLS} FROM category WHERE key=$1 AND state<>'merged'`, [key]);
}

export async function createCategory(
  input: { key: string; name?: string; description?: string; should?: string; cross_cutting?: boolean },
  ctx?: WriteCtx,
): Promise<CategoryRow> {
  const origin = ctx?.source === "mcp" ? "agent" : "human";
  const row: CategoryRow = await one(itemsPool,
    `INSERT INTO category(key, name, description, should, cross_cutting, origin, status, state, created_at, updated_at)
     VALUES($1,$2,$3,$4,COALESCE($5,false),$6,'confirmed','active',now(),now())
     RETURNING ${CATEGORY_COLS}`,
    [input.key, input.name ?? null, input.description ?? null,
     input.should ?? null, input.cross_cutting ?? null, origin]);
  await auditCategory(input.key, "insert", null, row, ctx);
  return row;
}

/**
 * 이 축을 비활성으로 바꿔도 되나(#1631) — **지식이 남아 있으면 안 된다.**
 *
 *  왜: 미분류 지식은 recall 라우터의 조인에서 빠져 **아예 소환되지 않는다**(lively-taxonomy 스킬이 이미
 *   세워 둔 규칙 — "카테고리를 지우기 전에 그 아래 지식을 먼저 옮긴다"). 비활성도 같은 자리다.
 *   이 검사가 있어야 «비활성 축은 비어 있다» 가 보장되고, 그 덕분에 비활성 축을 분류 후보에서 빼도
 *   소환에서 잃는 것이 없다(안 그러면 지식이 조용히 사라진다).
 */
async function assertDeprecatable(id: number, key: string): Promise<void> {
  const row: { n: number } | undefined = await one(itemsPool,
    `SELECT count(*)::int AS n FROM knowledge_category kc JOIN knowledge k ON k.name=kc.name
      WHERE kc.category_id=$1 AND kc.state<>'rejected' AND k.lifecycle='active'`, [id]);
  const n = row?.n ?? 0;
  if (n > 0) {
    throw new Error(`'${key}' 에 지식 ${n}건이 남아 있어 비활성으로 바꿀 수 없습니다 — 먼저 다른 축으로 옮기세요`
      + "(미분류 지식은 소환에 안 잡힙니다).");
  }
}

export async function updateCategory(
  id: number,
  patch: { name?: string; description?: string; should?: string; cross_cutting?: boolean; state?: string },
  ctx?: WriteCtx,
): Promise<CategoryRow> {
  const before = await getCategory(id);
  if (!before) throw new Error(`카테고리 #${id} 없음`);
  //  state 는 두 값만 오간다 — 'merged' 는 병합 경로가 소유하는 상태라 여기서 못 만든다.
  const nextState = patch.state === undefined ? null : String(patch.state);
  if (nextState !== null && nextState !== "active" && nextState !== "deprecated") {
    throw new Error("state 는 active|deprecated 만 가능합니다(merged 는 병합 경로가 정합니다)");
  }
  if (nextState === "deprecated" && before.state !== "deprecated") await assertDeprecatable(id, before.key);
  // COALESCE($n, col): undefined→null→기존값 보존(부분 수정).
  const row: CategoryRow = await one(itemsPool,
    `UPDATE category SET
       name=COALESCE($2,name), description=COALESCE($3,description),
       should=COALESCE($4,should), cross_cutting=COALESCE($5,cross_cutting),
       state=COALESCE($6,state), updated_at=now()
     WHERE id=$1 RETURNING ${CATEGORY_COLS}`,
    [id, patch.name ?? null, patch.description ?? null, patch.should ?? null, patch.cross_cutting ?? null, nextState]);
  await auditCategory(before.key, "update", before, row, ctx);
  // #1153 — 정의 벡터 재계산. 임베딩 입력(이름+설명+should)이 **실제로 바뀐** 경우에만 pending 으로 되돌린다
  //  (무변경 저장에 헛임베딩을 태우지 않는다 — knowledge 쓰기 경로와 동일 idiom). 백그라운드 스윕이 채운다.
  const embedText = (c: CategoryRow) =>
    embeddingInputText({ title: c.name, summary: c.description, body_md: c.should });
  if (embedText(row) !== embedText(before)) {
    await markEmbeddingPending(CATEGORY_TARGET, id).catch(() => { /* 임베딩 실패가 정의 저장을 막지 않는다 */ });
  }
  return row;
}

// ── #592 카테고리 뷰 설정 — view_mode(list|table|entry)·entry_name(엔트리 문서, knowledge.name 소프트 참조). ──
//  entry_name: 문자열=설정(존재 검증 — 오타·유령 참조 방지), null=해제, undefined=미변경(3상 부분 수정).
//  view_mode enum 은 DB CHECK(category_view_mode_chk)가 최종 방어 — 쓰기경로(capability)가 1차 검증.
export async function setCategoryView(
  id: number,
  patch: { view_mode?: string; entry_name?: string | null },
  ctx?: WriteCtx,
): Promise<CategoryRow> {
  const before = await getCategory(id);
  if (!before) throw new Error(`카테고리 #${id} 없음`);
  if (typeof patch.entry_name === "string") {
    const k = await one(itemsPool, `SELECT 1 AS x FROM knowledge WHERE name=$1`, [patch.entry_name]);
    if (!k) throw new Error(`지식 '${patch.entry_name}' 없음 — entry_name 은 존재하는 지식 이름이어야 합니다`);
  }
  const sets: string[] = []; const params: unknown[] = [id];
  if (patch.view_mode !== undefined) { params.push(patch.view_mode); sets.push(`view_mode=$${params.length}`); }
  if (patch.entry_name !== undefined) { params.push(patch.entry_name); sets.push(`entry_name=$${params.length}`); }
  if (!sets.length) return before;
  const row: CategoryRow = await one(itemsPool,
    `UPDATE category SET ${sets.join(", ")}, updated_at=now() WHERE id=$1 RETURNING ${CATEGORY_COLS}`, params);
  await auditCategory(before.key, "set_view", before, row, ctx);
  return row;
}

export async function deleteCategory(id: number, ctx?: WriteCtx): Promise<{ deleted: boolean; id: number }> {
  const before = await getCategory(id);
  if (!before) throw new Error(`카테고리 #${id} 없음`);
  await itemsPool.query(`DELETE FROM category WHERE id=$1`, [id]); // FK CASCADE: 매핑·엣지·정션 동반 삭제
  await auditCategory(before.key, "delete", before, null, ctx);
  return { deleted: true, id };
}

// 복원 — 마지막 delete 의 before 스냅샷을 원래 id 로 재적재한다. 매핑·엣지·정션은 삭제 시 cascade 됐으므로
//  복원되지 않는다(카테고리 본체만). 이미 존재하면 거부. (key 유니크 충돌 시 DB 가 throw.)
//  사람전용 게이트는 capability 계층(content_restore)에서 선행.
export async function restoreCategory(before: Record<string, unknown>, ctx?: WriteCtx): Promise<CategoryRow> {
  const after = await restoreSnapshot<CategoryRow>("category", CATEGORY_COLS, "id", before);
  await auditCategory(after.key, "restore", null, after, ctx);
  return after;
}

// ── category_edge (도메인 의존) — axis='should'(수동 저작) | 'is'(스캔 전용, 여기서 안 만듦). ──
export async function listCategoryEdges(filter?: { categoryId?: number; axis?: string }): Promise<CategoryEdgeRow[]> {
  const wh: string[] = [];
  const params: unknown[] = [];
  if (filter?.categoryId != null) {
    params.push(filter.categoryId);
    wh.push(`(e.from_category_id=$${params.length} OR e.to_category_id=$${params.length})`);
  }
  if (filter?.axis) {
    params.push(filter.axis);
    wh.push(`e.axis=$${params.length}`);
  }
  const where = wh.length ? `WHERE ${wh.join(" AND ")}` : "";
  return q(itemsPool,
    `SELECT e.id, e.from_category_id, e.to_category_id, e.axis, e.relation, e.origin, e.weight,
            cf.key AS from_key, ct.key AS to_key, cf.name AS from_name, ct.name AS to_name
     FROM category_edge e
     JOIN category cf ON cf.id=e.from_category_id
     JOIN category ct ON ct.id=e.to_category_id
     ${where} ORDER BY e.axis, cf.key, ct.key`, params);
}

export async function setCategoryEdge(
  input: { from_category_id: number; to_category_id: number; relation?: string },
  ctx?: WriteCtx,
): Promise<CategoryEdgeRow> {
  if (input.from_category_id === input.to_category_id) throw new Error("자기 참조 엣지는 불가합니다");
  const origin = ctx?.source === "mcp" ? "agent" : "human";
  // 수동 저작 = axis 'should'(의도된 관계). is 는 스캔 upsert 전용.
  return one(itemsPool,
    `INSERT INTO category_edge(from_category_id, to_category_id, axis, relation, origin, created_at, updated_at)
     VALUES($1,$2,'should',COALESCE($3,'depends_on'),$4,now(),now())
     ON CONFLICT (from_category_id, to_category_id, axis)
     DO UPDATE SET relation=EXCLUDED.relation, updated_at=now()
     RETURNING id, from_category_id, to_category_id, axis, relation, origin, weight`,
    [input.from_category_id, input.to_category_id, input.relation ?? null, origin]);
}

export async function removeCategoryEdge(id: number): Promise<{ deleted: boolean; id: number }> {
  const r = await itemsPool.query(`DELETE FROM category_edge WHERE id=$1 AND axis='should'`, [id]);
  if (!r.rowCount) throw new Error(`should 엣지 #${id} 없음(is 엣지는 스캔 소유라 수동 삭제 불가)`);
  return { deleted: true, id };
}
