// 박스 위 실행면 — 브로커가 없는 박스(셀프호스트)에서 작업 판을 이 박스의 tmux 에 띄우고 걷는다 (#5082)
//
//  매니지드 길(launch.ts — 브로커가 job- 컨테이너를 확보)과 단계는 같고 자리만 다르다:
//   ① OS 계정 — 사람 세션과 같은 판정(ensureMemberOsUser). 격리 박스면 실행 계정 구성원의 box_<사람>, 비격리 박스(격리 꺼짐 · 맥)면 게이트웨이 계정.
//      ⚠ 격리를 지원하는 박스에서 그 계정을 못 만들었으면 게이트웨이 계정으로 내려앉지 않는다 — 앱이 시킨 지시가 게이트웨이 권한(.env · DB)으로
//       돌게 되기 때문이다(사람 세션은 그 폴백을 하지만 사람이 직접 모는 셸이다). 일시 실패로 되돌려 다시 만든다.
//   ② 작업 폴더 — 행의 작업 폴더는 컨테이너 경로(/work/apps/<앱> · /work/shared/project/<n>)다. 그 사람이 보는 박스 위 자리로 옮긴다
//      (hostJobDir → profiles.resolveRootPath — 사람 세션 · 탐색기와 같은 자). 판이 받는 작업 폴더(paneView)도 같은 자로 다시 구한다.
//   ③ 홈 준비 — 격리 판만 prepareMemberHome(사람 세션의 비컨테이너 격리 분기와 같은 자리 · 키트 · safe.directory · git 자격).
//      #5081 공용 시트 작업은 건너뛴다 — 그 홈은 구성원 누구의 지시든 닿는 자리라 키트(라이블리 토큰) · git 자격을 새로 심지 않는다(launch.ts 와 같다).
//   ④ 판 — `tmux new-session -d -s job-…` 에 판 머리(PANE_PRELUDE) + 부트. 격리면 sudo box-spawn 으로 내려가고, 비격리면 tmux -c 와 그 사람의
//      Claude 설정 폴더(CLAUDE_CONFIG_DIR). 사람 세션 목록 · 복원은 `box-` 만 보므로 이 판은 안 뜬다(plan.jobSessionId 머리말).
//   ⑤ 메모리 상한 — 작업 정책의 memory_max_mb(기본 3072)를 격리 판의 cgroup MemoryMax 로 걸고, 스왑은 막는다(MemorySwapMax=0 — box-cgspawn
//      네 번째 값). MemoryMax 만 걸면 넘친 만큼 스왑으로 빠져 상한이 RAM 에만 걸린다(실측 2026-10-29 Ubuntu 24.04 · 스왑 8G: 상한 512MiB 작업이
//      스왑 1,696MiB). 사람 세션과 래퍼는 같고 값의 출처가 다르다(사람 세션은 세션 메모리 정책 · 스왑 값을 넘기지 않는다 — 종전 그대로).
//      상한을 둔 정책인데 걸 수 없으면 띄우지 않는다(CONTRIBUTING «정책은 있는데 집행 수단이 없으면 오류») — 래퍼가 없거나 sudo 가 허용하지 않으면
//      다시 해도 안 될 실패, 묻다 끊겼거나 래퍼가 스왑 값을 모르는 옛 판이면 일시 실패(옛 판은 배포가 새 판을 띄운 뒤 래퍼를 다시 놓는 사이에
//      생긴다 — cgspawnCheck). 비격리 박스는 걸 자리가 원래 없어(사람 세션도 같다) 그대로 띄우고 관리자 보기(agent_job_limits surface)에 보인다.
//      작업 폴더를 만들기 전에 본다.
//
//  ── 부트 비밀은 명령줄에 싣지 않는다(#4422) ──
//   이 박스의 프로세스 목록(/proc/<pid>/cmdline)은 다른 구성원도 본다 — tmux 클라이언트의 `-e LVLY_JOB_BOOT=…` 는 그 순간 남에게 보이고,
//   본 사람은 그 작업의 프롬프트 · 앱 토큰을 받아 갈 수 있다(매니지드는 tmux 가 그 작업 컨테이너 안이라 이 틈이 없다). 그래서 비밀은 판 계정이
//   새로 만든 0700 임시 폴더의 0600 파일로 두고, 판 머리가 읽자마자 지운 뒤 env 로 부트에 넘긴다. 작업 id · 포트 · 워크스페이스는 비밀이 아니라
//   인자로 넘겨 판 머리가 env 로 세운다 — sudo 의 env_reset 을 건너야 할 새 이름이 생기지 않는다(sudoers 재생성 · 박스 재설치가 필요 없다).
//
//  걷기는 같은 tmux 에 kill-session 한 번이다. 이미 없다는 확답에 «tmux 서버 자체가 없다» 를 넣는다 — 작업 판만 있던 서버는 판이 빠질 때
//   함께 끝난다(사람 세션의 «서버 없음 = 판정 불가» 규약은 서버가 잠깐 안 보이는 것일 수 있어서지만, 서버 없이 사는 판은 없다).
//  ⚠ 홈 없는 작업(#4891 — 앱 서버가 보낸 API 키 에이전트 작업)은 이 길에서 띄우지 않는다 — 전용 계정의 빈 홈이 이 박스에 없다.
//
//  ── 1단계(박스 위)의 한계 — 도커 실행면(2단계)이 닫는다 ──
//   · 판은 그 구성원 OS 계정으로 돈다 — 그 계정이 읽을 수 있는 공유 자리(다른 프로젝트 · 다른 앱 폴더)가 다 보인다(live.ts 머리말).
//   · 같은 구성원의 작업 · 사람 세션은 같은 uid 다 — 서로의 프로세스 env(/proc/<pid>/environ)와 임시 파일을 읽는다. 한 작업의 AI 가 같은 사람의
//     다른 작업이 받은 앱 토큰 · 프록시 토큰을 읽을 수 있다(홈의 키트 토큰을 읽을 수 있는 것과 같은 한계).
//   · 앱 폴더는 처음 만든 구성원 소유(2755 — sudo 기본 umask 022)라 다른 구성원의 작업은 읽기만 된다(사람 세션도 같다 — apps/app-folder-ops 머리말).
//   · 앱 작업이 프로젝트 폴더에서 돌면(project_id) 그 앱 폴더가 작업 폴더 안(.lively/apps/<앱>)에 붙지 않는다 — 박스 위 경로로 직접 연다.
import type { LivelyUser } from "../context.js";
import { logger } from "../log.js";
import { APP_ID_RE, JOB_SESSION_ID_RE, jobSeatMember } from "./plan.js";
import { BOOT_SOURCE, RUNNER_GATEWAY } from "./runner.js";
import { JobLaunchError, redactSecret, stepFailure } from "./launch.js";
import type { AgentJobRow } from "./store.js";
import type { PaneView } from "./surface.js";
import type { CgroupLimit } from "../terminal/terminal-isolation.js";

