// 위탁을 «누가 시켰나» 로 읽는 규칙 테스트 (#4551).
//
//  사양: 위탁 워커는 프로젝트를 갖지 않는다. 대신 위탁을 만들 때 시킨 세션 id 를 `requester_session` 에 적고,
//   세션 목록은 그 값으로 워커 행에 표식(task)을 얹는다 — 시킨 세션 id · 그 세션의 이름 · 그 세션의 프로젝트.
//   크론이 낸 위탁은 그 칸에 `cron:<잡>[#<레인>]` 표식을 쓴다(종전 그대로) — 시킨 세션이 없고 잡 id 만 있다.
//
//  엣지 표(입력 → 기대).
//   O1 세션 id(box-…-8자리 hex · 외부 하네스 id)            → 그 id
//   O2 크론 표식(`cron:x` · `cron:x#lane`)                   → 시킨 세션 없음 · 잡 id 는 나온다
//   O3 null · undefined · 빈 문자열 · 공백                   → 없음
//   O4 세션 id 꼴이 아닌 값(임의 문자열 · 주입 시도)          → 없음
//   O5 앞뒤 공백이 붙은 세션 id                              → 그 id(다듬는다)
//   R1 적을 값 — 요청이 실어 온 세션 id 는 그대로, `cron:` 접두 · 꼴이 아닌 값은 null(크론 표식 자리를 흉내 못 낸다)
//   M1 워커가 아닌 행은 안 건드린다(kind · task 가 안 생긴다)
//   M2 시킨 세션이 같은 목록에 있으면 그 행의 프로젝트 · 이름을 쓴다
//   M3 시킨 세션이 목록에 없으면 fallback 에서 찾는다 / 거기도 없으면 프로젝트 · 이름은 null 이고 세션 id 는 남는다
//   M4 시킨 세션의 프로젝트가 0 · null 이면 originProject 는 null(0 을 프로젝트로 읽지 않는다)
//   M5 크론 위탁 → originSession null · cron 은 잡 id
//   M6 ★ 워커 자신의 projectId 는 안 고친다(소속을 지어내지 않는다)
//   M7 출처가 하나도 없으면(빈 Map) 아무 행도 안 건드린다
//   M8 목록 행이 fallback 보다 앞선다(라이브 관측이 기억보다 새롭다)
//   X1 missingOrigins — 목록에 없는 시킨 세션만, 겹치지 않게. 크론 · 목록에 있는 것은 안 나온다
import assert from "node:assert/strict";
import { applyTaskMarks, missingOrigins, originSessionOf, requesterSessionFrom, taskOriginOf, type OriginRowLike, type TaskOrigin } from "./task-origin.js";

const SID = "box-wonjoon-jang-8923ed5b";

// ── O. 출처 읽기 ──
assert.equal(originSessionOf(SID), SID, "O1 박스 세션 id 는 그대로");
assert.equal(originSessionOf("claude-abc123"), "claude-abc123", "O1 외부 하네스 세션 id 도 받는다");
assert.equal(originSessionOf("cron:distill"), null, "O2 크론 표식은 시킨 세션이 아니다");
assert.equal(originSessionOf("cron:distill#slack"), null, "O2 레인 붙은 크론 표식도 아니다");
for (const v of [null, undefined, "", "   "]) assert.equal(originSessionOf(v as string | null | undefined), null, `O3 빈 값(${JSON.stringify(v)})은 없음`);
for (const v of ["hello", "box-x", "box-wonjoon-jang-8923ed5", "box-A-12345678", "'; DROP TABLE org_task;--", "cron"]) {
  assert.equal(originSessionOf(v), null, `O4 세션 id 꼴이 아닌 값(${v})은 없음`);
}
assert.equal(originSessionOf(`  ${SID}  `), SID, "O5 앞뒤 공백은 다듬는다");
assert.deepEqual(taskOriginOf({ id: "41", requester_session: SID }), { taskId: 41, originSession: SID, cronJobId: null }, "O1 행 → 출처(번호는 숫자로)");
assert.deepEqual(taskOriginOf({ id: 42, requester_session: "cron:distill#slack" }), { taskId: 42, originSession: null, cronJobId: "distill" }, "O2 크론 행 → 잡 id 만");
assert.deepEqual(taskOriginOf({ id: 43, requester_session: null }), { taskId: 43, originSession: null, cronJobId: null }, "O3 기록이 없던 때의 위탁 → 둘 다 없음");

// ── R. 적을 값 ──
assert.equal(requesterSessionFrom(SID), SID, "R1 요청이 실어 온 세션 id 를 적는다");
assert.equal(requesterSessionFrom(undefined), null, "R1 세션 밖에서 부른 위탁은 null");
assert.equal(requesterSessionFrom("cron:distill"), null, "R1 ★ 밖에서 온 값이 크론 표식을 흉내 내지 못한다");
assert.equal(requesterSessionFrom("not a session"), null, "R1 꼴이 아닌 값은 적지 않는다");

