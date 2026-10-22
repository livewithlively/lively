// 분기 실행 도구 경계 판정기(#4489) — **진짜 노드 프로세스**로 돌려 판정을 본다. 행 번호(G1~G20 · G32 · G37~G40 · N1~N2 · L1)는 사양 엣지 표
//  (지식 app-session-fork-asbuilt-4489 «도구 경계»). 판정기는 하네스의 PreToolUse 훅으로 도는 글(FORK_GUARD_SOURCE)이라 그 글을 그대로
//  파일로 써서 돌린다 — stdin 에 하네스 입력 JSON, stdout 의 permissionDecision 을 단언한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FORK_GUARD_SOURCE, FORK_GREP_EXCLUDE, forkLivelyReadTools, type ForkGuardConfig } from "./fork-guard.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  try { fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lvly-fork-guard-")));
const ROOT = path.join(tmp, "work");
const OUTSIDE = path.join(tmp, "outside.txt");
fs.mkdirSync(path.join(ROOT, "sub", ".git"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "src"), { recursive: true });
fs.mkdirSync(path.join(ROOT, ".lively", "apps", "myapp"), { recursive: true });
fs.mkdirSync(path.join(ROOT, ".lively", "apps", "other"), { recursive: true });
for (const [f, body] of [
  ["a.txt", "a"], ["README.md", "r"], [".env", "SECRET=1"], ["sub/.git/config", "[core]"], ["server.pem", "k"], ["id_rsa", "k"],
  ["credentials.json", "{}"], [".lively/apps/myapp/x.md", "x"], [".lively/apps/other/x.md", "y"], ["src/x.ts", "export {}"],
] as const) fs.writeFileSync(path.join(ROOT, f), body);
fs.writeFileSync(OUTSIDE, "밖");
fs.symlinkSync(OUTSIDE, path.join(ROOT, "link-out"));
const GUARD = path.join(tmp, "guard.cjs");
fs.writeFileSync(GUARD, FORK_GUARD_SOURCE);

const baseCfg = (over: Partial<ForkGuardConfig> = {}): ForkGuardConfig => ({
  root: ROOT, appId: "myapp", appFolder: ".lively/apps/myapp", livelyServer: "lively",
  livelyAllow: ["knowledge_get", "store_query", "store_tables"], ...over,
});
let cfgN = 0;
/** 판정 한 번 — 결정('allow' | 'deny')과 고친 입력을 돌려준다. 설정을 안 주면(null) 없는 파일 경로를 넘긴다. */
function decide(cfg: ForkGuardConfig | null, tool: string, input: Record<string, unknown>, raw?: string): { decision: string; reason: string; updated: Record<string, unknown> | null; status: number | null } {
  let cfgPath = path.join(tmp, "missing-config.json");
  if (cfg) { cfgPath = path.join(tmp, `cfg-${cfgN++}.json`); fs.writeFileSync(cfgPath, JSON.stringify(cfg)); }
  const r = spawnSync(process.execPath, [GUARD, cfgPath], {
    input: raw ?? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: ROOT }), encoding: "utf8", timeout: 10_000,
  });
  const line = String(r.stdout || "").trim().split("\n").filter(Boolean).pop() ?? "";
  let o: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } } = {};
  try { o = JSON.parse(line); } catch { /* 결정이 없으면 아래 단언이 실패한다 */ }
  return {
    decision: String(o.hookSpecificOutput?.permissionDecision ?? `(답 없음: ${line.slice(0, 120)} · stderr ${String(r.stderr).slice(0, 200)})`),
    reason: String(o.hookSpecificOutput?.permissionDecisionReason ?? ""),
    updated: o.hookSpecificOutput?.updatedInput ?? null,
    status: r.status,
  };
}
const C = baseCfg();
const allowOf = (cfg: ForkGuardConfig | null, tool: string, input: Record<string, unknown>): void => {
  const d = decide(cfg, tool, input);
  assert.equal(d.decision, "allow", `${tool} ${JSON.stringify(input)} 는 허용이어야 한다 — 사유: ${d.reason}`);
  assert.equal(d.status, 0);
};
const denyOf = (cfg: ForkGuardConfig | null, tool: string, input: Record<string, unknown>): void => {
  const d = decide(cfg, tool, input);
  assert.equal(d.decision, "deny", `${tool} ${JSON.stringify(input)} 는 거절이어야 한다`);
  assert.ok(d.reason.length > 0, "거절엔 사람이 읽을 사유가 붙는다");
};

