// #1820 — 죽은 세션 메타(deadSessionMeta)의 계약. 사양 spec S1 의 엣지 표 14행을 그대로 옮긴다.
//  이 표가 곧 "화면이 복원 경로를 탈 수 있나"다. 틀리면 티가 크다:
//   🔴 restorable 이 안 나가면 — 세션을 열어도 '그냥 끝난 세션' 배너로 끝난다(2026-08-14~20 실측 회귀, #109).
//   🔴 canRestore 가 너무 넓으면 — 남의 세션에 복원 버튼이 뜬다(눌러 보고 403 을 받는 UX).
//   🔴 남의 개인 세션에 응답하면 — 그 세션의 존재·이름·프로젝트가 새어 나간다.
//  ⚠ 호출 **순서**(살아있음 확인 → 이 판정)는 순수 테스트로 못 잡는다 — scripts/session-open-restore.test.mjs 가 지킨다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { deadSessionMeta, type DeadSessionMeta, type DeadSessionMetaResult, type DeadSessionStateLike } from "./session-meta.js";

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
