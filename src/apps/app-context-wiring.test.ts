// 앱 맥락 범위(#5100) — 문 배선(격리 리뷰 N3). 범위의 경계는 «앱 토큰 요청을 범위 안에서 돌리는» 한 줄짜리 감싸기 넷이다 —
//  하나가 빠지면 그 길이 통째로 열린다. 술어 · 판정은 PG 시험(app-context.pg-test · app-context-rest.pg-test)이 재고, 여기는 감싸기가 그 자리에
//  있는지 소스로 잰다(http-auth-gate.test.ts 와 같은 방식). REST 의 두 문(인증 · 능력 어댑터)은 app-context-rest.pg-test 가 진짜 Express 로도 잰다.
//  엣지 표:
//   C1 MCP — 모든 tools/call 이 지나는 instrument 가 핸들러를 runWithAppReadScope 로 부른다(capability · db · dynamic 도구 전부)
//   C2 REST 능력 어댑터 — cap.handler 를 runWithAppReadScope 안에서 부른다
//   C3 앱 화면 다리(runAppTool) — 앱 주체(appUser)로 감싼다(멤버 토큰이 아니라)
//   C4 인증 문(appServerGate) — 그대로 보내는 갈래 · 사람 신원으로 바꾼 갈래 모두 범위 안에서 next 한다(맨 라우트가 범위를 물려받는 자리)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

console.log(`\n${pass} 통과`);
