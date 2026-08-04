// 관리기 판정기(#1419 T5) — 4종이 실제로 '무엇을 문제로 보는가'.
//
//  판정 방식이 둘로 갈린다(설계의 핵심):
//   · 결정적 SQL — mismatch · outdated. LLM 없이 즉시·무료. 매 주기 전수 판정해도 부담이 없다.
//   · 2단(SQL 후보 → LLM 판정) — contradiction · code_drift. "실제로 상충하나"는 의미 판단이라 SQL 로는 못 낸다.
//     후보 좁히기를 안 하면 전 지식 쌍(n²)을 LLM 에 먹인다 — 증류에서 이미 실측된 비용 구조다(#1289).
//
//  ⚠ 판정기는 **발견만 만든다.** 고치는 것은 조치(apply-action.ts)가 하고, 그것도 action_level 이 허락할 때만.
//   관리기는 '이미 사람이 정리해 둔 것'을 건드리므로 오탐 한 번의 반경이 크다 — 기본은 report(쌓기만)다.
import { itemsPool, q } from "../../db/client.js";
import type { ManagerRow } from "../store/managers.js";

/** 판정 결과 1건 — 저장(upsertFinding)이 이 모양을 받는다. */
export interface Finding {
  target_kind: "knowledge" | "category" | "domain";
  target_ref: string;
  dedup_key?: string;
  severity: "note" | "warn" | "high";
  summary: string;
  evidence?: string;
  /** 조치안 — action_level 이 propose/auto 일 때 apply-action 이 읽는다. */
  proposed_action?: Record<string, unknown>;
}

/** 스코프 조건 — 4종이 공유한다. params 는 공유 배열(자리표시자는 길이에서 파생). */
function scopeConds(m: ManagerRow, params: unknown[], alias = "k"): string[] {
  const w: string[] = [`${alias}.lifecycle='active'`];
  if (m.match_types?.length) { params.push(m.match_types); w.push(`${alias}.type = ANY($${params.length}::text[])`); }
  if (m.match_provenance) { params.push(m.match_provenance); w.push(`${alias}.provenance = $${params.length}`); }
  if (m.exclude_names?.length) { params.push(m.exclude_names); w.push(`NOT (${alias}.name = ANY($${params.length}::text[]))`); }
  if (m.lookback_days) { params.push(m.lookback_days); w.push(`${alias}.updated_at >= now() - ($${params.length} || ' days')::interval`); }
  if (m.match_categories?.length) {
    params.push(m.match_categories);
    w.push(`EXISTS (SELECT 1 FROM knowledge_category kc JOIN category c ON c.id=kc.category_id
              WHERE kc.name=${alias}.name AND kc.state<>'rejected' AND c.key = ANY($${params.length}::text[]))`);
  }
  if (m.match_spaces?.length) {
    params.push(m.match_spaces);
    w.push(`EXISTS (SELECT 1 FROM knowledge_category kc2 JOIN category c2 ON c2.id=kc2.category_id
              WHERE kc2.name=${alias}.name AND kc2.state<>'rejected' AND c2.space = ANY($${params.length}::text[]))`);
  }
  return w;
}

// ════════ ① 분류 어긋남 — 결정적 ════════
//  이미 분류체계 탭이 세고 있던 신호(#1153)를 **보정 제안까지** 끌고 온다. 종전엔 배지가 개수만 보여 주고
//  거기서 끝이었다 — 무엇을 어디로 옮겨야 하는지는 사람이 매번 다시 판단해야 했다.
//
//  판정: "자기 정의와의 거리 − 가장 가까운 다른 정의와의 거리" 가 마진을 넘으면 어긋남.
//   즉 '남의 분류 정의에 더 어울린다'. 제안 조치 = 그 가까운 분류로 이동.
//  ⚠ 대문 문서·폴더는 뺀다 — 목차·색인이라 어떤 정의에서도 구조적으로 멀다(거짓 양성 고정 발생원, #1153 기록).
export const MISMATCH_DEFAULT_MARGIN = 0.1;

