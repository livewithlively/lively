// 앱 토큰의 MCP 도구 표면(#1780 v2.1 R4-M1) — 사양 spec-h8: EXEMPT 배관 도구는 앱 토큰 tools/list 에서 사라지고, 일반 세션은 무회귀.
//  readonly.test 의 가짜 서버 관례(registerTool 이름만 수집)를 그대로 쓴다 — 무엇이 실제로 등록되나가 이 테스트의 전부.
import assert from "node:assert/strict";
import { registerMcpCapabilities } from "./index.js";
import { APP_TOOL_EXEMPT } from "../apps/principal.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const registered = (appId: string | null | undefined): string[] => {
  const names: string[] = [];
  registerMcpCapabilities({ registerTool: (n: string) => names.push(n) } as never, undefined, undefined, null, false, false, appId);
  return names;
};

// EXEMPT 8종 중 MCP 표면에 있는 것은 whoami 뿐이다(나머지 7종은 expose.mcp:false — REST 전용 배관). 그래서 "감춤" 의
//  실효 대상은 whoami 하나지만, 판정은 집합 전체에 걸어 둔다(누가 나중에 배관 도구에 expose.mcp:true 를 켜도 새지 않게).
t("일반 세션(appId 없음/undefined/null): MCP 노출인 EXEMPT(whoami)는 등록된다(무회귀)", () => {
  for (const appId of [undefined, null]) {
    const names = registered(appId);
    assert.ok(names.length > 50, "배선 확인 — 등록이 실제로 일어나야 한다");
    assert.ok(names.includes("whoami"), `일반 세션엔 whoami 가 있어야 한다(appId=${String(appId)})`);
  }
});

t("앱 토큰: EXEMPT 8종은 tools/list 에서 사라지고 나머지 표면은 그대로", () => {
  const plain = registered(null);
  const app = registered("browser");
  for (const ex of APP_TOOL_EXEMPT) assert.ok(!app.includes(ex), `앱 토큰엔 ${ex} 가 없어야 한다`);
  assert.deepEqual(app, plain.filter((n) => !APP_TOOL_EXEMPT.has(n)), "EXEMPT 외엔 차이가 없어야 한다(grant 축소는 핸들러 몫)");
  assert.equal(plain.length - app.length, [...APP_TOOL_EXEMPT].filter((n) => plain.includes(n)).length, "빠진 개수 = 등록돼 있던 EXEMPT 개수");
});

console.log(`\napp-mcp-surface tests: ${pass} passed`);
