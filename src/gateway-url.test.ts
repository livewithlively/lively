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
  ["https://gw.example.com:8080/mcp/", "https://gw.example.com:8080"],
  ["https://gw.example.com:8080/", "https://gw.example.com:8080"],
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
];
for (const u of safeReject) assert.ok(!SAFE_GATEWAY_URL.test(u), `SAFE should reject ${u}`);

// 정규화 → 검증이 실사용 순서(safe())대로 통과하는지, '/mcp/' 붙은 복붙이 끝까지 살아남는지.
assert.ok(SAFE_GATEWAY_URL.test(normalizeGatewayUrl("https://gw.example.com/mcp/")),
  "normalize+SAFE must accept a pasted '/mcp/' URL end-to-end");

console.log("gateway-url.test.ts OK");
