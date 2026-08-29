// 리브 2턴 스윕(#1631) — 하우스키핑이 1분마다 부른다. 판정(decideSecondTurn)이 fire 면 그 세션에 증류 지시를 넣는다.
//
//  · 후보 = org_member.liv_profile.welcome 에 session_id 는 있고 distill_at·distill_gave_up_at 이 없는 사람(신원 전역 표).
//  · 그 세션의 워크스페이스는 gw_session_map(workspaceForSession)이 정본이다 — liv_profile 엔 워크스페이스 축이 없다(#2265).
//    수집기·잡 조회는 그 테넌트 컨텍스트 안에서 한다. 매핑이 없으면 primary(단일 테넌트) 로 본다.
//  · 배달은 라우트와 같은 함수(deliverPrompt) — 박스면 아웃박스(입력창 확인·에코), codex app-server 면 프로토콜, 노드면 릴레이.
//  · 실패는 삼키지 않는다: 쏘지 못한 이유는 로그에, 포기는 distill_gave_up_at + distill_note 로 프로필에 남는다.
import { logger } from "../../log.js";
import { buildSecondTurnPrompt, decideSecondTurn } from "./second-turn.js";

export async function sweepLivSecondTurn(): Promise<{ fired: number; waited: number; gaveUp: number; failed: number }> {
  const { listLivSecondTurnCandidates, appendLivProfile, getLivProfile, listCollectors } = await import("../store.js");
  const { listSessionsRaw } = await import("../../terminal/terminal-sessions.js");
  const { listOutbox } = await import("../../sessions/session-outbox.js");
  const { workspaceForSession, PRIMARY_TENANT_ID, PRIMARY_SLUG } = await import("../tenancy/registry.js");
  const { withTenant } = await import("../tenant-context.js");
  const { listCronJobs } = await import("../cron-store.js");
  const { collectorJobId } = await import("../store/collectors.js");
  const { deliverPrompt } = await import("../../terminal/deliver-prompt.js");

  const { sessionGone } = await import("../../terminal/tmux-exec.js");

  const out = { fired: 0, waited: 0, gaveUp: 0, failed: 0 };
  const candidates = await listLivSecondTurnCandidates();
  if (!candidates.length) return out;
  const now = Date.now();
  // ★ 세션 목록은 **워크스페이스 컨텍스트로 걸러진다**(실측 2026-08-29 dev: 같은 세션이 그 워크스페이스 헤더로는 보이고
  //  primary 로는 안 보였다 → 컨텍스트 없이 읽은 첫 판은 살아 있는 세션을 'session-gone' 으로 포기했다).
  //  그래서 목록은 그 세션의 테넌트 안에서 읽는다(테넌트별 1회 캐시). 그래도 없으면 tmux 에 직접 묻는다 —
  //  **없다고 확인된 것만 포기**한다(모르는 상태를 '없음'으로 읽어 파괴적 결정을 내리지 않는다, #1675 규율).
  const listCache = new Map<string, Map<string, { working?: boolean; agentState?: string | null }>>();
  const sessionIn = async (tenant: { id: string; slug: string }, sid: string) => {
    let m = listCache.get(tenant.id);
    if (!m) {
      const rows = await withTenant(tenant, () => listSessionsRaw()).catch(() => [] as Array<{ id: string; working?: boolean; agentState?: string | null }>);
      m = new Map(rows.map((s) => [s.id, { working: s.working, agentState: s.agentState ?? null }]));
      listCache.set(tenant.id, m);
    }
    const hit = m.get(sid);
    if (hit) return hit;
    // 목록엔 없지만 tmux 엔 있다(노드 세션·목록 필터 밖) → 상태를 모르는 채로 살아 있음. 없다고 확인되면 null.
    const gone = await sessionGone(sid).catch(() => false);
    return gone ? null : { working: false, agentState: "unknown" };
  };

  for (const c of candidates) {
    const sid = String(c.welcome.session_id);
    const ws = await workspaceForSession(sid).catch(() => null);
    const tenant = ws ? { id: ws.id, slug: ws.slug } : { id: PRIMARY_TENANT_ID, slug: PRIMARY_SLUG };
    const s = await sessionIn(tenant, sid);
    // 수집기와 그 잡의 마지막 실행 — 그 워크스페이스 안에서 읽는다.
    const collectors = await withTenant(tenant, async () => {
      const cols = await listCollectors().catch(() => []);
      const jobs = await listCronJobs().catch(() => [] as Array<Record<string, unknown>>);
      const lastRun = new Map(jobs.map((j) => [String(j.id), (j.last_run_at as string | null) ?? null]));
      return cols.map((col) => ({ label: col.label, preset_key: col.preset_key, enabled: col.enabled, lastRunAt: lastRun.get(collectorJobId(col.id)) ?? null }));
    }).catch((err) => { logger.warn({ err, member: c.id, ws: tenant.slug }, "리브 2턴 — 수집기 조회 실패(다음 tick 재시도)"); return null; });
    if (!collectors) { out.failed++; continue; }
    const outboxPending = s ? (await listOutbox(sid).catch(() => [])).length : 0;

    const d = decideSecondTurn({
      welcome: c.welcome,
      session: s ? { working: !!s.working, agentState: s.agentState ?? null } : null,
      outboxPending, now,
      collectors: collectors.map((x) => ({ enabled: x.enabled, lastRunAt: x.lastRunAt })),
    });
    if (d.action === "skip") continue;
    if (d.action === "wait") { out.waited++; continue; }
    if (d.action === "giveup") {
      await appendLivProfile(c.id, { welcome: { ...c.welcome, distill_gave_up_at: new Date(now).toISOString(), distill_note: d.reason } })
        .catch((err) => logger.warn({ err, member: c.id }, "리브 2턴 — 포기 기록 실패"));
      logger.info({ member: c.id, session: sid, reason: d.reason }, "리브 2턴 — 포기");
      out.gaveUp++; continue;
    }
    // fire — 프롬프트를 조립해 그 세션에 넣는다. 배달 성공(큐 등록 포함)이면 distill_at 을 찍는다(멱등: 다음 tick 엔 후보에서 빠진다).
    const done = Date.parse(String(c.welcome.done_at));
    const prompt = buildSecondTurnPrompt({
      displayName: c.display_name,
      drawers: c.welcome.drawers ?? [],
      firstOrder: c.welcome.first_order ?? null,
      collectors: collectors.map((x) => ({ label: x.label, preset_key: x.preset_key, enabled: x.enabled, ran: !!x.lastRunAt && Date.parse(x.lastRunAt) >= done })),
      partial: d.partial, waitedMin: d.waitedMin,
    });
    try {
      await withTenant(tenant, () => deliverPrompt(sid, prompt, { owner: c.id }));
      const cur = await getLivProfile(c.id).catch(() => null);
      await appendLivProfile(c.id, { welcome: { ...(cur?.welcome ?? c.welcome), distill_at: new Date(now).toISOString(), distill_note: d.partial ? "partial" : null } });
      logger.info({ member: c.id, session: sid, partial: d.partial, waitedMin: d.waitedMin }, "리브 2턴 — 증류 지시 주입");
      out.fired++;
    } catch (err) {
      out.failed++;
      logger.warn({ err, member: c.id, session: sid }, "리브 2턴 — 주입 실패(다음 tick 재시도)");
    }
  }
  return out;
}
