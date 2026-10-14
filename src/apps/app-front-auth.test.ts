// 앱 주소 앞단 → 게이트웨이 기계 헤더(#4480 v2-1) — 사양 표 B. 실행: npm run build && node dist/apps/app-front-auth.test.js
//  이게 틀리면: 인터넷에서 `<slug>.app.lvly.io/api/app-front/me` 로 아무 구성원 행세를 하거나(서명·테넌트·시각 검사 구멍),
//   CP 라우터와 계산이 어긋나 모든 앱 주소가 401 이 된다(고정 시험 벡터 — lvly-cloud appfront.test.ts 에 같은 값).
import assert from "node:assert/strict";
import { appFrontKey, signAppFront, verifyAppFront, type AppFrontPayload } from "./app-front-auth.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

const SECRET = "test-secret-4480";
const T = { id: "11111111-1111-1111-1111-111111111111", slug: "lively-46e3" };
const NOW = 1_791_000_000;
const act = (over: Partial<Record<string, unknown>> = {}): AppFrontPayload =>
  ({ op: "act", t: T.id, ws: T.slug, app: "deck-edit", var: "pub", mid: "sangmin-yoon", iat: NOW, ...over }) as AppFrontPayload;
/** 서명은 맞게, 본문만 내가 고른 것으로(검증기가 서명 뒤의 본문 칸을 실제로 보는지 재려고). */
const signRaw = (secret: string, body: unknown): string => signAppFront(secret, body as AppFrontPayload);

// ── B1 고정 시험 벡터 — CP 라우터(lvly-cloud)가 같은 식으로 만든다. 한쪽 계산만 바뀌면 여기가 빨개진다. ──
//  (값은 이 식을 node 한 줄로 따로 계산해 박았다 — HMAC(비밀,"lvly-app-front/v1") → HMAC(Kf, "v1."+본문). 본문 키 순서까지 같아야 같은 문자열이다.)
// ⓘ 이름에 KEY 를 넣지 않는다 — 비밀 탐지(gitleaks generic-api-key)가 `*_KEY = "<고엔트로피>"` 를 자격증명으로 오인한다(.gitleaks.toml 머리말 관례). 값은 시험 비밀에서 파생한 시험 벡터다.
const PINNED_KF_HEX = "87c195dafeda6e3707b5870eb4f66f9d2466ba59c0978b7e7913a5338ddf05ae";
const PINNED_ACT_HEADER = "v1.eyJvcCI6ImFjdCIsInQiOiIxMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTEiLCJ3cyI6ImxpdmVseS00NmUzIiwiYXBwIjoiZGVjay1lZGl0IiwidmFyIjoicHViIiwibWlkIjoic2FuZ21pbi15b29uIiwiaWF0IjoxNzkxMDAwMDAwfQ.JN-lSoI_PQcoTFIJ9EOSnAuQ41-5DPIGhESjJ6SU1-I";
{
  assert.equal(appFrontKey(SECRET).toString("hex"), PINNED_KF_HEX, "Kf");
  assert.equal(signAppFront(SECRET, act()), PINNED_ACT_HEADER, "고정 벡터 — act");
  const v = verifyAppFront(PINNED_ACT_HEADER, { secret: SECRET, tenant: T, op: "act", nowSec: NOW });
  assert.ok(v.ok, "고정 벡터를 받는다");
  ok("B1 고정 시험 벡터(Kf · act 헤더)");
}

// ── B2 왕복 ──
{
  const v = verifyAppFront(signAppFront(SECRET, act()), { secret: SECRET, tenant: T, op: "act", nowSec: NOW });
  assert.ok(v.ok && v.payload.op === "act" && v.payload.mid === "sangmin-yoon" && v.payload.app === "deck-edit" && v.payload.var === "pub");
  const r = verifyAppFront(signAppFront(SECRET, { op: "redeem", t: T.id, ws: T.slug, iat: NOW }), { secret: SECRET, tenant: T, op: "redeem", nowSec: NOW });
  assert.ok(r.ok && r.payload.op === "redeem");
  ok("B2 왕복 — act · redeem");
}

// ── B3 문 앞에서 거부 — 비밀 없음 · 테넌트 없음 · 꼴 ──
{
  const h = signAppFront(SECRET, act());
  assert.equal(verifyAppFront(h, { secret: "", tenant: T, op: "act", nowSec: NOW }).ok, false, "비밀 없음");
  assert.equal(verifyAppFront(h, { secret: SECRET, tenant: null, op: "act", nowSec: NOW }).ok, false, "테넌트 없음");
  for (const bad of [undefined, "", "v1", "v2." + h.slice(3), h + ".x", "v1.@@@.abc", h.replace(/\.[^.]+$/, ".short")]) {
    assert.equal(verifyAppFront(bad, { secret: SECRET, tenant: T, op: "act", nowSec: NOW }).ok, false, `꼴: ${String(bad).slice(0, 20)}`);
  }
  ok("B3 비밀 없음 · 테넌트 없음 · 꼴 틀림 거부");
}

