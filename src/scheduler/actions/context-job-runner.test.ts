// 맥락관리 잡 실행 신원 해소 사슬(#4012 T1 · #3994 D1) — 사양 엣지 표 C 의 모든 행.
//
//  사슬: ① 레인·잡이 명시한 requester → ② 워크스페이스 실행 멤버 → ③ 잡 created_by(호환 폴백).
//  이 순서가 뒤집히면 워크스페이스가 정한 자격이 안 먹거나(②가 ①을 이기면 레인별 지정이 죽고),
//  설정이 있는데도 «마지막 저장자» 로 돌아간다(②를 건너뛰면 이 결정 자체가 무효다).
import { strict as assert } from "node:assert";
import { resolveJobRunner } from "./_headless.js";

const ws = (v: string | null) => async (): Promise<string | null> => v;
const wsThrows = async (): Promise<string | null> => { throw new Error("DB 없음"); };

const run = async (): Promise<void> => {
  // C1 명시가 가장 구체적이므로 이긴다 — 레인별 지정이 죽으면 안 된다.
  assert.equal(await resolveJobRunner("lane-user", "maker", ws("ws-user")), "lane-user", "C1 명시 우선");

  // ★ C2 이 결정의 본체 — 명시가 없으면 워크스페이스 실행 멤버로 돈다(created_by 로 새지 않는다).
  assert.equal(await resolveJobRunner(undefined, "maker", ws("ws-user")), "ws-user", "C2 워크스페이스 설정");

  // C3 설정이 아직 없는 워크스페이스는 종전대로 — 이 변경으로 돌던 잡이 멈추면 안 된다.
  assert.equal(await resolveJobRunner(undefined, "maker", ws(null)), "maker", "C3 호환 폴백");

  // C4 셋 다 없음 → 빈 문자열. 호출부가 «의뢰자 미설정» 으로 처리한다(여기서 던지지 않는다).
  assert.equal(await resolveJobRunner(undefined, null, ws(null)), "", "C4 전부 없음");

  // C5 공백뿐인 명시는 명시가 아니다 — 다음 칸으로 내려간다.
  assert.equal(await resolveJobRunner("   ", "maker", ws("ws-user")), "ws-user", "C5 공백 명시는 무시");

  // ★ C6 설정 조회가 깨져도 **던지지 않는다** — 설정 하나 못 읽은 대가로 잡 전체가 멈추면 안 된다.
  assert.equal(await resolveJobRunner(undefined, "maker", wsThrows), "maker", "C6 조회 실패 → 폴백");
  assert.equal(await resolveJobRunner(undefined, null, wsThrows), "", "C6 조회 실패 + createdBy 없음");

  // C7 문자열이 아닌 명시(잡값)는 무시하고 다음 칸으로.
  for (const bad of [42, {}, true, null] as unknown[]) {
    assert.equal(await resolveJobRunner(bad, "maker", ws("ws-user")), "ws-user", "C7 잡값 명시는 무시");
  }

  // C8 설정값도 다듬는다(관리탭 붙여넣기 공백).
  assert.equal(await resolveJobRunner(undefined, "maker", ws("  ws-user  ")), "ws-user", "C8 설정값 다듬기");

  // 배선 단언 — 명시가 있으면 워크스페이스 조회를 **아예 안 한다**(핫패스에서 DB 를 치지 않는다).
  let called = 0;
  const counting = async (): Promise<string | null> => { called++; return "ws-user"; };
  await resolveJobRunner("lane-user", "maker", counting);
  assert.equal(called, 0, "명시가 있으면 워크스페이스 설정을 조회하지 않는다");
  await resolveJobRunner(undefined, "maker", counting);
  assert.equal(called, 1, "명시가 없을 때만 조회한다(관측 장치가 살아 있다)");

  console.log("✓ context-job-runner — 해소 사슬 (C1~C8 + 배선)");
};

await run();
