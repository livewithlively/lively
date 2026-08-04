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
export const HARNESS_IDS = ["claude", "codex", "opencode"];

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
    home: (HOME, env = process.env) => j(env.XDG_CONFIG_HOME || j(HOME, ".config"), "opencode"),
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
  if (spec.dir) return { file: j(root, assetId, "SKILL.md"), skillDir: j(root, assetId), root };
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
