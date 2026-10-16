// 확인 읽기(#4213 T11) — 보호 단위의 «볼 수 있는 구성원» 은 그 사람 커넥터로 읽은 글이 이미 저장된 글과 같을 때만 된다.
//
//  왜: 수집 실행의 원문(캡처)은 그 사람 홈에 있어 그 사람이 고쳐 쓸 수 있다. 목록 실행 결과만으로 확인된 구성원을 세우면 셸이 있는
//   구성원이 가짜 목록 한 장으로 남의 비공개 채널에 이미 모인 자료를 열 수 있다. 접근 못 하는 사람은 비공개 대화의 최근 본문을 만들어
//   낼 수 없으므로, «가장 새로 저장된 글과 좌표·본문이 같은 글을 읽어 왔다» 를 확인의 증거로 삼는다(collect-plan.judgeProof).
//
//  · 보호 단위 = 공개범위가 «모두» 가 아니고(viewers · me) · 메일함이 아니고(메일함은 주인 이메일로만 선다, T10) · 이미 저장된 자료가 있는 단위.
//  · 보호 단위에서 아직 확인되지 않은 사람 — 목록은 «확인 대기»(collect_proof) 까지 · 그 사람 실행은 그 단위에 자료를 넣지 못한다.
//  · 확인은 이미 있는 구성원 행만 올린다(없는 행을 만들지 않는다) — 목록에서 빠진 사람이 옛 대기 행으로 되살아나지 않게.
//
//  ⚠ 한계(이 장치가 막지 못하는 것):
//   · 자료가 모이기 **전에** 들어온 가짜 목록 — 지킬 자료가 없어 바로 확인되고, 그 뒤 남이 모은 자료를 본다. 서버가 아는 사실(그 앱의
//     구성원 목록)이나 관리자 승인이 있어야 막히므로 이 장치 밖이다.
//   · 최근 글을 알고 있는 사람 — 예전에 그 대화에 있다가 빠졌어도, 가장 새로 저장된 글이 빠지기 전 것이면 그 글로 확인된다(노션은 본문이
//     오래 그대로라 더 그렇다). 새 글이 저장되면 창이 옮겨 가 옛 기억은 증거가 못 된다.
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import { syncUnitAudience } from "./unit-store.js";
import { PROOF_MAX_ATTEMPTS, PROOF_RECENT, PROOF_RECHECK_SEC, PROOF_RETRY_SEC, type ProofOutcome } from "./collect-plan.js";

/** 이 사람($member) 기준 «보호 단위이고 아직 확인 안 됨» — 목록 판정(unitGuards)과 수집 판정(guardsByUnitId)이 같은 한 벌을 쓴다. */
const guardedSql = (member: string) => `(
  COALESCE(u.visibility, 'viewers') <> 'all' AND u.kind <> 'mailbox'
  AND EXISTS (SELECT 1 FROM collect_unit_source us WHERE us.unit_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM collect_unit_member m WHERE m.unit_id = u.id AND m.member_id = ${member} AND m.verified_at IS NOT NULL))`;

/** 단위들의 보호 여부(이 사람 기준) — ref → 단위 id(보호면). ref 는 T10 이 쓰는 좌표 모양(canonicalCoord)으로 넘긴다. 없는 단위는 빠진다. */
export async function unitGuards(member: string, app: string, instance: string, refs: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!refs.length) return out;
  //  상한을 두지 않는다 — 조회하지 않은 ref 가 «열린 단위» 로 기록되면 그 자리가 우회로가 된다(목록 상한은 부르는 쪽이 같은 목록으로 맞춘다).
  const r = await itemsPool.query(
    `SELECT u.id, u.ref FROM collect_unit u
      WHERE u.app = $1 AND u.instance = $2 AND u.ref = ANY($3::text[]) AND ${guardedSql("$4")}`,
    [app, instance, [...new Set(refs)], member]);
  for (const x of r.rows as any[]) out.set(String(x.ref), Number(x.id));
  return out;
}

/** 단위 id 로(수집 실행의 계획 단위) — 이 사람 기준 보호 여부. */
export async function guardsByUnitId(member: string, unitIds: readonly number[]): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  if (!unitIds.length) return out;
  const r = await itemsPool.query(
    `SELECT u.id, ${guardedSql("$2")} AS guarded FROM collect_unit u WHERE u.id = ANY($1::int[])`, [[...new Set(unitIds)], member]);
  for (const x of r.rows as any[]) out.set(Number(x.id), x.guarded === true);
  return out;
}