export async function detectMismatch(m: ManagerRow, limit: number): Promise<Finding[]> {
  const params: unknown[] = [];
  const conds = scopeConds(m, params);
  params.push(m.threshold ?? MISMATCH_DEFAULT_MARGIN);
  const marginP = `$${params.length}`;
  params.push(limit);
  const limP = `$${params.length}`;

  const rows = await q(itemsPool, `
    WITH scored AS (
      SELECT k.name, k.title, c.id AS cat_id, c.key AS cat_key, c.name AS cat_name,
             (k.embedding_vector <=> c.embedding_vector) AS own_dist,
             (SELECT oc.key FROM category oc
               WHERE oc.embedding_vector IS NOT NULL AND oc.id <> c.id
               ORDER BY (k.embedding_vector <=> oc.embedding_vector) LIMIT 1) AS near_key,
             (SELECT oc.id FROM category oc
               WHERE oc.embedding_vector IS NOT NULL AND oc.id <> c.id
               ORDER BY (k.embedding_vector <=> oc.embedding_vector) LIMIT 1) AS near_id,
             (SELECT (k.embedding_vector <=> oc.embedding_vector) FROM category oc
               WHERE oc.embedding_vector IS NOT NULL AND oc.id <> c.id
               ORDER BY (k.embedding_vector <=> oc.embedding_vector) LIMIT 1) AS near_dist
        FROM knowledge_category kc
        JOIN knowledge k ON k.name = kc.name
        JOIN category  c ON c.id = kc.category_id
       WHERE ${conds.join(" AND ")}
         AND kc.state <> 'rejected'
         AND k.embedding_vector IS NOT NULL AND c.embedding_vector IS NOT NULL
         AND COALESCE(k.is_folder,false) = false
         AND k.name <> ('category-home-' || c.key)
    )
    SELECT * FROM scored
     WHERE near_key IS NOT NULL AND (own_dist - near_dist) > ${marginP}
     ORDER BY (own_dist - near_dist) DESC
     LIMIT ${limP}`, params);

  return rows.map((r) => {
    const margin = Number(r.own_dist) - Number(r.near_dist);
    return {
      target_kind: "knowledge" as const,
      target_ref: String(r.name),
      // 같은 지식이라도 '어느 분류에서 어긋났나'가 다르면 다른 문제다(복수 분류 지식).
      dedup_key: `${r.cat_key}->${r.near_key}`,
      // ⚠ 심각도 컷을 0.25 → 0.18 로 내렸다. 실측(라이블리 지식 587 매핑) 최대 마진이 0.256 이라
      //  0.25 컷에서는 43건 중 1건만 warn 이 되고 나머지가 note 로 뭉쳐 우선순위가 사라졌다.
      //  ⚠⚠ 그런데 마진이 클수록 정확한 것도 아니다 — 실측에서 **최대 마진 1건이 오탐**이었다
      //  (주제어 자석이 셀수록 거리차가 커진다). 그래서 warn 은 '먼저 볼 것'일 뿐 '더 확실한 것'이 아니다.
      severity: (margin > 0.18 ? "warn" : "note") as Finding["severity"],
      summary: `‘${r.title || r.name}’ 은(는) 지금 분류(${r.cat_name || r.cat_key})보다 ‘${r.near_key}’ 정의에 더 가깝습니다`,
      evidence: `정의 거리차 ${margin.toFixed(3)} (자기 ${Number(r.own_dist).toFixed(3)} → ${r.near_key} ${Number(r.near_dist).toFixed(3)}). ` +
        `임계 ${(m.threshold ?? MISMATCH_DEFAULT_MARGIN).toFixed(2)} 초과.\n` +
        // 실측된 오탐 발생원을 증거문에 붙인다 — 사람이 이 두 줄만 읽고 대부분을 즉시 걸러낼 수 있다.
        //  이걸 안 적으면 매번 같은 판단을 처음부터 다시 한다(#1195 가 21건을 손으로 판정한 그 작업).
        `⚠ 이건 **판정이 아니라 후보**입니다(실측 정밀도 2/21, #1195). 옮기기 전에 두 가지를 확인하세요 — ` +
        `① 자석 축: 정의에 흔한 낱말(조직명·일반명사)이 있으면 그 낱말을 담은 문서 전부가 끌립니다. ` +
        `② 주제어 겹침: 주제가 같아도 **문서의 역할**이 다르면 지금 분류가 맞습니다` +
        `(예: 경쟁사 하네스 비교는 '하네스'가 겹쳐도 시장·경쟁이 맞습니다). ` +
        `거리차가 클수록 정확한 게 아니라 **자석이 센 것**일 수 있습니다.`,
      // ⚠ proposed_action 을 만들지 않는다(#1419 도그푸드). 종전엔 move_category 를 채웠고, 그것이
      //  action_level='auto' 의 자동 적용 대상이자 propose 의 묶음 적용 대상이 됐다. 정밀도 2/21 에서
      //  auto 를 켜면 건드리는 10건 중 9건을 잘못 옮긴다 — 되돌릴 수 있게 만들었어도 사람이 정리해 둔
      //  분류를 대량으로 흔든다. 이 신호는 사람이 정의를 읽고 판정해야 하는 후보다.
      //  자동 이동을 맡길 수 있는 신호는 **구조 일관성**(같은 출처·트리 부모인데 축이 흩어짐)이고,
      //  그건 정밀도가 사실상 100% 다(#1195) — 별도 kind 로 만들 때 그쪽에 조치안을 붙인다.
    };
  });
}

