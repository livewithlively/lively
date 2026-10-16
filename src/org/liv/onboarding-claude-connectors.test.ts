// #4213 T13(상민님 2026-10-15 To-Be §7) — 처음 설정의 Claude 로그인 장면이 «리브가 쓸 앱» 으로 이어진다는 것을 말하는 자리.
//  (web/v2/onboarding.ts — 머리말 lead · claudeAppsHtml · refreshClaudeConnectors · 정책을 물은 뒤 다시 그리기)
//
//  사양 — 엣지 표(행마다 한 단언 이상):
//   K1 머리말 — Claude 가 아닌 AI                → 앱 이야기를 하지 않는다(구독 이야기만)
//   K2 머리말 — 정책 허용 · 아직 안 물음(null)    → «그 계정에 연결해 두신 앱을 리브가 그대로 쓴다» 를 말한다(기본값이 허용)
//   K3 머리말 — 정책 막힘                        → 그 약속을 하지 않고, 관리자 설정으로 막혔다고 말한다
//   K4 머리말 — 정책을 못 읽음(unknown)           → 약속도 «막혔다» 도 하지 않는다(서버는 못 읽으면 막는다 — T6)
//   A1 앱 칸 — Claude 가 아니거나 정책 막힘         → 칸이 없다
//   A2 앱 칸 — 아직 안 잼 · 재는 중               → «확인하고 있어요»
//   A3 앱 칸 — 재기 실패(요청 실패 · 스캔 실패)    → 사실대로 «확인하지 못했어요» + 리브가 다시 잰다 · 스캔 실패는 사유 말
//   A4 앱 칸 — 잰 결과 빈 목록                    → «아직 연결해 두신 앱이 없어요» + 리브가 안내한다
//   A5 앱 칸 — 잰 결과 있음                       → 앱 이름 · 연결 안 된 것은 상태를 괄호로 · 이름은 이스케이프
//   R1 새로 재기 — 정책 꺼짐 응답                  → 정책을 막힘으로 바꾸고 칸을 비운다
//   R2 새로 재기 — 일 자료 아닌 커넥터(Claude Docs) · 끊은 커넥터 → 목록에서 뺀다
//   R3 새로 재기 — 요청 실패                       → 실패로 남긴다(지어내지 않는다)
//   R4 새로 재기 — 이미 잰 값이 있으면              → 다시 묻지 않는다(장면이 여러 번 그려져도 한 번)
//   R5 새로 재기 — 이 장면을 떠났으면               → 다시 그리지 않는다
//   P1 정책을 물은 뒤 다시 그리기는 첫 판정(AIC)이 끝난 뒤에만 — 판정이 도는 중에 다시 그리면 bind 가 프로브를 한 번 더 띄운다
//      (화면 실측 2026-10-17: ai-accounts/check 두 번)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const SRC = read("../../../web/v2/onboarding.ts");

