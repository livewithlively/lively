// 앱 정기 작업 설정(앱 v2 #121) — org_app_job_set. 앱 매니페스트가 깐 server 정기 작업(app_server_job)의 실행 신원(run_as) · 켜고 끔 · 지금 한 번.
//  왜 따로인가: cron_set · cron_delete · cron_run_now 는 잡 id 꼴(ID_RE)이 콜론을 받지 않아 앱 잡(app:<앱>:<key>)을 다루지 못하고, scope 가 memory 라
//   일반 구성원도 부른다 — «이 잡을 누구 이름으로 돌릴지» 는 관리자만 정해야 한다(남의 이름으로 작업을 거는 일). 그래서 admin 도구 하나를 둔다.
//  run_as 는 잡의 params 에 두고, 앱 재설치(apps/deploy.ts)가 그 값 · 켜고 끔을 지킨다.
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "./rest-util.js";
import { getCronJobState, updateCronJob } from "../org/cron-store.js";
import { runCronById } from "../scheduler/index.js";
import { runAsOf } from "../scheduler/actions/app-server-job.js";
import { getApp } from "../org/store/apps.js";
import { getMember } from "../org/store/members.js";
import { runAsGate } from "../apps/app-run-as.js";

const appJobSetInput = {
  app_id: z.string().min(1).max(100).describe("앱 id"),
  job: z.string().min(1).max(64).describe("매니페스트 jobs[].key"),
  run_as: z.string().max(200).optional().describe("이 잡을 누구로 돌릴지 — 구성원 id. 빈 글이면 기본(앱 책임자 → 설치한 사람 → 잡을 만든 사람)으로 되돌린다"),
  enabled: z.boolean().optional().describe("켜고 끔 — 앱을 다시 설치해도 이 값은 그대로다"),
  run_now: z.boolean().optional().describe("true 면 정한 때와 상관없이 지금 한 번 돌리고 결과를 함께 준다"),
};
type AppJobSetInput = z.infer<z.ZodObject<typeof appJobSetInput>>;

const appJobSet: Capability = {
  name: "org_app_job_set",
  title: "앱 정기 작업 설정",
  description:
    "앱 매니페스트가 깐 정기 작업(server 갈래 — 정한 때에 앱 서버 라우트를 백그라운드 작업으로 부르는 잡)의 실행 신원 · 켜고 끔을 정하고, 지금 한 번 돌린다. " +
    "run_as — 누구로 돌릴지(구성원 id · 빈 글이면 기본: 앱 책임자 → 설치한 사람). 작업은 그 구성원 ∩ 그 구성원의 앱 동의로 돌고, 동의가 없거나 예전 범위면 돌리지 않는다(skipped · 까닭). " +
    "enabled — 켜고 끔. run_now — 지금 한 번. 인자 없이 부르면 지금 상태(누구로 · 정한 때 · 마지막 실행)만 본다. 관리자 전용.",
  scope: "admin",
  input: appJobSetInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:app_id/jobs/:job"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return {
        app_id: req.params?.app_id, job: req.params?.job,
        ...(b.run_as !== undefined ? { run_as: b.run_as } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.run_now !== undefined ? { run_now: b.run_now } : {}),
      };
    } }],
  },
  handler: async (input: AppJobSetInput, user: LivelyUser) => {
    const appId = String(input.app_id).trim();
    const key = String(input.job).trim();
    const id = `app:${appId}:${key}`;
    const row = await getCronJobState(id);
    if (!row || row.action !== "app_server_job") {
      throw new HttpError(404, `앱 '${appId}' 의 server 정기 작업 '${key}' 이 없습니다 — 매니페스트 jobs[].run.kind 가 server 인 잡만 여기서 다룹니다(에이전트 잡은 cron_list 로 봅니다)`);
    }
    const warnings: string[] = [];
    const params: Record<string, unknown> = { ...(row.params ?? {}) };
    if (input.run_as !== undefined) {
      const want = input.run_as.trim();
      if (want) {
        const m = await getMember(want);
        if (!m || m.state !== "active") throw new HttpError(400, `활성 구성원이 아닙니다: ${want}`);
        const gate = await runAsGate(appId, m.id);
        if (gate) warnings.push(`지금은 이 구성원으로 돌지 않습니다 — ${gate}`);
        if ((m.scopes ?? []).includes("admin")) warnings.push("관리자 권한 구성원입니다 — 작업은 그 사람 ∩ 앱 동의로 돌지만, 되도록 앱에 필요한 권한만 가진 구성원을 고르세요");
        params.run_as = m.id;
      } else {
        delete params.run_as;
      }
    }
    if (input.run_as !== undefined || input.enabled !== undefined) {
      await updateCronJob({
        id, label: null, action: null, params: input.run_as !== undefined ? JSON.stringify(params) : null, interval_sec: null,
        cron_provided: false, cron_expr: null, enabled: input.enabled ?? null, note: null, run_once: null, actor: user.userId,
      });
    }
    const ran = input.run_now === true ? await runCronById(id) : null;
    const after = (await getCronJobState(id)) ?? row;
    const app = await getApp(appId);
    const who = runAsOf(after.params ?? {}, app, { created_by: after.created_by });
    return {
      id, enabled: after.enabled, schedule: after.cron_expr, route: after.params?.route ?? null,
      run_as: who ? { member: who.member, via: who.via } : null,
      last_run: after.last_run_at ? { at: after.last_run_at, status: after.last_status, summary: after.last_summary } : null,
      ...(warnings.length ? { warnings } : {}),
      ...(ran ? { run: ran } : {}),
    };
  },
};

export const appScheduleCapabilities: Capability[] = [appJobSet];
