#!/usr/bin/env node
// ★배선 가드 — **게이트웨이가 자기 능력을 전부 등록한다** (#2165).
//
//  왜 이 테스트가 필요한가. `sessions/gateway-capabilities.ts` 는 의존 방향을 뒤집는다 —
//  노드가 도달하는 모듈이 DB·자격 구현을 import 하지 않고, 게이트웨이가 부팅 때 꽂는다. 그래야 그 코드가
//  멤버 PC 로 나가는 노드 번들에서 빠진다(실측: GitHub App 서명·설치토큰 발급·OAuth 브로커가 실려 있었다).
//
//  🔴 그 설계의 유일한 위험은 **등록을 빠뜨리는 것**이고, 그 사고는 조용하다:
//     세션은 그대로 뜨고 공개 레포는 그냥 clone 된다 — **사설 레포에서만** 터진다. 즉 몇 주 안 들킬 수 있다.
//     그래서 '능력을 하나 선언했으면 게이트웨이가 반드시 등록한다'를 소스 수준에서 못박는다.
//     (`gateway-capabilities.ts` 의 런타임 경고는 두 번째 겹이다 — 그건 사고가 난 뒤에야 운다.)
//
//  실행: node scripts/gateway-capabilities-wired.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel) => readFileSync(join(ROOT, rel), "utf8");

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

const CAPS = src("src/sessions/gateway-capabilities.ts");
const INDEX = src("src/index.ts");

// 선언된 능력 이름을 **소스에서 읽는다** — 목록을 여기 복붙하면 능력이 늘 때 가드가 조용히 뒤처진다.
const declared = (() => {
  const m = CAPS.match(/GATEWAY_CAPABILITY_NAMES\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, "GATEWAY_CAPABILITY_NAMES 를 못 찾았다 — 가드가 무엇을 검사해야 할지 모른다");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
})();

t(`[W1] 능력 이름을 소스에서 읽었다 (${declared.length}개: ${declared.join(", ")})`, () => {
  assert.ok(declared.length > 0);
});

t("[W2] 선언된 이름이 인터페이스에도 전부 있다 — 목록과 타입이 갈라지지 않게", () => {
  for (const n of declared) assert.match(CAPS, new RegExp(`\\n\\s*${n}\\?:`), `GatewayCapabilities 에 ${n} 이 없다`);
});

t("[W3] 🔴 게이트웨이(src/index.ts)가 registerGatewayCapabilities 를 부른다", () => {
  assert.match(INDEX, /registerGatewayCapabilities\s*\(/,
    "게이트웨이가 능력을 등록하지 않는다 — git 자격이 조용히 죽는다(사설 레포 clone·세션 자격 주입).");
});

//  등록 호출의 **인자 객체 전체**를 괄호를 세어 자른다.
//   ⚠ 종전엔 `indexOf("}")` 로 첫 닫는 괄호까지만 봤다. 중첩 능력(`kitSeedDeps: { … }`)이 **마지막**일 때만
//    우연히 맞았고, 중첩이 둘이 되는 순간(#3668 T3 의 harnessSeat) 뒤 항목이 통째로 안 보여 «등록이 빠졌다» 는
//    거짓 빨간불이 났다. 가드가 인자 순서에 걸리면 사람이 가드를 피해 코드를 배치하게 된다 — 그건 가드가 아니다.
function registerArg(src) {
  const at = src.indexOf("registerGatewayCapabilities(");
  assert.notEqual(at, -1, "등록 호출을 못 찾았다");
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  assert.fail("등록 호출의 인자 객체가 닫히지 않는다");
}

t("[W4] 🔴 선언된 능력이 **하나도 빠짐없이** 등록된다", () => {
  const arg = registerArg(INDEX);
  const missing = declared.filter((n) => !arg.includes(n));
  assert.deepEqual(missing, [],
    `등록이 빠진 능력: ${missing.join(", ")} — 선언만 하고 안 꽂으면 그 기능은 게이트웨이에서도 없는 것이다.`);
});

t("[W4b] 가드가 **인자 순서에 안 걸린다** — 중첩 능력이 뒤에 오는 항목을 가리면 안 된다", () => {
  //  회귀락: 종전 판(첫 `}` 까지 자르기)이면 아래 합성 입력에서 `zeta` 를 못 본다.
  const synth = 'registerGatewayCapabilities({ alpha, beta: { x, y }, zeta });';
  assert.ok(registerArg(synth).includes("zeta"),
    "중첩 능력 뒤의 등록을 가드가 못 본다 — 사람이 가드를 피해 인자 순서를 정하게 된다");
});

t("[W5] 노드 에이전트 진입점은 이 구현들을 직접 import 하지 않는다(그러면 번들에 되돌아온다)", () => {
  const agent = src("src/node/agent.ts");
  for (const bad of ["git-credential-store", "git-credential-materialize-gateway"])
    assert.ok(!agent.includes(bad), `node/agent.ts 가 ${bad} 를 import 한다 — 뒤집은 의존이 원위치했다`);
});

console.log(`\n${pass} passed — 게이트웨이 능력 배선(#2165)`);
