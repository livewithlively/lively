// 작업 컨테이너를 띄우고 걷는 자리 — 부수효과만(브로커 확보 · 멤버 홈 준비 · tmux) (#4490 앱 v2-11)
//
//  사람 세션(createSession)과 **같은 길**을 쓰되 세션이 아니다: desired 행·@box_* 표식·아웃박스·이름짓기가 없고, 세션 id 가 `job-` 다.
//   ① 브로커 확보(`/lvly/session/ensure`, tmux:"inside") — 같은 이미지·번들·gVisor, 사람 세션과 같은 메모리 캡·예약
//   ② 멤버 홈 준비(prepareMemberHome — 키트·safe.directory·git 자격) — 구독 실행은 그 멤버 홈이 붙는다(설계 §12 ④)
//   ③ 컨테이너 안 tmux 에 판(부트) — `box-spawn --cwd <작업 폴더> node -e <부트>`. 판이 빠지면 tmux 가 끝나고 브로커가 걷는다(#4696).
//  걷기는 tmux kill-session 한 번이다 — 브로커가 그 결과를 «끝났다» 신호로 받아 안이 비면 곧바로 철거한다(신호 +1초, 실측 p50 2.2초).
//  #4891 홈 없는 작업(앱 서버가 보낸 API 키 에이전트 작업)은 ①의 확보를 «홈 없음» 으로 하고(전용 계정 · 앱 폴더 작업 폴더 · 브로커가 빈 홈을
//   컨테이너 안에 만든다) ②를 건너뛴다 — 앱 서버 코드가 사람의 홈(자격 · 토큰 · 키트)을 쓰는 작업을 띄우지 못하게.
//  #5081 공용 시트 작업은 시트 계정의 홈(Claude 로그인)으로 ①을 하되 ②를 건너뛴다 — 그 홈은 구성원 누구의 지시든 닿는 자리라 시트 계정의
//   라이블리 토큰(키트) · git 자격을 새로 심지 않는다. 작업에는 필요 없다(훅은 끄고 · MCP 는 작업 토큰만 · 작업 폴더는 앱 폴더 — runner.claudeJobArgv).
//
//  ⚠ 셀프호스트(컨테이너 확보 훅 없음)는 이 길이 없다 — 작업 컨테이너는 매니지드 전용이다(자가호스팅 실행은 v2-8).
import type { LivelyUser } from "../context.js";
import { logger } from "../log.js";
import { HOMELESS_OS_USER, JOB_SESSION_ID_RE, homelessJobRefusal, jobSeatMember } from "./plan.js";
import { BOOT_SOURCE, JOB_BOOT_ENV, JOB_ID_ENV, TMUX_ARG_MAX } from "./runner.js";
import type { AgentJobRow } from "./store.js";
import type { SessionEnsureRequest } from "../terminal/session-tmux.js";

/**
 * 띄우기 실패. transient = 다시 하면 될 수도 있는 실패(OS 계정 · 작업 폴더 · 컨테이너 확보 · 홈 준비 · 판 띄우기 — 노드 자리 · 브로커 중계 ·
 *  저장소가 잠깐 막힘) — 부르는 쪽이 작업을 대기열로 되돌리고 이번 배차를 멈춘다(시도 상한까지 — service.MAX_LAUNCH_ATTEMPTS).
 *  다시 해도 안 될 것(세션 id 없음 · 실행 계정 없음·비활성 · 매니지드 아님)은 그 작업을 바로 실패로 끝낸다.
 *  ⚠ 일시 실패를 실패로 끝내면 인프라가 잠깐 막힌 사이 대기열 전체가 차례로 실패한다(격리 리뷰).
 */
export class JobLaunchError extends Error {
  constructor(message: string, readonly transient = false) { super(message); }
}

