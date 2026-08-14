// 하네스 어댑터 레지스트리 — "claude냐 codex냐" 이분법으로 24곳에 흩어져 있던 분기를 **하네스별 데이터** 한 벌로 모은다.
//
// 왜 데이터인가: 세 번째 하네스를 그대로 끼우면 24곳에 케이스를 하나씩 더하는 일이 되고, 그건 #1475 에서 실제로
//  터진 "한 군데 빠져 조용히 안 감"과 같은 구조다(#1221 이 죽은 어댑터에만 들어가 실배포에 안 나간 것도 같은 뿌리).
//  여기 표에 한 줄을 더하는 것으로 끝나야 '빠뜨릴 자리'가 사라진다.
//
// ⚠ 배치 제약 — 이 파일은 **훅과 같은 디렉터리에 있어야 한다.** 훅 스크립트들은 설치 시 `~/.lively/hooks/` 로
//  **평평하게** 복사되므로(user-install.installShared 의 HOOK_SCRIPTS), 훅이 import 하는 모듈이 다른 디렉터리에
//  있으면 설치된 자리에서 ERR_MODULE_NOT_FOUND 로 **훅이 통째로 죽는다**. 그래서 kit/hooks/ 에 두고
//  HOOK_SCRIPTS 에 등재한다(등재 누락은 kit/hooks/harness-registry.test.mjs 가 잡는다).
//  설치기(setup/user-install.mjs)는 발행물의 `.claude/hooks/harness-registry.mjs` 를 dynamic import 로 읽는다
//  — kit 소스 트리와 발행물의 상대 배치가 달라 정적 import 로는 양쪽을 동시에 만족시킬 수 없기 때문이다.
//
// ⚠ 런타임 의존 0 — 훅의 계약이다. node 내장만 쓴다(여기선 path/os 조차 안 쓰고 호출부가 HOME 을 넘긴다).

// ── 하네스 식별 ────────────────────────────────────────────────────────────
// 지원 목록. 새 하네스는 여기 + 아래 표에만 추가하면 된다.
export const HARNESS_IDS = ["claude", "codex", "opencode", "antigravity", "grok"];

// 하네스 결정 — argv `--harness <n>` > env LIVELY_HARNESS > 기본 claude.
//  ⚠ 기본이 claude 인 건 종전 규약이다(미설정 = claude). 바꾸면 구설치가 조용히 다른 하네스로 취급된다.
//  ⚠ **모르는 값도 그대로 돌려준다**(정규화하지 않는다) — 종전 훅들의 동작이 그랬고, 이 값은 매니페스트 키와
//   게이트웨이 질의(`?harness=`)에 그대로 쓰이기 때문이다. 여기서 조용히 claude 로 바꾸면 오타 하나가
//   '남의 하네스 자산을 내 디스크에 깔았다'로 번진다. 표 조회(harness())만 claude 로 폴백한다(종전 placement 와 동일).
export function resolveHarness(argv = [], env = {}) {
  const i = Array.isArray(argv) ? argv.indexOf("--harness") : -1;
  return ((i > -1 ? argv[i + 1] : "") || env.LIVELY_HARNESS || "").toLowerCase().trim() || "claude";
}

// 이 값이 우리가 아는 하네스인가 — 진단·경고용(결정에는 쓰지 않는다).
export const isKnownHarness = (id) => HARNESS_IDS.includes(id);

