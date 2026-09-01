// #1881 G5 구글 "팀 자료로 모으기" — 순수 규칙 회귀 잠금. DB·네트워크 불요.
//   실행: npm run build && node dist/capabilities/google-connect.test.js
//
//   ★ 이 표가 겨누는 고장 둘:
//    ① **비용 사고** — 안 고른 Gmail(제한범위)이 켜져 미검증 100명 한도를 태우는 것. 그 카운트는 프로젝트
//       수명 누적이고 리셋·증액이 불가능해서, 한 번 태우면 되돌릴 수 없다.
//    ② **조용한 성공** — 동의하지 않은 서비스의 수집기가 켜져 run 은 ok 인데 자료가 0건인 상태.
import assert from "node:assert/strict";
import { scopeCovers, GOOGLE_COLLECTORS, googleCollectAction, splitGoogleServices, GOOGLE_TOOL_ONLY_SERVICES } from "./google-connect.js";
import { consumesUnverifiedUserCap, googleConsentTier } from "../org/credentials/google-oauth.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const DRIVE_RO = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const GMAIL_RO = "https://www.googleapis.com/auth/gmail.readonly";
const CAL_RO = "https://www.googleapis.com/auth/calendar.readonly";

// ── 동의 범위 ↔ 수집기 짝 ──────────────────────────────────────────────────────
t("P1 동의한 서비스만 '켤 수 있음'으로 본다", () => {
  const scope = `openid ${DRIVE_RO}`;
  assert.equal(scopeCovers(scope, "drive"), true);
  assert.equal(scopeCovers(scope, "gmail"), false, "동의 안 한 Gmail 을 켜면 run 은 ok 인데 자료가 0건이 된다");
});

t("P2 drive.file(비민감)도 드라이브 동의로 친다 — CASA 밖 경로가 막히면 안 된다", () => {
  assert.equal(scopeCovers(`openid ${DRIVE_FILE}`, "drive"), true);
});

t("P3 캘린더만 동의한 사람은 드라이브·Gmail 둘 다 못 켠다", () => {
  const scope = `openid ${CAL_RO}`;
  assert.equal(scopeCovers(scope, "drive"), false);
  assert.equal(scopeCovers(scope, "gmail"), false);
});

t("P4 빈 scope 는 아무것도 못 켠다(연결은 됐지만 범위를 모를 때 — fail-closed)", () => {
  assert.equal(scopeCovers("", "drive"), false);
  assert.equal(scopeCovers("", "gmail"), false);
});

t("★ P5b Gmail 전체 접근(https://mail.google.com/)도 Gmail 동의다 — 접두가 다르다", () => {
  // 가장 넓게 동의한 사람이 '동의 안 함'으로 판정되면 수집기를 못 켠다(거짓 음성). /auth/gmail. 만 보면 이걸 놓친다.
  assert.equal(scopeCovers("openid https://mail.google.com/", "gmail"), true);
  assert.equal(scopeCovers("openid https://mail.google.com/", "drive"), false, "메일 전체 권한이 드라이브 동의로 둔갑하면 안 된다");
});

t("P5 ★ 'drive' 문자열이 Gmail 판정에 새지 않는다(그 반대도)", () => {
  // 접두 매칭을 대충 하면 gmail.readonly 가 drive 로, drive.file 이 gmail 로 잡히는 사고가 난다
  assert.equal(scopeCovers(`openid ${GMAIL_RO}`, "drive"), false);
  assert.equal(scopeCovers(`openid ${DRIVE_RO}`, "gmail"), false);
});

// ── 수집 대상 ────────────────────────────────────────────────────────────────
t("P6 수집기는 드라이브·Gmail 둘뿐 — 캘린더는 자료가 아니다(도구 면에서 읽는다)", () => {
  assert.deepEqual(GOOGLE_COLLECTORS.map((c) => c.service), ["drive", "gmail"]);
  assert.deepEqual(GOOGLE_COLLECTORS.map((c) => c.preset), ["gdrive", "gmail"]);
  // 인스턴스 키가 겹치면 한쪽이 다른 쪽을 덮어써 수집기가 통째로 사라진다
  assert.equal(new Set(GOOGLE_COLLECTORS.map((c) => c.instance)).size, GOOGLE_COLLECTORS.length);
});

// ── ★ 비용 규칙(§9) — 무엇을 켜면 되돌릴 수 없는 100 한 칸을 태우는가 ──────────────
t("P7 ★ 드라이브만 모으면(비민감 경로) 100명 한도를 안 태운다", () => {
  assert.equal(consumesUnverifiedUserCap(["drive_file"]), false);
  assert.equal(googleConsentTier(["drive_file"]), "non_sensitive");
});

t("P8 ★ Gmail 이 섞이는 순간 제한범위 — CASA 또는 100명 한도가 붙는다", () => {
  assert.equal(googleConsentTier(["gmail"]), "restricted");
  assert.equal(consumesUnverifiedUserCap(["drive_file", "gmail"]), true);
});

