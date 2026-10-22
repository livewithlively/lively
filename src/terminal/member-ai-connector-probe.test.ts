// 구성원 Claude 커넥터 확인의 **스크립트·출력 판정** (#4213 T6 #4427) — 확인 스크립트는 그 사람 자리의 셸이 돌리는 문자열이라
//  TS 컴파일러가 안 본다. 그래서 실제 sh 로 가짜 claude 를 돌려 «무엇이 실제로 불렸나 · 어떤 env 로» 를 본다.
//  기록을 쓰는 오케스트레이션(정책 꺼짐 · 15초 · 저장)은 DB 가 필요해 org/store/member-ai-connectors.pg-test.mjs 가 본다.
//
//  엣지 표(사양 → 시나리오)
//   P1 @@nocli → no-cli            P2 빈 출력 · 표식 순서 뒤바뀜 → probe-output     P3 auth JSON 깨짐 → auth-unreadable
//   P4 loggedIn false → not-logged-in   P5 authMethod ≠ claude.ai → not-claude-ai-login   P6 정상 → 서버 목록
//   P7 exit 124 → timeout          P8 exit 1 → mcp-list-exit-1                      P9 exit 0 · 서버 0 → 빈 전체 목록([])
//   P10 auth 의 email·orgName 이 결과에 안 실린다     P11 @@exit 없이 잘림 · 목록 있음 → probe-output(잘린 뒤쪽이 removed 가 된다)
//   P12 @@exit 없이 잘림 · 목록도 빔 → probe-output(다 봤는지 모른다)
//   U1 «원래 있던 것이 전부 사라짐» 첫 번째 → 미확정   U2 바로 전 확인이 미확정이었으면 → 반영   U3 원래 없던 사람 → 반영
//   U4 claude.ai 가 하나라도 있으면 → 반영              U5 목록 못 얻음(null) → 해당 없음      U6 원래 있던 것이 전부 removed → 반영
//   X1 실제 sh + 가짜 claude · 토큰/차단 env 켠 채 → 가짜가 그 env 를 못 본다 · LIVELY_OFF=1 · HOME=준 홈 ·
//      --help 다음 auth 다음 «사용자 설정 뺀» list · 파싱 성공
//   X2 PATH 에 claude 없음 → no-cli     X3 홈 경로에 작은따옴표 → HOME 그대로
//   X4 --setting-sources 를 모르는 옛 claude → 플래그 없이 list
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { needsEmptyConfirmation, parseProbeOutput, probeScript, UNCONFIRMED_EMPTY } from "./member-ai-connector-probe.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const AUTH_OK = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.invalid", orgName: "Secret Org" });
const LIST = "Checking MCP server health…\n\nclaude.ai Slack: https://proxy.example.invalid/x - ✔ Connected\nlively: /bin/lively mcp - ✔ Connected\n";
const out = (auth: string, list: string, exit: string | null = "0"): string =>
  `@@auth\n${auth}\n\n@@list\n${list}${exit === null ? "" : `@@exit ${exit}\n`}`;

t("P1 CLI 가 없으면 no-cli", () => {
  assert.deepEqual(parseProbeOutput("@@nocli\n"), { servers: null, error: "no-cli" });
});

t("P2 빈 출력 · 표식 순서가 뒤바뀐 출력은 probe-output", () => {
  assert.deepEqual(parseProbeOutput(""), { servers: null, error: "probe-output" });
  assert.deepEqual(parseProbeOutput(`@@list\n${LIST}@@auth\n${AUTH_OK}\n`), { servers: null, error: "probe-output" });
});

t("P3 auth JSON 이 깨졌으면 auth-unreadable", () => {
  assert.deepEqual(parseProbeOutput(out("{not json", LIST)), { servers: null, error: "auth-unreadable" });
});

t("P4 로그인이 안 돼 있으면 목록이 아니라 not-logged-in", () => {
  assert.deepEqual(parseProbeOutput(out(JSON.stringify({ loggedIn: false }), LIST)), { servers: null, error: "not-logged-in" });
});

t("P5 claude.ai 로그인이 아니면(API 키 등) not-claude-ai-login", () => {
  assert.deepEqual(parseProbeOutput(out(JSON.stringify({ loggedIn: true, authMethod: "api_key" }), LIST)), { servers: null, error: "not-claude-ai-login" });
});

t("P6 정상이면 서버 목록", () => {
  assert.deepEqual(parseProbeOutput(out(AUTH_OK, LIST)), {
    servers: [{ name: "claude.ai Slack", status: "connected" }, { name: "lively", status: "connected" }], error: null,
  });
});

