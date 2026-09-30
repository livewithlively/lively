// 크론 감시·알림 규칙 테스트.
//
//  주기적으로 잡들의 last_status 를 보고 **상태가 바뀔 때만** 알림 1건을 만든다.
//  박스 경보(box-watch)와 같은 늑대소년 방지 원칙(같은상태 침묵·부팅정상 침묵·전이시만 알림·복구도 알림)이
//  크론 잡에도 적용되지만, 상태 판정 3분류(정상/실패/관측없음)와 last_summary 에서 사유를 뽑는 규칙이 다르다.
import assert from "node:assert/strict";
import type { BoxAlert } from "./box-watch.js";
import { readFileSync } from "node:fs";
import {
  cronPhaseOf, cronFailureReason, cronAlertFor, delegatedWork, delegatedPhaseOf, DELEGATION_LISTS, tickOnce, stopCronWatch,
  type BatchTaskState, type CronJobHealth,
} from "./cron-watch.js";

// ── cronPhaseOf: 정상 ──
{
  assert.equal(cronPhaseOf("ok"), "ok", "ok 는 정상");
}

// ── cronPhaseOf: 관측 없음 — 실행하지 않은 회차(skipped) ──
{
  assert.equal(cronPhaseOf("skipped"), null, "그 회차는 실행되지 않았다 → 관측 없음(전이를 만들지 않는다)");
}

// ── 위탁을 내는 잡은 last_status 가 아니라 그 회차 위탁의 **실제 상태**로 판정한다 ──
//  아래 요약들은 실제 액션이 돌려주는 모양이다(주석의 출처). 손으로 만든 모양으로 단언하면 운영에 없는 입력으로
//  초록이 된다 — 관리 잡은 종전에 id 를 싣지 않아 이 판정에 한 번도 닿지 못했다.
const st = (o: Record<string, string>): Map<string, BatchTaskState> => new Map(Object.entries(o).map(([k, v]) => [k, { status: v }]));
{
  //  _headless.enqueueHeadlessTask — 배정 성공 / 중첩 skip / 배정 실패(자격 없음 — 태스크는 배정 중에 곧바로 failed 로 끝난다)
  const accepted = { task_id: 12, assigned_node: "central", requester: "m1", harness: "claude", model: null, effort: null };
  const skip = { skipped: "이전 실행 아직 진행 중", task_id: 11, task_status: "running" };
  const noCred = { task_id: 9, queued: false, assign_code: "no_credential", reason: "자격 없음", requester: "m1", harness: "claude" };
  assert.equal(cronPhaseOf("ok", accepted), null, "위탁 상태를 못 받았으면 관측 없음(접수 시점의 ok 를 정상으로 읽지 않는다)");
  assert.equal(cronPhaseOf("ok", accepted, st({ 12: "running" })), null, "아직 도는 중이면 관측 없음");
  assert.equal(cronPhaseOf("ok", skip, st({ 11: "queued" })), null, "중첩 skip — 이전 위탁이 대기 중이면 관측 없음");
  assert.equal(cronPhaseOf("ok", accepted, st({ 12: "done" })), "ok", "위탁이 성공으로 끝났으면 정상");
  assert.equal(cronPhaseOf("ok", { ...accepted, task_status: "done" }, st({ 12: "failed" })), "failing",
    "되먹임 표식(task_status)이 아니라 위탁의 실제 상태를 믿는다");
  //  되먹임이 엔진 UPDATE 에 덮인 경우(위탁이 엔진 기록보다 먼저 끝났다) — 요약엔 종결 표식이 영영 안 온다.
  assert.equal(cronPhaseOf("error", noCred, st({ 9: "failed" })), "failing", "자격 없음 즉시 실패도 위탁 상태로 잡힌다");
  assert.equal(cronPhaseOf("ok", accepted, st({ 12: "canceled" })), null, "사람이 취소한 회차는 복구도 실패도 아니다");
  assert.equal(cronPhaseOf("ok", accepted, st({})), null, "조회에 없으면 관측 없음");
}