// ── grok compat 이중발화 가드 (#1701) ─────────────────────────────────────────
// grok 은 ~/.claude/settings.json 의 훅을 **기본값으로 그대로 로드·실행**한다(compat — 실측). 즉 우리가 claude 에
//  등록한 러너들이 grok 세션에서도 돈다. 그 사본이 그대로 돌면 ① 같은 러너가 grok 네이티브 배선(grok-adapter)과
//  **두 번** 돌고 ② snake_case 파서가 grok 의 camelCase 페이로드를 오파싱해 "반쯤 되는" 상태가 된다(가장 나쁜 부류).
//  판정: GROK_HOOK_EVENT 는 grok 훅 러너가 **훅 프로세스에만** 항상 주입하는 예약 env 다(실측 — 세션의 툴
//  서브프로세스엔 없다. GROK_SESSION_ID 로 판정하면 grok 안에서 띄운 중첩 claude 세션까지 오탐한다). 그 env 가
//  있는데 우리 스스로 grok 경로로 부른 게 아니면(= grok-adapter 가 LIVELY_HARNESS=grok 으로 스폰) compat 경유
//  사본이므로 조용히 비켜선다. claude·codex·opencode 세션엔 GROK_HOOK_EVENT 가 없어 영향 0.
export function isForeignGrokInvocation(argv = process.argv.slice(2), env = process.env) {
  return !!env.GROK_HOOK_EVENT && resolveHarness(argv, env) !== "grok";
}

// path.join 을 안 쓰고 직접 잇는다(이 모듈은 내장 의존조차 두지 않는다는 계약). 구분자는 호출부 플랫폼을 따른다.
const SEP = process.platform === "win32" ? "\\" : "/";
const j = (...parts) => parts.filter(Boolean).join(SEP);

// ── 표 ────────────────────────────────────────────────────────────────────
// 각 하네스는 아래 축을 채운다. 축을 하나 늘리면 **모든 하네스가 그 축을 답해야** 한다 — 그게 '빠진 자리'를 없애는 방법이다.
//
//  home(HOME, env)      설정·자산이 사는 디렉터리
//  configFile(home)     그 하네스의 설정 파일(진단·배선 판정의 대상)
//  wiring               배선 방식: "settings-merge"(JSON 머지) | "sentinel-block"(파일 안 관리블록) | "plugin-file"(파일로 놓는 모듈)
//  assets[kind]         자산 배치 — {root(home), dir(디렉터리형인가), ext, compose(본문 변환기 이름)}
//  tools                이 하네스가 툴을 부르는 이름 — matcher 는 반드시 여기서 파생시킨다
//  mcp                  MCP 등록 스키마의 형태(설치기가 분기하는 지점)
//  autoApprove          자동승인 표면 — {kind, key(server,tool)}. kind 가 곧 reconcile 전략의 키다.
//  contextEnvelope      컨텍스트 주입 봉투: "raw" | "json" | "file"
//  reloadAssets         자산 변경이 같은 세션에 반영되나
//  events               우리 8이벤트 중 이 하네스가 지원하는 것(러너 배선 대상)
//
// ※ claude·codex 값은 **현재 동작을 그대로 옮긴 것**이다(테이블화는 동작 무변경). opencode 값은 #1519 실측
//   ([[opencode-harness-spec-1519]])에서 왔고, 아직 배선에 쓰이지 않는다(데이터만 먼저 둔다).