t("P7 목록 명령이 timeout(124)으로 끝나면 timeout", () => {
  assert.deepEqual(parseProbeOutput(out(AUTH_OK, LIST, "124")), { servers: null, error: "timeout" });
});

t("P8 목록 명령이 1로 끝나면 mcp-list-exit-1", () => {
  assert.deepEqual(parseProbeOutput(out(AUTH_OK, LIST, "1")), { servers: null, error: "mcp-list-exit-1" });
});

t("P9 로그인이 맞고 정상 종료인데 서버가 0이면 빈 전체 목록(연결한 앱이 없다)", () => {
  assert.deepEqual(parseProbeOutput(out(AUTH_OK, "Checking MCP server health…\n\nNo MCP servers configured. Use `claude mcp add` to add a server.\n")),
    { servers: [], error: null });
});

t("P10 auth 의 email·orgName 은 결과에 실리지 않는다", () => {
  const s = JSON.stringify(parseProbeOutput(out(AUTH_OK, LIST)));
  assert.ok(!s.includes("someone@example.invalid") && !s.includes("Secret Org"), s);
});

t("P11 @@exit 없이 잘렸으면 목록이 있어도 믿지 않는다(probe-output)", () => {
  assert.deepEqual(parseProbeOutput(out(AUTH_OK, LIST, null)), { servers: null, error: "probe-output" });
});

t("P12 @@exit 없이 잘렸는데 목록도 비었으면 probe-output(다 봤는지 모른다)", () => {
  assert.deepEqual(parseProbeOutput(out(AUTH_OK, "", null)), { servers: null, error: "probe-output" });
});

const view = (connectors: Array<{ app: string; status: string }>, scanError: string | null = null) => ({
  member_id: "m", provider: "claude" as const,
  scan: scanError === null ? { scanned_at: "", origin: "probe" as const, ok: true, error: null, connected: 0 } : { scanned_at: "", origin: "probe" as const, ok: false, error: scanError, connected: 0 },
  connectors: connectors.map((c) => ({ ...c, status: c.status as never, origin: "probe" as const, first_seen_at: "", seen_at: "", status_at: "" })),
});
const EMPTY = [{ name: "lively", status: "connected" }];

t("U1 원래 있던 커넥터가 한 번에 전부 사라진 첫 확인은 미확정이다", () => {
  assert.equal(needsEmptyConfirmation(EMPTY, view([{ app: "Slack", status: "connected" }])), true);
  assert.equal(needsEmptyConfirmation([], view([{ app: "Slack", status: "needs-auth" }])), true);
  assert.equal(UNCONFIRMED_EMPTY, "unconfirmed-empty");
});
t("U2 바로 전 확인이 미확정이었으면 이번엔 반영한다(두 번 연속)", () => {
  assert.equal(needsEmptyConfirmation(EMPTY, view([{ app: "Slack", status: "connected" }], UNCONFIRMED_EMPTY)), false);
});
t("U3 원래 없던 사람은 바로 반영한다", () => {
  assert.equal(needsEmptyConfirmation(EMPTY, view([])), false);
});
t("U4 claude.ai 커넥터가 하나라도 있으면 바로 반영한다(일부가 빠진 것은 끊은 것이다)", () => {
  assert.equal(needsEmptyConfirmation([{ name: "claude.ai Slack", status: "connected" }], view([{ app: "Slack", status: "connected" }, { app: "Notion", status: "connected" }])), false);
});
t("U5 목록을 못 얻었으면(null) 해당 없다", () => {
  assert.equal(needsEmptyConfirmation(null, view([{ app: "Slack", status: "connected" }])), false);
});
t("U6 원래 있던 것이 이미 전부 removed 면 바로 반영한다", () => {
  assert.equal(needsEmptyConfirmation(EMPTY, view([{ app: "Slack", status: "removed" }])), false);
});

