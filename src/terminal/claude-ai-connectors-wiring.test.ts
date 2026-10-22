// 구성원 Claude 커넥터 정책(#4213 T6 #4427) — **집행하는 자리가 실제로 판정을 쓰나**. 판정 함수(claude-ai-connectors-policy)와
//  값(harnessSettingsArgv · claudeChatArgv)은 따로 시험되지만, 부르는 자리에서 한 줄만 빠져도 그 시험들은 초록인 채로 정책이 조용히
//  사라진다(리뷰 지적 2026-10-16). 그래서 그 줄들을 소스에서 못박는다(session-app-folders-wiring 과 같은 방식).
//
//  W1 판(createSession): 판정 → harnessSettingsArgv 에 실음      W2 대화 런타임(deliverPrompt): 처음 띄울 때 판정 → sendClaudeChat 에 실음
//  W3 대화 런타임 안: ensureClaudeChat 이 o 를 그대로 claudeChatArgv 로   W4 수집 실행: 정책이 첫 판정 · blocked 403 · unknown 503
//  W5 게이트웨이 능력 등록 · 선언     W6 안내문 네 자리(라이브 주입 둘 · 관리 화면 · 미리보기 · 발행물)가 정책을 넘긴다
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GATEWAY_CAPABILITY_NAMES } from "../sessions/gateway-capabilities.js";

const src = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
const slice = (s: string, from: string, to: string): string => {
  const i = s.indexOf(from);
  assert.ok(i >= 0, `못 찾았다: ${from}`);
  const j = s.indexOf(to, i + from.length);
  return s.slice(i, j < 0 ? undefined : j);
};

test("W1 판 — createSession 이 판정을 내고 그 값을 claude 의 --settings 조립에 싣는다", () => {
  const fn = slice(src("terminal/sessions.ts"), "export async function createSession(", "\ninterface OwnerMeta");
  const verdict = fn.indexOf("const blockClaudeAiConnectors = await claudeAiConnectorsBlocked(harness.key);");
  const use = fn.indexOf("harnessSettingsArgv(harness.key, { theme: input.theme, managed: !!input.managed, platform: process.platform, blockClaudeAiConnectors })");
  assert.ok(verdict > 0, "판정 줄이 없다");
  assert.ok(use > verdict, "판정 값을 --settings 조립에 싣지 않는다");
  assert.match(src("terminal/sessions.ts"), /import \{ claudeAiConnectorsBlocked \} from "\.\/claude-ai-connectors-policy\.js";/);
});

test("W2 대화 런타임 — 처음 띄울 때 판정을 내고 sendClaudeChat 에 싣는다", () => {
  const d = src("terminal/deliver-prompt.ts");
  const branch = slice(d, "r = await sendClaudeChat(", "\n");
  assert.match(branch, /blockClaudeAiConnectors \}\);$/, "sendClaudeChat 에 판정을 안 싣는다");
  assert.match(d, /const blockClaudeAiConnectors = !isClaudeChatLive\(sessionId\) && await claudeAiConnectorsBlocked\(harnessKey\);/);
});

test("W3 대화 런타임 안 — ensureClaudeChat 이 받은 옵션을 그대로 claudeChatArgv 로 넘기고, 그 함수가 정책 함수를 지난다", () => {
  const r = src("terminal/harness-io/claude-chat-runtime.ts");
  assert.match(slice(r, "export function ensureClaudeChat(", "\n}\n"), /claudeChatArgv\(\{ \.\.\.o, harness \}\)/);
  assert.match(slice(r, "export function claudeChatArgv(", "\n}\n"), /return chatArgvWithConnectorPolicy\(harness, a\?\.argv \? a\.argv\(o\) : \[\], o\.blockClaudeAiConnectors\);/);
});

test("W4 수집 실행 — 정책이 첫 판정이다(blocked 403 · unknown 503) · 자리·폴더를 만들기 전이다", () => {
  const fn = slice(src("terminal/collect-run.ts"), "export async function startCollectRun(", "\nasync function pollOnce(");
  const p = fn.indexOf("const policy = await memberAiConnectorsPolicy();");
  assert.ok(p > 0, "정책 판정이 없다");
  assert.match(fn, /if \(policy === "blocked"\) \{\s*throw new HttpError\(403,/);
  assert.match(fn, /if \(policy !== "allowed"\) throw new HttpError\(503,/);
  for (const later of ["resolveMemberOsUser(", "runAtLoginSeatSh(", "createSession(user"]) {
    const i = fn.indexOf(later);
    assert.ok(i > p, `정책 판정보다 ${later} 가 먼저다 — 막힌 워크스페이스에서도 자리를 띄운다`);
  }
});

test("W5 게이트웨이 능력 — 선언돼 있고 index.ts 가 그 구현을 꽂는다", () => {
  assert.ok((GATEWAY_CAPABILITY_NAMES as readonly string[]).includes("memberAiConnectorsPolicy"));
  const idx = src("index.ts");
  assert.match(idx, /const \{ memberAiConnectorsPolicy \} = await import\("\.\/org\/store\/member-ai-connectors\.js"\);/);
  assert.match(idx, /registerGatewayCapabilities\(\{[^}]*memberAiConnectorsPolicy,/);
});

test("W6 안내문 — 라이브 주입 두 조립 · 관리 화면 · 미리보기 · 발행물이 모두 정책 값을 넘긴다", () => {
  const blocks = slice(src("org/delivery/publish.ts"), "async function buildSectionBlocks(", "\n}\n");
  assert.equal(blocks.split("memberAiConnectorsAllowed: connectorsAllowed").length - 1, 2, "섹션 조립 두 자리(행 있음 · 행 없음) 중 하나가 빠졌다");
  const oc = src("capabilities/delivery/org-content.ts");
  assert.match(slice(oc, "export async function sectionsPayload(", "\n}\n"), /fillMemberAiConnectorsLine\(raw, connectorsAllowed\)/);
  assert.match(oc, /buildKnowledgeIndex\(wikiPins, categoryMap, bodyMd, wikiCats, \{ memberAiConnectorsAllowed: connectorsAllowed \}\)/);
  assert.match(src("org/delivery/knowledge-index.ts"), /\{ memberAiConnectorsAllowed: await memberAiConnectorsAllowed\(\) \}\)\);/);
});
