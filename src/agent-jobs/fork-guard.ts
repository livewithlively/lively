// 분기 실행(#4489 앱 v2-10)의 도구 경계 — 하네스의 PreToolUse 훅으로 도는 작은 판정기. 글자로만 있다(순수).
//
// ── 왜 훅인가(설계 §12 ④ 실측) ─────────────────────────────────────────────────
//  분기는 본 세션과 같은 모델·도구·MCP 구성이어야 대화 앞부분 캐시가 맞는다. `--tools` · `--disallowedTools` · `--strict-mcp-config` ·
//  권한 거부 규칙은 도구 정의를 바꿔 캐시를 통째로 깬다. PreToolUse 훅은 정의를 그대로 두고 **실행만** 막는다(실측 2026-10-20 · claude 2.1.303:
//  39만 토큰 분기에서 캐시 읽기 39.1만 / 새로 0.25만 · Bash 는 실행 전에 막힘). `--allowedTools` 는 자동 승인 목록이지 경계가 아니다
//  (src/org/delivery/liv-turn.ts 머리말).
//
// ── 무엇을 여나(상민 2026-10-20 결정 ②) ────────────────────────────────────────
//  세션 대화(이미 맥락에 있다) + 그 앱의 표 읽기 + 작업 폴더 파일 읽기(숨김·비밀 파일 제외) + 라이블리 읽기 도구(FORK_LIVELY_READ_TOOLS — 이름으로
//  적은 목록). 쓰기 · 셸 실행 · 웹 · 하위 에이전트 · 라이블리 밖 MCP 는 막는다. 라이블리 쓰기는 게이트웨이도 막는다 — 분기는 `x-lively-mode=readonly` 로
//  돈다(#1007). 판은 이 훅 말고 둘째 문도 둔다 — 권한 모드 `dontAsk`(이 훅이 허락하지 않은 도구는 묻지 않고 거절 — 훅이 죽거나 시간을 넘겨도 셸이
//  돌지 않는다 · fork-boot.ts).
//  Claude 세션만이다 — Codex 는 후속 #4920(셸로 파일을 읽어 셸 해석이 필요하다 · 진짜 codex 로 검증하며 다시 들인다).
//
// ── 경로는 하네스와 같게 읽는다 ─────────────────────────────────────────────────
//  claude 의 Grep · Glob · LS 는 `path` 를 앞뒤 공백을 걷고 `~` 를 홈으로 펼쳐 쓴다(격리 리뷰 — claude 2.1.304). 판정기가 그대로 `path.resolve` 하면
//  « ~» · « /etc» 를 작업 폴더 안의 이름으로 읽어 홈 · 파일시스템 전체를 열어 준다. 그래서 앞뒤 공백 · `~` 로 시작하는 경로는 막는다.
//  claude 의 Grep 은 숨김 파일까지 뒤진다(실측: 작업 폴더의 .env 줄이 결과에 나왔다) — 그래서 Grep 은 입력을 고쳐 «숨김·비밀 파일 제외»
//  글로브를 **맨 뒤에** 붙인다(updatedInput · 뒤의 글로브가 이긴다 — 실측: `*.txt !.*` 면 숨김 폴더 안 .txt 도 빠진다).
//
// ── 신뢰 경계 ────────────────────────────────────────────────────────────────
//  이 훅은 하네스 프로세스 안(작업 AI 와 같은 uid)에서 돈다. AI 가 훅을 끌 길은 쓰기 · 셸인데 그 둘을 이 훅이 막는다 — «쓰기 · 셸 막기» 가
//  첫째 일이다. 경로는 실제 경로(realpath)로 잰다(작업 폴더 안의 링크가 밖을 가리켜도 막힌다). 판정을 못 하면 **막는다**(설정을 못 읽음 ·
//  입력이 JSON 이 아님 · 예외). 작업 폴더의 `.claude/settings*.json` 이 `disableAllHooks` 를 켜도 판의 설정(`disableAllHooks: false`)이 이긴다(실측).

/** 판정기 설정 — 게이트웨이(service.onBoot)가 만들어 판이 임시 폴더에 쓴다. */
export interface ForkGuardConfig {
  /** 작업 폴더(컨테이너 경로) — 파일 읽기는 이 안에서만. */
  root: string;
  /** 요청한 앱 — 표 도구(store_*)는 이 앱 것만. */
  appId: string;
  /** 작업 폴더 기준 그 앱의 폴더(`.lively/apps/<앱>` — #4684). 숨김 폴더지만 이 자리만은 읽는다. 없으면 null. */
  appFolder: string | null;
  /** 라이블리 MCP 서버 이름(멤버 설정의 `mcpServers.lively`). */
  livelyServer: string;
  /** 열어 둘 라이블리 도구 이름(forkLivelyReadTools). */
  livelyAllow: string[];
}

