// knowledge_save 응답의 서술 형식 안내(style) 테스트.
//
//  회귀 대상 ①: 외부 미러(observed)·폴더에 안내가 실리는 것 — 고칠 수 없거나 본문이 없는 글이다.
//  회귀 대상 ②: 형식 조회·검사가 터졌을 때 저장 응답이 실패하는 것 — 저장은 이미 끝났으므로 안내만 빠져야 한다.
import assert from "node:assert/strict";
import { writingStyleInfo, writingRejects, writingRejectError } from "./authoring.js";
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
await ta("수정 제안으로 접수된 저장엔 edit 대신 재저장을 안내한다", async () => {
  const r = await writingStyleInfo(BAD.title, BAD.body, { observed: false, folder: false, proposed: true }, on) as { style?: { note: string } };
  assert.ok(r.style);
  assert.doesNotMatch(r.style.note, /mode='edit'/);
  assert.match(r.style.note, /다시 저장/);
});
const rejOn = async () => resolveWritingFormat({ enabled: true, rules: { title_leading_emoji: "reject" } });
await ta("reject 로 정한 규칙은 에이전트(mcp) 저장에서 거부 대상이 된다", async () => {
  const st = await writingStyleInfo(BAD.title, BAD.body, { observed: false, folder: false }, rejOn);
  const r = writingRejects(st, "mcp");
  assert.deepEqual(r.map((f) => f.rule), ["title_leading_emoji"], "reject 수준만, warn 은 제외");
});
await ta("출처를 모르는 호출도 거부 대상이다(사람 웹 편집만 예외)", async () => {
  const st = await writingStyleInfo(BAD.title, BAD.body, { observed: false, folder: false }, rejOn);
  assert.equal(writingRejects(st, undefined).length, 1);
  assert.equal(writingRejects(st, "app-ui").length, 1);
});
await ta("사람의 웹 편집은 거부하지 않는다", async () => {
  const st = await writingStyleInfo(BAD.title, BAD.body, { observed: false, folder: false }, rejOn);
  assert.deepEqual(writingRejects(st, "web"), []);
});
await ta("warn 만 있으면 거부하지 않는다", async () => {
  const st = await writingStyleInfo(BAD.title, BAD.body, { observed: false, folder: false }, on);
  assert.deepEqual(writingRejects(st, "mcp"), []);
});
await ta("거부 에러는 422 이고 메시지에 규칙·샘플·가이드를 담는다", async () => {
  const e = writingRejectError([{ rule: "title_date", level: "reject", message: "제목에 날짜를 넣지 마라.", sample: "배포 (2026-09-23)" }], "가이드 본문");
  assert.equal(e.status, 422);
  assert.match(e.message, /저장하지 않았습니다/);
  assert.match(e.message, /title_date/);
  assert.match(e.message, /2026-09-23/);
  assert.match(e.message, /가이드 본문/);
  assert.ok((e.body as { style?: unknown }).style);
});
console.log(`writing-style-info: ${pass} passed`);
