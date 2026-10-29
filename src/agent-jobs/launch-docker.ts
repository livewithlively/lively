// 도커 실행면 — 브로커가 없는 박스(셀프호스트)에서 작업 판을 그 작업만의 Docker 컨테이너로 띄우고 걷는다 (#5082 2단계)
//
//  박스 위 실행면(launch-host.ts — 1단계)과 흐름(접수 → 자리 → 띄우기 → 첫 말 → 박동 → 결과 → 걷기 — service.ts) · 판(runner.ts)은 같고,
//   판이 서는 자리만 다르다. 1단계의 한계(launch-host 머리말 끝)를 닫는 것이 목적이다:
//   · 컨테이너에는 그 작업의 작업 폴더와 하네스가 쓰는 것만 붙인다 — 구독 작업은 그 계정의 Claude 설정 폴더(로그인), 그 밖은 아무것도(빈 tmpfs 홈).
//     그 계정이 박스에서 읽을 수 있는 다른 자리(다른 앱 폴더 · 프로젝트 폴더 · 홈의 키트 토큰 · git 자격 · 게이트웨이 .env)는 컨테이너에 없다.
//   · 작업마다 프로세스 · 마운트 이름 공간이 따로다 — 같은 계정의 다른 작업 · 사람 세션의 프로세스 env · 임시 파일을 컨테이너 안에서 못 본다.
//   · 홈 없는 작업(#4891 — 앱 서버가 보낸 API 키 에이전트 작업)도 띄운다. 격리 박스에선 박스에 없는 전용 uid(LIVELY_AGENT_JOB_UID · 기본 65532)
//     + lively-shared 그룹으로 돈다 — 박스 위 어떤 프로세스도 같은 uid 로 그 컨테이너 안(/proc)을 들여다보지 못한다.
//  누구로 도나(jobPlacement):
//   · 격리 박스(구성원마다 OS 계정) — 홈 없는 작업은 위 전용 uid, 그 밖은 실행 계정(구독) · 보낸 사람(API 키)의 OS 계정 uid:gid + lively-shared
//     (--user uid:gid 는 박스 계정의 보조 그룹을 가져오지 않는다 — 공유 · 앱 폴더(setgid 2775)에 쓰려면 그룹을 더해야 한다).
//     구독 작업은 그 계정 홈의 ~/.claude 하나만 쓰기로 붙인다(HOME 은 빈 tmpfs — ~/.claude.json 은 작업마다 새로 생긴다).
//   · 비격리 박스(격리 꺼짐 · 맥) — 게이트웨이 계정 uid:gid. 구독 작업은 그 사람의 Claude 설정 폴더(멀티프로필 · 단일 계정이면 게이트웨이 ~/.claude)를
//     같은 경로에 붙이고 CLAUDE_CONFIG_DIR 로 알린다(1단계 · 사람 세션과 같은 자리). 그래도 게이트웨이의 .env · DB 자격은 컨테이너에 없다.
//  ★ ~/.claude 가 링크면 붙이지 않는다 — 도커(root)는 원본 경로의 링크를 따라가서, 링크 하나로 남의 0700 홈 아래 폴더를 그 계정 uid 로 열 수 있다
//   (부모 폴더의 막이를 건너뛴다). 그래서 띄우기 전에 그 계정 권한으로 «링크 아님 · 그 계정 소유 폴더» 를 보고(memberFacts), 컨테이너 안에서도
//   판 머리(JOB_CONTAINER_PRELUDE)가 붙은 자리가 그 uid 소유 폴더인지 한 번 더 본다(사이에 바꿔치기해도 남의 폴더면 판이 서지 않는다).
//  막이(jobContainerArgs — 꼴 하나 · 띄우기 직전 검사기 ops/docker-run-guard 가 jobContainerPolicy 로 한 번 더 거른다 — docker 그룹은 사실상 root):
//   · 루트 읽기 전용 · /tmp 와 HOME 만 tmpfs · 메모리 = 메모리+스왑(스왑 없음 — 1단계 실측의 «스왑으로 빠진다») · pids 상한 · cap 전부 빼기 ·
//     no-new-privileges · --init(신호 · 좀비 정리) · 다시 띄우지 않음 · 박스 메모리가 모자라면 작업이 먼저 끊기게(--oom-score-adj 1000).
//   · 네트워크는 host — 판이 이 박스 게이트웨이의 루프백(LIVELY_AGENT_JOBS_PORT)에 닿아야 한다(MCP · LLM 프록시가 그 아래). 앱 서버 컨테이너에
//     바로 닿는 길은 1단계와 같다(#5108 이 네트워크로 막는다).
//   · 부트 비밀은 env 파일로 넘기고(0600 · docker run 이 읽은 직후 지운다) 명령줄에 싣지 않는다. 컨테이너 설정(docker inspect)에는 남는다 —
//     그것을 볼 수 있는 docker 그룹은 이미 root 와 같고, 비밀은 부트 한 번에 쓰고 버린다(runner 머리말).
//  하네스 실행 파일은 게이트웨이 계정의 리눅스 claude(네이티브 설치 — 한 파일 실행 파일)를 읽기 전용으로 붙인다(LIVELY_AGENT_JOB_CLAUDE_BIN 이 먼저).
//   이미지는 node 가 든 이미지(판 부트 · 본체가 node 로 돈다 — LIVELY_AGENT_JOB_IMAGE · 기본 앱 서버 이미지 node:22-bookworm-slim).
//  컨테이너는 판이 빠지면 끝나고 스스로 지워진다(--rm). 걷기는 `docker rm -f` 한 번이다 — 이미 없다는 확답(No such container)만 삼킨다.
//  ⚠ 남는 한계 — 구독 작업은 그 계정의 ~/.claude 를 쓰기로 붙인다(로그인 갱신이 거기 쓴다). 작업 AI 가 거기 쓴 설정 · 지시(settings.json 훅 ·
//   CLAUDE.md)는 그 사람의 다음 사람 세션이 읽는다 — «구독 실행은 본인 세션과 같은 신뢰»(v2-11 결정 ③) 그대로다. 공용 시트 홈은 #5123.
//   앱 폴더를 다른 길이 2755 로 먼저 만들었으면 다른 계정의 작업(홈 없는 작업 포함)은 읽기만 된다(1단계와 같다).
//   프로젝트 폴더에서 도는 앱 작업은 그 앱 폴더가 작업 폴더 안(.lively/apps/<앱>)에 붙지 않는다(1단계와 같다 — 프로젝트 폴더만 붙인다).
import path from "node:path";
import type { LivelyUser } from "../context.js";
import { logger } from "../log.js";
import { DockerRunRejected, type DockerRunPolicy } from "../ops/docker-run-guard.js";
import { HOMELESS_OS_USER, JOB_SESSION_ID_RE, homelessJobRefusal, jobSeatMember } from "./plan.js";
import { BOOT_SOURCE, JOB_BOOT_ENV, JOB_ID_ENV, JOB_PORT_ENV, JOB_WS_ENV } from "./runner.js";
import { JobLaunchError, redactSecret, stepFailure } from "./launch.js";
import { hostGateway, hostJobDir, type HostJobDir } from "./launch-host.js";
import type { AgentJobRow } from "./store.js";
import type { PaneView } from "./surface.js";

