// 하네스 세션 I/O 어댑터 — 계약 테스트 (#1746). "모든 하네스가 모든 축을 답한다"를 표로 못박는다(harness-registry 원칙).
//  하나라도 빠지면 그 하네스의 세션 화면이 **조용히 반쪽**이 된다(#1475 "한 군데 빠져 조용히 안 감"). 사양: spec §A.
import assert from "node:assert/strict";
import { HARNESSES } from "../catalog.js";
import { HARNESS_IO, harnessIo, chatIoCaps, READABLE_HARNESSES, isChatAction } from "./adapter.js";
import { KNOWN_HARNESSES } from "../../sessions/session-share.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("[A1] 카탈로그(catalog.ts HARNESSES)의 모든 하네스에 어댑터가 있다 — 새 하네스를 카탈로그에만 넣으면 여기서 잡힌다", () => {
  for (const h of HARNESSES) assert.ok(harnessIo(h.key), `어댑터 없음: ${h.key}`);
});
// 키트 레지스트리(kit/hooks/harness-registry.mjs, 런타임 의존 0)의 목록과도 같은 우주를 본다 — 배포물 경계 때문에 dynamic import.
const reg = await import(new URL("../../../kit/hooks/harness-registry.mjs", import.meta.url).href) as { HARNESS_IDS: string[] };
t("[A2] 키트 레지스트리(HARNESS_IDS)의 모든 하네스에도 어댑터가 있다", () => {
  assert.ok(reg.HARNESS_IDS.length >= 5, "레지스트리가 비었다(배선 확인)");
  for (const id of reg.HARNESS_IDS) assert.ok(harnessIo(id), `어댑터 없음: ${id}`);
});
t("[A3] 모든 어댑터가 모든 축을 답한다(null 도 답이다 — undefined 는 '빠뜨림')", () => {
  for (const a of HARNESS_IO) {
    assert.equal(typeof a.key, "string"); assert.equal(typeof a.label, "string");
    assert.equal(typeof a.roots, "function", `${a.key}.roots`);
    assert.ok(a.filePattern instanceof RegExp, `${a.key}.filePattern`);
    assert.ok("pathFor" in a && (a.pathFor === null || typeof a.pathFor === "function"), `${a.key}.pathFor`);
    assert.ok("parse" in a && (a.parse === null || typeof a.parse === "function"), `${a.key}.parse`);
    assert.ok("answer" in a && (a.answer === null || typeof a.answer === "function"), `${a.key}.answer`);
    assert.ok(Array.isArray(a.roots(["/home/x"], "yoon")), `${a.key}.roots 는 배열`);
  }
});
t("[A4] 실측된 파서 — claude·antigravity·codex·grok 은 읽고, opencode·shell 은 아직 못 읽는다(있는 척 안 한다)", () => {
  assert.deepEqual([...READABLE_HARNESSES].sort(), ["antigravity", "claude", "codex", "grok"]);
  assert.deepEqual(chatIoCaps("claude"), { read: true, answer: true, chatFirst: true });
  assert.deepEqual(chatIoCaps("grok"), { read: true, answer: false, chatFirst: true });      // 승인 UI 미실측 → 화면이 버튼을 안 그린다
  assert.deepEqual(chatIoCaps("antigravity"), { read: true, answer: false, chatFirst: true });
  assert.deepEqual(chatIoCaps("codex"), { read: true, answer: false, chatFirst: true });   // rollout 파서 실측(#1759) · 승인 UI 미실측
  assert.deepEqual(chatIoCaps("opencode"), { read: false, answer: false, chatFirst: false });
  assert.deepEqual(chatIoCaps("shell"), { read: false, answer: false, chatFirst: false });
});
t("[A5] 모르는 하네스는 claude 로 추측하지 않는다 — read/answer 둘 다 false, 어댑터 null", () => {
  assert.deepEqual(chatIoCaps(undefined), { read: false, answer: false, chatFirst: false });
  assert.deepEqual(chatIoCaps("nope"), { read: false, answer: false, chatFirst: false });
  assert.equal(harnessIo("nope"), null); assert.equal(harnessIo(""), null);
  assert.ok(harnessIo("CLAUDE"), "대소문자는 무시(키는 소문자 규약)");
});
t("[A6] claude 승인 키 — approve=Enter · deny/interrupt=Escape (Claude Code 대화상자 실측)", () => {
  const c = harnessIo("claude")!;
  assert.equal(c.answer!("approve"), "Enter"); assert.equal(c.answer!("deny"), "Escape"); assert.equal(c.answer!("interrupt"), "Escape");
  assert.equal(harnessIo("grok")!.answer, null); assert.equal(harnessIo("antigravity")!.answer, null);
});
t("[A7] 규약 경로(pathFor) — claude·grok·antigravity 는 (cwd, convId)로 만들 수 있다 · 잡 id 는 null", () => {
  assert.equal(harnessIo("claude")!.pathFor!("/r", { cwd: "/Users/a/.x/w", convId: "u-1" }), "/r/-Users-a--x-w/u-1.jsonl");
  assert.equal(harnessIo("grok")!.pathFor!("/r", { cwd: "/Users/a/w", convId: "019f" }), "/r/%2FUsers%2Fa%2Fw/019f/updates.jsonl");
  assert.equal(harnessIo("antigravity")!.pathFor!("/r", { cwd: "/w", convId: "abcd" }), "/r/abcd/.system_generated/logs/transcript_full.jsonl");
  assert.equal(harnessIo("claude")!.pathFor!("/r", { cwd: "/w", convId: "../etc" }), null);
  assert.equal(harnessIo("grok")!.pathFor!("/r", { cwd: "/w", convId: "a/b" }), null);
  assert.equal(harnessIo("antigravity")!.pathFor!("/r", { cwd: "", convId: "" }), null);
  assert.equal(harnessIo("codex")!.pathFor, null, "codex 는 파일 이름에 시각이 들어 규약으로 못 만든다");
});
t("[A8] 세션 공유(중앙 캡처) 선택지는 '읽을 수 있는 하네스'에서 파생된다 + codex(종전 선택지) 유지 · opencode 는 밖", () => {
  for (const k of READABLE_HARNESSES) assert.ok(KNOWN_HARNESSES.includes(k), `KNOWN_HARNESSES 에 ${k} 없음`);
  assert.ok(KNOWN_HARNESSES.includes("codex"));
  assert.ok(!KNOWN_HARNESSES.includes("opencode"), "파서 없는 opencode 는 선택지 밖('못 지킬 켜기' 금지)");
});
t("[A9] 동작 어휘 — approve|deny|interrupt 만", () => {
  assert.equal(isChatAction("approve"), true); assert.equal(isChatAction("deny"), true); assert.equal(isChatAction("interrupt"), true);
  assert.equal(isChatAction("Enter"), false); assert.equal(isChatAction(""), false); assert.equal(isChatAction(undefined), false);
});

console.log(`harness-io/adapter: ${pass} passed`);