/** 띄우기의 확보 단계 — 다시 하면 될 수도 있는 것들(인프라가 잠깐 막힘). 다시 해도 안 될 것(계정·배포)은 여기 없다. */
export type LaunchStep = "os-user" | "workdir" | "ensure" | "home" | "pane";
const STEP_FAILURE: Readonly<Record<LaunchStep, string>> = {
  "os-user": "실행 계정의 OS 계정을 준비하지 못했습니다",
  workdir: "작업 폴더를 만들지 못했습니다",
  ensure: "작업 컨테이너를 확보하지 못했습니다",
  home: "실행 계정의 홈을 준비하지 못했습니다",
  pane: "작업 컨테이너에 판을 띄우지 못했습니다",
};
/** (순수) 확보 단계의 실패 → 일시(transient) 띄우기 실패. 분류는 여기 한 자리다(launch.test 가 단계마다 본다). */
export function stepFailure(step: LaunchStep, detail: unknown): JobLaunchError {
  const d = detail instanceof Error ? detail.message : String(detail ?? "");
  return new JobLaunchError(d ? `${STEP_FAILURE[step]}: ${d}` : STEP_FAILURE[step], true);
}

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

/**
 * (순수) 판 명령 tmux argv — 부트 비밀은 env(-e)로 한 번만 넘긴다. 부트가 브로커 인자 상한을 넘으면 던진다(판이 아예 안 뜬다).
 *  판 명령 꼬리(`<box-spawn> --cwd <작업 폴더> <명령>`)는 사람 세션의 session-tmux.sessionPaneArgv 와 같은 꼴이다 — launch.test 가 둘을 맞대 본다.
 */
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

/**
 * (순수) 브로커 확보 요청(`/lvly/session/ensure` 본문) — 사람 세션(createSession)과 같은 꼴에 작업 컨테이너의 몫만 얹는다.
 *  · 프로젝트 폴더에서 도는 앱 작업이면 그 앱 폴더를 `<작업 폴더>/.lively/apps/<앱>` 에 붙인다(#4684 와 같은 길). 앱 폴더가 작업 폴더면 붙일 것이 없다.
 *  · `fresh` 를 싣지 않는다 — 그 필드는 «같은 id 복원 전용»(#4694)이고, 작업 세션 id 는 무작위 꼬리가 붙어 늘 처음 보는 id 다.
 *  · 홈 없는 작업(#4891)은 `homeless: true` — 계정은 전용 계정이어야 한다(브로커가 다시 본다).
 */
export function jobEnsureRequest(
  job: Pick<AgentJobRow, "session_id" | "cwd" | "app_id" | "project_id" | "homeless">,
  o: { osUser: string; memMb: number; memRequestMb: number },
): SessionEnsureRequest {
  const apps = job.app_id && job.project_id != null ? [job.app_id] : undefined;
  return {
    sessionId: job.session_id ?? "", osUser: o.osUser, cwd: job.cwd, memMb: o.memMb, memRequestMb: o.memRequestMb, tmux: "inside",
    ...(apps ? { apps } : {}),
    ...(job.homeless === true ? { homeless: true } : {}),
  };
}

/**
 * (순수) 홈 없는 확보를 요청했는데 브로커가 «홈 없이 만들었다»(`homeless: true`)고 답하지 않았으면 사유, 아니면 null (#4891).
 *  이 칸을 모르는 옛 브로커는 요청의 homeless 를 무시하고 멤버 홈 자리를 붙인다 — 그 컨테이너에는 판을 띄우지 않는다.
 */
export function homelessEnsureMismatch(requested: boolean, made: Record<string, unknown>): string | null {
  return requested && made.homeless !== true ? `브로커가 홈 없는 작업 컨테이너를 모른다(${String(made.container ?? "?")})` : null;
}

/** 실패 문장에서 비밀을 가린다 — tmux 실행 실패는 명령줄을 통째로 싣는다(execFile 의 «Command failed: …»). */
export function redactSecret(msg: string, secret: string): string {
  return secret ? String(msg).split(secret).join("***") : String(msg);
}

