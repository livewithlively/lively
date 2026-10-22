// #4697 T7 — 대화창이 질의 중 꺼진 세션에 보내는 답 문장(web/lib/stop-note.ts)을 서버 측정(src/sessions/outbox-measure.ts)이 알아보는가.
//  사양·엣지 표: 작업 스크래치 spec.md E9. 두 판이 따로 바뀌면(화면 문구만 다듬음) 측정이 **조용히 0 건**이 된다 — 빨간불로 잡는다.
//  서버는 DB 에서 글 머리(ANSWER_HEAD_CHARS 자)만 꺼내 판정하므로 같은 길이로 잘라 넣는다.
// 실행: 빌드 뒤 — 러너 `node scripts/run-tests.mjs --build`(public/app/lib/stop-note.js · dist/sessions/outbox-measure.js 를 부른다).
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = await import(pathToFileURL(path.join(ROOT, "public/app/lib/stop-note.js")).href);
const S = await import(pathToFileURL(path.join(ROOT, "dist/sessions/outbox-measure.js")).href);
const head = (t) => String(t).slice(0, S.ANSWER_HEAD_CHARS);

const ASK = { kind: "ask", items: [{ header: "색상", text: "가장 좋아하는 색은?", options: [{ n: 1, label: "빨강" }, { n: 2, label: "파랑" }], free: true }] };
const TWO = { kind: "ask", items: [
  { header: "색", text: "가장 좋아하는 색은?", options: [{ n: 1, label: "빨강" }] },
  { header: "과일", text: "가장 좋아하는 과일은?", options: [{ n: 1, label: "사과" }] },
] };
const PERM = { kind: "permission", target: "rm -rf build", items: [{ text: "Do you want to proceed?", options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] }] };
const PERM_NO_TARGET = { kind: "permission", items: [{ text: "Bash 명령을 실행할까요?", options: [{ n: 1, label: "Yes" }] }] };

test("E9 화면이 만든 답 문장은 전부 서버가 답으로 본다 — 선택 · 여러 질문 · 실행 허락(대상 있음·없음) · 직접 쓴 답", () => {
  const prompts = [
    W.stopAnswerPrompt(ASK, [{ labels: ["파랑"] }]),
    W.stopAnswerPrompt(TWO, [{ labels: ["빨강"] }, { labels: ["사과"] }]),
    W.stopAnswerPrompt(PERM, [{ labels: ["Yes"] }]),
    W.stopAnswerPrompt(PERM_NO_TARGET, [{ labels: ["Yes"] }]),
    W.stopFreeAnswerPrompt(ASK, "초록"),
    W.stopFreeAnswerPrompt(TWO, "둘 다 아무거나"),
  ];
  assert.equal(prompts.filter((p) => !p).length, 0, "화면 도우미가 빈 문장을 만들었다 — 이 시험의 입력이 틀렸다");
  for (const p of prompts) assert.equal(S.isStopAnswerText(head(p)), true, `서버가 못 알아본 답 문장: ${p.split("\n")[0]}`);
});
test("E9b 사람이 평소에 쓰는 말은 답 문장으로 보지 않는다(화면 도우미를 거치지 않은 글)", () => {
  for (const t of ["앞서 말한 대로 진행해 줘", "파랑", "계속"]) assert.equal(S.isStopAnswerText(head(t)), false, t);
});
