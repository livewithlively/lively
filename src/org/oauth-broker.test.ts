// OAuth 브로커(#746 T2) 순수 프리미티브 단위 체크 — DB 불요. VaultOAuthProvider(DB 백엔드)는 배선 후 통합테스트.
// 실행: npm run build && node dist/org/oauth-broker.test.js
//  커버: PKCE(S256 정합·url-safe) / 서명 state(왕복·위변조·만료·키불일치·형식) / 토큰 코덱(왕복·불량·meta 토큰금지) / client metadata.
process.env.CONNECTOR_SECRET_KEY ||= "0".repeat(64); // state 서명키 소스(테스트용 결정값)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { generatePkce, signState, verifyState, encodeTokenBlob, decodeTokenBlob, tokenMeta, buildClientMetadata } from "./oauth-broker.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const throws = (fn: () => void, re: RegExp): void => { assert.throws(fn, (e: Error) => (assert.match(e.message, re), true)); };

// ── PKCE(RFC 7636 S256) ──
t("generatePkce: challenge = base64url(sha256(verifier)), method S256, url-safe", () => {
  const p = generatePkce();
  assert.equal(p.method, "S256");
  assert.equal(p.challenge, crypto.createHash("sha256").update(p.verifier).digest().toString("base64url"));
  assert.doesNotMatch(p.verifier, /[+/=]/); // url-safe·무패딩
  assert.ok(p.verifier.length >= 43);
  assert.notEqual(generatePkce().verifier, p.verifier); // 매번 랜덤
});

// ── 서명 state — CSRF·위변조 방지 + 콜백 라우팅 문맥 ──
t("signState/verifyState: 왕복 시 문맥(member·server·scope·nonce) 보존", () => {
  const tok = signState({ m: "u1", s: "notion_oauth", k: "", n: "abc123" });
  const p = verifyState(tok);
  assert.equal(p.m, "u1"); assert.equal(p.s, "notion_oauth"); assert.equal(p.k, ""); assert.equal(p.n, "abc123");
  assert.ok(p.e > Math.floor(Date.now() / 1000)); // 만료 미래
});
t("verifyState: 페이로드 위변조 → 서명 불일치 throw", () => {
  const tok = signState({ m: "u1", s: "srv", k: "", n: "n1" });
  const [body, mac] = tok.split(".");
  const forged = Buffer.from(JSON.stringify({ m: "attacker", s: "srv", k: "", n: "n1", e: 9999999999 }), "utf8").toString("base64url");
  throws(() => verifyState(`${forged}.${mac}`), /서명 불일치/); // 남의 계정으로 바꿔치기 차단
  throws(() => verifyState(`${body}.${mac.slice(0, -2)}AA`), /서명 불일치/); // mac 변조
});
t("verifyState: 만료 → throw", () => {
  const tok = signState({ m: "u1", s: "srv", k: "", n: "n1" }, -1); // 이미 만료
  throws(() => verifyState(tok), /만료/);
});
t("verifyState: 키 불일치(다른 마스터) → throw", () => {
  const tok = signState({ m: "u1", s: "srv", k: "", n: "n1" });
  const saved = process.env.CONNECTOR_SECRET_KEY;
  process.env.CONNECTOR_SECRET_KEY = "f".repeat(64); // 다른 키로 검증
  try { throws(() => verifyState(tok), /서명 불일치/); } finally { process.env.CONNECTOR_SECRET_KEY = saved; }
});
t("verifyState: 형식 오류 → throw", () => {
  throws(() => verifyState("nodot"), /형식 오류/);
  throws(() => verifyState(""), /형식 오류/);
});

// ── 토큰 코덱 — 토큰 통째 암호화 슬롯 저장, meta 엔 비밀 아닌 것만 ──
t("encode/decodeTokenBlob: 왕복", () => {
  const tokens = { access_token: "at-xxx", token_type: "bearer", refresh_token: "rt-yyy", expires_in: 3600 } as never;
  assert.deepEqual(decodeTokenBlob(encodeTokenBlob(tokens)), tokens);
});
t("decodeTokenBlob: 불량/누락 → null(access_token 없으면 무효)", () => {
  assert.equal(decodeTokenBlob(null), null);
  assert.equal(decodeTokenBlob("{not json"), null);
  assert.equal(decodeTokenBlob(JSON.stringify({ refresh_token: "x" })), null);
});
t("tokenMeta: 만료/scope 만 노출, access/refresh_token 은 meta 에 없음", () => {
  const m = tokenMeta({ access_token: "at", refresh_token: "rt", token_type: "bearer", expires_in: 3600, scope: "read" } as never);
  assert.equal(typeof m.expires_at, "number");
  assert.equal(m.scope, "read");
  assert.ok(!("access_token" in m) && !("refresh_token" in m)); // 평문 meta 로 토큰 유출 금지
});

// ── 클라이언트 메타데이터 ──
t("buildClientMetadata: PKCE public 클라 기본(redirect·refresh_token·none)", () => {
  const cm = buildClientMetadata({ redirectUrl: "https://gw.example.com/oauth/callback", clientName: "Lively", scope: "read write" });
  assert.deepEqual(cm.redirect_uris, ["https://gw.example.com/oauth/callback"]);
  assert.ok((cm.grant_types ?? []).includes("refresh_token"));
  assert.equal(cm.token_endpoint_auth_method, "none");
  assert.equal(cm.scope, "read write");
});

console.log(`\nOAUTH-BROKER UNIT: ${pass} passed`);
