// 크론 위탁 → 잡 되먹임 규칙 테스트.
//
//  크론이 낸 위탁은 requester_session 에 `cron:<잡id>` 또는 `cron:<잡id>#<배치키>` 마커를 남긴다.
//  이 마커에서 잡 id 를 뽑아내는 규칙과, 위탁 성공/실패를 잡이 기록할 상태 낱말로 옮기는 규칙을 검증한다.
//  잡 id 추출을 잘못하면 사람이 직접 부른 위탁 결과로 엉뚱한 잡 상태가 갱신된다.
//  되먹임 UPDATE 는 «무엇을 쓰고 무엇을 안 쓰는지»가 곧 계약이라 조립 결과를 직접 고정한다.
import assert from "node:assert/strict";
import { cronJobIdOf, cronStatusOf, buildCronFeedbackUpdate } from "./cron-task-feedback.js";

// ── cronJobIdOf: 기본 마커에서 잡 id 추출 ──
{
  assert.equal(cronJobIdOf("cron:map_unmapped"), "map_unmapped", "밑줄 포함 잡 id 를 그대로 추출");
  assert.equal(cronJobIdOf("cron:sync-notion-full"), "sync-notion-full", "하이픈 포함 잡 id 를 그대로 추출");
}

// ── cronJobIdOf: 배치 마커 — # 뒤는 잡 id 의 일부가 아니다 ──
{
  assert.equal(cronJobIdOf("cron:map_unmapped#batch1"), "map_unmapped", "# 뒤 배치키는 잡 id 에서 제외한다");
  assert.equal(cronJobIdOf("cron:sync-notion-full#2026-09-19"), "sync-notion-full", "하이픈 잡 id + 배치키 조합도 동일하게 처리");
}

// ── cronJobIdOf: 잡 id 가 비면 해당 없음 ──
{
  assert.equal(cronJobIdOf("cron:"), null, "콜론만 있고 잡 id 가 없으면 해당 없음");
  assert.equal(cronJobIdOf("cron:#batch1"), null, "잡 id 는 비고 배치키만 있어도 해당 없음");
}

// ── cronJobIdOf: 크론 유래가 아니면 해당 없음 ──
{
  assert.equal(cronJobIdOf("manual:map_unmapped"), null, "다른 접두는 크론 마커가 아니다");
  assert.equal(cronJobIdOf("사람이 직접 부른 위탁"), null, "마커 자체가 없는 문자열은 해당 없음");
}

// ── cronJobIdOf: 입력 없음 ──
{
  assert.equal(cronJobIdOf(null), null, "null 입력은 해당 없음");
  assert.equal(cronJobIdOf(undefined), null, "undefined 입력은 해당 없음");
  assert.equal(cronJobIdOf(""), null, "빈 문자열은 해당 없음");
}

// ── cronStatusOf: 위탁 성공/실패 → 잡 상태 낱말 ──
{
  assert.equal(cronStatusOf(true), "ok", "성공은 ok 로 옮긴다");
  assert.equal(cronStatusOf(false), "error", "실패는 error 로 옮긴다(화면·감시기가 이미 아는 낱말)");
}

// ── 되먹임 UPDATE: last_run_at 은 쓰지도 읽지도 않는다 ──
//  쓰면 잡 주기가 실행시간만큼 밀리고, **읽으면**(«더 최근 실행이 있었나»를 시각으로 재면) 오래 도는
//  태스크의 잡에서 되먹임이 통째로 드롭된다 — 중첩 skip 회차마다 last_run_at 이 앞으로 밀리기 때문이다.
//  그 드롭이 곧 침묵이고, 침묵이 이 기능이 고치려던 바로 그 증상이다.
{
  const u = buildCronFeedbackUpdate({ jobId: "distill-all", taskId: 42, ok: false, error: "타임아웃" });
  assert.equal(/last_run_at/.test(u.sql), false, "last_run_at 은 SET 에도 WHERE 에도 등장하면 안 된다");
  assert.match(u.sql, /task_id/, "순서 판정은 단조 증가하는 task_id 로 한다");
}

// ── 되먹임 UPDATE: 더 큰 task_id 가 기록돼 있으면(= 새 실행이 돌았으면) 쓰지 않는다 ──
{
  const u = buildCronFeedbackUpdate({ jobId: "distill-all", taskId: 42, ok: true });
  assert.match(u.sql.replace(/\s+/g, " "), /task_id'\)::bigint <= \$4/, "기록된 id 보다 크지 않은 태스크만 쓴다");
  assert.equal(u.params[3], 42, "비교 대상은 이 태스크의 id");
  assert.match(u.sql.replace(/\s+/g, " "), /task_id'\) IS NULL OR/, "최상위 task_id 가 없는 요약(배치 잡)은 통과시킨다");
}

// ── 되먹임 UPDATE: 무엇을 적나 ──
{
  const u = buildCronFeedbackUpdate({ jobId: "distill-all", taskId: 7, ok: false, error: "죽음" });
  assert.equal(u.params[0], "distill-all", "대상 잡");
  assert.equal(u.params[1], "error", "실패는 error 로 적는다");
  const patch = JSON.parse(String(u.params[2]));
  assert.equal(patch.task_status, "failed");
  assert.equal(patch.task_error, "죽음");
  assert.equal(patch.task_id, 7);
  assert.match(u.sql, /COALESCE\(last_summary/, "요약은 통째로 갈지 않고 덧댄다(접수 시점 정보 보존)");
}

// ── 되먹임 UPDATE: 긴 에러는 잘라 싣는다(요약이 통째로 비대해지지 않게) ──
{
  const u = buildCronFeedbackUpdate({ jobId: "j", taskId: 1, ok: false, error: "가".repeat(900) });
  assert.equal(JSON.parse(String(u.params[2])).task_error.length, 500);
}

console.log("cron-task-feedback.test.ts ok — 마커에서 잡 id 추출(배치키 제외·해당없음 판정) · 위탁 성공/실패 → ok/error · 되먹임 UPDATE 계약(last_run_at 무접촉·task_id 순서가드·요약 덧대기)");
