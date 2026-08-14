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
export interface Harness {
  key: string; label: string; bin: string; autoApproveFlag?: string; flags: FlagDef[];
  // #1516 런처 안내의 하네스별 부분(harnessFailNotice 가 읽는다 — 문구를 그 함수에 하드코딩하지 않는다).
  //  · loginCmd: 비정상 종료의 주원인이 '자격 만료'이고 **셸에서 한 줄로** 복구되는 하네스(codex)만. 있으면
  //    안내가 재시작 대신 이 명령을 준다.
  //  · failHint: 재시작 안내(`<bin>` 입력) 뒤에 덧붙일 줄들. 하네스마다 로그인 절차가 달라서 있는 값.
  loginCmd?: string;
  failHint?: string[];
}
export const HARNESSES: Harness[] = [
  {
    key: "claude", label: "Claude Code", bin: "claude",
    autoApproveFlag: "--dangerously-skip-permissions",
    flags: [
      // desc 는 폼에서 드롭다운 아래 회색 캡션으로 붙는다 — '비우면 기본' 류는 빈 값 옵션 라벨('(자동)')이 이미 말하므로 두지 않는다(#1145).
      { name: "--model", label: "모델", desc: "", type: "select", choices: ["", "opus", "sonnet", "haiku"] },
      { name: "--effort", label: "추론강도(effort)", desc: "무거운 작업(부트스트랩·분류 등)은 xhigh 권장", type: "select", choices: ["", "low", "medium", "high", "xhigh", "max"] },
    ],
    failHint: ["로그인이 필요하다고 나오면 claude 를 실행한 뒤 /login 을 입력하세요."],
  },
  {
    key: "codex", label: "Codex", bin: "codex",
    autoApproveFlag: "--yolo",
    // default 는 **표기용**이다(#1145) — 빈 값 옵션을 '(자동 · gpt-5.5)' 로 보여줄 뿐, 이 값을 argv 로 넘기지는 않는다.
    //  넘기는 순간 그 모델에 고정돼, codex 가 기본을 올려도 여기 적힌 낡은 문자열에 사용자가 묶인다.
    flags: [{ name: "--model", label: "모델", desc: "", type: "select", choices: ["", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"], default: "gpt-5.5" }],
    loginCmd: "codex logout && codex login --device-auth",
  },
  {
    // #1519 로 배선(훅·MCP·자산)은 이미 붙어 있는데 **웹 세션 카탈로그에만** 빠져 있던 자리(#1695).
    //  모델은 `provider/model` 형식이라 화이트리스트로 못 박기 어렵다(제공자마다 다름) → 여기선 안 받는다.
    //  opencode 안에서 고르면 되고, 반쯤 맞는 목록을 주는 것보다 안 주는 게 정직하다.
    key: "opencode", label: "OpenCode", bin: "opencode",
    autoApproveFlag: "--auto",   // 실측(1.18.x --help): 명시 deny 가 아닌 권한을 자동 승인
    flags: [],
    // 셸에서 그대로 치는 명령은 **명령 줄**로 준다(복사해 붙여넣게) — claude 의 /login 은 TUI 안 입력이라 문장으로 둔다.
    failHint: ["로그인이 필요하다고 나오면 아래를 입력해 제공자를 고르세요:", "", "    opencode auth login"],
  },
  {
    // #1689 로 배선 완료 → 이 카탈로그가 웹 세션(AI 세션 탭·프로젝트 화면)의 마지막 조각이다(#1695).
    //  bin 은 key 와 다르다(agy). 안내·재시작 문구를 key 로 만들면 없는 명령을 안내하게 된다(harnessFailNotice 참조).
    key: "antigravity", label: "Antigravity", bin: "agy",
    autoApproveFlag: "--dangerously-skip-permissions",   // 실측(agy 1.1.13 --help)
    // 모델은 `agy models` 실측 목록에서 **현행 대표만** 큐레이트한다(구세대 flash 3.5/3.6 은 뺀다).
    //  codex 와 같은 이유로 빈 값(=하네스 기본)을 기본으로 두어 낡은 문자열에 사용자를 묶지 않는다.
    flags: [
      { name: "--model", label: "모델", desc: "", type: "select", choices: ["", "gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low", "claude-opus-4-6-thinking", "claude-sonnet-4-6", "gpt-oss-120b-medium"] },
      { name: "--effort", label: "추론강도(effort)", desc: "", type: "select", choices: ["", "low", "medium", "high"] },   // claude 와 달리 3단계(실측)
    ],
    failHint: ["로그인이 필요하다고 나오면 화면에 뜨는 주소를 브라우저에서 열고, 함께 표시되는 코드를 입력하세요."],
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
  resumePick?: boolean;
  // #1516 — 로그인 전용 세션: 이 하네스의 **로그인 명령**을 셸에서 돌린다(하네스 TUI 를 띄우지 않는다).
  //  자격이 만료된 상태에서 그 하네스로 세션을 열면 즉사해 로그인 자체가 불가능하기 때문(harnessLoginArgv 주석).
  //  harness 는 'shell' 로 보낸다 — 이 세션은 AI 세션이 아니라 로그인 절차용이다.
  loginFor?: string; }

// ── 세션 런처(#1516) — 하네스가 죽어도 세션은 산다 ──
//
// 결함: 세션은 `tmux new-session -d -s <id> … <하네스 바이너리>` 로 뜬다(격리 경로의 box-spawn 도 `exec "$@"`).
//  하네스가 **그 pane 의 유일한 프로세스**라 하네스가 종료되면 pane→window→**tmux 세션이 통째로 사라진다.**
//  claude 는 미인증이어도 TUI 로 로그인 화면을 띄워 세션이 살아 있지만(실측), codex 는 인증이 만료되면
//   `Error: Your access token could not be refreshed because your refresh token was already used.` 를
//   stderr 로 한 줄 뱉고 **exit 1** 로 즉사한다 → 사용자는 그 문구를 읽을 기회조차 없이 세션이 닫히고,
//   무엇을 해야 하는지도 알 수 없다(2026-08-04 상민님 신고 · 실측 재현).
//  ⚠ 서버가 미리 막을 수는 없다: `codex login status` 도 `codex doctor` 도 **만료된 토큰을 정상으로 보고**한다
//   (실측 — 각각 "Logged in using ChatGPT" exit 0 / "✓ auth is configured"). 실제 갱신을 시도해야만 알 수 있다.
//   그래서 사전 판정이 아니라 **사후 회복**(세션 보존 + 사람 말 안내)이 유일하게 옳은 자리다.
//
// 그래서 하네스를 이 런처로 감싼다:
//  · exit 0(사용자가 /exit 로 정상 종료) → **종전 그대로** 세션 종료(#1059 restorable 설계 보존 — 여기서
//    셸을 남기면 정상 종료가 '종료됨'으로 안 잡히고 회수·복원 흐름이 통째로 어긋난다).
//  · exit≠0(비정상) → 한국어 안내를 찍고 **로그인 셸로 폴백** → 세션이 살아남아 원문 에러가 화면에 그대로 남고,
//    사람이 그 자리에서 로그인·재실행을 할 수 있다. pane 포그라운드가 셸이 되므로 isAgentOffline(phase.ts)이
//    'exited'(종료됨)로 정확히 판정한다 — 기존 상태 모델과 정합.
//
// ⚠ 인젝션 안전: 스크립트는 **고정 문자열**이고 하네스·플래그는 `sh -c '<고정>' <argv0> <안내> "$@"` 의
//  위치인자로만 들어간다(셸이 값을 해석하지 않는다). 문자열 보간으로 명령을 조립하지 말 것.
//
// ⚠⚠ `set -m`(job control) 은 취향이 아니라 이 런처의 **정확성 요건**이다 (#1535, 2026-08-05 실측).
//  래퍼를 씌운다는 것은 pane 에 프로세스를 하나 더 만든다는 뜻이고, job control 이 없으면 그 래퍼가
//  **pane tty 의 foreground 프로세스 그룹 리더로 눌러앉는다**. 그러면 하네스가 멀쩡히 돌고 있는데도
//  tmux 의 `#{pane_current_command}` 가 **`bash`** 로 나온다(macOS `/bin/sh` 의 실체가 bash).
//   실측 대조 — 같은 하네스를 같은 tmux 에 띄우고 pane_current_command 만 본 결과:
//     래퍼 없음(#1516 이전) → `2.1.220`(하네스) · 래퍼만 → `bash` · 래퍼+`set -m` → `2.1.220`
//  그 한 값이 아래 두 판정의 **유일한 입력**이라 둘 다 조용히 뒤집혔다:
//   · 웹터미널 stale 마우스 게이팅([[webterm-stale-mouse-mode-gating]] #1302) — '포그라운드가 셸이면 그
//     마우스 flag 는 죽은 앱의 잔재'로 오판 → 살아있는 앱의 마우스모드를 끄고(alt-screen 에서 휠이 화살표
//     키로 폴백 = #1535 사용자 신고 증상) `{t:'mr'}` 로 pane tty 에 DECRST 까지 써서 **tmux 가 아는
//     진실마저 파괴**했다. #1302 는 "Bash 툴 호출 중에도 foreground 는 안 바뀐다"를 실측 전제로 삼았는데,
//     #1516 의 래퍼가 그 전제를 깼다 — 게이팅의 잘못이 아니라 입력이 오염된 것이다.
//   · isAgentOffline(phase.ts) — SHELL_CMDS 에 `bash` 가 있으므로 살아있는 하네스가 '종료됨'으로 표시됐다.
//  `set -m` 이면 셸이 각 job 을 **새 프로세스 그룹**에 넣고 foreground job 에 tty 를 넘긴다 → 하네스가
//  자기 pgrp 리더 + tty foreground 가 되어 tmux 가 다시 하네스를 본다. 하네스가 끝나면 셸이 foreground 를
//  되찾으므로 위 두 판정은 **그때** 정확히 참이 된다 — 이 런처가 원래 의도한 정합 그대로다.
//  (비대화형 셸이라 job control 상태 메시지는 pane 에 찍히지 않는다 — 실측 확인.)
const LAUNCH_SH = [
  'set -m',
  'notice=$1; shift',
  '"$@"',
  'rc=$?',
  '[ "$rc" -eq 0 ] && exit 0',
  'printf \'\\n%s\\n\' "$notice"',
  'exec "${SHELL:-/bin/sh}" -il',
].join("\n");

// 비정상 종료 안내 — **비개발자가 그대로 따라 할 수 있는 한 줄**을 준다(원문 영문 에러는 위에 그대로 남는다).
//  codex 로그인은 `--device-auth` 가 정답이다: 웹터미널은 본질적으로 원격이라 기본 플로우가 띄우는
//  `http://localhost:1455`(서버의 localhost) 에 사용자 브라우저가 닿지 못한다. device-auth 는 주소+일회용 코드라
//  어느 브라우저에서든 된다(실측). 만료 케이스는 logout 이 선행돼야 한다 — codex 안내문("Please log out and
//  sign in again")과 같은 처방.
//
// ⚠ 문구는 **표(HARNESSES)에서 파생**한다(#1695). 종전엔 codex·claude 문장을 이 함수에 하드코딩하고 나머지는
//  `${harnessKey}` 로 폴백했는데, 그 폴백은 **key 를 실행 명령으로 안내**한다 — antigravity 는 bin 이 `agy` 라
//  "antigravity 를 입력하면 다시 시작합니다"가 되어 **없는 명령**을 시킨다(command not found → 사용자는 두 번 막힌다).
//  라벨 뒤 조사(이/가)도 라벨마다 갈리므로 문장을 `<라벨> — <서술>` 로 두어 하네스가 늘어도 한국어가 안 깨지게 한다.
export function harnessFailNotice(harnessKey: string): string {
  const line = "─".repeat(60);
  const h = HARNESSES.find((x) => x.key === harnessKey);
  const label = h?.label || harnessKey;
  const bin = h?.bin || harnessKey;   // 모르는 하네스·실행 파일이 빈 하네스면 key 로 폴백(빈 명령 줄을 안내하지 않는다)
  const body = h?.loginCmd
    ? [
      // 자격 만료가 주원인이고 셸 한 줄로 복구되는 하네스(codex) — 재시작보다 로그인이 먼저다.
      `${label} — 시작하지 못하고 종료됐습니다. 위 영문 메시지가 원인입니다.`,
      "",
      "로그인이 만료됐을 때 가장 흔합니다. 아래 한 줄을 복사해 붙여넣고 Enter 를 누르세요:",
      "",
      `    ${h.loginCmd}`,
      "",
      "화면에 주소와 일회용 코드가 나옵니다 → 브라우저에서 그 주소를 열고 코드를 입력하면 로그인이 끝납니다.",
      `로그인한 뒤  ${bin}  를 입력하면 이 세션에서 그대로 이어서 쓸 수 있습니다.`,
    ]
    : [
      `${label} — 예기치 않게 종료됐습니다. 위 메시지가 원인입니다.`,
      "",
      "이 세션은 살아 있습니다. 아래를 입력하면 다시 시작합니다:",
      "",
      `    ${bin}`,
      ...(h?.failHint?.length ? ["", ...h.failHint] : []),
    ];
  // 세션이 살아 있다는 사실 자체가 안내의 절반이다 — 종전엔 창이 사라져 사용자가 '내가 뭘 잘못했나'로 끝났다.
  return [line, ...body, line].join("\n");
}

// 하네스 실행 argv → 런처로 감싼 argv. cmd 가 비면(셸 세션) 감싸지 않는다 — 감쌀 하네스가 없다.
//
// ⚠ Windows(psmux 노드)에서는 감싸지 않는다 (#1541 실측). 이 런처는 **POSIX 셸 스크립트**인데
//  Windows 노드의 pane 셸은 PowerShell 이라 그 스크립트가 그대로 파싱된다 → 하네스는 시작조차 못 하고
//  세션이 즉사한다. 사용자가 본 화면 그대로:
//    위치 줄:5 문자:2  + [ "$rc" -eq 0 ] && exit 0
//    '[' 뒤에 형식 이름이 없습니다. / '&&' 토큰은 이 버전에서 올바른 문 구분 기호가 아닙니다.
//  감싸지 않으면 하네스가 **직접** 뜬다(정상 동작 회복). 대신 #1516 의 사후회복(하네스가 비정상 종료해도
//  세션은 셸로 남는다)이 Windows 에선 없다 — 그건 알려진 갭이고, PowerShell 판 런처는 별도로 만들어야 한다.
//  ⚠ 여기서 문자열 보간으로 PowerShell 스크립트를 조립하지 말 것: 이 자리는 하네스·플래그가 위치인자로만
//   들어가야 하는 인젝션 경계다(위 LAUNCH_SH 주석). 검증 없이 급조한 래퍼를 끼우는 것보다 안 감싸는 게 낫다.
export function harnessLaunchArgv(harnessKey: string, cmd: string[], platform: string = process.platform): string[] {
  if (!cmd.length) return cmd;
  if (platform === "win32") return cmd;
  return ["sh", "-c", LAUNCH_SH, "lively-launch", harnessFailNotice(harnessKey), ...cmd];
}

// 로그인 전용 세션(#1516) — 관리탭 [연결된 AI 계정]의 [로그인]이 여는 세션.
//  종전엔 `harness: codex` 세션을 열었는데, **자격이 만료된 바로 그 상태에서는 그 세션도 즉사**해서
//  로그인하려고 연 세션이 로그인 화면을 못 보여주는 데드락이었다. 로그인은 하네스 TUI 가 아니라
//  **셸에서 로그인 명령을 직접** 돌려야 한다.
//  codex: logout(만료 자격 제거) → device-auth 로그인 → 끝나면 셸로 남아 바로 `codex` 를 칠 수 있다.
//  claude: 로그인이 TUI 안 슬래시 커맨드(/login)라 자동화할 수 없다 → null(종전대로 claude 세션을 연다).
//  ⚠ 나머지 하네스도 **지금은 전부 null 이 정답**이다(#1695 실측). 여기 채우려면 '무인으로 한 줄' 이어야 하는데:
//   · antigravity(agy): 로그인 서브커맨드 자체가 없다(agy 1.1.13 --help — install·update·plugin·models·agent·changelog뿐).
//     인증은 하네스를 켜면 하네스가 띄운다(원격이면 주소+코드). 그래서 '로그인 전용 세션'을 만들 대상이 아니고,
//     대신 하네스가 죽었을 때의 안내(failHint)로 그 절차를 알려 준다.
//   · opencode: `opencode auth login` 이 있으나 **제공자를 고르는 대화형 TUI** 라 codex 의 device-auth 처럼
//     비대화형 한 줄이 아니다(실측). 셸에서 그대로 치는 게 나아 failHint 로 안내한다.
const LOGIN_SH = [
  'printf \'\\n%s\\n\\n\' "$1"',
  'codex logout >/dev/null 2>&1 || true',
  'codex login --device-auth || true',
  'printf \'\\n%s\\n\' "$2"',
  'exec "${SHELL:-/bin/sh}" -il',
].join("\n");
export function harnessLoginArgv(harnessKey: string): string[] | null {
  if (harnessKey !== "codex") return null;
  const line = "─".repeat(60);
  const intro = [line, "Codex 로그인을 시작합니다.",
    "잠시 뒤 나오는 주소를 브라우저에서 열고, 함께 표시되는 일회용 코드를 입력하세요.", line].join("\n");
  const done = [line, "로그인 절차가 끝났습니다. 확인하려면  codex login status  를 입력해 보세요.",
    "이 세션에서 바로 쓰려면  codex  를 입력하세요.", line].join("\n");
  return ["sh", "-c", LOGIN_SH, "lively-login", intro, done];
}

// 실행 모드(#1007+) → 격리 pane 에 실을 `-e` env 인자. 순수 함수라 단위테스트로 계약을 못박는다(terminal-sessions.test.ts).
//  incognito 는 readonly 보다 강함(lively 전체 차단 + LIVELY_OFF 로 훅까지 off). 둘 다면 incognito.
//  ⚠ **전이기 dual-env**: 새 LIVELY_MODE(주 신호) + 구 LIVELY_READONLY/LIVELY_INCOGNITO 를 함께 실어, x-lively-mode 헤더가 아직
//   전파 안 된 설치(구 boolean 헤더만, self-update 1세션 지연)에서도 격리가 fail-open 되지 않게. 전파 완료 후 #1021 에서 구 env 제거.
export function modeEnvArgs(input: { readOnly?: boolean; incognito?: boolean }): string[] {
  if (input.incognito) return ["-e", "LIVELY_MODE=incognito", "-e", "LIVELY_INCOGNITO=1", "-e", "LIVELY_OFF=1"];
  if (input.readOnly) return ["-e", "LIVELY_MODE=readonly", "-e", "LIVELY_READONLY=1"];
  return [];
}
