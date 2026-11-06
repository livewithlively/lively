// 처음 설정 뒤 «올린 파일이 지식이 되기까지» 의 단계(org/liv/setup-status.ts) — 값으로 잠근다(#5167).
//
//  사양 — 엣지 표(setupStatus):
//   S1 welcome 없음 · 처음 설정 안 끝남 · 파일 안 올림        → null(말할 것 없음)
//   S2 올리기 시작만 찍힘                                     → uploading · 단 갈래 없음이면 null(«곧 정리» 를 약속하지 않는다)
//   S3 다 올림 · 파일 갈래 · 증류 지시 전                      → waiting
//   S4 다 올림 · 연결 갈래 · 증류 지시 전                      → connecting
//   S5 다 올림 · 갈래 없음(관리 권한 없음 · 서버 AI 없음)      → null(리브가 오지 않는다 — 마지막 화면이 이미 말했다)
//   S6 증류 지시 뒤 · 켜진 정리 없음                           → working
//   S7 증류 지시 뒤 · 남은 자료 있음                           → organizing(backlog 그대로)
//   S8 증류 지시 뒤 · 남은 자료 0(경계)                        → done
//   S9 증류 지시 뒤 · 자격 때문에 멈춤                         → needs-ai(남은 수보다 앞선다)
//   S10 포기 표식                                              → stopped + 사유
//  사양 — 엣지 표(setupHoldsDistill):
//   H1 파일 갈래 · 증류 지시 전 · 하루 안                      → 쉰다
//   H2 연결 갈래 · 파일 올림 · 증류 지시 전                    → 쉰다
//   H7 파일을 안 올렸다(갈래 있음)                             → 안 쉰다(막을 것이 없다)
//   H3 증류 지시 뒤 · 포기 뒤                                  → 안 쉰다
//   H4 갈래 없음 · 합류자(join)                                → 안 쉰다(리브가 오지 않는다)
//   H5 하루 지남(경계: 정확히 상한)                             → 안 쉰다
//   H6 처음 설정 안 끝남 · 날짜가 깨짐                          → 안 쉰다
import test from "node:test";
import assert from "node:assert/strict";
import { setupHoldsDistill, setupStatus } from "./setup-status.js";
import { SECOND_TURN_STALE_MS } from "./second-turn.js";

const DONE = "2026-10-30T07:45:23.996Z";
const W = (o: Record<string, unknown> = {}) => ({ done_at: DONE, upload_started_at: DONE, upload_done_at: DONE, flow: "files", ...o });
const st = (w: Record<string, unknown> | null, backlog: number | null = null, credentialBlocked = false) =>
  setupStatus({ welcome: w as never, backlog, credentialBlocked });

test("S1 welcome 없음 · 처음 설정 안 끝남 · 파일 안 올림 — null", () => {
  assert.equal(st(null), null);
  assert.equal(st(W({ done_at: null })), null);
  assert.equal(st(W({ upload_started_at: null })), null, "파일을 안 올린 사람에게 띠를 띄우지 않는다");
});

test("S2 올리기 시작만 찍힘 — uploading", () => {
  assert.equal(st(W({ upload_done_at: null }))?.phase, "uploading");
  assert.equal(st(W({ upload_done_at: null, flow: "connect" }))?.phase, "uploading");
  assert.equal(st(W({ upload_done_at: null, flow: null })), null, "★ 리브가 오지 않는데 올리는 중이라며 «곧 정리» 를 약속한다");
});

test("S3·S4·S5 증류 지시 전 — 갈래로 가른다", () => {
  assert.equal(st(W())?.phase, "waiting");
  assert.equal(st(W({ flow: "connect" }))?.phase, "connecting");
  assert.equal(st(W({ flow: null })), null, "리브가 오지 않는 갈래는 기다리라고 말하지 않는다");
});

test("S6·S7·S8 증류 지시 뒤 — 남은 자료로 가른다", () => {
  const w = W({ distill_at: "2026-10-30T07:48:45.384Z", session_id: "box-x-1" });
  assert.deepEqual(st(w, null), { phase: "working", session_id: "box-x-1", backlog: null, note: null });
  assert.deepEqual(st(w, 286), { phase: "organizing", session_id: "box-x-1", backlog: 286, note: null });
  assert.equal(st(w, 1)?.phase, "organizing");
  assert.equal(st(w, 0)?.phase, "done", "0 은 «켜진 정리가 없다(null)» 와 다르다");
});

test("S9 자격 때문에 멈춤 — needs-ai 가 남은 수보다 앞선다", () => {
  const w = W({ distill_at: "2026-10-30T07:48:45.384Z" });
  assert.equal(st(w, 286, true)?.phase, "needs-ai");
  assert.equal(st(w, null, true)?.phase, "needs-ai");
  assert.equal(st(W(), 286, true)?.phase, "waiting", "증류 지시 전이면 아직 잡이 안 돈다 — 멈췄다고 말하지 않는다");
});

test("S10 포기 표식 — stopped + 사유", () => {
  assert.deepEqual(st(W({ distill_gave_up_at: DONE, distill_note: "reopen-failed" })),
    { phase: "stopped", session_id: null, backlog: null, note: "reopen-failed" });
});

const now = Date.parse(DONE) + 60_000;
test("H1·H2 증류 지시 전 — 쉰다", () => {
  assert.equal(setupHoldsDistill(W(), now), true);
  assert.equal(setupHoldsDistill(W({ flow: "connect" }), now), true, "연결 갈래도 올린 파일을 리브보다 먼저 집지 않는다");
});

test("H7 파일을 안 올렸다 — 안 쉰다", () => {
  assert.equal(setupHoldsDistill(W({ upload_started_at: null }), now), false);
  assert.equal(setupHoldsDistill(W({ flow: "connect", upload_started_at: null }), now), false, "★ 파일 없는 연결 갈래가 워크스페이스 정리를 하루 세운다");
});

test("H3 증류 지시 뒤 · 포기 뒤 — 안 쉰다", () => {
  assert.equal(setupHoldsDistill(W({ distill_at: DONE }), now), false);
  assert.equal(setupHoldsDistill(W({ distill_gave_up_at: DONE }), now), false);
});

test("H4 갈래 없음 · 합류자 — 안 쉰다", () => {
  assert.equal(setupHoldsDistill(W({ flow: null }), now), false);
  assert.equal(setupHoldsDistill(W({ flow: "join" }), now), false);
});

test("H5 하루 지남 — 경계에서 풀린다", () => {
  const t0 = Date.parse(DONE);
  assert.equal(setupHoldsDistill(W(), t0 + SECOND_TURN_STALE_MS - 1), true);
  assert.equal(setupHoldsDistill(W(), t0 + SECOND_TURN_STALE_MS), false);
});

test("H6 처음 설정 안 끝남 · 날짜가 깨짐 — 안 쉰다", () => {
  assert.equal(setupHoldsDistill(null, now), false);
  assert.equal(setupHoldsDistill(W({ done_at: null }), now), false);
  assert.equal(setupHoldsDistill(W({ done_at: "not-a-date" }), now), false);
});