/** 박스 위 자리 — 사람 세션의 루트 키(catalog.roots)와 그 안 경로. */
export interface HostJobDir { root: "apps" | "shared"; sub: string }

/**
 * (순수) 행의 작업 폴더(컨테이너 경로) → 박스 위 루트와 그 안 경로. 꼴 밖이면 null(옮기지 않는다).
 *  행의 작업 폴더는 plan.appFolderCwd · projectFolderCwd 가 만든 두 꼴뿐이다 — 그 밖(하위 폴더 · `..` · 규칙 밖 이름)은 받지 않는다.
 */
export function hostJobDir(cwd: string): HostJobDir | null {
  const app = /^\/work\/apps\/([^/]+)$/.exec(String(cwd));
  if (app) return APP_ID_RE.test(app[1]!) ? { root: "apps", sub: app[1]! } : null;
  const proj = /^\/work\/shared\/project\/([1-9][0-9]{0,15})$/.exec(String(cwd));
  if (proj && Number.isSafeInteger(Number(proj[1]))) return { root: "shared", sub: `project/${proj[1]}` };
  return null;
}

/**
 * 판 머리 — `sh -c <이것> lvly-job <비밀 파일> <작업 id> <포트> <워크스페이스> <부트>`. 판 계정 안에서 돈다(격리면 sudo 를 지난 뒤).
 *  비밀 파일을 읽자마자 지우고(폴더도) env 를 세운 뒤 부트로 넘어간다. 비밀을 못 읽으면 3(부트 실패와 같은 코드)으로 끝난다 —
 *  그 작업은 시작 상한에 «시작하지 못했습니다» 로 끝난다(비밀이 없어 실패 보고도 못 한다).
 *  워크스페이스가 빈 값이면 싣지 않는다(단일 워크스페이스 · primary).
 */
