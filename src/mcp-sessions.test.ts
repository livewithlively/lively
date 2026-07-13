// in-session push(#746 T5) 세션 레지스트리·브로드캐스트 단위 체크 — SSE/전송 불요(순수 로직).
// 실행: npm run build && node dist/mcp-sessions.test.js
//  sessioned SSE 전 구간 E2E(클라 구독→refresh→list_changed 수신)는 부팅 게이트웨이 필요(배포/dev 인스턴스).
import assert from "node:assert/strict";
import { sessionedEnabled, newSessionId, putSession, getSession, dropSession, sessionCount, broadcastToolListChanged } from "./mcp-sessions.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("newSessionId: 매번 고유 UUID", () => {
  assert.notEqual(newSessionId(), newSessionId());
  assert.match(newSessionId(), /^[0-9a-f-]{36}$/);
});

t("레지스트리 put/get/drop/count", () => {
  const fake = { transport: {} as never, server: { sendToolListChanged() {} } as never };
  putSession("s1", fake); putSession("s2", fake);
  assert.equal(sessionCount(), 2);
  assert.ok(getSession("s1"));
  dropSession("s1");
  assert.equal(sessionCount(), 1);
  assert.equal(getSession("s1"), undefined);
  dropSession("s2");
  assert.equal(sessionCount(), 0);
});

t("broadcastToolListChanged: 전 세션 sendToolListChanged 호출 + 개별 실패 무시", () => {
  let calls = 0;
  const mk = (dead: boolean) => ({ transport: {} as never, server: { sendToolListChanged() { calls++; if (dead) throw new Error("dead session"); } } as never });
  putSession("a", mk(false)); putSession("b", mk(true)); putSession("c", mk(false));
  const n = broadcastToolListChanged();
  assert.equal(calls, 3, "끊긴 세션 포함 전부 시도");
  assert.equal(n, 2, "성공(비-throw) 세션만 카운트");
  dropSession("a"); dropSession("b"); dropSession("c");
  assert.equal(broadcastToolListChanged(), 0, "세션 없으면 0(no-op)");
});

t("sessionedEnabled: on/1/true → true, 그 외/미설정 → false(기본 무상태)", () => {
  const saved = process.env.LIVELY_MCP_SESSIONED;
  for (const v of ["on", "1", "true"]) { process.env.LIVELY_MCP_SESSIONED = v; assert.equal(sessionedEnabled(), true, v); }
  for (const v of ["off", "", "0", "no"]) { process.env.LIVELY_MCP_SESSIONED = v; assert.equal(sessionedEnabled(), false, v); }
  delete process.env.LIVELY_MCP_SESSIONED; assert.equal(sessionedEnabled(), false, "미설정");
  if (saved !== undefined) process.env.LIVELY_MCP_SESSIONED = saved;
});

console.log(`\nMCP-SESSIONS(T5) UNIT: ${pass} passed`);
