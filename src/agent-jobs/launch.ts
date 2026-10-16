// 작업 컨테이너를 띄우고 걷는 자리 — 부수효과만(브로커 확보 · 멤버 홈 준비 · tmux) (#4490 앱 v2-11)
//
//  사람 세션(createSession)과 **같은 길**을 쓰되 세션이 아니다: desired 행·@box_* 표식·아웃박스·이름짓기가 없고, 세션 id 가 `job-` 다.
//   ① 브로커 확보(`/lvly/session/ensure`, tmux:"inside", fresh) — 같은 이미지·번들·gVisor, 사람 세션과 같은 메모리 캡·예약
//   ② 멤버 홈 준비(prepareMemberHome — 키트·safe.directory·git 자격) — 구독 실행은 그 멤버 홈이 붙는다(설계 §12 ④)
//   ③ 컨테이너 안 tmux 에 판(부트) — `box-spawn --cwd <작업 폴더> node -e <부트>`. 판이 빠지면 tmux 가 끝나고 브로커가 걷는다(#4696).
//  걷기는 tmux kill-session 한 번이다 — 브로커가 그 결과를 «끝났다» 신호로 받아 안이 비면 곧바로 철거한다(신호 +1초, 실측 p50 2.2초).
//
//  ⚠ 셀프호스트(컨테이너 확보 훅 없음)는 이 길이 없다 — 작업 컨테이너는 매니지드 전용이다(자가호스팅 실행은 v2-8).
import type { LivelyUser } from "../context.js";
import { logger } from "../log.js";
import { BOOT_SOURCE, JOB_BOOT_ENV, JOB_ID_ENV, TMUX_ARG_MAX } from "./runner.js";
import type { AgentJobRow } from "./store.js";

export class JobLaunchError extends Error {}

/** 이 배포에서 작업 컨테이너를 띄울 수 있나(매니지드 — 세션 컨테이너 확보 훅이 있고 테넌트 컨텍스트가 있다). */
export async function jobContainersAvailable(): Promise<boolean> {
  const { tenantSlug } = await import("../terminal/catalog.js");
  const { tmuxInSessionContainer } = await import("../terminal/session-tmux.js");
  return tmuxInSessionContainer(tenantSlug());
}

/** 실행 계정 멤버를 LivelyUser 로 — OS 계정·멤버 홈 준비(git 자격)가 이 신원으로 돈다. 비활성·사람 아님이면 던진다. */
async function accountUser(memberId: string): Promise<LivelyUser> {
  const { getMember } = await import("../org/store/members.js");
  const m = await getMember(memberId);
  if (!m || m.state !== "active" || (m.kind && m.kind !== "human")) throw new JobLaunchError(`실행 계정(${memberId})이 활성 사람 구성원이 아닙니다`);
  return { userId: m.id, email: m.email ?? undefined, scopes: Array.isArray(m.scopes) ? m.scopes : [] } as LivelyUser;
}

/** (순수) 판 명령 tmux argv — 부트 비밀은 env(-e)로 한 번만 넘긴다. 부트가 브로커 인자 상한을 넘으면 던진다(판이 아예 안 뜬다). */
export function jobTmuxArgv(o: { sessionId: string; jobId: number; bootSecret: string; cwd: string; tz: string; slug: string; locale: string; boxSpawn: string }): string[] {
  if (BOOT_SOURCE.length > TMUX_ARG_MAX) throw new Error(`판 부트가 tmux 인자 상한(${TMUX_ARG_MAX})을 넘는다: ${BOOT_SOURCE.length}`);
  return [
    "new-session", "-d", "-s", o.sessionId, "-x", "200", "-y", "50",
    "-e", `LANG=${o.locale}`, "-e", `LC_CTYPE=${o.locale}`, "-e", `LC_ALL=${o.locale}`,
    "-e", `TZ=${o.tz}`,
    "-e", `LVLY_TENANT_SLUG=${o.slug}`,
    //  기계 세션 표식 — 혹시 도는 훅이 있으면 사람 세션 일(프로젝트 자동 생성·이름짓기)을 하지 않게(session-kind.ts). 하네스 훅은 끈다(runner.claudeJobArgv).
    "-e", "LIVELY_SESSION_KIND=task",
    "-e", `${JOB_ID_ENV}=${o.jobId}`,
    "-e", `${JOB_BOOT_ENV}=${o.bootSecret}`,
    o.boxSpawn, "--cwd", o.cwd, "node", "-e", BOOT_SOURCE,
  ];
}

/** 실패 문장에서 비밀을 가린다 — tmux 실행 실패는 명령줄을 통째로 싣는다(execFile 의 «Command failed: …»). */
export function redactSecret(msg: string, secret: string): string {
  return secret ? String(msg).split(secret).join("***") : String(msg);
}

/**
 * 작업 컨테이너를 띄운다 — 확보 → 멤버 홈 준비 → 판. 실패는 JobLaunchError 로 던진다(부르는 쪽이 작업을 실패로 끝내고 걷는다).
 *  ⚠ 판이 뜬 뒤의 일(부트 · 하네스 · 결과)은 판이 콜백으로 알린다 — 여기서 기다리지 않는다.
 */