export const PANE_PRELUDE = [
  'f="$1"; k=$(cat -- "$f" 2>/dev/null); rm -f -- "$f"; rmdir -- "${f%/*}" 2>/dev/null',
  '[ -n "$k" ] || { echo "lvly-job: 부트 비밀을 읽지 못했습니다" >&2; exit 3; }',
  'export LVLY_JOB_BOOT="$k" LVLY_JOB_ID="$2" LVLY_JOB_PORT="$3"',
  '[ -z "$4" ] || export LVLY_JOB_WS="$4"',
  'exec node -e "$5"',
].join("\n");

/**
 * (순수) 박스 위 판의 tmux argv. 부트 비밀은 싣지 않는다(비밀 파일 경로만 — 위 머리말).
 *  격리(osUser)면 판 명령을 wrap(sudo box-spawn · box-cgspawn)이 그 계정으로 내린다 — 작업 폴더로 들어가는 것도 그 계정이 한다(tmux -c 는
 *  게이트웨이 권한이라 멤버 700 자리에 못 들어간다 — sessions.createSession 과 같은 이유). 비격리면 tmux -c 와 그 사람의 Claude 설정 폴더.
 *  env 는 사람 세션 격리 분기가 sudo 너머로 보존하는 이름만 싣는다(로케일 · TZ · 세션 종류 · 워크스페이스 — session-env-contract).
 */
export function hostPaneArgv(o: {
  sessionId: string; jobId: number; secretFile: string; hostCwd: string; tz: string; slug: string | null; locale: string; port: number;
  osUser: string | null; profileDir: string | null; wrap: (argv: string[]) => string[];
}): string[] {
  const cmd = ["sh", "-c", PANE_PRELUDE, "lvly-job", o.secretFile, String(o.jobId), String(o.port), o.slug ?? "", BOOT_SOURCE];
  return [
    "new-session", "-d", "-s", o.sessionId, "-x", "200", "-y", "50",
    "-e", `LANG=${o.locale}`, "-e", `LC_CTYPE=${o.locale}`, "-e", `LC_ALL=${o.locale}`,
    "-e", `TZ=${o.tz}`,
    ...(o.slug ? ["-e", `LVLY_TENANT_SLUG=${o.slug}`] : []),
    //  기계 세션 표식 — 혹시 도는 훅이 있어도 사람 세션 일(프로젝트 자동 생성 · 이름짓기)을 하지 않게(launch.jobTmuxArgv 와 같은 자리).
    "-e", "LIVELY_SESSION_KIND=task",
    ...(o.osUser ? o.wrap(cmd) : ["-c", o.hostCwd, ...(o.profileDir ? ["-e", `CLAUDE_CONFIG_DIR=${o.profileDir}`] : []), ...cmd]),
  ];
}

/** 박스 위 판이 보는 게이트웨이 주소 — 판의 콜백과 같은 루프백 포트(topology.agentJobsPort). MCP · LLM 프록시가 이 아래다. */
export function hostGateway(port: number): string {
  return `http://${RUNNER_GATEWAY.host}:${port}`;
}

/** 작업 메모리 상한을 걸 수 있나 — 된다, 또는 못 건다(그 까닭 · 다시 해 볼 만한가). */
export type CgroupCheck = { ok: true } | { ok: false; transient: boolean; why: string };

/** 못 걸 때 사람이 할 일 — 접수 실패 · 관리자 보기에 같은 글로 싣는다. */
const CAP_FIX = "박스에서 sudo GATEWAY_USER=<게이트웨이 계정> bash deploy/linux/install-isolation.sh 를 다시 돌리거나, 상한 없이 돌리려면 관리자가 agent_job_limits_set 으로 memory_max_mb 를 0 으로 바꿉니다";

