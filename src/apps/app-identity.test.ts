import { strict as assert } from "node:assert";
import test from "node:test";
import {
  ed25519FromSeed, ed25519PublicKey, signAppIdentity, verifyAppIdentity, appIdentityKeysFromEnv, APP_IDENTITY_MAX_TTL_SEC, APP_IDENTITY_SKEW_SEC,
  type AppIdentityClaims,
} from "./app-identity.js";

// 앱 신원 토큰(X-Lively-Identity, #4483 · v2-1 #4480 합의) — 「입력 × 기대」 엣지 표 I1~I17.
//  ★ 시험 벡터(V) 는 앞단(CP 라우터, lvly-cloud)의 서명 구현이 같은 값을 내는지 맞추는 기준이다 — 바꾸면 그쪽 시험도 바꿔야 한다.
//   Ed25519 는 결정적이라 같은 시드·kid·payload 바이트면 같은 토큰이 나온다. payload 칸 순서: ws, app, var, sub, name, iat, exp.

const V = {
  seedHex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  publicKeyB64: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
  kid: "test-1",
  claims: { ws: "6f477586-8eed-4e75-a321-3a1f0c9d2e41", app: "crm-dash", var: "pub", sub: "pgt-admin", name: "테스트", iat: 1791900000, exp: 1791900600 } as AppIdentityClaims,
  token: "v1.test-1.eyJ3cyI6IjZmNDc3NTg2LThlZWQtNGU3NS1hMzIxLTNhMWYwYzlkMmU0MSIsImFwcCI6ImNybS1kYXNoIiwidmFyIjoicHViIiwic3ViIjoicGd0LWFkbWluIiwibmFtZSI6Iu2FjOyKpO2KuCIsImlhdCI6MTc5MTkwMDAwMCwiZXhwIjoxNzkxOTAwNjAwfQ.aagVdtsWqkcgXbVFIJVYQzRNamKkFMhVHjPyXb-14_O_gAjn2FiEHXJrl8JWV3m_AtZeUG6JHSCrG9l_XGjBCw",
};
const k = ed25519FromSeed(Buffer.from(V.seedHex, "hex"));
const keys = new Map([[V.kid, ed25519PublicKey(V.publicKeyB64)]]);
const want = { ws: V.claims.ws, app: V.claims.app };
const NOW = V.claims.iat + 100;
const sign = (over: Partial<AppIdentityClaims> = {}, kid = V.kid) => signAppIdentity({ ...V.claims, ...over }, k.privateKey, kid);
const rejects = (token: string, re: RegExp, o: { now?: number; want?: { ws: string; app: string }; keys?: Map<string, ReturnType<typeof ed25519PublicKey>> } = {}) => {
  assert.throws(() => verifyAppIdentity(token, o.want ?? want, { keys: o.keys ?? keys, now: o.now ?? NOW }),
    (e: { status?: number; message?: string }) => e.status === 401 && re.test(String(e.message)), `${re} — ${token.slice(0, 60)}`);
};

test("V 시험 벡터 — 시드 → 공개 키 · 같은 칸이면 같은 토큰(결정적) · 검증하면 칸이 그대로 나온다", () => {
  assert.equal(k.publicKeyB64, V.publicKeyB64);
  assert.equal(sign(), V.token);
  assert.deepEqual(verifyAppIdentity(V.token, want, { keys, now: NOW }), V.claims);
});

// ★ 앞단(lvly-cloud control/src/appfront.test.ts, PR #485 [af-ident-1])의 시험 벡터 — 서명 구현이 따로 있는 쪽이 낸 토큰을
//  이 검증 모듈이 그대로 받아야 한다(두 구현이 같은 바이트를 주고받는다). 그쪽 값을 바꾸면 여기도 바꾼다.
const CP = {
  seed: Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)),
  publicKeyB64: "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ",
  claims: { ws: "11111111-2222-4333-8444-555555555555", app: "deck-edit", var: "pub", sub: "sangmin-yoon", name: "윤상민", iat: 1760400000, exp: 1760400600 } as AppIdentityClaims,
  token: "v1.k1.eyJ3cyI6IjExMTExMTExLTIyMjItNDMzMy04NDQ0LTU1NTU1NTU1NTU1NSIsImFwcCI6ImRlY2stZWRpdCIsInZhciI6InB1YiIsInN1YiI6InNhbmdtaW4teW9vbiIsIm5hbWUiOiLsnKTsg4Hrr7wiLCJpYXQiOjE3NjA0MDAwMDAsImV4cCI6MTc2MDQwMDYwMH0"
    + ".jL1JSNcoZXc-5a2xjccy7KC08VtGVS2prYcCTIQBE32oKuv-yQcA7oTRV8uwghKD5kSw_iGrSTRmJ0IC9W_hCA",
};

test("V2 앞단(CP) 시험 벡터 — 그쪽이 낸 토큰을 받는다 · 같은 시드로 이쪽이 서명해도 같은 토큰 · 사람을 바꾸면 거절", () => {
  const cpKeys = new Map([["k1", ed25519PublicKey(CP.publicKeyB64)]]);
  const cpWant = { ws: CP.claims.ws, app: CP.claims.app };
  assert.equal(ed25519FromSeed(CP.seed).publicKeyB64, CP.publicKeyB64);
  assert.deepEqual(verifyAppIdentity(CP.token, cpWant, { keys: cpKeys, now: CP.claims.iat + 1 }), CP.claims);
  assert.equal(signAppIdentity(CP.claims, ed25519FromSeed(CP.seed).privateKey, "k1"), CP.token);
  const [v, kid, , sig] = CP.token.split(".");
  const forged = [v, kid, Buffer.from(JSON.stringify({ ...CP.claims, sub: "admin" })).toString("base64url"), sig].join(".");
  rejects(forged, /서명/, { want: cpWant, keys: cpKeys, now: CP.claims.iat + 1 });
});

