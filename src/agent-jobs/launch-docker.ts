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
//  ★ 붙이는 원본은 링크면 안 된다 — 도커(root)는 원본 경로의 링크를 따라가서, 링크 하나로 남의 0700 홈 아래 폴더 · 다른 앱 폴더를 그 uid 로 열 수 있다
//   (부모 폴더의 막이를 건너뛴다 · apps 자리는 lively-shared 가 쓰는 2775 라 구성원이 이름을 바꿔치기할 수 있다). 그래서:
//   · ~/.claude 는 띄우기 전에 그 계정 권한으로 «링크 아님 · 그 계정 소유 폴더» 를 보고(memberFacts · 비격리는 게이트웨이가 lstat), 컨테이너 안에서도
//     판 머리(JOB_CONTAINER_PRELUDE)가 붙은 자리가 그 uid 소유 폴더인지 한 번 더 본다(사이에 바꿔치기해도 남의 폴더면 판이 서지 않는다).
//   · 작업 폴더는 게이트웨이가 «링크 아님 · 실제 경로가 그 자리» 를 본다(checkWork) — 만든 뒤 한 번, docker run 바로 앞에서 한 번 더
//     (그 사이 이미지 받기가 길 수 있다 · 검사기는 같은 뿌리 안 형제를 가리키는 링크를 원본 글로는 못 가린다).
//   · 원본은 `--mount type=bind` 로 붙인다 — 원본이 없으면 도커가 실패한다(-v 는 없는 원본을 root 소유 폴더로 만들어 그 자리 주인의 폴더를 망가뜨린다).
//  막이(jobContainerArgs — 꼴 하나 · 띄우기 직전 검사기 ops/docker-run-guard 가 jobContainerPolicy 로 한 번 더 거른다 — docker 그룹은 사실상 root):
//   · 루트 읽기 전용 · /tmp 와 HOME 만 tmpfs(exec — 도커 기본 noexec 면 npx 등이 홈에 받은 실행 파일을 못 돌린다 · 작업 폴더는 원래 실행이 된다) ·
//     메모리 = 메모리+스왑(스왑 없음 — 1단계 실측의 «스왑으로 빠진다») · pids 상한 · cap 전부 빼기 · no-new-privileges · --init(신호 · 좀비 정리) ·
//     다시 띄우지 않음 · 박스 메모리가 모자라면 작업이 먼저 끊기게(--oom-score-adj 1000) · umask 002(판 머리 — 공유 · 앱 폴더에 남는 파일 · 폴더를
//     lively-shared 가 고치고 지울 수 있게. 도커 기본 022 면 홈 없는 작업(uid 65532)이 만든 하위 폴더를 아무도 비우지 못한다).
//   · 정책은 지은 인자가 아니라 자리의 사실로 짓는다 — 작업 폴더 · ~/.claude · 하네스 실행 파일은 정확한 원본, 계정은 그 작업의 계정 하나
//     (그 계정 · 홈 없는 작업의 전용 uid · 비격리면 게이트웨이), 그룹은 lively-shared 만, tmpfs 의 exec 는 /tmp · HOME 만.
//     인자를 짓는 코드가 틀리면 검사기가 걸러 띄우지 않는다.
//   · 네트워크는 host — 판이 이 박스 게이트웨이의 루프백(LIVELY_AGENT_JOBS_PORT)에 닿아야 한다(MCP · LLM 프록시가 그 아래).
//     ⚠ 그래서 파일 자리는 막아도 이 박스 루프백에서 인증 없이 듣는 것(앞단 Caddy 의 관리 API · 임베딩 곁프로세스 등)에는 닿는다 — 1단계 판 · 사람 세션과
//     같은 한계다(#5142). 앱 서버 컨테이너에 바로 닿는 길도 1단계와 같다(#5108).
//   · 부트 비밀은 env 파일로 넘기고(0600 · docker run 이 읽은 직후 지운다) 명령줄에 싣지 않는다. 그 뒤에도 컨테이너 설정(docker inspect — docker 그룹은
//     이미 root 와 같다)과 컨테이너 프로세스의 처음 env(/proc/<pid>/environ — 컨테이너 안의 같은 uid · 격리 박스면 박스 위 그 계정의 프로세스)에 남는다.
//     부트는 한 번만 받으므로 읽어도 얻는 것은 그 작업을 «시작 실패» 로 끝내는 것뿐이다(runner 머리말 · boot-failed).
//  하네스 실행 파일은 게이트웨이 계정의 리눅스 claude(네이티브 설치 — 한 파일 실행 파일)를 읽기 전용으로 붙인다(LIVELY_AGENT_JOB_CLAUDE_BIN 이 먼저).
//   이미지는 node 가 든 이미지(판 부트 · 본체가 node 로 돈다 — LIVELY_AGENT_JOB_IMAGE · 기본 앱 서버 이미지 node:22-bookworm-slim · git · python 없음).
//   이미지가 박스에 없으면 첫 작업이 받는다(같은 때 여럿이 물어도 한 번) — 받는 시간도 시작 상한(180초 · 자리를 받은 때부터) 안에 든다.
//   느린 박스는 관리자가 처음 켤 때 docker pull 로 받아 둔다(deploy/env.example).
//  컨테이너는 판이 빠지면 끝나고 스스로 지워진다(--rm). 걷기는 `docker rm -f` 한 번이다 — 이미 없다(· 지우는 중이다)는 확답만 삼킨다.
//  다른 실행면과 다른 점(관리자가 알아 둘 것):
//   · 판이 보는 작업 폴더는 컨테이너 자리(/work/apps/<앱> — 매니지드와 같고 박스 위 /srv/... 와 다르다). 하네스는 대화를 작업 폴더별로 두므로 박스 위에서
//     만든 구독 대화를 도커 작업이 이어받으면 못 찾을 수 있다. 실행면을 host 에서 docker 로 바꾸기 전에 도는 작업을 비운다(남은 박스 위 판은 «이미 없음» 으로 걷힌다).
//   · 컨테이너에는 git 자격 · 키트 토큰 · 게이트웨이 env 가 없다(의도한 격리 — 작업에서 git push 같은 일은 이 실행면에서 안 된다).
//   · 판 머리가 멈춘 까닭(붙은 폴더가 남의 것)은 컨테이너와 함께 사라지고 시작 상한(180초) 문장만 남는다 — 띄우기 전 확인이 보통의 경우를 먼저 거른다.
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
/** 홈 없는 작업의 기본 uid — 박스 계정이 쓰지 않는 번호(박스에 같은 uid 계정이 있으면 띄우지 않는다 — probeDockerBox). */
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
 * 판 머리 — `sh -c <이것> lvly-job <부트>`. umask 를 002 로 두고(머리말 «막이»), 붙은 Claude 설정 폴더(구독 작업)가 이 uid 소유 폴더인지 보고 부트로
 *  넘어간다. 도커는 원본 경로의 링크를 따라가 붙이므로, 띄우기 전 확인(memberFacts) 뒤에 링크로 바꿔치기해도 남의 폴더면 여기서 멈춘다(3 — 부트 실패와 같은 코드).
 */