export const HARNESS = {
  claude: {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    // CLAUDE_CONFIG_DIR = 프로필별 계정 격리(#346). 없으면 <HOME>/.claude.
    home: (HOME, env = process.env) => env.CLAUDE_CONFIG_DIR || j(HOME, ".claude"),
    configFile: (home) => j(home, "settings.json"),
    configFormat: "json",
    wiring: "settings-merge",
    assets: {
      skill: { root: (h) => j(h, "skills"), dir: true, ext: "", compose: "markdown" },
      subagent: { root: (h) => j(h, "agents"), dir: false, ext: ".md", compose: "markdown" },
      command: { root: (h) => j(h, "commands"), dir: false, ext: ".md", compose: "markdown" },
    },
    tools: {
      // 파일 편집 — work-flag 의 '기록 인정' matcher 가 쓴다.
      edit: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
      shell: ["Bash"],
      read: ["Read", "Grep", "Glob"],
      skill: ["Skill"],
      // MCP 툴 이름 조합 — matcher 를 문자열로 박지 말고 반드시 이걸로 만든다(하네스마다 형태가 다르다).
      mcp: (server, tool = "") => `mcp__${server}__${tool}`,
      mcpMatcher: (server) => `mcp__${server}__.*`,
    },
    mcp: { style: "claude-cli" },          // `claude mcp add --transport stdio …`
    autoApprove: { kind: "settings-allow", key: (server, tool) => `mcp__${server}__${tool}` },
    contextEnvelope: "raw",                // SessionStart raw stdout 이 곧 컨텍스트
    reloadAssets: true,                    // reloadSkills:true 로 같은 세션 반영
    events: ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "Notification", "PreCompact", "PostCompact"],
  },

  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    home: (HOME) => j(HOME, ".codex"),
    configFile: (home) => j(home, "config.toml"),
    configFormat: "toml",
    wiring: "sentinel-block",
    assets: {
      // 스킬은 Agent Skills 오픈표준 = claude 와 **같은 파일**.
      skill: { root: (h) => j(h, "skills"), dir: true, ext: "", compose: "markdown" },
      // 서브에이전트만 TOML(포맷이 다르다) · 커맨드는 커스텀 프롬프트(`/prompts:<id>`, 최상위 .md 만 스캔).
      subagent: { root: (h) => j(h, "agents"), dir: false, ext: ".toml", compose: "codex-toml" },
      command: { root: (h) => j(h, "prompts"), dir: false, ext: ".md", compose: "codex-prompt" },
    },
    tools: {
      edit: ["apply_patch"],               // codex 는 편집 툴이 이것 하나다
      shell: ["Bash"],
      read: [],                            // 전용 툴 없음(셸로 한다)
      skill: [],                           // Skill 툴 없음 — 스킬은 프롬프트 인라인(#1475 §3 의 tracker 갭 원인)
      mcp: (server, tool = "") => `mcp__${server}__${tool}`,
      mcpMatcher: (server) => `mcp__${server}__.*`,
    },
    // ⚠ command 는 **문자열**, args 는 배열(0.142.0 실측). 배열을 넣으면 config.toml 전체가 로드 실패한다.
    mcp: { style: "toml-table", commandShape: "string+args" },
    autoApprove: { kind: "toml-approval", key: (_s, tool) => tool },
    contextEnvelope: "json",               // SessionStart 는 JSON 봉투 필수(raw 는 무시된다)
    reloadAssets: false,                   // 재시작해야 반영
    // codex 에 없는 것: SessionEnd · Notification. codex 에만 있는 것: PermissionRequest · SubagentStart
    //  (후자는 서버 org_hook event 허용목록에 없어 러너 배선 대상이 아니다 — #1475 CODEX_RUNNER_EVENTS 주석 참조).
    events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "PreCompact", "PostCompact"],
  },

  opencode: {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    // ⚠ `~/.opencode/` 가 아니다 — XDG 규약. 실측(번들 소스): `XDG_CONFIG_HOME || homedir()/.config` + 앱이름,
    //  그리고 이 계산은 **플랫폼 무관**이다(Windows 에서도 APPDATA 가 아니라 `%USERPROFILE%\.config\opencode`).
    //  ⚠ XDG_CONFIG_HOME 을 설정한 사용자에게 이걸 무시하면 우리는 `~/.config/opencode` 에 쓰고 opencode 는
    //   다른 곳을 봐서 **어댑터가 영영 로드되지 않는다**(에러도 안 난다 — 그냥 훅이 안 돈다).
    // ⚠ LIVELY_HOME(샌드박스 격리)이 설정된 경우엔 XDG_CONFIG_HOME 을 **따르지 않는다.** LIVELY_HOME 은
    //  "이 프로세스의 홈을 여기로 봐라"는 계약인데, XDG 가 그걸 뚫으면 격리가 새어 **테스트가 실 환경을
    //  오염시킨다**(실측: `lively status`/`install` 을 돌리는 테스트가 XDG 아래에 opencode 설정을 만들었다).
    //  실사용에선 LIVELY_HOME 이 없으므로 종전대로 XDG 를 존중한다.
    home: (HOME, env = process.env) => j(env.LIVELY_HOME ? j(HOME, ".config") : (env.XDG_CONFIG_HOME || j(HOME, ".config")), "opencode"),
    configFile: (home) => j(home, "opencode.json"),
    configFormat: "json",
    // 훅이 command 등록이 아니라 **파일로 놓는 JS 모듈**이다 — claude·codex 와 다른 배선 방식.
    wiring: "plugin-file",
    pluginDir: (home) => j(home, "plugin"),
    assets: {
      // 스킬은 오픈표준이라 claude 와 같은 파일. 에이전트·커맨드는 **파일 형태만** 같고 frontmatter 스키마가 다르다.
      //  ⚠ claude frontmatter 를 그대로 넘기면 opencode 가 `Configuration is invalid` 로 거부하고,
      //   그러면 **그 파일 하나 때문에 스킬까지 통째로 안 로드된다**(실측: 에이전트 1개 → 스킬 25개가 0개로).
      //   codex 의 `model`·`tools` 미이식과 같은 판단이며, opencode 는 피해가 그 파일 밖으로 번진다는 게 다르다.
      skill: { root: (h) => j(h, "skill"), dir: true, ext: "", compose: "markdown" },
      subagent: { root: (h) => j(h, "agent"), dir: false, ext: ".md", compose: "opencode-agent" },
      command: { root: (h) => j(h, "command"), dir: false, ext: ".md", compose: "opencode-command" },
    },
    tools: {
      // ⚠ 전부 **소문자**다. claude 의 `Edit|Write|…` 정규식은 여기서 한 번도 안 걸린다(조용한 무력화).
      edit: ["edit", "write"],
      shell: ["bash"],
      read: ["read", "grep", "glob"],
      skill: ["skill"],                    // Skill 툴이 있다 → codex 에서 못 열던 spec-blind tracker 가 여기선 산다
      // ⚠ MCP 툴 이름이 `<server>_<tool>` 이다(실측: lively_whoami). `mcp__lively__.*` 는 절대 안 걸린다.
      mcp: (server, tool = "") => `${server}_${tool}`,
      mcpMatcher: (server) => `${server}_.*`,
    },
    // ⚠ command 는 **항상 배열**, type 필수 — codex 와 정반대다.
    mcp: { style: "json-object", commandShape: "array", typeKey: true },
    autoApprove: { kind: "config-permission", key: (server, tool) => `${server}_${tool}` },
    // 정적 컨텍스트는 AGENTS.md/instructions 로 싣는다 — system.transform 은 **매 요청** 돌아 토큰이 반복된다.
    contextEnvelope: "file",
    contextFile: (home) => j(home, "AGENTS.md"),
    reloadAssets: false,                   // 기동 시 1회 로드, hot-reload 없음
    // 플러그인 훅 이름으로의 매핑(러너 배선이 아니라 어댑터가 구독할 자리).
    events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PreCompact", "PostCompact"],
    eventMap: {
      SessionStart: "event:session.created",
      UserPromptSubmit: "chat.message",
      PreToolUse: "tool.execute.before",
      PostToolUse: "tool.execute.after",
      Stop: "event:session.idle",
      PreCompact: "experimental.session.compacting",
      PostCompact: "experimental.compaction.autocontinue",
      // SessionEnd 대응물 없음(codex 와 같은 갭) · 승인대기는 permission.ask
      PermissionRequest: "permission.ask",
    },
  },

  antigravity: {
    id: "antigravity",
    label: "Antigravity CLI",
    bin: "agy",
    // `~/.gemini` — env 경로 오버라이드 **없음**(agy 1.1.13 실측: $HOME 만 본다. XDG 무관 — opencode 와 다르다).
    //  글로벌 커스터마이제이션 루트는 <home>/config (skills/·agents/·workflows/·plugins/·hooks.json·mcp_config.json).
    home: (HOME) => j(HOME, ".gemini"),
    // 진단·배선 판정 대상 = CLI 승인 설정(permissions.allow). 훅·MCP 는 플러그인 디렉터리에 있다(아래 pluginDir).
    configFile: (home) => j(home, "antigravity-cli", "settings.json"),
    configFormat: "json",
    // 배선 방식 4번째(plugin-dir): MCP·룰은 **우리 소유 플러그인 디렉터리**(비파괴가 구조로 보장),
    //  ⚠ 훅만은 글로벌 `<home>/config/hooks.json` 에 top-level 키("lively") 단위 비파괴 머지다 —
    //  문서는 플러그인 hooks.json 도 읽는다지만 실기기(1.1.13) 훅 스캐너는 글로벌 루트·워크스페이스만 봤다(#1689 E2E).
    wiring: "plugin-dir",
    pluginDir: (home) => j(home, "config", "plugins", "lively"),
    assets: {
      // 스킬은 Agent Skills 오픈표준 = claude 와 같은 파일(#1689 실측: 글로벌 skills/ 광고 확인).
      // ⚠ opencode 와 달리 `~/.claude/skills` 자동 로드가 **없다** — antigravity 자리에 별도 materialize 필수.
      skill: { root: (h) => j(h, "config", "skills"), dir: true, ext: "", compose: "markdown" },
      // 서브에이전트는 **디렉터리형인데 엔트리 파일명이 agent.md** 다(skills 의 SKILL.md 와 다름 — dirFile 축).
      subagent: { root: (h) => j(h, "config", "agents"), dir: true, ext: "", dirFile: "agent.md", compose: "antigravity-agent" },
      // 커맨드 등가 = workflows/*.md — `/이름` 으로 호출된다(#1689 실측: print 모드 포함).
      command: { root: (h) => j(h, "config", "workflows"), dir: false, ext: ".md", compose: "antigravity-workflow" },
    },
    tools: {
      // 실측(#1689): 신규 파일 생성 = write_to_file. replace_file_content 는 바이너리 강정황(발화 미실측).
      //  ⚠ 스텝타입 유도 목록(propose_code 등)에 없는 이름이었다 — 툴 이름은 실측만 믿는다.
      edit: ["write_to_file", "replace_file_content"],
      shell: ["run_command"],
      read: ["view_file", "grep_search", "list_dir"],
      skill: [],                           // 전용 Skill 툴 없음 — 스킬 본문은 view_file(IsSkillFile) 로 읽는다
      // ⚠ antigravity 의 MCP 호출은 이름이 전부 `call_mcp_tool` 이고 서버·툴은 args(ServerName/ToolName)에 온다
      //  — 이름 접두어 파싱이 원리적으로 불가하다. **어댑터(antigravity-adapter.mjs)가 args 를 읽어
      //  `mcp__<server>__<tool>`(claude 형)로 정규화한 뒤** 러너에 넘기므로, 표의 mcp 축은 claude 형이다.
      //  이 정규화 계약은 antigravity-adapter.test.mjs 가 고정한다.
      mcp: (server, tool = "") => `mcp__${server}__${tool}`,
      mcpMatcher: (server) => `mcp__${server}__.*`,
    },
    // MCP 는 플러그인 디렉터리의 mcp_config.json 파일로 등록(파일이 통째로 우리 것 — 머지 불요).
    //  스키마: command=**문자열** + args=배열(codex 형과 같고 opencode 의 command 배열과 다름) 또는 serverUrl.
    mcp: { style: "plugin-mcp-file", commandShape: "string+args" },
    // 승인은 CLI settings.json 의 permissions.allow — 규칙 문법이 `mcp(<server>/<tool>)` 다(와일드카드 `*` 성립, #1689 실측).
    autoApprove: { kind: "agy-settings-allow", key: (server, tool) => `mcp(${server}/${tool || "*"})` },
    // 정적 컨텍스트는 플러그인 rules/AGENTS.md 로 싣는다(네이티브 로드·경로 dedup — opencode 의 file 봉투와 동형).
    //  PreInvocation injectSteps 는 **매 모델 호출마다** 발화라 org-context 를 싣기에 부적합(#1689 실측).
    contextEnvelope: "file",
    contextFile: (home) => j(home, "config", "plugins", "lively", "rules", "AGENTS.md"),
    reloadAssets: false,                   // hot-reload 미확인(#1689) — 보수적으로 false
    // 러너 배선 대상 — agy 훅 이벤트는 5종뿐(PreToolUse·PostToolUse·PreInvocation·PostInvocation·Stop).
    //  UserPromptSubmit·SessionEnd 등가물 없음(정직 표기). SessionStart 는 PreInvocation 의 invocationNum==0 판정.
    events: ["SessionStart", "PreToolUse", "PostToolUse", "Stop"],
    eventMap: {
      SessionStart: "PreInvocation#0",     // invocationNum==0 인 PreInvocation — 어댑터가 판정
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      Stop: "Stop",
    },
  },

  grok: {
    id: "grok",
    label: "Grok Build",
    bin: "grok",
    // `$GROK_HOME` > `~/.grok` — XDG 무관(1.0.3 소스 전수 grep 0건, [[grok-harness-spec-1701]] §2-1).
    //  ⚠ grok 쪽은 OnceLock 메모이즈라 프로세스 시작 전에 env 가 놓여 있어야 한다(런타임 변경 무효).
    //  ⚠ LIVELY_HOME(샌드박스 격리)이 설정되면 GROK_HOME 을 따르지 않는다 — opencode 의 XDG 와 같은 계약:
    //   개발자 실환경의 GROK_HOME 이 테스트 격리를 뚫으면 테스트가 실 grok 홈을 오염시킨다.
    home: (HOME, env = process.env) => (env.LIVELY_HOME ? j(HOME, ".grok") : (env.GROK_HOME || j(HOME, ".grok"))),
    configFile: (home) => j(home, "config.toml"),
    configFormat: "toml",
    // 배선 방식: 훅은 **우리 소유 JSON 파일**(<home>/hooks/lively-grok.json — 파일이 통째로 우리 것이라
    //  비파괴가 구조로 보장, opencode plugin-file 과 동형) + MCP·permission·compat 는 config.toml 센티넬 머지.
    //  ⚠ 훅 파일은 **심링크 금지·복사만** — grok 은 정규 파일·비심링크·nlink==1 만 로드하고(무음 스킵),
    //   샌드박스 프로파일은 심링크 grok 홈이면 기동 자체를 거부한다(#1701 실측).
    wiring: "hook-file",
    hooksDir: (home) => j(home, "hooks"),
    assets: {
      // 스킬은 Agent Skills 오픈표준 = claude 와 같은 파일. grok 파서는 3중 fail-soft 라 불량 스킬이
      //  이웃을 못 죽인다(opencode 와 정반대 — 그래도 이식 최소셋 규칙은 유지). 동명이면 네이티브가
      //  ~/.claude/skills compat 사본을 이긴다(실측) — materialize 해도 중복 표시가 안 생긴다.
      skill: { root: (h) => j(h, "skills"), dir: true, ext: "", compose: "markdown" },
      // 서브에이전트는 md frontmatter(관용 파서 실측)지만 claude 의 model 슬러그·tools 의 런타임 의미는
      //  미실측 — codex·opencode·antigravity 와 같은 판단으로 이식 가능 최소셋(name·description·본문)만 넘긴다.
      //  ⚠ ~/.claude/agents compat 는 없다(compat 의 agents 셀은 지침 파일용) — grok 자리 materialize 필수.
      subagent: { root: (h) => j(h, "agents"), dir: false, ext: ".md", compose: "grok-agent" },
      // 커맨드 = commands/*.md flat — claude 레거시 레이아웃 그대로, frontmatter(description)도 해석(실측).
      command: { root: (h) => j(h, "commands"), dir: false, ext: ".md", compose: "markdown" },
    },
    tools: {
      // 실측(#1701 스텁 E2E 요청 body + xai-grok-agent/src/config.rs): 편집은 search_replace(+별도 write 툴).
      edit: ["search_replace", "write"],
      // 내부 id run_terminal_cmd 를 클라이언트 노출명으로 리네임한 것 — matcher·페이로드 둘 다 이 이름이다.
      shell: ["run_terminal_command"],
      read: ["read_file", "grep", "list_dir"],
      skill: ["skill"],
      // ⚠ MCP 툴명 = `<server>__<tool>` (mcp__ 접두 **없음** — 실측 lively__whoami). grok 훅 matcher 엔
      //  claude 형 `mcp__…` 재작성이 **없다**(permission rules 전용) — mcp__lively__.* 를 쓰면 영영 안 걸린다.
      mcp: (server, tool = "") => `${server}__${tool}`,
      mcpMatcher: (server) => `${server}__.*`,
    },
    // MCP 는 config.toml [mcp_servers.<name>] — command **문자열** + args 배열 + env 테이블(codex 와 같은 형).
    mcp: { style: "toml-table", commandShape: "string+args" },
    // 승인은 config.toml [permission] allow 배열 — 규칙 문법이 `MCPTool(<server>__<tool>)` 다(glob `*` 성립).
    //  참고: ~/.claude/settings.json 의 `mcp__lively__*` 도 compat 로 읽혀 재작성되지만, compat off 사용자를
    //  위해 네이티브 명시가 정본이다.
    autoApprove: { kind: "grok-permission-allow", key: (server, tool) => `MCPTool(${server}__${tool || "*"})` },
    // SessionStart·UserPromptSubmit stdout 은 **무시**된다(관측 전용 — 실측) — 훅 stdout 주입 채널이 없다.
    //  정적 컨텍스트는 <home>/rules/*.md 가 전 프로젝트 글로벌로 항상 스캔되는 걸 쓴다(세션 시스템 프롬프트 1회).
    contextEnvelope: "file",
    contextFile: (home) => j(home, "rules", "lively.md"),
    reloadAssets: true,                    // 스킬 핫리로드 실측·문서 확인(수 초 내 반영 — 에이전트·커맨드는 미확인)
    // grok 은 15이벤트 중 우리 표준 10종이 **claude 와 같은 이름으로 1:1** 존재한다(eventMap 불요).
    //  전부 fail-open(차단은 PreToolUse deny · Stop/SubagentStop block 뿐 — antigravity 의 fail-closed 와 정반대).
    events: ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "Notification", "PreCompact", "PostCompact"],
  },
};

