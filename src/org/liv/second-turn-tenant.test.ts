// 리브 2턴 — 후보마다 «어느 워크스페이스 안에서 일하나»(#4851). 사양·엣지 표: 지식 outbox-echo-typed-window-4851 §사양 의 G 행.
//  실측(2026-10-17 매니지드, 로그 09-03~10-16): 등록부(gw_workspace)가 비어 있어 세션 등록부 조회가 늘 비었고, 스윕은 늘 primary 로 떨어졌다 —
//   포기·발사 표식이 «구성원 정보를 찾을 수 없습니다» 로 9,049번 실패했고 2턴 지시는 primary 아웃박스에 쌓였다(배달 0).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as turn from "./second-turn.js";

//  네임스페이스로 받는다 — 옛 판(이 이름 없음)에서 파일이 링크 오류로 죽지 않고 그 행만 빨간불이 되게(fail-first).
type Ref = { id: string; slug: string };
const pick = (i: { mapped: Ref | null; welcomeWs: string | null; registry: Ref[]; current: Ref | null; managed: boolean }): Ref => {
  const f = (turn as unknown as { secondTurnTenant?: (x: typeof i & { primary: Ref }) => Ref }).secondTurnTenant;
  assert.equal(typeof f, "function", "secondTurnTenant 가 없다");
  return f!({ ...i, primary: PRIMARY });
};
const PRIMARY: Ref = { id: "00000000-0000-0000-0000-000000000000", slug: "primary" };
const WS_A: Ref = { id: "aaaaaaaa-0000-4000-8000-000000000001", slug: "lively-46e3" };
const WS_B: Ref = { id: "bbbbbbbb-0000-4000-8000-000000000002", slug: "mar-8b18" };

test("G1 세션 등록부가 아는 워크스페이스가 이긴다(자체호스팅 다중 워크스페이스 — 종전과 같음)", () => {
  for (const managed of [false, true]) {
    assert.deepEqual(pick({ mapped: WS_B, welcomeWs: WS_A.id, registry: [WS_A, WS_B], current: WS_A, managed }), WS_B);
  }
});
test("★ G2 등록부가 모르고 welcome 이 지금 워크스페이스의 칸에 산다 — 지금 워크스페이스(이름까지 — 매니지드에선 세션 경로에 들어간다)", () => {
  assert.deepEqual(pick({ mapped: null, welcomeWs: WS_A.id, registry: [], current: WS_A, managed: true }), WS_A);
  //  자체호스팅이라도 요청 안에서 불렸고 welcome 이 그 워크스페이스 칸에 살면 그 워크스페이스다(표식이 그 칸에 찍혀야 후보에서 빠진다).
  assert.deepEqual(pick({ mapped: null, welcomeWs: WS_A.id, registry: [], current: WS_A, managed: false }), WS_A);
});
test("G3 등록부가 모르고 welcome 칸이 지금 워크스페이스가 아니면 등록부에서 그 칸의 이름을 찾는다(자체호스팅 타이머 — 지금 워크스페이스 없음)", () => {
  assert.deepEqual(pick({ mapped: null, welcomeWs: WS_B.id, registry: [WS_A, WS_B], current: null, managed: false }), WS_B);
});
test("★ G4 매니지드 · 등록부가 모름 · 옛 자리 welcome(칸 없음) — 지금 요청(하우스키핑 틱)의 워크스페이스. primary 로 떨어지지 않는다", () => {
  assert.deepEqual(pick({ mapped: null, welcomeWs: null, registry: [], current: WS_A, managed: true }), WS_A);
});
test("G5 자체호스팅 · 등록부가 모름 · 칸 없음 — primary(종전과 같음 · 요청 안에서 불려도)", () => {
  assert.deepEqual(pick({ mapped: null, welcomeWs: null, registry: [], current: null, managed: false }), PRIMARY);
  assert.deepEqual(pick({ mapped: null, welcomeWs: null, registry: [WS_A], current: WS_A, managed: false }), PRIMARY);
});
test("G6 welcome 칸이 등록부에도 없다 — 배포 규칙의 기본값(매니지드 = 지금 · 자체호스팅 = primary)", () => {
  assert.deepEqual(pick({ mapped: null, welcomeWs: WS_B.id, registry: [WS_A], current: WS_A, managed: true }), WS_A);
  assert.deepEqual(pick({ mapped: null, welcomeWs: WS_B.id, registry: [WS_A], current: null, managed: false }), PRIMARY);
});
test("G7 매니지드인데 지금 워크스페이스가 없다(요청 밖) — primary(만들어 내지 않는다)", () => {
  assert.deepEqual(pick({ mapped: null, welcomeWs: null, registry: [], current: null, managed: true }), PRIMARY);
});

//  dist 에서 도는 시험이라 소스는 cwd 기준으로 읽는다(이 레포 관용구).
test("★ G8 스윕 배선 — 워크스페이스는 secondTurnTenant 로 고르고 · 1턴 대기는 기록과 다시 대조한 목록을 그 워크스페이스 안에서 센다", () => {
  const src = readFileSync("src/org/liv/second-turn-sweep.ts", "utf8");
  assert.match(src, /secondTurnTenant\(\{/, "워크스페이스를 고르는 판정을 안 쓴다");
  assert.match(src, /withTenant\(tenant, \(\) => listOutboxReconciled\(sid\)\)/, "재대조 목록을 그 워크스페이스 안에서 안 센다");
  assert.doesNotMatch(src, /\blistOutbox\(/, "재대조 없는 목록을 센다 — 기록에 들어간 «미확인» 1턴이 대기로 세어진다");
  assert.doesNotMatch(src, /: \{ id: PRIMARY_TENANT_ID, slug: PRIMARY_SLUG \};/, "등록부가 모르면 곧장 primary 로 떨어지는 종전 갈래가 남았다");
});