/** 작업 컨테이너 라벨 — 박스의 작업 컨테이너를 앱 서버 · 사람 것과 가른다. */
export const JOB_CONTAINER_LABEL = "lvly.agent-job";
/** 컨테이너 안 하네스 실행 파일 자리(읽기 전용 마운트) — PATH 맨 앞이다. */
export const JOB_CLAUDE_TARGET = "/opt/lively-job/bin/claude";
const JOB_PATH = "/opt/lively-job/bin:/usr/local/bin:/usr/bin:/bin";
/** 설정 폴더를 붙이지 않는 작업의 HOME(빈 tmpfs). */
export const JOB_BARE_HOME = "/home/lively-job";
/** 컨테이너 로캘 — 이미지(bookworm)에 늘 있는 값(게이트웨이 로캘 ko_KR · en_US 는 slim 이미지에 없다). */
export const JOB_LOCALE = "C.UTF-8";
/** 홈 없는 작업의 기본 uid — 박스 계정이 쓰지 않는 번호(박스에 같은 uid 계정이 있으면 띄우지 않는다 — dockerBox). */
export const DEFAULT_JOB_UID = 65532;
const JOB_PIDS = 1024;
const JOB_TMP_MB = 1024;
const JOB_HOME_MB = 256;
/** 박스 메모리가 모자랄 때 작업이 먼저 끊기게(게이트웨이 · DB · 앱 서버는 0) — 검사기가 받는 끝(0~1000). */
const JOB_OOM_SCORE_ADJ = 1000;
/** 판 머리가 붙은 Claude 설정 폴더를 확인하는 env(컨테이너 안 자리) — 머리가 읽고 지운다. */
export const JOB_CLAUDE_DIR_ENV = "LVLY_JOB_CLAUDE_DIR";
/** 컨테이너 안 작업 폴더 꼴 — 행의 작업 폴더(plan.appFolderCwd · projectFolderCwd)와 같은 두 꼴. */
const WORK_TARGET_RE = /^\/work\/(apps\/[a-z0-9][a-z0-9-]{1,31}|shared\/project\/[1-9][0-9]{0,15})$/;

/** (순수) 작업 컨테이너 이름 — `lvly-<작업 세션 id>`. 행의 session_id 에서 바로 나와 걷기가 같은 자로 다시 짓는다. `job-` 꼴이 아니면 던진다. */
export function jobContainerName(sessionId: string): string {
  if (!JOB_SESSION_ID_RE.test(String(sessionId))) throw new Error(`작업 세션 id 꼴이 아니다: ${JSON.stringify(String(sessionId).slice(0, 80))}`);
  return `lvly-${sessionId}`;
}

/**
 * 판 머리 — `sh -c <이것> lvly-job <부트>`. 붙은 Claude 설정 폴더(구독 작업)가 이 uid 소유 폴더인지 보고 부트로 넘어간다.
 *  도커는 원본 경로의 링크를 따라가 붙이므로, 띄우기 전 확인(memberFacts) 뒤에 링크로 바꿔치기해도 남의 폴더면 여기서 멈춘다(3 — 부트 실패와 같은 코드).
 */
export const JOB_CONTAINER_PRELUDE = [
  `c="\${${JOB_CLAUDE_DIR_ENV}:-}"; unset ${JOB_CLAUDE_DIR_ENV}`,
  'if [ -n "$c" ] && { [ ! -d "$c" ] || [ ! -O "$c" ]; }; then echo "lvly-job: 붙은 Claude 설정 폴더($c)가 이 계정의 폴더가 아닙니다 — 판을 세우지 않습니다" >&2; exit 3; fi',
  'exec node -e "$1"',
].join("\n");

/** 이 박스의 도커 · 하네스 사실(dockerBox). */
export interface DockerBox {
  /** 컨테이너 이미지 — node 가 든 이미지(판 부트 · 본체가 node 로 돈다). */
  image: string;
  /** 하네스 실행 파일(박스 위 실제 경로 · 리눅스 ELF · 다른 계정도 실행 가능). */
  claudeBin: string;
  /** 도커가 쓰는 메모리(MB) — memory_max_mb 0(상한 없음)일 때 컨테이너에 거는 값. */
  memMb: number;
  /** 도커가 스왑 상한을 거나(docker info SwapLimit) — 못 걸면 상한을 둔 정책으로는 띄우지 않는다. */
  swapLimit: boolean;
  /** 구성원 격리 박스인가(구성원마다 OS 계정 — terminal-isolation.isolationInfraReady). */
  isolated: boolean;
  /** lively-shared 그룹 gid — 격리 박스의 공유 · 앱 폴더(setgid)에 쓰는 그룹. 비격리 박스면 null. */
  sharedGid: number | null;
  /** 게이트웨이 계정 — 비격리 박스의 컨테이너 사용자. */
  gateway: { uid: number; gid: number; home: string };
  /** 홈 없는 작업의 컨테이너 uid(격리 박스). */
  jobUid: number;
}

