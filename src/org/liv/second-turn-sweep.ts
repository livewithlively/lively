// 리브 2턴 스윕(#1631) — 자체호스팅은 하우스키핑이 1분마다, **매니지드는 CP 가 테넌트마다 두드리는
//  하우스키핑 틱**(/api/ops/housekeeping/tick)이 부른다. 판정(decideSecondTurn)이 fire 면 그 세션에 증류 지시를 넣는다.
//
//  · 후보 = org_member.liv_profile.welcome 에 session_id 는 있고 distill_at·distill_gave_up_at 이 없는 사람.
//    (#5060) 파일 갈래(flow='files')는 세션 없이도 후보다 — 판정이 reopen(새로 열기)을 내면 리브 세션을 열고 2턴을 첫 지시로 넣는다.
//    ⓘ 그 사이에 사람이 리브를 열어 리브 세션이 이미 있으면(currentLivSessionId) 새로 열지 않고 **그 세션에** 넣는다 — 리브는 세션 하나다
//     (#4970 «리브 = 세션 하나»). 일하는 중이면 판정이 기다린다(turn1-running). 쉬는 대화에 정리 지시가 한 턴 들어오는 것은 의도다.
//    ⚠ 매니지드에선 그 표가 워크스페이스마다 갈려 있다(행 수준 격리) — 틱이 보는 후보는 그 틱 워크스페이스의 사람이다(#4851 실측).
//  · 일하는 워크스페이스는 secondTurnTenant(second-turn.ts)가 고른다 — 세션 등록부(workspaceForSession) → welcome 이 사는 칸(by_workspace 키) →
//    배포 규칙의 기본값(매니지드 = 지금 틱의 워크스페이스 · 자체호스팅 = primary). 수집기·잡·세션·아웃박스 조회와 표식이 모두 그 안에서 돈다.
//    ⚠ 종전엔 등록부가 모르면 곧장 primary 였다 — 매니지드는 등록부가 비어 있어 표식이 늘 실패하고 2턴이 primary 아웃박스로 갔다(#4851).
//  · 배달은 라우트와 같은 함수(deliverPrompt) — 박스면 아웃박스(입력창 확인·에코), codex app-server 면 프로토콜, 노드면 릴레이.
//  · 실패는 삼키지 않는다: 쏘지 못한 이유는 로그에, 포기는 distill_gave_up_at + distill_note 로 프로필에 남는다.
import { logger } from "../../log.js";
import { buildSecondTurnPrompt, decideSecondTurn, secondTurnTenant, sweepSlot, turnGroupInputs, type TenantRef } from "./second-turn.js";
import { onceAtATime } from "../../util/once-at-a-time.js";
import { managedMode } from "../tenancy/state.js";
import { currentTenant } from "../tenant-context.js";

// 동시 호출 가드(#1631) — 매니지드는 **테넌트마다** 틱이 들어오는데 후보 목록은 신원 전역(org_member)이라
//  같은 후보를 여러 틱이 동시에 본다. `distill_at` 은 배달 **뒤에** 찍히므로 그 사이가 겹치면 같은 세션에
//  2턴이 두 번 들어간다. 근거·한계는 util/once-at-a-time.ts 머리말.
//  ⓘ #4851 실측: 매니지드의 org_member 는 워크스페이스마다 갈려 있어(행 수준 격리) 실제로는 틱마다 그 워크스페이스의 후보만 본다 —
//   그래서 매니지드는 워크스페이스마다 한 칸으로 나눈다(second-turn sweepSlot). 칸이 하나면 앞 스윕과 겹친 워크스페이스의 틱이 매 주기 건너뛰어진다.
export const sweepLivSecondTurn = onceAtATime(
  () => runSweep(),
  () => ({ fired: 0, waited: 0, gaveUp: 0, failed: 0 }),
  () => sweepSlot(managedMode(), currentTenant()?.id),
);