try {
  t("G1 claude Read — 작업 폴더 안 보통 파일은 허용", () => allowOf(C, "Read", { file_path: path.join(ROOT, "a.txt") }));
  t("G1b claude Read — 상대 경로도 작업 폴더 기준", () => allowOf(C, "Read", { file_path: "src/x.ts" }));
  t("G2 claude Read — 절대 경로 밖(/etc/hosts)은 거절", () => denyOf(C, "Read", { file_path: "/etc/hosts" }));
  t("G3 claude Read — .. 로 빠져나가면 거절", () => denyOf(C, "Read", { file_path: path.join(ROOT, "..", "outside.txt") }));
  t("G4 claude Read — .env(숨김) 거절", () => denyOf(C, "Read", { file_path: path.join(ROOT, ".env") }));
  t("G5 claude Read — 숨김 폴더 안(sub/.git/config) 거절", () => denyOf(C, "Read", { file_path: path.join(ROOT, "sub/.git/config") }));
  t("G6 claude Read — 비밀 이름(server.pem · id_rsa · credentials.json) 거절", () => {
    for (const f of ["server.pem", "id_rsa", "credentials.json"]) denyOf(C, "Read", { file_path: path.join(ROOT, f) });
  });
  t("G7 claude Read — 요청한 앱 폴더(.lively/apps/myapp)는 허용", () => allowOf(C, "Read", { file_path: path.join(ROOT, ".lively/apps/myapp/x.md") }));
  t("G8 claude Read — 남의 앱 폴더(.lively/apps/other)는 거절", () => denyOf(C, "Read", { file_path: path.join(ROOT, ".lively/apps/other/x.md") }));
  t("G9 claude Read — 작업 폴더 안 링크가 밖을 가리키면 거절(실제 경로로 잰다)", () => denyOf(C, "Read", { file_path: path.join(ROOT, "link-out") }));
  t("G10 claude Read — 없는 파일(안)은 허용(도구가 알아서 실패한다)", () => allowOf(C, "Read", { file_path: path.join(ROOT, "missing.txt") }));
  t("G11 claude Grep — 글로브가 없으면 «숨김·비밀 제외» 묶음이 붙는다", () => {
    const d = decide(C, "Grep", { pattern: "SECRET", output_mode: "content" });
    assert.equal(d.decision, "allow");
    assert.equal(d.updated?.glob, FORK_GREP_EXCLUDE.join(" "));
    assert.ok(String(d.updated?.glob).startsWith("!.* "), "맨 앞 제외가 숨김(!.*)이다");
    assert.equal(d.updated?.pattern, "SECRET", "다른 칸은 그대로");
  });
  t("G12 claude Grep — 앱 글로브 뒤에 제외 묶음(뒤의 글로브가 이긴다)", () => {
    const d = decide(C, "Grep", { pattern: "x", glob: "*.ts" });
    assert.equal(d.decision, "allow");
    assert.equal(d.updated?.glob, ["*.ts", ...FORK_GREP_EXCLUDE].join(" "));
  });
  t("G13 claude Grep — path 가 밖이면 거절", () => denyOf(C, "Grep", { pattern: "x", path: "/etc" }));
  t("G14 claude Glob — 상대 패턴 허용 · 절대 · .. 거절", () => {
    allowOf(C, "Glob", { pattern: "src/**/*.ts" });
    denyOf(C, "Glob", { pattern: "/etc/*" });
    denyOf(C, "Glob", { pattern: "../*" });
  });
  t("G15 claude — Bash · Write · Edit · WebFetch · Agent 는 거절", () => {
    denyOf(C, "Bash", { command: "echo hi" });
    denyOf(C, "Write", { file_path: path.join(ROOT, "n.txt"), content: "x" });
    denyOf(C, "Edit", { file_path: path.join(ROOT, "a.txt"), old_string: "a", new_string: "b" });
    denyOf(C, "WebFetch", { url: "https://example.com" });
    denyOf(C, "Agent", { prompt: "x" });
  });
  t("G16 claude — ToolSearch · TodoWrite 는 허용", () => { allowOf(C, "ToolSearch", { query: "x" }); allowOf(C, "TodoWrite", { todos: [] }); });
  t("G17 허용 목록의 라이블리 도구(knowledge_get) 허용", () => allowOf(C, "mcp__lively__knowledge_get", { name: "x" }));
  t("G18 목록 밖 라이블리 도구(knowledge_save) 거절", () => denyOf(C, "mcp__lively__knowledge_save", {}));
  t("G19 claude store_query — 요청 앱 허용 · 다른 앱 거절 · app_id 없으면 허용", () => {
    allowOf(C, "mcp__lively__store_query", { app_id: "myapp", table: "t" });
    denyOf(C, "mcp__lively__store_query", { app_id: "other", table: "t" });
    allowOf(C, "mcp__lively__store_query", { table: "t" });
  });
  t("G20 claude — 라이블리 밖 MCP(mcp__claude_ai_Gmail__search) 거절", () => denyOf(C, "mcp__claude_ai_Gmail__search", { q: "x" }));
  t("G32 설정 없음 · 입력이 JSON 아님 → 거절(판정 못 하면 막는다)", () => {
    const a = decide(null, "Read", { file_path: path.join(ROOT, "a.txt") });
    assert.equal(a.decision, "deny");
    const b = decide(C, "Read", {}, "이건 JSON 이 아니다");
    assert.equal(b.decision, "deny");
  });
  //  G37~G40 — 하네스는 Grep · Glob · LS 의 path 를 앞뒤 공백을 걷고 ~ 를 홈으로 펼쳐 쓴다(격리 리뷰). 판정기는 그 둘을 막는다.
  t("G37 ~ 로 시작하는 경로(홈) — Grep · LS · Glob · Read 모두 거절", () => {
    denyOf(C, "Grep", { pattern: "x", path: "~" });
    denyOf(C, "Grep", { pattern: "x", path: "~/.lively" });
    denyOf(C, "LS", { path: "~" });
    denyOf(C, "Glob", { pattern: "*", path: "~" });
    denyOf(C, "Read", { file_path: "~/x" });
  });
  t("G38 앞뒤 공백이 든 경로 — 하네스가 걷어 밖을 읽는다 → 거절", () => {
    denyOf(C, "Grep", { pattern: "x", path: " /etc" });
    denyOf(C, "LS", { path: "\t/" });
    denyOf(C, "Read", { file_path: "a.txt " });
  });
  t("G39 Glob 패턴 — 앞뒤 공백 · ~ 로 시작하면 거절 · 작업 폴더 안 상대 패턴은 허용(대조군)", () => {
    denyOf(C, "Glob", { pattern: " /etc/*" });
    denyOf(C, "Glob", { pattern: "~/*" });
    allowOf(C, "Glob", { pattern: "src/*.ts" });
  });
  t("G40 이름 가운데 ~ · 공백은 글자 그대로(작업 폴더 안 파일 이름) — 허용", () => {
    allowOf(C, "Read", { file_path: "a~b.txt" });
    allowOf(C, "Read", { file_path: "my notes.md" });
  });
  //  G41 — 하네스는 경로를 NFC 로 접어 읽는다: 켈빈 기호(U+212A)로 쓴 my.Key 는 my.Key 다(재검토). 판정기도 같게 접어 비밀 이름으로 막는다.
  t("G41 NFC — 켈빈 기호로 쓴 비밀 이름(my.Key)도 거절 · 보통 한글 이름은 허용(대조군)", () => {
    denyOf(C, "Read", { file_path: "my.Key" });
    allowOf(C, "Read", { file_path: "회의록.md" });
  });
  //  G42 — Grep 제외 글로브는 대소문자를 가리지 않는다(ripgrep 글로브는 가린다 — 재검토 실측: Credentials.JSON · my.PEM 이 새었다).
  //   글로브를 정규식으로 옮겨(* · [..] 만 쓰는 꼴) 이름마다 제외되는지 본다 — 숨김 · 비밀 이름은 빠지고 보통 이름은 남는다.
  t("G42 Grep 제외 글로브 — 대문자 비밀 이름도 빠진다 · 보통 이름은 남는다", () => {
    const toRe = (g: string): RegExp => new RegExp("^" + g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
    const excluded = (name: string): boolean => FORK_GREP_EXCLUDE.some((g) => toRe(g.slice(1)).test(name));
    for (const n of ["Credentials.JSON", "my.PEM", "my.Key", "ID_RSA", "Secret.txt", "Service-Account.json", ".env", "server.pem"]) assert.ok(excluded(n), `${n} 가 빠지지 않는다`);
    for (const n of ["README.md", "src.ts", "keynote.md", "pemberton.txt"]) assert.ok(!excluded(n), `${n} 는 보통 파일인데 빠진다`);
  });
  t("N1 appFolder 가 없으면 .lively/apps/myapp 도 숨김으로 거절", () => denyOf(baseCfg({ appFolder: null }), "Read", { file_path: path.join(ROOT, ".lively/apps/myapp/x.md") }));
  t("N2 livelyAllow 가 비면 라이블리 도구 전부 거절", () => denyOf(baseCfg({ livelyAllow: [] }), "mcp__lively__knowledge_get", {}));
  t("N3 Bash · Write 는 어떤 설정이어도 거절(셸 갈래 없음 — Codex 는 #4920)", () => { denyOf(C, "Bash", { command: "cat a.txt" }); denyOf(baseCfg({ livelyAllow: [] }), "Write", { file_path: "a.txt", content: "" }); });
  t("L1 forkLivelyReadTools — 이름으로 적은 목록에 있고 지금 쓰지 않는 것만 · 목록 밖 읽기 도구(link_preview · file_url · app_pull)는 빠진다", () => {
    const got = forkLivelyReadTools([
      { name: "knowledge_save", mutates: true }, { name: "knowledge_get", mutates: false }, { name: "link_preview", mutates: false },
      { name: "file_url", mutates: false }, { name: "app_pull", mutates: false }, { name: "repo_discover", mutates: false },
      { name: "store_query", mutates: false }, { name: "project_get_v6", mutates: true }, { name: "org_runtime_config", mutates: false },
    ]);
    assert.deepEqual(got, ["knowledge_get", "store_query"], "목록의 project_get_v6 도 쓰기로 바뀌면 빠진다");
  });
  console.log(`\n${pass} 통과`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
