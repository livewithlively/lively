// 세션이력 웹뷰 렌더 파서(#905 C1 슬⑤b) 단위검증 — renderTranscript 는 순수라 파일·DB 없이 못박는다.
//  실행: npm run build && node dist/transcript-render.test.js
//  계약(채널필터): 사람 발화 + 어시스턴트 산문 + 툴콜 이름만 남기고, 툴결과·주입노이즈·메타는 버린다.
import assert from "node:assert/strict";
import { renderTranscript } from "./terminal-transcript.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const J = (o: unknown) => JSON.stringify(o);

// ── 사람 발화: 문자열/배열 모두 추출, 툴결과·주입은 제외 ──
{
  const jsonl = [
    J({ type: "user", message: { content: "안녕하세요" }, timestamp: "t1" }),
    J({ type: "user", message: { content: [{ type: "text", text: "배열 발화" }] }, timestamp: "t2" }),
    J({ type: "user", message: { content: [{ type: "tool_result", content: "결과..." }] } }),  // 툴결과 → 제외
    J({ type: "user", message: { content: "<system-reminder>노이즈</system-reminder>" } }),      // 주입 → 제외
  ].join("\n");
  const items = renderTranscript(jsonl);
  assert.deepEqual(items.map((i) => i.role), ["user", "user"], "사람 발화 2건만(툴결과·주입 제외)");
  assert.deepEqual(items.map((i) => i.text), ["안녕하세요", "배열 발화"]);
  assert.equal(items[0].ts, "t1", "타임스탬프 보존");
  ok("사람 발화 — 문자열·배열 추출, 툴결과·주입 제외");
}

// ── 어시스턴트: 산문 텍스트 + 툴콜(이름+요약) ──
{
  const jsonl = J({
    type: "assistant",
    message: { content: [
      { type: "text", text: "이렇게 하겠습니다" },
      { type: "tool_use", name: "Bash", input: { command: "npm test", description: "테스트" } },
      { type: "tool_use", name: "Read", input: { file_path: "/a/b.ts" } },
    ] },
    timestamp: "t3",
  });
  const items = renderTranscript(jsonl);
  assert.deepEqual(items.map((i) => i.role), ["assistant", "tool", "tool"]);
  assert.equal(items[0].text, "이렇게 하겠습니다");
  assert.equal(items[1].tool, "Bash");
  assert.equal(items[1].text, "npm test", "툴 요약은 command 우선");
  assert.equal(items[2].text, "/a/b.ts", "툴 요약은 file_path 우선");
  ok("어시스턴트 — 산문 + 툴콜(이름+입력요약)");
}

// ── 메타·사이드체인·깨진 줄 제외 ──
{
  const jsonl = [
    J({ type: "user", message: { content: "메타" }, isMeta: true }),
    J({ type: "assistant", message: { content: [{ type: "text", text: "사이드" }] }, isSidechain: true }),
    "{ 깨진 json",
    J({ type: "user", message: { content: "정상" } }),
  ].join("\n");
  const items = renderTranscript(jsonl);
  assert.deepEqual(items.map((i) => i.text), ["정상"], "메타·사이드체인·깨진 줄 전부 제외");
  ok("메타·사이드체인·깨진 JSON 제외");
}

// ── limit 준수 ──
{
  const many = Array.from({ length: 10 }, (_, i) => J({ type: "user", message: { content: `q${i}` } })).join("\n");
  assert.equal(renderTranscript(many, 3).length, 3, "limit 초과분은 자른다");
  ok("limit 준수");
}

// ── 긴 툴 입력은 잘린다 ──
{
  const long = "x".repeat(500);
  const items = renderTranscript(J({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: long } }] } }));
  assert.ok(items[0].text.length <= 141 && items[0].text.endsWith("…"), "긴 툴 입력은 잘리고 … 표시");
  ok("긴 툴 입력 절단");
}

console.log(`\n${pass} passed`);
