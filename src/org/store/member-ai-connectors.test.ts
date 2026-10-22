// 구성원 AI 계정 커넥터 기록의 **순수 판정** (#4213 T6 #4427) — DB 없이. 저장·조회(트랜잭션·removed·옛 관측 가드)는
//  member-ai-connectors.pg-test.mjs 가 실제 Postgres 로 본다.
//
//  엣지 표(사양 → 시나리오, 행마다 단언 하나 이상)
//   N1 init 상태 넷 그대로                N2 `claude mcp list` 기호·문장 → 같은 넷     N3 빈 값·모르는 값 → unknown
//   N4 «Disconnected» 는 connected 가 아니다
//   L1 실측 모양 목록(머리 줄·빈 줄) → 서버 넷   L2 명령 인자에 « - » → 마지막 « - » 뒤가 상태
//   L3 « - » 없는 안내 줄 → 서버가 아니다     L4 주소·홈 경로가 결과에 없다            L5 빈 입력 → []
//   C1 로컬 MCP 섞인 목록 → claude.ai 만(앞머리 뗌)   C2 앞머리만·모양 밖·대소문자 다른·붙은 앞머리·이름 없음 → 버림
//   C3 같은 앱 두 번 → 앞의 것            C4 경계 — 앱 이름 64자 받음 · 65자 버림    C5 경계 — 200개 · 201개 → 200
//   C6 null·undefined 목록 → []
//   S1 요약 없음 → 건너뜀(잃은 실행은 확인 줄을 덮지 않는다)   S2 버전 없음 → 건너뜀   S3 서버 0 · init 없음 → collect-no-list
//   S4 servers 비면 init.mcp              S5 claude.ai 0 → 러너 코드 / no-claude-ai-connectors   S6 정상 → 그대로
//   S7 러너의 자유 문장 사유 → collect-failed(경로·계정 이름이 섞일 수 있다)
//   E1 사유 코드 — 모양 안 → 그대로 · 모양 밖(공백·대문자·한글·41자) → failed · 경계 40자 받음
import assert from "node:assert/strict";
import {
  CLAUDE_AI_SERVER_PREFIX, claudeAiConnectorsOf, collectSummaryScan, normalizeAiConnectorStatus, parseClaudeMcpList, scanErrorCode,
} from "./member-ai-connectors.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("N1 init.mcp_servers 의 상태 넷은 그대로다", () => {
  for (const s of ["connected", "needs-auth", "failed", "pending"] as const) assert.equal(normalizeAiConnectorStatus(s), s);
});

t("N2 `claude mcp list` 의 기호·문장도 같은 넷으로 접힌다(2.1.301 실측 문구)", () => {
  assert.equal(normalizeAiConnectorStatus("✔ Connected"), "connected");
  assert.equal(normalizeAiConnectorStatus("! Needs authentication"), "needs-auth");
  assert.equal(normalizeAiConnectorStatus("✘ Failed to connect"), "failed");
  assert.equal(normalizeAiConnectorStatus("⏸ Pending approval"), "pending");
  assert.equal(normalizeAiConnectorStatus("Needs auth"), "needs-auth");
});

t("N3 빈 값·모르는 값은 unknown 이다(지어내지 않는다)", () => {
  for (const v of ["", null, undefined, "   ", "something else", 42]) assert.equal(normalizeAiConnectorStatus(v), "unknown", String(v));
});

t("N4 «Disconnected» 를 connected 로 읽지 않는다(낱말 경계)", () => {
  assert.notEqual(normalizeAiConnectorStatus("Disconnected"), "connected");
});

const LIST = [
  "Checking MCP server health…",
  "",
  "claude.ai Claude Docs: https://mcp-proxy.example.invalid/v1/mcp/abc - ✔ Connected",
  "lively: /home/box_x/.lively/bin/lively mcp - ✔ Connected",
  "lively-local: /home/box_x/.lively/bin/lively mcp-local - ✔ Connected",
  "figma: https://mcp.figma.example.invalid/mcp (HTTP) - ! Needs authentication",
  "",
].join("\n");

t("L1 실측 모양 목록 → 서버 넷(머리 줄·빈 줄은 서버가 아니다)", () => {
  assert.deepEqual(parseClaudeMcpList(LIST), [
    { name: "claude.ai Claude Docs", status: "connected" },
    { name: "lively", status: "connected" },
    { name: "lively-local", status: "connected" },
    { name: "figma", status: "needs-auth" },
  ]);
});

t("L2 명령 인자에 « - » 가 섞여도 마지막 « - » 뒤가 상태다(앞 조각에 «Connected» 가 있어도)", () => {
  assert.deepEqual(parseClaudeMcpList("notifier: notify - Connected users - ✘ Failed to connect"), [{ name: "notifier", status: "failed" }]);
});

t("L3 « - » 없는 안내 줄은 서버로 세지 않는다", () => {
  assert.deepEqual(parseClaudeMcpList("Warning: something odd happened\nNote: hello"), []);
});

t("L4 주소·홈 경로는 결과에 남지 않는다", () => {
  const s = JSON.stringify(parseClaudeMcpList(LIST));
  assert.ok(!s.includes("http") && !s.includes("/home/"), s);
});

t("L5 빈 입력은 빈 목록이다", () => {
  assert.deepEqual(parseClaudeMcpList(""), []);
  assert.deepEqual(parseClaudeMcpList(null as unknown as string), []);
});

