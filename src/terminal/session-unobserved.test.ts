// #2544 — «못 봤다» 와 «없다» 를 가르고, 폴백 행이 관측처럼 읽히지 않게 하는 순수 판정.
import { strict as assert } from "node:assert";
import test from "node:test";
import { shouldFallbackToDesired, unobservedSessionInfo } from "./session-unobserved.js";
import type { SessionState } from "../sessions/session-state.js";

const relayErr = (stderr: string) => Object.assign(new Error("exit 1"), { code: 1, stderr });

test("★ shouldFallbackToDesired — 매니지드 중계 + 비확답 실패만 참", () => {
  // 못 봤다(브로커·허브 장애) → 폴백
  assert.equal(shouldFallbackToDesired(relayErr("lvly tmux-relay: 브로커 응답 없음: http://hub"), true), true);
  assert.equal(shouldFallbackToDesired(relayErr("node channel unavailable"), true), true);
  assert.equal(shouldFallbackToDesired(Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" }), true), true, "타임아웃도 못 본 것이다");
  // 없다(서버 부재 확답) → 종전 그대로 빈 목록(복원 가능으로 뜬다)
  assert.equal(shouldFallbackToDesired(relayErr("no server running on /tmp/tmux-200001/lvly-acme"), true), false);
  assert.equal(shouldFallbackToDesired(relayErr("error connecting to /tmp/tmux-200001/lvly-acme (No such file or directory)"), true), false);
});

test("★ shouldFallbackToDesired — 셀프호스팅(중계 없음)은 어떤 실패든 폴백하지 않는다(무회귀)", () => {
  assert.equal(shouldFallbackToDesired(relayErr("anything"), false), false);
  assert.equal(shouldFallbackToDesired(Object.assign(new Error("timeout"), { killed: true }), false), false);
});

const state = (o: Partial<SessionState> = {}): SessionState => ({
  id: "box-yoon-1a2b3c4d", owner: "yoon", label: null, harness: "claude", dir: "/srv/shared/p", root_key: "shared", subpath: "p",
  flags: { "--model": "opus" }, auto_approve: true, invites: ["jang"], project_id: 42, project_src: "v6", app_id: null,
  read_only: false, incognito: false, created: 1700000000, last_busy: 1700000100, last_seen: null,
  claude_session_id: null, transcript_path: null, exited_at: null, exit_reason: null, node_id: null, ...o,
});

test("unobservedSessionInfo — desired 는 그대로, 관측은 기본값, observed:false, restorable 없음", () => {
  const r = unobservedSessionInfo(state(), "yoon");
  assert.equal(r.id, "box-yoon-1a2b3c4d");
  assert.equal(r.label, "box-yoon-1a2b3c4d", "라벨 없으면 id");
  assert.deepEqual([r.harness, r.dir, r.autoApprove, r.owner, r.owned], ["claude", "/srv/shared/p", true, "yoon", true]);
  assert.deepEqual([r.invites, r.flags, r.projectId, r.created, r.lastActive], [["jang"], { "--model": "opus" }, 42, 1700000000, 1700000100]);
  assert.deepEqual([r.attached, r.agentState, r.working, r.awaiting, r.title], [false, "offline", false, false, ""]);
  assert.equal(r.observed, false);
  assert.equal((r as { restorable?: unknown }).restorable, undefined, "복원 가능을 약속하지 않는다");
});

test("unobservedSessionInfo — 뷰어가 없으면(me=null, raw 수집) owned 는 false 고정 · 남이면 false", () => {
  assert.equal(unobservedSessionInfo(state(), null).owned, false);
  assert.equal(unobservedSessionInfo(state(), "jang").owned, false);
  assert.equal(unobservedSessionInfo(state({ label: "이름" }), "yoon").label, "이름");
});