// ════════ ② 지식 아웃데이티드 — 결정적 ════════
//  "원천이 움직였는데 지식은 그대로다." 두 신호를 본다:
//   ⓐ 인용한 자료(knowledge_source)가 지식보다 **나중에** 갱신됐다 — 근거가 바뀌었는데 결론이 안 바뀌었다.
//   ⓑ 미러 지식인데 원본 싱크는 계속 도는데 내용이 오래 안 바뀌었다 — 이건 정상일 때가 많아 **안 본다**.
//  ⓑ 를 뺀 이유: 안 바뀌는 문서가 낡은 문서는 아니다. 그걸 경보로 올리면 큐가 노이즈로 덮여
//   진짜 신호(ⓐ)가 묻힌다 — 거짓 경보가 반복되면 배지 자체가 무시된다(#1153 이 이미 배운 것).
export const OUTDATED_DEFAULT_DAYS = 30;

export async function detectOutdated(m: ManagerRow, limit: number): Promise<Finding[]> {
  const params: unknown[] = [];
  const conds = scopeConds(m, params);
  params.push(m.stale_days ?? OUTDATED_DEFAULT_DAYS);
  const daysP = `$${params.length}`;
  params.push(limit);
  const limP = `$${params.length}`;

  const rows = await q(itemsPool, `
    SELECT k.name, k.title, k.updated_at,
           max(s.updated_at) AS src_updated,
           count(*)::int AS src_count,
           (array_agg(s.title ORDER BY s.updated_at DESC))[1] AS newest_src_title,
           EXTRACT(EPOCH FROM (max(s.updated_at) - k.updated_at)) / 86400 AS days_behind
      FROM knowledge k
      JOIN knowledge_source ks ON ks.name = k.name
      JOIN source s ON s.id = ks.source_id
     WHERE ${conds.join(" AND ")}
     GROUP BY k.name, k.title, k.updated_at
    HAVING max(s.updated_at) > k.updated_at + (${daysP} || ' days')::interval
     ORDER BY days_behind DESC
     LIMIT ${limP}`, params);

  return rows.map((r) => {
    const days = Math.round(Number(r.days_behind));
    return {
      target_kind: "knowledge" as const,
      target_ref: String(r.name),
      dedup_key: "",
      severity: (days > 90 ? "warn" : "note") as Finding["severity"],
      summary: `‘${r.title || r.name}’ 의 근거 자료가 ${days}일 더 최신입니다 — 내용이 낡았을 수 있습니다`,
      evidence: `이 지식 갱신 ${new Date(String(r.updated_at)).toISOString().slice(0, 10)} · ` +
        `인용 자료 ${r.src_count}건 중 최신 ${new Date(String(r.src_updated)).toISOString().slice(0, 10)}` +
        (r.newest_src_title ? ` (‘${String(r.newest_src_title).slice(0, 60)}’)` : "") +
        `. 근거가 바뀌었는데 결론이 안 바뀐 상태입니다.`,
      // 자동 적용 대상이 아니다 — 무엇을 어떻게 고칠지는 읽어 봐야 안다. 사람(또는 AI)에게 넘긴다.
      proposed_action: { op: "review_knowledge", name: String(r.name), reason: "source_newer", days_behind: days },
    };
  });
}

// ════════ ③ 지식 간 모순 — 2단(후보 SQL → LLM) ════════
//  SQL 이 할 수 있는 것은 '**닮은 쌍 찾기**'까지다. 닮았다고 모순인 건 아니다(대개는 그냥 관련 문서다).
//  실제 상충 판정은 LLM 이 한다 — 이 함수는 그 후보만 낸다.
//  ⚠ 쌍 폭발 방지: 유사도 상위만, name < other_name 으로 한 방향만(A-B 와 B-A 를 둘 다 내지 않는다).
export const CONTRADICTION_DEFAULT_SIM = 0.85;

export interface ContradictionCandidate {
  a: string; a_title: string | null; b: string; b_title: string | null; similarity: number;
}

export async function findContradictionCandidates(m: ManagerRow, limit: number): Promise<ContradictionCandidate[]> {
  const params: unknown[] = [];
  const conds = scopeConds(m, params, "k");
  // 코사인 거리 = 1 - 유사도. 임계 유사도 이상 = 거리 (1-sim) 이하.
  params.push(1 - (m.threshold ?? CONTRADICTION_DEFAULT_SIM));
  const distP = `$${params.length}`;
  params.push(limit);
  const limP = `$${params.length}`;

  const rows = await q(itemsPool, `
    SELECT k.name AS a, k.title AS a_title, o.name AS b, o.title AS b_title,
           (1 - (k.embedding_vector <=> o.embedding_vector)) AS similarity
      FROM knowledge k
      JOIN knowledge o
        ON o.lifecycle='active' AND o.embedding_vector IS NOT NULL
       AND o.name > k.name
       AND (k.embedding_vector <=> o.embedding_vector) <= ${distP}
     WHERE ${conds.join(" AND ")}
       AND k.embedding_vector IS NOT NULL
       AND COALESCE(k.is_folder,false) = false AND COALESCE(o.is_folder,false) = false
     ORDER BY similarity DESC
     LIMIT ${limP}`, params);

  return rows.map((r) => ({
    a: String(r.a), a_title: (r.a_title ?? null) as string | null,
    b: String(r.b), b_title: (r.b_title ?? null) as string | null,
    similarity: Number(r.similarity),
  }));
}

