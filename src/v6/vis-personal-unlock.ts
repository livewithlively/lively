// #4007 — 개인 루트 업로드 자동 잠금의 **소급 해제**(멱등, 부팅마다).
//
//  배경: ingest/local-file.ts 가 개인 루트 업로드를 무조건 «올린 사람만»(visibility='members' + source_member 1행)
//   으로 잠갔다(#1436·#1631). 그 기제를 #4007 에서 걷어냈는데, 걷어내는 것만으로는 **이미 잠긴 행이 그대로 남는다** —
//   단건 공개범위를 바꾸는 수단이 코어에도 EE 에도 없어서(2026-09-16 실측) 사람이 손으로 풀 길이 없다.
//   그리고 그 잔존 잠금은 조용하지 않다: 하나라도 남아 있으면 anyLockedContext() 가 참이 되어
//   **조직 전체의 db_query self 조회가 막힌다**(db/self/self-guard.ts, v3 RLS 가 준비 안 된 배포에서).
//
//  왜 부팅마다 돌려도 되나 — 이 조정기는 «자동 잠금이 남긴 것»만 되돌리고, **정책이 생기는 순간 손을 뗀다**:
//   자료는 `external_system='local' ∧ fields.root='personal'` 이면서 그 테넌트에 로컬 대상 인입정책
//   (org_source_vis_policy, match_system='local')이 **하나도 없을 때만** 연다. EE 조직이 나중에 로컬 정책을 세우고
//   backfill 하면 그 테넌트는 이 조정기의 사정권에서 빠진다 — 사람이 정한 잠금을 다음 부팅이 되돌리지 않는다.
//
//  지식은 열지 **않고 다시 계산한다**: derived_from 근거가 하나 이상 있고 그 근거가 **전부** open 이 된 지식만 연다.
//   (근거로 생기는 지식 잠금은 derived-visibility.ts 한 곳에서만 생긴다 — knowledge_member 쓰기 자리가 거기뿐이다.)
//   슬랙 채널 정책 등 살아 있는 근거가 하나라도 남아 있으면 그 지식은 잠긴 채로 둔다.
//   ⚠ #4824 — 지식은 «이번 실행이 방금 연 자료» 에만 기대 잠긴 것만 연다(아래 쿼리 머리말). 종전엔 «근거가 지금 다 열려 있다»
//    만 봐서, 비공개 프로젝트 지식(리스트 grant)이 열린 자료를 근거로 하나만 가져도 부팅마다 전원 공개로 열렸다.
//    다른 근거(수집 단위·정책)로 잠긴 지식은 그 근거가 나중에 열려도 여기서 넓히지 않는다(지식 넓히기는 사람 몫).
//
//  ⚠ 여는 것은 되돌릴 수 없다. 그래서 조건을 넓히지 마라 — 특히 `external_system='local'` 과
//   `fields.root='personal'` 두 술어는 «자동 잠금이 만든 행» 의 정의 그 자체다.
//
//  #2202 — 같은 자리에서 **Zotero 개인 라이브러리** 자동 잠금도 푼다. 커넥터가 개인 라이브러리 자료를 주인에게 잠가
//   들여왔는데(RawItem.audience → stampSourceAudience), 워크스페이스에 연결한 자료는 팀과 함께 쓰는 것으로 정했다(장원준
//   2026-10-28). 잠금 기제는 커넥터에서 걷었고, 남은 잠긴 행을 여기서 연다. «자동 잠금이 만든 행» 의 정의:
//   `external_system='zotero'` ∧ `fields.library` 가 `users/…`(개인 라이브러리) ∧ 대상이 **정확히 그 주인 한 사람**
//   (`fields.owner_member`) ∧ 수집 단위가 대상을 정하는 연결이 없음 ∧ 그 테넌트에 Zotero 인입정책이 없음.
//   대상이 주인 말고 한 명이라도 더 있거나 다르면(사람·정책이 정한 것) 건드리지 않는다.
import { itemsPool, withTx } from "../db/client.js";
import { logger } from "../log.js";

export interface PersonalUnlockResult { sources: number; sourceGrants: number; knowledge: number; skipped?: string }