/** 확인 대기를 건다(이미 있으면 그대로 — 시도 수를 지우지 않는다). */
export async function requestProof(member: string, unitIds: readonly number[]): Promise<number> {
  if (!unitIds.length) return 0;
  const r = await itemsPool.query(
    `INSERT INTO collect_proof(unit_id, member_id) SELECT u, $2 FROM unnest($1::int[]) AS u
     ON CONFLICT (unit_id, member_id) DO NOTHING`, [[...new Set(unitIds)], member]);
  return r.rowCount ?? 0;
}

/** 이 사람이 더는 볼 수 있는 구성원이 아닌 단위의 대기 행을 지운다(목록에서 빠짐 · 단위 지워짐은 FK 가 지운다). */
export async function dropStaleProofs(member: string): Promise<number> {
  const r = await itemsPool.query(
    `DELETE FROM collect_proof p WHERE p.member_id = $1
       AND NOT EXISTS (SELECT 1 FROM collect_unit_member m WHERE m.unit_id = p.unit_id AND m.member_id = p.member_id)`, [member]);
  return r.rowCount ?? 0;
}

export interface PendingProof { unit_id: number; app: string; instance: string; ref: string; kind: string; newest_ts: string[] }

const SLACK_TS_SQL = `s.fields->>'ts' ~ '^[0-9]{9,11}\\.[0-9]{1,6}$'`;
/**
 * 지금 실을 수 있는 대기(p = collect_proof · u = collect_unit) — 계획(pendingProofs)과 주기 판 고르기(proofDueMembers)가 같은 한 벌을 쓴다.
 *  · 그 단위의 볼 수 있는 구성원(행)이어야 한다 · 시도가 상한에 닿았으면 마지막 시도에서 PROOF_RETRY_SEC 가 지나야(영영 잠기지 않게).
 *  · 슬랙은 확인 창을 만들 최상위 글(답글이 아닌 것)이 저장돼 있어야 한다 — 채널 읽기는 최상위 글만 준다. 노션은 페이지 하나.
 */
const ACTIONABLE_SQL = `
        (p.attempts < ${PROOF_MAX_ATTEMPTS} OR p.last_at < now() - make_interval(secs => ${PROOF_RETRY_SEC}))
        AND EXISTS (SELECT 1 FROM collect_unit_member m WHERE m.unit_id = p.unit_id AND m.member_id = p.member_id)
        AND (u.app = 'notion' OR (u.app = 'slack' AND EXISTS (
              SELECT 1 FROM collect_unit_source us JOIN source s ON s.id = us.source_id
               WHERE us.unit_id = p.unit_id AND s.parent_external_id IS NULL AND ${SLACK_TS_SQL})))`;

/** 이 사람의 확인 대기 가운데 지금 실을 수 있는 것(ACTIONABLE_SQL) — 오래 안 해 본 것부터(돌아가며) · 앱을 정했으면 그 앱만(상한보다 **먼저** 거른다). */
export async function pendingProofs(member: string, limit: number, opts: { app?: string | null } = {}): Promise<PendingProof[]> {
  const r = await itemsPool.query(
    `SELECT p.unit_id, u.app, u.instance, u.ref, u.kind,
            COALESCE((SELECT array_agg(t ORDER BY t::numeric DESC) FROM (
               SELECT s.fields->>'ts' AS t FROM collect_unit_source us JOIN source s ON s.id = us.source_id
                WHERE us.unit_id = p.unit_id AND s.parent_external_id IS NULL AND ${SLACK_TS_SQL}
                ORDER BY (s.fields->>'ts')::numeric DESC LIMIT $2) x), '{}') AS newest_ts
       FROM collect_proof p JOIN collect_unit u ON u.id = p.unit_id
      WHERE p.member_id = $1 AND ($4::text IS NULL OR u.app = $4) AND ${ACTIONABLE_SQL}
      ORDER BY p.last_at NULLS FIRST, p.requested_at, p.unit_id LIMIT $3`,
    [member, PROOF_RECENT, Math.max(0, limit), opts.app ?? null]);
  return (r.rows as any[]).map((x) => ({ unit_id: Number(x.unit_id), app: String(x.app), instance: String(x.instance), ref: String(x.ref), kind: String(x.kind),
    newest_ts: (x.newest_ts ?? []).map(String) }));
}

