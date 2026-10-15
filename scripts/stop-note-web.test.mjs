// 하네스를 끄기 전에 남긴 쪽지(#4695 T5)를 대화창이 되돌리는 순수 도우미(web/lib/stop-note.ts)의 계약.
//  틀리면 티가 크다:
//   🔴 모르는 모양의 쪽지를 그리면 — 서버가 판을 바꾼 날 대화창이 깨진 질문 카드를 띄운다.
//   🔴 답 문장에 질문을 안 붙이면 — 다시 띄운 AI 는 그 질문을 모른다(claude 는 질문이 대화 파일에 안 남는다 — 실측 3/3).
//   🔴 쓰던 글이 영원히 남으면 — 몇 주 뒤 그 세션을 열 때 낡은 글이 입력칸에 튀어나온다.
// 실행: npm run build:web 뒤 — 러너 `node scripts/run-tests.mjs --build`(빌드 산출 public/app/lib/stop-note.js 를 부른다).
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const N = await import(pathToFileURL(path.join(ROOT, "public/app/lib/stop-note.js")).href);

/** 브라우저 저장소 대역 — 쓴 것을 그대로 들여다본다. */
function memStore() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const ASK = { kind: "ask", items: [{ header: "색상", text: "가장 좋아하는 색은?", options: [{ n: 1, label: "빨강" }, { n: 2, label: "파랑" }], free: true }] };
const TAIL = "(이 세션은 질문에 답을 기다리다 꺼졌다가 다시 열렸어요. 위 답을 반영해 하던 일을 이어서 해 주세요.)";

