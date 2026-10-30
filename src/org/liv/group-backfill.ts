// 묶음 보정(#1631, 2026-09-14) — 처음 설정을 끝냈는데 묶음이 0개로 남은 워크스페이스를 한 번 채운다.
//
//  ── 왜 ───────────────────────────────────────────────────────────────────────
//  실측(lively-agent-2-6a84): 처음 설정·리브 2턴을 다 거쳤는데 묶음이 0개였고, 그래서 하드 규칙(묶음이 **있어야** 켜진다)도
//   꺼진 채 리브가 묶음 없는 카테고리를 만들었다. 심기 두 자리(처음 설정 반영 · 2턴 직전)를 이미 지나간 사람에겐
//   다시 올 기회가 없다 — 그 빈자리를 채우는 것이 이 파일이다.
//
//  ── 누구에게 ─────────────────────────────────────────────────────────────────
//  · 묶음이 0개이고
//  · **묶음 기능 이후**(GROUPS_FEATURE_SINCE)에 처음 설정을 끝낸 **주인**(초대 합류자가 아닌 사람)이 있는 워크스페이스.
//  · 그 이전에 끝낸 워크스페이스는 «옛 판» 이라 건드리지 않는다 — 우리가 그 사람들에게 묶음을 약속한 적이 없다.
//  · 합류자(join.via=invite)의 답으로는 심지 않는다 — 신입의 직무가 팀의 묶음 이름이 되면 안 된다(합류 결정 2026-09-13).
//  판정은 순수 함수(planGroupBackfill), 실행은 테넌트 컨텍스트 안에서 — 매니지드는 요청 정비표(sessions/outbox-request-sweep.ts),
//   셀프호스트는 하우스키핑(boot/housekeeping.ts perTenant)이 부른다.
import { logger } from "../../log.js";
import { turnGroupInputs } from "./second-turn.js";

/** 묶음 기능이 나간 날(#1631 PR #909·#912, 2026-09-13). 이 뒤에 처음 설정을 끝낸 주인만 보정한다. */
export const GROUPS_FEATURE_SINCE = "2026-09-13T00:00:00Z";

export interface BackfillMember {
  id: string;
  welcome?: { done_at?: string | null; stage?: string | null } | null;
  join?: { via?: string | null } | null;
  workAsis?: string | null;
}

/**
 * 보정의 기준이 될 사람 하나(가장 먼저 끝낸 주인)와 할 일 — 보정하지 않으면 null.
 *  · 묶음 0개 → mode "seed": 그 사람 답으로 세 칸을 심고 묶음 밖 카테고리를 넣는다.
 *  · 묶음 있음 → mode "place": 심지 않고 **묶음 밖 카테고리만** 넣는다. 실측(lively-agent-2-6a84, 2026-09-14 DB): 묶음 세 칸과
 *    리브가 만든 4개는 제자리였고, 묶음보다 3분 먼저 생긴 계정 서버 기본 카테고리 5개만 묶음 밖이었다 — 0개일 때만 도는 보정으론 못 닿는다.
 */
export function planGroupBackfill(input: { hasGroups: boolean; members: BackfillMember[]; since?: string }):
  { memberId: string; stage: string | null; workAsis: string | null; mode: "seed" | "place" } | null {
  const since = Date.parse(input.since ?? GROUPS_FEATURE_SINCE);
  const owners = input.members
    .map((m) => ({ m, at: Date.parse(String(m.welcome?.done_at ?? "")) }))
    .filter(({ m, at }) => Number.isFinite(at) && at >= since && m.join?.via !== "invite")
    .sort((a, b) => a.at - b.at);
  const hit = owners[0]?.m;
  return hit
    ? { memberId: hit.id, stage: hit.welcome?.stage ?? null, workAsis: hit.workAsis ?? null, mode: input.hasGroups ? "place" : "seed" }
    : null;
}

//  한 프로세스에서 워크스페이스마다 **결론이 난 뒤엔** 다시 보지 않는다 — 보정 대상은 새로 생기지 않는다
//   (새 처음 설정은 반영 자리에서 스스로 심는다). 조회가 실패한 판은 결론이 아니라서 기억하지 않는다(다음 주기에 다시 본다).
const settled = new Set<string>();
export function resetGroupBackfillMemo(): void { settled.clear(); }

export async function backfillCategoryGroups(): Promise<{ reason: "settled" | "no-owner" | "placed" | "seeded"; placed?: number }> {
  const { currentTenant } = await import("../tenant-context.js");
  const ws = currentTenant()?.id ?? "primary";
  if (settled.has(ws)) return { reason: "settled" };
  const { activeGroupKeys, placeUngroupedCategories, seedCategoryGroups } = await import("../../v6/category-group-store.js");
  const hasGroups = (await activeGroupKeys()).length > 0;
  const { listMembers, getLivProfile, WORK_ASIS_SEP } = await import("../store/members.js");
  const members: BackfillMember[] = [];
  for (const p of await listMembers()) {
    if (p.kind !== "human" || p.state !== "active") continue;
    const liv = await getLivProfile(p.id);
    if (!liv?.welcome) continue;
    members.push({ id: p.id, welcome: liv.welcome, join: liv.join ?? null, workAsis: liv.work?.asis ?? null });
  }
  const plan = planGroupBackfill({ hasGroups, members });
  if (!plan) { settled.add(ws); return { reason: "no-owner" }; }
  if (plan.mode === "place") {
    const placed = await placeUngroupedCategories({ actor: plan.memberId, source: "welcome" });
    settled.add(ws);
    if (placed.length) logger.info({ ws, member: plan.memberId, placed: placed.length }, "묶음 보정 — 묶음 밖에 남은 카테고리를 넣음");
    return { reason: "placed", placed: placed.length };
  }
  const gi = turnGroupInputs({ stage: plan.stage, workAsis: plan.workAsis, sep: WORK_ASIS_SEP });
  const r = await seedCategoryGroups({ stage: gi.stage, job: gi.job, actor: plan.memberId });
  settled.add(ws);
  logger.info({ ws, member: plan.memberId, created: r.created, placed: r.placed.length }, "묶음 보정 — 처음 설정 뒤 0개로 남은 워크스페이스를 채움");
  return { reason: "seeded", placed: r.placed.length };
}
