import { strict as assert } from "node:assert";
import test from "node:test";
import crypto from "node:crypto";
import {
  signFileUrlToken, verifyFileUrlToken, fileUrlKey, clampTtl, FileUrlTokenError,
  FILE_URL_TTL_DEFAULT_SEC, FILE_URL_TTL_MAX_SEC, FILE_URL_TTL_MIN_SEC, type FileUrlClaims,
} from "./file-url-token.js";

// 서명 주소 토큰(#4673) — 사양 표 E1~E8.
const KEY = fileUrlKey({ CONNECTOR_SECRET_KEY: "0".repeat(64) })!;
const NOW = 1_800_000_000;
const C: FileUrlClaims = { t: "6f477586-8eed-4e75-a321-3a1f0c9d2e41", m: "PUT", r: "apps", p: "crm/out/a.png", s: "sangmin-yoon", a: "crm", e: NOW + 600 };
const fails = (tok: string, kind: string, now = NOW, key = KEY): void => {
  assert.throws(() => verifyFileUrlToken(tok, key, now), (e: unknown) => e instanceof FileUrlTokenError && e.kind === kind, `${kind} — ${tok.slice(0, 40)}`);
};
/** 서명은 맞게 하되 칸만 마음대로 — 모양 검사가 서명 뒤에 서 있는지 본다. */
const forge = (body: Record<string, unknown>): string => {
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `v1.${payload}.${crypto.createHmac("sha256", KEY).update(`v1.${payload}`).digest("base64url")}`;
};

test("E1 서명 → 검증 왕복(앱 주체 · 사람)", () => {
  assert.deepEqual(verifyFileUrlToken(signFileUrlToken(C, KEY), KEY, NOW), C);
  const person: FileUrlClaims = { t: "", m: "GET", r: "shared", p: "project/4670/설계.md", s: "sangmin-yoon", e: NOW + 60 };
  const back = verifyFileUrlToken(signFileUrlToken(person, KEY), KEY, NOW);
  assert.deepEqual(back, person);
  assert.equal("a" in back, false, "사람 토큰에 앱 칸이 생기면 안 된다");
});
test("E2 본문 한 글자 변조 · 다른 키 → 서명 오류", () => {
  const tok = signFileUrlToken(C, KEY);
  const [v, payload, sig] = tok.split(".");
  const body = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
  body.p = "other/secret.txt";
  const tampered = `${v}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.${sig}`;
  fails(tampered, "signature");
  const other = fileUrlKey({ CONNECTOR_SECRET_KEY: "another-master" })!;
  fails(tok, "signature", NOW, other);
});
test("E3 만료 — e < now 는 만료 · e == now 는 받는다(경계)", () => {
  fails(signFileUrlToken({ ...C, e: NOW - 1 }, KEY), "expired");
  assert.equal(verifyFileUrlToken(signFileUrlToken({ ...C, e: NOW }, KEY), KEY, NOW).e, NOW);
});
test("E4 만료가 상한(+3600+30)을 넘으면 우리가 찍은 값이 아니다", () => {
  fails(signFileUrlToken({ ...C, e: NOW + FILE_URL_TTL_MAX_SEC + 31 }, KEY), "malformed");
  assert.ok(verifyFileUrlToken(signFileUrlToken({ ...C, e: NOW + FILE_URL_TTL_MAX_SEC + 30 }, KEY), KEY, NOW));
});
test("E5 조각 수 · 접두 · 글자 모양", () => {
  const tok = signFileUrlToken(C, KEY);
  fails(tok.split(".").slice(0, 2).join("."), "malformed");
  fails("v2" + tok.slice(2), "malformed");
  fails(tok.replace(/\.[^.]+$/, ".a+b/c"), "malformed");
  fails("", "malformed");
  fails("v1." + "a".repeat(5000) + ".b", "malformed");
});
test("E6 칸 빠짐 · 형 틀림은 서명이 맞아도 거절", () => {
  fails(forge({ t: "", m: "POST", r: "apps", p: "crm/x", s: "m", e: NOW + 10 }), "malformed");
  fails(forge({ t: "", m: "GET", r: "personal", p: "x", s: "m", e: NOW + 10 }), "malformed");
  fails(forge({ t: "", m: "GET", r: "shared", p: "x", s: "", e: NOW + 10 }), "malformed");
  fails(forge({ t: "", m: "GET", r: "shared", p: "x", s: "m", e: "soon" }), "malformed");
  fails(forge({ t: "", m: "GET", r: "shared", p: "x", s: "m", a: "", e: NOW + 10 }), "malformed");
  fails(forge({ t: 1, m: "GET", r: "shared", p: "x", s: "m", e: NOW + 10 }), "malformed");
});
test("E7 수명 — 없음 · 아래 · 위 · 경계 · 글자", () => {
  assert.equal(clampTtl(undefined), FILE_URL_TTL_DEFAULT_SEC);
  assert.equal(clampTtl(""), FILE_URL_TTL_DEFAULT_SEC);
  assert.equal(clampTtl("x"), FILE_URL_TTL_DEFAULT_SEC);
  assert.equal(clampTtl(10), FILE_URL_TTL_MIN_SEC);
  assert.equal(clampTtl(99999), FILE_URL_TTL_MAX_SEC);
  assert.equal(clampTtl(600), 600);
  assert.equal(clampTtl(FILE_URL_TTL_MAX_SEC), FILE_URL_TTL_MAX_SEC);
  assert.equal(clampTtl(FILE_URL_TTL_MAX_SEC + 1), FILE_URL_TTL_MAX_SEC);
  assert.equal(FILE_URL_TTL_DEFAULT_SEC, 900);
});
test("E8 키 — 마스터 없음 null · 같은 마스터 같은 키 · 다른 마스터 다른 키 · 32바이트 · OAuth state 키와 다르다", () => {
  assert.equal(fileUrlKey({}), null);
  assert.equal(fileUrlKey({ CONNECTOR_SECRET_KEY: "   " }), null);
  const a = fileUrlKey({ CONNECTOR_SECRET_KEY: "pass-a" })!, a2 = fileUrlKey({ CONNECTOR_SECRET_KEY: "pass-a" })!, b = fileUrlKey({ CONNECTOR_SECRET_KEY: "pass-b" })!;
  assert.equal(a.length, 32);
  assert.ok(a.equals(a2));
  assert.ok(!a.equals(b));
  //  도메인 분리 — 마스터 그대로(sha256)나 OAuth state 파생과 같으면 한쪽 서명이 다른 쪽에 통한다.
  const ikm = crypto.createHash("sha256").update("pass-a", "utf8").digest();
  assert.ok(!a.equals(ikm));
  assert.ok(!a.equals(Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from("lively-oauth-state-v1"), 32))));
});