/** 훅 스크립트 안에서 «비밀이 든 파일» 로 보는 이름(작업 폴더 안 · 숨김 아닌 것) — 시험이 같은 표를 쓴다. */
export const FORK_SECRET_FILE_RE = String.raw`^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|(credentials?|secrets?|service[-_]?account)(\.[a-z0-9]{1,8})?|.+\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk))$`;
/** claude Grep 에 맨 뒤로 붙이는 제외 글로브 — 숨김(점으로 시작) · 비밀 이름. ripgrep 은 뒤의 글로브가 이긴다. */
export const FORK_GREP_EXCLUDE = ["!.*", "!*.pem", "!*.key", "!*.p12", "!*.pfx", "!*.jks", "!*.keystore", "!*.kdbx", "!*.ppk",
  "!id_rsa*", "!id_dsa*", "!id_ecdsa*", "!id_ed25519*", "!credential*", "!secret*", "!service*account*"] as const;

/**
 * 판정기 본체 — `node <이 글> <설정 파일>` 로 돈다(ES2020 · 노드 내장만). stdin = 하네스의 PreToolUse 입력 JSON.
 *  답: 허용이면 `permissionDecision: "allow"`(Grep 은 updatedInput 과 함께), 아니면 `deny` + 사람이 읽을 사유(AI 가 그 사유를 보고 다른 길을 찾는다).
 *  ⚠ String.raw — 안에 백틱과 `${` 를 쓰지 않는다.
 */
export const FORK_GUARD_SOURCE = String.raw`"use strict";
const fs = require("fs"), path = require("path");
//  동기 쓰기 — 곧바로 process.exit 하므로(macOS 의 파이프 stdout 은 비동기라 write 뒤 exit 면 잘릴 수 있다).
const out = (o) => { try { fs.writeSync(1, JSON.stringify(o) + "\n"); } catch (e) {} };
const deny = (why) => {
  out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "앱 분기 실행 — " + why } });
  process.exit(0);
};
const allow = (updatedInput) => {
  const o = { hookEventName: "PreToolUse", permissionDecision: "allow" };
  if (updatedInput) o.updatedInput = updatedInput;
  out({ hookSpecificOutput: o });
  process.exit(0);
};
let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch (e) { cfg = null; }
const SECRET = new RegExp(CFG_SECRET_RE, "i");
const GREP_EXCLUDE = CFG_GREP_EXCLUDE;

let ROOT = null;
function rootOf() {
  if (ROOT) return ROOT;
  ROOT = fs.realpathSync(String(cfg.root));
  return ROOT;
}
//  실제 경로 — 있는 가장 가까운 조상의 realpath 에 나머지를 붙인다(없는 파일도 «어디를 가리키나» 로 잰다).
function realOf(p) {
  let cur = path.resolve(rootOf(), p);
  const rest = [];
  for (let i = 0; i < 256; i++) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); }
    catch (e) {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(rootOf(), p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  return cur;
}
//  경로를 읽어도 되나 — 안 되면 사유, 되면 null. 하네스는 앞뒤 공백을 걷고 ~ 를 홈으로 펼쳐 읽는다 — 그 둘은 여기서 막는다(머리말).
function pathRefusal(p) {
  if (typeof p !== "string" || !p.trim()) return "경로가 비었습니다";
  if (p.indexOf("\u0000") >= 0) return "경로에 쓸 수 없는 문자가 있습니다";
  if (p !== p.trim()) return "앞뒤에 공백이 있는 경로는 읽지 않습니다: " + JSON.stringify(p);
  if (p.charAt(0) === "~") return "~ 로 시작하는 경로(홈 폴더)는 읽지 않습니다 — 작업 폴더 기준 경로를 쓰세요: " + p;
  const root = rootOf();
  const real = realOf(p);
  const rel = path.relative(root, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "작업 폴더(" + cfg.root + ") 밖은 읽지 않습니다: " + p;
  const segs = rel.split(path.sep).filter(Boolean);
  const app = cfg.appFolder ? String(cfg.appFolder).split("/").filter(Boolean) : null;
  const inApp = !!app && app.every((s, i) => segs[i] === s);
  const check = inApp ? segs.slice(app.length) : segs;
  if (check.some((s) => s.startsWith("."))) return "숨김 파일·폴더는 읽지 않습니다: " + p;
  if (segs.length && SECRET.test(segs[segs.length - 1])) return "비밀이 든 파일로 보여 읽지 않습니다: " + p;
  return null;
}
function needPath(p) { const why = pathRefusal(p); if (why) deny(why); }

function mcp(name, inp) {
  const pre = "mcp__" + cfg.livelyServer + "__";
  if (!name.startsWith(pre)) deny("라이블리 밖 연결 도구는 쓸 수 없습니다: " + name);
  const tool = name.slice(pre.length);
  if (!Array.isArray(cfg.livelyAllow) || cfg.livelyAllow.indexOf(tool) < 0) deny("'" + tool + "' 은(는) 쓸 수 없습니다 — 라이블리 도구는 업무 맥락을 읽는 것만 됩니다");
  if (tool.startsWith("store_") && inp.app_id !== undefined && inp.app_id !== null && inp.app_id !== "" && String(inp.app_id) !== cfg.appId) {
    deny("이 분기를 요청한 앱(" + cfg.appId + ")의 표만 읽을 수 있습니다");
  }
  allow();
}

function decide(ev) {
  const name = String(ev && ev.tool_name || "");
  const inp = ev && ev.tool_input && typeof ev.tool_input === "object" ? ev.tool_input : {};
  if (name.startsWith("mcp__")) return mcp(name, inp);
  switch (name) {
    case "Read": needPath(inp.file_path); return allow();
    case "NotebookRead": needPath(inp.notebook_path); return allow();
    case "LS": needPath(inp.path === undefined ? "." : inp.path); return allow();
    case "Glob": {
      if (inp.path !== undefined) needPath(inp.path);
      const pat = String(inp.pattern || "");
      if (!pat || pat !== pat.trim() || pat.startsWith("/") || pat.startsWith("~") || pat.split("/").some((s) => s === "..")) {
        deny("Glob 은 작업 폴더 안의 상대 패턴만 씁니다: " + pat);
      }
      return allow();
    }
    case "Grep": {
      if (inp.path !== undefined) needPath(inp.path);
      if (inp.glob !== undefined && typeof inp.glob !== "string") deny("glob 은 글이어야 합니다");
      const next = Object.assign({}, inp);
      next.glob = [inp.glob, ...GREP_EXCLUDE].filter((x) => typeof x === "string" && x.trim()).join(" ");
      return allow(next);
    }
    case "ToolSearch": case "TodoWrite": return allow();
    default:
      return deny("'" + name + "' 은(는) 쓸 수 없습니다 — 읽기(Read · Glob · Grep)와 라이블리 읽기 도구만 됩니다");
  }
}

if (!cfg || typeof cfg.root !== "string" || !Array.isArray(cfg.livelyAllow)) deny("판정기 설정을 읽지 못했습니다");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; if (raw.length > 4000000) deny("입력이 너무 큽니다"); });
process.stdin.on("end", () => {
  let ev;
  try { ev = JSON.parse(raw); } catch (e) { deny("입력을 읽지 못했습니다"); }
  try { decide(ev); } catch (e) { deny("판정하지 못했습니다: " + String(e && e.message || e).slice(0, 200)); }
  deny("판정이 끝나지 않았습니다");
});
`
  .replace("CFG_SECRET_RE", () => JSON.stringify(FORK_SECRET_FILE_RE))
  .replace("CFG_GREP_EXCLUDE", () => JSON.stringify(FORK_GREP_EXCLUDE));