/** 격리 박스 그 계정의 사실 — uid · gid · 홈 · 홈의 ~/.claude 상태(구독 작업만 본다 — 그 계정 권한으로). */
export interface MemberFacts {
  uid: number; gid: number; home: string;
  claude: "ok" | "missing" | "link" | "foreign" | null;
}

/** 컨테이너를 누구로 · 무엇을 붙여 띄우나(jobPlacement). */
export interface JobPlacement {
  uid: number; gid: number;
  /** --group-add(숫자 gid). */
  groups: number[];
  /** 컨테이너 HOME(빈 tmpfs). */
  home: string;
  /** 구독 작업의 Claude 설정 폴더 — 박스 위 자리 · 컨테이너 안 자리 · 검사기 뿌리 · CLAUDE_CONFIG_DIR 로 알려야 하나. 없으면 붙이지 않는다. */
  claude: { host: string; target: string; root: string; configDirEnv: boolean } | null;
  runsAs: "member" | "gateway" | "job";
}

const CLAUDE_DIR_REFUSAL: Readonly<Record<"missing" | "link" | "foreign", string>> = {
  missing: "실행 계정의 홈에 Claude 로그인 폴더(~/.claude)가 없습니다 — 그 사람이 사람 세션에서 한 번 로그인해야 구독으로 돕니다",
  link: "실행 계정의 ~/.claude 가 링크라 작업 컨테이너에 붙이지 않습니다 — 링크를 걷고 실제 폴더로 두세요",
  foreign: "실행 계정의 ~/.claude 가 그 계정 소유의 폴더가 아니라 작업 컨테이너에 붙이지 않습니다",
};

/**
 * (순수) 컨테이너를 누구로 · 무엇을 붙여 띄우나 — 머리말 «누구로 도나». 띄울 수 없는 자리면 까닭과 함께 던진다(다시 해도 안 된다).
 *  profile = 비격리 박스 구독 작업의 Claude 설정 폴더와 그 뿌리(멀티프로필) — 단일 계정 스위치(LIVELY_MULTIPROFILE=0)면 null(게이트웨이 ~/.claude).
 */
export function jobPlacement(f: {
  homeless: boolean; subscription: boolean;
  box: Pick<DockerBox, "isolated" | "sharedGid" | "gateway" | "jobUid">;
  member: MemberFacts | null;
  profile: { dir: string; root: string } | null;
}): JobPlacement {
  const { box } = f;
  if (box.isolated) {
    if (box.sharedGid == null) throw new Error("이 박스에 lively-shared 그룹이 없습니다 — 구성원 격리 설치(deploy/linux/install-isolation.sh)를 다시 돌리세요");
    if (f.homeless) return { uid: box.jobUid, gid: box.sharedGid, groups: [], home: JOB_BARE_HOME, claude: null, runsAs: "job" };
    const m = f.member;
    if (!m) throw new Error("실행 계정의 OS 계정을 확인하지 못했습니다");
    const groups = m.gid === box.sharedGid ? [] : [box.sharedGid];
    if (!f.subscription) return { uid: m.uid, gid: m.gid, groups, home: JOB_BARE_HOME, claude: null, runsAs: "member" };
    if (m.claude !== "ok") throw new Error(CLAUDE_DIR_REFUSAL[m.claude ?? "missing"]);
    const dir = path.join(m.home, ".claude");
    return { uid: m.uid, gid: m.gid, groups, home: m.home, claude: { host: dir, target: dir, root: m.home, configDirEnv: false }, runsAs: "member" };
  }
  const g = box.gateway;
  if (g.uid === 0) throw new Error("게이트웨이가 root 로 돌고 있어 작업 컨테이너를 띄우지 않습니다(컨테이너 안은 root 가 아닌 계정으로 돈다)");
  if (f.homeless || !f.subscription) return { uid: g.uid, gid: g.gid, groups: [], home: JOB_BARE_HOME, claude: null, runsAs: "gateway" };
  const dir = f.profile?.dir ?? path.join(g.home, ".claude");
  return { uid: g.uid, gid: g.gid, groups: [], home: JOB_BARE_HOME, claude: { host: dir, target: dir, root: f.profile?.root ?? g.home, configDirEnv: true }, runsAs: "gateway" };
}

/** (순수) 작업 정책의 메모리 상한(MB) → 컨테이너 메모리(MB). 0 = 상한 없음 — 도커 메모리 전체까지(검사기는 --memory 를 꼭 받는다). */
export function dockerMemoryMb(memoryMaxMb: number, boxMemMb: number): number {
  if (Number.isFinite(memoryMaxMb) && memoryMaxMb > 0) return Math.floor(memoryMaxMb);
  return Math.max(256, Math.floor(boxMemMb) || 0);
}