const hasTable = async (t: string): Promise<boolean> =>
  !!(await itemsPool.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${t}`])).rows[0]?.ok;

const hasColumn = async (t: string, c: string): Promise<boolean> =>
  (await itemsPool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [t, c])).rowCount === 1;

/** 자동 잠금이 남긴 자료·지식 잠금을 되돌린다. 스키마 초기화 **직후**(tenant_id 보장 뒤)에 부른다. */
export async function reconcilePersonalUploadVisibility(): Promise<PersonalUnlockResult> {
  const none: PersonalUnlockResult = { sources: 0, sourceGrants: 0, knowledge: 0 };
  for (const t of ["source", "source_member", "knowledge", "knowledge_member", "knowledge_source"]) {
    if (!(await hasTable(t))) return { ...none, skipped: `${t} 없음` };
  }
  if (!(await hasColumn("source", "visibility"))) return { ...none, skipped: "source.visibility 없음" };

  // 정책 테이블이 아직 없는 배포(EE 미적재 순서)면 «로컬 정책 없음» 으로 본다 — 정책이 없으니 자동 잠금만 남아 있다.
  //  테넌트 축은 두 표에 tenant_id 가 다 있을 때만 건다(없으면 단일 테넌트라 구분할 것이 없다).
  const polTable = await hasTable("org_source_vis_policy");
  const byTenant = polTable && await hasColumn("org_source_vis_policy", "tenant_id") && await hasColumn("source", "tenant_id");
  const governed = (system: "local" | "zotero"): string => polTable
    ? `EXISTS (SELECT 1 FROM org_source_vis_policy p WHERE p.enabled AND p.match_system='${system}'${byTenant ? " AND p.tenant_id = s.tenant_id" : ""})`
    : "false";
  //  #2202 Zotero — 수집 단위가 대상을 정하는 자료(audience=true 연결)는 단위의 잠금이다. 그 표가 없으면 그런 연결도 없다.
  const unitAudience = (await hasTable("collect_unit_source"))
    ? `EXISTS (SELECT 1 FROM collect_unit_source us WHERE us.source_id = s.id AND us.audience)` : "false";
  const zoteroAutoLock = `s.external_system='zotero'
           AND s.fields->>'library' LIKE 'users/%'
           AND COALESCE(s.fields->>'owner_member', '') <> ''
           AND EXISTS (SELECT 1 FROM source_member m WHERE m.source_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM source_member m WHERE m.source_id = s.id
                            AND NOT (m.subject_kind='member' AND m.member_id = s.fields->>'owner_member'))
           AND NOT ${unitAudience}
           AND NOT ${governed("zotero")}`;

  //  지식 술어에 쓰는 표 확인은 트랜잭션 **전에**(풀 읽기). 리스트 grant 표가 없는 배포면 그 술어는 참(grant 가 있을 수 없다).
  const listed = (await hasTable("knowledge_list_grant"))
    ? `NOT EXISTS (SELECT 1 FROM knowledge_list_grant g WHERE g.name = k.name)` : "TRUE";
  const audited = (await hasTable("org_content_audit"))
    ? `NOT EXISTS (SELECT 1 FROM org_content_audit a
                    WHERE a.entity = 'knowledge' AND a.entity_key = k.name AND a.op = 'set_visibility'
                      AND a.after->>'visibility' = 'members'
                      AND (a.after ? 'via_project_list' OR a.after ? 'dropped_list_grants'
                           OR NOT (COALESCE(a.after->>'via_source', '') ~ '^[0-9]+$' AND (a.after->>'via_source')::int = ANY($1::int[]))
                           OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                                        CASE WHEN jsonb_typeof(a.after->'via_sources') = 'array' THEN a.after->'via_sources' ELSE '[]'::jsonb END) x
                                       WHERE NOT (x ~ '^[0-9]+$' AND x::int = ANY($1::int[])))))`
    : "TRUE";

  //  #4824 — 자료 열기와 지식 열기를 **한 트랜잭션**에서. 지식은 «이번에 연 자료» 로만 열므로(아래), 둘 사이에서 프로세스가 죽거나
  //   지식 문장이 실패하면 다음 부팅은 이번에 연 자료가 없어 그 지식을 영영 열지 않는다(격리 리뷰). 함께 커밋·롤백되면 다음 부팅이
  //   둘 다 다시 한다.
  return withTx(async (c) => {
    const src = await c.query(`
      WITH tgt AS (
        UPDATE source s SET visibility='open', updated_at=now()
         WHERE s.visibility='members'
           AND ((s.external_system='local'
                 AND s.fields->>'root'='personal'
                 AND NOT ${governed("local")})
             OR (${zoteroAutoLock}))
        RETURNING s.id),
      freed AS (DELETE FROM source_member m WHERE m.source_id IN (SELECT id FROM tgt) RETURNING 1)
      SELECT (SELECT count(*) FROM tgt)::int AS sources, (SELECT count(*) FROM freed)::int AS grants,
             (SELECT COALESCE(array_agg(id), '{}') FROM tgt) AS opened`);
    const opened = ((src.rows[0]?.opened ?? []) as unknown[]).map(Number).filter(Number.isFinite);
    const sources = Number(src.rows[0]?.sources ?? 0), sourceGrants = Number(src.rows[0]?.grants ?? 0);

    // 지식 재계산 — 근거가 전부 열린 것만. (근거가 하나도 없는 지식은 상속으로 잠긴 것이 아니므로 건드리지 않는다.)
    //  #4824 — 이번 실행이 **방금 연 자료**에 이어진 지식만 본다. 이번에 연 것이 없으면 지식도 안 연다 — 부팅마다 도는 이 조정기가
    //   «근거가 지금 다 열려 있다» 만으로 지식을 열면, 잠긴 근거가 지워졌거나(CASCADE) 끊긴 지식·나중에 넓힌 단위의 지식까지 열린다.
    //   그리고 그 지식을 잠근 기록(set_visibility 감사)이 전부 이번에 연 자료에서 온 것이어야 한다 — 다른 근거·프로젝트 스탬핑
    //   (via_project_list)·리스트 걷기(dropped_list_grants)가 한 번이라도 잠갔으면 열지 않는다. 리스트 grant 가 남아 있어도 열지 않는다.
    if (!opened.length) return { sources, sourceGrants, knowledge: 0 };
    const kno = await c.query(`
      WITH tgt AS (
        UPDATE knowledge k SET visibility='open'
         WHERE k.visibility='members'
           AND ${listed}
           AND ${audited}
           AND EXISTS (SELECT 1 FROM knowledge_source ks
                        WHERE ks.name = k.name AND ks.relation='derived_from' AND ks.source_id = ANY($1::int[]))
           AND NOT EXISTS (SELECT 1 FROM knowledge_source ks JOIN source s ON s.id = ks.source_id
                            WHERE ks.name = k.name AND ks.relation='derived_from' AND s.visibility='members')
        RETURNING k.name),
      freed AS (DELETE FROM knowledge_member m WHERE m.name IN (SELECT name FROM tgt) RETURNING 1)
      SELECT (SELECT count(*) FROM tgt)::int AS knowledge, (SELECT count(*) FROM freed)::int AS grants`, [opened]);
    return { sources, sourceGrants, knowledge: Number(kno.rows[0]?.knowledge ?? 0) };
  });
}

/** 부팅용 래퍼 — 데이터 조정은 **부팅을 막지 않는다**(실패해도 제품은 종전 동작으로 뜬다). */
export async function reconcilePersonalUploadVisibilitySafe(): Promise<PersonalUnlockResult | null> {
  try {
    const r = await reconcilePersonalUploadVisibility();
    if (r.sources || r.knowledge) {
      logger.info(`[vis] 개인 업로드·Zotero 개인 라이브러리 자동 잠금 해제(#4007·#2202) — 자료 ${r.sources}건(대상 ${r.sourceGrants}행) · 지식 ${r.knowledge}건`);
    }
    return r;
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "[vis] 개인 업로드 잠금 해제 실패(비치명) — 다음 부팅에 다시 시도한다");
    return null;
  }
}