test("I1·I11·I12 받는 것 — draft 판 · 이름 없음(칸에 name 이 없다) · ws 대문자 표기", () => {
  assert.equal(verifyAppIdentity(sign({ var: "draft" }), want, { keys, now: NOW }).var, "draft");
  const { name: _n, ...noName } = V.claims;
  const t = signAppIdentity(noName as AppIdentityClaims, k.privateKey, V.kid);
  assert.ok(!("name" in verifyAppIdentity(t, want, { keys, now: NOW })));
  assert.equal(verifyAppIdentity(sign({ ws: V.claims.ws.toUpperCase() }), want, { keys, now: NOW }).ws, V.claims.ws);
});

test("I2·I3·I15 서명 — payload 한 글자 · 서명 한 글자 · 서명 길이 · 다른 키로 서명", () => {
  const [v, kid, p, s] = V.token.split(".");
  const flip = (x: string, i: number) => x.slice(0, i) + (x[i] === "A" ? "B" : "A") + x.slice(i + 1);
  rejects([v, kid, flip(p, 10), s].join("."), /서명이 맞지 않습니다|payload/);
  rejects([v, kid, p, flip(s, 5)].join("."), /서명이 맞지 않습니다/);
  rejects([v, kid, p, s.slice(0, 40)].join("."), /서명 길이/);
  const other = ed25519FromSeed(Buffer.alloc(32, 7));
  rejects(signAppIdentity(V.claims, other.privateKey, V.kid), /서명이 맞지 않습니다/);
});

test("I4·I17 키 — 모르는 kid · 공개 키 목록이 비었으면 전부 거부(받는 쪽으로 새지 않는다)", () => {
  rejects(sign({}, "test-2"), /모르는 서명 키/);
  rejects(V.token, /모르는 서명 키/, { keys: new Map() });
});

test("I5·I16 형식 — 마디 수 · 판 표지 · base64url 밖 글자 · 빈 값 · 너무 긴 토큰", () => {
  const [, kid, p, s] = V.token.split(".");
  rejects(`${kid}.${p}.${s}`, /형식/);
  rejects(`v2.${kid}.${p}.${s}`, /형식/);
  rejects(`v1.${kid}.${p}=.${s}`, /형식/);
  rejects(`v1.bad kid.${p}.${s}`, /형식/);
  rejects("", /비었습니다/);
  rejects(`v1.${kid}.${"A".repeat(5000)}.${s}`, /너무 깁니다/);
});

test("I6·I7·I8·I14 시각 — 만료 경계(exp+30 은 받고 +31 은 거부) · 미래 발급 경계 · 수명 900초 경계 · exp<iat", () => {
  const t = sign();
  assert.ok(verifyAppIdentity(t, want, { keys, now: V.claims.exp + APP_IDENTITY_SKEW_SEC }));
  rejects(t, /만료/, { now: V.claims.exp + APP_IDENTITY_SKEW_SEC + 1 });
  assert.ok(verifyAppIdentity(t, want, { keys, now: V.claims.iat - APP_IDENTITY_SKEW_SEC }));
  rejects(t, /미래/, { now: V.claims.iat - APP_IDENTITY_SKEW_SEC - 1 });
  const max = sign({ exp: V.claims.iat + APP_IDENTITY_MAX_TTL_SEC });
  assert.ok(verifyAppIdentity(max, want, { keys, now: NOW }));
  rejects(sign({ exp: V.claims.iat + APP_IDENTITY_MAX_TTL_SEC + 1 }), /수명/);
  rejects(sign({ exp: V.claims.iat - 1 }), /수명|만료/, { now: V.claims.iat - 10 });
});

test("I9·I10 대상 — 다른 워크스페이스 · 다른 앱의 신원은 서명이 맞아도 거부", () => {
  rejects(V.token, /다른 워크스페이스/, { want: { ws: "7a588697-9ffe-4f86-b432-4b2a1dae3f52", app: "crm-dash" } });
  rejects(V.token, /다른 앱\(crm-dash\)/, { want: { ws: V.claims.ws, app: "memo" } });
});

test("I11·I12 칸 모양 — var · sub · name · iat 정수 · ws·app 모양", () => {
  rejects(sign({ var: "prod" as unknown as "pub" }), /var/);
  rejects(sign({ sub: "" }), /칸/);
  rejects(sign({ name: 3 as unknown as string }), /name/);
  rejects(sign({ iat: 1.5 }), /정수/);
  rejects(sign({ ws: "not-a-uuid" }), /칸/);
  rejects(sign({ app: "Bad_App" }), /칸/);
});

test("I13 공개 키 환경변수 — JSON 이 아니면 키 없음 · 모양이 틀린 항목은 버리고 맞는 항목만 · 같은 값이면 기억", () => {
  assert.equal(appIdentityKeysFromEnv({ LIVELY_APP_IDENTITY_PUBKEYS: "not json" }).size, 0);
  assert.equal(appIdentityKeysFromEnv({}).size, 0);
  const env = { LIVELY_APP_IDENTITY_PUBKEYS: JSON.stringify({ [V.kid]: V.publicKeyB64, "bad kid": V.publicKeyB64, short: "AAAA", num: 3 }) };
  const m = appIdentityKeysFromEnv(env);
  assert.deepEqual([...m.keys()], [V.kid]);
  assert.equal(appIdentityKeysFromEnv(env), m);
  assert.deepEqual(verifyAppIdentity(V.token, want, { keys: m, now: NOW }), V.claims);
});
