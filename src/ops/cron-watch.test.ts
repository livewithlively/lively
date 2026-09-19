// 크론 감시·알림 규칙 테스트.
//
//  주기적으로 잡들의 last_status 를 보고 **상태가 바뀔 때만** 알림 1건을 만든다.
//  박스 경보(box-watch)와 같은 늑대소년 방지 원칙(같은상태 침묵·부팅정상 침묵·전이시만 알림·복구도 알림)이
//  크론 잡에도 적용되지만, 상태 판정 3분류(정상/실패/관측없음)와 last_summary 에서 사유를 뽑는 규칙이 다르다.
import assert from "node:assert/strict";
import type { BoxAlert } from "./box-watch.js";
import { cronPhaseOf, cronFailureReason, cronAlertFor, tickOnce, stopCronWatch, type CronJobHealth } from "./cron-watch.js";

// ── cronPhaseOf: 정상 ──
{
  assert.equal(cronPhaseOf("ok"), "ok", "ok 는 정상");
}

// ── cronPhaseOf: 관측 없음 — 실행하지 않은 회차(skipped) ──
{
  assert.equal(cronPhaseOf("skipped"), null, "그 회차는 실행되지 않았다 → 관측 없음(전이를 만들지 않는다)");
}

// ── cronPhaseOf: «접수됐지만 아직 안 끝난» ok 는 정상이 아니다 ──
//  헤드리스 잡의 ok 는 태스크를 배치한 시점에 찍힌다. 그 창을 정상으로 읽으면 계속 실패하는 잡이
//  주기마다 복구→실패 알림을 한 쌍씩 뿜는다(늑대소년). 요약의 task_id/task_status 가 그 창을 가른다.
{
  assert.equal(cronPhaseOf("ok", { task_id: 12 }), null, "접수만 된 상태(종결 기록 없음)는 관측 없음");
  assert.equal(cronPhaseOf("ok", { task_id: 12, task_status: "running" }), null, "아직 도는 중이면 관측 없음");
  assert.equal(cronPhaseOf("ok", { task_id: 12, task_status: "queued" }), null, "중첩 skip(대기 중)도 관측 없음");
  assert.equal(cronPhaseOf("ok", { task_id: 12, task_status: "done" }), "ok", "종결이 성공으로 되먹여졌으면 정상");
  assert.equal(cronPhaseOf("error", { task_id: 12, task_status: "failed" }), "failing", "종결이 실패로 되먹여졌으면 실패");
  //  배치형(증류의 batches · 관리의 managers)은 위탁 id 가 배치 안에 있다 — 같은 규칙으로 본다.
  //  이 잡들이 요동의 본선이다(주기는 짧고 배치 하나의 실행은 길다).
  assert.equal(cronPhaseOf("ok", { batches: [{ task_id: 3 }] }), null, "배치형 접수도 종결 전이면 관측 없음");
  assert.equal(cronPhaseOf("ok", { managers: [{ task_id: 3 }] }), null, "관리 잡의 배치형 요약도 동일");
  assert.equal(cronPhaseOf("ok", { batches: [{ task_id: 3 }], task_status: "done" }), "ok", "종결이 덧대지면 그때 판정한다");
  assert.equal(cronPhaseOf("ok", { batches: [] }), "ok", "위탁 id 가 어디에도 없으면 종전대로 판정한다");
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
const alertsOf = (): { sent: BoxAlert[]; deps: (jobs: CronJobHealth[], accept?: boolean) => Parameters<typeof tickOnce>[0] } => {
  const sent: BoxAlert[] = [];
  return {
    sent,
    deps: (jobs, accept = true) => ({ listJobs: async () => jobs, send: async (a) => { sent.push(a); return accept; } }),
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

console.log("cron-watch.test.ts ok — 상태 판정(정상/관측없음/실패) · 전이시만 알림(침묵·첫관측·경고·복구) · last_summary 사유 추출(우선순위·공백/타입건너뜀·개행접기·300자 상한) · detail 필드 · 상태기계(재통지 금지·미발송 복구 침묵·skipped 보존·접수창 요동 없음·사라진 잡 폐기)");