/**
 * #4744 주기 판에 올릴 «확인 대기가 있는» 구성원 — 확인 읽기는 담당이 아닌 사람의 일이라 «때가 된 단위» 로는 안 잡힌다. 새로 들어온
 *  정당한 구성원이 손으로 띄우지 않아도 확인되게 주기 판이 띄운다. 같은 대기를 틱마다 읽지 않게 마지막 시도에서 PROOF_RECHECK_SEC 가 지난 것만.
 */
export async function proofDueMembers(limit = 500): Promise<Array<{ member: string; units: number; oldest_ms: number }>> {
  const r = await itemsPool.query(
    `SELECT p.member_id, count(*)::int AS units, (extract(epoch FROM min(p.requested_at)) * 1000)::bigint AS oldest_ms
       FROM collect_proof p JOIN collect_unit u ON u.id = p.unit_id
      WHERE ${ACTIONABLE_SQL} AND (p.last_at IS NULL OR p.last_at < now() - make_interval(secs => ${PROOF_RECHECK_SEC}))
      GROUP BY p.member_id ORDER BY min(p.requested_at), p.member_id LIMIT $1`, [Math.max(0, limit)]);
  return (r.rows as any[]).map((x) => ({ member: String(x.member_id), units: Number(x.units), oldest_ms: Number(x.oldest_ms) }));
}

/** 확인 읽기 판정에 쓸 저장된 글 — 그 단위에 이어진 자료 가운데 이 좌표들(가린 뒤의 본문). */
export async function storedBodies(unitId: number, app: string, instance: string, externalIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!externalIds.length) return out;
  const r = await itemsPool.query(
    `SELECT s.external_id, s.body_md FROM collect_unit_source us JOIN source s ON s.id = us.source_id
      WHERE us.unit_id = $1 AND s.external_system = $2 AND s.external_instance = $3 AND s.external_id = ANY($4::text[])`,
    [unitId, app, instance, [...new Set(externalIds)].slice(0, 5000)]);
  for (const x of r.rows as any[]) out.set(String(x.external_id), String(x.body_md ?? ""));
  return out;
}

/**
 * 확인 읽기를 통과한 사람을 확인된 구성원으로 — **이미 있는 구성원 행만**(없는 행은 만들지 않는다). 단위 행을 잡고(T10 저장과 같은 순서)
 *  올린 뒤 그 단위 자료의 볼 수 있는 사람을 다시 맞춘다. 돌려주는 값: verified(새로 확인) · already(이미 확인) · not_member(행 없음).
 */
export async function verifyByProof(member: string, unitId: number): Promise<"verified" | "already" | "not_member"> {
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT 1 FROM collect_unit WHERE id=$1 FOR UPDATE`, [unitId]);
    const m = await client.query(`SELECT verified_at FROM collect_unit_member WHERE unit_id=$1 AND member_id=$2`, [unitId, member]);
    let out: "verified" | "already" | "not_member";
    if (!m.rows.length) out = "not_member";
    else if (m.rows[0].verified_at != null) out = "already";
    else {
      await client.query(`UPDATE collect_unit_member SET verified_at = now(), seen_at = now() WHERE unit_id=$1 AND member_id=$2`, [unitId, member]);
      await syncUnitAudience(client, [unitId]);
      out = "verified";
    }
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 확인 읽기 결과를 남긴다.
 *  · pass · not_member → 대기 행을 지운다.
 *  · no_match(창 안 글이 있는데 안 맞음) · empty(창 안 글 없음) · unprovable(노션 본문이 너무 짧아 증거가 안 됨) → 시도 +1.
 *  · unreadable(결과를 못 풂 — 속도 제한 같은 일시 오류) → 시도는 그대로, 시각·사유만.
 */
export async function recordProofResult(member: string, unitId: number, outcome: ProofOutcome | "not_member" | "unreadable"): Promise<void> {
  try {
    if (outcome === "pass" || outcome === "not_member") {
      await itemsPool.query(`DELETE FROM collect_proof WHERE unit_id=$1 AND member_id=$2`, [unitId, member]);
      return;
    }
    const inc = outcome === "unreadable" ? 0 : 1;
    await itemsPool.query(
      `INSERT INTO collect_proof(unit_id, member_id, attempts, last_at, last_result) VALUES($1,$2,$3,now(),$4)
       ON CONFLICT (unit_id, member_id) DO UPDATE SET attempts = collect_proof.attempts + $3, last_at = now(), last_result = $4`,
      [unitId, member, inc, outcome]);
  } catch (e) {
    logger.warn({ unitId, member, err: (e as Error)?.message }, "[collect-proof] 확인 결과를 못 적었다 — 다음 판이 다시 확인한다");
  }
}
