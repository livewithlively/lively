// cursor 파서(cursor.ts) — 사양 §E 표 전수 (#4927). 표본 F 는 **Cursor 작성기 자신이 낸 줄**이다: 번들(cursor-agent 2026.10.19-6bbf2c4)
//  모듈 ../agent-transcript 의 U(메시지 → 줄)·H(턴 끝 줄)를 그대로 떼어 AI SDK 모양 메시지를 넣고 받은 출력을 옮겼다(지어내지 않았다).
//  실파일 실측 전이다 — 로그인한 Cursor 로 대화를 한 번 남기면 그 줄로 이 표본을 바꾼다.
import assert from "node:assert/strict";
import { parseCursor, cursorPathFor, cursorProjectSlug } from "./cursor.js";
import { harnessIo, READABLE_HARNESSES } from "./adapter.js";
import type { ChatLine } from "./chat-line.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const F = {
  //  user: 맥락 태그(<user_info>·<rules>)를 붙여 넣었더니 작성기가 걷어내고 사람 말만 남겼다.
  user: '{"role":"user","message":{"content":[{"type":"text","text":"whoami 를 호출해 내 id 만 답해."}]}}',
  userImg: '{"role":"user","message":{"content":[{"type":"text","text":"[Image]\\n이 그림 봐줘"}]}}',
  //  assistant: reasoning + text(<think> 포함) + tool-call 둘 → 생각은 본문 뒤에 붙고 <think> 는 걷혔다.
  asstMix: '{"role":"assistant","message":{"content":[{"type":"text","text":"확인한 뒤 호출하겠습니다.\\n\\nThe user wants whoami."},{"type":"tool_use","name":"Shell","input":{"command":"ls -la"}},{"type":"tool_use","name":"Read","input":{"path":"/w/a.txt"}}]}}',
  asstToolOnly: '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"x"}}]}}',
  asstRedacted: '{"role":"assistant","message":{"content":[{"type":"text","text":"끝났습니다.\\n\\n[REDACTED]"}]}}',
  oversize: '{"role":"assistant","message":{"content":[{"type":"text","text":"[Oversize transcript blob omitted: 6.2 MB]"}]}}',
  ok: '{"type":"turn_ended","status":"success"}',
  abort: '{"type":"turn_ended","status":"aborted"}',
  abortWhy: '{"type":"turn_ended","status":"aborted","error":"User cancelled"}',
  err: '{"type":"turn_ended","status":"error","error":"Rate limit exceeded"}',
  //  작성기가 요약을 만든 경우 맨 앞에 붙이는 줄(writeFromStateFull 의 metadata 래퍼)
  meta: '{"type":"metadata","metadata":{"overview":"요약"}}',
};
const run = (ls: string[], state = {}) => parseCursor(ls.join("\n") + "\n", state);
const blocks = (l: ChatLine): any[] => (l.type === "system" ? [] : (Array.isArray(l.message.content) ? l.message.content : [{ type: "text", text: l.message.content }]));
const toolIds = (ls: ChatLine[]): string[] => ls.flatMap((l) => blocks(l)).filter((b) => b.type === "tool_use").map((b) => b.id);

