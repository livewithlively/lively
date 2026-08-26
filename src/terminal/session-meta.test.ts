// #1820 — 죽은 세션 메타(deadSessionMeta)의 계약. 사양 spec S1 의 엣지 표 14행을 그대로 옮긴다.
//  이 표가 곧 "화면이 복원 경로를 탈 수 있나"다. 틀리면 티가 크다:
//   🔴 restorable 이 안 나가면 — 세션을 열어도 '그냥 끝난 세션' 배너로 끝난다(2026-08-14~20 실측 회귀, #109).
//   🔴 canRestore 가 너무 넓으면 — 남의 세션에 복원 버튼이 뜬다(눌러 보고 403 을 받는 UX).
//   🔴 남의 개인 세션에 응답하면 — 그 세션의 존재·이름·프로젝트가 새어 나간다.
//  ⚠ 호출 **순서**(살아있음 확인 → 이 판정) 중 노드 세션 갈래는 아래 nodeSessionMetaMode 표가 지킨다(2026-08-26).
//   그 밖의 진입 순서는 여전히 scripts/session-open-restore.test.mjs 가 지킨다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { deadSessionMeta, nodeSessionMetaMode, nodeMetaRestorable, type DeadSessionMeta, type DeadSessionMetaResult, type DeadSessionStateLike } from "./session-meta.js";

const st = (over: Partial<DeadSessionStateLike> = {}): DeadSessionStateLike => ({
  owner: "yoon", label: "라벨", harness: "claude", project_id: null, exited_at: null, exit_reason: null, ...over,
});
const okBody = (r: DeadSessionMetaResult): DeadSessionMeta => {
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") throw new Error("unreachable");
  return r.body;
};
const ID = "box-yoon-1a2b3c4d";
// #2116 — 실제 게이트가 쓰는 술어(isProjectSessionDir)와 **같은 뜻**의 흉내: 공유루트의 project/ 아래인가.
//  여기서 규약을 흉내 내는 이유는 이 모듈이 fs 를 몰라야 하기 때문이다(판정은 호출자가 주입한다).
const SHARED = "/srv/workspace/project/1719";                 // 프로젝트 폴더 세션
const PERSONAL = "/srv/box/jang/sessions/box-jang-8ee2bf2d";  // 개인 세션 홈(#2116 의 그 세션)
const shared = (dir: string): boolean => dir.startsWith("/srv/workspace/project/");

test("①⑦ 내 세션 — 되살릴 수 있다고 말한다(개인·프로젝트 둘 다)", () => {
  const solo = okBody(deadSessionMeta(ID, st(), "yoon", false, shared));
  assert.equal(solo.restorable, true);
  assert.equal(solo.canRestore, true);
  assert.equal(solo.label, "라벨");
  assert.equal(solo.harness, "claude");
  assert.equal(solo.projectId, 0);
  const inProj = okBody(deadSessionMeta(ID, st({ project_id: 1719, dir: SHARED }), "yoon", false, shared));
  assert.equal(inProj.canRestore, true);
  assert.equal(inProj.projectId, 1719);
});

test("②⑤ 남의 프로젝트 세션 — 보이되 복원은 소유자 몫(#452 공동 세션)", () => {
  const b = okBody(deadSessionMeta("box-jang-1a2b3c4d", st({ owner: "jang", project_id: 1719, dir: SHARED }), "yoon", false, shared));
  assert.equal(b.restorable, true);
  assert.equal(b.canRestore, false, "남의 세션은 복원 불가로 알려야 화면이 '소유자만 열기'로 안내한다");
  assert.equal(b.projectId, 1719);
  // ⚠ 경계는 이제 project_id 가 아니라 **dir** 이다(#2116) — project_id 는 응답에 실릴 뿐 판정에 안 쓴다.
  assert.equal(okBody(deadSessionMeta("box-jang-1a2b3c4d", st({ owner: "jang", project_id: 1, dir: SHARED }), "yoon", false, shared)).canRestore, false);
});

test("③④ 남의 개인 세션 — 존재조차 알리지 않는다(403)", () => {
  assert.equal(deadSessionMeta("box-jang-1a2b3c4d", st({ owner: "jang", dir: null }), "yoon", false, shared).kind, "forbidden");
  assert.equal(deadSessionMeta("box-jang-1a2b3c4d", st({ owner: "jang", dir: PERSONAL }), "yoon", false, shared).kind, "forbidden");
});

