// knowledge_save 응답의 서술 형식 안내(style) 테스트.
//
//  회귀 대상 ①: 외부 미러(observed)·폴더에 안내가 실리는 것 — 고칠 수 없거나 본문이 없는 글이다.
//  회귀 대상 ②: 형식 조회·검사가 터졌을 때 저장 응답이 실패하는 것 — 저장은 이미 끝났으므로 안내만 빠져야 한다.
import assert from "node:assert/strict";
import { writingStyleInfo } from "./authoring.js";
import { resolveWritingFormat } from "../../org/policies/writing-format.js";

const on = async () => resolveWritingFormat({ enabled: true });
const off = async () => resolveWritingFormat({});
const BAD = { title: "🔴 배포 규칙 (2026-09-23)", body: "## 배경\n\n오늘 배포했다." };
let pass = 0;
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

await ta("형식을 켠 조직에서 위반이 있으면 findings·note·guide 를 싣는다", async () => {
  const r = await writingStyleInfo(BAD.title, BAD.body, { observed: false, folder: false }, on) as { style?: { findings: Array<{ rule: string }>; note: string; guide_md: string } };
  assert.ok(r.style, "style 이 있어야 한다");
  const rules = r.style.findings.map((f) => f.rule);
  for (const want of ["title_leading_emoji", "title_date", "lead_missing", "relative_time"]) assert.ok(rules.includes(want), want);
  assert.match(r.style.note, /mode='edit'/);
  assert.ok(r.style.guide_md.length > 0);
});
await ta("형식이 꺼져 있으면 아무것도 싣지 않는다", async () => {
  assert.deepEqual(await writingStyleInfo(BAD.title, BAD.body, { observed: false, folder: false }, off), {});
});
await ta("위반이 없으면 아무것도 싣지 않는다", async () => {
  assert.deepEqual(await writingStyleInfo("배포 노트 범위", "노트는 직전 배포 이후 커밋을 싣는다.", { observed: false, folder: false }, on), {});
});
await ta("외부 미러(observed)는 안내하지 않는다", async () => {
  assert.deepEqual(await writingStyleInfo(BAD.title, BAD.body, { observed: true, folder: false }, on), {});
});
await ta("폴더는 안내하지 않는다", async () => {
  assert.deepEqual(await writingStyleInfo(BAD.title, "", { observed: false, folder: true }, on), {});
});
await ta("형식 조회가 실패하면 안내만 빠진다(throw 하지 않는다)", async () => {
  const boom = async (): Promise<never> => { throw new Error("db down"); };
  assert.deepEqual(await writingStyleInfo(BAD.title, BAD.body, { observed: false, folder: false }, boom), {});
});
console.log(`writing-style-info: ${pass} passed`);
