// 배정 실패 판정(#3994 T5 · #968) — 사양 엣지 표 A·C1 (스크래치패드 spec.md).
//  틀렸을 때: `error` 를 `ok` 로 적으면 #968 이 그대로 재발한다(파이프라인이 멈췄는데 크론은 초록,
//  서킷 브레이커도 안 걸린다 — 실측 10시간·199건). 반대로 `capacity` 를 `error` 로 적으면 **정상 배압**마다
//  잡이 실패로 기록되고 연속 5회에 스스로 꺼진다 — 자리 없는 시간대가 자동화를 통째로 끈다.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assignFailKind, headlessEnqueueStatus, type AssignFailCode } from "./assign-outcome.js";

// ── 표 A 의 코드별 종류 ──
assert.equal(assignFailKind("capacity"), "backpressure", "자리 부족을 고장으로 봤다 — 붐빌 때마다 잡이 꺼진다");
assert.equal(assignFailKind("no_nodes"), "fault", "후보 0 을 배압으로 봤다 — #968 재발");
assert.equal(assignFailKind("no_harness"), "fault", "하네스를 보고한 노드가 없는데 배압으로 봤다");
assert.equal(assignFailKind("node_disabled"), "fault", "노드 비활성을 배압으로 봤다");
assert.equal(assignFailKind("spawn_error"), "fault", "스폰 예외를 배압으로 봤다");

// ── A8·A9 ★ 새로 도입한 축이 비었거나 모르는 값일 때 — 보수적으로 고장 ──
assert.equal(assignFailKind(undefined), "fault", "코드 없는 실패를 정상으로 봤다 — 옛 호출부가 조용히 새는 자리다");
assert.equal(assignFailKind(null), "fault");
assert.equal(assignFailKind("made-up" as AssignFailCode), "fault", "처음 보는 코드를 배압으로 접었다 — 미래의 사유가 조용히 ok 가 된다");

// ── A1~A3 잡 상태 ──
assert.equal(headlessEnqueueStatus({ assigned: true }), "ok");
assert.equal(headlessEnqueueStatus({ assigned: true, code: "capacity" }), "ok", "배정됐는데 잔여 코드 때문에 실패로 적었다");
assert.equal(headlessEnqueueStatus({ assigned: false, code: "capacity" }), "ok",
  "자리 부족을 error 로 적었다 — 정상 배압이 브레이커를 때린다");

// ── A4~A9 잡 상태 ──
assert.equal(headlessEnqueueStatus({ assigned: false, code: "no_nodes" }), "error",
  "후보가 하나도 없는데 ok 로 적었다 — 이것이 #968 의 기제다");
assert.equal(headlessEnqueueStatus({ assigned: false, code: "no_harness" }), "error");
assert.equal(headlessEnqueueStatus({ assigned: false, code: "node_disabled" }), "error");
assert.equal(headlessEnqueueStatus({ assigned: false, code: "spawn_error" }), "error");
assert.equal(headlessEnqueueStatus({ assigned: false }), "error", "사유 없는 미배정을 ok 로 적었다");
assert.equal(headlessEnqueueStatus({ assigned: false, code: null }), "error");

// ── 표 C1 ★ 배선 — 판정을 «맞게 계산하고 안 쓰는» 상태를 막는다 ──
//  순수 함수만 맞으면 호출부가 여전히 status 를 하드코딩해도 위 표는 전부 초록이다.
//  #968 이 정확히 그 모양이었다(판정이 없었고 호출부가 ok 를 박아 뒀다).
const headless = readFileSync(path.join(process.cwd(), "src/scheduler/actions/_headless.ts"), "utf8");
assert.ok(headless.includes("headlessEnqueueStatus"),
  "_headless.ts 가 배정 판정을 안 쓴다 — 접수 실패가 다시 ok 로 기록된다");
assert.ok(!/if \(!assign\.assigned\) return \{ status: "ok"/.test(headless),
  "미배정 반환이 여전히 status:\"ok\" 로 굳어 있다");

console.log("assign-outcome.test: ok");
