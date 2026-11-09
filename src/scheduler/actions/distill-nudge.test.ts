// 수집 직후 이어달리기가 깨워도 되는 증류 잡인가 — 시각형(cron_expr) 잡을 깨우면 «야간에만» 같은
//  벽시계 약속이 수집 주기(1~2분)마다 깨진다.
import { strict as assert } from "node:assert";
import { isNudgeableDistillJob } from "./distill-nudge.js";

// 주기형 — 앞당겨도 약속을 어기지 않는다
assert.equal(isNudgeableDistillJob({ cron_expr: null }), true);
assert.equal(isNudgeableDistillJob({ cron_expr: undefined }), true);
assert.equal(isNudgeableDistillJob({}), true);
assert.equal(isNudgeableDistillJob({ cron_expr: "" }), true, "빈 cron_expr 은 interval 모드다(cron_set 이 빈 문자열로 되돌린다)");

// ★ 시각형 — 깨우면 벽시계 약속이 깨진다
assert.equal(isNudgeableDistillJob({ cron_expr: "0,20,40 22,23,0,1,2,3 * * *" }), false,
  "야간 전용 잡을 깨웠다 — 수집기가 돌 때마다 낮에도 실행된다");
assert.equal(isNudgeableDistillJob({ cron_expr: "30 4 * * *" }), false);

console.log("distill-nudge ok");
