// 앱 맥락 범위(#5100) — 문 배선(격리 리뷰 N3). 범위의 경계는 «앱 토큰 요청을 범위 안에서 돌리는» 한 줄짜리 감싸기 넷이다 —
//  하나가 빠지면 그 길이 통째로 열린다. 술어 · 판정은 PG 시험(app-context.pg-test · app-context-rest.pg-test)이 재고, 여기는 감싸기가 그 자리에
//  있는지 소스로 잰다(http-auth-gate.test.ts 와 같은 방식). REST 의 두 문(인증 · 능력 어댑터)은 app-context-rest.pg-test 가 진짜 Express 로도 잰다.
//  엣지 표:
//   C1 MCP — 모든 tools/call 이 지나는 instrument 가 핸들러를 runWithAppReadScope 로 부른다(capability · db · dynamic 도구 전부)
//   C2 REST 능력 어댑터 — cap.handler 를 runWithAppReadScope 안에서 부른다
//   C3 앱 화면 다리(runAppTool) — 앱 주체(appUser)로 감싼다(멤버 토큰이 아니라)
//   C4 인증 문(appServerGate) — 그대로 보내는 갈래 · 사람 신원으로 바꾼 갈래 모두 범위 안에서 next 한다(맨 라우트가 범위를 물려받는 자리)
//   C5 범위를 못 지키는 도구의 거절(격리 재검토 B1') — 세 어댑터 모두 앱 도구 판정(requireAppTool) 바로 뒤 · 핸들러 앞에서 assertAppContextSafeTool 을 부른다
//      (다리는 try 안 — 거절이 기록되게)
//   C6 그 목록(APP_CONTEXT_UNSAFE_TOOLS 이름 · APP_CONTEXT_UNSAFE_PREFIXES 앞머리)이 실제 도구를 가리킨다(오타 하나면 그 도구가 조용히 열린다) ·
//      재검토 · 재재검토가 짚은 도구가 모두 거절된다 · 범위 안에서 읽는 도구(검색 · 상세 · 자료 · 카테고리 목록 · 파이프라인 개요)는 거절되지 않는다(너무 넓은 앞머리)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APP_CONTEXT_UNSAFE_TOOLS, APP_CONTEXT_UNSAFE_PREFIXES, appContextUnsafeWhy } from "./app-context.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  try { fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++; console.log(`ok  ${name}`);
};
const src = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
/** start 표지부터 end 표지 앞까지(없으면 끝까지) — 그 함수 몸통 안에서만 찾게. */
const between = (s: string, start: string, end?: string): string => {
  const i = s.indexOf(start);
  assert.ok(i >= 0, `표지를 못 찾음: ${start}`);
  const j = end ? s.indexOf(end, i + start.length) : -1;
  return s.slice(i, j > i ? j : undefined);
};

t("C1 MCP instrument — 핸들러를 앱 읽기 범위 안에서 부른다", () => {
  const body = between(src("server.ts"), "function instrument(", "export function buildServer(");
  assert.match(body, /runWithAppReadScope\(user, \(\) => handler\(args, extra\)\)/);
  assert.doesNotMatch(body, /await handler\(args, extra\)/, "감싸지 않은 호출이 남아 있으면 안 된다");
});

