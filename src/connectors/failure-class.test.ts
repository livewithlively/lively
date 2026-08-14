// 순수 단위 체크(node:assert) — 수집 실패를 삼킬지 던질지의 경계(#1631).
//
// 이 파일이 지키는 것은 둘이다:
//  ① **자격이 무효면 조용히 넘어가지 않는다**(그게 "0건입니다"로 위장되던 버그다)
//  ② **그렇다고 아무 실패나 던지지 않는다**(403 능력 경계·일부 페이지 실패는 계속 가야 한다)
//
// 사양 엣지표(행마다 시나리오 1개 이상):
//  | #  | 입력                                        | 기대                                          |
//  |----|---------------------------------------------|-----------------------------------------------|
//  | 1  | status 401                                   | 무효 자격 — 던진다                             |
//  | 2  | status "401"(문자열)                          | 던진다(=== 로 비교하면 놓친다)                  |
//  | 3  | status 403                                   | **아니다** — 댓글 read 없음 등 능력 경계        |
//  | 4  | status 404 · 429 · 500                       | 아니다                                         |
//  | 5  | status 없음 + 메시지가 401 unauthorized        | 던진다(폴백)                                   |
//  | 6  | status 없음 + 메시지에 401 이지만 인증 낱말 없음 | **아니다** — 페이지 id 안의 401 오탐 방지        |
//  | 7  | 메시지에 1401·4010 처럼 숫자가 붙어 있음        | 아니다(경계 — 부분일치 금지)                    |
//  | 8  | null · undefined · 문자열 에러                 | 안 터진다                                      |
//  | 9  | 노션 실제 오류 원문                            | 던진다(실측 문자열 그대로)                      |
//  | 10 | 범위 1개 지정 · 1개 실패                       | 전부 실패 — 던진다                             |
//  | 11 | 범위 3개 지정 · 3개 실패                       | 던진다                                         |
//  | 12 | 범위 3개 지정 · 2개 실패                       | 아니다(하나는 들어온다)                         |
//  | 13 | 범위 3개 지정 · 0개 실패                       | 아니다                                         |
//  | 14 | 범위 **미지정**(0개) · 0개 실패                 | 아니다 — 루트 개념이 없는 전체 검색 경로         |
//  | 15 | 범위 미지정(0개) · 실패 1개                     | 아니다 — 루트 기반이 아니므로 이 규칙 대상 아님   |
import assert from "node:assert/strict";
import { isInvalidCredential, allScopedRootsFailed } from "./failure-class.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const withStatus = (status: unknown, message = "boom"): Error => Object.assign(new Error(message), { status });

t("[1] status 401 은 무효 자격이다", () => {
  assert.equal(isInvalidCredential(withStatus(401)), true);
});

t("[2] status 가 문자열 '401' 이어도 잡는다", () => {
  assert.equal(isInvalidCredential(withStatus("401")), true);
});

t("[3] 403 은 무효 자격이 **아니다** — 댓글 read 없음 같은 능력 경계라 나머지는 정상 동작한다", () => {
  assert.equal(isInvalidCredential(withStatus(403)), false);
});

t("[4] 404 · 429 · 500 은 아니다", () => {
  for (const s of [404, 429, 500, 502]) assert.equal(isInvalidCredential(withStatus(s)), false, `status ${s}`);
});

t("[5] status 가 없어도 메시지로 잡는다", () => {
  assert.equal(isInvalidCredential(new Error("HTTP 401 unauthorized")), true);
});

t("[6] 메시지에 401 이 있어도 인증 낱말이 없으면 아니다 — id 오탐이 수집을 통째로 멈추면 안 된다", () => {
  assert.equal(isInvalidCredential(new Error("Notion 404 /pages/401abc: not found")), false);
  assert.equal(isInvalidCredential(new Error("timeout after 401 ms")), false);
});

t("[7] 401 이 더 큰 숫자의 일부면 아니다(경계)", () => {
  assert.equal(isInvalidCredential(new Error("Notion 1401 unauthorized?")), false);
  assert.equal(isInvalidCredential(new Error("Notion 4010 unauthorized?")), false);
});

t("[8] null · undefined · 문자열이 와도 터지지 않는다", () => {
  assert.equal(isInvalidCredential(null), false);
  assert.equal(isInvalidCredential(undefined), false);
  assert.equal(isInvalidCredential("그냥 문자열"), false);
  assert.equal(isInvalidCredential("401 unauthorized"), true); // 문자열이어도 규칙은 같다
});

t("[9] 실측 노션 오류 원문을 잡는다", () => {
  const real = 'Notion 401 /databases/1a2b3c4d: {"object":"error","status":401,"code":"unauthorized","message":"API token is invalid."}';
  assert.equal(isInvalidCredential(new Error(real)), true, "이 문자열이 안 잡히면 그 버그가 그대로 재현된다");
  assert.equal(isInvalidCredential(withStatus(401, real)), true);
});

t("[10] 범위 1개를 지정했는데 그 1개가 실패 → 가져올 게 없다", () => {
  assert.equal(allScopedRootsFailed(1, 1), true);
});

t("[11] 지정한 것이 전부 실패해도 마찬가지", () => {
  assert.equal(allScopedRootsFailed(3, 3), true);
  assert.equal(allScopedRootsFailed(3, 4), true); // 방어적 — 실패 집계가 더 커도 전부 실패다
});

t("[12] 일부만 실패면 계속 간다 — 하나라도 들어오면 성공이다", () => {
  assert.equal(allScopedRootsFailed(3, 2), false);
});

t("[13] 실패가 없으면 당연히 아니다", () => {
  assert.equal(allScopedRootsFailed(3, 0), false);
});

t("[14] 범위를 지정하지 않았으면 이 규칙 대상이 아니다(전체 검색 경로)", () => {
  assert.equal(allScopedRootsFailed(0, 0), false);
});

t("[15] 범위 미지정인데 실패가 세어져도 이 규칙으로 던지지 않는다", () => {
  assert.equal(allScopedRootsFailed(0, 1), false);
});

console.log(`\n${pass} passed`);