// ★ #2116 — 이 한 행이 이번 수정의 전부다. 개인 세션 홈에서 도는데 project_id 만 붙은 세션(dev 실측 268건 중 104건).
//  종전엔 project_id>0 만 보고 "되살릴 수 있음"을 답했고, 정작 들어가려 하면 403 이었다 — 화면이 거짓말을 했다.
test("★ 개인 세션 홈 + project_id 만 붙은 남의 세션 — 재는 자는 dir 이다", () => {
  const st2 = st({ owner: "jang", project_id: 1968, dir: PERSONAL });
  assert.equal(deadSessionMeta("box-jang-05ab7578", st2, "yoon", false, shared).kind, "forbidden",
    "🔴 project_id 로 판정하면 남의 개인 세션에 '되살릴 수 있음'이 뜬다(다른 게이트는 전부 403 인데)");
  // 소유자·admin 에게는 종전 그대로 보인다 — 이 수정은 '남'의 축만 바꾼다.
  assert.equal(okBody(deadSessionMeta("box-jang-05ab7578", st2, "jang", false, shared)).canRestore, true);
  assert.equal(okBody(deadSessionMeta("box-jang-05ab7578", st2, "yoon", true, shared)).canRestore, true);
});

test("⑥ admin 은 남의 개인 세션도 되살릴 수 있다(관리 권한)", () => {
  assert.equal(okBody(deadSessionMeta("box-jang-1a2b3c4d", st({ owner: "jang" }), "yoon", true, shared)).canRestore, true);
});

test("⑧⑨ 판정 근거가 없으면 'none' — 호출자는 종전 흐름을 계속한다", () => {
  assert.equal(deadSessionMeta(ID, null, "yoon", false, shared).kind, "none");
  assert.equal(deadSessionMeta(ID, undefined, "yoon", false, shared).kind, "none");
  // 새 엣지 — 행은 있는데 owner 가 비었다(마이그레이션 잔재·부분 기록). 소유자를 모르면 권한 판정이 불가능하다.
  assert.equal(deadSessionMeta(ID, { owner: "" }, "yoon", false, shared).kind, "none", "owner 없는 행은 판정 근거가 아니다");
});

test("⑩⑪⑫ 사용자 종료와 메모리 부족 — 확정이 추정을 이긴다(#1251)", () => {
  const ex = okBody(deadSessionMeta(ID, st({ exited_at: "2026-08-20T00:00:00Z" }), "yoon", false, shared));
  assert.equal(ex.exitedByUser, true);
  assert.equal(ex.oomKilled, false);
  const oom = okBody(deadSessionMeta(ID, st({ exit_reason: "oom" }), "yoon", false, shared));
  assert.equal(oom.exitedByUser, false);
  assert.equal(oom.oomKilled, true);
  const both = okBody(deadSessionMeta(ID, st({ exited_at: "2026-08-20T00:00:00Z", exit_reason: "oom" }), "yoon", false, shared));
  assert.equal(both.exitedByUser, true);
  assert.equal(both.oomKilled, false, "/exit 는 확정 사실, oom 표시는 관측 기반 추정 — 겹치면 확정이 이긴다");
});