export const JOB_CONTAINER_PRELUDE = [
  "umask 002",
  `c="\${${JOB_CLAUDE_DIR_ENV}:-}"; unset ${JOB_CLAUDE_DIR_ENV}`,
  'if [ -n "$c" ] && { [ ! -d "$c" ] || [ ! -O "$c" ]; }; then echo "lvly-job: 붙은 Claude 설정 폴더($c)가 이 계정의 폴더가 아닙니다 — 판을 세우지 않습니다" >&2; exit 3; fi',
  'exec node -e "$1"',
].join("\n");

/** 이 박스의 도커 · 하네스 사실(probeDockerBox). */
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
  /** lively-shared 그룹 gid — 격리 박스의 공유 · 앱 폴더(setgid)에 쓰는 그룹(격리 박스면 늘 있다 — 없으면 판정이 실패한다). 비격리 박스면 null. */
  sharedGid: number | null;
  /** 게이트웨이 계정 — 비격리 박스의 컨테이너 사용자. */
  gateway: { uid: number; gid: number; home: string };
  /** 홈 없는 작업의 컨테이너 uid(격리 박스). */
  jobUid: number;
}

/** Claude 설정 폴더의 상태 — 폴더(그 계정 소유) · 없음 · 링크 · 그 밖(파일 · 남의 소유). */
export type ClaudeDirState = "ok" | "missing" | "link" | "foreign";

/** 격리 박스 그 계정의 사실 — uid · gid · 홈 · 홈의 ~/.claude 상태(구독 작업만 본다 — 그 계정 권한으로). */
export interface MemberFacts {
  uid: number; gid: number; home: string;
  claude: ClaudeDirState | null;
}

/** 비격리 박스 구독 작업의 Claude 설정 폴더 — 자리 · 검사기 뿌리 · 상태(게이트웨이가 lstat 으로 본다). */
export interface ProfileFacts { dir: string; root: string; state: ClaudeDirState }

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

const CLAUDE_DIR_REFUSAL: Readonly<Record<Exclude<ClaudeDirState, "ok">, string>> = {
  missing: "실행 계정의 홈에 Claude 로그인 폴더(~/.claude)가 없습니다 — 그 사람이 사람 세션에서 한 번 로그인해야 구독으로 돕니다",
  link: "실행 계정의 ~/.claude 가 링크라 작업 컨테이너에 붙이지 않습니다 — 링크를 걷고 실제 폴더로 두세요",
  foreign: "실행 계정의 ~/.claude 가 그 계정 소유의 폴더가 아니라 작업 컨테이너에 붙이지 않습니다",
};
const GATEWAY_CLAUDE_REFUSAL: Readonly<Record<Exclude<ClaudeDirState, "ok">, string>> = {
  missing: "게이트웨이 계정에 Claude 로그인 폴더가 없습니다 — 이 박스에서 그 계정으로 한 번 로그인해야 구독으로 돕니다",
  link: "게이트웨이 계정의 Claude 설정 폴더가 링크라 작업 컨테이너에 붙이지 않습니다 — 링크를 걷고 실제 폴더로 두세요",
  foreign: "게이트웨이 계정의 Claude 설정 폴더가 그 계정 소유의 폴더가 아니라 작업 컨테이너에 붙이지 않습니다",
};

/**
 * (순수) 컨테이너를 누구로 · 무엇을 붙여 띄우나 — 머리말 «누구로 도나». 띄울 수 없는 자리면 까닭과 함께 던진다(다시 해도 안 된다).
 *  profile = 비격리 박스 구독 작업의 Claude 설정 폴더 사실(멀티프로필이면 그 사람의 프로필 · 단일 계정이면 게이트웨이 ~/.claude) — 그 밖은 null.
 */