test("W1 쪽지 모양이 아니면 null — 그리지 않는다", () => {
  for (const v of [null, undefined, 3, "x", {}, { at: "1", why: "done" }, { at: 1, why: "lost" }, { why: "done" }]) assert.equal(N.stopNoteOf(v), null, JSON.stringify(v));
  assert.deepEqual(N.stopNoteOf({ at: 1, why: "done", harness: "claude" }), { at: 1, why: "done", harness: "claude" });
});
test("W2 쪽지 다듬기 — 빈 글·빈 질문·빈 선택지는 버리고, 모르는 질문 종류는 other", () => {
  const n = N.stopNoteOf({
    at: 5, why: "asking", harness: "claude", draft: "   ",
    question: { kind: "weird", items: [{ text: "", options: [] }, { text: "고르세요", options: [{ n: 1, label: " " }, { n: 2, label: "가" }], multi: 1 }, 7], target: "", reappears: false },
  });
  assert.deepEqual(n, { at: 5, why: "asking", harness: "claude", question: { kind: "other", items: [{ text: "고르세요", options: [{ n: 2, label: "가" }], multi: true }] } });
  assert.equal(N.stopNoteOf({ at: 5, why: "asking", harness: "x", question: { kind: "ask", items: [] } }).question, undefined, "질문이 비면 질문이 없다");
  assert.equal(N.stopNoteOf({ at: 5, why: "done", harness: "x", draft: "보낼 말" }).draft, "보낼 말");
});
test("W3 왜 꺼져 있나 — 세 까닭이 서로 다른 한 줄이다", () => {
  const lines = ["done", "asking", "exited"].map((why) => N.stopNoteWhy({ at: 1, why, harness: "claude" }));
  assert.equal(new Set(lines).size, 3);
  for (const l of lines) assert.ok(l.length > 5);
});
test("W4 답 문장 — «앞서 물은 ‹질문›에 대한 답: ‹선택›» + AI 가 이어 할 일 한 줄", () => {
  assert.equal(N.stopAnswerPrompt(ASK, [{ labels: ["파랑"] }]), `앞서 물은 ‹가장 좋아하는 색은?›에 대한 답: ‹파랑›\n${TAIL}`);
});
test("W5 승인 질문 — 실행 대상이 있으면 그것을 이름으로 «앞서 실행 허락을 물은 ‹대상›에 대한 답»", () => {
  const q = { kind: "permission", target: "touch /work/demo/a.txt", items: [{ header: "Bash command", text: "Do you want to proceed?", options: [{ n: 1, label: "Yes" }, { n: 4, label: "No" }] }] };
  assert.equal(N.stopAnswerPrompt(q, [{ labels: ["Yes"] }]).split("\n")[0], "앞서 실행 허락을 물은 ‹touch /work/demo/a.txt›에 대한 답: ‹Yes›");
  const noTarget = { ...q, target: undefined };
  assert.equal(N.stopAnswerPrompt(noTarget, [{ labels: ["No"] }]).split("\n")[0], "앞서 실행 허락을 물은 ‹Do you want to proceed?›에 대한 답: ‹No›");
});
test("W6 여러 개 고르기 · 직접 쓴 답은 쉼표로 잇는다 · 질문 이름은 질문 글의 마지막 줄 → 없으면 머리", () => {
  const q = { kind: "ask", items: [{ header: "과일", text: "", options: [{ n: 1, label: "사과" }, { n: 2, label: "배" }], multi: true }] };
  assert.equal(N.stopAnswerPrompt(q, [{ labels: ["사과", "배"], free: " 감도 " }]).split("\n")[0], "앞서 물은 ‹과일›에 대한 답: ‹사과, 배, 감도›");
  const two = { kind: "ask", items: [{ text: "설명 줄\n진짜 질문은?", options: [{ n: 1, label: "예" }] }] };
  assert.equal(N.stopAnswerPrompt(two, [{ labels: ["예"] }]).split("\n")[0], "앞서 물은 ‹진짜 질문은?›에 대한 답: ‹예›");
});
test("W7 고른 답이 하나도 없으면 빈 문자열(보내지 않는다)", () => {
  assert.equal(N.stopAnswerPrompt(ASK, []), "");
  assert.equal(N.stopAnswerPrompt(ASK, [{ labels: [" "], free: "  " }]), "");
});
test("W8 여러 질문 중 답한 것만 싣는다", () => {
  const q = { kind: "ask", items: [ASK.items[0], { header: "과일", text: "과일은?", options: [{ n: 1, label: "사과" }] }] };
  assert.equal(N.stopAnswerPrompt(q, [{ labels: [] }, { labels: ["사과"] }]), `앞서 물은 ‹과일은?›에 대한 답: ‹사과›\n${TAIL}`);
});
test("W9 질문 카드가 떠 있을 때 입력칸에 직접 쓴 답 — 질문 하나면 그 질문의 답으로, 여럿이면 질문들을 나열해 붙인다", () => {
  assert.equal(N.stopFreeAnswerPrompt(ASK, " 초록 "), `앞서 물은 ‹가장 좋아하는 색은?›에 대한 답: ‹초록›\n${TAIL}`);
  const q = { kind: "ask", items: [ASK.items[0], { header: "과일", text: "과일은?", options: [] }] };
  assert.equal(N.stopFreeAnswerPrompt(q, "둘 다 아무거나").split("\n")[0], "앞서 물은 질문(‹가장 좋아하는 색은?› · ‹과일은?›)에 대한 답: ‹둘 다 아무거나›");
  assert.equal(N.stopFreeAnswerPrompt(ASK, "   "), "");
});
test("W10 입력칸의 쓰던 글은 세션별로 남는다 — 14일 넘으면 버리고, 빈 글은 지우고, 상한에서 자른다", () => {
  const s = memStore();
  const T = 1_800_000_000_000;
  N.saveComposeDraft("box-a", "쓰던 말", T, s);
  N.saveComposeDraft("box-b", "다른 세션", T, s);
  assert.equal(N.loadComposeDraft("box-a", T + 1000, s), "쓰던 말");
  assert.equal(N.loadComposeDraft("box-b", T + 1000, s), "다른 세션", "세션마다 따로다");
  assert.equal(N.loadComposeDraft("box-a", T + N.COMPOSE_KEEP_MS, s), "쓰던 말", "정확히 14일은 아직 남는다");
  assert.equal(N.loadComposeDraft("box-a", T + N.COMPOSE_KEEP_MS + 1, s), "");
  assert.equal(s.m.has("lv-compose:box-a"), false, "낡은 글은 저장소에서도 지운다");
  N.saveComposeDraft("box-b", "  \n ", T, s);
  assert.equal(s.m.has("lv-compose:box-b"), false, "빈 글을 저장하면 지운다");
  N.saveComposeDraft("box-c", "가".repeat(N.COMPOSE_MAX_CHARS + 50), T, s);
  assert.equal(N.loadComposeDraft("box-c", T, s).length, N.COMPOSE_MAX_CHARS);
  s.m.set("lv-compose:box-d", "{깨진");
  assert.equal(N.loadComposeDraft("box-d", T, s), "", "깨진 값은 없는 것으로");
  const broken = { getItem: () => { throw new Error("막힘"); }, setItem: () => { throw new Error("막힘"); }, removeItem: () => { throw new Error("막힘"); } };
  assert.doesNotThrow(() => N.saveComposeDraft("box-e", "x", T, broken));
  assert.equal(N.loadComposeDraft("box-e", T, broken), "", "저장소가 막히면 조용히 종전대로");
});
test("W11 쓰다 만 글을 돌려 둔 쪽지는 기억한다 — 같은 쪽지(끈 시각)만, 다른 쪽지는 다시 채운다", () => {
  const s = memStore();
  assert.equal(N.stopDraftSeen("box-a", 100, s), false);
  N.markStopDraftSeen("box-a", 100, s);
  assert.equal(N.stopDraftSeen("box-a", 100, s), true);
  assert.equal(N.stopDraftSeen("box-a", 200, s), false, "다음에 끈 쪽지는 새 쪽지다");
  assert.equal(N.stopDraftSeen("box-b", 100, s), false);
});
