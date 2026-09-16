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
//   (지식 잠금은 inheritSourceVisibility 한 곳에서만 생긴다 — knowledge_member 쓰기 자리가 거기뿐이다.)
//   슬랙 채널 정책 등 살아 있는 근거가 하나라도 남아 있으면 그 지식은 잠긴 채로 둔다.
//
//  ⚠ 여는 것은 되돌릴 수 없다. 그래서 조건을 넓히지 마라 — 특히 `external_system='local'` 과
//   `fields.root='personal'` 두 술어는 «자동 잠금이 만든 행» 의 정의 그 자체다.
import { itemsPool } from "../db/client.js";
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
  const governed = polTable
    ? `EXISTS (SELECT 1 FROM org_source_vis_policy p WHERE p.enabled AND p.match_system='local'${byTenant ? " AND p.tenant_id = s.tenant_id" : ""})`
    : "false";

  const src = await itemsPool.query(`
    WITH tgt AS (
      UPDATE source s SET visibility='open', updated_at=now()
       WHERE s.visibility='members'
         AND s.external_system='local'
         AND s.fields->>'root'='personal'
         AND NOT ${governed}
      RETURNING s.id),
    freed AS (DELETE FROM source_member m WHERE m.source_id IN (SELECT id FROM tgt) RETURNING 1)
    SELECT (SELECT count(*) FROM tgt)::int AS sources, (SELECT count(*) FROM freed)::int AS grants`);

  // 지식 재계산 — 근거가 전부 열린 것만. (근거가 하나도 없는 지식은 상속으로 잠긴 것이 아니므로 건드리지 않는다.)
  const kno = await itemsPool.query(`
    WITH tgt AS (
      UPDATE knowledge k SET visibility='open'
       WHERE k.visibility='members'
         AND EXISTS (SELECT 1 FROM knowledge_source ks
                      WHERE ks.name = k.name AND ks.relation='derived_from')
         AND NOT EXISTS (SELECT 1 FROM knowledge_source ks JOIN source s ON s.id = ks.source_id
                          WHERE ks.name = k.name AND ks.relation='derived_from' AND s.visibility='members')
      RETURNING k.name),
    freed AS (DELETE FROM knowledge_member m WHERE m.name IN (SELECT name FROM tgt) RETURNING 1)
    SELECT (SELECT count(*) FROM tgt)::int AS knowledge, (SELECT count(*) FROM freed)::int AS grants`);

  return {
    sources: Number(src.rows[0]?.sources ?? 0),
    sourceGrants: Number(src.rows[0]?.grants ?? 0),
    knowledge: Number(kno.rows[0]?.knowledge ?? 0),
  };
}

/** 부팅용 래퍼 — 데이터 조정은 **부팅을 막지 않는다**(실패해도 제품은 종전 동작으로 뜬다). */
export async function reconcilePersonalUploadVisibilitySafe(): Promise<PersonalUnlockResult | null> {
  try {
    const r = await reconcilePersonalUploadVisibility();
    if (r.sources || r.knowledge) {
      logger.info(`[vis] 개인 업로드 자동 잠금 해제(#4007) — 자료 ${r.sources}건(대상 ${r.sourceGrants}행) · 지식 ${r.knowledge}건`);
    }
    return r;
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "[vis] 개인 업로드 잠금 해제 실패(비치명) — 다음 부팅에 다시 시도한다");
    return null;
  }
}
