// 중앙 박스 — 큐레이트 설정 카탈로그(허용 루트·하네스 플래그·세션 타입). terminal-sessions.ts 분할(#1313 R15).
//  순수 상수·타입·무의존 순수함수만 둔다(다른 terminal 모듈이 전부 이 파일을 딛고 선다 — 역방향 import 금지).
import path from "node:path";
import os from "node:os";

// 게이트웨이가 launchd/nohup 로 떠 PATH 에 brew 가 없을 수 있어 절대경로 우선(env 오버라이드 가능).
export const TMUX_BIN = process.env.TMUX_BIN || "/opt/homebrew/bin/tmux";

// pane(세션 안 shell/Claude) 로케일 — 한글(멀티바이트·더블폭) 편집 정상화(#633). ⚠ TMUX_ENV(tmux-exec.ts)는 tmux **CLI**
//  호출에만 UTF-8 을 준다 — 그 값은 pane 까지 전달되지 않는다. tmux 는 LANG/LC_* 를 update-environment 기본
//  목록에 넣지 않아, pane 프로세스는 **tmux 서버**의 env 를 상속하는데 서버가 launchd/nohup 로 LANG 없이 뜨면
//  pane 이 C/POSIX 로케일이 된다(실측: 라이브 box- 세션의 claude/zsh pane 은 LANG/LC_* 가 전혀 없음 = C).
//  C 로케일에선 zsh/readline 이 한글을 바이트폭으로 오산(글자당 1이 아닌 3열 등)해, 평범한 타이핑은 멀쩡해 보여도
//  단어이동(Option+←/→ = Meta-b/f)·중간삽입 시 커서 열이 어긋나 줄이 뒤섞이고 같은 글자가 반복 입력된다(#633).
//  → new-session 에 **세션스코프 -e** 로 UTF-8 로케일을 pane 에 직접 주입한다(전역/타세션 누수 없음 — 기존
//  -e CLAUDE_CONFIG_DIR 패턴과 동일). 값: 게이트웨이 env 의 UTF-8 로케일을 재사용(호스트에 실재하는 유효값),
//  없으면 플랫폼 기본 — macOS=en_US.UTF-8, Linux=C.UTF-8(glibc 에 항상 존재. en_US.UTF-8 은 미생성일 수 있음).
//  (⚠ 이미 떠 있는 pane 의 env 는 exec 시점에 고정 → 이 수정은 **새 세션**에만 적용. 옛 세션은 재생성 시 정상화.)
export const PANE_LOCALE: string = (() => {
  const cur = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  if (/utf-?8/i.test(cur)) return cur;
  return process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
})();

// ── 큐레이트 허용 루트 ──
export interface Root { key: string; label: string; base: string; perUser?: boolean; }
export const ROOTS: Root[] = [
  { key: "shared", label: "공유 워크스페이스", base: process.env.TERMINAL_ROOT_SHARED || path.join(os.homedir(), "workspace") },  // 폴백 = deploy 관례($HOME/workspace)
  { key: "personal", label: "개인 폴더", base: process.env.TERMINAL_ROOT_PERSONAL || path.join(os.homedir(), "box"), perUser: true },
];

// 공유 워크스페이스 루트 — 공유 빌드 캐시(#813)가 이 아래 `.cache` 로 산다.
//  그 디렉터리의 그룹·setgid 권한을 물려받아야 멤버별 격리 OS 유저(#524)들이 캐시를 함께 쓸 수 있다.
export const SHARED_ROOT: Root = ROOTS.find((r) => r.key === "shared") ?? ROOTS[0];

// ── 하네스 플래그 카탈로그(보수적 화이트리스트) ──
export interface FlagDef { name: string; label: string; desc: string; type: "select" | "bool" | "text"; choices?: string[]; default?: string; }
export interface Harness { key: string; label: string; bin: string; autoApproveFlag?: string; flags: FlagDef[]; }
export const HARNESSES: Harness[] = [
  {
    key: "claude", label: "Claude Code", bin: "claude",
    autoApproveFlag: "--dangerously-skip-permissions",
    flags: [
      { name: "--model", label: "모델", desc: "비우면 기본 모델", type: "select", choices: ["", "opus", "sonnet", "haiku"] },
      { name: "--effort", label: "effort(추론 강도)", desc: "비우면 기본. 판단 무거운 작업(부트스트랩·분류)은 high+ 권장", type: "select", choices: ["", "low", "medium", "high", "xhigh", "max"] },
    ],
  },
  {
    key: "codex", label: "Codex", bin: "codex",
    autoApproveFlag: "--yolo",
    flags: [{ name: "--model", label: "모델", desc: "비우면 기본 모델(gpt-5.5)", type: "select", choices: ["", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] }],
  },
  { key: "shell", label: "셸 (에이전트 없음)", bin: "", flags: [] },
];