t("P9 기본값이 드라이브만인 이유 — Gmail 을 기본으로 끼우면 전원이 한 칸씩 태운다", () => {
  // org_google_collect_set 은 services 가 비면 ["drive"] 로 떨어진다. 그 선택이 곧 비용이다.
  assert.equal(consumesUnverifiedUserCap(["drive_file"]), false);
  assert.equal(consumesUnverifiedUserCap(["drive"]), true, "drive.readonly 는 제한범위 — G6 실측 전까지는 이쪽이다");
});

// ── 1차 런칭 게이트: Gmail 제외 (윤상민 결정 2026-08-26) ──────────────────────
//  이 묶음이 겨누는 것은 **비대칭 대가**다. 한쪽으로 틀리면 되돌릴 수 없는 100명 한도가 타고,
//  반대쪽으로 틀리면 지금 잘 돌던 조직의 수집이 배포 하나로 조용히 멈춘다.
t("P10 ★ Gmail 을 골라도 새로 켜지지 않는다 — 태운 한도는 되돌릴 수 없다", () => {
  const r = googleCollectAction({ service: "gmail", wanted: true, enabled: false, scopeOk: true });
  assert.equal(r.action, "none");
  assert.equal(r.reason, "not_offered");
  assert.ok(r.message && r.message.includes("100명"), "왜 안 되는지를 말해 줘야 사람이 다음 행동을 안다");
});

t("P11 ★ 이미 켜 둔 Gmail 은 끄지 않는다 — 런칭 범위 결정이 기존 고객을 깨뜨릴 이유가 없다", () => {
  const r = googleCollectAction({ service: "gmail", wanted: false, enabled: true, scopeOk: true });
  assert.notEqual(r.action, "disable", "여길 disable 로 두면 배포 순간 남의 수집이 조용히 멈춘다");
  assert.equal(r.action, "none");
  assert.ok(r.message && r.message.includes("그대로 둡니다"));
});

t("P12 Gmail 이 애초에 안 켜져 있고 고르지도 않았으면 아무 말도 하지 않는다(노이즈 0)", () => {
  const r = googleCollectAction({ service: "gmail", wanted: false, enabled: false, scopeOk: false });
  assert.equal(r.action, "none");
  assert.equal(r.message, undefined);
});

t("P13 무회귀: 드라이브는 종전 규칙 그대로(동의 있으면 켜고, 빼면 끄고, 동의 없으면 사유와 함께 거른다)", () => {
  assert.equal(googleCollectAction({ service: "drive", wanted: true, enabled: false, scopeOk: true }).action, "enable");
  assert.equal(googleCollectAction({ service: "drive", wanted: false, enabled: true, scopeOk: true }).action, "disable");
  const ns = googleCollectAction({ service: "drive", wanted: true, enabled: false, scopeOk: false });
  assert.equal(ns.action, "none");
  assert.equal(ns.reason, "no_scope", "동의 없이 켜면 run 은 ok 인데 자료가 0건인 '조용한 성공'이 된다");
});

// ── 도구 전용 서비스(캘린더) — 2026-08-27 "캘린더 안떠" 가 만든 축 ─────────────
//  카드가 수집기 목록으로만 그려져서 캘린더는 **칸이 아예 없었고**, [권한 넓히기]가 보내는 services 에도
//  안 실렸다. 도구(google_calendar_*)는 등록돼 있는데 그걸 켤 방법이 화면 어디에도 없던 상태다.
t("P14 ★ 캘린더는 수집기를 만들지 않는다 — 없는 프리셋으로 upsert 를 시도하게 된다", () => {
  assert.equal(GOOGLE_COLLECTORS.some((c) => (c.service as string) === "calendar"), false);
  const r = splitGoogleServices(["drive", "calendar"]);
  assert.deepEqual(r.collect, ["drive"]);
  assert.deepEqual(r.toolOnly, ["calendar"], "동의 범위로는 반드시 실려야 한다");
});

t("P15 ★ 캘린더만 골라도 수집기는 0이고 동의는 열린다", () => {
  const r = splitGoogleServices(["calendar"]);
  assert.deepEqual(r.collect, []);
  assert.deepEqual(r.toolOnly, ["calendar"]);
});

t("P16 모르는 값·중복은 조용히 걸러진다(화면이 뭘 보내든 서버가 무너지지 않는다)", () => {
  const r = splitGoogleServices(["drive", "drive", "calendar", "calendar", "youtube", ""]);
  assert.deepEqual(r.collect, ["drive"]);
  assert.deepEqual(r.toolOnly, ["calendar"]);
});

t("P17 도구 전용 목록에 수집 서비스가 섞이지 않는다", () => {
  for (const s of GOOGLE_TOOL_ONLY_SERVICES) {
    assert.equal(GOOGLE_COLLECTORS.some((c) => (c.service as string) === s), false, `${s} 가 양쪽에 있다`);
  }
});

console.log(`\ngoogle-connect: ${pass} passed`);