async function runSweep(): Promise<{ fired: number; waited: number; gaveUp: number; failed: number }> {
  const { listLivSecondTurnCandidates, appendLivProfile, getLivProfile, listCollectors } = await import("../store.js");
  const { listSessionsRaw } = await import("../../terminal/terminal-sessions.js");
  const { listOutboxReconciled } = await import("../../sessions/outbox-late-echo.js");
  const { workspaceForSession, listWorkspaces, PRIMARY_TENANT_ID, PRIMARY_SLUG } = await import("../tenancy/registry.js");
  const { withTenant } = await import("../tenant-context.js");
  const { listCronJobs } = await import("../cron-store.js");
  const { collectorJobId } = await import("../store/collectors.js");
  const { deliverPrompt } = await import("../../terminal/deliver-prompt.js");

  const { sessionGone } = await import("../../terminal/tmux-exec.js");
  const { currentLivSessionId } = await import("./session.js");

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
    const gone = await withTenant(tenant, () => sessionGone(sid)).catch(() => false);   // #4851 — 매니지드는 세션 자리를 워크스페이스 이름으로 찾는다
    return gone ? null : { working: false, agentState: "unknown" };
  };

  //  지금 이 스윕을 부른 요청의 워크스페이스(매니지드 = 하우스키핑 틱의 워크스페이스 · 자체호스팅 타이머 = 없음).
  const reqTenant = currentTenant();
  const current: TenantRef | null = reqTenant ? { id: reqTenant.id, slug: reqTenant.slug } : null;
  const managed = managedMode();
  //  등록부(자체호스팅 다중 워크스페이스)는 그 칸이 지금 워크스페이스가 아닐 때만 한 번 읽는다(매니지드엔 등록부가 없다 — 빈 목록).
  let registry: TenantRef[] | null = null;
  const registryOnce = async (): Promise<TenantRef[]> =>
    (registry ??= (await listWorkspaces().catch(() => [])).map((w) => ({ id: String(w.id), slug: String(w.slug) })));

  for (const c of candidates) {
    //  워크스페이스(#4851 secondTurnTenant) — 킥오프 세션의 등록부 → welcome 이 사는 칸 → 배포 기본값(복원된 세션도 같은 워크스페이스에 선다).
    //  (#5060) 파일 갈래는 킥오프 세션이 없다(null) — 등록부로 워크스페이스를 못 찾으니 welcome 칸·배포 기본값으로 간다.
    const kickSid = c.welcome.session_id ? String(c.welcome.session_id) : null;
    const ws = kickSid ? await workspaceForSession(kickSid).catch(() => null) : null;
    const welcomeWs = c.workspace_id ?? null;
    const tenant = secondTurnTenant({
      mapped: ws ? { id: ws.id, slug: ws.slug } : null,
      welcomeWs,
      registry: !ws && welcomeWs && current?.id !== welcomeWs ? await registryOnce() : [],
      current, managed,
      primary: { id: PRIMARY_TENANT_ID, slug: PRIMARY_SLUG },
    });
    if (!tenant) {
      //  매니지드인데 welcome 칸이 이 틱의 워크스페이스가 아니다 — 덮어 쓰면 표식이 다른 칸에 찍혀 후보가 안 빠진다. 건너뛰고 남긴다(secondTurnTenant 머리말).
      logger.warn({ member: c.id, session: kickSid, welcomeWs, ws: current?.slug ?? null }, "리브 2턴 — welcome 칸이 이 워크스페이스가 아니다(건너뜀)");
      out.failed++; continue;
    }
    //  (#4032) 2턴은 **지금의 리브 세션**에 넣는다 — 리브 탭이 킥오프 세션을 되살렸으면 새 id 다(복원 이정표).
    //   옛 id 만 보면 «사라졌다» 로 읽고 새 세션을 또 열어, 사람이 이어 가던 대화를 두고 2턴이 딴 세션에 간다.
    //   좌표를 못 읽으면 킥오프 id 그대로 — 종전 판정(사라졌으면 reopen)으로 떨어진다.
    const sid = (await withTenant(tenant, () => currentLivSessionId(c.id)).catch(() => null)) ?? kickSid;
    const s = sid ? await sessionIn(tenant, sid) : null;
    // 수집기와 그 잡의 마지막 실행 — 그 워크스페이스 안에서 읽는다.
    const collectors = await withTenant(tenant, async () => {
      const cols = await listCollectors().catch(() => []);
      const jobs = await listCronJobs().catch(() => [] as Array<Record<string, unknown>>);
      const lastRun = new Map(jobs.map((j) => [String(j.id), (j.last_run_at as string | null) ?? null]));
      return cols.map((col) => ({ label: col.label, preset_key: col.preset_key, enabled: col.enabled, lastRunAt: lastRun.get(collectorJobId(col.id)) ?? null }));
    }).catch((err) => { logger.warn({ err, member: c.id, ws: tenant.slug }, "리브 2턴 — 수집기 조회 실패(다음 tick 재시도)"); return null; });
    if (!collectors) { out.failed++; continue; }
    //  #4851 — 기록과 다시 대조한 목록으로 센다(«미확인» 이지만 기록엔 이미 들어간 1턴을 «안 들어갔다» 로 세지 않게 — outboxPending 머리말).
    //   그 워크스페이스 안에서 묻는다 — 아웃박스도 워크스페이스마다 갈려 있다(종전엔 컨텍스트 밖·남의 틱 컨텍스트에서 물었다).
    const outboxPending = s && sid ? (await withTenant(tenant, () => listOutboxReconciled(sid)).catch(() => [])).length : 0;

    const d = decideSecondTurn({
      welcome: c.welcome,
      session: s ? { working: !!s.working, agentState: s.agentState ?? null } : null,
      outboxPending, now,
      collectors: collectors.map((x) => ({ enabled: x.enabled, lastRunAt: x.lastRunAt })),
    });
    if (d.action === "skip") continue;
    if (d.action === "wait") { out.waited++; continue; }
    if (d.action === "giveup") {
      //  포기 표식도 그 워크스페이스 칸에 찍는다(#2265) — 밖에서 쓰면 후보에서 안 빠져 매 tick 다시 판정된다.
      await withTenant(tenant, () => appendLivProfile(c.id, { welcome: { ...c.welcome, distill_gave_up_at: new Date(now).toISOString(), distill_note: d.reason } }))
        .catch((err) => logger.warn({ err, member: c.id }, "리브 2턴 — 포기 기록 실패"));
      logger.info({ member: c.id, session: sid, ws: tenant.slug, reason: d.reason }, "리브 2턴 — 포기");
      out.gaveUp++; continue;
    }
    //  일하는 형태·직무(#1631) — 2턴이 카테고리를 만들 재료다(자료가 0건이면 이것뿐이다). 후보 행에는 welcome 만 있어 따로 읽는다.
    //   못 읽어도 2턴은 쏜다 — 지시문에 «없음» 으로 실린다.
    const work = await withTenant(tenant, () => getLivProfile(c.id)).then((p) => p?.work?.asis ?? null).catch(() => null);
    //  묶음(#1631) — 카테고리 위의 **화면 층**. 처음 설정이 직업·직무로 심지만 그때 실패했을 수 있으니 여기서 한 번 더 받친다(멱등).
    //   심기는 **묶음 밖 카테고리 배치까지** 한다(seedCategoryGroups → placeUngroupedCategories) — 계정 서버가 심은 기본 카테고리처럼
    //   묶음보다 먼저 생긴 카테고리가 «묶음을 정해 주세요» 에 남지 않게.
    //   ⚠ 무대(welcome.stage)도 넘긴다 — 종전엔 null 이라 직무를 건너뛴 학업 사용자가 회사 기본 이름을 받았다(2026-09-14).
    //   ⚠ 심기가 실패해도 지시문은 «묶음부터 만든다» 로 간다(intended) — 조용히 묶음 없는 판으로 새지 않는다(실측 lively-agent-2-6a84).
    const { WORK_ASIS_SEP } = await import("../store/members.js");
    const gi = turnGroupInputs({ stage: c.welcome.stage ?? null, workAsis: work, sep: WORK_ASIS_SEP });
    const { groups, ungrouped } = await withTenant(tenant, async () => {
      const { listCategoryGroups, seedCategoryGroups, listUngroupedCategories } = await import("../../v6/category-group-store.js");
      await seedCategoryGroups({ stage: gi.stage, job: gi.job, actor: c.id }).catch((err) => {
        logger.warn({ err, member: c.id, ws: tenant.slug }, "리브 2턴 — 묶음 심기·배치 실패(지시문이 리브에게 먼저 만들게 한다)");
        return null;
      });
      const rows = await listCategoryGroups().catch(() => []);
      const loose = await listUngroupedCategories().catch(() => []);
      return {
        groups: rows.map((g) => ({ key: String(g.key), name: String(g.name), hint: (g as { hint?: string | null }).hint ?? null })),
        ungrouped: loose.map((x) => ({ key: String(x.key), name: String(x.name) })),
      };
    }).catch(() => ({ groups: [] as Array<{ key: string; name: string; hint: string | null }>, ungrouped: [] as Array<{ key: string; name: string }> }));
    //  ★ reopen(#1631) — 세션이 사라졌지만 **일은 남아 있다.** 새 창구를 열고 2턴 지시를 그 첫 지시로 넣는다.
    //   실측 2026-08-31(dev): 1턴을 성공으로 끝낸 리브 세션이 수집 대기 20분 사이에 사라졌고, 종전 코드는 그 자리에서
    //   영구 포기해 그 사람의 증류기 15개가 영원히 꺼진 채 남았다(온보딩 완주 → 지식 0건).
    //   ⚠ 딱 한 번이다 — `distill_reopened_at` 을 **먼저** 찍고 연다. 세션 생성이 실패해도 다시 시도하지 않는다
    //    (실패를 재시도하면 유령 세션이 쌓인다). 실패는 포기 표식으로 남아 화면이 «왜 안 왔나»에 답할 수 있다.
    if (d.action === "reopen") {
      const done0 = Date.parse(String(c.welcome.done_at));
      const prompt0 = buildSecondTurnPrompt({
        displayName: c.display_name,
        work, groups, intended: gi.intended, ungrouped,
        drawers: c.welcome.drawers ?? [],
        firstOrder: c.welcome.first_order ?? null,
        collectors: collectors.map((x) => ({ label: x.label, preset_key: x.preset_key, enabled: x.enabled, ran: !!x.lastRunAt && Date.parse(x.lastRunAt) > done0 })),
        partial: true, waitedMin: Math.max(0, Math.round((now - done0) / 60_000)),
        uploaded: !!c.welcome.upload_started_at, uploading: !!c.welcome.upload_started_at && !c.welcome.upload_done_at,
      });
      const stampedAt = new Date(now).toISOString();
      try {
        await withTenant(tenant, async () => {
          const cur = await getLivProfile(c.id).catch(() => null);
          await appendLivProfile(c.id, { welcome: { ...(cur?.welcome ?? c.welcome), distill_reopened_at: stampedAt } });
        });
        const { livKickoff } = await import("./kickoff.js");
        const made = await withTenant(tenant, () => livKickoff({ userId: c.id, email: "", scopes: [], projects: [] } as never,
          //  처음 설정 때 로그인돼 있던 AI(welcome.harnesses) — 스윕 자리에서 로그인을 못 재도 그 사람이 이은 AI 로 연다(claude 로 접지 않는다).
          { prompt: prompt0, remembered: c.welcome.harnesses ?? null }));
        await withTenant(tenant, async () => {
          const cur = await getLivProfile(c.id).catch(() => null);
          await appendLivProfile(c.id, { welcome: { ...(cur?.welcome ?? c.welcome), distill_reopened_at: stampedAt,
            session_id: made.session_id, distill_at: stampedAt, distill_note: d.reason === "files" ? "files-opened" : "reopened" } });
        });
        logger.info({ member: c.id, gone: sid, session: made.session_id, reason: d.reason }, d.reason === "files"
          ? "리브 2턴 — 올린 파일을 정리할 리브 세션을 새로 열고 배달" : "리브 2턴 — 세션이 사라져 새로 열고 배달");
        out.fired++;
      } catch (err) {
        await withTenant(tenant, async () => {
          const cur = await getLivProfile(c.id).catch(() => null);
          await appendLivProfile(c.id, { welcome: { ...(cur?.welcome ?? c.welcome), distill_reopened_at: stampedAt,
            distill_gave_up_at: stampedAt, distill_note: "reopen-failed" } });
        }).catch(() => { /* 비치명 */ });
        out.gaveUp++;
        logger.warn({ err, member: c.id, gone: sid }, "리브 2턴 — 다시 열기 실패(재시도하지 않는다)");
      }
      continue;
    }
    //  fire 는 살아 있는 세션이 있을 때만 나온다(판정) — 세션 id 가 없으면 넣을 자리가 없다(#5060 파일 갈래의 방어선).
    if (!sid) { out.failed++; continue; }
    // fire — 프롬프트를 조립해 그 세션에 넣는다. 배달 성공(큐 등록 포함)이면 distill_at 을 찍는다(멱등: 다음 tick 엔 후보에서 빠진다).
    const done = Date.parse(String(c.welcome.done_at));
    const prompt = buildSecondTurnPrompt({
      displayName: c.display_name,
      work, groups, intended: gi.intended, ungrouped,
      drawers: c.welcome.drawers ?? [],
      firstOrder: c.welcome.first_order ?? null,
      collectors: collectors.map((x) => ({ label: x.label, preset_key: x.preset_key, enabled: x.enabled, ran: !!x.lastRunAt && Date.parse(x.lastRunAt) >= done })),
      partial: d.partial, waitedMin: d.waitedMin,
      uploaded: !!c.welcome.upload_started_at, uploading: !!c.welcome.upload_started_at && !c.welcome.upload_done_at,
    });
    try {
      await withTenant(tenant, () => deliverPrompt(sid, prompt, { owner: c.id }));
      // ⚠ 표식은 **그 워크스페이스 컨텍스트 안에서** 찍는다(#2265) — welcome 은 워크스페이스 칸에 살아서,
      //  컨텍스트 밖에서 쓰면 옛 최상위 자리에 남아 후보에서 안 빠진다(= 2턴이 매 tick 반복 발사된다).
      await withTenant(tenant, async () => {
        const cur = await getLivProfile(c.id).catch(() => null);
        await appendLivProfile(c.id, { welcome: { ...(cur?.welcome ?? c.welcome), distill_at: new Date(now).toISOString(), distill_note: d.partial ? "partial" : null } });
      });
      logger.info({ member: c.id, session: sid, ws: tenant.slug, partial: d.partial, waitedMin: d.waitedMin }, "리브 2턴 — 증류 지시 주입");
      out.fired++;
    } catch (err) {
      out.failed++;
      logger.warn({ err, member: c.id, session: sid }, "리브 2턴 — 주입 실패(다음 tick 재시도)");
    }
  }
  return out;
}
