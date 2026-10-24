// 매니지드 정비 틱(web.ts POST /api/ops/housekeeping/tick)의 단계 분류와 «자동화 단계 빼기» 선택 — #4193 T3.
//
// ── 왜 ──────────────────────────────────────────────────────────────────────
//  CP 는 사람이 N일 동안 안 들어온 워크스페이스(자동화 휴면)에서 **자동화만** 멈춘다. 이 선택이 없던 때 CP 가 할 수 있는
//  일은 틱을 통째로 건너뛰는 것뿐이었고, 그러면 세션 회수·앱 스냅숏·정리·백필·시딩까지 함께 멈췄다. 회수가 멈추면
//  CP 회수 감시가 «리퍼 결과가 끊겼다(reaper_stale)» 고 거짓 경보도 낸다(lvly-cloud reclaimhealth). 그래서 CP 가 요청
//  본문으로 «자동화 단계 빼기» 를 고르고, 코어는 정비 단계를 그대로 돌린다.
//
// ── 분류 ────────────────────────────────────────────────────────────────────
//  · 자동화 = 사람 대신 일을 벌이는 단계 — AI 세션·외부 수집·토큰을 쓴다.
//    - scheduler       : org_cron 크론 실행기. 수집(connector_sync)·증류(distill_*)·카테고리 붙이기(classify_*)·관리기
//                        (run_managers)·에이전트 잡(agent_*)·상시 세션 유지(ensure_managed_sessions)·도메인맵·base 갱신(refresh_*)
//                        이 전부 이 안에서 돈다.
//    - liv-second-turn : 리브 2턴 — 세션에 증류 지시를 넣는다.
//  · 정비 = 워크스페이스를 건강하게 두는 단계 — 휴면이어도 돈다. 회수(session-reaper·session-stop-rule·
//    session-pressure-reaper·session-end-lost) · 스냅숏(app-data-snapshot) · 정리(call-log-prune·app-folder-archive·
//    app-bundles·app-servers) · 백필(session-backfill) · 시딩(seed-default-content).
//  · 모르는 이름은 정비로 본다. 분류를 잊은 새 단계가 휴면 워크스페이스에서 조용히 멈추지 않게 한다 — 이 방향으로 틀리면
//    자동화가 조금 더 돌 뿐이고, 반대로 틀리면 회수 같은 정비가 멈춘다. 이 표와 web.ts 의 단계 목록이 어긋나면
//    시험(housekeeping-tick.test [4206-H5])이 잡는다.
//
// ── 선택 ────────────────────────────────────────────────────────────────────
//  · 본문 { skip: ["automation"] } 만 받는다. 모양이 틀리거나 모르는 값은 버린다 — 정비를 빼는 선택은 없다.
//  · 응답의 skip 에 적용한 선택을 돌려준다. 이 필드를 모르는 옛 코어는 아무것도 빼지 않고 전부 돌리므로(본문을 안 읽는다),
//    CP 는 응답으로 둘을 가른다.

export type TickStepGroup = "automation" | "maintenance";

/** 틱 단계 → 묶음. web.ts 의 step("…") 이름과 같아야 한다. */
export const TICK_STEP_GROUPS: ReadonlyMap<string, TickStepGroup> = new Map<string, TickStepGroup>([
  ["scheduler", "automation"],
  ["liv-second-turn", "automation"],
  ["seed-default-content", "maintenance"],
  ["call-log-prune", "maintenance"],
  ["session-backfill", "maintenance"],
  ["app-data-snapshot", "maintenance"],
  ["app-folder-archive", "maintenance"],
  ["app-bundles", "maintenance"],
  ["app-servers", "maintenance"],
  ["session-reaper", "maintenance"],
  ["session-stop-rule", "maintenance"],
  ["session-pressure-reaper", "maintenance"],
  ["session-end-lost", "maintenance"],
]);

/** 단계의 묶음(순수). 표에 없는 이름은 정비 — 빼지 않는다. */
export function tickStepGroup(name: string): TickStepGroup {
  return TICK_STEP_GROUPS.get(name) ?? "maintenance";
}

/** 요청 본문에서 뺄 묶음을 읽는다(순수). 받는 값은 "automation" 하나뿐 — 그 밖은 «아무것도 안 뺀다». */
export function parseTickSkip(body: unknown): Set<TickStepGroup> {
  const raw = body && typeof body === "object" ? (body as { skip?: unknown }).skip : undefined;
  return new Set<TickStepGroup>(Array.isArray(raw) && raw.includes("automation") ? ["automation"] : []);
}

/**
 * 틱의 단계 실행기 — 고른 묶음의 단계는 돌리지 않고 "skipped" 로 적는다. 나머지는 돌려 결과(없으면 "ok")를,
 *  던지면 {error} 를 적는다 — 한 단계가 죽어도 다음 단계는 돈다.
 */
export function tickStepRunner(skip: ReadonlySet<TickStepGroup>, out: Record<string, unknown>) {
  return async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    if (skip.has(tickStepGroup(name))) { out[name] = "skipped"; return; }
    try { out[name] = (await fn()) ?? "ok"; }
    catch (e) { out[name] = { error: e instanceof Error ? e.message : String(e) }; }
  };
}
