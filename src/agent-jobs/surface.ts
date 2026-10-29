// 에이전트 작업 실행면 — 작업 판을 «어디에» 세우고 걷나 (#5082)
//
//  작업의 흐름(접수 → 자리 주기 → 띄우기 → 첫 말 → 박동 → 결과 → 걷기 — service.ts)과 판 본체(runner.ts)는 하나다. 배포마다 다른 것은
//   판을 세우고 걷는 자리뿐이라, 그 자리를 실행면 하나로 묶는다:
//   · broker — 매니지드. 세션 컨테이너 확보 훅(브로커)이 job- 컨테이너를 확보하고 그 안 tmux 에 판을 띄운다(launch.ts #4490 — 종전 그대로).
//   · host   — 브로커가 없는 박스(셀프호스트). 이 박스의 tmux 에 판을 띄운다 — 사람 세션과 같은 OS 계정 · 홈 규칙(launch-host.ts).
//   · docker — 브로커가 없는 박스(셀프호스트 2단계). 작업마다 이 박스의 Docker 컨테이너를 띄운다 — 작업 폴더와 하네스가 쓰는 것만 붙인다(launch-docker.ts).
//   · none   — 띄우지 않는다(접수 501). 셀프호스트는 관리자가 게이트웨이 env 에 LIVELY_AGENT_JOBS=docker(또는 host)를 넣고 다시 띄워 켠다.
//  실행면이 바꾸는 것은 다섯이다: 띄울 수 있나(available) · 못 띄울 때의 까닭(unavailableMessage — 접수 501) · 띄우기(launch = OS 계정 ·
//   메모리 상한 · 작업 폴더 · 홈 · 판) · 걷기(kill) · 판이 보는 자리(paneView — 작업 폴더 · 게이트웨이 주소 · 실을 워크스페이스).
//   매니지드 판정은 그대로다 — 확보 훅이 있는 배포는 스위치와 무관하게 늘 broker 다(박스 위로 새지 않는다).
import type { ExecTopology } from "../exec-topology.js";
import { RUNNER_GATEWAY_URL } from "./runner.js";
import type { AgentJobRow } from "./store.js";

export type JobSurfaceKind = "broker" | "host" | "docker" | "none";

type SurfaceTopology = Pick<ExecTopology, "hooks" | "sessionHost" | "agentJobs">;

/**
 * (순수) 박스 위에 판을 세울 수 없는 까닭 — 없으면 null. 스위치보다 먼저 본다(켜도 이 배포에선 판이 게이트웨이에 닿지 않는다).
 *  · tmux 가 이 호스트에 없다(sessionHost 가 노드 에이전트 · tmux 중계) — 판을 세울 자리가 아니다.
 *  · 세션을 무엇에 담아 띄울지 갈아끼우는 훅(LIVELY_SESSION_SPAWN)이 있다 — 사람 세션처럼 판도 그 훅으로 내려가는데(wrapAsMember session),
 *    그 안에서 판이 이 박스 루프백(LIVELY_AGENT_JOBS_PORT)에 닿는지 모른다(격리 리뷰 — 닿지 못하면 시작 상한까지 말없이 기다린다).
 */
export function hostSurfaceBlocker(t: SurfaceTopology): string | null {
  if (t.sessionHost !== "local") return "이 게이트웨이는 세션을 다른 자리(노드 · 중계)에 띄워 박스 위에 판을 세울 자리가 없습니다";
  if (t.hooks.sessionSpawn) return "이 박스는 세션을 띄우는 훅(LIVELY_SESSION_SPAWN)을 써서 박스 위 작업을 띄우지 않습니다 — 그 훅 안의 판이 게이트웨이 루프백에 닿는지 확인되지 않았습니다";
  return null;
}

/**
 * (순수) 이 박스에 작업 컨테이너(도커)를 띄울 수 없는 까닭 — 없으면 null. 이 프로세스가 노드 에이전트이거나 세션이 중계 너머(매니지드 꼴)면
 *  여기는 셀프호스트 게이트웨이 박스가 아니다. 세션 spawn 훅은 보지 않는다 — 도커 판은 사람 세션 길(tmux · 그 훅)을 지나지 않는다.
 */
export function dockerSurfaceBlocker(t: SurfaceTopology): string | null {
  if (t.sessionHost !== "local") return "이 프로세스는 셀프호스트 게이트웨이 박스가 아닙니다(노드 에이전트 · 중계 배포) — 이 박스에 작업 컨테이너를 띄우지 않습니다";
  return null;
}

