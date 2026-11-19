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
               WHERE oc.embedding_vector IS NOT NULL AND oc.id <> c.id AND oc.state = 'active'
               ORDER BY (k.embedding_vector <=> oc.embedding_vector) LIMIT 1) AS near_key,
             (SELECT oc.id FROM category oc
               WHERE oc.embedding_vector IS NOT NULL AND oc.id <> c.id AND oc.state = 'active'
               ORDER BY (k.embedding_vector <=> oc.embedding_vector) LIMIT 1) AS near_id,
             (SELECT (k.embedding_vector <=> oc.embedding_vector) FROM category oc
               WHERE oc.embedding_vector IS NOT NULL AND oc.id <> c.id AND oc.state = 'active'
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
      severity: (margin > 0.25 ? "warn" : "note") as Finding["severity"],
      summary: `‘${r.title || r.name}’ 은(는) 지금 분류(${r.cat_name || r.cat_key})보다 ‘${r.near_key}’ 정의에 더 가깝습니다`,
      evidence: `정의 거리차 ${margin.toFixed(3)} (자기 ${Number(r.own_dist).toFixed(3)} → ${r.near_key} ${Number(r.near_dist).toFixed(3)}). ` +
        `임계 ${(m.threshold ?? MISMATCH_DEFAULT_MARGIN).toFixed(2)} 초과.`,
      proposed_action: {
        op: "move_category", name: String(r.name),
        from_category_id: Number(r.cat_id), to_category_id: Number(r.near_id), to_category_key: String(r.near_key),
      },
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

//  시각 두 개를 «내용이 바뀐 때» 로 잰다. 행의 updated_at 은 내용과 무관하게 오른다 — 지식은 제목·분류·속성 저장에,
//   자료는 커넥터의 다시 그리기(렌더링 변경)에. 그대로 쓰면 메타 수정만으로 발견이 사라지거나, 렌더링 일괄 갱신으로 발견이 쏟아진다.
//   자료의 원본 수정 시각은 저장되지 않아 원본 시각(occurred_at)으로 대신한다. 둘 다 없는 자료만 행 시각이다.
//  인용 관계는 derived_from(이 자료에서 나온 지식)만 본다 — cites(참고로 건 자료)가 새로워졌다고 결론이 낡은 것은 아니다.
//  탐지(detectOutdated)와 재판정(reevaluateOpenFindings)이 같은 식을 쓴다 — 갈리면 재판정이 방금 연 발견을 닫는다.
const OUTDATED_K_TIME = "COALESCE(k.body_updated_at, k.updated_at)";
const OUTDATED_S_TIME = "COALESCE(s.occurred_at, s.updated_at)";
const OUTDATED_JOIN = "JOIN knowledge_source ks ON ks.name = k.name AND ks.relation = 'derived_from' JOIN source s ON s.id = ks.source_id";

export async function detectOutdated(m: ManagerRow, limit: number): Promise<Finding[]> {
  const params: unknown[] = [];
  const conds = scopeConds(m, params);
  params.push(m.stale_days ?? OUTDATED_DEFAULT_DAYS);
  const daysP = `$${params.length}`;
  params.push(limit);
  const limP = `$${params.length}`;

  const rows = await q(itemsPool, `
    SELECT k.name, k.title, ${OUTDATED_K_TIME} AS k_time,
           max(${OUTDATED_S_TIME}) AS src_updated,
           count(*)::int AS src_count,
           (array_agg(s.title ORDER BY ${OUTDATED_S_TIME} DESC))[1] AS newest_src_title,
           EXTRACT(EPOCH FROM (max(${OUTDATED_S_TIME}) - ${OUTDATED_K_TIME})) / 86400 AS days_behind
      FROM knowledge k
      ${OUTDATED_JOIN}
     WHERE ${conds.join(" AND ")}
     GROUP BY k.name, k.title, k.body_updated_at, k.updated_at
    HAVING max(${OUTDATED_S_TIME}) > ${OUTDATED_K_TIME} + (${daysP} || ' days')::interval
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
      evidence: `이 지식 본문 갱신 ${new Date(String(r.k_time)).toISOString().slice(0, 10)} · ` +
        `인용 자료 ${r.src_count}건 중 최신 ${new Date(String(r.src_updated)).toISOString().slice(0, 10)}` +
        (r.newest_src_title ? ` (‘${String(r.newest_src_title).slice(0, 60)}’)` : "") +
        `. 근거가 바뀌었는데 결론이 안 바뀐 상태입니다.`,
      // 자동 적용 대상이 아니다 — 무엇을 어떻게 고칠지는 읽어 봐야 안다. 사람(또는 AI)에게 넘긴다.
      proposed_action: { op: "review_knowledge", name: String(r.name), reason: "source_newer", days_behind: days },
    };
  });
}

// ════════ 열린 발견 재판정(결정적 종류) ════════
//  탐지는 «지금 성립하는 것» 을 새로 열거나 다시 세기만 하고, 조건이 사라진 발견은 닫지 않았다 — 본문을 고쳐도 발견이 열린 채 쌓였다.
//  여기서 이 관리기의 열린 발견 **전부**를 탐지와 같은 술어로 다시 본다. 스코프 조건(lookback·match_categories 등)과 배치 크기는
//   걸지 않는다 — 범위에서 밀려났거나 이번 배치에 안 뽑혔다고 «해소» 로 닫으면 안 된다. 닫을 것과 사유만 돌려준다(닫기는 호출자가
//   id 마다 state='open' 조건으로 — 재판정 도중 사람이 반려한 발견을 덮지 않게).
export interface ReevalClose { id: number; resolution: string }
export async function reevaluateOpenFindings(m: ManagerRow): Promise<ReevalClose[]> {
  if (m.kind === "outdated") {
    const rows = await q(itemsPool, `
      SELECT f.id, k.name IS NOT NULL AND k.lifecycle = 'active' AS alive,
             COALESCE(${OUTDATED_K_TIME} > f.last_seen_at, false) AS body_changed,
             EXISTS (SELECT 1 FROM knowledge_source ks JOIN source s ON s.id = ks.source_id
                      WHERE ks.name = k.name AND ks.relation = 'derived_from'
                        AND ${OUTDATED_S_TIME} > ${OUTDATED_K_TIME} + ($2 || ' days')::interval) AS holds
        FROM org_manager_finding f
        LEFT JOIN knowledge k ON k.name = f.target_ref
       WHERE f.manager_id = $1 AND f.state = 'open' AND f.target_kind = 'knowledge'`,
      [m.id, m.stale_days ?? OUTDATED_DEFAULT_DAYS]);
    return rows.filter((r) => !(r.alive && r.holds)).map((r) => ({
      id: Number(r.id),
      //  last_seen_at 은 술어가 마지막으로 성립한 시각이다. 그 뒤에 본문이 바뀌었으면 본문 수정으로 풀린 것이고,
      //   아니면 판정식이 바뀌어(인용 관계·자료 시각) 더는 걸리지 않는 것이다. first_seen_at 은 재개된 발견에서 옛 수정을 잡아 쓰지 않는다.
      resolution: !r.alive ? "대상 지식이 없거나 활성이 아니어서 해소" : r.body_changed ? "본문 갱신으로 해소" : "판정 기준 변경으로 해소",
    }));
  }
  if (m.kind === "mismatch") {
    //  dedup_key 는 탐지가 만든 «지금 분류 key -> 더 가까운 분류 key». 지금도 그 분류에 있고, 가장 가까운 다른 활성 분류가 같고,
    //   거리차가 임계를 넘을 때만 성립한다. 키를 쪼개지 않고 탐지와 같은 식으로 다시 붙여 비교한다 — 분류 key 규칙이 도구 입력에서만
    //   걸려(categories.ts KEY_RE) 다른 생성 경로의 key 에 '->' 가 없다고 보장할 수 없다.
    const rows = await q(itemsPool, `
      SELECT f.id,
             EXISTS (
               SELECT 1 FROM knowledge k
                 JOIN knowledge_category kc ON kc.name = k.name AND kc.state <> 'rejected'
                 JOIN category c ON c.id = kc.category_id
                 CROSS JOIN LATERAL (
                   SELECT oc.key, (k.embedding_vector <=> oc.embedding_vector) AS dist FROM category oc
                    WHERE oc.embedding_vector IS NOT NULL AND oc.id <> c.id AND oc.state = 'active'
                    ORDER BY (k.embedding_vector <=> oc.embedding_vector) LIMIT 1) near
                WHERE k.name = f.target_ref AND k.lifecycle = 'active'
                  AND k.embedding_vector IS NOT NULL AND c.embedding_vector IS NOT NULL
                  AND COALESCE(k.is_folder, false) = false AND k.name <> ('category-home-' || c.key)
                  AND (c.key || '->' || near.key) = f.dedup_key
                  AND ((k.embedding_vector <=> c.embedding_vector) - near.dist) > $2) AS holds
        FROM org_manager_finding f
       WHERE f.manager_id = $1 AND f.state = 'open' AND f.target_kind = 'knowledge'`,
      [m.id, m.threshold ?? MISMATCH_DEFAULT_MARGIN]);
    return rows.filter((r) => !r.holds).map((r) => ({ id: Number(r.id), resolution: "분류 변경으로 해소" }));
  }
  return [];
}

// ════════ ③ 지식 간 모순 — 2단(후보 SQL → LLM) ════════
//  SQL 이 할 수 있는 것은 '**닮은 쌍 찾기**'까지다. 닮았다고 모순인 건 아니다(대개는 그냥 관련 문서다).
//  실제 상충 판정은 LLM 이 한다 — 이 함수는 그 후보만 낸다.
//  ⚠ 쌍 폭발 방지: 유사도 상위만, name < other_name 으로 한 방향만(A-B 와 B-A 를 둘 다 내지 않는다).
export const CONTRADICTION_DEFAULT_SIM = 0.85;

export interface ContradictionCandidate {
  a: string; a_title: string | null; b: string; b_title: string | null; similarity: number;
}

// 후보 = 스코프 지식 k 마다 HNSW 최근접 이웃 CONTRADICTION_NEIGHBORS 개 중 임계 이상인 쌍.
//  ⚠ 전쌍 자기조인(JOIN ... ON 거리 <= 임계)으로 되돌리지 마라 — 거리 술어는 인덱스를 못 타 n² 스캔이 되고,
//   임베딩 수천 건 규모에서 statement timeout 으로 관리기가 통째로 실패했다.
//  LATERAL 안의 ORDER BY 는 관례상 인덱스 열을 왼쪽에 둔다(`o.embedding_vector <=> k.embedding_vector`) —
//   테스트가 이 모양을 못박는다.
//  한계(근사): 임계 이상 유사 쌍이 k 의 이웃 N개 밖에 있으면 빠진다(닮은 문서가 N개 넘게 몰린 군집).
//   o.name > k.name 을 바깥에서 거르므로 쌍 (A,B) 는 A 의 이웃 목록에서만 살아남는다 — B 의 목록에 A 가 있어도
//   B 가 스코프 밖이거나 이름이 커서 그 쪽 행은 버려진다. 또 HNSW 는 근사라 이웃 순위 자체가 정확하지 않을 수 있다.
//   o 쪽 술어(lifecycle·폴더)는 인덱스가 뽑은 뒤 걸러지므로 비활성·폴더가 이웃 자리를 차지하면 N 보다 적게 남는다.
//  N=40 과 ef_search=100: 인덱스 스캔은 hnsw.ef_search(기본 40)개보다 많이 돌려주지 않고(iterative scan 기본 꺼짐),
//   LIMIT 을 ef_search 와 같게 두면 후보 목록 꼬리(30~40위)의 리콜이 가장 나쁘다. 자기 행·비활성·폴더가 그 자리를
//   먹은 뒤 남는 게 꼬리라 손실이 겹친다. 그래서 탐색 폭은 100 으로 넓히고 쓰는 이웃은 40 으로 둔다
//   (pgvector 권장 ef_search > LIMIT). ef_search 는 트랜잭션 안 SET LOCAL 로만 건다 — 세션 SET 은 풀 커넥션에 샌다.
//  플래너는 이 LATERAL 에서 HNSW 경로를 만들긴 하지만 비용 추정에서 «순차 스캔 + top-N 정렬» 에 진다(지식 수천 건이면
//   HNSW 시작 비용 추정이 순차 스캔 전체 비용보다 크다). 그래서 대체 경로(seqscan·bitmapscan·sort)를 SET LOCAL 로 끈다.
//   끄지 않으면 행마다 테이블 전체를 훑어 수천 건에서 수 분이 걸린다 — prod EXPLAIN ANALYZE(2026-10-11)에서 행당
//   33ms(순차) 대 1.2ms(HNSW), 전체 6.3초. 끄는 설정은 «금지» 가 아니라 «비용 가산» 이라 다른 경로가 없으면 그대로 쓰인다
//   (바깥 ORDER BY similarity 의 정렬처럼). 검증: 같은 SQL 을 이 SET LOCAL 아래 EXPLAIN 해 Index Scan using
//   knowledge_embedding_hnsw 가 보이는지.
export const CONTRADICTION_NEIGHBORS = 40;
export const CONTRADICTION_EF_SEARCH = 100;
export const CONTRADICTION_PLANNER_OFF = ["enable_seqscan", "enable_bitmapscan", "enable_sort"] as const;

/** 후보 SQL 조립(순수) — 술어 보존을 테스트가 문자열로 못박는다. conds 는 scopeConds(…,"k") 결과. */
export function contradictionCandidateSql(conds: string[], distP: string, limP: string): string {
  return `
    SELECT k.name AS a, k.title AS a_title, o.name AS b, o.title AS b_title,
           (1 - o.dist) AS similarity
      FROM knowledge k
     CROSS JOIN LATERAL (
       SELECT o.name, o.title, (o.embedding_vector <=> k.embedding_vector) AS dist
         FROM knowledge o
        WHERE o.lifecycle='active' AND o.embedding_vector IS NOT NULL
          AND COALESCE(o.is_folder,false) = false
          AND o.name <> k.name
        ORDER BY o.embedding_vector <=> k.embedding_vector
        LIMIT ${CONTRADICTION_NEIGHBORS}
     ) o
     WHERE ${conds.join(" AND ")}
       AND k.embedding_vector IS NOT NULL
       AND COALESCE(k.is_folder,false) = false
       AND o.name > k.name
       AND o.dist <= ${distP}
     ORDER BY similarity DESC
     LIMIT ${limP}`;
}

export async function findContradictionCandidates(m: ManagerRow, limit: number): Promise<ContradictionCandidate[]> {
  const params: unknown[] = [];
  const conds = scopeConds(m, params, "k");
  // 코사인 거리 = 1 - 유사도. 임계 유사도 이상 = 거리 (1-sim) 이하.
  params.push(1 - (m.threshold ?? CONTRADICTION_DEFAULT_SIM));
  const distP = `$${params.length}`;
  params.push(limit);
  const limP = `$${params.length}`;

  const client = await itemsPool.connect();
  let rows: Record<string, unknown>[];
  let broken: Error | undefined;
  //  ⚠ 체크아웃해 쥔 동안 커넥션이 끊기면(DB 재시작·장애조치·pg_terminate_backend) pg 클라이언트가 'error' 를 낸다.
  //   리스너가 없으면 Node 가 그걸 uncaughtException 으로 바꿔 게이트웨이가 통째로 재기동한다(열린 터미널이 전부
  //   끊긴다). pool.query 는 이 리스너를 스스로 달지만 connect() 로 받은 클라이언트엔 없다 — 후보 쿼리는 수 초가
  //   걸려 그 창이 넓다. 받은 오류는 broken 에 남겨 아래 release(err) 로 그 커넥션을 폐기한다.
  //   (실측 2026-10-14: 쿼리 도중 백엔드를 끊으면 리스너 없이는 프로세스가 죽고, 있으면 거부로 끝난다.)
  const onError = (e: Error): void => { broken ??= e; };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL hnsw.ef_search = ${CONTRADICTION_EF_SEARCH}`);
    for (const g of CONTRADICTION_PLANNER_OFF) await client.query(`SET LOCAL ${g} = off`);
    rows = (await client.query(contradictionCandidateSql(conds, distP, limP), params)).rows as Record<string, unknown>[];
    await client.query("COMMIT");
  } catch (e) {
    //  ROLLBACK 마저 실패하면 커넥션이 죽은 것이다 — 풀에 돌려보내지 않고 폐기한다(release(err)).
    await client.query("ROLLBACK").catch((re: Error) => { broken ??= re; });
    throw e;
  } finally {
    client.removeListener("error", onError);
    client.release(broken);
  }

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

/**
 * 코드 괴리 후보 — **지식 쪽**(#3579).
 *
 * ⚠ 왜 따로 필요한가: 위 `findCodeDriftCandidates` 는 **도메인 정의(category.should)** 만 후보로 낸다.
 *  그런데 이 판정기의 종류 이름은 «지식 ↔ 코드 비교» 이고, 관리기 설정도 지식 필터(match_types)로 쓰이고
 *  있었다 — 즉 **설정이 약속하는 것과 구현이 보는 것이 갈라져 있었다.** 그래서 «지식이 «이 함수가 X 를
 *  막는다» 고 적었는데 그 심볼이 코드에 없다» 는 자리를 **아무도 안 보고 있었다.**
 *
 *  실측(#3579, 2026-09-07): 2026-08-28 지식이 `defaultWorkspaceId()` 로 고쳤다고 적어 뒀는데 그 심볼은
 *  전 브랜치 어디에도 커밋된 적이 없었다. 지식만 «고쳤다» 고 말하고 코드엔 없는 상태가 열흘 갔고,
 *  그 사이 같은 버그를 #3564 가 처음부터 다시 진단했다. 이 후보 경로가 있었으면 기계가 먼저 물었을 것이다.
 *
 *  후보 조건: 활성 지식 + 관리기 스코프(scopeConds) + **레포가 연결된 도메인에 속할 것**.
 *  레포를 요구하는 이유는 category 쪽과 같다 — 읽을 코드가 어디 있는지 모르면 AI 가 추측한다(#1419 T8).
 */
export interface CodeDriftKnowledgeCandidate {
  name: string; title: string | null; type: string | null;
  repos: string[]; category_keys: string[]; updated_at: string | null;
  /** 작업 기록 원천(findCodeDriftTouchCandidates)만 — 지식 본문 뒤에 바뀐 모듈(repos[0] 의 것, 최근 순). */
  changed_units?: Array<{ path: string; changed_at: string }>;
}

/** Postgres undefined_table — 선택 기능의 테이블이 없는 배포를 오류와 구분한다. */
const UNDEFINED_TABLE = "42P01";

export async function findCodeDriftKnowledgeCandidates(m: ManagerRow, limit: number): Promise<CodeDriftKnowledgeCandidate[]> {
  const params: unknown[] = [];
  const conds = scopeConds(m, params, "k");
  params.push(limit);
  const limP = `$${params.length}`;
  try {
    const rows = await q(itemsPool, `
      SELECT k.name, k.title, k.type, k.updated_at,
             ARRAY_AGG(DISTINCT c.key)   AS category_keys,
             ARRAY_AGG(DISTINCT cr.repo) AS repos
        FROM knowledge k
        JOIN knowledge_category kc ON kc.name = k.name AND kc.state <> 'rejected'
        JOIN category c            ON c.id = kc.category_id
        JOIN category_repo cr      ON cr.category_id = c.id
       WHERE ${conds.join(" AND ")}
       GROUP BY k.name, k.title, k.type, k.updated_at
       ORDER BY k.updated_at DESC
       LIMIT ${limP}`, params);
    return rows.map((r) => ({
      name: String(r.name), title: (r.title ?? null) as string | null, type: (r.type ?? null) as string | null,
      repos: (r.repos as string[]) ?? [], category_keys: (r.category_keys as string[]) ?? [],
      updated_at: r.updated_at ? String(r.updated_at) : null,
    }));
  } catch (e) {
    if ((e as { code?: string })?.code === UNDEFINED_TABLE) return [];   // category_repo 부재(레포를 안 쓰는 배포) — 볼 것이 없다
    throw e;
  }
}

/**
 * 코드 괴리 후보 — **작업 기록 원천**. 지식을 산출·결정한 작업 기록이 건드린 모듈을, 지식 본문과 그 작업 뒤에 커밋 작업이 다시 건드린 것.
 *  분류에 레포가 없어도 바뀐 모듈의 레포를 알기 때문에 그 레포를 싣는다(분류의 첫 레포는 대표값일 뿐 실제로 바뀐 곳이 아니다).
 *
 *  · 모듈 변경 시각은 그 모듈을 건드린 커밋 작업 기록의 시각이다 — 도메인맵의 모듈 내용 변경 시각이 아직 없어 대신 쓴다.
 *    committed_at 이 없는 기록이면 커밋 시각이 아니라 기록 시각이다. 아래 findCodeDriftCandidates 가 쓰는 code_unit.updated_at 은
 *    모듈이 생기거나 옮겨질 때만 오르는 구조 변경 시각이라(모듈 안 파일 수정은 refresh 가 건드리지 않는다) 여기 쓸 수 없다.
 *  · 14일 여유: 같은 작업의 MR 이 늦게 머지돼 작업 기록 뒤 커밋이 다시 기록되는 경우를 오탐으로 올리지 않으려는 값이다.
 *    본문 시각에도 붙이는 것은 본문을 고친 그 작업의 커밋이 뒤늦게 기록되는 경우도 같기 때문이다. 대가로 창 안의 변경은
 *    뒤에 다른 변경이 오지 않는 한 영영 후보가 되지 않는다.
 *  · 지식을 낸 작업의 커밋과 같은 sha 의 기록은 어느 모듈에서든 변경이 아니다 — 같은 커밋을 늦게 다시 기록한 것이다.
 *    제외 집합은 지식 단위다(지식×모듈 단위로 모으면 다른 모듈에 붙은 재기록이 변경으로 세진다).
 *  · 변경은 커밋이 달린 작업 기록의 touch 만 센다(유도·호출자 모두). 조사·리뷰 기록의 touch 는 «읽었다» 일 수 있다.
 *  · 같은 모듈에 지식을 낸 작업이 여럿이면 가장 늦은 것을 기준으로 본다 — 변경 뒤 그 지식을 다시 냈으면 이미 대조한 것이다.
 *  · 스코프의 lookback_days 는 걸지 않는다. 그 조건은 «최근에 고친 지식» 인데 이 원천은 «오래 안 고친 지식» 을 찾는다
 *    — 걸면 lookback 을 둔 관리기에서 이 원천이 늘 빈다.
 *  · 지식 하나는 한 레포(가장 최근 변경)로 접는다 — 레포마다 따로 위탁하면 같은 지식을 두 번 대조한다.
 *  ⚠ 지식×모듈 행을 그 모듈의 touch 전부와 조인하지 마라 — 모듈당 touch 수의 제곱으로 커진다. 모듈별 커밋에 시각 순번을 한 번
 *   매기고, 지식×모듈마다 «제외되지 않은 가장 작은 순번» 하나만 찾는다. 그 순번은 1 이거나 «제외된 순번 + 1» 중 하나라서
 *   (빈자리는 제외된 순번 바로 뒤에서만 생긴다), 후보를 그 둘로 만들고 제외된 순번을 등호 안티조인으로 빼면 모든 조인이 등호다.
 *   순번을 범위 조건(rn <= n)이나 generate_series 로 펼치지 마라 — 추정치가 낮으면 플래너가 nested loop 를 골라, 산출 sha 가
 *   몰린 지식 하나가 (그 sha 수 × 모듈 커밋 수)를 훑는다(편중 데이터에서 같은 쿼리가 데이터 무작위성에 따라 3초와 10분으로 갈렸다).
 *  ⚠ 테이블 없음(42P01)만 빈 결과다. 다른 SQL 오류를 삼키면 관리기가 매주 후보 0건을 ok 로 내며 조용히 죽는다.
 */
export const CODE_DRIFT_TOUCH_GRACE_DAYS = 14;

export async function findCodeDriftTouchCandidates(m: ManagerRow, limit: number): Promise<CodeDriftKnowledgeCandidate[]> {
  const params: unknown[] = [];
  const conds = scopeConds({ ...m, lookback_days: null }, params, "k");
  params.push(CODE_DRIFT_TOUCH_GRACE_DAYS);
  const graceP = `$${params.length}`;
  params.push(limit);
  const limP = `$${params.length}`;
  try {
    const rows = await q(itemsPool, `
      WITH kk AS (
        SELECT k.name, COALESCE(k.body_updated_at, k.updated_at) AS body_at
          FROM knowledge k
         WHERE ${conds.join(" AND ")}
      ), origin AS (
        SELECT ak.name, t.target_id AS unit_id, max(COALESCE(a.committed_at, a.created_at)) AS origin_at
          FROM activity_knowledge ak
          JOIN kk               ON kk.name = ak.name
          JOIN activity a       ON a.id = ak.activity_id
          JOIN activity_touch t ON t.activity_id = a.id AND t.target_kind = 'code_unit'
         WHERE ak.relation IN ('produced', 'decided')
         GROUP BY ak.name, t.target_id
      ), origin_sha AS (
        SELECT DISTINCT ak.name, a.commit_sha
          FROM activity_knowledge ak
          JOIN kk         ON kk.name = ak.name
          JOIN activity a ON a.id = ak.activity_id AND a.commit_sha IS NOT NULL
         WHERE ak.relation IN ('produced', 'decided')
      ), unit_commit AS (
        SELECT t2.target_id AS unit_id, a2.commit_sha, max(COALESCE(a2.committed_at, a2.created_at)) AS changed_at
          FROM activity_touch t2
          JOIN activity a2 ON a2.id = t2.activity_id AND a2.commit_sha IS NOT NULL
         WHERE t2.target_kind = 'code_unit' AND t2.target_id IN (SELECT unit_id FROM origin)
         GROUP BY t2.target_id, a2.commit_sha
      ), ranked AS (
        SELECT uc.unit_id, uc.commit_sha, uc.changed_at,
               row_number() OVER (PARTITION BY uc.unit_id ORDER BY uc.changed_at DESC, uc.commit_sha) AS rn
          FROM unit_commit uc
      ), excl_rank AS (
        SELECT os.name, r.unit_id, r.rn
          FROM origin_sha os
          JOIN ranked r ON r.commit_sha = os.commit_sha
      ), cand AS (
        SELECT o.name, o.unit_id, 1::bigint AS rn FROM origin o
        UNION
        SELECT e.name, e.unit_id, e.rn + 1 FROM excl_rank e
      ), first_kept AS (
        SELECT c.name, c.unit_id, min(c.rn) AS rn
          FROM cand c
          LEFT JOIN excl_rank e ON e.name = c.name AND e.unit_id = c.unit_id AND e.rn = c.rn
         WHERE e.name IS NULL
         GROUP BY c.name, c.unit_id
      ), changed AS (
        SELECT o.name, o.unit_id, r.changed_at
          FROM origin o
          JOIN kk            ON kk.name = o.name
          JOIN first_kept f  ON f.name = o.name AND f.unit_id = o.unit_id
          JOIN ranked r      ON r.unit_id = f.unit_id AND r.rn = f.rn
         WHERE r.changed_at > kk.body_at + (${graceP} || ' days')::interval
           AND r.changed_at > o.origin_at + (${graceP} || ' days')::interval
      ), per_repo AS (
        SELECT c.name, r.name AS repo, max(c.changed_at) AS changed_at,
               json_agg(json_build_object('path', cu.path, 'changed_at', c.changed_at) ORDER BY c.changed_at DESC, cu.path) AS units
          FROM changed c
          JOIN code_unit cu ON cu.id = c.unit_id AND (cu.state = 'active' OR cu.state IS NULL)
          JOIN repo r       ON r.id = cu.repo_id AND r.name IS NOT NULL AND (r.state = 'active' OR r.state IS NULL)
         GROUP BY c.name, r.name
      ), pick AS (
        SELECT DISTINCT ON (p.name) p.name, p.repo, p.changed_at, p.units
          FROM per_repo p
         ORDER BY p.name, p.changed_at DESC, p.repo
      )
      SELECT k.name, k.title, k.type, k.updated_at, pick.repo, pick.units,
             COALESCE((SELECT ARRAY_AGG(DISTINCT c.key) FROM knowledge_category kc JOIN category c ON c.id = kc.category_id
                        WHERE kc.name = k.name AND kc.state <> 'rejected'), ARRAY[]::text[]) AS category_keys
        FROM pick JOIN knowledge k ON k.name = pick.name
       ORDER BY pick.changed_at DESC, k.name
       LIMIT ${limP}`, params);
    return rows.map((r) => ({
      name: String(r.name), title: (r.title ?? null) as string | null, type: (r.type ?? null) as string | null,
      repos: [String(r.repo)], category_keys: (r.category_keys as string[]) ?? [],
      updated_at: r.updated_at ? String(r.updated_at) : null,
      changed_units: ((r.units as Array<{ path: string; changed_at: string }>) ?? [])
        .map((u) => ({ path: String(u.path), changed_at: new Date(String(u.changed_at)).toISOString() })),
    }));
  } catch (e) {
    if ((e as { code?: string })?.code === UNDEFINED_TABLE) return [];   // 도메인맵·작업 기록 표가 없는 배포 — 볼 것이 없다
    throw e;
  }
}

/**
 * 두 지식 후보 원천을 limit 까지 합친다. 같은 지식은 작업 기록 원천의 것(바뀐 모듈의 레포)을 쓴다 — 지식 하나를 두 레포에서 대조하지 않게.
 *  몫을 나누는 이유: 작업 기록 원천 후보는 본문을 고치기 전까지 빠지지 않아, 앞에서부터 채우면 매주 자리를 다 차지해 분류 원천이
 *  영영 0건이 된다. 작업 기록 원천은 ceil(limit/2) 까지, 나머지는 분류 원천이고, 한쪽이 모자라면 다른 쪽이 남은 자리를 채운다.
 */
export function mergeCodeDriftKnowledgeCandidates(
  touched: readonly CodeDriftKnowledgeCandidate[], byCategory: readonly CodeDriftKnowledgeCandidate[], limit: number,
): CodeDriftKnowledgeCandidate[] {
  const touchBy = new Map(touched.map((d) => [d.name, d] as const));
  const out = new Map<string, CodeDriftKnowledgeCandidate>();
  for (const d of touched.slice(0, Math.ceil(limit / 2))) out.set(d.name, d);
  for (const d of byCategory) {
    if (out.size >= limit) break;
    if (!out.has(d.name)) out.set(d.name, touchBy.get(d.name) ?? d);
  }
  for (const d of touched) {
    if (out.size >= limit) break;
    if (!out.has(d.name)) out.set(d.name, d);
  }
  return [...out.values()];
}

export async function findCodeDriftCandidates(m: ManagerRow, limit: number): Promise<CodeDriftCandidate[]> {
  const params: unknown[] = [];
  const conds: string[] = ["COALESCE(c.should,'') <> ''"];
  if (m.match_categories?.length) { params.push(m.match_categories); conds.push(`c.key = ANY($${params.length}::text[])`); }
  params.push(limit);
  const limP = `$${params.length}`;

  // 코드유닛→카테고리는 mapping.category_id 에 있다(code_unit 엔 카테고리 컬럼이 없다 — 도메인맵 목록 listProductDomains 와 같은 조인).
  //  도메인맵 테이블이 아예 없는 배포만 빈 결과로 본다. 그 밖의 오류(컬럼 이름 착오 등)를 삼키면 관리기가 status ok 로
  //  매번 후보 0건을 내며 조용히 죽으므로 run_managers 의 오류 기록으로 올린다.
  try {
    const rows = await q(itemsPool, `
      SELECT c.id AS category_id, c.key, c.name, c.should, c.updated_at AS should_updated,
             COALESCE((SELECT ARRAY_AGG(cr.repo ORDER BY cr.repo) FROM category_repo cr WHERE cr.category_id=c.id), ARRAY[]::text[]) AS repos,
             (SELECT count(*)::int FROM mapping m JOIN code_unit cu ON cu.id = m.target_id
               WHERE m.category_id = c.id AND m.target_kind = 'code_unit' AND m.status <> 'rejected'
                 AND COALESCE(cu.state, 'active') = 'active') AS unit_count,
             (SELECT max(cu.updated_at) FROM mapping m JOIN code_unit cu ON cu.id = m.target_id
               WHERE m.category_id = c.id AND m.target_kind = 'code_unit' AND m.status <> 'rejected'
                 AND COALESCE(cu.state, 'active') = 'active') AS code_updated
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
    if ((e as { code?: string })?.code === UNDEFINED_TABLE) return []; // 도메인맵 미사용 배포 — 이 관리기는 할 일이 없다
    throw e;
  }
}
