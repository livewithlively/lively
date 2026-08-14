// #1473 T2 — OAuth 인가서버의 순수 판정 4종. DB·네트워크 불요(기본 npm test 체인).
//  이 넷이 각각 막는 사고:
//   C 권한 교집합 — 틀리면 **권한이 확대된다**(외부 챗 앱에 admin 이 새는 경로).
//   D redirect_uri 게이트 — 느슨하면 우리가 발급한 인가코드를 임의 주소로 흘리는 오픈 리다이렉터가 된다.
//   E CIMD 문서 검증 — 문서의 client_id 를 안 맞춰보면 **아무나 남의 클라이언트를 참칭**할 수 있다.
//   F 문서 캐시 수명 — 상한이 없으면 회수가 영영 반영 안 되고, 하한이 없으면 매 인가마다 외부 호출이 나간다.
import assert from "node:assert/strict";
import { grantableScopes } from "./grant-util.js";
import { isAcceptableRedirectUri, isCimdClientId, validateCimdDocument, ttlFromHeaders } from "./oauth-clients.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

// ── C. 권한 교집합 — 절대 확대되지 않는다 ──
assert.deepEqual(grantableScopes({ memberScopes: ["items", "context", "admin"] }),
  ["items", "context"], "C1 요청 미지정 → 멤버 상한 전체, 단 위험 scope 제외");
assert.deepEqual(grantableScopes({ memberScopes: ["items", "context"], allowed: ["items"] }),
  ["items"], "C2 요청만큼만");
assert.deepEqual(grantableScopes({ memberScopes: ["items"], allowed: ["items", "db"] }),
  ["items"], "C3 ★ 멤버가 없는 권한은 요청해도 안 나간다(확대 불가)");
assert.deepEqual(grantableScopes({ memberScopes: ["items", "admin"], allowed: ["admin"] }),
  [], "C4 ★ 위험 scope 는 요청·보유해도 제외");
assert.deepEqual(grantableScopes({ memberScopes: ["items", "admin"], allowed: ["admin"], allowDangerous: true }),
  ["admin"], "C5 명시 opt-in 일 때만 위험 scope(디바이스 흐름의 control-plane 승인)");
assert.deepEqual(grantableScopes({ memberScopes: ["items", "context"], allowed: [] }),
  [], "C6 ★ 빈 배열은 '아무것도 허용 안 함' — 미지정(undefined)과 다르다");
assert.deepEqual(grantableScopes({ memberScopes: ["items", 7, "nope", null, "db"] as unknown[] }),
  ["items", "db"], "C7 잡값 섞여도 알려진 권한만");
assert.deepEqual(grantableScopes({ memberScopes: "items" as unknown }), [], "C7' 배열이 아니면 빈 결과");
ok("grantableScopes (C1~C7)");

// ── D. 되돌아갈 주소 ──
assert.equal(isAcceptableRedirectUri("https://a.example/cb"), true, "D1 https");
assert.equal(isAcceptableRedirectUri("http://localhost:8123/cb"), true, "D2 loopback(포트 임의)");
assert.equal(isAcceptableRedirectUri("http://127.0.0.1/cb"), true, "D3 loopback IPv4");
assert.equal(isAcceptableRedirectUri("http://[::1]:9/cb"), true, "D3' loopback IPv6");
assert.equal(isAcceptableRedirectUri("http://evil.example/cb"), false, "D4 ★ 평문 원격 거부");
assert.equal(isAcceptableRedirectUri("myapp://cb"), false, "D5 커스텀 스킴 거부");
assert.equal(isAcceptableRedirectUri("https://a.example/cb#frag"), false, "D6 조각 포함 거부(RFC 6749 §3.1.2)");
assert.equal(isAcceptableRedirectUri("not a url"), false, "D7 파싱 불가 거부");
assert.equal(isAcceptableRedirectUri(""), false, "D7' 빈 값 거부");
ok("isAcceptableRedirectUri (D1~D7)");