// ── 레인 잡(증류 batches · 분류 classifiers · 관리 managers)은 그 회차 레인 **전부**로 판정한다 ──
//  되먹임은 레인이 끝날 때마다 잡 상태를 그 결과로 덮는다. 레인 하나만 계속 실패하는 잡을 last_status 로 읽으면
//  회차 안에서 error↔ok 가 오가 회차마다 실패·복구 알림이 한 쌍씩 나간다.
{
  //  distill.runDistillHeadless — { distiller, status, ...enqueue 요약 } · 실행 멤버 없음은 id 없이 error
  const distill = { batches: [
    { distiller: "A", status: "ok", task_id: 1, assigned_node: "central" },
    { distiller: "B", status: "ok", skipped: "이전 실행 아직 진행 중", task_id: 2, task_status: "running" },
  ] };
  //  classify.runClassifyKnowledgeHeadless(레인) — { classifier, ...enqueue 요약 }
  const classify = { classifiers: [{ classifier: "c1", task_id: 5, assigned_node: "central" }, { classifier: "c2", skipped: "인박스 비었음" }] };
  //  manage.runManagers → run-manager.runManager — 모순 탐지 task_id · 코드 비교(레포별) task_ids
  const manage = { managers: [
    { manager: "m1", kind: "contradiction", candidates: 3, enqueued: true, task_id: 7 },
    { manager: "m2", kind: "code_drift", candidates: 4, enqueued: true, task_ids: [8, 9] },
    { manager: "m3", kind: "mismatch", found: 0, created: 0, repeated: 0, applied: 0 },
  ] };
  assert.deepEqual(delegatedWork(distill), { ids: ["1", "2"], entryErrors: [] }, "skip 레인도 이전 위탁 id 로 센다(그게 끝나야 회차가 끝난다)");
  assert.deepEqual(delegatedWork(classify)?.ids, ["5"], "분류 레인");
  assert.deepEqual(delegatedWork(manage)?.ids, ["7", "8", "9"], "관리기 — 레포별로 갈라 낸 위탁까지");
  assert.equal(delegatedWork({ managers: [{ manager: "m3", kind: "mismatch", found: 0 }] }), null, "위탁 없는 관리기만이면 위탁형이 아니다");
  assert.equal(delegatedWork({ skipped: "미분류 지식 없음", unmapped: 0 }), null, "할 일이 없던 회차");

  assert.equal(cronPhaseOf("ok", distill, st({ 1: "failed", 2: "running" })), null, "하나라도 도는 중이면 회차가 안 끝났다");
  assert.equal(cronPhaseOf("ok", distill, st({ 1: "done", 2: "failed" })), "failing", "다 끝났고 하나라도 실패면 실패");
  assert.equal(cronPhaseOf("ok", { ...distill, task_id: 2, task_status: "done" }, st({ 1: "failed", 2: "done" })), "failing",
    "마지막 되먹임(성공)이 아니라 회차 전체로 판정한다");
  assert.equal(cronPhaseOf("error", distill, st({ 1: "done", 2: "done" })), "ok", "회차가 전부 성공이면 정상");
  assert.equal(cronPhaseOf("ok", manage, st({ 7: "done", 8: "done", 9: "failed" })), "failing", "관리기 레포 위탁 하나의 실패");
  assert.equal(cronPhaseOf("ok", manage, st({ 7: "done", 8: "done", 9: "canceled" })), "ok", "취소는 실패로 세지 않는다");

  //  접수 전에 실패한 레인 — 위탁 id 가 없어 조회할 게 없지만 확정된 실패다. 증류의 잡 상태는 늘 ok 라 이걸 못 보면
  //   실패를 놓치고, 앞 회차가 실패였으면 오히려 «복구» 로 읽힌다.
  const noRunner = { batches: [{ distiller: "A", error: "실행 멤버 미설정 — …" }] };
  assert.deepEqual(delegatedWork(noRunner), { ids: [], entryErrors: ["실행 멤버 미설정 — …"] });
  assert.equal(cronPhaseOf("ok", noRunner), "failing", "접수 전 실패는 조회 없이도 실패");
  assert.equal(cronPhaseOf("ok", { managers: [{ manager: "m1", kind: "contradiction", error: "DB 오류" }] }), "failing", "관리기 실행 오류");
  assert.equal(delegatedPhaseOf({ ids: ["1"], entryErrors: ["x"] }, st({ 1: "running" })), "failing",
    "확정된 실패가 있으면 다른 레인을 기다리지 않는다");
}

