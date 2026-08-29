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

  const out = { fired: 0, waited: 0, gaveUp: 0, failed: 0 };
  const candidates = await listLivSecondTurnCandidates();
  if (!candidates.length) return out;
  const sessions = new Map((await listSessionsRaw()).map((s) => [s.id, s]));
  const now = Date.now();

  for (const c of candidates) {
    const sid = String(c.welcome.session_id);
    const s = sessions.get(sid) ?? null;
    const ws = await workspaceForSession(sid).catch(() => null);
    const tenant = ws ? { id: ws.id, slug: ws.slug } : { id: PRIMARY_TENANT_ID, slug: PRIMARY_SLUG };
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
