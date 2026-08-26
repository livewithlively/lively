// #1820 — 죽은 세션 메타(deadSessionMeta)의 계약. 사양 spec S1 의 엣지 표 14행을 그대로 옮긴다.
//  이 표가 곧 "화면이 복원 경로를 탈 수 있나"다. 틀리면 티가 크다:
//   🔴 restorable 이 안 나가면 — 세션을 열어도 '그냥 끝난 세션' 배너로 끝난다(2026-08-14~20 실측 회귀, #109).
//   🔴 canRestore 가 너무 넓으면 — 남의 세션에 복원 버튼이 뜬다(눌러 보고 403 을 받는 UX).
//   🔴 남의 개인 세션에 응답하면 — 그 세션의 존재·이름·프로젝트가 새어 나간다.
//  ⚠ 호출 **순서**(살아있음 확인 → 이 판정) 중 노드 세션 갈래는 아래 nodeSessionMetaMode 표가 지킨다(2026-08-26).
//   그 밖의 진입 순서는 여전히 scripts/session-open-restore.test.mjs 가 지킨다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { deadSessionMeta, nodeSessionMetaMode, type DeadSessionMeta, type DeadSessionMetaResult, type DeadSessionStateLike } from "./session-meta.js";

const st = (over: Partial<DeadSessionStateLike> = {}): DeadSessionStateLike => ({
  owner: "yoon", label: "라벨", harness: "claude", project_id: null, exited_at: null, exit_reason: null, ...over,
});
const okBody = (r: DeadSessionMetaResult): DeadSessionMeta => {
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") throw new Error("unreachable");
  return r.body;
};
const ID = "box-yoon-1a2b3c4d";

test("①⑦ 내 세션 — 되살릴 수 있다고 말한다(개인·프로젝트 둘 다)", () => {
  const solo = okBody(deadSessionMeta(ID, st(), "yoon", false));
  assert.equal(solo.restorable, true);
  assert.equal(solo.canRestore, true);
  assert.equal(solo.label, "라벨");
  assert.equal(solo.harness, "claude");
  assert.equal(solo.projectId, 0);
  const inProj = okBody(deadSessionMeta(ID, st({ project_id: 1719 }), "yoon", false));
  assert.equal(inProj.canRestore, true);
  assert.equal(inProj.projectId, 1719);
});

test("②⑤ 남의 프로젝트 세션 — 보이되 복원은 소유자 몫(#452 공동 세션)", () => {
  const b = okBody(deadSessionMeta("box-jang-1a2b3c4d", st({ owner: "jang", project_id: 1719 }), "yoon", false));
  assert.equal(b.restorable, true);
  assert.equal(b.canRestore, false, "남의 세션은 복원 불가로 알려야 화면이 '소유자만 열기'로 안내한다");
  assert.equal(b.projectId, 1719);
  // 경계: project_id 는 1 부터 '프로젝트 세션'이다(0 은 없음 — 아래 ③④).
  assert.equal(okBody(deadSessionMeta("box-jang-1a2b3c4d", st({ owner: "jang", project_id: 1 }), "yoon", false)).canRestore, false);
});

test("③④ 남의 개인 세션 — 존재조차 알리지 않는다(403). project_id 0·null 은 '프로젝트 없음'", () => {
  assert.equal(deadSessionMeta("box-jang-1a2b3c4d", st({ owner: "jang", project_id: null }), "yoon", false).kind, "forbidden");
  assert.equal(deadSessionMeta("box-jang-1a2b3c4d", st({ owner: "jang", project_id: 0 }), "yoon", false).kind, "forbidden");
});

test("⑥ admin 은 남의 개인 세션도 되살릴 수 있다(관리 권한)", () => {
  assert.equal(okBody(deadSessionMeta("box-jang-1a2b3c4d", st({ owner: "jang" }), "yoon", true)).canRestore, true);
});

test("⑧⑨ 판정 근거가 없으면 'none' — 호출자는 종전 흐름을 계속한다", () => {
  assert.equal(deadSessionMeta(ID, null, "yoon", false).kind, "none");
  assert.equal(deadSessionMeta(ID, undefined, "yoon", false).kind, "none");
  // 새 엣지 — 행은 있는데 owner 가 비었다(마이그레이션 잔재·부분 기록). 소유자를 모르면 권한 판정이 불가능하다.
  assert.equal(deadSessionMeta(ID, { owner: "" }, "yoon", false).kind, "none", "owner 없는 행은 판정 근거가 아니다");
});

