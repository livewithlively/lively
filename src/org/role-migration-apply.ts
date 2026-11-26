// 옛 방식 구성원을 역할로 옮기기 — 저장 (#5799).
//  계획(누가 어느 역할로 · 무엇을 얻고 잃는가)은 auth/role-migration.ts 가 계산한다(순수). 여기는 그 계획을 저장한다.
//  부르는 곳 둘: 관리자가 고르는 적용(capabilities/delivery/members.ts org_member_role_apply)과, 워크스페이스마다 도는 자동 이관(sweepLegacyMembers).
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";
import { listMembers, upsertMember } from "./store/members.js";
import { addDbSourceMembers } from "./store/db-source-grants.js";
import { listSourceConfigs, refreshSources } from "../db/sources.js";
import { SELF_SOURCE } from "../db/self-source.js";
import { planMigration, type MigrationPlan } from "../auth/role-migration.js";

/** 옛 방식 구성원 전원의 이관 계획 — DB 소스는 지금 등록된 것(내장 self 제외). */
export async function legacyMemberPlans(keep: boolean): Promise<MigrationPlan[]> {
  await refreshSources(true);
  const sources = listSourceConfigs().map((s) => s.name).filter((n) => n !== SELF_SOURCE);
  return planMigration(await listMembers(), { sources, keep });
}

export interface MigrationResult { moved: Array<{ id: string; role: string; custom: boolean }>; skipped: Array<{ id: string; reason: string }>; dbGrants: number }

/**
 * 고른 계획을 저장한다 — DB 소스 지정을 **먼저** 넣고 역할을 바꾼다(역할이 먼저 바뀌면 그 사이 조회가 끊긴다. 옛 방식 구성원에게
 *  지정은 아무 효과가 없어 먼저 넣어도 넓어지지 않는다). 옮기지 않을 계획(role 없음)은 건너뛴다. 옛 scopes 값은 감사 로그(before)에 남는다.
 */
export async function applyMigrationPlans(picked: readonly MigrationPlan[], actor: string | null): Promise<MigrationResult> {
  const bySource = new Map<string, string[]>();
  for (const p of picked) if (p.role) for (const src of p.dbSources) bySource.set(src, [...(bySource.get(src) ?? []), p.id]);
  let dbGrants = 0;
  for (const [src, members] of bySource) dbGrants += await addDbSourceMembers(src, members, actor);
  const moved: MigrationResult["moved"] = [];
  const skipped: MigrationResult["skipped"] = [];
  for (const p of picked) {
    if (!p.role) { skipped.push({ id: p.id, reason: p.skip ?? "skip" }); continue; }
    await upsertMember({ id: p.id, role: p.role, grants: p.grants }, actor ?? undefined, "role-migration");
    moved.push({ id: p.id, role: p.role, custom: p.custom });
  }
  return { moved, skipped, dbGrants };
}

/** 자동 이관을 끈다 — `LIVELY_ROLE_MIGRATION=off`(셀프호스트가 이관을 미루고 싶을 때). 기본은 켜짐. */
export const autoMigrationOff = (env: NodeJS.ProcessEnv = process.env): boolean => (env.LIVELY_ROLE_MIGRATION || "").trim().toLowerCase() === "off";

/**
 * 자동 이관(워크스페이스마다 주기 정비 — sessions/outbox-request-sweep.ts SWEEP_JOBS) — 이 워크스페이스의 옛 방식 구성원을 **잃는 것 없이** 역할로 옮긴다.
 *  · keep 고정: 역할이 낮추는 권한은 개별 권한으로 남긴다(결정 2026-11-26 — 자동 이관은 아무것도 잃게 하지 않는다).
 *  · 옛 `db` 는 «모든 소스» 지정으로 잇는다(계획이 정한다).
 *  · 권한이 없는 구성원(시스템 계정 등)은 옮기지 않는다.
 *  · 옮길 사람이 없으면 조회 한 번으로 끝난다(멱등). 나중에 옛 방식으로 만들어진 구성원(scopes 만 준 API 호출)도 다음 판에 옮긴다.
 */
export async function sweepLegacyMembers(
  env: NodeJS.ProcessEnv = process.env,
  /** only — 이 구성원만(시험용: 같은 DB 를 쓰는 다른 시험의 구성원을 건드리지 않게). 운영 배선은 주지 않는다. */
  opts: { only?: (memberId: string) => boolean } = {},
): Promise<{ moved: number }> {
  if (autoMigrationOff(env)) return { moved: 0 };
  //  역할 칸은 행에서 꺼낸다(롤 창에 칸이 아직 없으면 NULL — 그때는 아래 계획도 전원을 옛 방식으로 보지만, 저장이 칸 없이 실패하고 다음 판에 다시 돈다).
  const any = await itemsPool.query(
    `SELECT 1 FROM org_member WHERE to_jsonb(org_member) ->> 'role' IS NULL AND scopes IS NOT NULL AND scopes <> '[]'::jsonb LIMIT 1`);
  if (!(any.rowCount ?? 0)) return { moved: 0 };
  const plans = (await legacyMemberPlans(true)).filter((p) => p.role && (!opts.only || opts.only(p.id)));
  if (!plans.length) return { moved: 0 };
  const r = await applyMigrationPlans(plans, "system:role-migration");
  logger.info({ moved: r.moved.length, dbGrants: r.dbGrants }, "[role-migration] 옛 방식 구성원을 역할로 자동 이관(잃는 것 없이)");
  return { moved: r.moved.length };
}