// ── M. 표식 얹기 ──
const origins = (...xs: Array<[string, TaskOrigin]>): Map<string, TaskOrigin> => new Map(xs);
const row = (id: string, o: Partial<OriginRowLike> = {}): OriginRowLike => ({ id, projectId: null, label: id, ...o });
{
  const rows = [row(SID, { projectId: 4551, label: "지금 볼 것 묶기" }), row("box-wonjoon-jang-aaaaaaaa", { label: "위탁 #41" }), row("box-wonjoon-jang-bbbbbbbb", { label: "사람 세션" })];
  applyTaskMarks(rows, origins(["box-wonjoon-jang-aaaaaaaa", { taskId: 41, originSession: SID, cronJobId: null }]));
  assert.equal(rows[2].kind, undefined, "M1 워커가 아닌 행에 kind 가 안 생긴다");
  assert.equal(rows[2].task, undefined, "M1 워커가 아닌 행에 task 가 안 생긴다");
  assert.equal(rows[0].task, undefined, "M1 시킨 세션 자신도 워커가 아니다");
  assert.equal(rows[1].kind, "task", "M2 워커 행은 kind=task");
  assert.deepEqual(rows[1].task, { id: 41, originSession: SID, originLabel: "지금 볼 것 묶기", originProject: 4551, cron: null }, "M2 같은 목록의 시킨 세션에서 프로젝트 · 이름을 얻는다");
  assert.equal(rows[1].projectId, null, "M6 ★ 워커 자신의 projectId 는 그대로다");
}
{
  const rows = [row("w1"), row("w2")];
  const fb = new Map([[SID, { projectId: 77, label: "끝난 세션" }]]);
  applyTaskMarks(rows, origins(["w1", { taskId: 1, originSession: SID, cronJobId: null }], ["w2", { taskId: 2, originSession: "box-wonjoon-jang-cccccccc", cronJobId: null }]), fb);
  assert.deepEqual(rows[0].task, { id: 1, originSession: SID, originLabel: "끝난 세션", originProject: 77, cron: null }, "M3 목록에 없으면 fallback 에서 찾는다");
  assert.deepEqual(rows[1].task, { id: 2, originSession: "box-wonjoon-jang-cccccccc", originLabel: null, originProject: null, cron: null }, "M3 어디에도 없으면 프로젝트 · 이름은 null, 세션 id 는 남는다");
}
{
  const rows = [row(SID, { projectId: 0, label: "" }), row("w"), row("box-wonjoon-jang-dddddddd", { projectId: null }), row("w2")];
  applyTaskMarks(rows, origins(["w", { taskId: 3, originSession: SID, cronJobId: null }], ["w2", { taskId: 4, originSession: "box-wonjoon-jang-dddddddd", cronJobId: null }]));
  assert.equal(rows[1].task?.originProject, null, "M4 시킨 세션의 프로젝트가 0 이면 null");
  assert.equal(rows[1].task?.originLabel, null, "M4 시킨 세션의 이름이 비었으면 null");
  assert.equal(rows[3].task?.originProject, null, "M4 시킨 세션의 프로젝트가 null 이면 null");
}
{
  const rows = [row("w")];
  applyTaskMarks(rows, origins(["w", { taskId: 5, originSession: null, cronJobId: "weekly" }]));
  assert.deepEqual(rows[0].task, { id: 5, originSession: null, originLabel: null, originProject: null, cron: "weekly" }, "M5 크론 위탁 — 시킨 세션 없음 · 잡 id");
}
{
  const rows = [row("a", { projectId: 9 }), row("b")];
  const before = JSON.stringify(rows);
  const out = applyTaskMarks(rows, new Map());
  assert.equal(JSON.stringify(rows), before, "M7 출처가 없으면 아무 행도 안 건드린다");
  assert.equal(out, rows, "M7 같은 배열을 돌려준다");
}
{
  const rows = [row(SID, { projectId: 10, label: "라이브" }), row("w")];
  applyTaskMarks(rows, origins(["w", { taskId: 6, originSession: SID, cronJobId: null }]), new Map([[SID, { projectId: 99, label: "기억" }]]));
  assert.equal(rows[1].task?.originProject, 10, "M8 목록 행이 fallback 보다 앞선다(프로젝트)");
  assert.equal(rows[1].task?.originLabel, "라이브", "M8 목록 행이 fallback 보다 앞선다(이름)");
}

// ── X. 따로 조회할 것 ──
{
  const rows = [row(SID), row("w1"), row("w2"), row("w3"), row("w4")];
  const miss = missingOrigins(rows, origins(
    ["w1", { taskId: 1, originSession: SID, cronJobId: null }],                              // 목록에 있다
    ["w2", { taskId: 2, originSession: "box-wonjoon-jang-eeeeeeee", cronJobId: null }],      // 없다
    ["w3", { taskId: 3, originSession: "box-wonjoon-jang-eeeeeeee", cronJobId: null }],      // 같은 것 또
    ["w4", { taskId: 4, originSession: null, cronJobId: "weekly" }],                         // 크론
    ["gone", { taskId: 5, originSession: "box-wonjoon-jang-ffffffff", cronJobId: null }],    // 워커 자신이 목록에 없다
  ));
  assert.deepEqual(miss, ["box-wonjoon-jang-eeeeeeee"], "X1 목록에 없는 시킨 세션만, 한 번씩 — 크론 · 목록에 있는 것 · 목록에 없는 워커의 것은 안 나온다");
}

console.log("task-origin: ok");
