// 미러 공용 해소 헬퍼 — 감사 append + external 좌표/멤버 해소(#1313 R20 — connector-mirror.ts 에서 verbatim 이관).
//  knowledge/pm/project/source 미러가 공유한다(교차 의존을 여기 한 곳으로 모아 mirror/* 상호 순환 0 유지).
import type pg from "pg";

// 감사 append — entity 별 actor_kind='connector'/channel='connector' 고정. before/after 스냅샷은 JSON 직렬화.
//  같은 트랜잭션 client(미러 쓰기와 원자적). FK 없는 append-only 라 대상 행 삭제 후에도 이력 보존.
export async function auditConnector(
  client: pg.PoolClient,
  entity: "knowledge" | "project" | "source",
  entityKey: string,
  op: "insert" | "update",
  before: unknown,
  after: unknown,
  actor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source, channel, actor_kind)
     VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,'connector','connector','connector')`,
    [entity, entityKey, op,
     before == null ? null : JSON.stringify(before),
     after == null ? null : JSON.stringify(after),
     actor],
  );
}

/**
 * 스윕 아카이브 감사(#1561) — 원본 삭제/공유해제 전파로 lifecycle 이 바뀐 행들을 감사에 남긴다.
 *
 *  왜 필요한가: 아카이브 스윕은 단건 경로(setKnowledgeLifecycle)와 달리 벌크 UPDATE 라 감사를 안 남겼다.
 *   그래서 '언제·왜 이 문서가 아카이브됐나'가 문서 이력에도 org_audit_list 에도 없었다
 *   (실측 2026-08-05: notion 미러 511건이 그렇게 아카이브돼 있었다 — 흔적 0).
 *
 *  왜 폭주하지 않는가: 두 스윕 모두 `WHERE lifecycle='active'` 라 이미 아카이브된 행은 다시 안 잡힌다.
 *   즉 감사행은 **상태가 실제로 바뀐 순간에만** 생긴다 — mirrorKnowledgeV6 의 감사 노이즈 게이트(본문
 *   실변경 시에만 audit)와 같은 결이고, 여긴 SQL WHERE 가 이미 그 게이트 역할을 한다.
 *
 *  왜 부분 스냅샷인가: 전체 행을 실으면 한 번의 full 스윕이 수백 건 × 본문 30KB 를 감사에 복사한다.
 *   {name, lifecycle} 만 남긴다 — undo 행렬의 set_lifecycle 핸들러가 `s.lifecycle` 만 읽으므로 그대로 먹고,
 *   되돌리기(knowledge_revert)는 본문 스냅샷이 없는 op 을 이미 400 으로 막는다(문서를 비우는 사고 방지).
 *
 *  ⚠ 한 번의 INSERT…SELECT unnest 로 N행을 넣는다 — 행마다 왕복하면 500건 스윕이 500 왕복이 된다.
 */
//  op 은 단건 경로(setKnowledgeLifecycle)와 **같은 것**을 쓴다 — 스윕만 다른 op 을 쓰면 이력 화면의 분류
//   목록(CONTENT_OPS/META_OPS)과 undo 행렬 양쪽에 따로 등록해야 하고, 한 곳만 빠뜨리면 그 변경이 화면에서
//   조용히 사라진다. 상수로 빼 둔 건 테스트가 '이 op 이 분류돼 있나'를 소스에서 대조하기 위해서다.
export const LIFECYCLE_SWEEP_OP = "set_lifecycle";

export async function auditLifecycleSweep(
  db: pg.Pool | pg.PoolClient,
  names: string[],
  actor: string,
  from: string,
  to: string,
): Promise<void> {
  if (!names.length) return;
  await db.query(
    `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source, channel, actor_kind)
     SELECT 'knowledge', t.n, $5,
            jsonb_build_object('name', t.n, 'lifecycle', $2::text),
            jsonb_build_object('name', t.n, 'lifecycle', $3::text),
            $4, 'connector', 'connector', 'connector'
       FROM unnest($1::text[]) AS t(n)`,
    [names, from, to, actor, LIFECYCLE_SWEEP_OP],
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ── PM 계층·부속 미러(#541 무손실) — 공용 해소 헬퍼 ──
// ════════════════════════════════════════════════════════════════════════════

export async function folderIdByExternal(client: pg.PoolClient, system: string, instance: string, externalId: string): Promise<number | null> {
  const r = await client.query(
    `SELECT id FROM project_folder WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId]);
  return (r.rows[0] as { id: number } | undefined)?.id ?? null;
}

export async function listIdByExternal(client: pg.PoolClient, system: string, instance: string, externalId: string): Promise<number | null> {
  const r = await client.query(
    `SELECT id FROM project_list WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId]);
  return (r.rows[0] as { id: number } | undefined)?.id ?? null;
}

export async function projectIdByExternal(client: pg.PoolClient, system: string, instance: string, externalId: string): Promise<number | null> {
  const r = await client.query(
    `SELECT id FROM project WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId]);
  return (r.rows[0] as { id: number } | undefined)?.id ?? null;
}

// ClickUp 유저 → member_id 해소(헤더 주석 3단 폴백). actor = {id?, email?, username?} shape(fields.assignees[]).
export async function resolveMemberId(
  client: pg.PoolClient, system: string,
  actor: { id?: unknown; email?: unknown; username?: unknown } | null | undefined,
): Promise<string | null> {
  if (!actor) return null;
  const email = actor.email ? String(actor.email).trim().toLowerCase() : "";
  const extIds = [email, actor.id != null ? String(actor.id) : ""].filter(Boolean);
  if (extIds.length) {
    // ① person_identity(수동 매핑 포함) → org_member 실재 확인(자동 생성 person 슬러그 배제).
    const r = await client.query(
      `SELECT pi.person_id FROM person_identity pi JOIN org_member om ON om.id = pi.person_id
        WHERE pi.system=$1 AND pi.external_id = ANY($2::text[]) LIMIT 1`,
      [system, extIds]);
    const hit = (r.rows[0] as { person_id: string } | undefined)?.person_id;
    if (hit) return hit;
  }
  if (email) {
    // ② org_member.email 직접 매치.
    const r = await client.query(
      `SELECT id FROM org_member WHERE lower(email)=$1 AND email <> '' LIMIT 1`, [email]);
    const hit = (r.rows[0] as { id: string } | undefined)?.id;
    if (hit) return hit;
  }
  // ③ raw 폴백(손실 0 — UI 는 raw 표시). 사후 매핑은 reresolveMirrorMembers 가 소급(#697): 매핑 저장 시점 즉시 +
  //    매 clickup 싱크(healPmMirror)에서 재해소. (구주석 '다음 싱크가 수렴'은 증분 창 밖 태스크에 미성립이었음.)
  return email || (actor.id != null ? String(actor.id) : null);
}