// ── 파생 헬퍼 — 호출부가 표를 직접 뒤지지 않게 한다(분기가 다시 흩어지는 걸 막는 자리) ──

export function harness(id) {
  return HARNESS[HARNESS_IDS.includes(id) ? id : "claude"];
}

// 자산 배치 — sync-harness-assets.placement() 가 쓰던 분기를 대체한다.
//  반환 { file, root, skillDir? } 또는 null(그 하네스가 이 종류를 지원 안 함).
export function placementFor(id, kind, assetId, HOME, env = process.env) {
  const h = harness(id);
  const spec = h.assets[kind];
  if (!spec) return null;
  const home = h.home(HOME, env);
  const root = spec.root(home);
  // 디렉터리형 자산의 엔트리 파일명은 기본 SKILL.md(스킬 표준). antigravity 서브에이전트처럼 다른 이름
  //  (agents/<n>/agent.md)이면 표의 dirFile 축이 답한다 — 파일명을 여기 하드코딩하면 그 하네스에서만 조용히 빗나간다.
  if (spec.dir) return { file: j(root, assetId, spec.dirFile || "SKILL.md"), skillDir: j(root, assetId), root };
  return { file: j(root, `${assetId}${spec.ext}`), root };
}

// 자산 스캔 디렉터리 — assetDirs() 가 쓰던 [kind, root, isDir, ext] 튜플.
//  ⚠ placementFor 와 **같은 표**에서 나오므로 둘이 어긋날 수 없다(종전엔 두 함수가 따로 하드코딩돼 어긋날 수 있었다).
export function assetDirsFor(id, HOME, env = process.env) {
  const h = harness(id);
  const home = h.home(HOME, env);
  return Object.entries(h.assets).map(([kind, spec]) => [kind, spec.root(home), spec.dir, spec.ext]);
}