/** 박스 위 실행면이 쓰는 바깥 일 — 시험이 바꿔 끼운다(기본은 liveHostDeps). */
export interface HostLaunchDeps {
  accountUser(memberId: string): Promise<LivelyUser>;
  /** 사람 세션과 같은 OS 계정 판정 — 격리면 box_<사람>(없으면 만든다), 비격리면 null. */
  ensureOsUser(user: LivelyUser): Promise<string | null>;
  /** 이 박스가 구성원 격리를 지원하나(box-spawn 설치 · 리눅스 · 격리 켜짐) — 그런데 OS 계정이 null 이면 만들기 실패다. */
  isolationReady(): boolean;
  /** 박스 위 자리의 절대 경로(profiles.resolveRootPath — osUser 로 격리 기준을 고른다). */
  resolveDir(user: LivelyUser, dir: HostJobDir, osUser: string | null): Promise<string>;
  mkdir(osUser: string | null, abs: string): Promise<void>;
  /** 격리 판의 멤버 홈 준비(사람 세션의 격리 분기와 같은 자리 — 비격리 박스의 사람 세션도 이것을 부르지 않는다). */
  prepareHome(user: LivelyUser, osUser: string): Promise<void>;
  /** 비격리 판의 Claude 설정 폴더(사람 세션과 같은 멀티프로필 자리) — 단일 계정 스위치(LIVELY_MULTIPROFILE=0)면 null. */
  profileDir(user: LivelyUser): Promise<string | null>;
  /** 작업 하나의 메모리 상한(작업 정책 memory_max_mb) — 0 이면 undefined(상한 없음). */
  memoryLimit(): Promise<CgroupLimit | undefined>;
  /** box-cgspawn 을 지금 쓸 수 있나(래퍼 설치 · sudo 허용) — 격리 판에 상한이 있을 때만 묻는다. 못 쓰면 그 작업은 띄우지 않는다(머리말 ⑤). */
  cgroupCheck(): Promise<CgroupCheck>;
  /** 판 계정이 새로 만든 0700 임시 폴더의 0600 비밀 파일 — 경로를 돌려준다. */
  writeSecret(osUser: string | null, secret: string): Promise<string>;
  removeSecret(osUser: string | null, file: string): Promise<void>;
  /** 판 명령을 그 계정으로 내린다(terminal-isolation.wrapAsMember · session:true). */
  wrap(osUser: string, argv: string[], cwd: string, cg: CgroupLimit | undefined): string[];
  tmux(argv: string[]): Promise<unknown>;
  tz(): Promise<string>;
  slug(): string | null;
  port(): number;
  locale(): string;
}

/** 비격리 박스에서 게이트웨이 계정으로 띄운다는 경고 — 프로세스마다 한 번(작업마다 찍으면 묻힌다 · 관리자 보기에는 늘 보인다). */
let warnedGatewayAccount = false;

/**
 * 박스 위 판을 띄운다 — OS 계정 → 메모리 상한 → 작업 폴더 → 홈 준비 → 비밀 파일 → 판. 실패는 JobLaunchError(단계 실패는 일시 — launch.stepFailure).
 *  다시 해도 안 될 것(세션 id 없음 · 홈 없는 작업 · 실행 계정 없음 · 작업 폴더 꼴 밖 · 상한을 걸 수 없음)은 작업 폴더 · 비밀 파일 앞에서 끝낸다.
 */
