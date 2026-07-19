// 세션이력 웹뷰 렌더 파서(#905 C1 슬⑤b) 단위검증 — renderTranscript 는 순수라 파일·DB 없이 못박는다.
//  실행: npm run build && node dist/transcript-render.test.js
//  계약(채널필터): 사람 발화 + 어시스턴트 산문 + 툴콜 이름만 남기고, 툴결과·주입노이즈·메타는 버린다.
import assert from "node:assert/strict";
import { renderTranscript } from "./terminal-transcript.js";
import { firstUserPromptTitle } from "./v6/session-log-store.js";

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

// ── 제목 유도(firstUserPromptTitle) — 첫 사람 발화에서 제목(uuid 대신). 툴결과·주입·메타는 건너뛴다. ──
{
  // 첫 사람 발화가 제목.
  assert.equal(firstUserPromptTitle(J({ type: "user", message: { content: "프로젝트 상태 알려줘" } })), "프로젝트 상태 알려줘", "문자열 발화");
  assert.equal(firstUserPromptTitle(J({ type: "user", message: { content: [{ type: "text", text: "배열 발화" }] } })), "배열 발화", "배열 발화");
  // 주입/툴결과/어시스턴트는 건너뛰고 첫 '진짜' 사람 발화를 찾는다.
  const mixed = [
    J({ type: "user", message: { content: "<system-reminder>노이즈</system-reminder>" } }),   // 주입 → skip
    J({ type: "user", message: { content: [{ type: "tool_result", content: "..." }] } }),        // 툴결과 → skip
    J({ type: "assistant", message: { content: [{ type: "text", text: "안녕하세요" }] } }),       // AI → skip
    J({ type: "user", message: { content: "진짜 질문입니다" } }),
  ].join("\n");
  assert.equal(firstUserPromptTitle(mixed), "진짜 질문입니다", "주입·툴결과·AI 건너뛰고 첫 사람 발화");
  // 사람 발화 없음 → null.
  assert.equal(firstUserPromptTitle(J({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } })), null, "사람 발화 없으면 null");
  // 아주 길면 120자로 자른다.
  const longQ = firstUserPromptTitle(J({ type: "user", message: { content: "가".repeat(300) } }));
  assert.ok(longQ && longQ.length <= 121 && longQ.endsWith("…"), "긴 발화는 120자+… 로 절단");
  ok("제목 유도 — 첫 사람 발화(주입·툴결과·AI 제외) · 없으면 null · 장문 절단");
}

// ── 취소된 턴(esc) — 보낸 질문 + 부분답변을 버리고 재작성본만 남긴다(사용자 요청) ──
{
  const jsonl = [
    J({ type: "user", message: { content: "첫 질문(취소될 것)" } }),
    J({ type: "assistant", message: { content: [{ type: "text", text: "부분 답변…" }] } }),
    J({ type: "user", message: { content: "[Request interrupted by user]" } }),   // esc
    J({ type: "user", message: { content: "다시 쓴 질문" } }),
    J({ type: "assistant", message: { content: [{ type: "text", text: "제대로 답변" }] } }),
  ].join("\n");
  const items = renderTranscript(jsonl);
  assert.deepEqual(items.map((i) => i.text), ["다시 쓴 질문", "제대로 답변"],
    "취소된 질문·부분답변은 사라지고 재작성본만");
  ok("취소된 턴(질문+부분답변) 폐기 → 재작성본만 남음");
}

// ── 중단표식이 '이미 끝난 앞 턴'을 지우면 안 된다 — 사이에 다른 사용자 행동(bash 등)이 있으면 경계 ──
{
  const jsonl = [
    J({ type: "user", message: { content: "완료된 질문" } }),
    J({ type: "assistant", message: { content: [{ type: "text", text: "완결된 답변" }] } }),
    J({ type: "user", message: { content: "<bash-input>ls</bash-input>" } }),       // 다른 행동 → 앞 턴 종료 경계
    J({ type: "user", message: { content: "[Request interrupted by user]" } }),     // 이 esc 는 bash 를 끊은 것
    J({ type: "user", message: { content: "다음 질문" } }),
  ].join("\n");
  const items = renderTranscript(jsonl);
  assert.deepEqual(items.map((i) => i.text), ["완료된 질문", "완결된 답변", "다음 질문"],
    "완료된 앞 턴은 보존(중단표식이 bash 뒤라 앞 턴을 안 지운다)");
  ok("중단표식 앞에 다른 사용자 행동이 있으면 완료 턴 보존");
}

// ── 답변 시작 전 취소 — 질문만 있고 바로 esc → 그 질문도 버린다 ──
{
  const jsonl = [
    J({ type: "user", message: { content: "바로 취소할 질문" } }),
    J({ type: "user", message: { content: "[Request interrupted by user]" } }),
    J({ type: "user", message: { content: "진짜 질문" } }),
  ].join("\n");
  assert.deepEqual(renderTranscript(jsonl).map((i) => i.text), ["진짜 질문"], "답변 전 취소된 질문도 폐기");
  ok("답변 시작 전 취소 → 질문 폐기");
}

console.log(`\n${pass} passed`);
