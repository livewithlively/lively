// 레인 뼈대(#1631) — 처음 설정(온보딩) 답만으로 정해지는 증류기 초안을 서버가 즉시 만든다(LLM 없음).
//
//  ── 왜 서버가 만드나 ──
//  리브(2턴)가 자료를 읽고 채우기 전에도 사람은 "내 서랍마다 정리 자리가 생겼다"를 봐야 하고, AI 로그인이 없어도
//  뼈대는 있어야 한다. 설계 [liv-collector-distiller-design-v1-1631] 단계 1: 서랍마다 `liv-<서랍key>`(꺼짐, 기준 비움,
//  목적지 = 그 서랍) + `liv-catch-all`(꺼짐, 스코프 없음, priority -100). 리브는 이 초안을 **채우지 새로 만들지 않는다**.
//
//  ── 규율 ──
//  · 멱등: 같은 key 가 이미 있으면 건드리지 않는다(리브가 채운 기준을 덮으면 안 된다).
//  · 꺼진 채로: 켜는 것은 리브가 미리보기로 1건↑ 확인한 뒤의 일이다(설계 원칙 5).
//  · 판정(planLaneSkeleton)은 순수 함수 — 표로 검증한다.

export const CATCH_ALL_KEY = "liv-catch-all";

export interface SkeletonDrawer { key: string; name: string }
export interface LanePlan {
  key: string; label: string; enabled: false; priority: number;
  target_category: string | null; lookback_days: number | null;
  criteria_md: string; format_md: string; note: string;
}

/** 주기 답 → 되돌아보는 날수(설계 §2 깊이). 첫 지시의 시간 표현은 리브가 2턴에서 덮어쓴다. */
export function lookbackFromCadence(cadence: string | null | undefined): number | null {
  switch (String(cadence ?? "").trim()) {
    case "week": return 30;
    case "month": return 90;
    default: return null;   // 없음/미답 = 전체(1회 백필)
  }
}

export function laneKeyFor(drawerKey: string): string {
  const k = String(drawerKey ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `liv-${k || "drawer"}`;
}

const PLACEHOLDER_CRITERIA = [
  "## 아직 채워지지 않은 초안",
  "처음 설정에서 만든 서랍의 자리표다. 기준은 리브가 이 서랍에 실제로 들어온 자료 표본을 읽은 뒤 쓴다(liv-distill 스킬).",
  "이 문장이 남아 있는 동안 이 증류기는 켜지 않는다.",
].join("\n");
const PLACEHOLDER_FORMAT = "리브가 표본을 읽은 뒤 정한다.";

/**
 * 뼈대 계획 — 있는 key 는 건너뛴다(멱등). 서랍이 0개면 catch-all 도 만들지 않는다(승인한 적이 없다 — 로컬 증류기와 같은 규율).
 */
export function planLaneSkeleton(o: { drawers: SkeletonDrawer[]; existingKeys: Iterable<string>; cadence?: string | null }): LanePlan[] {
  const have = new Set(o.existingKeys);
  const lookback = lookbackFromCadence(o.cadence);
  const seen = new Set<string>();
  const out: LanePlan[] = [];
  for (const d of o.drawers) {
    const key = laneKeyFor(d.key);
    if (seen.has(key) || have.has(key)) continue;
    seen.add(key);
    out.push({
      key, label: `${d.name} — 리브가 채울 자리`, enabled: false, priority: 50,
      target_category: d.key, lookback_days: lookback,
      criteria_md: PLACEHOLDER_CRITERIA, format_md: PLACEHOLDER_FORMAT,
      note: "처음 설정이 만든 뼈대(liv-distill 이 채운다)",
    });
  }
  if (out.length || (o.drawers.length && !have.has(CATCH_ALL_KEY))) {
    if (!have.has(CATCH_ALL_KEY) && !seen.has(CATCH_ALL_KEY)) {
      out.push({
        key: CATCH_ALL_KEY, label: "그 밖의 자료 — 안전망(리브가 켠다)", enabled: false, priority: -100,
        target_category: null, lookback_days: null,
        criteria_md: PLACEHOLDER_CRITERIA, format_md: PLACEHOLDER_FORMAT,
        note: "어느 레인에도 안 걸린 자료를 받는 마지막 레인. 스코프를 비워 둔다(좁히지 않는다).",
      });
    }
  }
  return out;
}

/** 계획을 실제로 저장한다 — 실패는 던진다(호출자 welcome 이 비치명으로 감싼다). */
export async function applyLaneSkeleton(o: { drawers: SkeletonDrawer[]; cadence?: string | null; actor: string }): Promise<{ created: string[]; skipped: string[] }> {
  const { listDistillers } = await import("../distill/distiller.js");
  const { upsertDistiller } = await import("../store/ingest.js");
  const existing = (await listDistillers()).map((r) => String(r.key));
  const plan = planLaneSkeleton({ drawers: o.drawers, existingKeys: existing, cadence: o.cadence });
  const created: string[] = [];
  for (const p of plan) {
    await upsertDistiller({
      key: p.key, label: p.label, enabled: false, priority: p.priority,
      target_category: p.target_category, lookback_days: p.lookback_days,
      criteria_md: p.criteria_md, format_md: p.format_md, note: p.note,
      thread_aware: false, prefilter_level: 0,
    }, o.actor, "welcome");
    created.push(p.key);
  }
  const skipped = o.drawers.map((d) => laneKeyFor(d.key)).filter((k) => existing.includes(k));
  return { created, skipped };
}