export async function launchHostJob(
  job: AgentJobRow, bootSecret: string, deps?: HostLaunchDeps, o: { sharedSeat?: boolean } = {},
): Promise<{ container: string }> {
  const sid = job.session_id;
  if (!sid || !JOB_SESSION_ID_RE.test(sid)) throw new JobLaunchError("세션 id 가 없는 작업입니다");
  if (job.homeless === true) throw new JobLaunchError("이 박스의 작업 실행면은 사람 홈 없는 작업을 띄우지 않습니다(앱 서버가 보낸 API 키 에이전트 작업)");
  const seat = jobSeatMember(job);
  if (!seat) throw new JobLaunchError("실행 계정이 없는 작업입니다");
  const dir = hostJobDir(job.cwd);
  if (!dir) throw new JobLaunchError(`작업 폴더 꼴이 아닙니다: ${JSON.stringify(String(job.cwd).slice(0, 120))}`);
  const d = deps ?? (await liveHostDeps());
  const user = await d.accountUser(seat);
  let osUser: string | null;
  try { osUser = await d.ensureOsUser(user); } catch (e) { throw stepFailure("os-user", e); }
  if (!osUser && d.isolationReady()) throw stepFailure("os-user", `실행 계정 ${seat} 의 OS 계정을 만들지 못했습니다(게이트웨이 계정으로는 띄우지 않는다)`);
  //  메모리 상한(머리말 ⑤) — 격리 판만 건다. 걸 수 없으면 띄우지 않는다 · 비격리 박스는 걸 자리가 없어 그대로(관리자 보기에 보인다).
  const cap = await d.memoryLimit().catch((e) => { throw stepFailure("memory", e); });
  let cg: CgroupLimit | undefined;
  if (cap && osUser) {
    const c = await d.cgroupCheck().catch((e): CgroupCheck => ({ ok: false, transient: true, why: String((e as Error)?.message ?? e) }));
    if (!c.ok) {
      if (c.transient) throw stepFailure("memory", c.why);
      throw new JobLaunchError(`작업 메모리 상한(${cap.maxMb}MB)을 걸 수 없어 띄우지 않습니다 — ${c.why}. ${CAP_FIX}`);
    }
    cg = cap;
  }
  if (!osUser && !warnedGatewayAccount) {
    warnedGatewayAccount = true;
    logger.warn({ job: job.id, memoryMaxMb: cap?.maxMb ?? 0 }, "[agent-job] 구성원 격리가 꺼진 박스다 — 작업이 게이트웨이 계정으로 돌고(앱이 시킨 지시가 게이트웨이 권한으로) 메모리 상한을 걸 자리가 없다");
  }
  let hostCwd: string;
  try {
    hostCwd = await d.resolveDir(user, dir, osUser);
    await d.mkdir(osUser, hostCwd);
  } catch (e) { throw stepFailure("workdir", e); }
  if (osUser && !o.sharedSeat) { try { await d.prepareHome(user, osUser); } catch (e) { throw stepFailure("home", e); } }
  const profileDir = osUser ? null : await d.profileDir(user).catch((e) => { throw stepFailure("home", e); });
  let secretFile: string;
  try { secretFile = await d.writeSecret(osUser, bootSecret); } catch (e) { throw stepFailure("pane", redactSecret(String((e as Error)?.message ?? e), bootSecret)); }
  const argv = hostPaneArgv({
    sessionId: sid, jobId: job.id, secretFile, hostCwd, tz: await d.tz(), slug: d.slug(), locale: d.locale(), port: d.port(),
    osUser, profileDir, wrap: (a) => d.wrap(osUser!, a, hostCwd, cg),
  });
  try {
    await d.tmux(argv);
  } catch (e) {
    await d.removeSecret(osUser, secretFile).catch(() => undefined);
    throw stepFailure("pane", redactSecret((e as Error)?.message ?? String(e), bootSecret).slice(0, 400));
  }
  logger.info({ job: job.id, session: sid, osUser: osUser ?? "(게이트웨이 계정)", cwd: hostCwd, memoryMaxMb: cg?.maxMb ?? 0, sharedSeat: o.sharedSeat === true }, "[agent-job] 박스 위 판을 띄웠다");
  return { container: sid };
}

/**
 * 박스 위 판이 보는 자리 — 작업 폴더(박스 위 경로) · 게이트웨이 주소 · 실을 워크스페이스. 띄울 때와 같은 함수 · 같은 인자로 다시 구한다
 *  (실행 계정 → OS 계정 → resolveDir · 포트 · 워크스페이스 모두 deps — 둘이 갈리면 판이 만든 적 없는 폴더에서 돈다). OS 계정은 띄울 때 만들어
 *  두어 여기선 있는 것을 읽는다(ensureMemberOsUser 의 빠른 길). 격리 박스인데 계정이 없으면 띄우기와 같이 거절한다.
 */
export async function hostPaneView(job: Pick<AgentJobRow, "cwd" | "account_kind" | "account_member" | "requester">, deps?: HostLaunchDeps): Promise<PaneView> {
  const seat = jobSeatMember(job);
  const dir = hostJobDir(job.cwd);
  if (!seat || !dir) throw new Error("작업 폴더를 박스 위 자리로 옮길 수 없습니다");
  const d = deps ?? (await liveHostDeps());
  const user = await d.accountUser(seat);
  const osUser = await d.ensureOsUser(user);
  if (!osUser && d.isolationReady()) throw new Error(`실행 계정 ${seat} 의 OS 계정이 없습니다`);
  return { cwd: await d.resolveDir(user, dir, osUser), gateway: hostGateway(d.port()), workspace: d.slug() };
}

/**
 * 박스 위 판을 걷는다 — `job-` 꼴만(launch.killJobContainer 의 마지막 자리 그대로). 이미 없다는 확답 = 세션 없음 · tmux 서버 자체가 없음
 *  (머리말). 권한 · 시간 초과는 확답이 아니라 던진다(부르는 쪽이 다음 감시에 다시 걷는다). run 은 시험이 바꿔 끼우는 자리다.
 */
