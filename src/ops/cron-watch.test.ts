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
  failureRecordedAt, inheritsAlertedFailure,
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
  //  일부 레포만 접수 실패한 코드 비교 관리기 — 남은 위탁이 done 이어도 회차는 실패다(id 가 있다고 error 를 버리면 정상으로 읽힌다).
  const partial = { managers: [{ manager: "m2", kind: "code_drift", task_ids: [8, 9], partial_error: "레포 1/3 접수 실패: r3: 헤드리스 접수 실패" }] };
  assert.deepEqual(delegatedWork(partial), { ids: ["8", "9"], entryErrors: ["레포 1/3 접수 실패: r3: 헤드리스 접수 실패"] });
  assert.equal(cronPhaseOf("warn", partial, st({ 8: "done", 9: "done" })), "failing", "일부 접수 실패는 남은 위탁이 성공해도 실패");
  assert.equal(cronPhaseOf("warn", partial), "failing", "조회 없이도 실패");
  //  접수 후 배정 오류(_headless.ts 배치 오류) — 태스크는 큐에 남아 나중에 돌 수 있으니 id 의 결과로 판정한다.
  const assignErr = { batches: [{ distiller: "A", error: "배치 오류: x", task_id: 3 }] };
  assert.deepEqual(delegatedWork(assignErr), { ids: ["3"], entryErrors: [] });
  assert.equal(cronPhaseOf("ok", assignErr, st({ 3: "done" })), "ok", "배정 오류 뒤 결국 돌았으면 정상");
  //  관리기도 같은 규칙이다 — 배정 단계에서 실패한 모순·코드 비교 관리기는 error 와 id 를 함께 싣는다(run-manager.ts).
  //   잡 status 는 error(전멸)라 브레이커는 세지만, 감시는 큐에 남은 그 위탁의 결과로 판정한다.
  const mgrQueued = { managers: [
    { manager: "m1", kind: "contradiction", candidates: 3, error: "적합 노드 없음", task_id: 77 },
    { manager: "m2", kind: "code_drift", candidates: 2, task_ids: [78], error: "레포 1/1 접수 실패: r1: 적합 노드 없음" },
  ] };
  assert.deepEqual(delegatedWork(mgrQueued), { ids: ["77", "78"], entryErrors: [] });
  assert.equal(cronPhaseOf("error", mgrQueued, st({ 77: "done", 78: "done" })), "ok", "큐에 남았던 관리기 위탁이 결국 돌았으면 정상");
  assert.equal(cronPhaseOf("error", mgrQueued, st({ 77: "queued", 78: "done" })), null, "아직 큐에 있으면 판정 보류");
  assert.equal(cronPhaseOf("error", mgrQueued, st({ 77: "failed", 78: "done" })), "failing", "끝내 못 돌았으면 실패");
  assert.equal(delegatedPhaseOf({ ids: ["1"], entryErrors: ["x"] }, st({ 1: "running" })), "failing",
    "확정된 실패가 있으면 다른 레인을 기다리지 않는다");
}