t("C1 로컬 MCP 가 섞인 목록에서 claude.ai 만, 앞머리를 뗀 이름으로", () => {
  assert.equal(CLAUDE_AI_SERVER_PREFIX, "claude.ai ");
  assert.deepEqual(claudeAiConnectorsOf(parseClaudeMcpList(LIST)), [{ app: "Claude Docs", status: "connected" }]);
  assert.deepEqual(claudeAiConnectorsOf([
    { name: "lively", status: "connected" }, { name: "claude.ai Slack", status: "connected" },
    { name: "claude.ai Google Drive", status: "needs-auth" }, { name: "figma", status: "needs-auth" },
  ]), [{ app: "Slack", status: "connected" }, { app: "Google Drive", status: "needs-auth" }]);
});

t("C2 앞머리만 · 모양 밖 이름 · 대소문자 다른 앞머리 · 붙은 앞머리 · 이름 없음은 버린다", () => {
  assert.deepEqual(claudeAiConnectorsOf([
    { name: "claude.ai ", status: "connected" }, { name: "claude.ai Sl@ck", status: "connected" },
    { name: "Claude.ai Slack", status: "connected" }, { name: "claude.aiSlack", status: "connected" },
    { name: undefined, status: "connected" }, { status: "connected" },
  ]), []);
});

t("C3 같은 앱이 두 번 오면 앞의 것을 쓴다", () => {
  assert.deepEqual(claudeAiConnectorsOf([{ name: "claude.ai Slack", status: "needs-auth" }, { name: "claude.ai Slack", status: "connected" }]),
    [{ app: "Slack", status: "needs-auth" }]);
});

t("C4 경계 — 앱 이름 64자는 받고 65자는 버린다", () => {
  const n64 = "A" + "b".repeat(63), n65 = "A" + "b".repeat(64);
  assert.deepEqual(claudeAiConnectorsOf([{ name: "claude.ai " + n64, status: "connected" }]), [{ app: n64, status: "connected" }]);
  assert.deepEqual(claudeAiConnectorsOf([{ name: "claude.ai " + n65, status: "connected" }]), []);
});

t("C5 경계 — 200개는 200개, 201개도 200개", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `claude.ai App${i}`, status: "connected" }));
  assert.equal(claudeAiConnectorsOf(mk(200)).length, 200);
  assert.equal(claudeAiConnectorsOf(mk(201)).length, 200);
});

t("C6 null·undefined 목록은 빈 목록", () => {
  assert.deepEqual(claudeAiConnectorsOf(null), []);
  assert.deepEqual(claudeAiConnectorsOf(undefined), []);
});

const SERVERS = [{ name: "claude.ai Slack", status: "connected" }, { name: "lively", status: "connected" }];

t("S1 요약이 없으면(잃은 실행) 건너뛴다 — 확인 줄을 덮지 않는다", () => {
  assert.deepEqual(collectSummaryScan(null, { error: "lost" }), { skip: true });
  assert.deepEqual(collectSummaryScan(null, null), { skip: true });
});

t("S2 claude 버전을 못 쟀으면(목록 단계 전에 죽음) 건너뛴다", () => {
  assert.deepEqual(collectSummaryScan({ claude: { version: null }, servers: SERVERS }, { error: "claude --version 실패: boom" }), { skip: true });
});

t("S3 서버가 0이고 init 도 없으면 collect-no-list", () => {
  assert.deepEqual(collectSummaryScan({ claude: { version: "2.1.301" }, servers: [] }, {}), { skip: false, servers: null, error: "collect-no-list" });
});

t("S4 servers 가 비면 init.mcp 로 읽는다", () => {
  const init = { mcp: [{ name: "claude.ai Notion", status: "connected" }] };
  assert.deepEqual(collectSummaryScan({ claude: { version: "2.1.301" }, servers: [], init }, {}), { skip: false, servers: init.mcp, error: null });
});

t("S5 claude.ai 커넥터가 0이면 실패다 — 러너 코드가 있으면 그 코드, 없으면 no-claude-ai-connectors", () => {
  const onlyLocal = { claude: { version: "2.1.301" }, servers: [{ name: "lively", status: "connected" }] };
  assert.deepEqual(collectSummaryScan(onlyLocal, { error: "no-connector" }), { skip: false, servers: null, error: "no-connector" });
  assert.deepEqual(collectSummaryScan(onlyLocal, { error: "timeout" }), { skip: false, servers: null, error: "timeout" });
  assert.deepEqual(collectSummaryScan(onlyLocal, {}), { skip: false, servers: null, error: "no-claude-ai-connectors" });
});

t("S6 정상이면 목록을 그대로 넘기고 사유는 없다", () => {
  assert.deepEqual(collectSummaryScan({ claude: { version: "2.1.301" }, servers: SERVERS }, { error: null }), { skip: false, servers: SERVERS, error: null });
});

t("S7 러너의 자유 문장 사유는 싣지 않고 collect-failed 로 접는다", () => {
  const onlyLocal = { claude: { version: "2.1.301" }, servers: [{ name: "lively", status: "connected" }] };
  assert.deepEqual(collectSummaryScan(onlyLocal, { error: "runner: ENOENT /home/box_x/.cache/lvly-collect/cr-1" }),
    { skip: false, servers: null, error: "collect-failed" });
});

t("E1 사유 코드 — 모양 안은 그대로, 모양 밖은 failed · 경계 40자", () => {
  for (const ok of ["not-logged-in", "timeout", "no-capacity", "mcp-list-exit-1", "a" + "b".repeat(39)]) assert.equal(scanErrorCode(ok), ok, ok);
  for (const bad of ["", "Timeout", "로그인 안 됨", "claude --version 실패", "/home/x", "a" + "b".repeat(40), null, undefined]) {
    assert.equal(scanErrorCode(bad), "failed", String(bad));
  }
});

console.log(`\n${pass} passed`);