test("⑩⑪⑫ 사용자 종료와 메모리 부족 — 확정이 추정을 이긴다(#1251)", () => {
  const ex = okBody(deadSessionMeta(ID, st({ exited_at: "2026-08-20T00:00:00Z" }), "yoon", false));
  assert.equal(ex.exitedByUser, true);
  assert.equal(ex.oomKilled, false);
  const oom = okBody(deadSessionMeta(ID, st({ exit_reason: "oom" }), "yoon", false));
  assert.equal(oom.exitedByUser, false);
  assert.equal(oom.oomKilled, true);
  const both = okBody(deadSessionMeta(ID, st({ exited_at: "2026-08-20T00:00:00Z", exit_reason: "oom" }), "yoon", false));
  assert.equal(both.exitedByUser, true);
  assert.equal(both.oomKilled, false, "/exit 는 확정 사실, oom 표시는 관측 기반 추정 — 겹치면 확정이 이긴다");
});

test("⑬⑭ 빈 라벨·하네스 미상 — id 와 'shell' 로 채운다(빈 제목이 화면에 나가지 않게)", () => {
  const nul = okBody(deadSessionMeta(ID, st({ label: null, harness: null }), "yoon", false));
  assert.equal(nul.label, ID);
  assert.equal(nul.harness, "shell");
  // 경계: null 이 아니라 빈 문자열인 경우도 같다(회귀 당시 실제로 나가던 값이 "" 였다).
  assert.equal(okBody(deadSessionMeta(ID, st({ label: "" }), "yoon", false)).label, ID);
});

// ── 노드 세션 메타의 갈래(nodeSessionMetaMode) — 사양 spec S2 의 엣지 표 6행 ───────────────────
//  이 표가 곧 "돌고 있는 노드 세션을 죽었다고 답하지 않는다"이다. 틀리면 티가 크다:
//   🔴 살아 있는데 dead — 화면이 이어받기로 흘러 **빈 새 세션**이 생긴다(2026-08-26 실측: 프로젝트 하나에 4개).
//   🔴 죽었는데 alive — 없는 tmux 에 붙어 4410 배너로 끝난다(복원 버튼이 안 뜬다).
//   🔴 이미 물어본 노드를 또 묻기 — 같은 스냅샷을 두 번 훑는다(답은 같다).
const spy = (found: boolean): { fn: (n: string) => boolean; calls: string[] } => {
  const calls: string[] = [];
  return { fn: (n: string) => { calls.push(n); return found; }, calls };
};

test("① 노드 세션이 아니면 dead — 빈 노드 이름으로 스냅샷을 묻지 않는다(방어)", () => {
  const s = spy(true);
  assert.equal(nodeSessionMetaMode("", "", s.fn), "dead");
  assert.deepEqual(s.calls, [], "물어볼 노드가 없다");
  // 경계: 호출자는 좌표를 줬는데 desired-state 가 모르는 경우. 빈 이름으로 물으면 **아무 노드의** 같은 id 를
  //  살아 있다고 오판할 수 있다(스냅샷 조회는 노드 이름으로 좁힌다).
  const s2 = spy(true);
  assert.equal(nodeSessionMetaMode("laptop", "", s2.fn), "dead");
  assert.deepEqual(s2.calls, [], "빈 노드 이름으로는 묻지 않는다");
});

test("② 좌표 없이 물어본 호출도 살아 있으면 alive — 이 갈래가 없어서 빈 새 세션이 생겼다", () => {
  const s = spy(true);
  assert.equal(nodeSessionMetaMode("", "mac", s.fn), "alive");
  assert.deepEqual(s.calls, ["mac"], "desired-state 가 아는 노드로 물어야 한다(호출자가 준 값이 아니라)");
});

test("③ 좌표 없이 물어봤는데 스냅샷에 없으면 dead — 진짜 죽은 세션은 종전대로 복원 안내", () => {
  const s = spy(false);
  assert.equal(nodeSessionMetaMode("", "mac", s.fn), "dead");
  assert.deepEqual(s.calls, ["mac"]);
});

test("④ 이미 그 노드를 물어보고 못 찾은 호출은 다시 묻지 않는다(중복 조회 금지)", () => {
  const s = spy(true);
  assert.equal(nodeSessionMetaMode("mac", "mac", s.fn), "dead");
  assert.deepEqual(s.calls, [], "같은 스냅샷을 두 번 훑지 않는다 — 답이 같다");
});

test("⑤⑥ 엉뚱한 좌표로 물어봤어도 desired-state 의 노드로 다시 확인한다", () => {
  const alive = spy(true);
  assert.equal(nodeSessionMetaMode("laptop", "mac", alive.fn), "alive");
  assert.deepEqual(alive.calls, ["mac"]);
  const gone = spy(false);
  assert.equal(nodeSessionMetaMode("laptop", "mac", gone.fn), "dead");
  assert.deepEqual(gone.calls, ["mac"]);
});