// ── 실제 sh 로 돈다 ──────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-probe-"));
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
const log = path.join(tmp, "calls.log");
fs.writeFileSync(path.join(bin, "claude"), [
  "#!/bin/sh",
  `{ echo "ARGS=$*"; echo "OAUTH=\${CLAUDE_CODE_OAUTH_TOKEN-unset}"; echo "APIKEY=\${ANTHROPIC_API_KEY-unset}"; echo "AUTHTOK=\${ANTHROPIC_AUTH_TOKEN-unset}";`,
  `  echo "ENABLE=\${ENABLE_CLAUDEAI_MCP_SERVERS-unset}"; echo "TRAFFIC=\${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC-unset}";`,
  `  echo "NESTED=\${CLAUDECODE-unset}"; echo "LIVELY_OFF=\${LIVELY_OFF-unset}"; echo "HOME=$HOME"; } >> "$PROBE_LOG"`,
  `case "$*" in`,
  `  "--help") [ -n "$OLD_CLAUDE" ] && echo "Usage: claude [options]" || echo "  --setting-sources <sources>  Comma-separated list" ;;`,
  `  "auth status --json") echo '${AUTH_OK}' ;;`,
  `  *"mcp list") printf 'Checking MCP server health…\\n\\nclaude.ai Slack: https://proxy.example.invalid/x - ✔ Connected\\nlively: /bin/lively mcp - ✔ Connected\\n' ;;`,
  `esac`,
].join("\n"), { mode: 0o755 });
const runScript = (home: string, pathEnv: string, extra: Record<string, string> = {}) => spawnSync("/bin/sh", ["-c", probeScript(home)], {   // 절대 경로 — X2 는 PATH 를 비운다
  encoding: "utf8",
  env: {
    ...extra, PATH: pathEnv, PROBE_LOG: log,
    CLAUDE_CODE_OAUTH_TOKEN: "leak-oauth", ANTHROPIC_API_KEY: "leak-key", ANTHROPIC_AUTH_TOKEN: "leak-auth",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDECODE: "1",
  },
});

t("X1 실제 sh — 가짜 claude 는 토큰·차단 env 를 못 보고, 라이블리 훅은 꺼지고, HOME 은 준 홈이며, auth 다음 list 를 부른다", () => {
  fs.rmSync(log, { force: true });
  const home = path.join(tmp, "home");
  const r = runScript(home, `${bin}:/usr/bin:/bin`);
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(log, "utf8");
  assert.ok(calls.length > 0, "가짜 claude 가 한 번도 안 불렸다(관측 장치 배선)");
  const args = calls.split("\n").filter((l) => l.startsWith("ARGS="));
  assert.deepEqual(args, ["ARGS=--help", "ARGS=auth status --json", "ARGS=--setting-sources project,local mcp list"]);
  for (const k of ["OAUTH", "APIKEY", "AUTHTOK", "ENABLE", "TRAFFIC", "NESTED"]) {
    const lines = calls.split("\n").filter((l) => l.startsWith(`${k}=`));
    assert.equal(lines.length, 3, k);
    assert.ok(lines.every((l) => l === `${k}=unset`), `${k} 가 새어 들어갔다: ${lines.join(" | ")}`);
  }
  assert.ok(calls.split("\n").filter((l) => l.startsWith("LIVELY_OFF=")).every((l) => l === "LIVELY_OFF=1"));
  assert.ok(calls.split("\n").filter((l) => l.startsWith("HOME=")).every((l) => l === `HOME=${home}`));
  assert.deepEqual(parseProbeOutput(r.stdout).servers, [{ name: "claude.ai Slack", status: "connected" }, { name: "lively", status: "connected" }]);
});

t("X2 PATH 에 claude 가 없으면 no-cli(아무것도 안 부른다)", () => {
  fs.rmSync(log, { force: true });
  const empty = path.join(tmp, "empty");
  fs.mkdirSync(empty, { recursive: true });
  const r = runScript(path.join(tmp, "home"), empty);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseProbeOutput(r.stdout), { servers: null, error: "no-cli" });
  assert.ok(!fs.existsSync(log), "claude 가 없는데 무언가 불렸다");
});

t("X3 홈 경로에 작은따옴표가 있어도 HOME 이 그대로 넘어간다", () => {
  fs.rmSync(log, { force: true });
  const home = path.join(tmp, "it's home");
  const r = runScript(home, `${bin}:/usr/bin:/bin`);
  assert.equal(r.status, 0, r.stderr);
  const homes = fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("HOME="));
  assert.ok(homes.length === 3 && homes.every((l) => l === `HOME=${home}`), homes.join(" | "));
});

t("X4 --setting-sources 를 모르는 옛 claude 면 플래그 없이 목록을 센다", () => {
  fs.rmSync(log, { force: true });
  const r = runScript(path.join(tmp, "home"), `${bin}:/usr/bin:/bin`, { OLD_CLAUDE: "1" });
  assert.equal(r.status, 0, r.stderr);
  const args = fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("ARGS="));
  assert.deepEqual(args, ["ARGS=--help", "ARGS=auth status --json", "ARGS=mcp list"]);
  assert.equal(parseProbeOutput(r.stdout).servers?.length, 2);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed`);
