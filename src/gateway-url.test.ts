// gateway-url 정규화/형태검증 테이블 테스트.
//  실행: npm run build && node dist/gateway-url.test.js
//
//  이 값은 실행되는 셸/PowerShell 스크립트의 문자열 리터럴로 굽힌다(gateway-url.ts §주석) →
//  형태검증(SAFE_GATEWAY_URL)과 정규화(normalizeGatewayUrl)는 신뢰경계다. 순수 함수라 DB 불요.
import assert from "node:assert/strict";
import { normalizeGatewayUrl, SAFE_GATEWAY_URL } from "./gateway-url.js";

// ── normalizeGatewayUrl: '/mcp' 꼬리와 말미 슬래시를 순서 무관하게 흡수해야 한다 ──
const norm: Array<[string, string]> = [
  ["http://host", "http://host"],
  ["http://host/", "http://host"],
  ["http://host/mcp", "http://host"],
  // 회귀 핵심: 사람이 MCP 엔드포인트를 말미 슬래시까지 붙여 복붙하는 흔한 형태.
  //  순서 버그(먼저 /mcp$ 를 떼고 → 슬래시 제거)면 '/mcp' 가 살아남아 SAFE 검증에서 탈락한다.
  ["http://host/mcp/", "http://host"],
  ["http://host/mcp///", "http://host"],
  // '/mcp' 를 뗀 **뒤에** 남는 슬래시 — 마지막 제거 단계가 필요한 유일한 행.
  ["http://host//mcp", "http://host"],
  ["https://gw.example.com:8080/mcp/", "https://gw.example.com:8080"],
  ["https://gw.example.com:8080/", "https://gw.example.com:8080"],
  // 앞뒤 공백 — kit/cli 의 normGw 는 trim 까지 하는 같은 체인이다. 한쪽만 흡수하면 같은 값이 CLI 에선
  //  살고 게이트웨이에선 SAFE 검증(공백 불허)에 걸려 죽는다. 붙여넣기·env 줄바꿈으로 실제로 섞인다.
  ["  http://host  ", "http://host"],
  ["\thttp://host/mcp/\n", "http://host"],
  [" https://gw.example.com:8080/mcp/ ", "https://gw.example.com:8080"],
  // 정규화 결과가 **빈 문자열**일 수 있다 — 그건 정상이고 형태검증이 거른다(아래 SAFE 가 "" 를 거부).
  //  trim 을 넣으면서 새로 생긴 엣지다: 공백뿐인 값이 통째로 사라진다.
  ["", ""],
  ["   ", ""],
];
for (const [input, want] of norm) {
  assert.equal(normalizeGatewayUrl(input), want, `normalizeGatewayUrl(${input})`);
}

// ── SAFE_GATEWAY_URL: 정규화 뒤 값은 스킴+호스트(+포트)만, 경로/자격/공백 없어야 통과 ──
const safeOk = [
  "http://host",
  "https://gw.example.com",
  "https://gw.example.com:8080",
  "http://192.0.2.10:8080",
];
for (const u of safeOk) assert.ok(SAFE_GATEWAY_URL.test(u), `SAFE should accept ${u}`);

const safeReject = [
  "http://host/mcp",          // 정규화가 안 됐다면 경로가 남아 탈락(방어선)
  "https://host/some/path",
  "ftp://host",
  'http://host"; rm -rf /',   // 셸 인젝션 시도
  "http://host$(whoami)",
  "http://user:pass@host",
  "",                          // 정규화가 통째로 비운 값(공백뿐인 입력) — 링크·스크립트로 새면 안 된다
];
for (const u of safeReject) assert.ok(!SAFE_GATEWAY_URL.test(u), `SAFE should reject ${u}`);

// 정규화 → 검증이 실사용 순서(safe())대로 통과하는지, '/mcp/' 붙은 복붙이 끝까지 살아남는지.
assert.ok(SAFE_GATEWAY_URL.test(normalizeGatewayUrl("https://gw.example.com/mcp/")),
  "normalize+SAFE must accept a pasted '/mcp/' URL end-to-end");
// 공백까지 섞인 최악의 복붙도 끝까지 살아남아야 한다 — 공백은 SAFE 가 거부하므로 정규화가 유일한 방어선이다.
assert.ok(SAFE_GATEWAY_URL.test(normalizeGatewayUrl(" https://gw.example.com/mcp/\n")),
  "normalize+SAFE must accept a pasted URL with surrounding whitespace end-to-end");
// 반대 방향: 공백뿐인 값은 정규화가 비우고 SAFE 가 거부해 **base 없음**으로 떨어져야 한다(엉뚱한 base 금지).
assert.ok(!SAFE_GATEWAY_URL.test(normalizeGatewayUrl("   ")),
  "normalize+SAFE must reject a whitespace-only value (no base, not a bogus one)");

console.log("gateway-url.test.ts OK");