/** (순수) 컨테이너 env — 판 부트가 읽는 넷(비밀 · 작업 id · 포트 · 워크스페이스) + 하네스가 도는 데 필요한 것. 명령줄이 아니라 env 파일로 넘긴다. */
export function jobContainerEnv(o: {
  jobId: number; bootSecret: string; port: number; slug: string | null; tz: string; place: Pick<JobPlacement, "home" | "claude">;
}): Record<string, string> {
  const c = o.place.claude;
  return {
    [JOB_BOOT_ENV]: o.bootSecret, [JOB_ID_ENV]: String(o.jobId), [JOB_PORT_ENV]: String(o.port),
    ...(o.slug ? { [JOB_WS_ENV]: o.slug, LVLY_TENANT_SLUG: o.slug } : {}),
    HOME: o.place.home, PATH: JOB_PATH, LANG: JOB_LOCALE, LC_ALL: JOB_LOCALE, LC_CTYPE: JOB_LOCALE, TZ: o.tz,
    //  기계 세션 표식(launch.jobTmuxArgv · launch-host.hostPaneArgv 와 같은 자리) · 하네스 실행 파일은 읽기 전용이라 고치려 들지 않게.
    LIVELY_SESSION_KIND: "task", DISABLE_AUTOUPDATER: "1",
    ...(c ? { [JOB_CLAUDE_DIR_ENV]: c.target } : {}),
    ...(c?.configDirEnv ? { CLAUDE_CONFIG_DIR: c.target } : {}),
  };
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** (순수) env 파일 글 — KEY=VALUE 한 줄씩(Docker --env-file 꼴 · 따옴표를 풀지 않는다). 줄바꿈 · NUL 이 든 값은 던진다. */
export function envFileText(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => {
    if (!ENV_KEY_RE.test(k) || /[\r\n\0]/.test(v)) throw new Error(`env ${k.slice(0, 40)} 를 작업 컨테이너에 넘길 수 없습니다(이름 꼴 · 줄바꿈)`);
    return `${k}=${v}\n`;
  }).join("");
}

/** 컨테이너 하나 — jobContainerArgs 의 입력. */
export interface JobContainerPlan {
  name: string;
  image: string;
  labels: Record<string, string>;
  place: Pick<JobPlacement, "uid" | "gid" | "groups" | "home" | "claude">;
  memoryMb: number;
  /** 작업 폴더(박스 위) — 컨테이너 안 workdir(행의 작업 폴더)에 쓰기로 붙인다. */
  workHost: string;
  workdir: string;
  claudeBin: string;
  envFile: string;
}