// ── G. 문서 기반 식별자 판별 ──
assert.equal(isCimdClientId("https://chatgpt.com/oauth/x/client.json"), true, "G1 https URL");
assert.equal(isCimdClientId("http://x.example/c.json"), false, "G2 http 는 CIMD 아님");
assert.equal(isCimdClientId("0f2b9a1c-1111-2222-3333-444455556666"), false, "G3 DCR uuid");
assert.equal(isCimdClientId("https://x.example/c.json#a"), false, "G4 조각 있으면 CIMD 아님");
ok("isCimdClientId (G1~G4)");

// ── E. CIMD 문서 검증 ──
const CID = "https://chatgpt.com/oauth/abc/client.json";
{
  const info = validateCimdDocument(CID, {
    client_id: CID, client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  });
  assert.equal(info.client_id, CID);
  assert.deepEqual(info.redirect_uris, ["https://chatgpt.com/connector_platform_oauth_redirect"]);
  assert.equal(info.client_name, "ChatGPT");
}
assert.throws(() => validateCimdDocument(CID, { client_id: "https://evil.example/c.json", redirect_uris: ["https://a/cb"] }),
  /일치하지 않음/, "E2 ★ 문서의 client_id 가 URL 과 다르면 거부(신원 도용 차단)");
assert.throws(() => validateCimdDocument(CID, { redirect_uris: ["https://a/cb"] }),
  /일치하지 않음/, "E2' client_id 자체가 없어도 거부");
assert.throws(() => validateCimdDocument(CID, { client_id: CID, redirect_uris: [] }),
  /redirect_uris/, "E3 되돌아갈 주소 없음 → 거부");
assert.throws(() => validateCimdDocument(CID, { client_id: CID, redirect_uris: ["http://evil.example/cb", "myapp://cb"] }),
  /redirect_uris/, "E4 전부 비허용 → 거부");
{
  const info = validateCimdDocument(CID, { client_id: CID, redirect_uris: ["http://evil.example/cb", "https://ok.example/cb"] });
  assert.deepEqual(info.redirect_uris, ["https://ok.example/cb"], "E5 허용된 주소만 남긴다");
}
assert.throws(() => validateCimdDocument(CID, { client_id: CID, redirect_uris: "https://a/cb" }),
  /형식 오류/, "E6 메타데이터 형식 위반 → 거부");
assert.throws(() => validateCimdDocument(CID, null), /일치하지 않음/, "E6' 문서가 객체가 아님 → 거부");
{
  const info = validateCimdDocument(CID, { client_id: CID, redirect_uris: ["https://a.example/cb"], client_secret: "s3cret" });
  assert.equal(info.client_secret, undefined, "E7 ★ 문서에 비밀이 적혀 있어도 공개 클라이언트로 취급");
}
ok("validateCimdDocument (E1~E7)");

// ── F. 문서 캐시 수명 ──
const hdr = (v?: string): Headers => new Headers(v ? { "cache-control": v } : {});
assert.equal(ttlFromHeaders(hdr()), 3600, "F1 헤더 없음 → 1시간");
assert.equal(ttlFromHeaders(hdr("max-age=60")), 300, "F2 ★ 하한 5분");
assert.equal(ttlFromHeaders(hdr("max-age=999999")), 86400, "F3 ★ 상한 24시간(회수 반영 지연 방지)");
assert.equal(ttlFromHeaders(hdr("no-store")), 300, "F4 캐시 금지 요구여도 최소 5분");
assert.equal(ttlFromHeaders(hdr("public, max-age=7200")), 7200, "F5 범위 안이면 그대로");
assert.equal(ttlFromHeaders(hdr("max-age=abc")), 3600, "F5' 파싱 불가 → 기본값");
ok("ttlFromHeaders (F1~F5)");

console.log(`oauth unit tests: ${pass} groups passed`);
