// #2122 — transcript_path 에서 대화 uuid 를 되읽는 순수 판정. 매핑 null 전파 창에서 정밀복원을 살리되,
//  '그 폴더의 최신 대화 추측'(routes.ts:1082 가 금지)과 섞이면 안 되므로 계약을 못박는다.
// 실행: npm run build && node dist/terminal/uuid-from-transcript.test.js
import assert from "node:assert/strict";
import { uuidFromTranscriptPath } from "./routes.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("claude 규약 경로의 stem = uuid 를 되읽는다", () => {
  assert.equal(
    uuidFromTranscriptPath("/home/box_x/.claude/projects/-work-shared-project-1937/01985b13-2b61-4851-bb9e-d9d1cf0fad2d.jsonl", "claude"),
    "01985b13-2b61-4851-bb9e-d9d1cf0fad2d",
  );
});

t("harness 미지정은 claude 로 취급(기본)", () => {
  assert.equal(
    uuidFromTranscriptPath("/x/9a0f069a-1b9a-464a-a5b0-e8b0cbf91620.jsonl", null),
    "9a0f069a-1b9a-464a-a5b0-e8b0cbf91620",
  );
});

t("claude 가 아니면 null — 파일명 규약이 다를 수 있다(추측 금지)", () => {
  assert.equal(uuidFromTranscriptPath("/x/01a0370e-de99-7421-b600-d65ea797c16e.jsonl", "codex"), null);
});

t("uuid 형태가 아니면 null — 임의 파일명을 uuid 로 오인하지 않는다", () => {
  assert.equal(uuidFromTranscriptPath("/x/rollout-2026-08-25.jsonl", "claude"), null);
  assert.equal(uuidFromTranscriptPath("/x/not-a-uuid.jsonl", "claude"), null);
  assert.equal(uuidFromTranscriptPath("/x/01985b13.jsonl", "claude"), null, "짧은 hex 도 아님");
});

t("확장자·빈값·null 방어", () => {
  assert.equal(uuidFromTranscriptPath("/x/01985b13-2b61-4851-bb9e-d9d1cf0fad2d.txt", "claude"), null, ".jsonl 아님");
  assert.equal(uuidFromTranscriptPath("", "claude"), null);
  assert.equal(uuidFromTranscriptPath(null, "claude"), null);
  assert.equal(uuidFromTranscriptPath(undefined, "claude"), null);
});

console.log(`\n${pass} passed`);
