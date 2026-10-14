// 허브 «터미널 세션» 위젯의 [입장]/[열기] — 셸 안의 세션 화면(#/s/<id>)으로 간다(#4135, 원준 2026-10-04).
//  종전: 새 창(terminal.html?session=)에 세션 하나만 떠서 «사이드바 있는 세션 화면» 이 아니었다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const kit = readFileSync(new URL("../web/projects/detail-hub-kit.ts", import.meta.url), "utf8");
const body = (name) => { const i = kit.indexOf(`export const ${name} =`); assert.ok(i >= 0, name + " 없음"); return kit.slice(i, kit.indexOf("\n};", i) + 3); };

test("E1 셸 안이면 openSessionRoute(셸에 #/s/<id> 를 부탁) 로 간다 — 새 창을 먼저 열지 않는다", () => {
  const b = body("enterSession");
  const iRoute = b.indexOf("openSessionRoute("), iWin = b.indexOf("openSessionWindow(");
  assert.ok(iRoute > 0, "셸 경로가 없다");
  assert.ok(iWin > iRoute, "새 창이 셸 경로보다 먼저다");
  assert.match(b, /if \(inShell\(\)\) \{ openSessionRoute\(String\(s\.id\)\); return; \}/);
});

test("E2 셸 판정 — 셸 액자(EMBEDDED + 부모 창) 또는 셸 문서(#v2-root)", () => {
  const i = kit.indexOf("function inShell()");
  const b = kit.slice(i, kit.indexOf("\n}", i));
  assert.match(b, /EMBEDDED && window\.parent && window\.parent !== window/);
  assert.match(b, /getElementById\('v2-root'\)/);
});

test("E3 openSessionRoute 는 셸에 새 탭(=사이드바 있는 세션 화면)으로 부탁한다", () => {
  assert.match(kit, /export const openSessionRoute = \(sid: string\): void => requestOpenRoute\('#\/s\/' \+ encodeURIComponent\(sid\), true\);/);
  const main = readFileSync(new URL("../web/v2/main.ts", import.meta.url), "utf8");
  const i = main.indexOf("m.type === 'lively:open-route'");
  const b = main.slice(i, main.indexOf("return;", i));
  assert.match(b, /setRailSection\('home'/, "세션은 홈 구역에서 연다");
  assert.match(b, /tabsApi\.find\(m\.href\)/, "이미 열린 세션이면 그 자리로");
});