export async function killHostJob(sessionId: string, run?: (args: string[]) => Promise<unknown>): Promise<void> {
  const { killJobContainer } = await import("./launch.js");
  const { isSessionGoneError, tmux } = await import("../terminal/tmux-exec.js");
  const { TMUX_BIN } = await import("../terminal/catalog.js");
  await killJobContainer(sessionId, run ?? tmux, (e) => isSessionGoneError(e, TMUX_BIN, true));
}

/** 비밀 파일의 폴더가 우리가 만든 임시 폴더 꼴인가 — 지우기 전에 본다(엉뚱한 폴더를 rm -rf 하지 않게). */
const SECRET_DIR_RE = /\/lvly-job\.[A-Za-z0-9]{6,}$/;

/** (순수) 작업 정책의 메모리 상한(MB) → cgroup 상한. 0 = 상한 없음. MemoryMax 하나만 건다(MemoryHigh 로 판을 느리게 조이지 않는다). */
export function jobMemoryLimit(memoryMaxMb: number): CgroupLimit | undefined {
  return Number.isFinite(memoryMaxMb) && memoryMaxMb > 0 ? { highMb: 0, maxMb: Math.floor(memoryMaxMb), requestMb: 0, swapMaxMb: 0 } : undefined;
}

/** box-cgspawn 이 스왑 값(네 번째 값)을 받나 — 래퍼 파일의 표지 줄(`# lively-cgspawn-caps: … swap-max …`). 옛 판은 네 값을 받으면 판이 곧바로 죽는다. */
export const CGSPAWN_SWAP_CAP_RE = /^# lively-cgspawn-caps:.*\bswap-max\b/m;

async function jobPolicy(): Promise<{ memory_max_mb: number }> {
  const pol = await import("../org/policies/agent-job-policy.js");
  const store = await import("./store.js");
  return pol.effectiveAgentJobPolicy(async () => pol.resolveAgentJobPolicy(await store.agentJobPolicyRow()));
}

/** 래퍼 판정을 기억하는 동안 — 된다는 10분(판마다 sudo 를 두드리지 않게), 못 쓴다는 30초(관리자가 sudoers 를 고치면 곧 따라오게 — 그동안
 *  작업이 «다시 해도 안 된다» 로 끝나므로 오래 두지 않는다). 끊긴 답은 기억하지 않는다. */
const CGSPAWN_OK_MS = 10 * 60_000;
const CGSPAWN_NO_MS = 30_000;
let cgProbe: { at: number; result: CgroupCheck } | null = null;
/** 묻고 있는 중인 판정 — 같은 때 여러 배차 · 관리자 보기가 물어도 sudo 는 한 번만 띄운다(sudo 가 멎었을 때 프로세스가 쌓이지 않게). */
let cgInflight: Promise<CgroupCheck> | null = null;

/** `sudo -n -l <명령>` 의 끝 — 0 = 허용(NOPASSWD) · 1 = 허용 없음 · 비밀번호가 필요 · sudo 없음, null = 모른다(시간 초과 · 못 띄움). */
export type SudoListProbe = (cmd: string) => Promise<{ code: number | null; error?: string }>;

/** `sudo -n -l <명령>` 을 부르고 끝을 옮긴다. o 는 시험이 바꿔 끼운다(가짜 sudo · 짧은 시간). */
export const sudoListProbe = async (cmd: string, o: { bin?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; error?: string }> => {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(o.bin ?? "sudo", ["-n", "-l", cmd], { timeout: o.timeoutMs ?? 5000 }, (err) => {
      if (!err) return resolve({ code: 0 });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.killed) return resolve({ code: null, error: "sudo 가 시간 안에 답하지 않았습니다" });
      if (typeof e.code === "number") return resolve({ code: e.code });
      if (e.code === "ENOENT") return resolve({ code: 1 });
      resolve({ code: null, error: String(e.message ?? e) });
    });
  });
};