// ── 레인 목록 키가 실제 액션의 요약 키와 같다(배선) — 액션이 모양을 바꾸면 감시가 조용히 못 알아본다 ──
{
  const src = (p: string): string => readFileSync(new URL(p, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  assert.match(src("../scheduler/actions/distill.ts"), /summary: \{ batches: out\b/, "증류 레인 요약 키");
  assert.match(src("../scheduler/actions/classify.ts"), /summary: \{ classifiers: out \}/, "분류 레인 요약 키");
  assert.match(src("../scheduler/actions/manage.ts"), /summary: \{ managers: out \}/, "관리 요약 키");
  assert.deepEqual([...DELEGATION_LISTS].sort(), ["batches", "classifiers", "managers"]);
  //  관리기는 접수한 위탁 id 를 반환값(= 잡 요약의 managers[i])에 실어야 한다 — 안 실으면 접수 ok 만 보인다.
  const rm = src("../org/manage/run-manager.ts");
  assert.match(rm, /enqueued: true, \.\.\.\(taskId \? \{ task_id: taskId \} : \{\}\)/, "모순 탐지 관리기가 task_id 를 싣는다");
  assert.match(rm, /\.\.\.\(taskIds\.length \? \{ enqueued: true, task_ids: taskIds \} : \{\}\)/, "코드 비교 관리기가 task_ids 를 싣는다");
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

// ── 재시작: 직전 프로세스가 이미 봤을 만큼 오래된 실패는 다시 알리지 않는다 ──
//  관측 상태는 메모리라 재시작하면 비워진다. 격주로 도는 잡의 실패 하나가 다음 회차까지 게이트웨이 재시작마다
//  같은 «크론 실패» 로 되살아났다. 기록 시각이 기동보다 두 주기 넘게 앞서면 «보냈음» 으로 이어받는다.
{
  const MIN = 60_000, CHECK = 5 * MIN, BOOT = Date.parse("2026-11-16T10:55:00Z");
  const iso = (ms: number): string => new Date(ms).toISOString();
  const work = delegatedWork({ task_id: 5 });
  const failedAt = (ms: number | null): Map<string, BatchTaskState> =>
    new Map([["5", { status: "failed", finished_at: ms === null ? null : iso(ms) }]]);

  assert.equal(failureRecordedAt({ ...failing, updated_at: iso(BOOT - 60 * MIN) }, work, failedAt(BOOT - 30 * MIN)), BOOT - 30 * MIN,
    "행보다 늦게 끝난 실패 위탁이 있으면 그 시각이다(되먹임이 덮여 행이 먼저 멈춘 경우)");
  assert.equal(failureRecordedAt({ ...failing, updated_at: iso(BOOT - 10 * MIN) }, work, failedAt(BOOT - 30 * MIN)), BOOT - 10 * MIN,
    "행이 더 늦게 바뀌었으면 행 시각이다(편집은 이어받기를 늦추는 쪽으로만 틀린다)");
  assert.equal(failureRecordedAt({ ...failing, updated_at: iso(BOOT - 60 * MIN) }, work, failedAt(null)), null,
    "끝난 위탁의 종료 시각을 모르면 모른다");
  const lanes = delegatedWork({ batches: [{ distiller: "A", task_id: 7 }, { distiller: "B", task_id: 8 }] });
  assert.equal(failureRecordedAt({ ...failing, updated_at: iso(BOOT - 60 * MIN) }, lanes, new Map([
    ["7", { status: "failed", finished_at: iso(BOOT - 60 * MIN) }], ["8", { status: "done", finished_at: iso(BOOT + MIN) }],
  ])), BOOT + MIN, "회차는 마지막 위탁이 끝나야 판정된다 — 실패한 레인이 아니라 가장 늦게 끝난 레인의 시각이다");
  assert.equal(failureRecordedAt(failing, work, failedAt(BOOT - 30 * MIN)), null, "행 시각을 모르면 모른다");
  assert.equal(failureRecordedAt({ id: "x", action: "a", last_status: "error", updated_at: iso(BOOT - 20 * MIN) }, null, null), BOOT - 20 * MIN,
    "위탁을 내지 않는 잡은 행 시각");

  assert.equal(inheritsAlertedFailure(BOOT - 2 * CHECK - 1, BOOT, CHECK), true, "두 주기 넘게 앞선 실패는 직전 프로세스가 봤다");
  assert.equal(inheritsAlertedFailure(BOOT - 2 * CHECK, BOOT, CHECK), false, "경계는 알리는 쪽");
  assert.equal(inheritsAlertedFailure(BOOT - MIN, BOOT, CHECK), false, "기동 직전의 실패는 직전 프로세스가 못 봤을 수 있다");
  assert.equal(inheritsAlertedFailure(null, BOOT, CHECK), false, "시각을 모르면 알린다");
}
{
  //  상태기계: 오래된 실패는 첫 관측에 침묵하고, 복구는 그대로 알린다. 갓 기록된 실패는 종전처럼 알린다.
  const BOOT = Date.now() - 1_000;
  const old = new Date(BOOT - 24 * 3600_000).toISOString();
  const tasks = (fin: string): Map<string, BatchTaskState> => new Map([
    ["5", { status: "failed", error: "timeout(21600s)", finished_at: fin }], ["6", { status: "done" }],
  ]);
  const sent: BoxAlert[] = [];
  const d = (job: CronJobHealth, fin: string): Parameters<typeof tickOnce>[0] =>
    ({ listJobs: async () => [job], taskStates: async () => tasks(fin), send: async (a) => { sent.push(a); return true; }, bootedAt: BOOT });

  stopCronWatch();
  await tickOnce(d({ ...failing, updated_at: old }, old));
  await tickOnce(d({ ...failing, updated_at: old }, old));
  assert.equal(sent.length, 0, "재시작 전부터 실패해 있던 잡을 다시 알리지 않는다");
  await tickOnce(d({ ...healthy, updated_at: new Date().toISOString() }, old));
  assert.equal(sent.length, 1, "이어받은 실패에서 나으면 복구를 알린다");
  assert.equal(sent[0].severity, "ok");

  stopCronWatch();
  const fresh = new Date(BOOT - 60_000).toISOString();
  await tickOnce(d({ ...failing, updated_at: fresh }, fresh));
  assert.equal(sent.length, 2, "기동 직전에 기록된 실패는 알린다");
  assert.equal(sent[1].severity, "warn");
  stopCronWatch();
}

{
  //  레인 하나가 재시작 전에 실패했어도 다른 레인이 재시작 뒤에 끝났으면, 직전 프로세스는 회차를 판정한 적이 없다.
  //   되먹임 id 가드·취소로 행 updated_at 이 실패 시각에 멈춰 있어도 알려야 한다(리뷰가 재현한 침묵 경로).
  const BOOT = Date.now() - 1_000;
  const old = new Date(BOOT - 24 * 3600_000).toISOString();
  const job: CronJobHealth = { id: "lanes", action: "distill_sources_headless", last_status: "error", updated_at: old,
    last_summary: { batches: [{ distiller: "A", task_id: 5 }, { distiller: "B", task_id: 7 }], task_id: 7, task_status: "failed" } };
  for (const last of ["done", "canceled"]) {
    stopCronWatch();
    const sent: BoxAlert[] = [];
    let states = new Map<string, BatchTaskState>([["5", { status: "running" }], ["7", { status: "failed", error: "레인 B 실패", finished_at: old }]]);
    const d: Parameters<typeof tickOnce>[0] =
      { listJobs: async () => [job], taskStates: async () => states, send: async (a) => { sent.push(a); return true; }, bootedAt: BOOT };
    await tickOnce(d);
    assert.equal(sent.length, 0, "회차가 아직 안 끝났다");
    states = new Map([["5", { status: last, finished_at: new Date().toISOString() }], ["7", { status: "failed", error: "레인 B 실패", finished_at: old }]]);
    await tickOnce(d);
    assert.equal(sent.length, 1, `재시작 뒤에 회차가 끝났으면(${last}) 실패를 알린다`);
    assert.equal(sent[0].severity, "warn");
  }
  stopCronWatch();
}

{
  //  이어받기는 «재시작 뒤 첫 스캔» 에 이미 켜져 있던 잡에만 건다. 그 뒤에 목록에 들어온 잡(다시 켬·새로 만듦)은 직전
  //   프로세스가 지켜보던 잡이 아니다. 수집기·커넥터 싱크 잡은 다시 켤 때 updated_at 을 올리지 않아(org/store/collectors.ts ·
  //   connectors.ts 의 ON CONFLICT … enabled=true) 행 시각이 옛 실패에 머문다 — 거기에 이어받기를 걸면 고치지 못한 채 다시 켠
  //   수집기가 계속 실패해도 경보가 한 번도 나가지 않는다.
  const BOOT = Date.now() - 3600_000;   // 한 시간 전에 뜬 프로세스
  const old = new Date(BOOT - 24 * 3600_000).toISOString();
  const sync: CronJobHealth = { id: "sync-slack", action: "connector_sync", last_status: "error", last_summary: { error: "401" }, updated_at: old };
  for (const firstScanList of [[], [{ ...sync, last_status: "ok", last_summary: {} }]] as CronJobHealth[][]) {
    stopCronWatch();
    const sent: BoxAlert[] = [];
    let jobs: CronJobHealth[] = firstScanList;
    const d: Parameters<typeof tickOnce>[0] = { listJobs: async () => jobs, send: async (a) => { sent.push(a); return true; }, bootedAt: BOOT };
    await tickOnce(d);              // 재시작 뒤 첫 스캔 — 꺼져 있었거나(목록에 없음) 정상이었다
    jobs = [];
    await tickOnce(d);              // 사람이 껐다(관측 상태 폐기)
    jobs = [sync];
    await tickOnce(d);              // 다시 켰다 — 행은 하루 전 실패 그대로
    assert.equal(sent.length, 1, `다시 켠 잡이 실패해 있으면 알린다(첫 스캔 목록 ${firstScanList.length}건)`);
    assert.equal(sent[0].severity, "warn");
    await tickOnce(d);
    assert.equal(sent.length, 1, "알린 뒤엔 상태 그대로라 침묵");
  }
  stopCronWatch();
}
{
  //  목록을 못 읽은 tick(null)은 첫 스캔을 소비하지 않는다 — 읽기에 성공한 다음 tick 이 첫 스캔이라 오래된 실패를 이어받는다.
  const BOOT = Date.now() - 3600_000;
  const old = new Date(BOOT - 24 * 3600_000).toISOString();
  stopCronWatch();
  const sent: BoxAlert[] = [];
  let jobs: CronJobHealth[] | null = null;
  const d: Parameters<typeof tickOnce>[0] = {
    listJobs: async () => jobs,
    taskStates: async () => new Map([["5", { status: "failed", error: "timeout", finished_at: old }]]),
    send: async (a) => { sent.push(a); return true; }, bootedAt: BOOT,
  };
  await tickOnce(d);
  jobs = [{ ...failing, updated_at: old }];
  await tickOnce(d);
  assert.equal(sent.length, 0, "목록 읽기에 실패한 tick 뒤의 첫 성공 스캔도 첫 스캔이다");
  stopCronWatch();
}

console.log("cron-watch.test.ts ok — 상태 판정(정상/관측없음/실패) · 전이시만 알림(침묵·첫관측·경고·복구) · last_summary 사유 추출(우선순위·공백/타입건너뜀·개행접기·300자 상한) · detail 필드 · 상태기계(재통지 금지·미발송 복구 침묵·skipped 보존·접수창 요동 없음·레인 회차 판정·관리 잡 요동 없음·조회 실패 보존·사라진 잡 폐기·재시작 뒤 오래된 실패 이어받기·재시작 뒤 끝난 레인의 실패 알림·첫 스캔 뒤 다시 켠 잡은 이어받지 않음·읽기 실패 tick 은 첫 스캔이 아님) · warn 정상 · 사유 가림");
