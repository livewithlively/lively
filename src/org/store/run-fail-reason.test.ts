// 실패한 수집 실행의 사정 한 줄(#4135) — 사양 엣지 표 F1~F9.
//
//  수집 워커의 마지막 로그 줄은 대개 구조화 로그다. 그 줄을 통째로 화면에 내면 사람은 `{"level":50,…}` 를 읽어야 한다.
//  수집기 목록(last_run.error)과 자동 실행 기록이 같은 함수를 쓰므로, 여기가 틀리면 두 화면이 같이 틀린다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REASON_MAX, failReason } from "./run-fail-reason.js";

const J = (o: unknown): string => JSON.stringify(o);

test("F1 로그가 없으면 사유도 없다", () => {
  for (const x of [null, undefined, "", "   ", "\n\n  \n"]) assert.equal(failReason(x as string | null), null);
});
test("F2 구조화 로그의 err 글", () => {
  const log = ["준비", J({ level: 30, msg: "수집기 인스턴스 바인딩" }), J({ level: 50, err: "Figma 토큰이 없습니다 — 저장하세요", msg: "generic 싱크 실패" })].join("\n");
  assert.equal(failReason(log), "Figma 토큰이 없습니다 — 저장하세요");
});
test("F3 err 가 없으면 msg", () => {
  assert.equal(failReason(J({ level: 50, msg: "generic 싱크 실패" })), "generic 싱크 실패");
});
test("F4 err 가 {message} 꼴", () => {
  assert.equal(failReason(J({ level: 50, err: { message: "연결 거부됨", code: "ECONNREFUSED" }, msg: "실패" })), "연결 거부됨");
});
test("F5 마지막 줄이 보통 글", () => {
  assert.equal(failReason("첫 줄\nError: 401 Unauthorized"), "Error: 401 Unauthorized");
});
test("F6 잘린 구조화 로그는 있는 그대로", () => {
  const cut = '{"level":50,"time":1789612960540,"err":"Figma 토';
  assert.equal(failReason("앞 줄\n" + cut), cut);
});
test("F7 경계 — 300자는 그대로, 301자는 자른다", () => {
  assert.equal(REASON_MAX, 300);
  const a = "가".repeat(300), b = "가".repeat(301);
  assert.equal(failReason(a), a);
  assert.equal(failReason(b), a);
  assert.equal(failReason(J({ err: b }))!.length, 300);
});
test("F8 뒤에 빈 줄이 붙어도 글이 있는 마지막 줄", () => {
  assert.equal(failReason("실패했습니다\n\n   \n"), "실패했습니다");
});
test("F9 err · msg 가 비면 그 줄 그대로", () => {
  const line = J({ level: 50, err: "", msg: "  " });
  assert.equal(failReason(line), line);
});
test("배선 — 목록과 기록이 같은 함수를 쓴다", () => {
  const here = new URL(".", import.meta.url).pathname.replace("/dist/", "/src/");
  const col = readFileSync(here + "collectors.ts", "utf8");
  const runs = readFileSync(here + "../../capabilities/delivery/auto-runs.ts", "utf8");
  assert.ok(col.length > 3000 && runs.length > 3000, "소스를 실제로 읽었다");
  assert.match(col, /error: String\(row\.status\) === "error" \? \(failReason\(/, "수집기 목록의 last_run.error");
  assert.match(runs, /failReason\(x\.log_tail\)/, "자동 실행 기록의 error");
  assert.ok(!/function lastLine\(/.test(runs), "옛 함수가 남지 않았다");
});
