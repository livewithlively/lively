// 자료 공개범위 정책 소급 — 자료 한 건 판정(순수)의 엣지 표. 읽기·잠금·쓰기(훑는 사이 자료가 바뀌는 판 포함)는
//  src/v6/derived-visibility.pg-test.mjs 의 R 계열이 실제 Postgres 로 잰다.
//
//  사양 요지: 잠금 규칙이 걸린 자료를 규칙 대상으로 맞춘다. 단 ① 이미 맞으면 그대로 ② 잠긴 단위 자료는 단위 몫 ③ 빈 대상으로는
//   쓰지 않는다 ④ 잠긴 자료를 넓히는 것은 그 자료를 지금 보는 사람(직접·팀)이나 전체 긴급열람 중인 사람만.
import test from "node:test";
import assert from "node:assert/strict";
import { editorSees, judgeBackfillRow, writesVisibility, type BackfillEditor, type BackfillRowState } from "./source-vis-backfill.js";

const rule = (...ids: string[]) => ({
  visibility: "members",
  members: ids.map((k) => { const [subject_kind, member_id] = k.split(":"); return { subject_kind, member_id }; }),
});
const row = (visibility: "open" | "members", aud: string[] = [], unitOwned = false): BackfillRowState => ({ visibility, aud, unitOwned });
const who = (id: string, o: { teams?: string[]; privileged?: boolean } = {}): BackfillEditor =>
  ({ id, teams: new Set(o.teams ?? []), privileged: o.privileged ?? false });

test("J1 잠금 규칙이 없으면(open) no_rule — 자료 상태와 무관", () => {
  assert.equal(judgeBackfillRow(row("members", ["member:a"], true), { visibility: "open", members: [] }, who("a")), "no_rule");
  assert.equal(judgeBackfillRow(row("open"), { visibility: "open", members: [] }, who("a")), "no_rule");
});

test("J2 열린 자료 + 규칙 → lock(부른 사람이 대상이 아니어도 — 새로 얻는 것이 없다)", () => {
  assert.equal(judgeBackfillRow(row("open"), rule("member:a", "member:b"), who("z")), "lock");
});

test("J3 잠겨 있고 대상이 규칙과 같으면 already — 순서가 달라도 · 단위 자료여도", () => {
  assert.equal(judgeBackfillRow(row("members", ["member:b", "member:a"]), rule("member:a", "member:b"), who("z")), "already");
  assert.equal(judgeBackfillRow(row("members", ["member:a"], true), rule("member:a"), who("z")), "already");
});

test("J4 잠긴 단위 자료는 대상이 달라도 unit_managed — 넓히는 쪽이든 좁히는 쪽이든 · 긴급열람 중이어도", () => {
  assert.equal(judgeBackfillRow(row("members", ["member:a"], true), rule("member:a", "member:b"), who("a")), "unit_managed");
  assert.equal(judgeBackfillRow(row("members", ["member:a", "member:b"], true), rule("member:a"), who("a")), "unit_managed");
  assert.equal(judgeBackfillRow(row("members", ["member:a"], true), rule("member:a", "member:b"), who("z", { privileged: true })), "unit_managed");
});

test("J5 열린 단위 자료(«모두» 단위)는 규칙 대상으로 잠근다 — lock", () => {
  assert.equal(judgeBackfillRow(row("open", [], true), rule("member:a"), who("z")), "lock");
});

test("J6 규칙 대상이 비면 skipped_empty — 열린 자료도 잠긴 자료도 · 긴급열람 중이어도", () => {
  assert.equal(judgeBackfillRow(row("open"), rule(), who("a")), "skipped_empty");
  assert.equal(judgeBackfillRow(row("members", ["member:a"]), rule(), who("a", { privileged: true })), "skipped_empty");
});

test("J7 대상 0 으로 잠긴 자료 + 빈 규칙은 already(바꿀 것이 없다) — skipped_empty 보다 먼저", () => {
  assert.equal(judgeBackfillRow(row("members", []), rule(), who("a")), "already");
});

test("J8 잠긴 자료를 넓히기 — 지금 대상인 사람은 resync · 아닌 사람은 resync_refused", () => {
  assert.equal(judgeBackfillRow(row("members", ["member:a"]), rule("member:a", "member:b"), who("a")), "resync");
  assert.equal(judgeBackfillRow(row("members", ["member:a"]), rule("member:a", "member:b"), who("b")), "resync_refused");
});

test("J9 팀 경유 — 대상 팀의 팀원은 넓힐 수 있고 팀 밖은 거절", () => {
  assert.equal(judgeBackfillRow(row("members", ["team:7"]), rule("member:b", "member:c"), who("c", { teams: ["7"] })), "resync");
  assert.equal(judgeBackfillRow(row("members", ["team:7"]), rule("member:b", "member:c"), who("c", { teams: ["70"] })), "resync_refused");
});

test("J10 전체 긴급열람 중이면 못 보던 자료도 넓힌다 — 대상 0 으로 닫힌 자료는 긴급열람으로만", () => {
  assert.equal(judgeBackfillRow(row("members", ["member:a"]), rule("member:b"), who("z", { privileged: true })), "resync");
  assert.equal(judgeBackfillRow(row("members", []), rule("member:a"), who("a")), "resync_refused");
  assert.equal(judgeBackfillRow(row("members", []), rule("member:a"), who("a", { privileged: true })), "resync");
});

test("J11 좁히기만 하는 변경(규칙 대상 ⊂ 지금 대상)은 대상이 아닌 사람도 resync", () => {
  assert.equal(judgeBackfillRow(row("members", ["member:a", "member:b"]), rule("member:b"), who("z")), "resync");
});

test("J12 대상을 통째로 바꾸는 변경(겹치지 않음)은 넓힘이다 — 지금 대상이 아니면 거절", () => {
  assert.equal(judgeBackfillRow(row("members", ["member:c"]), rule("member:a", "member:b"), who("a")), "resync_refused");
  assert.equal(judgeBackfillRow(row("members", ["member:c"]), rule("member:a", "member:b"), who("c")), "resync");
});

test("J13 editorSees — 사람 열쇠는 글자 그대로 · 팀 열쇠는 팀 id 전체가 같아야", () => {
  assert.equal(editorSees(who("a"), ["member:a"]), true);
  assert.equal(editorSees(who("a"), ["member:ab", "team:a"]), false);
  assert.equal(editorSees(who("a", { teams: ["12"] }), ["team:1", "team:123"]), false);
  assert.equal(editorSees(who("a", { teams: ["12"] }), ["team:12"]), true);
  assert.equal(editorSees(who("a"), []), false);
});

test("J14 writesVisibility — lock·resync 만 자료를 바꾼다", () => {
  const all = ["no_rule", "already", "unit_managed", "skipped_empty", "resync_refused", "lock", "resync"] as const;
  assert.deepEqual(all.filter(writesVisibility), ["lock", "resync"]);
});
