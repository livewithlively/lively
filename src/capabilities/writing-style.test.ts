// 서술 형식 검사의 capability 배선 테스트 — 지식·작업기록·프로젝트 저장이 공유한다.
//
//  회귀 대상 ①: 외부 미러(observed)·폴더에 안내가 실리는 것 — 고칠 수 없거나 본문이 없는 글이다.
//  회귀 대상 ②: 형식 조회·검사가 터졌을 때 저장이 실패하는 것 — 형식 검사는 부가 기능이라 fail-open 이다.
//  회귀 대상 ③: 기존 문서에 원래 있던 위반으로 에이전트의 수정·이어쓰기가 거부되는 것 — 거부는 새로 생긴 위반에만 건다.
//  회귀 대상 ④: 사람의 웹 편집이 거부되는 것, 반대로 토큰 스크립트가 사람으로 취급돼 거부를 비껴가는 것.
import assert from "node:assert/strict";
import { checkWriting, writingRejectError } from "./writing-style.js";
import { resolveWritingFormat } from "../org/policies/writing-format.js";

const fmt = (raw: Record<string, unknown>) => async () => resolveWritingFormat({ enabled: true, ...raw });
const on = fmt({});
const rejEmoji = fmt({ rules: { title_leading_emoji: "reject" } });
const BAD = { title: "🔴 배포 규칙 (2026-09-23)", body: "## 배경\n\n오늘 배포했다." };
const CLEAN = { title: "배포 노트 범위", body: "노트는 직전 배포 이후 커밋을 싣는다." };
type Style = { style?: { findings: Array<{ rule: string; level: string }>; note: string; guide_md: string } };
let pass = 0;
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

await ta("위반이 있으면 findings·note·guide 를 싣는다", async () => {
  const { info, rejects } = await checkWriting("knowledge", BAD, {}, on);
  const st = (info as Style).style!;
  for (const want of ["title_leading_emoji", "title_date", "lead_missing", "relative_time"]) assert.ok(st.findings.some((f) => f.rule === want), want);
  assert.match(st.note, /mode='edit'/);
  assert.ok(st.guide_md.length > 0);
  assert.deepEqual(rejects, [], "warn 만 있으면 거부 없음");
});
await ta("형식이 꺼져 있거나 위반이 없으면 아무것도 싣지 않는다", async () => {
  assert.deepEqual(await checkWriting("knowledge", BAD, {}, async () => resolveWritingFormat({})), { info: {}, rejects: [] });
  assert.deepEqual(await checkWriting("knowledge", CLEAN, {}, on), { info: {}, rejects: [] });
});
await ta("외부 미러와 폴더는 판정하지 않는다", async () => {
  assert.deepEqual(await checkWriting("knowledge", BAD, { observed: true }, rejEmoji), { info: {}, rejects: [] });
  assert.deepEqual(await checkWriting("knowledge", BAD, { folder: true }, rejEmoji), { info: {}, rejects: [] });
});
await ta("형식 조회가 실패하면 안내도 거부도 없다(throw 하지 않는다)", async () => {
  const boom = async (): Promise<never> => { throw new Error("db down"); };
  assert.deepEqual(await checkWriting("knowledge", BAD, {}, boom), { info: {}, rejects: [] });
});
await ta("수정 제안으로 접수된 저장엔 edit 대신 재저장을 안내한다", async () => {
  const { info } = await checkWriting("knowledge", BAD, { proposed: true }, on);
  assert.doesNotMatch((info as Style).style!.note, /mode='edit'/);
  assert.match((info as Style).style!.note, /다시 저장/);
});
await ta("reject 규칙 위반은 에이전트 저장의 거부 사유가 된다(reject 수준만)", async () => {
  const { rejects } = await checkWriting("knowledge", BAD, {}, rejEmoji);
  assert.deepEqual(rejects.map((f) => f.rule), ["title_leading_emoji"]);
});
await ta("사람의 웹 편집은 거부하지 않고 안내만 한다", async () => {
  const { info, rejects } = await checkWriting("knowledge", BAD, { human: true }, rejEmoji);
  assert.deepEqual(rejects, []);
  assert.ok((info as Style).style!.findings.some((f) => f.rule === "title_leading_emoji" && f.level === "reject"));
});
await ta("기존 글에 원래 있던 위반은 거부하지 않는다(새로 생긴 위반만)", async () => {
  const before = { title: "🔴 옛 제목", body: "옛 본문이다." };
  assert.deepEqual((await checkWriting("knowledge", BAD, { before }, rejEmoji)).rejects, []);
  const cleanBefore = { title: "옛 제목", body: "옛 본문이다." };
  assert.equal((await checkWriting("knowledge", BAD, { before: cleanBefore }, rejEmoji)).rejects.length, 1);
});
await ta("작업기록 표면: 본문 없는 기록을 안내하고, 지식 전용 규칙은 보지 않는다", async () => {
  const { info } = await checkWriting("activity", { title: "배포 스크립트 수정", body: null }, {}, on);
  const rules = (info as Style).style!.findings.map((f) => f.rule);
  assert.deepEqual(rules, ["activity_body_missing"]);
  const r2 = await checkWriting("activity", { title: "배포 (2026-09-23)", body: "## 변경\n오늘 고쳤다." }, {}, on);
  const rules2 = ((r2.info as Style).style?.findings ?? []).map((f) => f.rule);
  assert.ok(rules2.includes("relative_time"));
  assert.ok(!rules2.includes("title_date") && !rules2.includes("lead_missing"), rules2.join(","));
});
await ta("작업기록 제목은 작업기록 한도로 본다", async () => {
  const t81 = "가".repeat(81);
  const r = await checkWriting("activity", { title: t81, body: "고쳤다." }, {}, on);
  assert.ok(((r.info as Style).style?.findings ?? []).some((f) => f.rule === "title_length"));
  const r2 = await checkWriting("activity", { title: "가".repeat(80), body: "고쳤다." }, {}, on);
  assert.deepEqual(r2.info, {});
});
await ta("프로젝트 표면: 목표·범위 골격은 첫 줄 결론을 요구하지 않는다", async () => {
  const r = await checkWriting("project", { title: null, body: "## 목표\n배포를 자동화한다." }, {}, on);
  assert.deepEqual(r.info, {});
  const r2 = await checkWriting("project", { title: null, body: "## 목표\n원본은 /Users/someone/a.md 에 있다." }, {}, on);
  assert.ok(((r2.info as Style).style?.findings ?? []).some((f) => f.rule === "local_path"));
});
await ta("apply_to 에서 뺀 표면은 판정하지 않는다", async () => {
  const f = fmt({ apply_to: ["knowledge"], rules: { local_path: "reject" } });
  assert.deepEqual(await checkWriting("project", { title: null, body: "/Users/someone/a.md" }, {}, f), { info: {}, rejects: [] });
});
await ta("거부 에러는 422 이고 메시지에 규칙·샘플·가이드를 담는다", async () => {
  const e = writingRejectError([{ rule: "title_date", level: "reject", message: "제목에 날짜를 넣지 마라.", sample: "배포 (2026-09-23)" }], "가이드 본문");
  assert.equal(e.status, 422);
  for (const re of [/저장하지 않았습니다/, /title_date/, /2026-09-23/, /가이드 본문/]) assert.match(e.message, re);
  assert.ok((e.body as { style?: unknown }).style);
});
console.log(`writing-style: ${pass} passed`);
