// 사람 대신 도는 앱 작업의 신원 관문(앱 v2 #121) — 정기 작업(scheduler/actions/app-server-job.ts)과 그 신원을 정하는 도구(org_app_job_set)가 같이 쓴다.
//  «그 구성원으로 이 앱 작업을 돌릴 수 있나» — 구성원(활성 · 워크스페이스 출입) · 앱(활성 · 켜짐 · 그 구성원에게 보임) · 동의(있음 · 앱의 지금 선언을 덮음).
//  startAppJob 도 앞의 것을 다시 보지만, 여기서 먼저 보면 «돌리지 않음(skipped)» 과 «고장(error)» 을 가를 수 있다.
//  슬랙 다리(org/slack-bridge/manager.ts runnable)와 같은 판정이다 — 그쪽은 사람에게 보일 안내 글까지 짓는다.
import { getMember } from "../org/store/members.js";
import { getApp, getActiveGrant } from "../org/store/apps.js";
import { workspaceAccessAllowed } from "../org/tenancy/gate.js";
import { canSeeApp } from "./visibility.js";
import { logger } from "../log.js";

/** 못 돌리면 그 까닭(한 줄), 돌릴 수 있으면 null. */
export async function runAsGate(appId: string, memberId: string): Promise<string | null> {
  const m = await getMember(memberId);
  if (!m || m.state !== "active") return `구성원 '${memberId}' 이 활성 상태가 아닙니다`;
  if (!(await workspaceAccessAllowed(m.id))) return `구성원 '${memberId}' 이 이 워크스페이스에 들어올 수 없습니다`;
  const app = await getApp(appId);
  if (!app || app.status !== "active" || !app.enabled) return `앱 '${appId}' 이 없거나 꺼져 있습니다`;
  if (!canSeeApp(app, { userId: m.id, scopes: m.scopes ?? [] })) return `구성원 '${memberId}' 에게 보이지 않는 앱입니다`;
  if (!(await getActiveGrant(appId, m.id))) return `구성원 '${memberId}' 이 앱에 동의하지 않았습니다 — 그 구성원이 앱을 한 번 열어 동의해야 합니다`;
  //  #1644 — 동의가 앱의 지금 선언 전체를 덮나. 앱이 동의 뒤에 권한을 넓혔으면 예전 동의로 도는 작업은 새 권한에서 막히거나 조용히 빠진다 —
  //   시작하지 않고 까닭을 남긴다. 판정을 읽지 못하면 종전대로 돌린다(권한의 경계는 작업 토큰 — 그 사람 ∩ 동의 — 이 그대로 지킨다).
  const { consentCoverage } = await import("./app-consent-gap.js");
  const { describeGrantGap, grantGapEmpty } = await import("./grant.js");
  const cov = await consentCoverage(appId, m.id, { installed: app }).catch((e: unknown) => {
    logger.warn({ app: appId, member: m.id, err: (e as Error)?.message ?? String(e) }, "[app-run-as] 동의 덮음 판정을 읽지 못했다 — 종전대로 돌린다(#1644)");
    return null;
  });
  if (cov && !grantGapEmpty(cov.gap)) return `구성원 '${memberId}' 의 앱 동의가 예전 범위입니다(동의에 없는 것: ${describeGrantGap(cov.gap)}) — 그 구성원이 다시 동의해야 합니다`;
  return null;
}
