// 조각으로 찾기(#5204) 유닛 시험 — 측정한 소환 질의 · 스니펫 꼴을 잠근다. DB 쪽은 knowledge-chunk-search.pg-test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { chunkSnippet, iterativeScanSupported, recallQueryText } from "./knowledge-chunk-search.js";

test("소환 질의 — 100자 미만이면 앞 턴 300자를 앞에 붙인다", () => {
  assert.equal(recallQueryText("응 그걸로", "앞 턴"), "앞 턴\n응 그걸로");
  assert.equal(recallQueryText("가".repeat(100), "앞 턴"), "가".repeat(100));
  assert.equal(recallQueryText("응", "나".repeat(400)), `${"나".repeat(300)}\n응`);
});

test("소환 질의 — 앞 턴이 없거나 비면 프롬프트만 · 앞 1,000자", () => {
  assert.equal(recallQueryText("응 그걸로", null), "응 그걸로");
  assert.equal(recallQueryText("응 그걸로", "  "), "응 그걸로");
  assert.equal(recallQueryText("가".repeat(1500), null).length, 1000);
  assert.equal(recallQueryText("  앞뒤 공백  ", undefined), "앞뒤 공백");
});

test("소환 질의 — 자를 때 서로게이트 쌍을 가르지 않는다", () => {
  assert.equal(recallQueryText(`${"가".repeat(999)}😀`, null), "가".repeat(999));
  assert.equal(recallQueryText("응", `${"나".repeat(299)}😀`), `${"나".repeat(299)}\n응`);
});

test("반복 탐색은 pgvector 0.8 부터", () => {
  for (const [v, want] of [["0.7.4", false], ["0.8.0", true], ["0.8.6", true], ["0.10.0", true], ["1.0.0", true], ["0.5", false], ["", false], [null, false], ["이상한 값", false]] as const) {
    assert.equal(iterativeScanSupported(v), want, String(v));
  }
});

test("스니펫 — grep 과 같은 L<n>: 꼴 · 화면의 줄 표시 떼기에 걸린다", () => {
  const s = chunkSnippet({ start_line: 12, path: "배포 › 순서", body: "첫 줄\n\n둘째   줄" });
  assert.equal(s, "L12: «배포 › 순서» 첫 줄 둘째 줄");
  assert.equal(s.replace(/L\d+:\s*/g, ""), "«배포 › 순서» 첫 줄 둘째 줄");
});

test("스니펫 — 경로가 없으면 글만 · 길이 상한", () => {
  assert.equal(chunkSnippet({ start_line: 1, path: "", body: "글" }), "L1: 글");
  assert.equal(chunkSnippet({ start_line: 1, path: "", body: "가".repeat(500) }).length, "L1: ".length + 160);
  assert.ok(chunkSnippet({ start_line: 1, path: "경".repeat(200), body: "글" }).length < 80);
});