// ════════ ④ 지식 ↔ 코드 — 2단(후보 SQL → LLM) ════════
//  도메인 정의(category.should)와 실제 코드(is — 매핑된 code_unit)의 괴리. 기존 eval_domain_debt 가
//  구조 부채를 재고 있었지만 그건 '매핑 구조'의 부채이고, 여기서 묻는 것은 **의미의 괴리**다:
//   "이 도메인이 하겠다고 적어 둔 것과 코드가 실제로 하는 것이 다른가."
//  SQL 이 낼 수 있는 것은 '검사할 가치가 있는 도메인' 목록이다 — should 가 있고, 코드가 매핑돼 있고,
//  둘 중 하나가 최근에 움직인 것. 판정은 LLM 이 코드를 읽어야 한다.
export interface CodeDriftCandidate {
  category_id: number; key: string; name: string | null; should: string;
  repos: string[]; unit_count: number; should_updated: string | null; code_updated: string | null;
}

export async function findCodeDriftCandidates(m: ManagerRow, limit: number): Promise<CodeDriftCandidate[]> {
  const params: unknown[] = [];
  const conds: string[] = ["COALESCE(c.should,'') <> ''"];
  if (m.match_spaces?.length) { params.push(m.match_spaces); conds.push(`c.space = ANY($${params.length}::text[])`); }
  if (m.match_categories?.length) { params.push(m.match_categories); conds.push(`c.key = ANY($${params.length}::text[])`); }
  params.push(limit);
  const limP = `$${params.length}`;

  // code_unit 매핑은 도메인맵 쪽 테이블이라 없을 수 있다 — 없으면 빈 결과로 떨어진다(에러 아님).
  try {
    const rows = await q(itemsPool, `
      SELECT c.id AS category_id, c.key, c.name, c.should, c.updated_at AS should_updated,
             COALESCE((SELECT ARRAY_AGG(cr.repo ORDER BY cr.repo) FROM category_repo cr WHERE cr.category_id=c.id), ARRAY[]::text[]) AS repos,
             -- ⚠ code_unit 에는 category_id 가 없다(컬럼: id·repo_id·kind·path·label·state·prev_path·…).
             --  분류축↔코드 매핑은 mapping 테이블에 산다(v6 가 domain_id → category_id 로 착지시킨 것).
             --  종전 코드가 code_unit.category_id 를 참조해 매 실행이 SQL 오류였고, 아래 catch 가 그것을
             --  '도메인맵 미사용'으로 삼켜 **항상 조용히 0건 + status=ok** 였다(#1419 도그푸드에서 발견).
             (SELECT count(*)::int FROM mapping mp
               WHERE mp.category_id = c.id AND mp.target_kind = 'code_unit' AND mp.status = 'confirmed') AS unit_count,
             (SELECT max(mp.updated_at) FROM mapping mp
               WHERE mp.category_id = c.id AND mp.target_kind = 'code_unit' AND mp.status = 'confirmed') AS code_updated
        FROM category c
       WHERE ${conds.join(" AND ")}
       ORDER BY c.updated_at DESC
       LIMIT ${limP}`, params);
    return rows
      // 코드가 하나도 안 붙은 도메인은 '괴리'를 물을 대상이 아니다(비교할 is 가 없다).
      .filter((r) => Number(r.unit_count) > 0)
      .map((r) => ({
        category_id: Number(r.category_id), key: String(r.key), name: (r.name ?? null) as string | null,
        should: String(r.should), repos: (r.repos as string[]) ?? [], unit_count: Number(r.unit_count),
        should_updated: r.should_updated ? String(r.should_updated) : null,
        code_updated: r.code_updated ? String(r.code_updated) : null,
      }));
  } catch (e) {
    // 관용은 **테이블 부재만**(도메인맵 미사용 배포). 그 외(컬럼 오타·문법)는 드러낸다 —
    //  종전에 전부 삼켜서 잘못된 컬럼 참조가 '0건 + status=ok' 로 몇 달 숨어 있었다(#1419).
    //  42P01 = undefined_table. 이 코드 외의 오류는 위로 던져 실행이 error 로 기록되게 한다.
    if ((e as { code?: string })?.code === "42P01") return [];
    throw e;
  }
}