t("[E1] user 줄 → user ChatLine(본문 그대로) · 턴 열림", () => {
  const { lines, state } = run([F.user, F.userImg]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.type), ["user", "user"]);
  assert.equal(blocks(lines[0])[0].text, "whoami 를 호출해 내 id 만 답해.");
  assert.equal(blocks(lines[1])[0].text, "[Image]\n이 그림 봐줘");
  assert.equal(state.turnOpen, true);
});
t("[E2] assistant text + tool_use×2 → 한 줄 [text, tool_use, tool_use] · id 는 비지 않고 서로 다르다", () => {
  const { lines } = run([F.asstMix]);
  assert.equal(lines.length, 1);
  const b = blocks(lines[0]);
  assert.deepEqual(b.map((x) => x.type), ["text", "tool_use", "tool_use"]);
  assert.equal(b[0].text, "확인한 뒤 호출하겠습니다.\n\nThe user wants whoami.");
  assert.deepEqual([b[1].name, b[1].input], ["Shell", { command: "ls -la" }]);
  assert.deepEqual([b[2].name, b[2].input], ["Read", { path: "/w/a.txt" }]);
  const ids = toolIds(lines);
  assert.ok(ids.every((id) => typeof id === "string" && id.length > 0), "빈 id 금지");
  assert.equal(new Set(ids).size, ids.length, "id 중복 금지");
});
t("[E3] assistant tool_use 만 → [tool_use]", () => {
  const { lines } = run([F.asstToolOnly]);
  assert.deepEqual(blocks(lines[0]).map((x) => [x.type, x.name]), [["tool_use", "Grep"]]);
});
t("[E4] turn_ended — success=turn_duration(시간 없음) · aborted(±이유)=interrupted · error=error(원문 포함) · 턴 닫힘", () => {
  const { lines, state } = run([F.user, F.ok, F.abort, F.abortWhy, F.err]);
  const sys = lines.filter((l) => l.type === "system") as any[];
  assert.deepEqual(sys.map((l) => l.subtype), ["turn_duration", "interrupted", "interrupted", "error"]);
  assert.equal("durationMs" in sys[0], false, "작성기는 턴 시간을 안 쓴다 — 지어내지 않는다");
  assert.match(sys[3].text, /Rate limit exceeded/);
  assert.equal(state.turnOpen, false);
  //  error 가 객체로 와도 내용이 보인다(«[object Object]» 금지)
  const obj = run(['{"type":"turn_ended","status":"error","error":{"code":429,"message":"slow down"}}']).lines[0] as any;
  assert.match(obj.text, /slow down/);
  assert.doesNotMatch(obj.text, /\[object Object\]/);
});
t("[E5] 버리는 것 — metadata · 모르는 type · role tool/system · 깨진 줄 · 빈 content · 공백 text · 빈 줄", () => {
  const junk = [
    F.meta,
    '{"type":"future_thing","x":1}',
    '{"role":"tool","message":{"content":[{"type":"text","text":"결과"}]}}',
    '{"role":"system","message":{"content":[{"type":"text","text":"sys"}]}}',
    '{"role":"assistant","message":{"content":[]}}',
    '{"role":"assistant","message":{"content":[{"type":"text","text":"   "}]}}',
    '{"role":"user","message":{"content":[{"type":"tool_use","name":"x","input":{}}]}}',
    '{"role":"assistant","message":{"content":[{"type":"te',
    "",
  ];
  const { lines } = run(junk);
  assert.deepEqual(lines, []);
  //  같은 덩이에 정상 줄을 섞으면 정상 줄만 남는다(앞 잡음이 뒤 줄을 막지 않는다)
  assert.equal(run([...junk, F.user]).lines.length, 1);
});
t("[E6] 창을 나눠 읽어도 도구 id 가 겹치지 않는다 · 순번 부재(빈 state·남의 state·잡값)면 1 부터", () => {
  const a = run([F.asstMix]);
  const b = run([F.asstToolOnly, F.asstMix], a.state);
  const all = [...toolIds(a.lines), ...toolIds(b.lines)];
  assert.equal(all.length, 5);
  assert.equal(new Set(all).size, 5, `창 사이 id 충돌: ${all.join(",")}`);
  for (const st of [{}, { turnStartMs: 1, model: "grok-4.6" }, { toolSeq: "7" }, { toolSeq: Number.NaN }]) {
    const ids = toolIds(run([F.asstToolOnly], st).lines);
    assert.deepEqual(ids, ["cursor-tool-1"], `state=${JSON.stringify(st)}`);
  }
});
t("[E7] tool_use 의 input·name 이 없으면 {} · \"tool\"", () => {
  const { lines } = run(['{"role":"assistant","message":{"content":[{"type":"tool_use"}]}}']);
  assert.deepEqual([blocks(lines[0])[0].name, blocks(lines[0])[0].input], ["tool", {}]);
});
t("[E8] pathFor — <root>/<slug>/agent-transcripts/<id>/<id>.jsonl · 주입형 id · 빈/기호뿐 cwd 는 null", () => {
  const id = "0b6f2a1e-9c3d-4e5f-8a7b-1c2d3e4f5a6b";
  assert.equal(cursorPathFor("/h/.cursor/projects", { cwd: "/Users/me/my proj/", convId: id }),
    `/h/.cursor/projects/Users-me-my-proj/agent-transcripts/${id}/${id}.jsonl`);
  //  번들 slug 규칙: 영숫자 밖 → "-", 연속 "-" → 하나, 앞뒤 "-" 제거(한글도 영숫자 밖이다)
  assert.equal(cursorProjectSlug("/w/한글--a_b.c"), "w-a-b-c");
  for (const bad of ["../../etc/passwd", "a/b", "", "a b", ".hidden"]) {
    assert.equal(cursorPathFor("/r", { cwd: "/w", convId: bad }), null, `convId=${JSON.stringify(bad)}`);
  }
  for (const cwd of ["", "/", "///"]) assert.equal(cursorPathFor("/r", { cwd, convId: id }), null, `cwd=${JSON.stringify(cwd)}`);
});
t("[E9] content 가 문자열이어도(방어) 본문으로 읽는다", () => {
  const { lines } = run(['{"role":"user","message":{"content":"문자열 본문"}}', '{"role":"assistant","message":{"content":"답"}}']);
  assert.deepEqual(lines.map((l) => blocks(l)[0].text), ["문자열 본문", "답"]);
});
t("[E10] 모든 줄의 timestamp 는 \"\" — 작성기가 시각을 안 쓴다(지어내지 않는다)", () => {
  const { lines } = run([F.user, F.asstMix, F.asstRedacted, F.oversize, F.ok]);
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => l.timestamp === ""));
});
t("[배선] 어댑터 표가 이 파서를 쓴다 → 세션 로그 수집 선택지(READABLE)에 cursor 가 열린다", () => {
  const io = harnessIo("cursor")!;
  assert.equal(io.parse, parseCursor);
  assert.equal(io.pathFor, cursorPathFor);
  assert.ok(READABLE_HARNESSES.includes("cursor"));
  assert.deepEqual(io.roots(["/home/u"], "u"), ["/home/u/.cursor/projects"]);
});

console.log(`harness-io/cursor: ${pass} passed`);