/**
 * (순수) 이 배포의 실행면. 확보 훅(매니지드)이 먼저다 — 그 배포는 LIVELY_AGENT_JOBS 를 보지 않는다.
 *  훅이 없으면 스위치를 보되, 그 실행면을 세울 수 없는 배포면(dockerSurfaceBlocker · hostSurfaceBlocker) none 이다.
 */
export function jobSurfaceKind(t: SurfaceTopology): JobSurfaceKind {
  if (t.hooks.sessionEnsure) return "broker";
  if (t.agentJobs === "docker") return dockerSurfaceBlocker(t) ? "none" : "docker";
  if (hostSurfaceBlocker(t)) return "none";
  return t.agentJobs === "host" ? "host" : "none";
}

/**
 * 판이 보는 자리 — 작업 폴더(판의 자리 기준 경로) · 게이트웨이 주소(판의 자리에서 — MCP · LLM 프록시가 이 아래) · 판이 하네스 요청에 실어야 할
 *  워크스페이스(게이트웨이에 바로 닿는 박스 위 판만 — 매니지드는 세션 루프백이 테넌트를 싣는다).
 */
export interface PaneView { cwd: string; gateway: string; workspace: string | null }

/**
 * 띄울 때 실행면에 넘기는 것(#5081). 필수다 — 빠뜨린 자리가 공용 시트 작업의 시트 홈에 키트 · git 자격을 심지 않게.
 *  sharedSeat = 공용 시트로 도는 작업(그 홈은 구성원 누구의 지시든 닿는 자리라 사람 세션용 준비를 하지 않는다 — launch.ts · launch-host.ts).
 */
export interface JobLaunchOpts { sharedSeat: boolean }

export interface JobSurface {
  readonly kind: JobSurfaceKind;
  /** 이 배포에서 지금 띄울 수 있나 — 아니면 접수가 501 이고 대기 작업은 배차되지 않는다. */
  available(): Promise<boolean>;
  /** 못 띄울 때 접수가 돌려줄 문장(501). */
  unavailableMessage(): string;
  /** 띄운다. 일시 실패(확보 단계)는 transient 인 JobLaunchError 로 던진다(launch.stepFailure). */
  launch(job: AgentJobRow, bootSecret: string, o: JobLaunchOpts): Promise<{ container: string }>;
  /** 걷는다 — 이미 없다는 확답이면 조용히, 그 밖은 던진다(부르는 쪽이 다음 감시에 다시 걷는다). */
  kill(sessionId: string): Promise<void>;
  /** 판의 첫 말(boot)에 줄 자리 — 띄울 때와 같은 자로 다시 구한다. */
  paneView(job: AgentJobRow): Promise<PaneView>;
}

/** 매니지드 판의 게이트웨이 주소 — 컨테이너 안 세션 루프백(runner.RUNNER_GATEWAY). MCP(/mcp)는 종전 service.onBoot 가 박아 두던 값 그대로다. */
export const BROKER_GATEWAY = RUNNER_GATEWAY_URL;

/** (순수) 못 띄우는 배포에서 접수가 돌려줄 문장(501) — 사람(관리자)이 무엇을 켜면 되는지, 켤 수 없으면 왜인지 말한다. */
export function jobsUnavailableMessage(kind: JobSurfaceKind, t?: SurfaceTopology): string {
  if (kind !== "none") return "지금은 에이전트 작업을 띄울 수 없습니다 — 이 워크스페이스의 작업 컨테이너 자리를 확인하지 못했습니다";
  const blocker = t ? (t.agentJobs === "docker" ? dockerSurfaceBlocker(t) : hostSurfaceBlocker(t)) : null;
  return blocker
    ? `이 배포에서는 에이전트 작업을 띄울 수 없습니다 — ${blocker}`
    : "이 배포에서는 에이전트 작업을 띄울 수 없습니다 — 자체 호스팅 박스는 관리자가 게이트웨이 설정(.env)에 LIVELY_AGENT_JOBS=docker(작업마다 컨테이너 — Docker 필요) 또는 LIVELY_AGENT_JOBS=host(박스 위) 를 넣고 게이트웨이를 다시 띄우면 켜집니다";
}

let cached: JobSurface | null = null;