/** (순수) 작업 컨테이너 인자(docker run …) — 정해진 꼴 하나(머리말 «막이»). */
export function jobContainerArgs(p: JobContainerPlan): string[] {
  const { place } = p;
  return [
    "run", "-d", "--rm", "--name", p.name,
    ...Object.entries(p.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    "--network", "host",
    "--read-only",
    "--tmpfs", `/tmp:rw,nosuid,nodev,size=${JOB_TMP_MB}m,mode=1777`,
    //  HOME 은 그 사용자의 빈 tmpfs — 그 아래 Claude 설정 폴더(구독)를 붙인다(도커는 얕은 자리부터 붙인다).
    "--tmpfs", `${place.home}:rw,nosuid,nodev,size=${JOB_HOME_MB}m,mode=0700,uid=${place.uid},gid=${place.gid}`,
    "--memory", `${p.memoryMb}m`, "--memory-swap", `${p.memoryMb}m`, "--pids-limit", String(JOB_PIDS), "--oom-score-adj", String(JOB_OOM_SCORE_ADJ),
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${place.uid}:${place.gid}`,
    ...place.groups.flatMap((g) => ["--group-add", String(g)]),
    "--init", "--restart", "no",
    "--volume", `${p.workHost}:${p.workdir}`,
    ...(place.claude ? ["--volume", `${place.claude.host}:${place.claude.target}`] : []),
    "--volume", `${p.claudeBin}:${JOB_CLAUDE_TARGET}:ro`,
    "--env-file", p.envFile,
    "--workdir", p.workdir, "--stop-timeout", "10",
    "--log-driver", "json-file", "--log-opt", "max-size=1m", "--log-opt", "max-file=1",
    p.image, "sh", "-c", JOB_CONTAINER_PRELUDE, "lvly-job", BOOT_SOURCE,
  ];
}

const exact = (s: string): RegExp => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/**
 * (순수) 작업 컨테이너의 검사 정책 — 인자를 지은 값이 아니라 자리의 사실(뿌리)로 짓는다: 작업 폴더는 그 자리(apps · shared)의 뿌리 아래에서만 행의
 *  작업 폴더 꼴로, Claude 설정 폴더는 그 계정 홈(프로필 뿌리) 아래에서 정해진 자리 하나로, 하네스 실행 파일은 그 파일 하나를 읽기 전용으로,
 *  env 파일은 작업 런타임 폴더 아래만, tmpfs 는 /tmp 와 HOME 만, 그룹은 lively-shared 만.
 */
export function jobContainerPolicy(f: {
  image: string; workRoot: string; workdir: string; claude: { root: string; target: string } | null; claudeBin: string; envRoot: string; home: string; groups: number[];
}): DockerRunPolicy {
  if (!WORK_TARGET_RE.test(f.workdir)) throw new Error(`작업 폴더 꼴이 아닙니다: ${f.workdir.slice(0, 80)}`);
  return {
    networks: ["host"], images: [f.image], readOnly: true, publish: false,
    tmpfs: ["/tmp", f.home],
    binds: [
      { root: f.workRoot, rw: true, targets: exact(f.workdir) },
      ...(f.claude ? [{ root: f.claude.root, rw: true, targets: exact(f.claude.target) }] : []),
      { root: f.claudeBin, rw: false, targets: exact(JOB_CLAUDE_TARGET) },
    ],
    envFiles: [f.envRoot],
    groupAdds: f.groups,
  };
}

/** 고칠 길 — 상한을 못 걸 때 접수 실패 · 관리자 보기에 같은 글로 싣는다. */
const DOCKER_CAP_FIX = "박스의 스왑 계정(cgroup v2 · swapaccount)을 켜거나, 상한 없이 돌리려면 관리자가 agent_job_limits_set 으로 memory_max_mb 를 0 으로 바꿉니다";

/** 도커 실행면이 쓰는 바깥 일 — 시험이 바꿔 끼운다(기본은 liveDockerDeps). */
export interface DockerLaunchDeps {
  /** 이 박스의 도커 · 하네스 사실 — 도커에 못 닿거나 하네스 실행 파일이 없으면 던진다(일시 실패 — 고치면 다음 띄우기가 된다). */
  box(): Promise<DockerBox>;
  accountUser(memberId: string): Promise<LivelyUser>;
  /** 사람 세션과 같은 OS 계정 판정(격리 박스 — 없으면 만든다). */
  ensureOsUser(user: LivelyUser): Promise<string | null>;
  /** 격리 박스 그 계정의 uid · gid · 홈 — wantClaude 면 홈의 ~/.claude 상태도 그 계정 권한으로 본다. */
  memberFacts(osUser: string, wantClaude: boolean): Promise<MemberFacts>;
  /** 비격리 박스 구독 작업의 Claude 설정 폴더와 그 뿌리 — 단일 계정 스위치면 null(게이트웨이 ~/.claude). */
  profileDir(user: LivelyUser): Promise<{ dir: string; root: string } | null>;
  /** 박스 위 작업 폴더와 그 자리의 뿌리(profiles.resolveRootPath — osUser 가 격리 기준을 고른다). */
  resolveWork(user: LivelyUser, dir: HostJobDir, osUser: string | null): Promise<{ abs: string; base: string }>;
  /** 작업 폴더를 만든다 — 그 계정으로(격리 · 사람 작업), 게이트웨이로(홈 없는 작업 · 비격리 — 격리 박스면 lively-shared 가 쓰는 2775). */
  mkdirWork(osUser: string | null, abs: string, shared: boolean): Promise<void>;
  /** 작업 메모리 상한(작업 정책 memory_max_mb · 0 = 없음). */
  memoryMaxMb(): Promise<number>;
  ensureImage(image: string): Promise<void>;
  /** env 파일을 런타임 폴더에 0600 으로 쓰고 경로를 돌려준다(root = 그 폴더 — 검사기 뿌리). */
  writeEnvFile(name: string, text: string): Promise<{ file: string; root: string }>;
  removeEnvFile(file: string): Promise<void>;
  /** 검사기를 지난 인자로 컨테이너를 띄운다(docker run -d). 검사기가 거절하면 DockerRunRejected. */
  run(args: string[], policy: DockerRunPolicy): Promise<void>;
  /** 컨테이너를 지운다 — 없으면 조용히(No such container). 그 밖은 던진다. */
  remove(name: string): Promise<void>;
  tz(): Promise<string>;
  slug(): string | null;
  port(): number;
}

/**
 * 작업 컨테이너를 띄운다 — 도커 · 하네스 → 메모리 상한 → 자리(누구로 · 무엇을 붙이나) → 작업 폴더 → 이미지 → env 파일 → docker run.
 *  다시 해도 안 될 것(세션 id · 홈 없는 작업의 조건 · 실행 계정 · 작업 폴더 꼴 · 상한을 걸 수 없음 · 붙일 수 없는 Claude 폴더 · 검사기 거절)은
 *  JobLaunchError, 인프라가 잠깐 막힌 것(도커 · OS 계정 · 작업 폴더 · 이미지 · 띄우기)은 일시 실패다(launch.stepFailure).
 */
export async function launchDockerJob(
  job: AgentJobRow, bootSecret: string, deps?: DockerLaunchDeps, o: { sharedSeat?: boolean } = {},
): Promise<{ container: string }> {
  const sid = job.session_id;
  if (!sid || !JOB_SESSION_ID_RE.test(sid)) throw new JobLaunchError("세션 id 가 없는 작업입니다");
  const homelessWhy = homelessJobRefusal(job);
  if (homelessWhy) throw new JobLaunchError(homelessWhy);
  const homeless = job.homeless === true;
  const seat = jobSeatMember(job);
  if (!seat) throw new JobLaunchError("실행 계정이 없는 작업입니다");
  const dir = hostJobDir(job.cwd);
  if (!dir) throw new JobLaunchError(`작업 폴더 꼴이 아닙니다: ${JSON.stringify(String(job.cwd).slice(0, 120))}`);
  const d = deps ?? (await liveDockerDeps());
  let box: DockerBox;
  try { box = await d.box(); } catch (e) { throw stepFailure("ensure", e); }
  const policyMb = await d.memoryMaxMb().catch((e) => { throw stepFailure("memory", e); });
  if (policyMb > 0 && !box.swapLimit) {
    throw new JobLaunchError(`작업 메모리 상한(${policyMb}MB)을 걸 수 없어 띄우지 않습니다 — 이 박스의 도커가 스왑 상한을 걸지 못합니다(docker info SwapLimit=false). ${DOCKER_CAP_FIX}`);
  }
  const subscription = job.account_kind === "subscription";
  //  홈 없는 작업은 그 사람의 계정 · 홈을 쓰지 않는다(전용 uid) — 작업 폴더 자리만 그 사람 기준으로 푼다(앱 자리는 사람마다 다르지 않다).
  const user = homeless ? ({ userId: seat } as LivelyUser) : await d.accountUser(seat);
  let osUser: string | null = null;
  let member: MemberFacts | null = null;
  if (!homeless && box.isolated) {
    try { osUser = await d.ensureOsUser(user); } catch (e) { throw stepFailure("os-user", e); }
    if (!osUser) throw stepFailure("os-user", `실행 계정 ${seat} 의 OS 계정을 만들지 못했습니다(게이트웨이 계정으로는 띄우지 않는다)`);
    try { member = await d.memberFacts(osUser, subscription); } catch (e) { throw stepFailure("os-user", e); }
  }
  const profile = !box.isolated && subscription && !homeless ? await d.profileDir(user).catch((e) => { throw stepFailure("home", e); }) : null;
  let place: JobPlacement;
  try { place = jobPlacement({ homeless, subscription, box, member, profile }); }
  catch (e) { throw new JobLaunchError(String((e as Error)?.message ?? e)); }
  let work: { abs: string; base: string };
  try {
    work = await d.resolveWork(user, dir, box.isolated ? (osUser ?? HOMELESS_OS_USER) : null);
    await d.mkdirWork(osUser, work.abs, box.isolated && !osUser);
  } catch (e) { throw stepFailure("workdir", e); }
  try { await d.ensureImage(box.image); } catch (e) { throw stepFailure("ensure", e); }
  const name = jobContainerName(sid);
  const slug = d.slug();
  let env: { file: string; root: string };
  try {
    env = await d.writeEnvFile(name, envFileText(jobContainerEnv({ jobId: job.id, bootSecret, port: d.port(), slug, tz: await d.tz(), place })));
  } catch (e) { throw stepFailure("pane", redactSecret(String((e as Error)?.message ?? e), bootSecret)); }
  const memoryMb = dockerMemoryMb(policyMb, box.memMb);
  const labels: Record<string, string> = { [JOB_CONTAINER_LABEL]: "1", [`${JOB_CONTAINER_LABEL}.id`]: String(job.id), ...(slug ? { "lvly.tenant": slug } : {}) };
  const args = jobContainerArgs({ name, image: box.image, labels, place, memoryMb, workHost: work.abs, workdir: job.cwd, claudeBin: box.claudeBin, envFile: env.file });
  try {
    const policy = jobContainerPolicy({
      image: box.image, workRoot: work.base, workdir: job.cwd, claude: place.claude ? { root: place.claude.root, target: place.claude.target } : null,
      claudeBin: box.claudeBin, envRoot: env.root, home: place.home, groups: place.groups,
    });
    await d.run(args, policy);
  } catch (e) {
    //  검사기 거절은 인자를 지은 코드 탓이다 — 다시 해도 같다.
    if (e instanceof DockerRunRejected) throw new JobLaunchError(e.message);
    throw stepFailure("ensure", redactSecret(String((e as Error)?.message ?? e), bootSecret).slice(0, 400));
  } finally {
    //  docker run 은 env 파일을 띄울 때 한 번 읽는다(--restart no) — 곧바로 지워 비밀을 디스크에 남기지 않는다.
    await d.removeEnvFile(env.file).catch(() => undefined);
  }
  logger.info({ job: job.id, session: sid, container: name, runsAs: place.runsAs, uid: place.uid, memoryMb, claudeDir: !!place.claude, sharedSeat: o.sharedSeat === true, homeless },
    "[agent-job] 작업 컨테이너를 띄웠다(도커)");
  return { container: name };
}

/** 판이 보는 자리 — 컨테이너 안 작업 폴더는 행의 작업 폴더 그대로(같은 자리에 붙인다) · 게이트웨이는 이 박스 루프백 포트 · 실을 워크스페이스. */
export function dockerPaneView(job: Pick<AgentJobRow, "cwd">, o: { port: number; slug: string | null }): PaneView {
  return { cwd: job.cwd, gateway: hostGateway(o.port), workspace: o.slug };
}

/**
 * 작업 컨테이너를 걷는다 — `job-` 꼴만(launch.killJobContainer 의 마지막 자리와 같은 규율 — 사람 · 앱 서버 컨테이너를 지우는 길이 여기로 열리지 않게).
 *  이미 없다는 확답은 remove 가 삼킨다. 그 밖은 던진다(부르는 쪽이 다음 감시에 다시 걷는다).
 */
export async function killDockerJob(sessionId: string, deps?: Pick<DockerLaunchDeps, "remove">): Promise<void> {
  const name = jobContainerName(sessionId);
  await (deps ?? (await liveDockerDeps())).remove(name);
}

// ── 박스 사실 · 관리자 보기 ─────────────────────────────────────────────────────

/** 박스 판정을 기억하는 동안 — 된다는 1분, 안 된다는 15초(관리자가 고치면 곧 따라오게). 묻는 중인 판정은 함께 받는다. */
const BOX_OK_MS = 60_000;
const BOX_NO_MS = 15_000;
let boxProbe: { at: number; result: { ok: true; box: DockerBox } | { ok: false; why: string } } | null = null;
let boxInflight: Promise<{ ok: true; box: DockerBox } | { ok: false; why: string }> | null = null;

/** 이 박스에서 도커 실행면을 쓸 수 있나 — 기억한 판정(없으면 묻는다). o 는 시험이 바꿔 끼운다. */
export async function dockerBoxCheck(o: { probe?: () => Promise<DockerBox>; now?: () => number } = {}): Promise<{ ok: true; box: DockerBox } | { ok: false; why: string }> {
  const now = (o.now ?? Date.now)();
  if (boxProbe && now - boxProbe.at < (boxProbe.result.ok ? BOX_OK_MS : BOX_NO_MS)) return boxProbe.result;
  if (boxInflight) return boxInflight;
  boxInflight = (async () => {
    const result: { ok: true; box: DockerBox } | { ok: false; why: string } = await (o.probe ?? probeDockerBox)()
      .then((box) => ({ ok: true as const, box }))
      .catch((e) => ({ ok: false as const, why: String((e as Error)?.message ?? e) }));
    boxProbe = { at: now, result };
    return result;
  })().finally(() => { boxInflight = null; });
  return boxInflight;
}

/** 시험 전용 — 기억한 박스 판정을 잊는다. */
export function resetDockerProbesForTest(): void { boxProbe = null; boxInflight = null; }

/** 지금 못 띄울 때의 까닭(마지막 판정) — 접수 501 문장. */
export function dockerUnavailableMessage(): string {
  const why = boxProbe && !boxProbe.result.ok ? boxProbe.result.why : "이 박스의 도커 · 하네스 실행 파일을 아직 확인하지 못했습니다";
  return `지금은 에이전트 작업을 띄울 수 없습니다 — ${why}`;
}

/** 관리자에게 보일 도커 실행면 상태 — 누구로 도나 · 작업 메모리 상한이 실제로 걸리나(agent_job_limits surface). 띄우기와 같은 판정. */
export async function dockerSurfaceStatus(memoryMaxMb: number, o: { check?: typeof dockerBoxCheck } = {}): Promise<{ runsAs: "member" | "gateway" | null; enforced: boolean; note: string }> {
  const c = await (o.check ?? dockerBoxCheck)();
  if (!c.ok) return { runsAs: null, enforced: false, note: `지금은 작업 컨테이너를 띄울 수 없습니다 — ${c.why}` };
  const runsAs = c.box.isolated ? "member" : "gateway";
  if (!(Number.isFinite(memoryMaxMb) && memoryMaxMb > 0)) {
    return { runsAs, enforced: false, note: `memory_max_mb 가 0 이라 작업 컨테이너는 도커 메모리 전체(${c.box.memMb}MB)까지 씁니다` };
  }
  if (!c.box.swapLimit) return { runsAs, enforced: false, note: `이 박스의 도커가 스왑 상한을 걸지 못해(SwapLimit=false) 이대로는 작업을 띄우지 않습니다. ${DOCKER_CAP_FIX}` };
  return { runsAs, enforced: true, note: "작업마다 컨테이너 메모리 상한(스왑 없이)으로 겁니다 — 넘으면 그 컨테이너 안에서 메모리를 가장 많이 쓰는 프로세스가 끊깁니다" };
}

// ── 살아 있는 의존 ─────────────────────────────────────────────────────────────

/** docker CLI(env LIVELY_DOCKER_BIN · 기본 PATH 의 docker — 앱 서버 실행면 DockerDriver 와 같은 값). */
const dockerBin = (): string => process.env.LIVELY_DOCKER_BIN?.trim() || "docker";

async function exec(bin: string, args: string[], timeoutMs: number): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return reject(new Error(`${bin} 를 찾지 못했습니다`));
      reject(Object.assign(new Error(`${bin} ${args[0]} 실패: ${(String(stderr ?? "").trim() || e.message).slice(0, 500)}`), { stderr: String(stderr ?? "") }));
    });
  });
}

/** PATH 에서 실행 파일을 찾는다(which). */
async function onPath(name: string): Promise<string | null> {
  const fsp = await import("node:fs/promises");
  for (const d of String(process.env.PATH ?? "").split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, name);
    try { await fsp.access(p, 1 /* X_OK */); return p; } catch { /* 다음 */ }
  }
  return null;
}

/** 하네스 실행 파일 — env LIVELY_AGENT_JOB_CLAUDE_BIN 이 먼저, 없으면 게이트웨이 PATH 의 claude. 실제 경로 · 리눅스 ELF · 다른 계정도 실행 가능이어야 한다. */
async function resolveClaudeBin(): Promise<string> {
  const fsp = await import("node:fs/promises");
  const named = process.env.LIVELY_AGENT_JOB_CLAUDE_BIN?.trim();
  const found = named || (await onPath("claude"));
  const fix = "게이트웨이 계정으로 네이티브 claude 를 깔거나(curl -fsSL https://claude.ai/install.sh | bash) LIVELY_AGENT_JOB_CLAUDE_BIN 에 리눅스 claude 실행 파일 경로를 적으세요";
  if (!found) throw new Error(`작업 컨테이너에 넣을 claude 가 게이트웨이 계정의 PATH 에 없습니다 — ${fix}`);
  const real = await fsp.realpath(found).catch(() => { throw new Error(`claude(${found})를 찾지 못했습니다 — ${fix}`); });
  const head = Buffer.alloc(4);
  const fh = await fsp.open(real, "r");
  try { await fh.read(head, 0, 4, 0); } finally { await fh.close(); }
  if (!(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)) {
    throw new Error(`claude(${real})가 리눅스 실행 파일(ELF)이 아닙니다(npm 설치 · 맥 실행 파일은 컨테이너에서 돌지 않는다) — ${fix}`);
  }
  if (((await fsp.stat(real)).mode & 0o005) !== 0o005) throw new Error(`claude(${real})를 다른 계정이 실행할 수 없습니다(권한) — 작업 컨테이너는 게이트웨이가 아닌 계정으로 돈다`);
  return real;
}

/** 홈 없는 작업의 uid(env LIVELY_AGENT_JOB_UID · 1000 이상) — 꼴이 틀리면 기본값. */
function jobUidOf(): number {
  const raw = String(process.env.LIVELY_AGENT_JOB_UID ?? "").trim();
  const n = /^[0-9]{4,10}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 1000 && n <= 2147483647 ? n : DEFAULT_JOB_UID;
}

/** 이 박스의 도커 · 하네스 사실을 읽는다 — 못 쓰면 까닭과 함께 던진다. */
export async function probeDockerBox(): Promise<DockerBox> {
  const os = await import("node:os");
  const iso = await import("../terminal/terminal-isolation.js");
  const { localImage, LOCAL_IMAGE_RE } = await import("../apps/app-server-config.js");
  const claudeBin = await resolveClaudeBin();
  const info = await exec(dockerBin(), ["info", "--format", "{{.MemTotal}} {{.SwapLimit}}"], 20_000)
    .catch((e) => { throw new Error(`도커에 닿지 못했습니다(${(e as Error).message}) — 박스에 Docker 를 깔고 게이트웨이 계정을 docker 그룹에 넣으세요`); });
  const [mem, swap] = info.trim().split(/\s+/);
  const named = String(process.env.LIVELY_AGENT_JOB_IMAGE ?? "").trim();
  const image = named && LOCAL_IMAGE_RE.test(named) ? named : localImage();
  const isolated = iso.isolationInfraReady();
  let sharedGid: number | null = null;
  const jobUid = jobUidOf();
  if (isolated) {
    const g = await exec("getent", ["group", "lively-shared"], 10_000).catch(() => "");
    const gid = Number(g.split(":")[2]);
    sharedGid = Number.isSafeInteger(gid) && gid > 0 ? gid : null;
    //  전용 uid 가 박스 계정과 겹치면 그 계정이 컨테이너 안을 들여다본다 — 띄우지 않는다.
    const taken = await exec("getent", ["passwd", String(jobUid)], 10_000).then((s) => s.split(":")[0]).catch(() => "");
    if (taken) throw new Error(`홈 없는 작업의 uid(${jobUid})를 박스 계정 ${taken} 이 씁니다 — LIVELY_AGENT_JOB_UID 를 비어 있는 번호로 바꾸세요`);
  }
  return {
    image, claudeBin, memMb: Math.floor((Number(mem) || 0) / 1048576), swapLimit: swap === "true", isolated, sharedGid,
    gateway: { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1, home: os.homedir() }, jobUid,
  };
}

/** 그 계정 홈의 ~/.claude 상태 — 그 계정 권한으로 본다(게이트웨이는 0700 홈 안을 못 본다). 경로는 우리가 지은 값(따옴표 안 · 꼴을 먼저 본다). */
export function claudeDirProbeScript(dir: string): string {
  if (!/^\/[A-Za-z0-9._/-]{1,250}$/.test(dir)) throw new Error(`Claude 설정 폴더 경로 꼴 밖: ${JSON.stringify(dir.slice(0, 80))}`);
  return `c='${dir}'; if [ -L "$c" ]; then echo link; elif [ ! -e "$c" ]; then echo missing; elif [ ! -d "$c" ] || [ ! -O "$c" ]; then echo foreign; else echo ok; fi`;
}

/** 이미지 받기를 기억한다(프로세스마다 한 번 — 지워졌으면 docker run 이 실패해 다음 띄우기가 다시 받는다). */
const pulled = new Set<string>();

/** 도커 실행면의 살아 있는 의존. */
export async function liveDockerDeps(): Promise<DockerLaunchDeps> {
  const launch = await import("./launch.js");
  const profiles = await import("../terminal/profiles.js");
  const mfs = await import("../terminal/terminal-member-fs.js");
  const { tenantSlug } = await import("../terminal/catalog.js");
  const { execTopology } = await import("../exec-topology.js");
  const { assertSafeDockerRun } = await import("../ops/docker-run-guard.js");
  const { stateDir } = await import("../ops/state-dir.js");
  const fsp = await import("node:fs/promises");
  const runDir = stateDir("agent-jobs", "run");
  return {
    box: async () => { const c = await dockerBoxCheck(); if (!c.ok) throw new Error(c.why); return c.box; },
    accountUser: (m) => launch.accountUser(m),
    ensureOsUser: (u) => profiles.ensureMemberOsUser(u),
    memberFacts: async (osUser, wantClaude) => {
      const uid = Number((await exec("id", ["-u", osUser], 10_000)).trim());
      const gid = Number((await exec("id", ["-g", osUser], 10_000)).trim());
      if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0) throw new Error(`OS 계정 ${osUser} 의 uid · gid 를 읽지 못했습니다`);
      const home = path.join(profiles.MEMBER_HOME_BASE, osUser);
      if (!wantClaude) return { uid, gid, home, claude: null };
      const s = (await mfs.memberShOut(osUser, claudeDirProbeScript(path.join(home, ".claude")))).trim();
      if (s !== "ok" && s !== "missing" && s !== "link" && s !== "foreign") throw new Error(`~/.claude 상태를 읽지 못했습니다: ${s.slice(0, 80)}`);
      return { uid, gid, home, claude: s };
    },
    profileDir: async (u) => {
      //  비격리 박스 — 사람 세션 · 1단계와 같은 자리(멀티프로필 #346 · #1014). 단일 계정 스위치면 게이트웨이 ~/.claude 그대로.
      if (process.env.LIVELY_MULTIPROFILE === "0") return null;
      const dir = profiles.profileConfigDir(u);
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      return { dir, root: profiles.PROFILES_ROOT };
    },
    resolveWork: (u, dir, osUser) => profiles.resolveRootPath(u, dir.root, dir.sub, osUser),
    mkdirWork: async (osUser, abs, shared) => {
      if (osUser) { await mfs.memberMkdir(osUser, abs); return; }
      await fsp.mkdir(abs, { recursive: true });
      //  격리 박스의 홈 없는 작업 — 게이트웨이(lively-shared)가 만든 앱 폴더를 그룹이 쓰게(apps 자리와 같은 2775). 남이 먼저 만든 폴더는 못 바꾼다(그대로 둔다).
      if (shared) await fsp.chmod(abs, 0o2775).catch(() => undefined);
    },
    memoryMaxMb: async () => {
      const pol = await import("../org/policies/agent-job-policy.js");
      const store = await import("./store.js");
      return (await pol.effectiveAgentJobPolicy(async () => pol.resolveAgentJobPolicy(await store.agentJobPolicyRow()))).memory_max_mb;
    },
    ensureImage: async (image) => {
      if (pulled.has(image)) return;
      try { await exec(dockerBin(), ["image", "inspect", "--format", "{{.Id}}", image], 20_000); }
      catch (e) {
        if (!/No such image|not found/i.test(String((e as { stderr?: string }).stderr ?? (e as Error).message))) throw e;
        await exec(dockerBin(), ["pull", "--quiet", image], 10 * 60_000);
      }
      pulled.add(image);
    },
    writeEnvFile: async (name, text) => {
      await fsp.mkdir(runDir, { recursive: true, mode: 0o700 });
      const file = path.join(runDir, `${name}.env`);
      await fsp.writeFile(file, text, { mode: 0o600, flag: "w" });
      return { file, root: runDir };
    },
    removeEnvFile: async (file) => { if (path.dirname(file) === runDir && file.endsWith(".env")) await fsp.rm(file, { force: true }); },
    run: async (args, policy) => { assertSafeDockerRun(args, policy); await exec(dockerBin(), args, 60_000); },
    remove: async (name) => {
      await exec(dockerBin(), ["rm", "-f", name], 30_000).catch((e) => {
        if (/No such container/i.test(String((e as { stderr?: string }).stderr ?? (e as Error).message))) return "";
        throw e;
      });
    },
    tz: async () => (await import("../org/timezone.js")).orgTimezone(),
    slug: () => tenantSlug(),
    port: () => execTopology().agentJobsPort,
  };
}
