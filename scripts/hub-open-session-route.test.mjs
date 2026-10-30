// #3870 — 프로젝트 허브(액자 안)에서 세션을 열면 **셸이 홈에서** 연다.
//  신고(원준 2026-09-28): 작업 타임라인 모달의 [세션 열기]를 누르면 홈탭의 세션이 아니라 클래식 홈페이지로 간다.
//  원인: 프로젝트 탭은 `?embed=1&shell=classic` 액자(v2/apps.ts appFrame)인데, 그 단추가 location.hash 를 직접 바꿨다 —
//   액자 안 클래식 화면은 `#/s/` 를 몰라 클래식 홈으로 떨어진다. 셸에 부탁하는 길(ctx-registry.requestOpenRoute →
//   'lively:open-route')은 이미 있었다(우클릭 행·태스크 모달이 쓴다).
//  왜 소스 텍스트인가: 이건 값이 아니라 **배선**이다 — 잘못 이어도 콘솔에 아무것도 안 남고 엉뚱한 화면이 뜰 뿐이다.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

// H1. 프로젝트 화면(액자에 실리는 web/projects/*)은 세션 주소를 제 location 에 쓰지 않는다.
for (const f of readdirSync(join(root, "web/projects")).filter((f) => f.endsWith(".ts"))) {
  const s = read("web/projects/" + f);
  ok(!/location\.hash\s*=\s*['"]#\/s\//.test(s), `H1 ${f} — 액자 안에서 location.hash 로 세션을 열지 않는다`);
}

// H2. 허브 부품의 세션 열기 = 셸에 부탁(새 탭 = 부모 창 postMessage).
const kit = read("web/projects/detail-hub-kit.ts");
ok(/export const openSessionRoute = \(sid: string\): void => requestOpenRoute\('#\/s\/' \+ encodeURIComponent\(sid\), true\)/.test(kit),
  "H2 detail-hub-kit.openSessionRoute 가 requestOpenRoute(…, true) 로 셸에 부탁한다");

// H3. 작업 타임라인 옆 칸의 [세션 열기] 단추가 그 길을 쓴다.
const tl = read("web/projects/detail-hub-timeline.ts");
ok(/sbtn\('세션 열기', 'term', \(\) => openSessionRoute\(String\(a\.session_id\)\)/.test(tl), "H3 타임라인 [세션 열기] → openSessionRoute");

// H4. 셸이 받은 세션 주소는 홈 구역에서 연다 — 세션 목록 [세션 열기](paintSessAll onOpen)와 같이.
const main = read("web/v2/main.ts");
const at = main.indexOf("m.type === 'lively:open-route'");
ok(at > 0, "H4a 셸에 'lively:open-route' 받는 자리가 있다");
const block = main.slice(at, main.indexOf("return;", at));
const home = block.indexOf("routeKey(m.href).startsWith('s:')) setRailSection('home', { navigate: false })");
ok(home > 0, "H4b 세션 주소면 구역을 홈으로 옮긴다(주소는 옮기지 않는다)");
ok(home < block.indexOf("tabsApi.find(m.href)"), "H4c 구역을 먼저 옮기고 창을 연다");

console.log(`\n${pass} passed`);