/** 소스에서 `head` 로 시작하는 블록(짝 맞는 중괄호까지)을 꺼낸다 — 못 찾으면 검사가 헛돌지 않게 그 자리에서 실패한다. */
function blockFrom(src: string, head: string): string {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} 를 못 찾았다 — 검사가 헛돈다`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  assert.fail(`${head} 의 닫는 괄호를 못 찾았다`);
}
type Fn = (...args: unknown[]) => unknown;
const compile = (params: string[], body: string): Fn => new Function(...params, body) as unknown as Fn;

// ── 머리말 ──────────────────────────────────────────────────────────────────────
const leadAt = SRC.indexOf("const lead = aiHarness()");
assert.ok(leadAt >= 0, "Claude 장면 머리말(lead)을 못 찾았다 — 검사가 헛돈다");
const leadExpr = SRC.slice(leadAt + "const lead = ".length, SRC.indexOf(";\n", leadAt));
const lead = (harness: string, ccp: string | null): string =>
  compile(["aiHarness", "CCP", "sub"], `return ${leadExpr};`)(() => harness, ccp, "«구독 안내»") as string;
const PROMISE = /그 계정에 연결해 두신 Slack·Notion·Gmail 같은 앱을 리브가 그대로 써서/;

test("K1 Claude 가 아닌 AI — 앱 이야기를 하지 않는다", () => {
  const t = lead("codex", "allowed");
  assert.match(t, /«구독 안내»/);
  assert.doesNotMatch(t, /Slack|앱을/, "Claude 가 아닌 AI 에게 Claude 커넥터 약속을 한다");
});

test("K2 정책 허용 · 아직 안 물음 — «Claude 에 연결해 둔 앱을 리브가 그대로 쓴다» 를 말한다", () => {
  for (const ccp of ["allowed", null]) {
    const t = lead("claude", ccp);
    assert.match(t, PROMISE, `정책 ${ccp} 에서 약속을 안 한다`);
    assert.match(t, /«구독 안내»/);
  }
});

test("K3 정책 막힘 — 약속하지 않고 관리자 설정으로 막혔다고 말한다", () => {
  const t = lead("claude", "blocked");
  assert.doesNotMatch(t, PROMISE, "막힌 워크스페이스에 리브가 Claude 앱을 쓴다고 약속한다");
  assert.match(t, /관리자 설정으로 Claude 에 연결해 둔 앱을 쓰지 않아요/);
});

test("K4 정책을 못 읽음 — 약속도 «막혔다» 도 하지 않는다", () => {
  const t = lead("claude", "unknown");
  assert.doesNotMatch(t, PROMISE, "못 읽은 정책을 허용으로 친다(서버는 못 읽으면 막는다)");
  assert.doesNotMatch(t, /관리자 설정/, "못 읽은 정책을 막힘이라고 단정한다");
  assert.match(t, /«구독 안내»/);
});

// ── «Claude 에 연결해 두신 앱» 칸 ────────────────────────────────────────────────
const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LABEL: Record<string, string> = { "needs-auth": "다시 로그인 필요", failed: "연결 실패" };
const appsHtml = (harness: string, ccp: string | null, cca: unknown): string =>
  compile(["esc", "scanErrorText", "CLAUDE_CONNECTOR_STATUS_LABEL", "CCP", "CCA", "h"],
    `${blockFrom(SRC, "function claudeAppsHtml(harness) {")}\nreturn claudeAppsHtml(h);`)(
    esc, (code: string) => `«사유 ${code}»`, LABEL, ccp, cca, harness) as string;

test("A1 Claude 가 아니거나 정책이 막혔으면 칸이 없다", () => {
  assert.equal(appsHtml("codex", "allowed", { ok: true, apps: [{ app: "Slack", status: "connected" }] }), "");
  assert.equal(appsHtml("claude", "blocked", { ok: true, apps: [{ app: "Slack", status: "connected" }] }), "");
});

test("A2 아직 안 잼 · 재는 중 — «확인하고 있어요»", () => {
  for (const cca of [null, { busy: true }]) assert.match(appsHtml("claude", "allowed", cca), /id="ccBox"[\s\S]*확인하고 있어요/);
});

test("A3 재기 실패 — 사실대로 말하고 리브가 다시 잰다고 한다 · 스캔 실패는 사유를 말한다", () => {
  const req = appsHtml("claude", "allowed", { ok: false, error: null, apps: [], failed: "네트워크" });
  assert.match(req, /지금은 확인하지 못했어요\.[\s\S]*리브가 대화를 시작하면서 다시 확인합니다/);
  assert.doesNotMatch(req, /«사유/, "요청 실패에 스캔 사유를 지어 붙인다");
  const scan = appsHtml("claude", "allowed", { ok: false, error: "no-login", apps: [] });
  assert.match(scan, /지금은 확인하지 못했어요\. «사유 no-login»/);
});

test("A4 잰 결과 빈 목록 — 없다고 말하고 리브가 연결을 안내한다고 한다", () => {
  const t = appsHtml("claude", "allowed", { ok: true, error: null, apps: [] });
  assert.match(t, /아직 Claude 에 연결해 두신 앱이 없어요/);
  assert.match(t, /리브가 대화에서/);
});

test("A5 잰 결과 있음 — 이름 · 연결 안 된 것은 상태 괄호 · 이름은 이스케이프", () => {
  const t = appsHtml("claude", null, { ok: true, error: null, apps: [
    { app: "Slack", status: "connected" }, { app: "Gmail", status: "needs-auth" }, { app: "<b>X</b>", status: "weird" }] });
  assert.match(t, /Claude 에 연결해 두신 앱: Slack · Gmail\(다시 로그인 필요\) · &#60;b&#62;X&#60;\/b&#62;\(weird\)/);
  assert.doesNotMatch(t, /<b>X<\/b>/, "앱 이름이 이스케이프되지 않았다");
});

// ── 새로 재기(refreshClaudeConnectors) ─────────────────────────────────────────
type Probe = { run: () => Promise<void>; get: () => { CCA: any; CCP: any } };
function refresher(apiImpl: (path: string, opts?: unknown) => Promise<unknown>, scene = "claude"): { p: Probe; calls: string[]; renders: number[] } {
  const calls: string[] = [];
  const renders: number[] = [];
  const NOT_WORK = new Set(["claude-docs"]);
  const keyOf = (n: string): string => String(n).trim().toLowerCase().replace(/\s+/g, "-");
  const p = compile(["api", "NOT_WORK_APPS", "appKeyOfConnector", "S", "renderScene"],
    `let CCP = null, CCA = null, destroyed = false, leavingAi = false;\n${blockFrom(SRC, "async function refreshClaudeConnectors() {")}\n` +
    "return { run: refreshClaudeConnectors, get: () => ({ CCA, CCP }) };")(
    (path: string, opts?: unknown) => { calls.push(path); return apiImpl(path, opts); }, NOT_WORK, keyOf, { scene },
    () => { renders.push(1); }) as Probe;
  return { p, calls, renders };
}

test("R1 정책 꺼짐 응답 — 정책을 막힘으로 바꾸고 칸을 비운다", async () => {
  const { p, renders } = refresher(async () => ({ skipped: "policy-off" }));
  await p.run();
  assert.deepEqual(p.get(), { CCA: null, CCP: "blocked" });
  assert.equal(renders.length, 1, "정책이 바뀌었는데 다시 그리지 않는다");
});

test("R2 일 자료 아닌 커넥터(Claude Docs)와 끊은 커넥터는 목록에서 뺀다", async () => {
  const { p, calls } = refresher(async () => ({ record: { scan: { ok: true, error: null }, connectors: [
    { app: "Slack", status: "connected" }, { app: "Claude Docs", status: "connected" }, { app: "Notion", status: "removed" }, { app: "Gmail", status: "needs-auth" }] } }));
  await p.run();
  assert.deepEqual(calls, ["/api/ui/me/ai-connectors/refresh"], "배선 — 새로 재기 요청이 나가지 않았다");
  assert.deepEqual(p.get().CCA, { ok: true, error: null, apps: [{ app: "Slack", status: "connected" }, { app: "Gmail", status: "needs-auth" }] });
});

test("R3 요청 실패 — 실패로 남긴다", async () => {
  const { p } = refresher(async () => { throw new Error("502"); });
  await p.run();
  assert.deepEqual(p.get().CCA, { ok: false, error: null, apps: [], failed: "502" });
});

test("R4 이미 잰 값이 있으면 다시 묻지 않는다 · R5 이 장면을 떠났으면 다시 그리지 않는다", async () => {
  const { p, calls, renders } = refresher(async () => ({ record: { scan: { ok: true }, connectors: [] } }), "ai");
  await p.run();
  await p.run();
  assert.equal(calls.length, 1, "장면이 다시 그려질 때마다 새로 잰다(그 사람 자리에서 claude mcp list 가 매번 돈다)");
  assert.equal(renders.length, 0, "떠난 장면을 다시 그린다");
});

// ── 정책을 물은 뒤 다시 그리기 ───────────────────────────────────────────────────
test("P1 정책을 물은 뒤 다시 그리기는 첫 판정(AIC)이 끝난 뒤에만 — 판정 중에 다시 그리면 프로브가 두 번 돈다", () => {
  const bind = SRC.slice(SRC.indexOf("        if (CCP == null && aiHarness() === 'claude')"), SRC.indexOf("        if (!AIC) { checkAi().then("));
  assert.ok(bind.length > 0 && bind.length < 400, "정책 묻기 · 첫 판정 두 줄을 못 찾았다(또는 순서가 바뀌었다) — 검사가 헛돈다");
  assert.match(bind, /loadClaudeConnectorPolicy\(\)\.then\(\(\) => \{ if \(!destroyed && !leavingAi && S\.scene === 'claude' && AIC\) renderScene\('claude', false\); \}\)/,
    "정책 답이 오면 첫 판정이 끝나기 전에도 다시 그린다 — bind 가 ai-accounts/check 를 한 번 더 띄운다");
});