export interface SessionInfo {
  id: string; label: string; harness: string; dir: string; autoApprove: boolean;
  owner: string; owned: boolean; created: number; attached: boolean;
  invites: string[]; // 초대된 멤버 id(@box_invites). 빈 배열 = 비공개(소유자만 보기·열기).
  flags: Record<string, string>; // 생성 시 적용된 하네스 플래그(@box_flags, 예: {"--model":"opus"}). 수정 팝업의 비활성 표시용.
  projectId?: number; // 프로젝트 세션이면 그 프로젝트 id(@box_project). 보드의 '내 세션' 칼럼 활성 판단용.
  // 에이전트 실행 상태(#1015 E 에서 '오프라인' 한 칸에 섞여 있던 '셸로 빠짐'을 exited 로 분리):
  //  busy=스피너 관측(작업중) · waiting=화면에 사용자 선택/승인 대기(확인 필요) — 이 둘은 **접속 무관**.
  //   탭을 닫아도 AI 는 계속 일하고, waiting 은 사용자 결정을 기다리는 알림이라 회색으로 덮으면 놓친다.
  //  idle=탭에 열려 있고(attached>0) 안 바쁨 = '대기 중'
  //  offline=탭에 안 열려 있음(attached==0) 또는 원격 노드에 못 닿음(node/registry.ts 가 강제) = '오프라인'
  //   ⚠ busy·waiting 도 탭이 없으면 offline 이다(탭=온라인 규칙, 2026-07-23 상민님 확정). 탭이 붙어 있을 때만
  //    작업중·확인필요를 색으로 구분한다.
  //  exited=**AI 하네스가 끝나** 포그라운드가 셸(claude 로 만든 세션인데 AI 가 더 안 돈다 → 정리 대상)
  //  shell=**애초에 AI 없는 터미널 세션**(harness=shell). exited 와 뜻이 완전히 다르다 — 이건 그 세션의 정상
  //   상태이고 세션은 멀쩡히 살아 있다. 종전엔 둘을 함께 exited 로 줘서 카드가 '종료됨'으로 떴고, **살아 있는
  //   셸 세션이 죽은 것처럼** 보였다(고객사 A 실측: '종료됨' 3건이 전부 셸 세션이었다). #1059 감사 P1-①.
  agentState?: "busy" | "waiting" | "idle" | "exited" | "offline" | "shell";
  // #1059 — **접속 여부와 무관한 '지금 뭔가 돌고 있다'** 신호. agentState 는 attached==0 이면 busy 여도 offline 이
  //  되므로(탭=온라인 규칙), 그 값만 보면 **아무도 안 붙은 채 크론이 도는 세션을 '작업 중'으로 못 본다.**
  //  회수(F)의 '작업 중 제외' 판정은 이 값을 써야 한다 — 안 그러면 도는 세션이 회수된다.
  //  claude: 하네스 보고(#1221) 또는 pane 제목 스피너 관측 · 셸: pane 포그라운드가 셸이 아님(빌드·lively run 등).
  working?: boolean;
  // #1221 — **접속 여부와 무관한 '사람의 결정을 기다린다'** 신호. working 의 형제다. agentState 는 탭이 없으면
  //  waiting 을 offline 으로 덮어 회수(F)가 그 세션을 '아무 일도 없는 것'으로 본다 → **승인 대기 중인 세션을 죽여
  //  결정을 잃는다**(working 을 도입할 때 busy 만 구제하고 waiting 은 남겨 둔 구멍). 표시는 종전대로 탭이 있을 때만
  //  '확인 필요'로 색을 주고, 이 값은 회수 판정에만 쓴다.
  awaiting?: boolean;
  // 실시간 작업 요약(#req) — Claude Code 가 pane_title 에 써두는 '지금 하는 일' 요약(상태 글리프 제거). 없으면 빈 문자열 → 프론트가 label 로 폴백.
  title?: string;
  // 마지막 '작업(busy)' 시각(epoch초) — 클로드가 마지막으로 턴을 돌리고 있던(또는 끝낸) 때. 정렬·카드 시간 표시용.
  //  ⚠ '내가 열어본(브라우저 접속)' 시각은 섞지 않는다(#853) — 열어보기는 작업이 아니다.
  //  @box_last_busy(tmux 세션 옵션)로 영속 → 게이트웨이가 재기동해도 유지(tmux 서버가 더 오래 산다).
  lastActive?: number;
  // #1098 — 마지막으로 이 세션에 **탭이 붙은** 시각(epoch초, tmux `session_last_attached`). 한 번도 안 붙었으면 0.
  //  lastActive(마지막 작업) 와 비교해 '내가 시킨 작업이 끝났는데 아직 안 본' 세션을 프론트가 판정한다
  //  (lastActive > lastAttached = 마지막 열람 이후에 작업이 끝남). 값 자체는 예전부터 tmux 가 주고 있었는데 버리고 있었다.
  lastAttached?: number;
  // #1059 E — 복원 가능(restorable): tmux 에 없고 DB desired-state(org_session_state)에만 있는 세션(재부팅으로 죽었거나
  //  F reaper 가 회수). agentState 는 offline. 프론트가 이 배지를 보고 '열기=복원'(POST …/restore) 경로로 분기한다(attach 아님).
  restorable?: boolean;
  // #1059 — restorable 이 **사용자 정상 종료**(/exit·logout, SessionEnd 훅 보고)로 생겼나. true=내가 종료('종료됨·대화 이어보기'),
  //  false=재부팅·강제kill·reaper 회수('복원 가능·중단됨'). 프론트가 라벨·버튼을 구분(둘 다 복원 경로는 동일).
  exitedByUser?: boolean;
  // #1251 — **earlyoom(OS 보호장치)이 죽인** 세션. exitedByUser 와 배타다(사용자가 끝낸 게 아니라 당한 것).
  //  이걸 구분해 주지 않으면 사용자는 자기 세션이 왜 사라졌는지 모른 채 재부팅·자동회수와 같은 '중단됨'으로만 본다.
  //  ⚠ 관측 기반 **추정**이라, 확신이 서지 않으면 아예 안 붙인다(box-watch 의 매핑 조건 참조).
  oomKilled?: boolean;
}
export interface CreateInput { label: string; rootKey: string; subpath: string; harness: string; flags: Record<string, unknown>; autoApprove: boolean; invites?: unknown; projectId?: number; projectSrc?: "v6" | "org"; loginProfile?: boolean; resume?: string; readOnly?: boolean; incognito?: boolean;
  // #1291 v2 — 기록 범위(write cap)와 read 축소. 미지정이면 실행 폴더에서 파생한다(신규·복원이 같은 규칙).
  //  writeVis: 'open'|'audience'|'private' — 이 세션이 **사용자 승인 없이** 만들 수 있는 맥락의 최대 가시성.
  //  restrictRead: 프로젝트 세션을 owner∪invites 로 더 좁힌다(프로젝트 대상 안에서만 축소 가능).
  writeVis?: string;
  restrictRead?: boolean;
  // #1059 E — 상시(managed) 세션은 desired-state DB 미러를 만들지 않는다(keep-alive 가 그 영속을 소유). ensureManagedSession 만 넘긴다.
  managed?: boolean;
  // #1059 — claude UUID 를 모를 때 인자 없는 --resume 로 후보 picker 를 띄운다(restorable 복원. resume 과 배타 — resume 우선).
  resumePick?: boolean; }

// 실행 모드(#1007+) → 격리 pane 에 실을 `-e` env 인자. 순수 함수라 단위테스트로 계약을 못박는다(terminal-sessions.test.ts).
//  incognito 는 readonly 보다 강함(lively 전체 차단 + LIVELY_OFF 로 훅까지 off). 둘 다면 incognito.
//  ⚠ **전이기 dual-env**: 새 LIVELY_MODE(주 신호) + 구 LIVELY_READONLY/LIVELY_INCOGNITO 를 함께 실어, x-lively-mode 헤더가 아직
//   전파 안 된 설치(구 boolean 헤더만, self-update 1세션 지연)에서도 격리가 fail-open 되지 않게. 전파 완료 후 #1021 에서 구 env 제거.
export function modeEnvArgs(input: { readOnly?: boolean; incognito?: boolean }): string[] {
  if (input.incognito) return ["-e", "LIVELY_MODE=incognito", "-e", "LIVELY_INCOGNITO=1", "-e", "LIVELY_OFF=1"];
  if (input.readOnly) return ["-e", "LIVELY_MODE=readonly", "-e", "LIVELY_READONLY=1"];
  return [];
}