/**
 * 분기에서 여는 라이블리 도구 — **이름으로 직접 적는다**. 고르는 자: 업무 맥락을 **읽는** 도구(지식 · 프로젝트 · 태스크 · 자료 · 활동 · 분류 ·
 *  팀 · 이 세션에 붙은 앱과 그 표). 라이블리 밖으로 나가는 도구(외부 서비스 · 웹 주소 · git 호스트) · 관리 설정 · 자격 · 서명 주소 · 다른 실행 기록 ·
 *  파일을 만드는 도구는 넣지 않는다. 늘릴 때는 «읽기만 하나 · 밖으로 나가나 · 무엇을 돌려주나» 를 본다.
 *  ⚠ «쓰기가 아님 + 이름 규칙으로 제외» 로 고르지 않는다(격리 리뷰 — GET 인데 파일을 쓰는 app_pull{dir} · 서버가 아무 주소로 나가는
 *   link_preview · 서명 주소를 내주는 file_url 이 그 규칙을 통과했다).
 */
export const FORK_LIVELY_READ_TOOLS: readonly string[] = [
  "activity_list",
  "category_edge_list", "category_get", "category_group_list", "category_list",
  "context_overview",
  "knowledge_classifications", "knowledge_get", "knowledge_grep", "knowledge_history", "knowledge_list", "knowledge_projects_v6", "knowledge_search", "knowledge_similar",
  "project_comments_v6", "project_get_v6", "project_grep", "project_list_v6", "project_search", "project_similar",
  "session_apps",
  "source_get", "source_list", "source_tree",
  "store_query", "store_tables",
  "task_detail_v6",
  "team_get", "team_list",
  "whoami", "workspace_people",
];

/**
 * (순수) 지금 열 라이블리 도구 — 위 목록 가운데 지금 표면에 있고 쓰지 않는 것(capMutates 거짓)만. 목록의 도구가 표면에서 쓰기로 바뀌거나
 *  사라지면 저절로 빠진다(부르는 쪽이 노출된 도구와 그 판정을 넘긴다 — registry 를 모르게).
 */
export function forkLivelyReadTools(tools: ReadonlyArray<{ name: string; mutates: boolean }>): string[] {
  const reads = new Set(tools.filter((t) => !t.mutates).map((t) => t.name));
  return FORK_LIVELY_READ_TOOLS.filter((n) => reads.has(n)).sort();
}