export function jobPlacement(f: {
  homeless: boolean; subscription: boolean;
  box: Pick<DockerBox, "isolated" | "sharedGid" | "gateway" | "jobUid">;
  member: MemberFacts | null;
  profile: ProfileFacts | null;
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
  const p = f.profile;
  if (!p) throw new Error("게이트웨이 계정의 Claude 설정 폴더를 확인하지 못했습니다");
  if (p.state !== "ok") throw new Error(GATEWAY_CLAUDE_REFUSAL[p.state]);
  return { uid: g.uid, gid: g.gid, groups: [], home: JOB_BARE_HOME, claude: { host: p.dir, target: p.dir, root: p.root, configDirEnv: true }, runsAs: "gateway" };
}

/**
 * (순수) 이 작업 컨테이너가 돌 수 있는 계정(정확히 하나) · 더할 수 있는 그룹 — 검사기 정책의 사실(자리 판정과 따로 짓는다).
 *  격리 박스: 그 작업의 OS 계정(member) — 없으면(홈 없는 작업) 전용 uid:lively-shared / 그룹은 lively-shared 만. 비격리 박스: 게이트웨이 계정 / 그룹 없음.
 *  lively-shared 가 없는 격리 박스의 홈 없는 작업은 계정이 없다(검사기가 어느 --user 도 받지 않는다 — 자리 판정이 먼저 거절한다).
 */
export function jobIdentities(box: Pick<DockerBox, "isolated" | "sharedGid" | "gateway" | "jobUid">, member: Pick<MemberFacts, "uid" | "gid"> | null): { users: string[]; groups: number[] } {
  if (!box.isolated) return { users: [`${box.gateway.uid}:${box.gateway.gid}`], groups: [] };
  const users = member ? [`${member.uid}:${member.gid}`] : box.sharedGid != null ? [`${box.jobUid}:${box.sharedGid}`] : [];
  return { users, groups: box.sharedGid != null ? [box.sharedGid] : [] };
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

/** 바인드 하나 — `--mount type=bind`(원본이 없으면 도커가 실패한다 · 쉼표 · 따옴표가 든 경로는 짓지 않는다). */
function bindMount(src: string, dst: string, readonly: boolean): string[] {
  if (/[,"]/.test(src) || /[,"]/.test(dst)) throw new JobLaunchError(`붙일 경로에 쉼표 · 따옴표가 있어 작업 컨테이너에 붙이지 않습니다: ${JSON.stringify(src.slice(0, 80))}`);
  return ["--mount", `type=bind,src=${src},dst=${dst}${readonly ? ",readonly" : ""}`];
}

/** (순수) 작업 컨테이너 인자(docker run …) — 정해진 꼴 하나(머리말 «막이»). */
export function jobContainerArgs(p: JobContainerPlan): string[] {
  const { place } = p;
  return [
    "run", "-d", "--rm", "--name", p.name,
    ...Object.entries(p.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    "--network", "host",
    "--read-only",
    "--tmpfs", `/tmp:rw,exec,nosuid,nodev,size=${JOB_TMP_MB}m,mode=1777`,
    //  HOME 은 그 사용자의 빈 tmpfs — 그 아래 Claude 설정 폴더(구독)를 붙인다(도커는 얕은 자리부터 붙인다).
    "--tmpfs", `${place.home}:rw,exec,nosuid,nodev,size=${JOB_HOME_MB}m,mode=0700,uid=${place.uid},gid=${place.gid}`,
    "--memory", `${p.memoryMb}m`, "--memory-swap", `${p.memoryMb}m`, "--pids-limit", String(JOB_PIDS), "--oom-score-adj", String(JOB_OOM_SCORE_ADJ),
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${place.uid}:${place.gid}`,
    ...place.groups.flatMap((g) => ["--group-add", String(g)]),
    "--init", "--restart", "no",
    ...bindMount(p.workHost, p.workdir, false),
    ...(place.claude ? bindMount(place.claude.host, place.claude.target, false) : []),
    ...bindMount(p.claudeBin, JOB_CLAUDE_TARGET, true),
    "--env-file", p.envFile,
    "--workdir", p.workdir, "--stop-timeout", "10",
    "--log-driver", "json-file", "--log-opt", "max-size=1m", "--log-opt", "max-file=1",
    p.image, "sh", "-c", JOB_CONTAINER_PRELUDE, "lvly-job", BOOT_SOURCE,
  ];
}

const exact = (s: string): RegExp => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/**
 * (순수) 작업 컨테이너의 검사 정책 — 인자를 지은 값이 아니라 자리의 사실로 짓는다(머리말 «막이»): 작업 폴더는 그 자리(apps · shared) 뿌리 아래의
 *  정확한 원본을 행의 작업 폴더 자리에, Claude 설정 폴더는 그 홈(프로필 뿌리) 아래의 정확한 원본 하나를, 하네스 실행 파일은 그 파일 하나를 읽기
 *  전용으로, env 파일은 작업 런타임 폴더 아래만, tmpfs(exec 포함)는 /tmp 와 HOME 만, 계정 · 그룹은 jobIdentities 의 것만.
 */
export function jobContainerPolicy(f: {
  image: string;
  work: { root: string; source: string; target: string };
  claude: { root: string; source: string; target: string } | null;
  claudeBin: string; envRoot: string; home: string; users: string[]; groups: number[];
}): DockerRunPolicy {
  if (!WORK_TARGET_RE.test(f.work.target)) throw new Error(`작업 폴더 꼴이 아닙니다: ${f.work.target.slice(0, 80)}`);
  return {
    networks: ["host"], images: [f.image], readOnly: true, publish: false,
    tmpfs: ["/tmp", f.home], tmpfsExec: ["/tmp", f.home],
    binds: [
      { root: f.work.root, rw: true, targets: exact(f.work.target), source: f.work.source },
      ...(f.claude ? [{ root: f.claude.root, rw: true, targets: exact(f.claude.target), source: f.claude.source }] : []),
      { root: f.claudeBin, rw: false, targets: exact(JOB_CLAUDE_TARGET), source: f.claudeBin },
    ],
    envFiles: [f.envRoot],
    users: f.users,
    groupAdds: f.groups,
  };
}

/** 고칠 길 — 상한을 못 걸 때 접수 실패 · 관리자 보기에 같은 글로 싣는다. */
const DOCKER_CAP_FIX = "박스의 스왑 계정(cgroup v2 · swapaccount)을 켜거나, 상한 없이 돌리려면 관리자가 agent_job_limits_set 으로 memory_max_mb 를 0 으로 바꿉니다";

/** 작업 폴더 상태 — 실제 폴더 · 링크(또는 실제 경로가 다른 자리) · 폴더 아님 · 없음(checkWork). */
export type WorkDirState = "ok" | "link" | "notdir" | "missing";

/** 도커 실행면이 쓰는 바깥 일 — 시험이 바꿔 끼운다(기본은 liveDockerDeps). */
export interface DockerLaunchDeps {
  /** 이 박스의 도커 · 하네스 사실 — 도커에 못 닿거나 하네스 실행 파일이 없으면 던진다(일시 실패 — 고치면 다음 띄우기가 된다). */
  box(): Promise<DockerBox>;
  accountUser(memberId: string): Promise<LivelyUser>;
  /** 사람 세션과 같은 OS 계정 판정(격리 박스 — 없으면 만든다). */
  ensureOsUser(user: LivelyUser): Promise<string | null>;
  /** 격리 박스 그 계정의 uid · gid · 홈 — wantClaude 면 홈의 ~/.claude 상태도 그 계정 권한으로 본다. */
  memberFacts(osUser: string, wantClaude: boolean): Promise<MemberFacts>;
  /** 비격리 박스 구독 작업의 Claude 설정 폴더 — 멀티프로필이면 그 사람의 프로필(없으면 만든다), 단일 계정이면 게이트웨이 ~/.claude(만들지 않는다). */
  profileDir(user: LivelyUser): Promise<ProfileFacts>;
  /** 박스 위 작업 폴더와 그 자리의 뿌리(profiles.resolveRootPath — osUser 가 격리 기준을 고른다). */
  resolveWork(user: LivelyUser, dir: HostJobDir, osUser: string | null): Promise<{ abs: string; base: string }>;
  /** 작업 폴더를 만든다 — 그 계정으로(격리 · 사람 작업), 게이트웨이로(홈 없는 작업 · 비격리 — 격리 박스면 lively-shared 가 쓰는 2775). */
  mkdirWork(osUser: string | null, abs: string, shared: boolean): Promise<void>;
  /** 작업 폴더가 실제 폴더이고 실제 경로가 그 뿌리 아래 그 자리인가(링크 · 바꿔치기 막기). */
  checkWork(work: { abs: string; base: string }): Promise<WorkDirState>;
  /** 작업 메모리 상한(작업 정책 memory_max_mb · 0 = 없음). */
  memoryMaxMb(): Promise<number>;
  ensureImage(image: string): Promise<void>;
  /** env 파일을 런타임 폴더에 0600 으로 쓰고 경로를 돌려준다(root = 그 폴더 — 검사기 뿌리). */
  writeEnvFile(name: string, text: string): Promise<{ file: string; root: string }>;
  removeEnvFile(file: string): Promise<void>;
  /** 검사기를 지난 인자로 컨테이너를 띄운다(docker run -d). 검사기가 거절하면 DockerRunRejected. */
  run(args: string[], policy: DockerRunPolicy): Promise<void>;
  /** 컨테이너를 지운다 — 없으면(지우는 중이면) 조용히. 그 밖은 던진다. */
  remove(name: string): Promise<void>;
  tz(): Promise<string>;
  slug(): string | null;
  port(): number;
}

const WORK_REFUSAL: Readonly<Record<Exclude<WorkDirState, "ok" | "missing">, string>> = {
  link: "작업 폴더가 링크이거나 실제 경로가 그 자리가 아니라 작업 컨테이너에 붙이지 않습니다 — 링크를 걷고 실제 폴더로 두세요",
  notdir: "작업 폴더 자리에 폴더가 아닌 것이 있어 작업 컨테이너에 붙이지 않습니다",
};

/**
 * 작업 컨테이너를 띄운다 — 도커 · 하네스 → 메모리 상한 → 자리(누구로 · 무엇을 붙이나) → 작업 폴더(만들고 · 확인) → 이미지 → env 파일 → docker run.
 *  다시 해도 안 될 것(세션 id · 홈 없는 작업의 조건 · 실행 계정 · 작업 폴더 꼴 · 상한을 걸 수 없음 · 붙일 수 없는 Claude 폴더 · 작업 폴더가 링크 ·
 *  검사기 거절)은 JobLaunchError, 인프라가 잠깐 막힌 것(도커 · OS 계정 · 작업 폴더 · 이미지 · 띄우기)은 일시 실패다(launch.stepFailure).
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
  let profile: ProfileFacts | null = null;
  if (!box.isolated && subscription && !homeless) {
    try { profile = await d.profileDir(user); } catch (e) { throw stepFailure("home", e); }
  }
  let place: JobPlacement;
  try { place = jobPlacement({ homeless, subscription, box, member, profile }); }
  catch (e) { throw new JobLaunchError(String((e as Error)?.message ?? e)); }
  let work: { abs: string; base: string };
  try { work = await d.resolveWork(user, dir, box.isolated ? (osUser ?? HOMELESS_OS_USER) : null); }
  catch (e) { throw stepFailure("workdir", e); }
  //  박스 위 자리가 행의 작업 폴더(그 앱 · 그 프로젝트)와 맞아야 한다 — 검사기 정책의 원본이 이 값이라, 형제 폴더를 고르는 잘못은 여기서만 걸린다.
  //   작업 오류(앱이 받는다)에는 박스 위 경로를 싣지 않는다 — 행의 작업 폴더로 말하고, 박스 위 자리는 게이트웨이 로그에만 남긴다.
  if (path.relative(work.base, work.abs) !== dir.sub) {
    logger.warn({ job: job.id, work: work.abs, base: work.base }, "[agent-job] 작업 폴더 자리가 행의 작업 폴더와 맞지 않는다");
    throw new JobLaunchError(`작업 폴더 자리가 행의 작업 폴더(${job.cwd})와 맞지 않습니다`);
  }
  const resolved = work;
  //  작업 폴더 확인 — 만든 뒤 한 번, docker run 바로 앞에서 한 번 더(머리말 «붙이는 원본은 링크면 안 된다»).
  const assertWork = async (): Promise<void> => {
    let st: WorkDirState;
    try { st = await d.checkWork(resolved); } catch (e) { throw stepFailure("workdir", e); }
    if (st === "ok") return;
    logger.warn({ job: job.id, work: resolved.abs, state: st }, "[agent-job] 작업 폴더를 작업 컨테이너에 붙이지 않는다");
    if (st === "missing") throw stepFailure("workdir", `작업 폴더(${job.cwd})가 만든 뒤에도 없습니다`);
    throw new JobLaunchError(`${WORK_REFUSAL[st]} (${job.cwd})`);
  };
  try { await d.mkdirWork(osUser, work.abs, box.isolated && !osUser); } catch (e) { throw stepFailure("workdir", e); }
  await assertWork();
  try { await d.ensureImage(box.image); } catch (e) { throw stepFailure("ensure", e); }
  const name = jobContainerName(sid);
  const slug = d.slug();
  let env: { file: string; root: string };
  try {
    env = await d.writeEnvFile(name, envFileText(jobContainerEnv({ jobId: job.id, bootSecret, port: d.port(), slug, tz: await d.tz(), place })));
  } catch (e) { throw stepFailure("pane", redactSecret(String((e as Error)?.message ?? e), bootSecret)); }
  const memoryMb = dockerMemoryMb(policyMb, box.memMb);
  const labels: Record<string, string> = { [JOB_CONTAINER_LABEL]: "1", [`${JOB_CONTAINER_LABEL}.id`]: String(job.id), ...(slug ? { "lvly.tenant": slug } : {}) };
  try {
    const args = jobContainerArgs({ name, image: box.image, labels, place, memoryMb, workHost: work.abs, workdir: job.cwd, claudeBin: box.claudeBin, envFile: env.file });
    //  정책의 사실 — 자리 판정(place)이 아니라 박스 · 그 계정 · 프로필 사실에서 따로 짓는다(머리말 «막이»).
    const claudeFacts = !subscription || homeless ? null
      : box.isolated ? (member ? { root: member.home, source: path.join(member.home, ".claude"), target: path.join(member.home, ".claude") } : null)
        : (profile ? { root: profile.root, source: profile.dir, target: profile.dir } : null);
    const ids = jobIdentities(box, member);
    const policy = jobContainerPolicy({
      image: box.image, work: { root: work.base, source: work.abs, target: job.cwd }, claude: claudeFacts,
      claudeBin: box.claudeBin, envRoot: env.root, home: place.home, users: ids.users, groups: ids.groups,
    });
    //  이미지 받기 · env 파일 사이에 작업 폴더 이름을 링크로 바꿔치기했을 수 있다 — 붙이기 바로 앞에서 다시 본다.
    await assertWork();
    await d.run(args, policy);
  } catch (e) {
    //  검사기 거절 · 짓지 못하는 인자는 인자를 지은 코드 탓이다 — 다시 해도 같다.
    if (e instanceof DockerRunRejected) throw new JobLaunchError(e.message);
    if (e instanceof JobLaunchError) throw e;
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
 *  이미 없다(· 지우는 중이다)는 확답은 remove 가 삼킨다. 그 밖은 던진다(부르는 쪽이 다음 감시에 다시 걷는다).
 */
export async function killDockerJob(sessionId: string, deps?: Pick<DockerLaunchDeps, "remove">): Promise<void> {
  const name = jobContainerName(sessionId);
  await (deps ?? (await liveDockerDeps())).remove(name);
}

// ── 박스 사실 · 관리자 보기 ─────────────────────────────────────────────────────

/**
 * 박스 판정 실패 — message 는 접수 501 · 관리자 보기(구성원 누구나 · 앱도 MCP 로 본다)에 싣는 글이라 박스 안 정보(경로 · 계정 이름 · 도커 원문)를
 *  싣지 않고, detail 은 게이트웨이 로그에만 남긴다. 판정 중 이것이 아닌 오류(파일 · 실행 오류 원문)는 공개 글을 BOX_UNKNOWN 으로 바꾼다(dockerBoxCheck).
 */
export class DockerBoxError extends Error {
  constructor(message: string, readonly detail: string = "") { super(message); this.name = "DockerBoxError"; }
}
const BOX_UNKNOWN = "이 박스의 도커 · 하네스 실행 파일을 확인하지 못했습니다 — 관리자가 확인해야 합니다";
const SEE_LOG = "자세한 까닭은 게이트웨이 로그의 [agent-job] 도커 실행면 줄에 있습니다";

/** 박스 판정을 기억하는 동안 — 된다는 1분, 안 된다는 15초(관리자가 고치면 곧 따라오게). 판정이 끝난 때부터 잰다. 묻는 중인 판정은 함께 받는다. */
const BOX_OK_MS = 60_000;
const BOX_NO_MS = 15_000;
type BoxCheck = { ok: true; box: DockerBox } | { ok: false; why: string };
let boxProbe: { at: number; result: BoxCheck } | null = null;
let boxInflight: Promise<BoxCheck> | null = null;
let lastLogged = "";

/** 이 박스에서 도커 실행면을 쓸 수 있나 — 기억한 판정(없으면 묻는다). o 는 시험이 바꿔 끼운다. */
export async function dockerBoxCheck(o: { probe?: () => Promise<DockerBox>; now?: () => number } = {}): Promise<BoxCheck> {
  const now = o.now ?? Date.now;
  if (boxProbe && now() - boxProbe.at < (boxProbe.result.ok ? BOX_OK_MS : BOX_NO_MS)) return boxProbe.result;
  if (boxInflight) return boxInflight;
  boxInflight = (async () => {
    const result: BoxCheck = await (o.probe ?? probeDockerBox)()
      .then((box) => ({ ok: true as const, box }))
      .catch((e) => {
        //  공개 글은 DockerBoxError 의 글만 — 그 밖의 원문(경로가 든 파일 오류 등)은 로그에만(DockerBoxError 머리말).
        const why = e instanceof DockerBoxError ? e.message : BOX_UNKNOWN;
        const detail = e instanceof DockerBoxError ? e.detail : String((e as Error)?.message ?? e);
        //  같은 까닭이 이어지면 한 번만 적는다 — 공개 글이 같아도 원문이 바뀌면(권한 → 데몬 꺼짐) 새로 적는다.
        const key = `${why}\0${detail}`;
        if (key !== lastLogged) logger.warn({ detail }, `[agent-job] 도커 실행면을 지금 쓸 수 없다 — ${why}`);
        lastLogged = key;
        return { ok: false as const, why };
      });
    if (result.ok) lastLogged = "";
    boxProbe = { at: now(), result };
    return result;
  })().finally(() => { boxInflight = null; });
  return boxInflight;
}

/** 기억한 박스 판정을 잊는다 — 다음 판정이 다시 묻는다(묻는 중인 판정은 그대로 함께 받는다). */
export function invalidateDockerBox(): void { boxProbe = null; }

/** 시험 — 박스 판정 기억 · 묻는 중 · 로그 기억을 모두 잊는다. */
export function resetDockerProbesForTest(): void { boxProbe = null; boxInflight = null; lastLogged = ""; }

/** 지금 못 띄울 때의 까닭(마지막 판정) — 접수 501 문장. */
export function dockerUnavailableMessage(): string {
  const why = boxProbe && !boxProbe.result.ok ? boxProbe.result.why : "이 박스의 도커 · 하네스 실행 파일을 아직 확인하지 못했습니다";
  return `지금은 에이전트 작업을 띄울 수 없습니다 — ${why}`;
}

/** 관리자에게 보일 도커 실행면 상태 — 누구로 도나 · 작업 메모리 상한이 실제로 걸리나(agent_job_limits surface). 띄우기와 같은 판정. */
export async function dockerSurfaceStatus(memoryMaxMb: number, o: { check?: typeof dockerBoxCheck } = {}): Promise<{ runsAs: "member" | "gateway" | null; enforced: boolean; note: string }> {
  const c = await (o.check ?? dockerBoxCheck)();
  if (!c.ok) return { runsAs: null, enforced: false, note: `지금은 작업 컨테이너를 띄울 수 없습니다 — ${c.why}. ${SEE_LOG}` };
  const runsAs = c.box.isolated ? "member" : "gateway";
  if (!(Number.isFinite(memoryMaxMb) && memoryMaxMb > 0)) {
    return { runsAs, enforced: false, note: `memory_max_mb 가 0 이라 작업 컨테이너는 도커 메모리 전체(${c.box.memMb}MB)까지 씁니다` };
  }
  if (!c.box.swapLimit) return { runsAs, enforced: false, note: `이 박스의 도커가 스왑 상한을 걸지 못해(SwapLimit=false) 이대로는 작업을 띄우지 않습니다. ${DOCKER_CAP_FIX}` };
  return { runsAs, enforced: true, note: "작업마다 컨테이너 메모리 상한(스왑 없이)으로 겁니다 — 넘으면 그 컨테이너 안에서 메모리를 가장 많이 쓰는 프로세스만 끊깁니다(작업은 그 실패를 받고 이어 간다)" };
}

// ── 살아 있는 의존 ─────────────────────────────────────────────────────────────

/** docker CLI(env LIVELY_DOCKER_BIN · 기본 PATH 의 docker — 앱 서버 실행면 DockerDriver 와 같은 값). */
const dockerBin = (): string => process.env.LIVELY_DOCKER_BIN?.trim() || "docker";

/** 실행 실패 — 끝 코드(못 띄웠으면 null)와 stderr 를 싣는다. */
class ExecError extends Error {
  constructor(message: string, readonly code: number | null, readonly stderr: string) { super(message); }
}

async function exec(bin: string, args: string[], timeoutMs: number): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = err as NodeJS.ErrnoException & { code?: unknown };
      if (e.code === "ENOENT") return reject(new ExecError(`${bin} 를 찾지 못했습니다`, null, ""));
      reject(new ExecError(`${bin} ${args[0]} 실패: ${(String(stderr ?? "").trim() || e.message).slice(0, 500)}`, typeof e.code === "number" ? e.code : null, String(stderr ?? "")));
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

const CLAUDE_FIX = "관리자가 게이트웨이 계정으로 네이티브 claude 를 깔거나(curl -fsSL https://claude.ai/install.sh | bash) LIVELY_AGENT_JOB_CLAUDE_BIN 에 리눅스 claude 실행 파일 경로를 적어야 합니다";

/** 하네스 실행 파일 — env LIVELY_AGENT_JOB_CLAUDE_BIN 이 먼저, 없으면 게이트웨이 PATH 의 claude. 실제 경로 · 리눅스 ELF · 다른 계정도 실행 가능이어야 한다. */
async function resolveClaudeBin(): Promise<string> {
  const fsp = await import("node:fs/promises");
  const named = process.env.LIVELY_AGENT_JOB_CLAUDE_BIN?.trim();
  const found = named || (await onPath("claude"));
  if (!found) throw new DockerBoxError(`작업 컨테이너에 넣을 claude 를 게이트웨이 계정에서 찾지 못했습니다 — ${CLAUDE_FIX}`, "PATH 에 claude 없음");
  const real = await fsp.realpath(found).catch(() => { throw new DockerBoxError(`작업 컨테이너에 넣을 claude 를 찾지 못했습니다 — ${CLAUDE_FIX}`, `realpath 실패: ${found}`); });
  const head = Buffer.alloc(4);
  let mode: number;
  try {
    const fh = await fsp.open(real, "r");
    try { await fh.read(head, 0, 4, 0); } finally { await fh.close(); }
    mode = (await fsp.stat(real)).mode;
  } catch (e) {
    throw new DockerBoxError("게이트웨이 계정이 claude 실행 파일을 읽지 못했습니다 — 관리자가 그 파일의 권한(게이트웨이 · 다른 계정이 읽고 실행)을 확인해야 합니다",
      `${real}: ${(e as Error)?.message ?? e}`);
  }
  if (!(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)) {
    throw new DockerBoxError(`게이트웨이 계정의 claude 가 리눅스 실행 파일(ELF)이 아닙니다(npm 설치 · 맥 실행 파일은 컨테이너에서 돌지 않는다) — ${CLAUDE_FIX}`, `ELF 아님: ${real}`);
  }
  if ((mode & 0o005) !== 0o005) {
    throw new DockerBoxError("게이트웨이 계정의 claude 를 다른 계정이 실행할 수 없습니다(권한 — 작업 컨테이너는 게이트웨이가 아닌 계정으로 돈다)", `권한: ${real}`);
  }
  return real;
}

/** 홈 없는 작업의 uid(env LIVELY_AGENT_JOB_UID · 1000 이상) — 꼴이 틀리면 기본값. */
function jobUidOf(): number {
  const raw = String(process.env.LIVELY_AGENT_JOB_UID ?? "").trim();
  const n = /^[0-9]{4,10}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 1000 && n <= 2147483647 ? n : DEFAULT_JOB_UID;
}

/** getent 한 번 — 찾음(줄) · 없음(끝 2 → null). 그 밖(못 띄움 · 다른 끝)은 던진다 — 계정 판정은 닫힌 쪽이다(모르면 «없음» 으로 읽지 않는다). */
async function getent(bin: string, db: "group" | "passwd", key: string): Promise<string | null> {
  try { return (await exec(bin, [db, key], 10_000)).trim(); }
  catch (e) {
    if (e instanceof ExecError && e.code === 2) return null;
    throw new DockerBoxError("이 박스의 계정 정보를 읽지 못했습니다", `getent ${db} ${key}: ${(e as Error)?.message ?? e}`);
  }
}

/** 이 박스의 도커 · 하네스 사실을 읽는다 — 못 쓰면 까닭과 함께 던진다(DockerBoxError). o 는 시험이 바꿔 끼운다(격리 판정 · getent). */
export async function probeDockerBox(o: { isolated?: boolean; getent?: string } = {}): Promise<DockerBox> {
  const os = await import("node:os");
  const iso = await import("../terminal/terminal-isolation.js");
  const { localImage, LOCAL_IMAGE_RE } = await import("../apps/app-server-config.js");
  const claudeBin = await resolveClaudeBin();
  const info = await exec(dockerBin(), ["info", "--format", "{{.MemTotal}} {{.SwapLimit}}"], 20_000)
    .catch((e) => { throw new DockerBoxError("이 박스의 도커에 닿지 못했습니다 — 관리자가 Docker 설치와 게이트웨이 계정의 docker 그룹을 확인해야 합니다", String((e as Error)?.message ?? e)); });
  const [mem, swap] = info.trim().split(/\s+/);
  const named = String(process.env.LIVELY_AGENT_JOB_IMAGE ?? "").trim();
  const image = named && LOCAL_IMAGE_RE.test(named) ? named : localImage();
  const isolated = o.isolated ?? iso.isolationInfraReady();
  let sharedGid: number | null = null;
  const jobUid = jobUidOf();
  if (isolated) {
    const g = await getent(o.getent ?? "getent", "group", "lively-shared");
    const gid = g ? Number(g.split(":")[2]) : NaN;
    if (!(Number.isSafeInteger(gid) && gid > 0)) throw new DockerBoxError("이 박스에 lively-shared 그룹이 없습니다 — 관리자가 구성원 격리 설치(deploy/linux/install-isolation.sh)를 다시 돌려야 합니다", g ?? "없음");
    sharedGid = gid;
    //  전용 uid 가 박스 계정과 겹치면 그 계정이 컨테이너 안을 들여다본다 — 띄우지 않는다.
    const taken = await getent(o.getent ?? "getent", "passwd", String(jobUid));
    if (taken) throw new DockerBoxError("홈 없는 작업의 uid(LIVELY_AGENT_JOB_UID)를 박스 계정이 씁니다 — 관리자가 비어 있는 번호로 바꿔야 합니다", `uid ${jobUid} = ${taken.split(":")[0]}`);
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

/** 게이트웨이가 직접 보는 Claude 설정 폴더 상태(비격리 박스 — 그 폴더는 게이트웨이 소유여야 한다). */
export async function gatewayClaudeDirState(dir: string): Promise<ClaudeDirState> {
  const fsp = await import("node:fs/promises");
  const st = await fsp.lstat(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
  if (!st) return "missing";
  if (st.isSymbolicLink()) return "link";
  return st.isDirectory() && st.uid === process.getuid?.() ? "ok" : "foreign";
}

/** 작업 폴더 상태 — 링크가 아니고, 실제 경로가 «뿌리의 실제 경로 + 그 안 자리» 와 같아야 한다(뿌리 위의 링크 · 맥 /var 는 괜찮다). */
export async function workDirState(work: { abs: string; base: string }): Promise<WorkDirState> {
  const fsp = await import("node:fs/promises");
  const st = await fsp.lstat(work.abs).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
  if (!st) return "missing";
  if (st.isSymbolicLink()) return "link";
  if (!st.isDirectory()) return "notdir";
  const rel = path.relative(work.base, work.abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "link";
  return (await fsp.realpath(work.abs)) === path.join(await fsp.realpath(work.base), rel) ? "ok" : "link";
}

/** 이미지 받기 — 박스에 없을 때만(«No such image») · 이미지마다 한 번(같은 때 여럿이 물어도 한 번 받는다). 실패하면 잊어 다음에 다시 받는다. */
const images = new Map<string, Promise<void>>();
export function ensureImageOnce(image: string): Promise<void> {
  let p = images.get(image);
  if (!p) {
    p = (async () => {
      try { await exec(dockerBin(), ["image", "inspect", "--format", "{{.Id}}", image], 20_000); }
      catch (e) {
        if (!(e instanceof ExecError) || !/No such image|not found/i.test(e.stderr || e.message)) throw e;
        await exec(dockerBin(), ["pull", "--quiet", image], 10 * 60_000);
      }
    })();
    images.set(image, p);
    p.catch(() => { if (images.get(image) === p) images.delete(image); });
  }
  return p;
}

/** 도커 실행면의 살아 있는 의존. */
export async function liveDockerDeps(): Promise<DockerLaunchDeps> {
  const launch = await import("./launch.js");
  const profiles = await import("../terminal/profiles.js");
  const mfs = await import("../terminal/terminal-member-fs.js");
  const { tenantSlug } = await import("../terminal/catalog.js");
  const { execTopology } = await import("../exec-topology.js");
  const { assertSafeDockerRun } = await import("../ops/docker-run-guard.js");
  const { stateDir } = await import("../ops/state-dir.js");
  const fs = await import("node:fs");
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const runDir = stateDir("agent-jobs", "run");
  return {
    box: async () => {
      let c = await dockerBoxCheck();
      //  기억하는 동안 하네스가 새 판으로 바뀌어 옛 실행 파일이 지워졌으면 다시 판정한다(검사기가 없는 원본을 거절해 그 작업이 영영 실패하지 않게).
      if (c.ok && !fs.existsSync(c.box.claudeBin)) { invalidateDockerBox(); c = await dockerBoxCheck(); }
      if (!c.ok) throw new Error(c.why);
      return c.box;
    },
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
      //  비격리 박스 — 사람 세션 · 1단계와 같은 자리(멀티프로필 #346 · #1014). 멀티프로필이면 그 사람의 프로필을 만들어 두고(사람 세션도 만든다),
      //   단일 계정 스위치면 게이트웨이 ~/.claude 를 만들지 않고 본다(없으면 그 계정이 로그인하지 않은 것이다 — 도커가 그 자리를 root 로 만들지 않게).
      if (process.env.LIVELY_MULTIPROFILE === "0") {
        const dir = path.join(os.homedir(), ".claude");
        return { dir, root: os.homedir(), state: await gatewayClaudeDirState(dir) };
      }
      const dir = profiles.profileConfigDir(u);
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      return { dir, root: profiles.PROFILES_ROOT, state: await gatewayClaudeDirState(dir) };
    },
    resolveWork: (u, dir, osUser) => profiles.resolveRootPath(u, dir.root, dir.sub, osUser),
    mkdirWork: async (osUser, abs, shared) => {
      if (osUser) { await mfs.memberMkdir(osUser, abs); return; }
      await fsp.mkdir(abs, { recursive: true });
      //  격리 박스의 홈 없는 작업 — 게이트웨이(lively-shared)가 만든 앱 폴더를 그룹이 쓰게(apps 자리와 같은 2775). 남이 먼저 만든 폴더는 못 바꾼다(그대로 둔다).
      if (shared) await fsp.chmod(abs, 0o2775).catch(() => undefined);
    },
    checkWork: (work) => workDirState(work),
    memoryMaxMb: async () => {
      const pol = await import("../org/policies/agent-job-policy.js");
      const store = await import("./store.js");
      return (await pol.effectiveAgentJobPolicy(async () => pol.resolveAgentJobPolicy(await store.agentJobPolicyRow()))).memory_max_mb;
    },
    ensureImage: (image) => ensureImageOnce(image),
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
        //  이미 없다 · --rm 컨테이너를 데몬이 지우는 중이다(409) — 둘 다 «걷힘» 이다.
        if (/No such container|removal of container .* is already in progress/i.test(String(e instanceof ExecError ? e.stderr || e.message : (e as Error)?.message))) return "";
        throw e;
      });
    },
    tz: async () => (await import("../org/timezone.js")).orgTimezone(),
    slug: () => tenantSlug(),
    port: () => execTopology().agentJobsPort,
  };
}