/**
 * 작업 컨테이너를 띄운다 — 확보 → 멤버 홈 준비 → 판. 실패는 JobLaunchError 로 던진다(부르는 쪽이 작업을 실패로 끝내고 걷는다).
 *  ⚠ 판이 뜬 뒤의 일(부트 · 하네스 · 결과)은 판이 콜백으로 알린다 — 여기서 기다리지 않는다.
 */
export async function launchJobContainer(job: AgentJobRow, bootSecret: string, o: { sharedSeat?: boolean } = {}): Promise<{ container: string }> {
  const sid = job.session_id;
  if (!sid) throw new JobLaunchError("세션 id 가 없는 작업입니다");
  //  #4891 — 홈 없는 작업의 조건(API 키 · 앱 작업 · 앱 폴더 작업 폴더)은 부수효과 앞에서 본다. 어기면 다시 해도 안 된다.
  const homelessWhy = homelessJobRefusal(job);
  if (homelessWhy) throw new JobLaunchError(homelessWhy);
  const homeless = job.homeless === true;
  //  자리의 구성원 — 구독이면 실행 계정, API 키(#4488)면 보낸 사람(plan.jobSeatMember). 키는 자리에 들어가지 않는다(판 env 가 프록시를 가리킨다).
  //   홈 없는 작업은 그 사람의 홈 · OS 계정을 쓰지 않는다(전용 계정 · 빈 홈) — 그래도 보낸 사람은 있어야 한다(권한 판정 · 작업 AI 토큰의 기준).
  const seat = jobSeatMember(job);
  if (!seat) throw new JobLaunchError("실행 계정이 없는 작업입니다");
  const { tenantSlug, PANE_LOCALE } = await import("../terminal/catalog.js");
  const { ensureSessionContainerViaRelay, sessionEnsureArgv, tmuxInSessionContainer } = await import("../terminal/session-tmux.js");
  const slug = tenantSlug();
  if (!tmuxInSessionContainer(slug) || !slug) throw new JobLaunchError("이 배포에서는 작업 컨테이너를 띄울 수 없습니다(매니지드 전용)");
  const user = homeless ? null : await accountUser(seat);
  let osUser: string = HOMELESS_OS_USER;
  if (user) {
    const { ensureMemberOsUser } = await import("../terminal/profiles.js");
    const mine = await ensureMemberOsUser(user).catch((e) => { throw stepFailure("os-user", e); });
    if (!mine) throw stepFailure("os-user", `실행 계정 ${seat}`);
    osUser = mine;
  }
  //  메모리 — 사람 세션과 같은 정책·같은 셈(sessions.ts createSession: max 없으면 high, 0 = 브로커 기본).
  const { effectiveSessionMemoryPolicy } = await import("../sessions/session-memory-policy.js");
  const { getRuntimeConfig } = await import("../org/store/runtime-config.js");
  const mp = await effectiveSessionMemoryPolicy(() => getRuntimeConfig().then((c) => c.session_memory_policy)).catch(() => null);
  const memMb = mp ? (mp.per_session_max_mb > 0 ? mp.per_session_max_mb : mp.per_session_high_mb) : 0;
  const memRequestMb = mp?.per_session_request_mb ?? 0;
  //  작업 폴더 — 프로젝트 폴더는 사람 세션처럼 멤버 경계에서 먼저 만든다(createSession 과 같은 순서 · 없으면 바인드가 실패한다).
  //   앱 폴더(`/work/apps/<앱>`)는 브로커가 확보 때 원본을 보장한다(lvly-cloud #4490 — 링크 없이 O_NOFOLLOW 사슬). 홈 없는 작업은 앱 폴더뿐이다.
  if (job.project_id != null) {
    const { memberMkdir } = await import("../terminal/terminal-member-fs.js");
    try { await memberMkdir(osUser, job.cwd); }
    catch (e) { throw stepFailure("workdir", `${job.cwd} — ${(e as Error)?.message ?? e}`); }
  }
  let made: { container: string; created: boolean } & Record<string, unknown>;
  try {
    made = await ensureSessionContainerViaRelay(sessionEnsureArgv(slug), jobEnsureRequest(job, { osUser, memMb, memRequestMb }));
  } catch (e) {
    throw stepFailure("ensure", e);
  }
  //  어느 자리(컨테이너)에 앉았나 — 브로커 저널(철거 줄은 컨테이너 이름만 싣는다)과 이 작업을 잇는 유일한 단서다.
  logger.info({ job: job.id, session: sid, container: made.container, created: made.created, homeless, sharedSeat: o.sharedSeat === true }, "[agent-job] 작업 컨테이너 확보");
  //  #4891 — 홈 없이 만들었다는 브로커의 답이 없으면(이 칸을 모르는 옛 브로커 — 멤버 홈 자리를 붙였다) 그 컨테이너에 판을 띄우지 않는다.
  //   일시 실패로 되돌린다(노드 브로커가 새 판으로 바뀌는 중일 수 있다). 판이 없으면 tmux 도 없어 브로커의 닻 없음 안전망이 걷는다.
  const skew = homelessEnsureMismatch(homeless, made);
  if (skew) throw stepFailure("ensure", skew);
  //  #5081 — 공용 시트 작업은 시트 홈에 키트 · git 자격을 심지 않는다(머리말).
  if (user && !o.sharedSeat) {
    const { prepareMemberHome } = await import("../terminal/sessions.js");
    try { await prepareMemberHome(user, { osUser, sessionId: sid }); }
    catch (e) { throw stepFailure("home", e); }
  }
  const { orgTimezone } = await import("../org/timezone.js");
  const { BOX_SPAWN } = await import("../terminal/terminal-isolation.js");
  const { tmux } = await import("../terminal/tmux-exec.js");
  const argv = jobTmuxArgv({ sessionId: sid, jobId: job.id, bootSecret, cwd: job.cwd, tz: await orgTimezone(), slug, locale: PANE_LOCALE, boxSpawn: BOX_SPAWN });
  try {
    await tmux(argv);
  } catch (e) {
    throw stepFailure("pane", redactSecret((e as Error)?.message ?? String(e), bootSecret).slice(0, 400));
  }
  return { container: made.container };
}

