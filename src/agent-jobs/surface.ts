// 에이전트 작업 실행면 — 작업 판을 «어디에» 세우고 걷나 (#5082)
//
//  작업의 흐름(접수 → 자리 주기 → 띄우기 → 첫 말 → 박동 → 결과 → 걷기 — service.ts)과 판 본체(runner.ts)는 하나다. 배포마다 다른 것은
//   판을 세우고 걷는 자리뿐이라, 그 자리를 실행면 하나로 묶는다:
//   · broker — 매니지드. 세션 컨테이너 확보 훅(브로커)이 job- 컨테이너를 확보하고 그 안 tmux 에 판을 띄운다(launch.ts #4490 — 종전 그대로).
//   · host   — 브로커가 없는 박스(셀프호스트). 이 박스의 tmux 에 판을 띄운다 — 사람 세션과 같은 OS 계정 · 홈 규칙(launch-host.ts).
//   · none   — 띄우지 않는다(접수 501). 셀프호스트는 관리자가 게이트웨이 env 에 LIVELY_AGENT_JOBS=host 를 넣고 다시 띄워 켠다.
//  실행면이 바꾸는 것은 넷이다: 띄울 수 있나(available) · 띄우기(launch = OS 계정 · 작업 폴더 · 홈 · 판) · 걷기(kill) · 판이 보는 자리(paneView —
//   작업 폴더 · MCP 주소). 매니지드 판정은 그대로다 — 확보 훅이 있는 배포는 스위치와 무관하게 늘 broker 다(박스 위로 새지 않는다).
import type { ExecTopology } from "../exec-topology.js";
import type { AgentJobRow } from "./store.js";

export type JobSurfaceKind = "broker" | "host" | "none";

/**
 * (순수) 이 배포의 실행면. 확보 훅(매니지드)이 먼저다 — 그 배포는 LIVELY_AGENT_JOBS 를 보지 않는다.
 *  훅이 없으면 tmux 가 이 호스트에 있을 때(sessionHost local)만 스위치를 본다 — 노드 에이전트 프로세스 · tmux 중계 배포는 판을 세울 자리가 아니다.
 */
export function jobSurfaceKind(t: Pick<ExecTopology, "hooks" | "sessionHost" | "agentJobs">): JobSurfaceKind {
  if (t.hooks.sessionEnsure) return "broker";
  if (t.sessionHost !== "local") return "none";
  return t.agentJobs === "host" ? "host" : "none";
}

/** 판이 보는 자리 — 작업 폴더(판의 자리 기준 경로)와 라이블리 MCP 주소. */
export interface PaneView { cwd: string; mcpUrl: string }

export interface JobSurface {
  readonly kind: JobSurfaceKind;
  /** 이 배포에서 지금 띄울 수 있나 — 아니면 접수가 501 이고 대기 작업은 배차되지 않는다. */
  available(): Promise<boolean>;
  /** 띄운다. 일시 실패(확보 단계)는 transient 인 JobLaunchError 로 던진다(launch.stepFailure). */
  launch(job: AgentJobRow, bootSecret: string): Promise<{ container: string }>;
  /** 걷는다 — 이미 없다는 확답이면 조용히, 그 밖은 던진다(부르는 쪽이 다음 감시에 다시 걷는다). */
  kill(sessionId: string): Promise<void>;
  /** 판의 첫 말(boot)에 줄 자리 — 띄울 때와 같은 자로 다시 구한다. */
  paneView(job: AgentJobRow): Promise<PaneView>;
}

/** 매니지드 판의 MCP 주소 — 컨테이너 안 세션 루프백(runner.RUNNER_GATEWAY). 종전 service.onBoot 가 박아 두던 값 그대로다. */
export const BROKER_MCP_URL = "http://127.0.0.1:8080/mcp";

/** (순수) 못 띄우는 배포에서 접수가 돌려줄 문장(501) — 사람(관리자)이 무엇을 켜면 되는지 말한다. */
export function jobsUnavailableMessage(kind: JobSurfaceKind): string {
  return kind === "none"
    ? "이 배포에서는 에이전트 작업을 띄울 수 없습니다 — 자체 호스팅 박스는 관리자가 게이트웨이 설정(.env)에 LIVELY_AGENT_JOBS=host 를 넣고 게이트웨이를 다시 띄우면 켜집니다"
    : "지금은 에이전트 작업을 띄울 수 없습니다 — 이 워크스페이스의 작업 컨테이너 자리를 확인하지 못했습니다";
}

let cached: JobSurface | null = null;

/** 이 프로세스의 실행면(토폴로지가 부팅에 얼므로 한 번 고르면 그대로다). */
export async function jobSurface(): Promise<JobSurface> {
  if (cached) return cached;
  const { execTopology } = await import("../exec-topology.js");
  const kind = jobSurfaceKind(execTopology());
  const launch = await import("./launch.js");
  if (kind === "broker") {
    cached = {
      kind,
      available: () => launch.jobContainersAvailable(),
      launch: (job, boot) => launch.launchJobContainer(job, boot),
      kill: (sid) => launch.killJobContainer(sid),
      paneView: async (job) => ({ cwd: job.cwd, mcpUrl: BROKER_MCP_URL }),
    };
    return cached;
  }
  const host = await import("./launch-host.js");
  const port = execTopology().agentJobsPort;
  cached = {
    kind,
    available: async () => kind === "host",
    launch: (job, boot) => kind === "host" ? host.launchHostJob(job, boot)
      : Promise.reject(new launch.JobLaunchError(jobsUnavailableMessage(kind))),
    //  꺼진 박스도 걷기는 박스 위 tmux 로 한다 — 스위치를 끈 뒤에 남은 판이 있을 수 있다(없으면 «이미 없다» 확답이라 조용하다).
    kill: (sid) => host.killHostJob(sid),
    paneView: (job) => host.hostPaneView(job, port),
  };
  return cached;
}

/** 시험 전용 — 고른 실행면을 잊는다. */
export function resetJobSurfaceForTest(): void { cached = null; }

/**
 * 관리자에게 보일 실행면 상태(agent_job_limits) — 어느 실행면인가 · 지금 띄울 수 있나 · 작업 메모리 상한이 실제로 걸리나.
 *  상한은 박스 위 실행에서만 이 정책 칸(memory_max_mb)으로 건다 — 격리 박스(구성원 OS 계정)에서 cgroup 래퍼(box-cgspawn)를 sudo 로 쓸 수 있을 때.
 */
export async function describeJobSurface(memoryMaxMb: number): Promise<{ kind: JobSurfaceKind; available: boolean; memory_cap: { mb: number; enforced: boolean; note: string } }> {
  const s = await jobSurface();
  const available = await s.available().catch(() => false);
  if (s.kind === "broker") return { kind: s.kind, available, memory_cap: { mb: memoryMaxMb, enforced: false, note: "매니지드 작업 컨테이너는 세션 메모리 정책으로 잡힌다(이 칸은 쓰지 않는다)" } };
  if (s.kind === "none") return { kind: s.kind, available, memory_cap: { mb: memoryMaxMb, enforced: false, note: jobsUnavailableMessage("none") } };
  const { hostMemoryCapStatus } = await import("./launch-host.js");
  return { kind: s.kind, available, memory_cap: { mb: memoryMaxMb, ...(await hostMemoryCapStatus(memoryMaxMb)) } };
}
