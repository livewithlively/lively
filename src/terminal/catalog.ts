// 중앙 박스 — 큐레이트 설정 카탈로그(허용 루트·하네스 플래그·세션 타입). terminal-sessions.ts 분할(#1313 R15).
//  순수 상수·타입·무의존 순수함수만 둔다(다른 terminal 모듈이 전부 이 파일을 딛고 선다 — 역방향 import 금지).
import path from "node:path";
import os from "node:os";

// 게이트웨이가 launchd/nohup 로 떠 PATH 에 brew 가 없을 수 있어 절대경로 우선(env 오버라이드 가능).
export const TMUX_BIN = process.env.TMUX_BIN || "/opt/homebrew/bin/tmux";
/** psmux(윈도우 네이티브 tmux 구현)인가 — 파일명으로 판정한다(경로·확장자 무관). 원래 terminal-pty 에 있던 것을 여기(leaf)로
 *  내렸다(#1791): tmux-exec 의 sessionGone 도 이 판정이 필요한데 terminal-pty 는 그 위층이라 역방향 import 가 된다. */
export const isPsmuxBin = (bin: string): boolean => /(^|[\\/])psmux(\.exe)?$/i.test(String(bin || ""));

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

// ── 왜 상수가 아니라 함수인가 ───────────────────────────────────────────────
//
// 종전엔 `export const ROOTS = [...]` 였다. 모듈 로드 시점에 `process.env` 한 번 읽고 끝 — 즉
//  **프로세스 하나 = 워크스페이스 하나**라는 가정이 이 상수에 굳어 있었다.
//
// 게이트웨이 하나가 여러 워크스페이스를 서비스하는 배포에서는 그 가정이 곧 사고다: 파일 탐색기·
//  세션 생성·디스크 가드가 전부 **첫 번째로 로드될 때의 테넌트** 경로를 본다. 남의 파일이 보인다.
//
// 그래서 값을 **호출 시점에** 만든다. 상수를 남겨두지 않는 것이 중요하다 — 남겨두면 누군가
//  그걸 쓰고, 그 한 곳이 유출 경로가 된다("빠뜨릴 곳이 존재하지 않게" 가 이 설계 전체의 규율이다).
//
// ⚠ 이 파일은 terminal 모듈들이 전부 딛고 서는 **leaf** 다(머리말) — `org/tenant-context.js` 를
//  import 하면 역방향 의존이 된다. 그래서 슬러그는 **주입**받는다(부팅 배선이 꽂는다).

/** 이 요청의 테넌트 슬러그. 단일 테넌트 배포에서는 언제나 null(종전 동작). */
export type TenantSlugResolver = () => string | null;
let slugResolver: TenantSlugResolver = () => null;

/** 부팅 배선이 한 번 꽂는다. 안 꽂으면 단일 테넌트 그대로다. */
export function installTenantSlugResolver(fn: TenantSlugResolver): void {
  slugResolver = fn;
}

/** 슬러그는 경로에 들어간다 — 형식을 통과 못 하면 **테넌트 경로를 쓰지 않는다**(폴백이 아니라 무시). */
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * 지금 이 요청의 테넌트 슬러그(형식 검증 통과분만). 없으면 null = 단일 테넌트.
 *  ⚠ 이 값은 경로·컨테이너 이름에 들어가므로 **여기서 한 번만** 검증한다 — 호출부마다 다시 재면 갈린다.
 */
export function tenantSlug(): string | null {
  const s = slugResolver();
  return s && SAFE_SLUG.test(s) ? s : null;
}

/**
 * 테넌트별 루트의 base 디렉터리. 템플릿에 `{slug}` 를 넣어 쓴다
 * (예: `LIVELY_TENANT_ROOT_TEMPLATE=/var/lib/lvly/tenants/{slug}/work`).
 * 템플릿이 없거나 컨텍스트가 없으면 null → 종전 경로.
 */
function tenantRootBase(): string | null {
  // 셀프호스트 registry(#1750 S3) — 템플릿 미설정이면 홈 아래 기본 자리로 워크스페이스별 파일루트를 가른다.
  //  primary 는 slug 가 없어 여기 안 걸린다(= 종전 경로 그대로, 기존 파일 무회귀). DB 만 갈라지고 파일이
  //  섞이면 파일 탐색기에서 곧바로 남의 파일이 보인다 — 그래서 기본값이 있어야 한다(옵트인이 아니라).
  const tpl = process.env.LIVELY_TENANT_ROOT_TEMPLATE
    || ((process.env.LIVELY_TENANCY_MODE || "").trim().toLowerCase() === "registry"
      ? path.join(os.homedir(), "lively", "workspaces", "{slug}") : "");
  if (!tpl || !tpl.includes("{slug}")) return null;
  const slug = tenantSlug();
  if (!slug) return null;
  return tpl.replace("{slug}", slug);
}

/** 지금 이 요청이 볼 수 있는 루트들. **호출 시점**에 만든다(위 머리말). */
export function roots(): Root[] {
  const t = tenantRootBase();
  if (t) {
    return [
      { key: "shared", label: "공유 워크스페이스", base: path.join(t, "shared") },
      { key: "personal", label: "개인 폴더", base: path.join(t, "personal"), perUser: true },
    ];
  }
  return [
    { key: "shared", label: "공유 워크스페이스", base: process.env.TERMINAL_ROOT_SHARED || path.join(os.homedir(), "workspace") },  // 폴백 = deploy 관례($HOME/workspace)
    { key: "personal", label: "개인 폴더", base: process.env.TERMINAL_ROOT_PERSONAL || path.join(os.homedir(), "box"), perUser: true },
  ];
}

// 공유 워크스페이스 루트 — 공유 빌드 캐시(#813)가 이 아래 `.cache` 로 산다.
//  그 디렉터리의 그룹·setgid 권한을 물려받아야 멤버별 격리 OS 유저(#524)들이 캐시를 함께 쓸 수 있다.
export function sharedRoot(): Root {
  const all = roots();
  return all.find((r) => r.key === "shared") ?? all[0]!;
}