type TmuxRun = (args: string[]) => Promise<unknown>;
type GoneCheck = (err: unknown) => boolean;

/**
 * 작업 컨테이너를 걷는다 — kill-session 한 번(브로커 #4696 이 그 결과를 «끝났다» 신호로 받아 안이 비면 곧바로 철거한다).
 *  · `job-<id>-<8hex>` 꼴이 아니면 **보내지 않고 던진다** — 사람 세션(`box-`)을 끄는 길이 여기로 열리지 않게 하는 마지막 자리다.
 *  · 이미 없다는 **확답**(`can't find session` — 판이 먼저 빠져 tmux 가 끝났다)만 «걷힘» 으로 삼킨다.
 *  · 그 밖(중계 시간 초과 · 브로커 오류 · 목록을 못 봄)은 던진다 — 못 걷은 것을 «걷었다» 로 적으면 하네스가 구독으로 계속 돌고
 *    아무도 다시 걷지 않는다(격리 리뷰 blocking). 부르는 쪽(service.reapJob)이 다음 감시에 다시 걷는다.
 *  run·gone 은 시험이 바꿔 끼우는 자리다(기본은 tmux 중계와 그 확답 판정).
 */
export async function killJobContainer(sessionId: string, run?: TmuxRun, gone?: GoneCheck): Promise<void> {
  if (!JOB_SESSION_ID_RE.test(sessionId)) throw new Error(`작업 세션 id 꼴이 아니다 — 걷지 않는다: ${JSON.stringify(String(sessionId).slice(0, 80))}`);
  const t = run && gone ? null : await import("../terminal/tmux-exec.js");
  try {
    await (run ?? t!.tmux)(["kill-session", "-t", sessionId]);
  } catch (e) {
    if ((gone ?? ((err: unknown) => t!.isSessionGoneError(err)))(e)) {
      logger.debug?.({ session: sessionId }, "작업 컨테이너 kill-session — 이미 끝났다(확답)");
      return;
    }
    throw e;
  }
}
