// SSE 프레임 자르기 — 회귀 가드 (web/sse-frames.ts, #2055).
//
// 왜 이 테스트가 있나: 이 자르기는 **틀려도 조용하다.** 네트워크 청크는 항상 프레임 한가운데서 끊기는데,
//  잘못 자른 조각은 JSON.parse 에서 버려지고 화면엔 "가끔 글자가 빠진다"로만 나타난다 — 신고되지 않고
//  원인도 안 보인다. 실제로 이 통로가 나르는 것은 **승인 요청**이라, 한 장을 놓치면 그 턴이 통째로 선다.
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { frameData, splitSse } = await import(pathToFileURL(path.join(ROOT, "public/app/sse-frames.js")).href);

test("배선 · 모듈이 실제로 함수를 내보낸다", () => {
  assert.equal(typeof frameData, "function");
  assert.equal(typeof splitSse, "function");
});

test("1 · 프레임 하나 — data 값만 뽑는다", () => {
  assert.deepEqual(splitSse('data: {"a":1}\n\n'), { data: ['{"a":1}'], rest: "" });
});

test("★ 2 · 경계가 안 온 꼬리는 rest 로 남는다 — 다음 청크에 이어 붙여야 한 글자도 안 샌다", () => {
  const a = splitSse('data: {"a":1}\n\ndata: {"b":');
  assert.deepEqual(a.data, ['{"a":1}']);
  const b = splitSse(a.rest + '2}\n\n');
  assert.deepEqual(b.data, ['{"b":2}']);
  assert.equal(b.rest, "");
});

test("★ 3 · 주석(하트비트)만 있는 프레임은 값이 없다 — null 을 이벤트로 흘리면 파서가 매번 터진다", () => {
  assert.deepEqual(splitSse(": beat\n\n").data, []);
  assert.equal(frameData(": beat"), null);
});

test("★ 4 · 한 프레임에 data 줄이 여럿이면 개행으로 이어 붙인다(규격) — 한 줄만 읽으면 긴 값이 잘린다", () => {
  assert.equal(frameData("data: 첫줄\ndata: 둘째줄"), "첫줄\n둘째줄");
});

test("5 · data: 뒤 공백은 한 칸만 벗긴다(그 뒤 공백은 값이다)", () => {
  assert.equal(frameData("data:  두칸"), " 두칸");
  assert.equal(frameData("data:없는칸"), "없는칸");
});

test("6 · 한 청크에 프레임이 여러 장이면 순서대로 다 준다", () => {
  const r = splitSse('data: 1\n\ndata: 2\n\ndata: 3\n\n');
  assert.deepEqual(r.data, ["1", "2", "3"]);
});

test("★ 7 · CRLF 로 바꿔 놓는 프록시도 받는다(경계·줄끝 둘 다)", () => {
  const r = splitSse('data: {"a":1}\r\n\r\n');
  assert.deepEqual(r.data, ['{"a":1}']);
  assert.equal(r.rest, "");
});

test("8 · 우리가 안 쓰는 필드(event:·id:)는 무시하되 프레임은 소비한다", () => {
  const r = splitSse('event: ping\nid: 7\n\ndata: 진짜\n\n');
  assert.deepEqual(r.data, ["진짜"]);
});

test("9 · 빈 입력은 아무것도 주지 않는다(예외로 터지지 않는다)", () => {
  assert.deepEqual(splitSse(""), { data: [], rest: "" });
  assert.deepEqual(splitSse(null), { data: [], rest: "" });
});
