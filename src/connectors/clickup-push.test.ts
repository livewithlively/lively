// 연결된 ClickUp 태스크가 저쪽에서 지워졌을 때 갱신 푸시가 영원히 재시도하지 않는다.
//
// 배경: 갱신(upsert)은 404 를 실패로 다뤄 markErr 로 남기고 다음 틱에 다시 보냈다. 태스크는 돌아오지 않으므로
//  그 행은 매 실행 실패 1건을 만들고, 실행 하나에 실패가 하나라도 있으면 run-push 가 exit 1 이라
//  연속 실패 서킷브레이커(기본 5회)가 push-clickup 을 멈춘다 — 카드 한 장을 ClickUp 에서 손으로 지운 것만으로
//  조직 전체의 반출이 선다. 삭제(delete) 경로는 이미 404 를 성공으로 본다.
//
// 실행: npm run build && node dist/connectors/clickup-push.test.js
import assert from "node:assert/strict";
import { isClickupTaskGone, pushLinkedUpsert } from "./clickup-push.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

// clickupFetch 가 던지는 모양 그대로(api.ts: `ClickUp ${status} ${path}: ${text}`).
//  본문은 실측이다 — 삭제된 태스크에 GET·PUT 모두 이 404/ITEM_013 이 온다(2026-09-29, clickup API 직접 호출로 확인).
const gone = new Error('ClickUp 404 /task/abc123: {"err":"Task not found, deleted","ECODE":"ITEM_013"}');
const unauthorized = new Error('ClickUp 401 /task/abc123: {"err":"Token invalid"}');
const serverErr = new Error("ClickUp 502 /task/abc123: bad gateway");

{
  assert.equal(isClickupTaskGone(gone), true);
  assert.equal(isClickupTaskGone(unauthorized), false);
  assert.equal(isClickupTaskGone(serverErr), false);
  // 경로나 본문에 404 라는 숫자가 들어 있어도 상태코드가 아니면 아니다.
  assert.equal(isClickupTaskGone(new Error("ClickUp 500 /task/x404y: upstream 404 lookup failed")), false);
  assert.equal(isClickupTaskGone("not an error"), false);
  ok("isClickupTaskGone — 상태코드 404 만 «태스크 없음»으로 본다");
}

{
  const calls: string[] = [];
  const r = await pushLinkedUpsert({
    update: async () => { calls.push("update"); },
    detach: async () => { calls.push("detach"); },
  });
  assert.equal(r, "pushed");
  assert.deepEqual(calls, ["update"]);
  ok("갱신 성공 → pushed · 연결 유지");
}

{
  const calls: string[] = [];
  const r = await pushLinkedUpsert({
    update: async () => { calls.push("update"); throw gone; },
    detach: async () => { calls.push("detach"); },
  });
  assert.equal(r, "detached");
  assert.deepEqual(calls, ["update", "detach"]);
  ok("★태스크가 지워졌다(404) → 연결을 끊고 detached — 던지지 않는다(재시도 안 함)");
}

for (const [label, err] of [["401", unauthorized], ["502", serverErr]] as const) {
  const calls: string[] = [];
  await assert.rejects(
    pushLinkedUpsert({
      update: async () => { calls.push("update"); throw err; },
      detach: async () => { calls.push("detach"); },
    }),
    (e: unknown) => e === err,
  );
  assert.deepEqual(calls, ["update"], `${label} 에선 연결을 끊으면 안 된다`);
  ok(`${label} → 그대로 던진다(종전대로 재시도) · 연결 유지`);
}

{
  const detachFail = new Error("db down");
  await assert.rejects(
    pushLinkedUpsert({ update: async () => { throw gone; }, detach: async () => { throw detachFail; } }),
    (e: unknown) => e === detachFail,
  );
  ok("연결 끊기가 실패하면 던진다 — 다음 틱에 다시 본다(조용히 done 으로 닫지 않는다)");
}

console.log(`\n${pass} passed`);
