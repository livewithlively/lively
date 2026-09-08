// 워크스페이스 회수 — **타입 있는 얇은 표면**. 구현은 `kit/cli/workspace-reclaim-core.mjs` 한 벌이다.
//
// 왜 kit 이 구현을 갖나 (#2621): 이 로직은 `fs` + `git` 만 쓰는 순수 로컬 작업인데, 게이트웨이(`src/`)에만
//  있으면 **게이트웨이 호스트의 파일시스템만** 회수할 수 있다. 개인 PC 노드의 `~/workspace/project/<id>/` 는
//  원리적으로 그 스캔 범위 밖이라(`reposIn(dir)` 의 dir 이 게이트웨이 박스의 경로다), 그 PC 로 프로젝트를
//  여럿 돌리면 디스크가 조용히 찼다 — 회수는 «레포가 없습니다» 라고 답하고 사람이 손으로 찾아 지웠다.
//  → 구현을 kit 으로 옮겼다. 게이트웨이(이 파일)와 로컬 CLI(`lively reclaim`)가 **같은 코드**를 각자의
//    컨텍스트로 부른다. **삭제 규칙(DERIVED/PROTECTED/classify)이 두 벌로 갈라지지 않는 것이 핵심이다** —
//    한쪽만 고쳐지면 어느 한 표면이 조용히 위험해진다.
//
// 삭제 규칙·안전선의 근거(왜 gitignored∩allow-list 여야 하는지, 왜 심링크를 건드리지 않는지, 왜 워크트리
//  제거가 '푸시 완료 + 클린' 일 때만인지)는 전부 그 코어 파일의 머리주석에 있다. 여기 중복해 적지 않는다.
//
// ⚠ 이 파일이 코어를 `await import()` 로 로드하므로 **ESM 모듈 캐시**에 걸린다 — 코어를 고치면 게이트웨이를
//  재시작해야 반영된다. `scripts/serve-sync.sh` 가 `kit/` 변경에 재시작하도록 돼 있어 dev 에선 자동이다(#2621).
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../log.js";

export type EntryKind = "derived" | "unclassified" | "protected";

export interface ReclaimEntry {
  /** 워크트리 기준 상대 경로(모노레포면 `packages/a/node_modules` 처럼 중첩). */
  rel: string;
  kind: EntryKind;
  bytes: number;
  partial: boolean; // 크기 측정이 시간 예산에 걸렸는지
  /** 심링크인가 — 회수 대상에서 제외한다(코어의 §심링크 참조). */
  symlink?: boolean;
}

export interface WorktreeCheck {
  removable: boolean;
  /** removable=false 인 이유(사람이 읽는 문장). */
  reason: string | null;
  dirty: boolean;
  /** 어떤 remote-tracking ref 에서도 안 닿는 커밋 수 (-1 = 세지 못했다 → 안전측으로 거부). */
  unpushed: number;
  branch: string | null;
}

export interface ReclaimPlan {
  worktree: string;
  entries: ReclaimEntry[];
  /** 실제로 지울 것들의 합계(kind=derived 만). */
  reclaimableBytes: number;
  worktree_check: WorktreeCheck;
  /** 이 워크트리에 살아있는 세션이 붙어 있다 → 아무것도 회수하지 않는다(빌드 중일 수 있다). */
  active_session: boolean;
}

export interface ReclaimResult {
  removed: string[];
  freedBytes: number;
  worktreeRemoved: boolean;
  /** 워크트리를 못 지웠으면 그 이유(사용자에게 그대로 보여준다). */
  worktreeSkippedReason: string | null;
}

/** 실행기가 필요 없는 것들(순수 · fs 전용) — 코어가 top-level 로 내준다. */
interface ReclaimPure {
  DERIVED_NAMES: string[];
  PROTECTED_NAMES: string[];
  isInside(child: string, parent: string): boolean;
  dirSize(root: string, budgetMs?: number): Promise<{ bytes: number; partial: boolean }>;
  reposIn(dir: string): Promise<string[]>;
  createReclaim(deps: {
    exec: (file: string, args: string[], opts?: object) => Promise<{ stdout: string }>;
    logger?: { warn: (o: unknown, m: string) => void; info: (o: unknown, m: string) => void };
  }): ReclaimOps;
}

/** 외부 프로세스(git·du)를 쓰는 것들 — 주입된 실행기 위에서 동작한다. */
interface ReclaimOps {
  dirSizeFast(p: string, timeoutMs?: number): Promise<number | null>;
  dirSizesFast(paths: string[], timeoutMs?: number): Promise<Map<string, number | null>>;
  baseRepoOf(wt: string): Promise<string | undefined>;
  checkWorktree(wt: string): Promise<WorktreeCheck>;
  planReclaim(wt: string, opts?: { sizeBudgetMs?: number; activeSessionDirs?: string[] }): Promise<ReclaimPlan>;
  applyReclaim(plan: ReclaimPlan, opts?: { removeWorktree?: boolean; repoRoot?: string }): Promise<ReclaimResult>;
}

// 코어 위치 — 병합 후 kit 은 게이트웨이 레포 안(`<root>/kit`)이다. `WORKFLOW_STD_DIR` 오버라이드는
//  `publish.ts` 의 generator 로딩과 같은 규약(분리 배포·테스트에서 kit 트리를 딴 곳에 두는 경우).
const coreUrl = process.env.WORKFLOW_STD_DIR
  ? pathToFileURL(join(process.env.WORKFLOW_STD_DIR, "cli", "workspace-reclaim-core.mjs")).href
  : new URL("../../kit/cli/workspace-reclaim-core.mjs", import.meta.url).href;

// top-level await — 코어는 node 내장만 import 하는 zero-dep 모듈이라 순환도 없고 로드가 즉시 끝난다.
//  (동기 export 가 필요한 소비자가 있다: `delivery/workspace.ts` 가 `isInside` 를 배열 콜백 안에서 쓴다.)
const core = (await import(coreUrl)) as ReclaimPure;
// 게이트웨이의 실행기 — 코어는 외부 프로세스를 직접 쥐지 않는다(kit R5). 로거도 여기서 꽂는다.
const ops = core.createReclaim({ exec: promisify(execFile), logger });

export const DERIVED_NAMES: readonly string[] = core.DERIVED_NAMES;
export const PROTECTED_NAMES: readonly string[] = core.PROTECTED_NAMES;

/** 세션의 작업 디렉터리가 이 워크트리 안(또는 자신)인가. 경로 접두사 비교의 흔한 함정(`/a/b` vs `/a/bc`)을 피한다. */
export const isInside = core.isInside;
export const dirSize = core.dirSize;
export const reposIn = core.reposIn;

export const dirSizeFast = ops.dirSizeFast;
export const dirSizesFast = ops.dirSizesFast;
export const baseRepoOf = ops.baseRepoOf;
export const checkWorktree = ops.checkWorktree;
export const planReclaim = ops.planReclaim;
export const applyReclaim = ops.applyReclaim;
