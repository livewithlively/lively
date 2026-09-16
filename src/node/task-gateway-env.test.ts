// 위탁 판이 «어디에 붙나» env (#4012 T5) — 사양 엣지 표 G1~G11.
//
//  왜 이 파일이 있나(2026-09-16 실사고): 맥미니에 게이트웨이가 둘(olddev + 매니지드 노드)이고 앱 로그인이 운영
//   워크스페이스를 가리키자, olddev 가 띄운 83개 테넌트의 증류 판이 `~/.lively/gateway-url` 을 읽어 **운영
//   워크스페이스에 붙었다** — 우리 자료를 읽고 우리 지식에 썼다. 대화형 세션은 LVLY_TENANT_SLUG 를 싣는데
//   위탁 판만 둘 다 빠져 있었다. 이 값들은 tmux 명령줄(`-e K=V`)에 그대로 펼쳐지므로 **모양 검사**가 곧 안전선이다.
import { strict as assert } from "node:assert";
import { taskGatewayEnvArgs } from "./tasks.js";
import { envKeepPolicy } from "../terminal/session-env-contract.js";

const env = (u: unknown, s: unknown): Record<string, string> => {
  const a = taskGatewayEnvArgs(u as string, s as string);
  //  배선 단언 — `-e K=V` 쌍으로만 나와야 한다(홀수·다른 플래그가 섞이면 tmux 인자가 어긋난다).
  assert.equal(a.length % 2, 0, `-e 쌍이 아니다: ${JSON.stringify(a)}`);
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i += 2) {
    assert.equal(a[i], "-e", `플래그 자리에 -e 가 아닌 것: ${a[i]}`);
    const kv = a[i + 1]; const at = kv.indexOf("=");
    out[kv.slice(0, at)] = kv.slice(at + 1);
  }
  return out;
};

// G1 둘 다 — 판이 보낸 곳에 붙는다.
assert.deepEqual(env("https://lively-46e3.app.lvly.io", "lively-46e3"),
  { LIVELY_GATEWAY_URL: "https://lively-46e3.app.lvly.io", LVLY_TENANT_SLUG: "lively-46e3" }, "G1 둘 다 싣는다");

// G2 ★ 둘 다 없음 — 구 게이트웨이·단일 테넌트는 **아무것도 안 싣는다**(무회귀).
assert.deepEqual(taskGatewayEnvArgs(undefined, undefined), [], "G2 없으면 빈 배열");
assert.deepEqual(taskGatewayEnvArgs(null, null), [], "G2 null 도 빈 배열");

// G3 주소만 — 셀프호스트 단일 테넌트(슬러그 없음).
assert.deepEqual(env("http://localhost:8080", null), { LIVELY_GATEWAY_URL: "http://localhost:8080" }, "G3 주소만");

// G4 슬러그만 — 주소를 못 정한 게이트웨이(PUBLIC_URL·프로필 둘 다 없음).
assert.deepEqual(env(null, "lively-46e3"), { LVLY_TENANT_SLUG: "lively-46e3" }, "G4 슬러그만");

// G5·G6 끝의 `/` 는 다듬는다 — 훅들이 base 에 경로를 이어 붙인다(`//api` 가 되면 라우팅이 어긋난다).
assert.equal(env("https://gw.example.com/", null).LIVELY_GATEWAY_URL, "https://gw.example.com", "G5 끝 슬래시 하나");
assert.equal(env("https://gw.example.com///", null).LIVELY_GATEWAY_URL, "https://gw.example.com", "G6 끝 슬래시 여럿");

// G7 ★ 모양이 아닌 주소는 **안 싣는다** — 명령줄에 펼쳐지는 값이다.
for (const [label, bad] of [
  ["세미콜론", "https://x; rm -rf /"], ["공백", "https://x y"], ["따옴표", 'https://x"'],
  ["자바스크립트", "javascript:alert(1)"], ["다른 스킴", "ftp://x"], ["경로 포함", "https://x/mcp"],
  ["빈 문자열", ""], ["공백뿐", "   "], ["개행", "https://x\nLIVELY_OFF=1"],
] as Array<[string, string]>) {
  assert.equal(env(bad, null).LIVELY_GATEWAY_URL, undefined, `G7 ${label} 거부`);
}

// G8 ★ 모양이 아닌 슬러그도 안 싣는다 — 경로·컨테이너 이름에 들어가는 값이다.
for (const [label, bad] of [
  ["상위 경로", "../x"], ["공백", "a b"], ["대문자", "UPPER"], ["선행 대시", "-lead"],
  ["과길이", "a".repeat(64)], ["빈 문자열", ""], ["개행", "a\nb"],
] as Array<[string, string]>) {
  assert.equal(env(null, bad).LVLY_TENANT_SLUG, undefined, `G8 ${label} 거부`);
}

// G9 포트는 받는다 — 셀프호스트가 흔히 쓴다.
assert.equal(env("https://gw.example.com:8443", null).LIVELY_GATEWAY_URL, "https://gw.example.com:8443", "G9 포트");

// G10 문자열이 아니면 안 싣는다.
assert.deepEqual(taskGatewayEnvArgs(42 as unknown as string, { s: 1 } as unknown as string), [], "G10 비문자열");

// G11 ★ 격리 세션(sudo → box-spawn)에서 sudo 가 **지우지 않는다** — 계약에 keep 이어야 한다.
//  이게 빠지면 셀프호스트 리눅스 격리 박스에서만 주소가 조용히 사라져 이 수정이 무효가 된다.
assert.equal(envKeepPolicy("LIVELY_GATEWAY_URL"), "keep", "G11 LIVELY_GATEWAY_URL 은 keep");
assert.equal(envKeepPolicy("LVLY_TENANT_SLUG"), "keep", "G11 LVLY_TENANT_SLUG 은 keep(종전 계약 유지)");

console.log("✓ task-gateway-env — 위탁 판의 게이트웨이·워크스페이스 주입 (G1~G11)");