// 회수(prune) 안전 검사에 쓰는 자산 디렉터리 이름 집합 — removeAsset 의 경로 화이트리스트가 표에서 파생된다.
//  종전엔 정규식에 `(skills|agents|commands|prompts)` 를 손으로 적어, 새 하네스의 디렉터리명을 빠뜨리면
//  회수가 조용히 안 돌아 '중앙에서 지운 자산이 멤버 디스크에 영원히 남는' 결함이 됐다.
export function assetDirNames() {
  const names = new Set();
  for (const id of HARNESS_IDS) {
    for (const spec of Object.values(HARNESS[id].assets)) {
      // home 을 빈 문자열로 넘기면 j() 의 filter(Boolean) 이 그 자리를 지워 디렉터리명만 남는다.
      const r = spec.root("");
      names.add(r.split(/[/\\]/).pop());
    }
  }
  return names;
}

// 툴 이름 → matcher 정규식. 하네스마다 이름도 대소문자도 다르므로 **문자열 리터럴을 코드에 박지 않는다**.
export function toolMatcher(id, group) {
  const list = harness(id).tools[group] || [];
  return list.length ? list.join("|") : null;      // null = 그 하네스엔 해당 툴이 없다(배선하지 않는다)
}

// MCP 서버 툴 matcher(우리 서버 호출 관측용).
export function mcpMatcher(id, server = "lively") {
  return harness(id).tools.mcpMatcher(server);
}

