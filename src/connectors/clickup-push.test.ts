// 연결된 ClickUp 태스크가 저쪽에서 지워졌을 때 갱신 푸시가 영원히 재시도하지 않는다.
//
// 배경: 갱신(upsert)은 404 를 실패로 다뤄 markErr 로 남기고 다음 틱에 다시 보냈다. 태스크는 돌아오지 않으므로
//  그 행은 매 실행 실패 1건을 만들고, 실행 하나에 실패가 하나라도 있으면 run-push 가 exit 1 이라
//  연속 실패 서킷브레이커(기본 5회)가 push-clickup 을 멈춘다 — 카드 한 장을 ClickUp 에서 손으로 지운 것만으로
//  조직 전체의 반출이 선다. 삭제(delete) 경로는 이미 404 를 성공으로 본다.
//
// 실행: npm run build && node dist/connectors/clickup-push.test.js
import assert from "node:assert/strict";
import { descriptionEchoOf, isClickupTaskGone, isClickupTaskInaccessible, pushLinkedUpsert } from "./clickup-push.js";
import type { ClickUpTask } from "./clickup/types.js";

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
  //  본문은 실측이다 — 다른 워크스페이스로 옮겨진 부모 카드를 조직 토큰으로 GET 하면 이 401/OAUTH_027 이 온다(2026-10-11).
  const otherTeam = new Error('ClickUp 401 /task/abc999: {"err":"Team not authorized","ECODE":"OAUTH_027"}');
  assert.equal(isClickupTaskInaccessible(otherTeam), true, "다른 워크스페이스 카드를 «볼 수 없음» 으로 못 본다 — 부모 연결을 못 끊어 매 틱 실패한다");
  assert.equal(isClickupTaskInaccessible(unauthorized), false, "토큰 자체가 죽은 401 을 «카드 없음» 으로 덮는다 — 토큰 장애가 부모 연결 끊기로 둔갑한다");
  assert.equal(isClickupTaskInaccessible(gone), false);
  assert.equal(isClickupTaskInaccessible(new Error('ClickUp 500 /task/x: OAUTH_027 echoed')), false, "상태코드가 아니라 본문 문자열로 판정한다");
  assert.equal(isClickupTaskInaccessible("OAUTH_027"), false);
  ok("isClickupTaskInaccessible — 401 OAUTH_027 만 «이 워크스페이스에서 볼 수 없음» 으로 본다");
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

// 푸시 메아리 — 인바운드(toRawItem)가 볼 본문과 같은 값을 남겨야 다음 싱크가 우리 값으로 환원한다.
{
  const task = (o: Partial<ClickUpTask>) => o as ClickUpTask;
  const row = (description: string | null, base_description: string | null = null, base_description_echo: string | null = null) =>
    ({ description, base_description, base_description_echo });
  let fetched = 0;
  const fetchOf = (t: ClickUpTask) => async () => { fetched++; return t; };

  assert.equal(await descriptionEchoOf(row(null), "t", fetchOf(task({ markdown_description: "x" }))), null);
  assert.equal(fetched, 0);
  ok("본문 없는 푸시 → 메아리 null · 조회 안 함");

  assert.equal(await descriptionEchoOf(row("a"), "t", fetchOf(task({ markdown_description: "\\<!-- a -->" }))), "\\<!-- a -->");
  assert.equal(fetched, 1);
  ok("푸시 뒤 markdown_description 을 메아리로");

  assert.equal(await descriptionEchoOf(row("a"), "t", fetchOf(task({ markdown_description: "", description: "평문" }))), "평문");
  ok("markdown_description 이 비면 인바운드와 같은 폴백(description)");

  fetched = 0;
  assert.equal(await descriptionEchoOf(row("a", "a", "e"), "t", fetchOf(task({ markdown_description: "다른 값" }))), "e");
  assert.equal(fetched, 0);
  ok("본문이 base 와 같고 메아리가 있으면 재조회 없이 그 메아리");

  assert.equal(await descriptionEchoOf(row("b", "a", "e"), "t", fetchOf(task({ markdown_description: "B" }))), "B");
  ok("본문이 바뀌었으면 다시 조회");

  assert.equal(await descriptionEchoOf(row("a"), "t", async () => { throw serverErr; }), null);
  ok("조회 실패 → null(푸시는 성공으로 둔다)");
}

console.log(`\n${pass} passed`);
