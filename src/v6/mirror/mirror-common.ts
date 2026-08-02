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