// 전 하네스의 툴 이름 합집합 — "어느 하네스에서 왔든 이건 편집 툴이다" 같은 **하네스 무관 판정**에 쓴다.
//  합집합이 안전한 이유: 하네스마다 이름 공간이 겹치지 않는다(claude 는 `apply_patch`·`edit` 를 내지 않고,
//  codex 는 `Edit`·`edit` 를 내지 않는다). 그래서 추가는 가산적이고 오탐을 만들지 않는다.
//  ⚠ 손으로 적은 집합을 쓰면 하네스를 추가할 때마다 이 집합이 스테일해져 그 하네스에서만 판정이 조용히 빠진다.
export function allToolNames(group) {
  const out = new Set();
  for (const id of HARNESS_IDS) for (const t of harness(id).tools[group] || []) out.add(t);
  return out;
}

// 이 툴 호출이 우리 MCP 서버 것인가 — 맞으면 **서버 접두어를 뗀 bare 이름**, 아니면 null.
//  하네스마다 접두어 형태가 다르다(`mcp__lively__whoami` vs `lively_whoami`) — 문자열을 코드에 박으면
//  한쪽 하네스에서 판정이 **항상 false** 가 되어 세션 상태·기록 인정이 통째로 무음이 된다(#1519 §4).
export function mcpToolName(id, server, full) {
  const prefix = harness(id).tools.mcp(server, "");
  const s = String(full || "");
  return s.startsWith(prefix) ? s.slice(prefix.length) : null;
}