// ── B4 서명 — 다른 비밀 · 본문 바꿔치기 ──
{
  assert.equal(verifyAppFront(signAppFront("other-secret", act()), { secret: SECRET, tenant: T, op: "act", nowSec: NOW }).ok, false, "다른 비밀");
  const h = signAppFront(SECRET, act());
  const [v, , sig] = h.split(".");
  const forged = `${v}.${Buffer.from(JSON.stringify(act({ mid: "admin" }))).toString("base64url")}.${sig}`;
  assert.equal(verifyAppFront(forged, { secret: SECRET, tenant: T, op: "act", nowSec: NOW }).ok, false, "본문만 바꿔치기");
  const notJson = `v1.${Buffer.from("not json").toString("base64url")}.`;
  const sigOfNotJson = signRaw(SECRET, "x");   // 꼴만 맞춘 것 — 서명이 다르니 거부
  assert.equal(verifyAppFront(notJson + sigOfNotJson.split(".")[2], { secret: SECRET, tenant: T, op: "act", nowSec: NOW }).ok, false, "본문 JSON 아님");
  ok("B4 다른 비밀 · 본문 바꿔치기 · JSON 아닌 본문 거부");
}

// ── B5 op · 테넌트 ──
{
  const o = { secret: SECRET, tenant: T, nowSec: NOW };
  assert.equal(verifyAppFront(signAppFront(SECRET, act()), { ...o, op: "redeem" }).ok, false, "act 를 redeem 자리에");
  assert.equal(verifyAppFront(signAppFront(SECRET, { op: "redeem", t: T.id, ws: T.slug, iat: NOW }), { ...o, op: "act" }).ok, false, "redeem 을 act 자리에");
  assert.equal(verifyAppFront(signAppFront(SECRET, act({ t: "22222222-2222-2222-2222-222222222222" })), { ...o, op: "act" }).ok, false, "테넌트 id 다름");
  assert.equal(verifyAppFront(signAppFront(SECRET, act({ ws: "other-1a2b" })), { ...o, op: "act" }).ok, false, "슬러그 다름");
  ok("B5 op 다름 · 테넌트 id 다름 · 슬러그 다름 거부");
}

// ── B6 시각 경계 — 정확히 60초 차이는 됨, 61초는 안 됨(앞뒤 둘 다) ──
{
  const o = { secret: SECRET, tenant: T, op: "act" as const };
  assert.equal(verifyAppFront(signAppFront(SECRET, act({ iat: NOW - 60 })), { ...o, nowSec: NOW }).ok, true, "60초 전 됨");
  assert.equal(verifyAppFront(signAppFront(SECRET, act({ iat: NOW + 60 })), { ...o, nowSec: NOW }).ok, true, "60초 뒤 됨");
  assert.equal(verifyAppFront(signAppFront(SECRET, act({ iat: NOW - 61 })), { ...o, nowSec: NOW }).ok, false, "61초 전 안 됨");
  assert.equal(verifyAppFront(signAppFront(SECRET, act({ iat: NOW + 61 })), { ...o, nowSec: NOW }).ok, false, "61초 뒤 안 됨");
  assert.equal(verifyAppFront(signAppFront(SECRET, act({ iat: "x" })), { ...o, nowSec: NOW }).ok, false, "시각이 숫자 아님");
  ok("B6 시각 경계 ±60 됨 · ±61 안 됨 · 숫자 아님 안 됨");
}

// ── B7 act 신원 칸 ──
{
  const o = { secret: SECRET, tenant: T, op: "act" as const, nowSec: NOW };
  assert.equal(verifyAppFront(signAppFront(SECRET, act({ app: "Bad App" })), o).ok, false, "앱 id 꼴");
  assert.equal(verifyAppFront(signAppFront(SECRET, act({ var: "beta" })), o).ok, false, "모르는 판");
  assert.equal(verifyAppFront(signAppFront(SECRET, act({ mid: "" })), o).ok, false, "빈 구성원");
  assert.equal(verifyAppFront(signAppFront(SECRET, act({ mid: "x".repeat(201) })), o).ok, false, "구성원 id 200자 초과");
  const d = verifyAppFront(signAppFront(SECRET, act({ var: "draft", mid: "윤상민" })), o);
  assert.ok(d.ok && d.payload.op === "act" && d.payload.var === "draft" && d.payload.mid === "윤상민", "초안 · 한글 id 는 된다");
  ok("B7 act 신원 칸 — 앱 id · 판 · 구성원 id");
}

console.log(`\n${pass} passed`);
