// 앱 정기 작업의 server 갈래(앱 v2 #121) — 매니페스트 jobs[].run.kind "server" 를 정한 때에 앱 서버 라우트로 부른다(앱 백그라운드 작업 하나).
//  왜: 정기 작업은 AI 에이전트(agent_headless)로만 깔렸다 — 앱 서버의 기계적인 일(새 배포판 확인 · 장부 정리)을 돌리려 해도 에이전트를 띄워 도구를
//   부르게 해야 했다. server 갈래는 에이전트 없이 앱 서버 라우트를 곧바로 백그라운드 작업으로 부른다(앱 SDK 의 livelyJobs 와 같은 작업).
//  누구로 도나(상민 2026-11-22 «지정 구성원(run_as)»): 관리자가 정한 구성원(params.run_as — org_app_job_set) → 앱 책임자(owner_member) →
//   설치한 사람(installed_by) → 잡을 만든 사람(created_by). 작업은 그 구성원 ∩ 그 구성원의 앱 동의로 돈다(startAppJob · 작업 토큰).
//  표시: source 'schedule'(앱은 x-lively-job-source 로 정기 실행임을 안다) · unattended · automation(사람이 보지도 시키지도 않은 작업 — 판정은
//   ai-runs/plan.ts subscriptionRefusal: 공용 시트는 받고 개인 구독은 거절).
//  돌리지 않음(skipped)과 고장(error)을 가른다 — 설치 직후 곧바로 한 번 도는데(cron-due · last_run_at 없음) 관리자 설치 뒤 서버는 따로 올리니,
//   그때(서버 없음 409 · 서버 실행 꺼짐 501 · 서버 멈춤 503 · 앱 없음 404)를 고장으로 세어 브레이커(연속 실패 → 자동 정지)를 당기지 않게.
//   구성원 · 동의 문제도 skipped 다 — 관리자가 고칠 일이고, 고장 세기로 잡이 꺼지면 고친 뒤 사람이 다시 켜야 해서.
//  무거운 의존(앱 작업 · 저장소)은 실행 때 동적으로 읽는다 — 등록부(registry.ts)의 정적 로드가 부팅 비용 · 순환 의존을 만들지 않게(registry.ts 머리말).
import type { CronJob } from "../registry.js";
import type { LivelyUser } from "../../context.js";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
/** 작업 이름 — 같은 정기 작업이 아직 도는지 이 이름으로 찾는다. */
export const scheduleJobLabel = (key: string): string => `정기: ${key}`;

/** 이 잡을 누구로 돌리나 — 위 머리말의 차례. 정할 수 없으면 null. */
export function runAsOf(params: Record<string, unknown>, app: { owner_member: string | null; installed_by: string | null } | null, job: Pick<CronJob, "created_by">): { member: string; via: string } | null {
  const pick: Array<[string, string]> = [
    [str(params.run_as), "run_as"], [str(app?.owner_member), "owner"], [str(app?.installed_by), "installer"], [str(job.created_by), "creator"],
  ];
  const hit = pick.find(([m]) => m);
  return hit ? { member: hit[0], via: hit[1] } : null;
}

export async function runAppServerJob(params: Record<string, unknown>, job: CronJob): Promise<{ status: string; summary: unknown }> {
  const appId = str(params.app_id);
  const route = str(params.route);
  const key = str(params.job_key) || job.id;
  if (!appId || !route) return { status: "error", summary: "params 에 app_id · route 가 없습니다 — 앱 설치가 깐 잡이 아닙니다" };
  const [{ getApp }, { getMember }, { runAsGate }, { SCHEDULE_JOB_SOURCE, startAppJob }, { listAppJobs }] = await Promise.all([
    import("../../org/store/apps.js"), import("../../org/store/members.js"), import("../../apps/app-run-as.js"),
    import("../../apps/app-jobs.js"), import("../../apps/app-jobs-store.js"),
  ]);
  const app = await getApp(appId);
  if (!app) return { status: "skipped", summary: `앱 '${appId}' 이 없습니다` };
  const who = runAsOf(params, app, job);
  if (!who) return { status: "skipped", summary: "누구로 돌릴지 정할 수 없습니다 — org_app_job_set 으로 run_as 를 정하세요" };
  const gate = await runAsGate(appId, who.member);
  if (gate) return { status: "skipped", summary: { reason: gate, run_as: who.member, via: who.via } };
  //  같은 정기 작업의 앞 실행이 아직 줄에 있거나 돌고 있으면 건너뛴다(앞 실행이 길어져 쌓이지 않게).
  const label = scheduleJobLabel(key);
  const recent = await listAppJobs({ appId, limit: 50 }).catch(() => []);
  const open = recent.find((r) => r.label === label && r.source === SCHEDULE_JOB_SOURCE && (r.status === "queued" || r.status === "dispatched" || r.status === "running"));
  if (open) return { status: "skipped", summary: { reason: `앞 실행(작업 #${open.id})이 아직 끝나지 않았습니다`, job: open.id } };
  const m = await getMember(who.member);
  const user: LivelyUser = { userId: who.member, email: m?.email ?? "", scopes: m?.scopes ?? [], projects: ["*"] };
  const body = params.body && typeof params.body === "object" && !Array.isArray(params.body) ? params.body : {};
  try {
    const out = await startAppJob({ app_id: appId, route, body, label }, user, { source: SCHEDULE_JOB_SOURCE, unattended: true, automation: true });
    return { status: "ok", summary: { job: out.id ?? null, run_as: who.member, via: who.via } };
  } catch (e) {
    const status = (e as { status?: number })?.status;
    const reason = (e as Error)?.message ?? String(e);
    if (status === 404 || status === 409 || status === 501 || status === 503) {
      return { status: "skipped", summary: { reason: `작업을 시작하지 않았습니다(${status}): ${reason}`, run_as: who.member } };
    }
    return { status: "error", summary: { reason: `작업을 시작하지 못했습니다(${status ?? "?"}): ${reason}`, run_as: who.member } };
  }
}