/**
 * box-cgspawn 을 지금 쓸 수 있나 — 래퍼가 있고(terminal-isolation.cgroupInfraReady — 격리 켜짐 · 리눅스 · 설치), 게이트웨이 계정이 그것을
 *  비밀번호 없이 sudo 로 부를 수 있다. 래퍼 파일만 보고 고르면 sudoers 줄이 빠진 박스에서 판이 «비밀번호가 필요하다» 로 곧바로 죽는다 — 그 작업은
 *  시작 상한(180초)에 이유 없이 끝난다. `sudo -n -l <래퍼>` 는 무엇도 실행하지 않는다. 끝이 0 · 1 이 아니면(시간 초과 등) 모른다 — 기억하지
 *  않고 일시 실패로 돌려 다음 띄우기에 다시 묻는다(격리 리뷰 — 한 번 끊긴 것을 오래 «못 쓴다» 로 두지 않게). o 는 시험이 바꿔 끼운다.
 */
export async function cgspawnCheck(o: { infraReady?: () => boolean; wrapper?: string; probe?: SudoListProbe; now?: () => number; readWrapper?: (p: string) => Promise<string> } = {}): Promise<CgroupCheck> {
  const iso = await import("../terminal/terminal-isolation.js");
  const wrapper = o.wrapper ?? iso.BOX_CGSPAWN;
  if (!(o.infraReady ?? iso.cgroupInfraReady)()) return { ok: false, transient: false, why: `cgroup 래퍼(${wrapper})가 이 박스에 없습니다` };
  //  스왑 값을 아는 판인가 — 래퍼는 root 소유 0755 라 게이트웨이가 읽는다. 못 읽으면 모르는 것이라 일시로 둔다(기억하지 않는다).
  //   옛 판도 일시다 — 배포(deploy-release.sh)는 새 판으로 넘긴 «뒤에» 격리 인프라(이 래퍼)를 다시 놓아, 그 사이 잠깐 새 코어 + 옛 래퍼가 된다.
  //   그때 들어온 작업은 실패시키지 않고 다시 기다리게 한다. 다시 놓기가 실패해 그대로면 시도를 다 쓰고 고칠 길과 함께 실패한다(service).
  let text: string;
  try { text = await (o.readWrapper ?? (async (p: string) => (await import("node:fs/promises")).readFile(p, "utf8")))(wrapper); }
  catch (e) { return { ok: false, transient: true, why: `cgroup 래퍼(${wrapper})를 읽지 못했습니다: ${String((e as Error)?.message ?? e)}` }; }
  if (!CGSPAWN_SWAP_CAP_RE.test(text)) {
    return { ok: false, transient: true, why: `cgroup 래퍼(${wrapper})가 스왑 상한을 모르는 옛 판입니다(배포가 래퍼를 새로 놓는 중이면 곧 풀립니다 — 그대로면 ${CAP_FIX})` };
  }
  const now = (o.now ?? Date.now)();
  if (cgProbe && now - cgProbe.at < (cgProbe.result.ok ? CGSPAWN_OK_MS : CGSPAWN_NO_MS)) return cgProbe.result;
  if (cgInflight) return cgInflight;
  cgInflight = (async (): Promise<CgroupCheck> => {
    const r = await (o.probe ?? sudoListProbe)(wrapper);
    if (r.code !== 0 && r.code !== 1) return { ok: false, transient: true, why: r.error ?? `sudo 가 알 수 없는 끝(${r.code})을 냈습니다` };
    const result: CgroupCheck = r.code === 0 ? { ok: true }
      : { ok: false, transient: false, why: `게이트웨이 계정이 cgroup 래퍼(${wrapper})를 비밀번호 없이 sudo 로 쓸 수 없습니다` };
    cgProbe = { at: now, result };
    return result;
  })().catch((e): CgroupCheck => ({ ok: false, transient: true, why: String((e as Error)?.message ?? e) }))
    .finally(() => { cgInflight = null; });
  return cgInflight;
}

/** 시험 전용 — 기억한 래퍼 판정 · 게이트웨이 계정 경고를 잊는다. */
export function resetHostProbesForTest(): void { cgProbe = null; cgInflight = null; warnedGatewayAccount = false; }

/** 박스 위 판이 어느 계정으로 도나 — 격리 박스면 구성원 OS 계정(못 만들면 띄우지 않는다), 아니면 게이트웨이 계정(사람 세션과 같은 판정). */
export async function hostRunsAs(): Promise<"member" | "gateway"> {
  const iso = await import("../terminal/terminal-isolation.js");
  return iso.isolationInfraReady() ? "member" : "gateway";
}

