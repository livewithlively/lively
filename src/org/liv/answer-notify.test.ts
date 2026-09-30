// #4180 리브의 답 알림 — 순수 판정(어떤 전이가 답인가 · 어떤 세션이 리브인가 · 무엇을 발췌하나)을 못박는다.
//
// ── 엣지 표 ──
//  A1 busy→idle 은 답이다 · A2 busy→waiting 도 답(물음)이다
//  A3 idle→busy(시작)·idle→idle(하트비트)·(없음)→idle 은 답이 아니다
//  L1 작업 폴더 이름이 liv 면 리브 세션 · L2 이름이 «리브 — 대화» 또는 킥오프 이름이면 리브 세션
//  L3 폴더가 liv 가 아닌 다른 이름이면(이름도 아니면) 리브가 아니다 · L4 윈도 경로·끝 슬래시도 같은 판정
//  X1 마지막 assistant 의 text 블록만 발췌(도구 호출·생각은 건너뛴다) · X2 서브에이전트 가지(isSidechain)는 건너뛴다
//  X3 assistant 줄이 없으면 빈 문자열 · X4 200자에서 자른다
//  W1 물음(waiting)이면 «리브가 물어요», 답(idle)이면 «리브가 답했어요» · W2 발췌가 비면 리브 탭 안내 문장
import { strict as assert } from "node:assert";
import test from "node:test";
import { isLivAnswerTransition, lastAssistantExcerpt, livAnswerText, looksLikeLivSession } from "./answer-notify.js";
import type { ChatBlock, ChatLine } from "../../terminal/harness-io/chat-line.js";

test("A1·A2 답인 전이 / A3 답이 아닌 전이", () => {
  assert.equal(isLivAnswerTransition({ prev: "busy", phase: "idle", at: 1 }), true);
  assert.equal(isLivAnswerTransition({ prev: "busy", phase: "waiting", at: 1 }), true);
  assert.equal(isLivAnswerTransition({ prev: "idle", phase: "busy", at: 1 }), false);
  assert.equal(isLivAnswerTransition({ prev: "idle", phase: "idle", at: 1 }), false);
  assert.equal(isLivAnswerTransition({ prev: null, phase: "idle", at: 1 }), false);
  assert.equal(isLivAnswerTransition(null), false);
});

test("L1~L4 리브 세션 판정", () => {
  assert.equal(looksLikeLivSession({ dir: "/home/box_jang/liv" }), true);
  assert.equal(looksLikeLivSession({ dir: "/home/box_jang/liv/" }), true);
  assert.equal(looksLikeLivSession({ dir: "C:\\Users\\jang\\liv" }), true);
  assert.equal(looksLikeLivSession({ dir: "/home/box_jang/project/4135", label: "9/22 UI 수정" }), false);
  assert.equal(looksLikeLivSession({ label: "리브 — 대화" }), true);
  assert.equal(looksLikeLivSession({ label: "리브 — 처음 설정 점검" }), true);
  assert.equal(looksLikeLivSession({ label: "리브에게 물어볼 것 정리" }), false);
  assert.equal(looksLikeLivSession({}), false);
});

const A = (blocks: ChatBlock[], side = false): ChatLine =>
  ({ type: "assistant", timestamp: "2026-09-23T00:00:00Z", message: { role: "assistant", content: blocks }, ...(side ? { isSidechain: true } : {}) });
const U = (text: string): ChatLine => ({ type: "user", timestamp: "2026-09-23T00:00:00Z", message: { role: "user", content: text } });

test("X1 마지막 assistant 의 text 만 — 도구 호출·생각은 건너뛴다", () => {
  const lines: ChatLine[] = [
    U("수집기 상태 봐줘"),
    A([{ type: "text", text: "먼저 볼게요." }]),
    A([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
    A([{ type: "thinking", thinking: "…" }, { type: "text", text: "수집기 3개가 " }, { type: "text", text: "돌고 있어요." }]),
  ];
  assert.equal(lastAssistantExcerpt(lines), "수집기 3개가 돌고 있어요.");
});

test("X2 서브에이전트 가지는 건너뛴다 · X3 없으면 빈 문자열 · X4 200자", () => {
  const side = A([{ type: "text", text: "가지의 글" }], true);
  assert.equal(lastAssistantExcerpt([A([{ type: "text", text: "본 줄기" }]), side]), "본 줄기");
  assert.equal(lastAssistantExcerpt([U("질문만")]), "");
  const long = lastAssistantExcerpt([A([{ type: "text", text: "가".repeat(300) }])]);
  assert.equal(long.length, 201);
  assert.ok(long.endsWith("…"));
});

test("W1·W2 문구", () => {
  assert.deepEqual(livAnswerText("idle", "다 됐어요."), { title: "리브가 답했어요", body: "다 됐어요." });
  assert.deepEqual(livAnswerText("waiting", ""), { title: "리브가 물어요", body: "리브 탭에서 답을 골라 주세요." });
  assert.deepEqual(livAnswerText("idle", ""), { title: "리브가 답했어요", body: "리브 탭에서 답을 볼 수 있어요." });
});
