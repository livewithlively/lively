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

/** 아직 리브가 안 채운 뼈대라는 표식 — 화면·집계가 «설정됨» 으로 세지 않으려면 이 문장을 봐야 한다(#1631). */
export const PLACEHOLDER_MARK = "## 아직 채워지지 않은 초안";
const PLACEHOLDER_CRITERIA = [
  PLACEHOLDER_MARK,
  "처음 설정에서 만든 카테고리의 자리표다. 기준은 리브가 이 카테고리에 실제로 들어온 자료 표본을 읽은 뒤 쓴다(liv-distill 스킬).",
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

/** 서랍 레인의 서랍 key — 키에서 `liv-` 를 뗀 값. 서랍 레인이 아니면 null(일반 key · 안전망 · `liv-` 뒤가 빔). */
export function drawerOfLane(key: string | null | undefined): string | null {
  const k = String(key ?? "").trim();
  if (!k.startsWith("liv-") || k === CATCH_ALL_KEY) return null;
  return k.slice("liv-".length).trim() || null;
}

/**
 * 서랍 레인의 목적지를 정한다(#1631 · #5235) — 저장이 통과하면 그 값이 실제로 저장되고, 뜻대로 못 하면 거절로 이유를 말한다.
 *
 *  키가 곧 목적지인 레인이라, 서랍이 **있는데** 목적지가 비면 고장이다.
 *  ── 실측 (2026-08-31 dev, 감사 기록) ──
 *    17:22:52 insert (welcome)  (null) → d-21c2235a7d   enabled=false   ← 뼈대가 목적지를 넣었다
 *    17:42:36 update (web)      d-21c2235a7d → (null)   enabled=true    ← 리브가 **켜면서 지웠다**
 *   레인은 켜졌는데 목적지가 없다 = 그 레인이 만든 지식이 그 서랍에 안 들어간다. 사람이 온보딩에서 승인한
 *   «이 서랍으로 모아 주세요» 가 조용히 사라지는 것이다. (같은 턴의 다른 레인들은 목적지를 지켰다 — 그래서
 *   부분 갱신 계약의 문제가 아니라 **한 호출이 빈 값을 실어 보낸** 문제다. 사람도 도구도 그럴 수 있다.)
 *
 *  ── 되살리기만 하면 생기는 결함 둘 (#5235, 셀프호스트 고객 박스·olddev 실측) ──
 *   ① 키에서 **없는 서랍을 지어냈다.** 빈 값은 목적지 검증(judgeTargetCategory)을 통과하고, 그 뒤에 되살아나 검증을 우회했다
 *      (`liv-product-thread` 를 목적지 없이 만들면 없는 카테고리 `product-thread` 가 박혔다).
 *   ② 비우는 저장이 200 인데 아무것도 안 바뀌었다. 없는 서랍이 박힌 레인을 고칠 길이 없어 다른 key 로 새 레인을 만들어야 했다.
 *
 *  | 이번 저장의 목적지 | 키의 서랍                 | 결과 |
 *  |---|---|---|
 *  | 있음               | —                         | 그대로 — 옮기는 것은 정당하다(명시한 값의 검증은 judgeTargetCategory) |
 *  | 빔                 | 서랍 레인 아님            | 빈 채로 — 안전망은 스코프도 목적지도 비우는 것이 설계다 |
 *  | 빔                 | 활성 카테고리가 아님      | 빈 채로 — 되살릴 서랍이 없다. 없는 서랍이 박힌 레인을 고치는 길이 이것이다 |
 *  | 빔                 | 활성 · 비우려는 저장      | 거절 — 받아 주면 위 실측의 고장이 되고, 되살리면 조용한 무시가 된다 |
 *  | 빔                 | 활성 · 그 밖              | 서랍으로 되살린다 |
 *
 * @param o.key      증류기 key
 * @param o.given    이번 저장에서 정해진 목적지(명시한 값, 안 보냈으면 현재 값)
 * @param o.clearing 빈 값을 명시해 목적지를 없애려는 저장인가. 이미 빈 목적지를 그대로 되돌려 보낸 것은 아니다 —
 *                   켜고 끄는 화면이 현재 값을 통째로 되보내는데(distillers.ts settable), 그걸 거절하면 스위치가 막힌다.
 * @param o.stateOf  카테고리 key → state(없으면 undefined)
 * @returns 저장할 목적지, 또는 비울 수 없는 서랍(refuse)
 */
export function settleDrawerTarget(o: {
  key: string | null | undefined; given: string | null | undefined;
  clearing: boolean; stateOf: (categoryKey: string) => string | undefined;
}): { target: string | null } | { refuse: string } {
  const given = String(o.given ?? "").trim();
  if (given) return { target: given };
  const drawer = drawerOfLane(o.key);
  if (!drawer || o.stateOf(drawer) !== "active") return { target: null };
  return o.clearing ? { refuse: drawer } : { target: drawer };
}