test("⑬⑭ 빈 라벨·하네스 미상 — id 와 'shell' 로 채운다(빈 제목이 화면에 나가지 않게)", () => {
  const nul = okBody(deadSessionMeta(ID, st({ label: null, harness: null }), "yoon", false, shared));
  assert.equal(nul.label, ID);
  assert.equal(nul.harness, "shell");
  // 경계: null 이 아니라 빈 문자열인 경우도 같다(회귀 당시 실제로 나가던 값이 "" 였다).
  assert.equal(okBody(deadSessionMeta(ID, st({ label: "" }), "yoon", false, shared)).label, ID);
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

// 🔴 #2108 로 바뀐 칸 — 종전엔 dead 였다. 스냅샷 부재는 죽음의 근거가 아니다(상태 push 3초 주기라
//  방금 만든 살아있는 세션이 그 창 동안 빠진다). 호출자가 노드에 확답을 구하도록 ask 로 보낸다.
test("③ 좌표 없이 물어봤는데 스냅샷에 없으면 ask — 부재는 죽음의 근거가 아니다(#2108)", () => {
  const s = spy(false);
  assert.equal(nodeSessionMetaMode("", "mac", s.fn), "ask");
  assert.deepEqual(s.calls, ["mac"]);
});

// 🔴 #2108 로 바뀐 칸 — 종전엔 dead("이미 물어보고 못 찾았다")였다. 같은 스냅샷을 두 번 훑지 않는 계약은
//  그대로 두되, 결론만 ask 로 바꾼다: 스냅샷을 두 번 봐도 답이 같을 뿐 그게 죽음을 뜻하지는 않는다.
test("④ 이미 그 노드를 물어보고 못 찾았어도 ask — 스냅샷은 두 번 안 훑는다(#2108)", () => {
  const s = spy(true);
  assert.equal(nodeSessionMetaMode("mac", "mac", s.fn), "ask");
  assert.deepEqual(s.calls, [], "같은 스냅샷을 두 번 훑지 않는다 — 답이 같다");
});

test("⑤⑥ 엉뚱한 좌표로 물어봤어도 desired-state 의 노드로 다시 확인한다", () => {
  const alive = spy(true);
  assert.equal(nodeSessionMetaMode("laptop", "mac", alive.fn), "alive");
  assert.deepEqual(alive.calls, ["mac"]);
  const gone = spy(false);
  assert.equal(nodeSessionMetaMode("laptop", "mac", gone.fn), "ask", "#2108 — 부재는 죽음이 아니라 '물어보라'다");
  assert.deepEqual(gone.calls, ["mac"]);
});

// ── #2108 그 갈래에서 복원 신호를 실을까(nodeMetaRestorable) — 사양 표 A 5행 ─────────────────
// 🔴 실측 사고(2026-08-26): 노드 상태 push 는 3초 주기라 **방금 만든 살아있는 세션**이 그 창 동안 스냅샷에서
//  빠진다. 종전엔 그 부재만으로 restorable 을 냈고, 부팅 게이트(web maybeRestoreOnOpen, #1820)가 WS 도 안 붙이고
//  복원으로 갔다 — 갓 만든 세션엔 이어받을 대화 id 가 없어 인자 없는 `--resume` = **후보 0건 피커**가 떴다
//  ("새 세션이 안 열리고 곧장 이어받기가 뜬다"). hammurabi 5회 중 3회 재현 · macmini 오답 구간 45~143ms.
test("표A-1 ask + 노드가 '살아 있다'고 확답 → 복원 신호를 내지 않는다", () => {
  assert.equal(nodeMetaRestorable({ mode: "ask", nodeGone: false }), false);
});
test("표A-2 ask + 노드가 '없다'고 확답 → 종전대로 복원 신호를 낸다", () => {
  assert.equal(nodeMetaRestorable({ mode: "ask", nodeGone: true }), true);
});
// 판정불가를 '살아있음'으로 접으면 진짜 죽은 세션이 영영 복원 불가가 된다 — 이 수정이 고치려는 것보다 나쁘다.
//  종전 동작(#1791: 꺼진 노드의 세션도 복원 가능으로 알린다)을 그대로 보존한다.
test("표A-3 ask + 확답 없음(null) → 종전대로 복원 가능", () => {
  assert.equal(nodeMetaRestorable({ mode: "ask", nodeGone: null }), true);
});
// 표A-4·5 — ask 가 아닌 갈래는 이 게이트의 대상이 아니다. dead 는 노드 세션이 아니라 판정 밖이고,
//  alive 는 라우트가 위에서 이미 라이브 메타로 답해 여기 도달하지 않는다(도달해도 종전 동작을 바꾸지 않는다).
test("표A-4 dead 는 확답과 무관하게 복원 가능 — 이 게이트의 대상이 아니다", () => {
  assert.equal(nodeMetaRestorable({ mode: "dead", nodeGone: false }), true);
});
test("표A-5 alive 도 이 게이트가 건드리지 않는다", () => {
  assert.equal(nodeMetaRestorable({ mode: "alive", nodeGone: false }), true);
});
