// #3970 — 관리 권한 재확인(step-up)이 «그 사람이 아는 비밀번호» 를 묻는가.
//
// 이 버그는 화면과 서버가 **서로 다른 비밀번호**를 뜻해서 났다. 매니지드 사용자는 라이블리 계정 비밀번호만
//  아는데, 양쪽 다 프로비저닝이 심어 둔 로컬 비번을 물었다 — 정확히 넣어도 403 인, 통과할 수 없는 관문.
// 그래서 여기서 잠그는 것은 «우선순위» 다: 라이블리 계정으로 들어오는 사람에겐 **로컬 비번이 남아 있어도**
//  그걸 묻지 않는다. 표는 scratchpad/spec.md 의 A·B 표.
import assert from "node:assert/strict";
import test from "node:test";
import { decideStepUp } from "./step-up.js";
import { wantsLocalAccount } from "./members.js";

// ── A. 재확인 수단 판정 ───────────────────────────────────────────────────────
const CP_WITH_PW = { has_password: true };
const CP_NO_PW = { has_password: false };

test("A1 ★ 라이블리 계정 + 비번 있음 + 로컬 비번도 있음 → cp (로컬로 되돌아가지 않는다)", () => {
  assert.equal(decideStepUp(CP_WITH_PW, true), "cp");
});

test("A2 라이블리 계정 + 비번 있음 + 로컬 없음 → cp", () => {
  assert.equal(decideStepUp(CP_WITH_PW, false), "cp");
});

test("A3 ★ 라이블리 계정인데 비번 없음(소셜) + 로컬 비번 있음 → none (그 로컬 비번은 본인이 모른다)", () => {
  assert.equal(decideStepUp(CP_NO_PW, true), "none");
});

test("A4 라이블리 계정인데 비번 없음 + 로컬도 없음 → none", () => {
  assert.equal(decideStepUp(CP_NO_PW, false), "none");
});

test("A5 라이블리 계정 아님 + 로컬 비번 있음 → local (셀프호스트·운영 계정)", () => {
  assert.equal(decideStepUp(null, true), "local");
});

test("A6 라이블리 계정 아님 + 로컬도 없음 → none", () => {
  assert.equal(decideStepUp(null, false), "none");
});

test("A-edge 응답에 has_password 키가 아예 없으면 «있다» 로 읽지 않는다", () => {
  assert.equal(decideStepUp({}, true), "none");
  assert.equal(decideStepUp({ has_password: undefined }, true), "none");
});

// ── B. 초기 비밀번호 발급 ─────────────────────────────────────────────────────
const CP_IDENT = [{ system: "lvly_account", external_id: "acc-1" }];

test("B1 ★ 새 사람이 라이블리 계정으로 들어오면 로컬 초기 비번을 만들지 않는다", () => {
  assert.equal(wantsLocalAccount({ kind: "human", email: "a@b.c", identities: CP_IDENT }, false), false);
});

test("B2 새 사람이고 라이블리 계정이 아니면 만든다(셀프호스트·운영 계정)", () => {
  assert.equal(wantsLocalAccount({ kind: "human", email: "a@b.c", identities: [] }, false), true);
  assert.equal(wantsLocalAccount({ kind: "human", email: "a@b.c" }, false), true);
  assert.equal(wantsLocalAccount({ kind: "human", email: "a@b.c", identities: null }, false), true);
});

test("B3 oidc 신원만 있는 사람은 라이블리 계정이 아니다 — 종전대로 만든다", () => {
  assert.equal(wantsLocalAccount(
    { kind: "human", email: "a@b.c", identities: [{ system: "oidc", external_id: "x" }] }, false), true);
});

test("B4 기존 멤버는 만들지 않는다", () => {
  assert.equal(wantsLocalAccount({ kind: "human", email: "a@b.c", identities: [] }, true), false);
});

test("B5 사람이 아니면 만들지 않는다", () => {
  assert.equal(wantsLocalAccount({ kind: "agent", email: "a@b.c", identities: [] }, false), false);
  assert.equal(wantsLocalAccount({ kind: "system", email: "a@b.c", identities: [] }, false), false);
});

test("B6 이메일이 없으면 만들지 않는다(로그인이 이메일 기준)", () => {
  assert.equal(wantsLocalAccount({ kind: "human", email: "", identities: [] }, false), false);
  assert.equal(wantsLocalAccount({ kind: "human", identities: [] }, false), false);
});

// ── 배선 — 승인 창구와 화면이 정말 이 축을 쓰는가(판정이 옳아도 안 쓰면 소용없다) ──
test("★ 승인 창구는 로컬 비번을 직접 검증하지 않는다 — verifyStepUp 한 길로만 간다", async () => {
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(new URL("../../../src/capabilities/delivery/tokens-devices.ts", import.meta.url), "utf8");
  assert.match(body, /verifyStepUp\(user, pw\)/, "🔴 device_approve 가 verifyStepUp 을 안 쓴다");
  assert.doesNotMatch(body, /verifyOwnPassword|hasCredential/,
    "🔴 승인 창구가 로컬 축을 직접 본다 — 매니지드에선 그 비번을 아무도 모른다");
});

test("★ 화면은 서버 판정을 읽는다 — hasPassword(로컬 축)로 되돌아가지 않는다", async () => {
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(new URL("../../../web/activate.ts", import.meta.url), "utf8");
  assert.match(body, /cli\/device\/stepup-info/, "🔴 화면이 서버 판정을 안 읽는다");
  assert.doesNotMatch(body, /api\('\/api\/ui\/me\/logins'\)/,
    "🔴 화면이 다시 로컬 축(hasPassword)을 본다 — 그 값은 이 게이트웨이의 비번만 안다");
});