/** 이 프로세스의 실행면(토폴로지가 부팅에 얼므로 한 번 고르면 그대로다). */
export async function jobSurface(): Promise<JobSurface> {
  if (cached) return cached;
  const { execTopology } = await import("../exec-topology.js");
  const topo = execTopology();
  const kind = jobSurfaceKind(topo);
  const unavailable = jobsUnavailableMessage(kind, topo);
  const launch = await import("./launch.js");
  if (kind === "broker") {
    cached = {
      kind,
      available: () => launch.jobContainersAvailable(),
      unavailableMessage: () => unavailable,
      launch: (job, boot, o) => launch.launchJobContainer(job, boot, o),
      kill: (sid) => launch.killJobContainer(sid),
      paneView: async (job) => ({ cwd: job.cwd, gateway: BROKER_GATEWAY, workspace: null }),
    };
    return cached;
  }
  if (kind === "docker") {
    const docker = await import("./launch-docker.js");
    cached = {
      kind,
      //  도커에 닿고 하네스 실행 파일이 있어야 띄운다(기억한 판정 — 못 띄우면 접수 501 · 대기 작업은 배차되지 않는다).
      available: async () => (await docker.dockerBoxCheck()).ok,
      unavailableMessage: () => docker.dockerUnavailableMessage(),
      launch: (job, boot, o) => docker.launchDockerJob(job, boot, undefined, o),
      kill: (sid) => docker.killDockerJob(sid),
      paneView: async (job) => docker.dockerPaneView(job, { port: topo.agentJobsPort, slug: (await import("../terminal/catalog.js")).tenantSlug() }),
    };
    return cached;
  }
  const host = await import("./launch-host.js");
  cached = {
    kind,
    available: async () => kind === "host",
    unavailableMessage: () => unavailable,
    launch: (job, boot, o) => kind === "host" ? host.launchHostJob(job, boot, undefined, o)
      : Promise.reject(new launch.JobLaunchError(unavailable)),
    //  꺼진 박스도 걷기는 박스 위 tmux 로 한다 — 스위치를 끈 뒤에 남은 판이 있을 수 있다(없으면 «이미 없다» 확답이라 조용하다).
    kill: (sid) => host.killHostJob(sid),
    paneView: (job) => host.hostPaneView(job),
  };
  return cached;
}

/** 시험 전용 — 고른 실행면을 잊는다. */
export function resetJobSurfaceForTest(): void { cached = null; }

/** 관리자에게 보일 실행면 상태(agent_job_limits.surface). */
export interface JobSurfaceView {
  kind: JobSurfaceKind;
  available: boolean;
  /** 못 띄울 때 그 까닭(접수 501 문장과 같다) — 띄울 수 있으면 null. */
  unavailable: string | null;
  /** 박스 위 판 · 작업 컨테이너가 어느 계정으로 도나 — 구성원 OS 계정(격리 박스) · 게이트웨이 계정(격리 꺼짐 · 맥). 셀프호스트 실행면이 아니거나 모르면 null. */
  runs_as: "member" | "gateway" | null;
  memory_cap: { mb: number; enforced: boolean; note: string };
}

/**
 * 관리자에게 보일 실행면 상태(agent_job_limits) — 어느 실행면인가 · 지금 띄울 수 있나(아니면 왜) · 어느 계정으로 도나 · 작업 메모리 상한이 실제로 걸리나.
 *  상한은 셀프호스트 실행면에서만 이 정책 칸(memory_max_mb)으로 건다 — 박스 위는 격리 박스(구성원 OS 계정)에서 cgroup 래퍼(box-cgspawn)를 sudo 로
 *  쓸 수 있을 때, 도커는 컨테이너 메모리(스왑 없이 — 도커가 스왑 상한을 걸 수 있을 때).
 */
export async function describeJobSurface(memoryMaxMb: number): Promise<JobSurfaceView> {
  const s = await jobSurface();
  const available = await s.available().catch(() => false);
  const unavailable = available ? null : s.unavailableMessage();
  if (s.kind === "broker") return { kind: s.kind, available, unavailable, runs_as: null, memory_cap: { mb: memoryMaxMb, enforced: false, note: "매니지드 작업 컨테이너는 세션 메모리 정책으로 잡힌다(이 칸은 쓰지 않는다)" } };
  if (s.kind === "none") return { kind: s.kind, available, unavailable, runs_as: null, memory_cap: { mb: memoryMaxMb, enforced: false, note: s.unavailableMessage() } };
  if (s.kind === "docker") {
    const st = await (await import("./launch-docker.js")).dockerSurfaceStatus(memoryMaxMb);
    return { kind: s.kind, available, unavailable, runs_as: st.runsAs, memory_cap: { mb: memoryMaxMb, enforced: st.enforced, note: st.note } };
  }
  const { hostMemoryCapStatus, hostRunsAs } = await import("./launch-host.js");
  return { kind: s.kind, available, unavailable, runs_as: await hostRunsAs(), memory_cap: { mb: memoryMaxMb, ...(await hostMemoryCapStatus(memoryMaxMb)) } };
}
