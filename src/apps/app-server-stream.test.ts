// 함수 응답(HTTP 통합 틀) 풀기(#4485) 시험 — 사양 표 C(spec-4485.md). 흘려 받기의 사건들을 직접 만들어 넣는다.
import test from "node:test";
import assert from "node:assert/strict";
import { HTTP_INTEGRATION_CT, PRELUDE_MAX, collectHttpStream, parsePrelude, startHttpStream } from "./app-server-stream.js";
import type { StreamEvent, StreamInvokeOut } from "../net/aws/lambda-lite.js";

const NUL8 = Buffer.alloc(8);
function out(parts: Buffer[], ct: string | null = HTTP_INTEGRATION_CT, log = "REPORT RequestId: x\tDuration: 3.00 ms\tBilled Duration: 4 ms\t"): StreamInvokeOut {
  async function* events(): AsyncGenerator<StreamEvent> {
    for (const p of parts) yield { type: "chunk", data: p };
    yield { type: "complete", errorCode: null, errorDetails: null, log };
  }
  return { status: 200, executedVersion: "1", contentType: ct, events: events() };
}
const prelude = (o: unknown): Buffer => Buffer.from(JSON.stringify(o));

test("C1 앞머리 + NUL 8 + 본문 한 조각 — 상태 · 머리글 · 쿠키 · 본문", async () => {
  const p = { statusCode: 201, headers: { "Content-Type": "application/json", "X-A": "1" }, cookies: ["a=1; Path=/", "b=2"] };
  const r = await collectHttpStream(out([Buffer.concat([prelude(p), NUL8, Buffer.from("{\"ok\":1}")])]));
  assert.equal(r.kind, "http");
  if (r.kind !== "http") return;
  assert.equal(r.prelude.statusCode, 201);
  assert.deepEqual(r.prelude.headers, { "content-type": "application/json", "x-a": "1" }, "머리글 이름은 소문자로");
  assert.deepEqual(r.prelude.cookies, ["a=1; Path=/", "b=2"]);
  assert.equal(r.body.toString(), "{\"ok\":1}");
  assert.match(r.complete!.log, /Billed Duration/);
});

test("C2 앞머리가 여러 조각 · NUL 8 이 조각 경계에 걸쳐도 같은 결과 · 뒤 조각은 이어 읽는다", async () => {
  const whole = Buffer.concat([prelude({ statusCode: 200, headers: {}, cookies: [] }), NUL8, Buffer.from("body-1"), Buffer.from("body-2")]);
  const at = whole.indexOf(NUL8);
  const parts = [whole.subarray(0, 5), whole.subarray(5, at + 3), whole.subarray(at + 3, at + 8 + 2), whole.subarray(at + 10)];
  const s = await startHttpStream(out(parts));
  assert.equal(s.kind, "http");
  if (s.kind !== "http") return;
  assert.equal(s.prelude.statusCode, 200);
  const rest: string[] = [s.first.toString()];
  for await (const ev of s.rest) if (ev.type === "chunk") rest.push(ev.data.toString());
  assert.equal(rest.join(""), "body-1body-2");
});

test("C3 본문 없는 응답 — NUL 8 뒤에 아무것도 없다", async () => {
  const r = await collectHttpStream(out([prelude({ statusCode: 204, headers: {} }), NUL8]));
  assert.equal(r.kind, "http");
  if (r.kind === "http") { assert.equal(r.prelude.statusCode, 204); assert.equal(r.body.length, 0); assert.deepEqual(r.prelude.cookies, []); }
});

test("C4 통합 틀이 아니면(앱이 응답 전에 죽음) 오류 + Lambda 오류 본문", async () => {
  const err = Buffer.from(JSON.stringify({ errorType: "Runtime.ExitError", errorMessage: "exit status 4" }));
  const r = await collectHttpStream(out([err], "application/octet-stream"));
  assert.equal(r.kind, "error");
  if (r.kind === "error") { assert.equal(JSON.parse(r.payload.toString()).errorType, "Runtime.ExitError"); assert.ok(r.complete); }
  const r2 = await collectHttpStream(out([err], null));
  assert.equal(r2.kind, "error", "틀 머리가 없으면 통합 틀로 보지 않는다");
  //  내용이 통합 틀처럼 생겨도(앞머리 + NUL 8) 틀 머리가 아니면 앱 응답으로 내보내지 않는다 — 판정은 Lambda 가 준 틀 머리가 한다.
  const lookalike = Buffer.concat([prelude({ statusCode: 200, headers: {} }), NUL8, Buffer.from("hi")]);
  assert.equal((await collectHttpStream(out([lookalike], "application/octet-stream"))).kind, "error", "틀 머리 없이 앱 응답처럼 읽었다");
});

test("C5 앞머리 전에 끝남 · 앞머리 JSON 깨짐 · 앞머리가 너무 김 → 오류", async () => {
  assert.equal((await collectHttpStream(out([Buffer.from("{\"statusCode\":200")]))).kind, "error");
  assert.equal((await collectHttpStream(out([Buffer.from("{nope"), NUL8, Buffer.from("x")]))).kind, "error");
  assert.equal((await collectHttpStream(out([Buffer.alloc(PRELUDE_MAX + 10, 0x61)]))).kind, "error");
  assert.equal((await collectHttpStream(out([]))).kind, "error", "조각 없이 끝남");
});

test("C6 경계 — statusCode 100 · 599 받음 · 99 · 600 · 정수 아님 · 배열 앞머리 거부", () => {
  assert.equal(parsePrelude(prelude({ statusCode: 100 }))?.statusCode, 100);
  assert.equal(parsePrelude(prelude({ statusCode: 599 }))?.statusCode, 599);
  assert.equal(parsePrelude(prelude({ statusCode: 99 })), null);
  assert.equal(parsePrelude(prelude({ statusCode: 600 })), null);
  assert.equal(parsePrelude(prelude({ statusCode: 200.5 })), null);
  assert.equal(parsePrelude(prelude([200])), null);
});

test("C7 머리글 — 이름 소문자 · 배열 값은 합침 · 숫자는 글자로 · 객체 값은 버림 · 쿠키 배열의 글자 아닌 것은 버림", () => {
  const p = parsePrelude(prelude({ statusCode: 200, headers: { Vary: ["a", "b"], "Content-Length": 5, Bad: { x: 1 } }, cookies: ["a=1", 3, null] }))!;
  assert.deepEqual(p.headers, { vary: "a, b", "content-length": "5" });
  assert.deepEqual(p.cookies, ["a=1"]);
});
