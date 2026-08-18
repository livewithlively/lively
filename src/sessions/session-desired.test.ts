import { strict as assert } from "node:assert";
import test from "node:test";
import { resolveDesired, type TmuxDesired } from "./session-desired.js";
import type { SessionState } from "./session-state.js";

const TM: TmuxDesired = {
  owner: "u-tmux",
  label: "tmux 라벨",
  harness: "claude",
  dir: "/work/shared/a",
  autoApprove: false,
  flags: { "--model": "sonnet" },
  invites: ["u-old"],
  projectId: 11,
};

const db = (p: Partial<SessionState> = {}): SessionState => ({
  id: "box-x-1", owner: "u-db", label: "db 라벨", harness: "codex",
  dir: "/work/shared/b", root_key: null, subpath: null,
  flags: { "--model": "opus" }, auto_approve: true, invites: ["u-new"],
  project_id: 22, project_src: "v6", read_only: false, incognito: false,
  write_vis: null, restrict_read: false, created: 1, last_busy: null, last_seen: null,
  claude_session_id: null, exited_at: null, exit_reason: null,
  ...p,
});

test("DB 행이 없으면 tmux 값을 그대로 쓴다 — 업그레이드 직후 백필 전 구간", () => {
  assert.deepEqual(resolveDesired(undefined, TM), { ...TM, source: "tmux" });
});

test("DB 행이 있으면 DB 가 이긴다", () => {
  const d = resolveDesired(db(), TM);
  assert.equal(d.source, "db");
  assert.equal(d.owner, "u-db");
  assert.equal(d.label, "db 라벨");
  assert.equal(d.harness, "codex");
  assert.equal(d.dir, "/work/shared/b");
  assert.equal(d.autoApprove, true);
  assert.deepEqual(d.invites, ["u-new"]);
  assert.equal(d.projectId, 22);
  assert.deepEqual(d.flags, { "--model": "opus" });
});

// 나중에 추가된 컬럼은 구버전 행에서 null 이다. 통째로 덮으면 화면에서 배지·플래그가 조용히 사라진다.
test("★ DB 의 null/빈 값은 tmux 로 메운다 — '옮겼더니 정보가 줄었다'를 막는다", () => {
  const d = resolveDesired(db({ label: null, dir: null, project_id: null, flags: {}, invites: [] }), TM);
  assert.equal(d.label, "tmux 라벨");
  assert.equal(d.dir, "/work/shared/a");
  assert.equal(d.projectId, 11);
  assert.deepEqual(d.flags, { "--model": "sonnet" });
  assert.deepEqual(d.invites, ["u-old"]);
});

// ★ 소유자는 접근 제어의 근거다. tmux 값으로 덮이면 권한이 뒤집힌다.
test("★ owner 는 DB 값이 있으면 절대 tmux 로 덮이지 않는다", () => {
  const d = resolveDesired(db({ owner: "u-db" }), { ...TM, owner: "u-attacker" });
  assert.equal(d.owner, "u-db");
});

test("DB owner 가 파손(빈 문자열)이면 그때만 tmux 로 폴백한다", () => {
  assert.equal(resolveDesired(db({ owner: "" }), TM).owner, "u-tmux");
});

// autoApprove 는 boolean 이라 '값 없음'이 없다 — DB 가 무조건 이긴다(false 를 '미설정'으로 읽으면 안 된다).
test("autoApprove: DB 의 false 는 tmux 의 true 를 이긴다", () => {
  assert.equal(resolveDesired(db({ auto_approve: false }), { ...TM, autoApprove: true }).autoApprove, false);
});

test("harness 는 빈 값일 때만 폴백한다", () => {
  assert.equal(resolveDesired(db({ harness: "" }), TM).harness, "claude");
  assert.equal(resolveDesired(db({ harness: "shell" }), TM).harness, "shell");
});