// ── 레인 목록 키가 실제 액션의 요약 키와 같다(배선) — 액션이 모양을 바꾸면 감시가 조용히 못 알아본다 ──
{
  const src = (p: string): string => readFileSync(new URL(p, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  assert.match(src("../scheduler/actions/distill.ts"), /summary: \{ batches: out \}/, "증류 레인 요약 키");
  assert.match(src("../scheduler/actions/classify.ts"), /summary: \{ classifiers: out \}/, "분류 레인 요약 키");
  assert.match(src("../scheduler/actions/manage.ts"), /summary: \{ managers: out \}/, "관리 요약 키");
  assert.deepEqual([...DELEGATION_LISTS].sort(), ["batches", "classifiers", "managers"]);
  //  관리기는 접수한 위탁 id 를 반환값(= 잡 요약의 managers[i])에 실어야 한다 — 안 실으면 접수 ok 만 보인다.
  const rm = src("../org/manage/run-manager.ts");
  assert.match(rm, /enqueued: true, \.\.\.\(taskId \? \{ task_id: taskId \} : \{\}\)/, "모순 탐지 관리기가 task_id 를 싣는다");
  assert.match(rm, /enqueued: true, \.\.\.\(taskIds\.length \? \{ task_ids: taskIds \} : \{\}\)/, "코드 비교 관리기가 task_ids 를 싣는다");
}

// ── warn 은 정상이다 — 잡은 돌았고, 경고는 그 잡이 스스로 알린다(카나리) ──
{
  assert.equal(cronPhaseOf("warn"), "ok", "카나리의 warn(프로브 일부 실패)을 크론 실패로 읽으면 카나리의 연속 실패 임계를 건너뛴다");
}

// ── cronPhaseOf: 관측 없음 — 값 없음(아직 한 번도 안 돎) ──
{
  assert.equal(cronPhaseOf(null), null, "null 은 관측 없음");
  assert.equal(cronPhaseOf(undefined), null, "undefined 는 관측 없음");
  assert.equal(cronPhaseOf(""), null, "빈 문자열은 관측 없음");
}

// ── cronPhaseOf: 그 외 모든 낱말은 실패 ──
{
  assert.equal(cronPhaseOf("error"), "failing", "error 는 실패");
  assert.equal(cronPhaseOf("timeout"), "failing", "모르는 낱말도 실패로 취급한다(안전 쪽으로 fail)");
}

// ── cronFailureReason: 후보 우선순위 — task_error 최우선 ──
{
  assert.equal(
    cronFailureReason({ task_error: "위탁 실패 메시지", error: "다른 에러" }),
    "위탁 실패 메시지",
    "task_error 가 있으면 error 보다 우선"
  );
}

// ── cronFailureReason: task_error 없으면 error ──
{
  assert.equal(cronFailureReason({ error: "연결 실패", reason: "다른 사유" }), "연결 실패", "task_error 없으면 error 채택");
}

// ── cronFailureReason: task_error·error 없으면 reason ──
{
  assert.equal(cronFailureReason({ reason: "타임아웃", assign_code: "T001" }), "타임아웃", "앞 두 후보 없으면 reason 채택");
}

// ── cronFailureReason: 앞의 셋 다 없으면 assign_code ──
{
  assert.equal(cronFailureReason({ assign_code: "ASSIGN_FAIL" }), "ASSIGN_FAIL", "마지막 후보 assign_code 채택");
}

// ── cronFailureReason: 공백뿐인 후보는 건너뛰고 다음 후보로 ──
{
  assert.equal(cronFailureReason({ task_error: "   ", error: "실제 사유" }), "실제 사유", "공백뿐인 상위 후보는 건너뛴다");
}

// ── cronFailureReason: 문자열이 아닌 후보는 건너뛴다 ──
{
  assert.equal(cronFailureReason({ task_error: 123, error: "실제 사유" }), "실제 사유", "숫자 등 문자열 아닌 후보는 건너뛴다");
}

// ── cronFailureReason: 여러 줄·연속 공백은 한 칸으로 접는다 ──
{
  const r = cronFailureReason({ error: "첫 줄\n\n둘째   줄" });
  assert.ok(r, "사유가 뽑혀야 한다");
  assert.doesNotMatch(r!, /\n/, "개행이 남아있으면 안 된다");
  assert.match(r!, /첫 줄 둘째 줄/, "여러 줄·연속 공백이 한 칸으로 접혀야 한다");
}

// ── cronFailureReason: 지나치게 길면 300자로 잘라낸다 ──
{
  const long = "가".repeat(500);
  const r = cronFailureReason({ error: long });
  assert.ok(r, "사유가 뽑혀야 한다");
  assert.ok(r!.length <= 300, "300자 상한을 넘으면 안 된다");
}

// ── cronFailureReason: 조직 밖 웹훅으로 나가는 문장이라 출구에서 가린다(#4422) ──
//  되먹임이 넘기는 위탁 실패는 저장 때 이미 가려졌지만, 일반 액션의 error(자식 프로세스 오류 원문)는 아니다.
{
  const r = cronFailureReason({ error: "Command failed: node x.js CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abcdefghijklmnop" });
  assert.ok(r);
  assert.doesNotMatch(r!, /sk-ant-oat01-abcdefghijklmnop/, "토큰 원문이 사유에 남으면 안 된다");
  assert.match(r!, /CLAUDE_CODE_OAUTH_TOKEN=\[REDACTED\]/, "이름은 남기고 값만 가린다");
}

// ── cronFailureReason: 객체가 아니면 사유 없음 ──
{
  assert.equal(cronFailureReason(null), null, "null 은 사유 없음");
  assert.equal(cronFailureReason("그냥 문자열"), null, "문자열은 객체가 아니므로 사유 없음");
  assert.equal(cronFailureReason(42), null, "숫자는 객체가 아니므로 사유 없음");
}

// ── cronFailureReason: 객체이지만 후보가 하나도 없으면 사유 없음 ──
{
  assert.equal(cronFailureReason({}), null, "빈 객체는 후보가 없어 사유 없음");
  assert.equal(cronFailureReason({ other_key: "무관한 값" }), null, "후보 키가 하나도 없으면 사유 없음");
}

// ── cronAlertFor: 직전 == 현재 → 알림 없음 ──
{
  const job: CronJobHealth = { id: "map_unmapped", action: "run_mapping", last_status: "ok", last_summary: {} };
  assert.equal(cronAlertFor("ok", "ok", job), null, "정상 유지 → 침묵(같은 경보 반복 금지)");
  assert.equal(cronAlertFor("failing", "failing", { ...job, last_status: "error" }), null, "실패 유지 → 침묵(재통지 금지)");
}

// ── cronAlertFor: 첫 관측이 정상 → 알림 없음(기동할 때마다 알리면 안 된다) ──
{
  const job: CronJobHealth = { id: "sync-notion-full", action: "run_sync", last_status: "ok" };
  assert.equal(cronAlertFor(null, "ok", job), null, "부팅 시 정상 → 침묵");
}

// ── cronAlertFor: 첫 관측이 실패 → 알린다(이미 실패한 잡을 침묵으로 넘기지 않는다) ──
{
  const job: CronJobHealth = {
    id: "sync-notion-full",
    label: "노션 전체 동기화",
    action: "run_sync",
    last_status: "error",
    last_summary: { error: "노션 API 429" },
  };
  const a = cronAlertFor(null, "failing", job);
  assert.ok(a, "첫 관측이 실패면 알려야 한다");
  assert.match(a!.title + a!.text, /sync-notion-full/, "어느 잡인지(id) 드러나야 한다");
  assert.match(a!.title + a!.text, /노션 전체 동기화/, "label 이 있으면 함께 드러나야 한다");
  assert.match(a!.text, /노션 API 429/, "실패 알림 본문에는 사유가 들어간다");
}

// ── cronAlertFor: 정상 → 실패 전이 → 알림, 심각도 warn ──
{
  const job: CronJobHealth = {
    id: "map_unmapped",
    label: "매핑 갱신",
    action: "run_mapping",
    last_status: "error",
    last_summary: { task_error: "타임아웃" },
  };
  const a = cronAlertFor("ok", "failing", job);
  assert.ok(a);
  assert.equal(a!.severity, "warn", "정상→실패는 경고 등급(지금 전면 장애가 아니라 곧 문제가 되는 상태)");
  assert.match(a!.title + a!.text, /map_unmapped/, "어느 잡인지 드러나야 한다");
  assert.match(a!.title + a!.text, /매핑 갱신/, "label 도 함께");
  assert.match(a!.text, /타임아웃/, "사유가 본문에 들어간다");
}

// ── cronAlertFor: 실패 → 정상 전이 → 알림, 심각도 ok(복구) ──
{
  const job: CronJobHealth = { id: "map_unmapped", label: "매핑 갱신", action: "run_mapping", last_status: "ok" };
  const a = cronAlertFor("failing", "ok", job);
  assert.ok(a, "실패→정상 복구는 반드시 알려야 한다");
  assert.equal(a!.severity, "ok", "복구는 ok 등급");
}

// ── cronAlertFor: 사유를 못 찾으면 '기록되지 않았다'는 뜻을 밝힌다 ──
{
  const job: CronJobHealth = { id: "map_unmapped", action: "run_mapping", last_status: "error", last_summary: {} };
  const a = cronAlertFor("ok", "failing", job);
  assert.ok(a);
  assert.match(a!.text, /기록되지 않/, "사유를 못 찾으면 그 사실을 본문에 밝혀야 한다");
}

// ── cronAlertFor: 자동 정지가 닿는 잡과 아닌 잡에 다른 안내를 한다 ──
//  위탁형(헤드리스)은 카운터가 접수 결과만 세어 상한에 도달하지 못한다 — 같은 문장을 모든 잡에 쓰면
//  액션이 직접 error 를 내는 잡에는 거짓이 되고, 거짓 안내는 알림 전체의 신뢰를 깎는다.
{
  const base: CronJobHealth = { id: "j", action: "a", last_status: "error" };
  const delegated = cronAlertFor("ok", "failing", { ...base, last_summary: { task_id: 9, task_status: "failed" } });
  const direct = cronAlertFor("ok", "failing", { ...base, last_summary: { error: "429" } });
  assert.ok(delegated && direct);
  assert.match(delegated!.text, /스스로 멈추지 않/, "위탁형은 자동 정지가 닿지 않는다고 말한다");
  assert.match(direct!.text, /자동 정지/, "그 외 잡은 상한에서 멈춘다고 말한다");
  assert.equal(/스스로 멈추지 않/.test(direct!.text), false, "두 안내가 섞이면 안 된다");
}

// ── cronAlertFor: label 이 없어도 id 는 제목/본문에 들어간다 ──
{
  const job: CronJobHealth = { id: "housekeeping", action: "run_housekeeping", last_status: "error", last_summary: { reason: "디스크 부족" } };
  const a = cronAlertFor("ok", "failing", job);
  assert.ok(a);
  assert.match(a!.title + a!.text, /housekeeping/, "label 이 없어도 id 는 드러나야 한다");
}

// ── cronAlertFor: detail 에 잡 id·action·직전/현재 상태가 들어간다 ──
{
  const job: CronJobHealth = { id: "map_unmapped", action: "run_mapping", last_status: "error", last_summary: { reason: "테스트 사유" } };
  const a = cronAlertFor("ok", "failing", job);
  assert.ok(a);
  const detailStr = JSON.stringify(a!.detail);
  assert.match(detailStr, /map_unmapped/, "detail 에 잡 id 가 들어간다");
  assert.match(detailStr, /run_mapping/, "detail 에 action 이 들어간다");
  assert.match(detailStr, /ok/, "detail 에 직전 상태가 들어간다");
  assert.match(detailStr, /failing/, "detail 에 현재 상태가 들어간다");
}

// ── 상태기계(tickOnce): 전이에서만 보내고, 보낸 적 있는 문제만 해제한다 ──
//  순수 함수가 맞아도 상태 보관이 틀리면 결과는 같다 — 그 축을 box-watch.test 의 관례대로 여기서 잰다.
//  위탁 5 = 실패, 6 = 성공, 7 = 도는 중(org_task 의 실제 상태 — 감시가 요약의 id 로 읽는다).
const TASKS: ReadonlyMap<string, BatchTaskState> = new Map([
  ["5", { status: "failed", error: "자격 없음" }], ["6", { status: "done" }], ["7", { status: "running" }],
]);
const alertsOf = (): { sent: BoxAlert[]; deps: (jobs: CronJobHealth[] | null, accept?: boolean) => Parameters<typeof tickOnce>[0] } => {
  const sent: BoxAlert[] = [];
  return {
    sent,
    deps: (jobs, accept = true) => ({
      listJobs: async () => jobs, taskStates: async () => TASKS, send: async (a) => { sent.push(a); return accept; },
    }),
  };
};
const failing: CronJobHealth = { id: "j1", action: "agent_headless", last_status: "error", last_summary: { task_error: "자격 없음", task_status: "failed", task_id: 5 } };
const healthy: CronJobHealth = { id: "j1", action: "agent_headless", last_status: "ok", last_summary: { task_status: "done", task_id: 6 } };

{
  stopCronWatch();
  const { sent, deps } = alertsOf();
  await tickOnce(deps([failing]));
  await tickOnce(deps([failing]));
  assert.equal(sent.length, 1, "같은 실패가 이어지면 한 번만 알린다(재통지 금지)");
  await tickOnce(deps([healthy]));
  assert.equal(sent.length, 2, "복구는 알린다");
  assert.equal(sent[1].severity, "ok");
  await tickOnce(deps([healthy]));
  assert.equal(sent.length, 2, "정상 유지 중엔 조용하다");
}

// ── 전송이 실제로 안 된 문제의 복구는 보내지 않는다(받는 사람이 "언제 문제였는데?" 가 된다) ──
{
  stopCronWatch();
  const { sent, deps } = alertsOf();
  await tickOnce(deps([failing], false));   // 채널 미설정 등으로 전송 거부
  assert.equal(sent.length, 1, "시도는 한다");
  await tickOnce(deps([healthy], false));
  assert.equal(sent.length, 1, "문제를 못 알렸으면 복구도 보내지 않는다");
}

// ── skipped 회차는 이전 상태를 보존한다(관측 없음이지 복구가 아니다) ──
{
  stopCronWatch();
  const { sent, deps } = alertsOf();
  await tickOnce(deps([failing]));
  await tickOnce(deps([{ ...failing, last_status: "skipped" }]));
  assert.equal(sent.length, 1, "실행되지 않은 회차로는 아무 알림도 만들지 않는다");
  await tickOnce(deps([healthy]));
  assert.equal(sent.length, 2, "그 뒤 실제로 정상이 되면 그때 복구를 알린다");
}

// ── 접수 ok 가 복구로 읽히지 않는다(이 변경의 본선 시나리오) ──
//  헤드리스 잡은 매 실행 시작에 접수 ok 를 먼저 찍는다. 그 창을 정상으로 읽으면 계속 실패하는 잡이
//  주기마다 «복구» 와 «실패» 를 한 쌍씩 뿜는다 — 그러면 사람이 채널을 음소거하고, 다음 진짜 사고를 놓친다.
{
  stopCronWatch();
  const { sent, deps } = alertsOf();
  const accepted: CronJobHealth = { ...failing, last_status: "ok", last_summary: { task_id: 7 } }; // 접수만 됨
  await tickOnce(deps([failing]));
  await tickOnce(deps([accepted]));
  await tickOnce(deps([failing]));
  assert.equal(sent.length, 1, "접수 창을 지나도 실패는 한 번만 알린다(복구 알림이 끼면 안 된다)");
  assert.equal(sent[0].severity, "warn");
}

// ── 배치형: 레인 하나가 계속 실패해도 회차마다 복구·실패 쌍을 내지 않는다(요동의 본선 시나리오) ──
//  되먹임은 끝난 배치마다 잡 상태를 덮는다 — 아래 last_status/최상위 task_status 가 그 흔들림이다. 판정은 회차의
//  위탁 전부를 보므로, 레인 A(홀수 id)가 계속 실패하는 한 실패로 머문다.
{
  stopCronWatch();
  const sent: BoxAlert[] = [];
  let states = new Map<string, BatchTaskState>();
  const d = (job: CronJobHealth): Parameters<typeof tickOnce>[0] =>
    ({ listJobs: async () => [job], taskStates: async () => states, send: async (a) => { sent.push(a); return true; } });
  const job = (last_status: string, summary: Record<string, unknown>): CronJobHealth =>
    ({ id: "distill", action: "distill_sources_headless", last_status, last_summary: summary });
  // 회차 1 — A(1) 실패가 먼저 되먹여지고, B(2) 성공이 나중에 덮는다.
  const c1 = { batches: [{ distiller: "A", task_id: 1 }, { distiller: "B", task_id: 2 }] };
  states = new Map([["1", { status: "failed", error: "레인 A 도구 오류" }], ["2", { status: "running" }]]);
  await tickOnce(d(job("error", { ...c1, task_id: 1, task_status: "failed" })));
  states = new Map([["1", { status: "failed", error: "레인 A 도구 오류" }], ["2", { status: "done" }]]);
  await tickOnce(d(job("ok", { ...c1, task_id: 2, task_status: "done" })));
  assert.equal(sent.length, 1, "회차가 끝나면 실패를 한 번 알린다(B 의 성공 되먹임이 복구로 읽히면 안 된다)");
  assert.equal(sent[0].severity, "warn");
  assert.match(sent[0].text, /레인 A 도구 오류/, "사유는 마지막 되먹임(B 성공)이 아니라 실패한 배치의 것이다");
  // 회차 2 — 접수 직후(관측 없음) → B 가 먼저 성공 → A 가 또 실패.
  const c2 = { batches: [{ distiller: "A", task_id: 3 }, { distiller: "B", task_id: 4 }] };
  states = new Map([["3", { status: "running" }], ["4", { status: "running" }]]);
  await tickOnce(d(job("ok", c2)));
  states = new Map([["3", { status: "running" }], ["4", { status: "done" }]]);
  await tickOnce(d(job("ok", { ...c2, task_id: 4, task_status: "done" })));
  states = new Map([["3", { status: "failed" }], ["4", { status: "done" }]]);
  await tickOnce(d(job("ok", { ...c2, task_id: 4, task_status: "done" })));   // id 가드로 A(3) 되먹임은 막혔다
  assert.equal(sent.length, 1, "같은 레인이 계속 실패하면 회차가 바뀌어도 알림은 그대로 한 번이다");
  // 회차 3 — 전부 성공하면 그때 복구를 알린다.
  const c3 = { batches: [{ distiller: "A", task_id: 5 }, { distiller: "B", task_id: 6 }] };
  states = new Map([["5", { status: "done" }], ["6", { status: "done" }]]);
  await tickOnce(d(job("ok", { ...c3, task_id: 6, task_status: "done" })));
  assert.equal(sent.length, 2, "회차 전체가 성공하면 복구를 알린다");
  assert.equal(sent[1].severity, "ok");
  stopCronWatch();
}

// ── 관리 잡(실제 요약 모양): 관리기가 계속 실패해도 회차마다 복구·실패 쌍을 내지 않는다 ──
//  종전엔 managers[i] 에 위탁 id 가 없어서, 엔진이 접수 ok 를 쓰는 창이 곧 «복구» 였다(경고·복구·경고·복구…).
{
  stopCronWatch();
  const sent: BoxAlert[] = [];
  let states = new Map<string, BatchTaskState>();
  const d = (job: CronJobHealth): Parameters<typeof tickOnce>[0] =>
    ({ listJobs: async () => [job], taskStates: async () => states, send: async (a) => { sent.push(a); return true; } });
  const mgr = (taskId: number, extra: Record<string, unknown> = {}): CronJobHealth => ({
    id: "managers", action: "run_managers", last_status: "ok",
    last_summary: { managers: [{ manager: "m1", kind: "contradiction", candidates: 3, enqueued: true, task_id: taskId }], ...extra },
  });
  for (const id of [21, 22, 23]) {
    states = new Map([[String(id), { status: "running" }]]);
    await tickOnce(d(mgr(id)));                                               // 엔진이 접수 ok 를 쓴 창
    states = new Map([[String(id), { status: "failed", error: "모델 호출 실패" }]]);
    await tickOnce(d({ ...mgr(id, { task_id: id, task_status: "failed" }), last_status: "error" }));   // 되먹임
  }
  assert.equal(sent.length, 1, "관리기가 세 회차 내리 실패해도 알림은 한 번이다");
  assert.match(sent[0].text, /모델 호출 실패/);
  stopCronWatch();
}

// ── 조회 실패(null)는 «잡이 다 사라졌다» 가 아니다 — 상태를 지우지 않는다 ──
//  DB 가 잠깐 끊긴 뒤 돌아왔을 때: 아직 실패 중인 잡을 또 알리거나, 그 사이 나은 잡의 복구를 삼키면 안 된다.
{
  stopCronWatch();
  const { sent, deps } = alertsOf();
  await tickOnce(deps([failing]));
  await tickOnce(deps(null));
  await tickOnce(deps([failing]));
  assert.equal(sent.length, 1, "조회 실패를 지나도 같은 실패를 다시 알리지 않는다");
  await tickOnce(deps(null));
  await tickOnce(deps([healthy]));
  assert.equal(sent.length, 2, "그 사이 나았으면 복구를 알린다");
  assert.equal(sent[1].severity, "ok");
  stopCronWatch();
}

// ── 목록에서 사라진 잡의 상태는 버린다 — 다시 켜졌을 때 '옛 실패에서 복구' 로 읽히면 안 된다 ──
{
  stopCronWatch();
  const { sent, deps } = alertsOf();
  await tickOnce(deps([failing]));
  await tickOnce(deps([]));                 // 삭제·비활성으로 목록에서 빠짐
  await tickOnce(deps([healthy]));          // 나중에 다시 켜져 정상으로 관측
  assert.equal(sent.length, 1, "다시 켜진 잡의 첫 정상 관측은 복구가 아니다(첫 관측 침묵 규칙)");
  stopCronWatch();
}

console.log("cron-watch.test.ts ok — 상태 판정(정상/관측없음/실패) · 전이시만 알림(침묵·첫관측·경고·복구) · last_summary 사유 추출(우선순위·공백/타입건너뜀·개행접기·300자 상한) · detail 필드 · 상태기계(재통지 금지·미발송 복구 침묵·skipped 보존·접수창 요동 없음·레인 회차 판정·관리 잡 요동 없음·조회 실패 보존·사라진 잡 폐기) · warn 정상 · 사유 가림");