t("C2 REST 능력 어댑터 — cap.handler 를 범위 안에서 부른다", () => {
  const s = src("web.ts");
  assert.match(s, /runWithAppReadScope\(user, \(\) => cap\.handler\(input, user, \{/);
  assert.doesNotMatch(s, /res\.json\(await cap\.handler\(/, "감싸지 않은 능력 호출이 남아 있으면 안 된다");
});

t("C3 앱 화면 다리 — 앱 주체(appUser)로 감싼다", () => {
  const body = between(src("capabilities/app-tool-call.ts"), "export async function runAppTool(");
  assert.match(body, /runWithAppReadScope\(appUser, \(\) => cap\.handler\(/);
  assert.doesNotMatch(body, /runWithAppReadScope\(member,/, "멤버 토큰으로 감싸면 범위가 안 걸린다(appId 없음)");
});

t("C4 인증 문 — 두 갈래 모두 범위 안에서 next 한다", () => {
  const s = src("auth/http-auth.ts");
  assert.match(between(s, "const nextInAppScope", "function appServerGate("), /runWithAppReadScope\(user, \(\) => \{ next\(\); return Promise\.resolve\(\); \}\)/);
  const gate = between(s, "function appServerGate(", "export function bearerWithResourceMetadata(");
  assert.match(gate, /if \(verdict === "next"\) \{ nextInAppScope\(user, next\); return; \}/);
  assert.match(gate, /\.extra = p;[^\n]*\n\s*nextInAppScope\(p, next\);/);
  assert.doesNotMatch(gate, /\bnext\(\);/, "범위 밖에서 바로 next() 하는 갈래가 남아 있으면 안 된다");
});

t("C5 세 어댑터 — 앱 도구 판정 바로 뒤, 핸들러 앞에서 범위를 못 지키는 도구를 거절한다", () => {
  const mcp = between(src("capabilities/index.ts"), "server.registerTool(", "const out = await cap.handler(");
  assert.match(mcp, /await requireAppTool\(u, cap\.name\);[^\n]*\n\s*await assertAppContextSafeTool\(u, cap\.name, "mcp"\);/);
  const rest = between(src("web.ts"), "await requireAppTool(user, cap.name);", "cap.handler(input, user, {");
  assert.match(rest, /await assertAppContextSafeTool\(user, cap\.name, "web"\);/);
  const bridge = between(src("capabilities/app-tool-call.ts"), "export async function runAppTool(");
  const tryAt = bridge.indexOf("  try {\n"), guardAt = bridge.indexOf("await assertAppContextSafeTool(appUser, name, opts.source);"), handlerAt = bridge.indexOf("cap.handler(args");
  assert.ok(tryAt >= 0 && tryAt < guardAt && guardAt < handlerAt, `다리: try(${tryAt}) < 거절(${guardAt}) < 핸들러(${handlerAt})`);
});

t("C6 범위를 못 지키는 도구 목록 — 실제 도구를 가리키고 · 짚은 도구는 모두 거절 · 범위 안 읽기는 열림", () => {
  const known = new Set((JSON.parse(src("capabilities/surface-snapshot.json")) as { name: string }[]).map((c) => c.name));
  for (const name of APP_CONTEXT_UNSAFE_TOOLS.keys()) assert.ok(known.has(name), `없는 도구 이름: ${name}`);
  for (const prefix of APP_CONTEXT_UNSAFE_PREFIXES.keys()) assert.ok([...known].some((n) => n.startsWith(prefix)), `아무 도구도 안 가리키는 앞머리: ${prefix}`);
  const mustDeny = ["deleted_list", "content_snapshot", "content_restore", "content_purge", "trash_counts", "content_undo", "my_lively_log",
    "org_distiller_preview", "org_distiller_category_preview", "org_distiller_tune", "org_distiller_list",
    "org_manager_findings", "org_manager_finding_report", "org_manager_finding_resolve", "org_manager_findings_apply", "org_classifier_list"];
  for (const name of mustDeny) {
    assert.ok(known.has(name), `짚은 도구가 표면에 없다(이름이 바뀌었나): ${name}`);
    assert.ok((appContextUnsafeWhy(name) ?? "").length > 0, `거절되지 않는다(또는 까닭이 비었다): ${name}`);
  }
  for (const name of ["knowledge_search", "knowledge_grep", "knowledge_get", "knowledge_list", "knowledge_similar", "source_get", "source_list",
    "category_list", "category_get", "org_pipeline_overview", "store_query", "app_ai_run"]) {
    assert.ok(known.has(name), `대조 도구가 표면에 없다: ${name}`);
    assert.equal(appContextUnsafeWhy(name), null, `범위 안에서 읽는 도구가 막혔다: ${name}`);
  }
});

console.log(`\n${pass} 통과`);