// ── 하네스 플래그 카탈로그(보수적 화이트리스트) ──
export interface FlagDef { name: string; label: string; desc: string; type: "select" | "bool" | "text"; choices?: string[]; default?: string; }
// 이 하네스를 **누구의 모델로 부르나**(#1758 홈 입력창 제공자 선택). 사람은 'Claude Code' 보다 'Anthropic' 을 먼저 떠올린다 —
//  화면은 제공자를 고르게 하고, 그 선택이 곧 어떤 CLI 가 뜨는지를 정한다(앤트로픽=클로드 코드 · 오픈AI=코덱스 ·
//  제미나이=안티그래비티 · xAI=그록 빌드 · 그 밖=오픈코드). 매핑을 화면에 두지 않고 여기 표에 두는 이유는 소비자가
//  셋이기 때문이다(홈 입력창 · 프로젝트 '클로드로 실행' · 세션 대화창) — 세 곳에 같은 if 를 쓰면 한쪽만 고쳐진다.
export interface HarnessProvider { id: string; label: string }
export interface Harness {
  key: string; label: string; bin: string; provider: HarnessProvider; autoApproveFlag?: string; flags: FlagDef[];
  /** 모델마다 허용 추론강도가 다를 때 UI가 잘못된 조합을 만들지 않게 하는 표. 미지정 모델은 --effort 전체 선택지를 쓴다. */
  effortsByModel?: Record<string, string[]>;
  // #1516 런처 안내의 하네스별 부분(harnessFailNotice 가 읽는다 — 문구를 그 함수에 하드코딩하지 않는다).
  //  · loginCmd: 비정상 종료의 주원인이 '자격 만료'이고 **셸에서 한 줄로** 복구되는 하네스(codex)만. 있으면
  //    안내가 재시작 대신 이 명령을 준다.
  //  · failHint: 재시작 안내(`<bin>` 입력) 뒤에 덧붙일 줄들. 하네스마다 로그인 절차가 달라서 있는 값.
  loginCmd?: string;
  failHint?: string[];
  // 이어받기(#1711) — '이어서 열기'(복원)가 **같은 대화를 이어서** 열게 하는 argv 조각.
  //  id 를 주면 그 대화, 없으면 '가장 최근 대화 또는 피커'. 하네스마다 수단이 완전히 다르다(실측 2026-08-14):
  //   claude `--resume <uuid>` / `--resume`(피커) · codex **서브커맨드** `resume <id>` / `resume --last`
  //   · opencode `--session <id>` / `--continue` · antigravity `--conversation <id>` / `--continue`
  //  ⚠ 반환 argv 는 bin **바로 뒤**에 붙는다 — codex 는 플래그가 아니라 서브커맨드라 그 위치가 계약이다
  //   (`codex resume <id> --model x` 는 유효하다 — resume 이 --model 을 받는 것을 --help 로 확인했다).
  //  ⚠ 종전엔 이 로직이 sessions.ts 에 `harness.key === "claude"` 로 박혀 있어, **claude 아닌 세션은 복원해도
  //   늘 새 대화로 시작**했다(2026-08-14 상민님 신고: antigravity 세션을 /exit 로 닫고 이어 열면 대화가 없다).
  resumeArgv?: (id?: string) => string[];
  // 이미 떠 있는 세션의 모델·추론강도를 바꾸는 **타이핑 한 줄**(#1758 세션 대화창). 세션은 이미 argv 로 떴으므로
  //  플래그로는 못 바꾼다 — 사람이 터미널에서 치는 것과 같은 슬래시 명령을 주입하는 수밖에 없다(POST …/runtime).
  //  ⚠ **인자를 받는 명령이 실증된 하네스에만 둔다.** codex 의 `/models`·opencode 의 `/model` 은 고르는 팝업이라
  //   인자를 안 받고(실측: codex 바이너리에 `/model <arg>` 문자열 없음, 추론강도는 키보드 단축키), antigravity 는
  //   슬래시로 바꾸는 경로가 확인되지 않았다. 없는 하네스도 화면 선택기는 보이되, 같은 프로세스에 거짓 명령을 넣지 않고
  //   같은 작업 자리의 새 프로세스로 맥락을 넘긴다(session-chat.ts handoff).
  runtimeCmd?: { model?: (v: string) => string; effort?: (v: string) => string };
}
// 이어받기 대화 id 형식 — 하네스가 만든 값이라 제각각이다(claude·agy=UUID · opencode=`ses_…`).
//  ⚠ `_` 를 허용한다: 종전 정규식(sessions.ts)엔 없어서 opencode 세션 id 가 형식 오류로 400 이 날 자리였다(#1711).
//  셸 인젝션 표면은 없다(argv 로만 전달) — 이 검증은 하네스에 쓰레기 값을 넘기지 않기 위한 것이다.
export const RESUME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const HARNESSES: Harness[] = [
  {
    key: "claude", label: "Claude Code", bin: "claude", provider: { id: "anthropic", label: "Anthropic" },
    autoApproveFlag: "--dangerously-skip-permissions",
    flags: [
      // desc 는 폼에서 드롭다운 아래 회색 캡션으로 붙는다 — '비우면 기본' 류는 빈 값 옵션 라벨('(자동)')이 이미 말하므로 두지 않는다(#1145).
      // 2026-08-24 Claude Code 2.1.241 --help 가 현행 별칭으로 fable·opus·sonnet 을 직접 안내한다.
      // haiku 는 빠른 기존 별칭으로 유지하고, 기본 표기만 현재 세션 기본인 fable 로 올린다(argv 고정은 하지 않는다).
      //  ⚠ 별칭 목록은 CLI 도움말을 실측해 맞춘다 — fable 이 빠져 있었다(원준님 2026-08-21 지적).
      //   실측(claude 2.1.238 `--help`): "Provide an alias for the latest model (e.g. 'fable', 'opus', or
      //   'sonnet') or a model's full name (e.g. 'claude-fable-5')." 목록에 없어도 터미널에서 `/model fable`
      //   로는 바뀌었기 때문에(이 박스 최근 대화 claude-fable-5 5,059줄) 폼만 모르고 있던 상태였다.
      { name: "--model", label: "모델", desc: "", type: "select", choices: ["", "fable", "opus", "sonnet", "haiku"], default: "fable" },
      { name: "--effort", label: "추론강도(effort)", desc: "무거운 작업(부트스트랩·분류 등)은 xhigh 권장", type: "select", choices: ["", "low", "medium", "high", "xhigh", "max"] },
    ],
    failHint: ["로그인이 필요하다고 나오면 claude 를 실행한 뒤 /login 을 입력하세요."],
    resumeArgv: (id) => (id ? ["--resume", id] : ["--resume"]),   // 인자 없는 --resume = 이 폴더의 대화 피커
    // 실측(claude 2.1.234 번들): `/model <별칭|풀네임>` · `/effort <low|medium|high|xhigh|max|auto>` 둘 다 인자를 받는
    //  local 커맨드(effort 는 supportsNonInteractive) — 입력창에 한 줄로 쳐서 그 자리에서 바뀐다.
    runtimeCmd: { model: (v) => `/model ${v}`, effort: (v) => `/effort ${v}` },
  },
  {
    key: "codex", label: "Codex", bin: "codex", provider: { id: "openai", label: "OpenAI" },
    autoApproveFlag: "--yolo",
    // 2026-08-24 Codex CLI 0.149.1 기준 현행 카탈로그. gpt-5.5를 기본 표기로 남기면
    // 새 세션 화면에서 5.6 계열을 애초에 고를 수 없어, 실제 설치본보다 UI가 뒤처진다.
    // default 는 **표기용**이다(#1145) — 빈 값 옵션을 '(자동 · gpt-5.6-sol)' 로 보여줄 뿐, 이 값을 argv 로 넘기지는 않는다.
    //  넘기는 순간 그 모델에 고정돼, codex 가 기본을 올려도 여기 적힌 낡은 문자열에 사용자가 묶인다.
    flags: [
      { name: "--model", label: "모델", desc: "", type: "select", choices: ["", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"], default: "gpt-5.6-sol" },
      // Codex CLI는 현재 launch-time reasoning effort를 config로 받는다. 일반 --effort 플래그가 아니라
      // session 생성기에서 별도 argv로 정규화한다. UI 계약은 다른 하네스와 동일하게 유지한다.
      { name: "--effort", label: "추론강도(effort)", desc: "", type: "select", choices: ["", "low", "medium", "high", "xhigh", "max", "ultra"] },
    ],
    effortsByModel: {
      "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
      "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
      "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
      "gpt-5.5": ["low", "medium", "high", "xhigh"],
      "gpt-5.4": ["low", "medium", "high", "xhigh"],
      "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
    },
    loginCmd: "codex logout && codex login --device-auth",
    resumeArgv: (id) => (id ? ["resume", id] : ["resume", "--last"]),   // 피커는 대화형이라 무인 복원엔 --last
  },
  {
    // #1519 로 배선(훅·MCP·자산)은 이미 붙어 있는데 **웹 세션 카탈로그에만** 빠져 있던 자리(#1695).
    // 2026-08-24 설치본 `opencode models` 실측의 기본 제공 모델. 계정별 추가 provider 모델은 이 목록에 없지만,
    // 적어도 설치 직후 누구나 쓸 수 있는 모델은 상단에서 고를 수 있게 한다. 선택 뒤에는 새 OpenCode 프로세스로 핸드오프된다.
    key: "opencode", label: "OpenCode", bin: "opencode", provider: { id: "other", label: "그 밖의 제공자" },
    autoApproveFlag: "--auto",   // 실측(1.18.x --help): 명시 deny 가 아닌 권한을 자동 승인
    flags: [
      { name: "--model", label: "모델", desc: "", type: "select", choices: ["", "opencode/big-pickle", "opencode/hy3-free", "opencode/mimo-v2.5-free", "opencode/muse-spark-1.2-contributor-free", "opencode/nemotron-3-ultra-free", "opencode/nemotron-3.5-lightning-free", "opencode/x-preview-f-free"] },
    ],
    // 셸에서 그대로 치는 명령은 **명령 줄**로 준다(복사해 붙여넣게) — claude 의 /login 은 TUI 안 입력이라 문장으로 둔다.
    failHint: ["로그인이 필요하다고 나오면 아래를 입력해 제공자를 고르세요:", "", "    opencode auth login"],
    resumeArgv: (id) => (id ? ["--session", id] : ["--continue"]),
  },
  {
    // #1689 로 배선 완료 → 이 카탈로그가 웹 세션(AI 세션 탭·프로젝트 화면)의 마지막 조각이다(#1695).
    //  bin 은 key 와 다르다(agy). 안내·재시작 문구를 key 로 만들면 없는 명령을 안내하게 된다(harnessFailNotice 참조).
    key: "antigravity", label: "Antigravity", bin: "agy", provider: { id: "google", label: "Google Gemini" },
    autoApproveFlag: "--dangerously-skip-permissions",   // 실측(agy 1.1.13 --help)
    // 모델은 `agy models` 실측 목록을 그대로 싣는다. 최신 3.7만 남기면 이미 설치본이 지원하는 3.5/3.6을
    // 상단에서 고를 수 없으므로, 새 모델 추가와 기존 지원 모델 보존을 함께 반영한다.
    // codex 와 같은 이유로 빈 값(=하네스 기본)을 기본으로 두어 특정 문자열에 사용자를 묶지 않는다.
    flags: [
      { name: "--model", label: "모델", desc: "", type: "select", choices: ["", "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low", "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low", "gemini-3.5-flash-high", "gemini-3.5-flash-medium", "gemini-3.5-flash-low", "gemini-3.1-pro-high", "gemini-3.1-pro-low", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"] },
      { name: "--effort", label: "추론강도(effort)", desc: "", type: "select", choices: ["", "low", "medium", "high"] },   // claude 와 달리 3단계(실측)
    ],
    failHint: ["로그인이 필요하다고 나오면 화면에 뜨는 주소를 브라우저에서 열고, 함께 표시되는 코드를 입력하세요."],
    // ⚠ id 없는 폴백(`--continue`)은 **가장 최근 대화**를 잡는데, agy 의 대화 저장(~/.gemini/antigravity-cli/brain/)은
    //  워크스페이스별이 아니라 **전역**이다(실측) → 세션을 여러 개 돌리면 남의 대화를 이어받을 수 있다.
    //  그래서 antigravity 는 id 복원이 정상 경로이고(어댑터가 conversationId 를 세션 id 로 보고한다 — 매핑 존재),
    //  폴백은 매핑이 없을 때의 차선이다.
    resumeArgv: (id) => (id ? ["--conversation", id] : ["--continue"]),
  },
  {
    // #1701 로 배선 완료(hook-file + config.toml 센티넬 + rules 주입) — 5번째 하네스.
    key: "grok", label: "Grok Build", bin: "grok", provider: { id: "xai", label: "xAI" },
    autoApproveFlag: "--always-approve",   // 실측(grok 1.0.3 --help; --yolo 는 별칭이지만 제품 표기가 always-approve)
    // 2026-08-24 Grok Build 1.0.5 `grok models` 실측: 사용 가능·기본 모델 모두 grok-4.6 하나다.
    // 더는 목록에 없는 4.5 를 남기면 선택 즉시 실패하므로 제거한다. 빈 값은 하네스 기본을 계속 따른다.
    flags: [
      { name: "--model", label: "모델", desc: "", type: "select", choices: ["", "grok-4.6"], default: "grok-4.6" },
      { name: "--effort", label: "추론강도(effort)", desc: "모델이 지원하는 단계만 적용됩니다", type: "select", choices: ["", "low", "medium", "high", "xhigh"] },
    ],
    failHint: ["로그인이 필요하다고 나오면 아래를 입력해 브라우저 없이 로그인하세요:", "", "    grok login --device-code"],
    // 실측(grok 바이너리 도움말 문자열): `/model <모델id>  # Switch model` · `/effort <level>` 둘 다 인자를 받는다.
    runtimeCmd: { model: (v) => `/model ${v}`, effort: (v) => `/effort ${v}` },
    // 실측(#1701): `-r <id>` 는 세션 id(UUID) 재개, id 없으면 `-c` = 이 폴더의 최근 세션. 어댑터가 sessionId 를
    //  세션 매핑으로 보고하므로 id 복원이 정상 경로다(antigravity 와 같은 구조).
    resumeArgv: (id) => (id ? ["--resume", id] : ["--continue"]),
  },
  { key: "shell", label: "셸 (에이전트 없음)", bin: "", provider: { id: "none", label: "AI 없음" }, flags: [] },
];

export interface SessionInfo {
  id: string; label: string; harness: string; dir: string; autoApprove: boolean;
  owner: string; owned: boolean; created: number; attached: boolean;
  invites: string[]; // 초대된 멤버 id(@box_invites). 빈 배열 = 비공개(소유자만 보기·열기).
  flags: Record<string, string>; // 생성 시 적용된 하네스 플래그(@box_flags, 예: {"--model":"opus"}). 수정 팝업의 비활성 표시용.
  projectId?: number; // 프로젝트 세션이면 그 프로젝트 id(@box_project). 보드의 '내 세션' 칼럼 활성 판단용.
  appId?: string; // 이 세션을 실행한 AppPackage. 일반 AI 세션은 undefined이고 셸이 ai-session builtin으로 해석한다.
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
  // #1954 3차 — 마지막으로 이 세션 **화면을 보고 있던** 시각(epoch초, tmux `@box_last_seen`). 한 번도 안 봤으면 0.
  //  lastAttached 와 뜻이 겹쳐 보이지만 축이 다르다: 저건 '터미널이 붙은 순간'(탭 수명당 한 번)이고 이건
  //  '사람이 그 화면을 열어 두고 있다'(보는 동안 주기적으로 갱신). 새 셸이 탭 DOM 을 유지하면서 전자만으로는
  //  '봤다'를 표현할 수 없게 됐다 — tmux-exec.ts LIST_FMT 주석 참조.
  lastViewed?: number;
  // #1059 E — 복원 가능(restorable): tmux 에 없고 DB desired-state(org_session_state)에만 있는 세션(재부팅으로 죽었거나
  //  F reaper 가 회수). agentState 는 offline. 프론트가 이 배지를 보고 '열기=복원'(POST …/restore) 경로로 분기한다(attach 아님).
  restorable?: boolean;
  // #2022 — 이 행을 게이트웨이가 **노드 스냅샷에서 발견해** 적었나(그 컴퓨터에서 직접 띄운 세션).
  //  좌표를 모르므로 되살릴 수 없다 — 위 restorable 이 false 로 나가고, 화면은 '왜 못 되살리나'를 이 값으로 말할 수 있다.
  discovered?: boolean;
  // #1059 — restorable 이 **사용자 정상 종료**(/exit·logout, SessionEnd 훅 보고)로 생겼나. true=내가 종료('종료됨·대화 이어보기'),
  //  false=재부팅·강제kill·reaper 회수('복원 가능·중단됨'). 프론트가 라벨·버튼을 구분(둘 다 복원 경로는 동일).
  exitedByUser?: boolean;
  // #1851 — 휴지통에 있는 세션(소유자 자신의 표식, ISO 시각). 목록엔 그대로 실리되 새 셸은 사이드바에서 빼고 휴지통 화면에 그린다.
  //  완전 삭제(purged)된 세션은 이 목록에서 아예 빠진다.
  trashedAt?: string;
  trashedWith?: number;   // #1851 — 프로젝트를 통째로 버릴 때 함께 들어간 세션이면 그 프로젝트 id(따로 버린 것은 없음)
  // #1251 — **earlyoom(OS 보호장치)이 죽인** 세션. exitedByUser 와 배타다(사용자가 끝낸 게 아니라 당한 것).
  //  이걸 구분해 주지 않으면 사용자는 자기 세션이 왜 사라졌는지 모른 채 재부팅·자동회수와 같은 '중단됨'으로만 본다.
  //  ⚠ 관측 기반 **추정**이라, 확신이 서지 않으면 아예 안 붙인다(box-watch 의 매핑 조건 참조).
  oomKilled?: boolean;
  // #1719 세션 대화창 — 이 박스가 지금(또는 마지막으로) 돌린 **하네스 대화 id**(org_session_state.claude_session_id,
  //  work-flag 훅 보고·last-write-wins). 화면이 이 값으로 ① 로컬 트랜스크립트(/sessions/:id/transcript)를 잇고
  //  ② 중앙 세션 기록(v6/sessions 의 session_id 는 이 uuid 다)과 **같은 세션임을 알아 목록에서 한 장으로 접는다.**
  //  미보고면 없다(추측하지 않는다 — sessions.ts restore 의 picker 원칙과 같다).
  claudeSessionId?: string;
  // #1746 세션 대화창의 하네스 능력 요약(harness-io/adapter.ts chatIoCaps) — read=대화 파일을 화면으로 읽을 수 있나(파서 있음) ·
  //  answer=승인·거부·중단을 화면에서 대신 누를 수 있나(승인 키 실측 있음). 화면이 이걸로 버튼·안내를 **정직하게** 그린다(없는 능력의
  //  버튼을 두지 않는다 — 막다른 컨트롤 금지). 없으면(구 서버) 화면은 둘 다 있는 것으로 본다(종전 동작).
  chat?: { read: boolean; answer: boolean };
  /** #2055 — 대화 런타임: "tmux"(pane 의 TUI) · "app-server"(pane 은 셸, 대화는 JSON-RPC). 화면의 기본 보기가 이걸 따른다. */
  chatMode?: string;
  // #1791 — 이 세션이 도는 노드(라이브 노드 스냅샷 행은 node/registry 가 채우고, **복원 가능 노드 세션 행**은
  //  listRestorableSessions 가 desired-state 의 node_id 로 채운다 — 이름·온라인 여부는 routes 가 레지스트리로 보강). 없으면 게이트웨이 박스.
  //  프론트는 이 값으로 &node= 를 릴레이한다(입장·삭제·복원 결과 열기).
  node?: { id: string; name: string; online: boolean };
}
export interface PreparedAppSession {
  appId: string;
  token: string;
  gatewayUrl: string | null;
  assets: Array<{ path: string; body: string; mode: number }>;
}

export interface CreateInput { label: string; rootKey: string; subpath: string; harness: string; flags: Record<string, unknown>; autoApprove: boolean; invites?: unknown; projectId?: number; projectSrc?: "v6" | "org"; loginProfile?: boolean; resume?: string; readOnly?: boolean; incognito?: boolean;
  // #1291 v2 — 기록 범위(write cap)와 read 축소. 미지정이면 실행 폴더에서 파생한다(신규·복원이 같은 규칙).
  //  writeVis: 'open'|'audience'|'private' — 이 세션이 **사용자 승인 없이** 만들 수 있는 맥락의 최대 가시성.
  //  restrictRead: 프로젝트 세션을 owner∪invites 로 더 좁힌다(프로젝트 대상 안에서만 축소 가능).
  writeVis?: string;
  restrictRead?: boolean;
  // #1541 — 노드(멤버 PC) 세션: **그 PC 주인의 네이티브 클로드 설정을 그대로 쓴다**(CLAUDE_CONFIG_DIR 미주입).
  //  #1014 프로필 주입은 '여러 멤버가 한 OS 계정을 공유하는 게이트웨이 박스'의 신원 유출 방어인데, 본인 소유
  //  member 노드에선 그 전제가 없다 — 주입하면 텅 빈 프로필 dir 이 돼 MCP·훅·로그인이 전부 사라진 claude 가 뜬다
  //  (실측: /mcp "No MCP servers configured"). 게이트웨이가 "member 노드 && 생성자=노드 주인"일 때만 켠다 —
  //  노드측은 값을 믿고 따르기만 한다(정책 판단은 게이트웨이, 노드는 기계적 실행 — agent runOp 전제 그대로).
  hostProfile?: boolean;
  // #1059 E — 상시(managed) 세션은 desired-state DB 미러를 만들지 않는다(keep-alive 가 그 영속을 소유). ensureManagedSession 만 넘긴다.
  managed?: boolean;
  // #1059 — claude UUID 를 모를 때 인자 없는 --resume 로 후보 picker 를 띄운다(restorable 복원. resume 과 배타 — resume 우선).
  resumePick?: boolean;
  // #1516 — 로그인 전용 세션: 이 하네스의 **로그인 명령**을 셸에서 돌린다(하네스 TUI 를 띄우지 않는다).
  //  자격이 만료된 상태에서 그 하네스로 세션을 열면 즉사해 로그인 자체가 불가능하기 때문(harnessLoginArgv 주석).
  //  harness 는 'shell' 로 보낸다 — 이 세션은 AI 세션이 아니라 로그인 절차용이다.
  loginFor?: string;
  // #1683 다크모드 — 이 세션을 만든 **브라우저 화면의 테마**(해석된 값: dark|light). pane env 로 내려보내
  //  안에서 도는 하네스·TUI 가 배경에 맞는 색을 고르게 한다(COLORFGBG·LIVELY_THEME — sessions.ts 참조).
  //  ⚠ 하네스 설정 파일(~/.claude/settings.json 의 theme 등)은 **건드리지 않는다** — 그건 사람의 설정이고
  //   킷이 보존하기로 한 키다(kit/adapters/*/uninstall.mjs). 우리는 터미널이 하는 표준 신호만 준다.
  theme?: "dark" | "light";
  // #1719 홈 입력창 — 첫 지시. 세션을 띄운 뒤 하네스 입력창이 뜨는 걸 **보고 나서** 주입한다(session-first-prompt.ts).
  //  생성 응답은 기다리지 않는다(주입은 백그라운드) — 화면은 세션 대화창으로 가서 대화 파일에 나타나는 걸 따라간다.
  initialPrompt?: string;
  // #1780 D4 — 이 세션을 **앱으로** 띄운다. 설정 시 createSession 이 grant 검사 → 앱 토큰 발급 →
  //  cwd와 분리된 private app runtime home에 토큰·앱 하네스 자산을 물질화하고
  //  pane env LIVELY_HOME=<private session_home>·LIVELY_APP_ID=<id> 를 주입한다. session_home은 cwd와 분리된다.
  appId?: string;
  // 게이트웨이가 정책·grant·DB를 확인해 준비한 원격 실행용 봉투. HTTP body에서는 받지 않고 내부 node relay만 사용한다.
  appSession?: PreparedAppSession;
}

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
  'notice=$1; notfound=$2; shift 2',
  '"$@"',
  'rc=$?',
  '[ "$rc" -eq 0 ] && exit 0',
  // 127 = 명령을 못 찾음(셸 규약) — "하네스가 죽었다"와 원인·처방이 전혀 다르다(#1541 실측: GUI 가 구운 좁은
  //  PATH 로 노드가 떠서 pane 이 claude 를 못 찾음). 이 갈래만 다른 안내를 찍는다.
  'if [ "$rc" -eq 127 ]; then printf \'\\n%s\\n\' "$notfound"; else printf \'\\n%s\\n\' "$notice"; fi',
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

// 명령 자체를 못 찾은 경우(exit 127) — "다시 시작하세요(<bin>)"는 **같은 실패를 한 번 더 시키는 안내**다.
//  원인은 십중팔구 이 세션의 PATH(#1541 실측): 노드를 데스크톱 앱(GUI)에서 재시작하면 등록 절차가 GUI 의 최소
//  PATH 를 구웠고, pane 은 그걸 물려받아 하네스를 못 찾는다. 처방은 "터미널에서 노드 재시작" 한 줄이다
//  (kit cmd-node 가 로그인 셸 PATH 를 굽도록 고쳐진 뒤로는 그 한 번으로 영구 해결된다).
export function harnessNotFoundNotice(harnessKey: string): string {
  const line = "─".repeat(60);
  const h = HARNESSES.find((x) => x.key === harnessKey);
  const label = h?.label || harnessKey;
  const bin = h?.bin || harnessKey;
  return [
    line,
    `${label} — 실행 파일(${bin})을 이 세션의 PATH 에서 찾지 못했습니다.`,
    "",
    `이 PC 에 ${bin} 이 설치돼 있는데도 이 메시지가 나오면, 노드가 좁은 PATH 로 시작된 것입니다`,
    "(데스크톱 앱에서 노드를 시작하면 생길 수 있습니다). 이 PC 의 터미널에서 아래 한 줄을 실행하세요:",
    "",
    "    lively node stop && lively node --daemon",
    "",
    `설치돼 있지 않다면 먼저 설치하세요. 그 뒤 이 세션에서  ${bin}  을 입력하면 이어서 쓸 수 있습니다.`,
    line,
  ].join("\n");
}

// Windows pane 셸의 UTF-8 프렐류드(#1541) — POSIX 의 PANE_LOCALE(#633)에 대응하는 **Windows 축**이다.
//
// ★ 실측(2026-08-14, hammurabi 실기기): 노드 pane 은 `chcp 949` · `[Console]::OutputEncoding =
//  ks_c_5601-1987` 로 시작한다. 그래서 **우리가 내보내는 UTF-8 을 pane 의 소비자가 cp949 로 디코드**한다:
//    Write-Host "한글"          → 정상 (PowerShell → WriteConsoleW)
//    node x.mjs                 → 정상 (Node → WriteConsoleW)
//    node x.mjs | Out-String    → **깨짐** (`NODE吏곸젒: ?쒓?媛€?섎떎`)
//    type <UTF-8 로그파일>      → **깨짐**  ← 우리가 `lively node start` 로 안내해 온 바로 그 명령
//  즉 파일도 프로그램도 정상인데 **읽는 층**만 틀렸다. 파이프는 AI 하네스가 상시로 쓰는 경로다.
//
// ⚠ `chcp 65001` **만으로는 안 고쳐진다** — PowerShell 은 시작 시 `[Console]::OutputEncoding` 을 캐시하므로
//  네이티브 출력 디코드는 여전히 cp949 다(실측). 두 층을 **다** 세워야 한다:
//   · `chcp 65001`               → 네이티브 자식(`type`·findstr…)의 콘솔 입출력
//   · `[Console]::OutputEncoding` → PowerShell 이 **네이티브 출력을 디코드**할 때 (= 파이프 정상화)
//   · `[Console]::InputEncoding`  → 사람이 pane 에 타이핑한 한글이 네이티브 자식에게 갈 때
//   · `$OutputEncoding`           → PowerShell 이 네이티브 자식의 **stdin 으로 보낼** 때
//
// ⚠ 사용자 셸 전역이 아니라 **이 pane 만** 바뀐다(실측: 프렐류드를 넣은 A 세션은 utf-8, 동시에 뜬 B 세션은
//  949 그대로). 세션스코프라는 점에서 `-e LANG=…`(#633)과 성질이 같다.
//
// ⚠ 설정마다 개별 try/catch — 구 PowerShell·핸들 무효로 한 줄이 실패해도 **셸은 떠야 한다**(프렐류드는
//  편의지 전제가 아니다). 프로필(`-NoProfile` 안 씀)은 그대로 로드해 사용자 설정이 이긴다.
const WIN_UTF8_PS = [
  "try{chcp 65001|Out-Null}catch{}",
  "try{$u=New-Object System.Text.UTF8Encoding($false)}catch{$u=$null}",
  "if($u){try{[Console]::OutputEncoding=$u}catch{};try{[Console]::InputEncoding=$u}catch{};try{$OutputEncoding=$u}catch{}}",
].join("\n");

// `-EncodedCommand`(UTF-16LE base64)로 넘긴다 — **인용부호를 아예 안 쓰기 위해서**다.
//  psmux 3.3.7 은 인자의 `"` · `'` · 탭을 삼키고(opt-json.test.ts 가 세운 계약), 공백은 인자를 쪼갠다.
//  base64 는 그 문자를 하나도 안 쓰므로 psmux 를 통과해도 스크립트가 원형 그대로 도착한다.
//  (여기엔 보간할 값이 없다 — 위 상수 하나뿐이라 아래 인젝션 경계 규칙과 어긋나지 않는다.)
const WIN_UTF8_B64 = Buffer.from(WIN_UTF8_PS, "utf16le").toString("base64");

/**
 * Windows 셸 세션이 실행할 argv. 토큰에 `"` `'` 탭 **공백**이 하나도 없어야 한다(psmux 통과 조건).
 *
 * `powershell`(5.1)을 명시한다 — psmux 의 Windows 기본 셸과 같고 어느 Windows 에나 있다(pwsh 는 없을 수 있다).
 */
export function winShellArgv(): string[] {
  return ["powershell", "-NoLogo", "-NoExit", "-EncodedCommand", WIN_UTF8_B64];
}

// 하네스 실행 argv → 런처로 감싼 argv. cmd 가 비면(셸 세션) 감쌀 하네스는 없지만, Windows 는 UTF-8
//  프렐류드를 세운 셸을 띄운다(위 WIN_UTF8_PS).
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
//   → 그래서 UTF-8 프렐류드(#1541)도 **하네스 세션엔 넣지 않는다**: 하네스를 감싸려면 그 argv 를
//     PowerShell 문자열에 이어붙여야 하고, 그게 정확히 이 규칙이 막는 것이다. 셸 세션(cmd 가 빈 경우)은
//     이어붙일 값이 없어(상수 하나) 안전하다 — 그쪽만 세운다.
//   하네스 세션은 프렐류드 없이도 화면이 정상이다: 하네스는 ConPTY 에 UTF-8 을 직접 쓰고 xterm.js 가
//    UTF-8 로 디코드한다. 콘솔 코드페이지는 **파이프·네이티브 자식**을 읽을 때만 문제가 된다.
export function harnessLaunchArgv(harnessKey: string, cmd: string[], platform: string = process.platform): string[] {
  const argv = Array.isArray(cmd) ? cmd : [];
  if (platform === "win32") return argv.length ? argv : winShellArgv();
  if (!argv.length) return argv;
  return ["sh", "-c", LAUNCH_SH, "lively-launch", harnessFailNotice(harnessKey), harnessNotFoundNotice(harnessKey), ...argv];
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

// codex app-server 모드의 pane (#2055) — TUI 대신 **셸**을 띄우고, 왜 그런지 한 화면으로 알려 준다.
//  왜 셸인가: codex 는 스레드당 writer 가 하나다(실측). pane 에 TUI 를 띄우면 대화창이 쥔 대화와 **다른 대화**가
//  열려, 터미널에서 보는 것과 대화창에서 보는 것이 갈린다. 그래서 대화는 대화창(app-server)이 전담하고
//  pane 은 사람이 직접 명령을 치는 자리로 남는다.
//  ⚠ 안내에 `codex` 를 그냥 치라고 쓰지 않는다 — 그건 **새 대화**를 연다. 이어가려면 대화창이 스레드를
//   놓아 준 뒤 `codex resume <id>` 다(그 id 는 화면이 알려 준다).
const APP_SERVER_SH = [
  'printf \'\\n%s\\n\\n\' "$1"',
  'exec "${SHELL:-/bin/sh}" -il',
].join("\n");
export function codexAppServerPaneArgv(): string[] {
  const line = "─".repeat(60);
  const intro = [line,
    "이 세션의 Codex 대화는 **대화창**이 맡습니다(App Server).",
    "이 터미널은 명령을 직접 치는 자리입니다 — 파일·빌드·git 을 그대로 쓰세요.",
    "여기서  codex  를 실행하면 대화창과 **다른 대화**가 열립니다(같은 대화는 한 곳만 쥘 수 있습니다).",
    "대화를 이 터미널로 옮기려면 대화창에서 [터미널로 넘기기] 를 누르세요.",
    line].join("\n");
  return ["sh", "-c", APP_SERVER_SH, "lively-codex-chat", intro];
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

// 화면 테마(#1683) — 값 정규화와 `-e` env 조립. modeEnvArgs 와 같은 자리·같은 모양(순수 함수 → 계약을 테스트로 못박는다).
//
// 왜 pane 에 내려보내나: 터미널 안에서 도는 하네스·TUI 가 **배경에 맞는 색**을 골라야 읽힌다. 밝은 배경에
//  밝은 회색으로 쓰면 안 보이고, 그 반대도 마찬가지다. 터미널이 앱에게 배경을 알려주는 표준 통로는 둘이다 —
//   · OSC 11 질의 응답 — 앱이 물어보면 터미널이 답한다. 웹터미널은 xterm 이 자동으로 답한다
//     (실증: 배경 #111726 → `ESC]11;rgb:1111/1717/2626`). **물어보는** 도구는 이 env 없이도 맞게 고른다.
//   · COLORFGBG env — 물어보지 않고 env 를 읽는 도구(vim/neovim 의 background 자동판정, less 등)를 위한 보강.
//  LIVELY_THEME 은 우리 훅·스킬이 읽을 명시 값이다(COLORFGBG 는 값 규약이 느슨해 해석이 갈린다).
//
// ⚠ 하네스의 설정 파일(~/.claude/settings.json 의 theme 등)은 **고치지 않는다** — 사람의 설정이고 킷이
//  보존하기로 한 키다(kit/adapters/*/uninstall.mjs). 터미널이 하는 표준 신호까지가 우리 몫이다.
// ⚠ pane env 는 exec 시점 고정 → **새 세션부터** 적용된다(LANG #633·TZ #778·SESSION_ID #852 와 같은 성질).
export function normalizeTheme(v: unknown): "dark" | "light" | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "dark" || s === "light" ? s : undefined;
}
export function themeEnvArgs(theme: unknown): string[] {
  const t = normalizeTheme(theme);
  if (!t) return [];   // 모르면 아무것도 안 넣는다 — 종전 동작(무회귀). 억지 기본값이 더 나쁘다.
  // COLORFGBG "<fg>;<bg>" ANSI 번호 — 다크는 밝은 글자(15) on 검정(0), 라이트는 그 반대.
  return ["-e", `COLORFGBG=${t === "dark" ? "15;0" : "0;15"}`, "-e", `LIVELY_THEME=${t}`];
}

// ── 하네스별 테마 주입 (#1683 후속) ─────────────────────────────────────────
//
// 왜 따로 필요한가: 위 COLORFGBG·OSC 11 은 "터미널이 배경을 알려주는" 표준 통로인데, **AI 하네스 대부분은
//  그걸 묻지 않고 자기 설정에 저장한 테마를 쓴다**(실측: Claude Code 는 settings.json 의 theme 을 읽고
//  터미널에 묻지 않는다 — 그래서 앱을 다크로 바꿔도 하네스 화면은 라이트 그대로였다).
//
// 원칙 — **사람의 설정 파일을 고치지 않는다.** 하네스 설정의 theme 은 그 사람이 고른 값이고 킷이 보존하기로
//  한 키다(kit/adapters/*/uninstall.mjs). 대신 **실행 시점에만 얹는 방법**(플래그·env)이 있는 하네스에만
//  세션 스코프로 준다. 그 방법이 없는 하네스는 **손대지 않는다** — 전역 설정을 대신 고치면 라이블리 밖에서
//  쓰는 그 사람의 세션까지 바뀌고, 비격리 박스에서는 그 파일이 **구성원 공유**라 남의 화면까지 바꾼다.
//
// 하네스별 실측 (2026-08-20, 이 박스의 설치본 기준):
//  · claude      — `--settings '{"theme":"dark"}'`  ★검증: 다크·라이트로 각각 띄워 pane ANSI 색이 갈리는 것 확인
//  · codex       — `-c tui.theme=<이름>`             (`-c key=value` 오버라이드. 테마는 dark/light 가 아니라 **이름**)
//  · opencode    — `OPENCODE_CONFIG_CONTENT` env     (설정을 통째로 문자열로 받는다)
//  · antigravity — 없음. 테마는 있으나(~/.gemini/antigravity-cli/settings.json 의 colorScheme) 실행 시점
//                  주입 경로가 없다(플래그·env 스캔 음성). 위 원칙대로 손대지 않는다.
//  · grok        — 테마 기능 자체가 없다(--help·inspect·바이너리 스캔 모두 음성).
//
// ⚠ 값은 여기 한 곳에서만 고친다. codex 의 이름은 그 하네스가 가진 테마 목록에서 고른 것이라
//  하네스가 목록을 바꾸면 여기만 손보면 된다.
const HARNESS_THEME: Record<string, { argv?: (t: "dark" | "light") => string[]; env?: (t: "dark" | "light") => string[] }> = {
  claude: { argv: (t) => ["--settings", JSON.stringify({ theme: t })] },
  codex: { argv: (t) => ["-c", `tui.theme=${t === "dark" ? "one-half-dark" : "one-half-light"}`] },
  opencode: { env: (t) => [`OPENCODE_CONFIG_CONTENT=${JSON.stringify({ theme: t })}`] },
};

/** 이 하네스가 실행 시점 테마 주입을 지원하나 — 화면이 "이 하네스는 앱 테마를 따릅니다"를 말할 근거. */
export function harnessFollowsTheme(harnessKey: string): boolean {
  return !!HARNESS_THEME[String(harnessKey || "")];
}

/** 하네스 실행 argv 에 덧붙일 테마 인자. 지원 안 하면 빈 배열(무회귀). */
export function harnessThemeArgv(harnessKey: string, theme: unknown): string[] {
  const t = normalizeTheme(theme);
  const h = HARNESS_THEME[String(harnessKey || "")];
  return t && h?.argv ? h.argv(t) : [];
}

// ── 실행 중 세션의 테마 전환 (#1683 후속2) ─────────────────────────────────
//
// 왜 별도인가: 위 harnessThemeArgv/EnvArgs 는 **새로 뜨는** 세션에만 통한다. pane env·실행 인자는 exec 시점에
//  고정되고, 하네스는 시작할 때 테마를 정한 뒤 설정을 다시 읽지 않는다(실측). 그런데 이미 열어 둔 탭도 같이
//  바뀌길 원하는 게 자연스럽다 — 그건 **하네스의 자체 명령**을 그 pane 에 넣어야만 된다.
//
// ⚠ 이건 '계약'이 아니라 '화면 조작'이다. 아래 시퀀스는 그 하네스 TUI 의 메뉴 순서·라벨에 기댄다 —
//  하네스가 업데이트로 메뉴를 한 줄 추가하면 **그 하네스만 조용히 엉뚱한 테마로 바뀐다**. 그래서
//   ① 실측으로 확인한 하네스만 넣는다(verified 표시). 미확인 하네스는 넣지 않는다 — 틀린 테마로 바꾸는 것이
//      안 바꾸는 것보다 나쁘다.
//   ② 결과를 호출부가 사람에게 그대로 알린다(조용한 실패 금지).
//   ③ 값은 여기 한 곳 — 하네스가 UI 를 바꾸면 이 표만 고친다.
//
// 하네스별 실측 (2026-08-24, 이 박스 설치본):
//  · claude      — `/theme` ⏎ 로 번호 선택창(1 Auto · 2 Dark · 3 Light · …), 번호를 누르면 **그 자리에서 적용**.
//                  ★검증: 라이트 세션에 넣어 pane ANSI 색이 다크로 바뀌는 것 확인(38;5;137 사라지고 38;5;220·244 나타남).
//  · grok        — `/theme` 이 **순환**이다(Grok Day → Tokyo Night → Rose Pine Moon → oscura …). 원하는 테마를
//                  지정할 수단이 없어 **지원하지 않는다**(설정 모달은 다단계라 ① 원칙에 걸린다).
//  · codex       — `/theme` 은 **구문 강조** 테마다(전체 크롬 아님). 미검증이라 넣지 않는다.
//  · opencode    — `/themes` 선택창. 미검증이라 넣지 않는다.
//  · antigravity — 전용 명령 없음(`/config` → 검색 → 값 선택 다단계). 미검증이라 넣지 않는다.
export type LiveThemeStep =
  | { kind: "text"; text: string }   // 입력창에 글자를 넣는다(제출은 enter 단계가 한다)
  | { kind: "enter" }                // 제출
  | { kind: "wait"; ms: number };    // TUI 가 그릴 시간을 준다

const HARNESS_LIVE_THEME: Record<string, (t: "dark" | "light") => LiveThemeStep[]> = {
  // `/theme` ⏎ → 선택창 → 번호. 번호를 누르는 순간 적용되고 별도 ⏎ 가 필요 없다(실측).
  claude: (t) => [
    { kind: "text", text: "/theme" },
    { kind: "enter" },
    { kind: "wait", ms: 1200 },
    { kind: "text", text: t === "dark" ? "2" : "3" },
  ],
};

/** 이 하네스가 **실행 중** 전환을 지원하나(실측 확인된 것만 true). */
export function harnessLiveThemeSupported(harnessKey: string): boolean {
  return !!HARNESS_LIVE_THEME[String(harnessKey || "")];
}

/** 실행 중 전환 시퀀스. 지원 안 하면 빈 배열 — 호출부가 '지원하지 않음'으로 사람에게 알린다. */
export function harnessLiveThemeSteps(harnessKey: string, theme: unknown): LiveThemeStep[] {
  const t = normalizeTheme(theme);
  const f = HARNESS_LIVE_THEME[String(harnessKey || "")];
  return t && f ? f(t) : [];
}

/** 하네스 테마를 env 로 주는 경우의 tmux `-e` 인자. 지원 안 하면 빈 배열. */
export function harnessThemeEnvArgs(harnessKey: string, theme: unknown): string[] {
  const t = normalizeTheme(theme);
  const h = HARNESS_THEME[String(harnessKey || "")];
  if (!t || !h?.env) return [];
  return h.env(t).flatMap((kv) => ["-e", kv]);
}