export async function launchJobContainer(job: AgentJobRow, bootSecret: string): Promise<{ container: string }> {
  const sid = job.session_id;
  if (!sid) throw new JobLaunchError("세션 id 가 없는 작업입니다");
  if (!job.account_member) throw new JobLaunchError("실행 계정이 없는 작업입니다(API 키 실행은 아직 없다 — v2-9)");
  const { tenantSlug, PANE_LOCALE } = await import("../terminal/catalog.js");
  const { ensureSessionContainerViaRelay, sessionEnsureArgv, tmuxInSessionContainer } = await import("../terminal/session-tmux.js");
  const slug = tenantSlug();
  if (!tmuxInSessionContainer(slug) || !slug) throw new JobLaunchError("이 배포에서는 작업 컨테이너를 띄울 수 없습니다(매니지드 전용)");
  const user = await accountUser(job.account_member);
  const { ensureMemberOsUser } = await import("../terminal/profiles.js");
  const osUser = await ensureMemberOsUser(user);
  if (!osUser) throw new JobLaunchError(`실행 계정(${job.account_member})의 OS 계정을 준비하지 못했습니다`);
  //  메모리 — 사람 세션과 같은 정책·같은 셈(sessions.ts createSession: max 없으면 high, 0 = 브로커 기본).
  const { effectiveSessionMemoryPolicy } = await import("../sessions/session-memory-policy.js");
  const { getRuntimeConfig } = await import("../org/store/runtime-config.js");
  const mp = await effectiveSessionMemoryPolicy(() => getRuntimeConfig().then((c) => c.session_memory_policy)).catch(() => null);
  const memMb = mp ? (mp.per_session_max_mb > 0 ? mp.per_session_max_mb : mp.per_session_high_mb) : 0;
  const memRequestMb = mp?.per_session_request_mb ?? 0;
  //  프로젝트 폴더에서 도는 앱 작업이면 그 앱 폴더를 `<작업 폴더>/.lively/apps/<앱>` 에 붙인다(#4684 와 같은 길). 앱 폴더가 작업 폴더면 붙일 것이 없다.
  const apps = job.app_id && job.project_id != null ? [job.app_id] : undefined;
  //  작업 폴더 — 프로젝트 폴더는 사람 세션처럼 멤버 경계에서 먼저 만든다(createSession 과 같은 순서 · 없으면 바인드가 실패한다).
  //   앱 폴더(`/work/apps/<앱>`)는 브로커가 확보 때 원본을 보장한다(lvly-cloud #4490 — 링크 없이 O_NOFOLLOW 사슬).
  if (job.project_id != null) {
    const { memberMkdir } = await import("../terminal/terminal-member-fs.js");
    try { await memberMkdir(osUser, job.cwd); }
    catch (e) { throw new JobLaunchError(`작업 폴더를 만들지 못했습니다(${job.cwd}): ${(e as Error)?.message ?? e}`); }
  }
  let made: { container: string; created: boolean } & Record<string, unknown>;
  try {
    made = await ensureSessionContainerViaRelay(sessionEnsureArgv(slug), {
      sessionId: sid, osUser, cwd: job.cwd, memMb, memRequestMb, tmux: "inside", fresh: true,
      ...(apps ? { apps } : {}),
    });
  } catch (e) {
    throw new JobLaunchError(`작업 컨테이너를 확보하지 못했습니다: ${(e as Error)?.message ?? e}`);
  }
  //  어느 자리(컨테이너)에 앉았나 — 브로커 저널(철거 줄은 컨테이너 이름만 싣는다)과 이 작업을 잇는 유일한 단서다.
  logger.info({ job: job.id, session: sid, container: made.container, created: made.created }, "[agent-job] 작업 컨테이너 확보");
  const { prepareMemberHome } = await import("../terminal/sessions.js");
  await prepareMemberHome(user, { osUser, sessionId: sid });
  const { orgTimezone } = await import("../org/timezone.js");
  const { BOX_SPAWN } = await import("../terminal/terminal-isolation.js");
  const { tmux } = await import("../terminal/tmux-exec.js");
  const argv = jobTmuxArgv({ sessionId: sid, jobId: job.id, bootSecret, cwd: job.cwd, tz: await orgTimezone(), slug, locale: PANE_LOCALE, boxSpawn: BOX_SPAWN });
  try {
    await tmux(argv);
  } catch (e) {
    throw new JobLaunchError(`작업 컨테이너에 판을 띄우지 못했습니다: ${redactSecret((e as Error)?.message ?? String(e), bootSecret).slice(0, 400)}`);
  }
  return { container: made.container };
}

/**
 * 작업 컨테이너를 걷는다 — kill-session 한 번(브로커 #4696 이 그 결과를 «끝났다» 신호로 받아 안이 비면 곧바로 철거한다).
 *  이미 없으면(판이 먼저 빠져 tmux 가 끝났다) tmux 가 실패를 돌려준다 — 그것도 같은 신호라 삼킨다. 던지지 않는다.
 */
export async function killJobContainer(sessionId: string): Promise<void> {
  try {
    const { tmux } = await import("../terminal/tmux-exec.js");
    await tmux(["kill-session", "-t", sessionId]);
  } catch (e) {
    logger.debug?.({ session: sessionId, err: (e as Error)?.message }, "작업 컨테이너 kill-session — 이미 끝났다(무해)");
  }
}