/** 관리자에게 보일 박스 위 메모리 상한 상태 — 걸리나와 그 이유(agent_job_limits surface.memory_cap). 띄우기와 같은 판정(머리말 ⑤). o 는 시험이 바꿔 끼운다. */
export async function hostMemoryCapStatus(memoryMaxMb: number, o: { runsAs?: () => Promise<"member" | "gateway">; check?: () => Promise<CgroupCheck> } = {}): Promise<{ enforced: boolean; note: string }> {
  if (!jobMemoryLimit(memoryMaxMb)) return { enforced: false, note: "memory_max_mb 가 0 이라 작업 메모리 상한 없이 돕니다" };
  if ((await (o.runsAs ?? hostRunsAs)()) === "gateway") {
    return { enforced: false, note: "이 박스는 구성원 격리(OS 계정)가 꺼져 있어 작업이 게이트웨이 계정으로 돌고 상한을 걸 자리가 없습니다(사람 세션도 같다)" };
  }
  const c = await (o.check ?? cgspawnCheck)();
  if (c.ok) return { enforced: true, note: "구성원 OS 계정 판마다 cgroup MemoryMax 로 겁니다(넘으면 그 판 안에서 하네스가 먼저 끊깁니다)" };
  return { enforced: false, note: c.transient
    ? `지금은 상한을 걸지 못합니다 — ${c.why}. 그동안 작업은 일시 실패로 다시 시도합니다`
    : `${c.why} — 이대로는 작업을 띄우지 않습니다. ${CAP_FIX}` };
}

/** 박스 위 실행면의 살아 있는 의존 — 사람 세션(createSession)과 같은 자리들. */
export async function liveHostDeps(): Promise<HostLaunchDeps> {
  const launch = await import("./launch.js");
  const profiles = await import("../terminal/profiles.js");
  const iso = await import("../terminal/terminal-isolation.js");
  const mfs = await import("../terminal/terminal-member-fs.js");
  const { tenantSlug, PANE_LOCALE } = await import("../terminal/catalog.js");
  const { tmux } = await import("../terminal/tmux-exec.js");
  const { execTopology } = await import("../exec-topology.js");
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  return {
    accountUser: (m) => launch.accountUser(m),
    ensureOsUser: (u) => profiles.ensureMemberOsUser(u),
    isolationReady: () => iso.isolationInfraReady(),
    resolveDir: async (u, dir, osUser) => (await profiles.resolveRootPath(u, dir.root, dir.sub, osUser)).abs,
    mkdir: async (osUser, abs) => { if (osUser) await mfs.memberMkdir(osUser, abs); else await fsp.mkdir(abs, { recursive: true }); },
    prepareHome: async (u, osUser) => { const { prepareMemberHome } = await import("../terminal/sessions.js"); await prepareMemberHome(u, osUser); },
    profileDir: async (u) => {
      //  사람 세션의 비격리 길과 같은 자리(sessions.createSession — 멀티프로필 #346 · #1014). 단일 계정 스위치면 박스 계정의 ~/.claude 그대로.
      if (process.env.LIVELY_MULTIPROFILE === "0") return null;
      const dir = profiles.profileConfigDir(u);
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    memoryLimit: async () => jobMemoryLimit((await jobPolicy()).memory_max_mb),
    cgroupCheck: () => cgspawnCheck(),
    writeSecret: async (osUser, secret) => {
      if (osUser) return mfs.memberWriteTempSecret(osUser, secret);
      //  비격리 — 판이 곧 게이트웨이 계정이다. 같은 꼴(새 0700 폴더 · 0600 파일 · 덮어쓰지 않음)로 둔다.
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lvly-job."));
      const file = path.join(dir, "boot");
      await fsp.writeFile(file, secret, { mode: 0o600, flag: "wx" });
      return file;
    },
    removeSecret: async (osUser, file) => {
      const dir = path.dirname(file);
      if (path.basename(file) !== "boot" || !SECRET_DIR_RE.test(dir)) return;
      if (osUser) { await mfs.memberRm(osUser, dir); return; }
      await fsp.rm(dir, { recursive: true, force: true });
    },
    wrap: (osUser, argv, cwd, cg) => iso.wrapAsMember(osUser, argv, cwd, cg, { session: true }),
    tmux: (argv) => tmux(argv),
    tz: async () => (await import("../org/timezone.js")).orgTimezone(),
    slug: () => tenantSlug(),
    port: () => execTopology().agentJobsPort,
    locale: () => PANE_LOCALE,
  };
}
