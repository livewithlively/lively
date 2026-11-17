// 서술 형식 검사의 capability 배선 테스트 — 지식·작업기록·프로젝트 저장이 공유한다.
//
//  회귀 대상 ①: 외부 미러(observed)·폴더에 안내가 실리는 것 — 고칠 수 없거나 본문이 없는 글이다.
//  회귀 대상 ②: 형식 조회·검사가 터졌을 때 저장이 실패하는 것 — 형식 검사는 부가 기능이라 fail-open 이다.
//  회귀 대상 ③: 기존 문서에 원래 있던 위반으로 에이전트의 수정·이어쓰기가 거부되는 것 — 거부는 새로 생긴 위반에만 건다.
//  회귀 대상 ④: 사람의 웹 편집이 거부되는 것, 반대로 토큰 스크립트가 사람으로 취급돼 거부를 비껴가는 것.
import assert from "node:assert/strict";
import { checkWriting, isHumanWriter, writingRejectError, rejectWriting } from "./writing-style.js";
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
  assert.deepEqual(await checkWriting("knowledge", BAD, {}, async () => resolveWritingFormat({})), { info: {}, rejects: [], guide: "" });
  assert.deepEqual(await checkWriting("knowledge", CLEAN, {}, on), { info: {}, rejects: [], guide: "" });
});
await ta("외부 미러와 폴더는 판정하지 않는다", async () => {
  assert.deepEqual(await checkWriting("knowledge", BAD, { observed: true }, rejEmoji), { info: {}, rejects: [], guide: "" });
  assert.deepEqual(await checkWriting("knowledge", BAD, { folder: true }, rejEmoji), { info: {}, rejects: [], guide: "" });
});
await ta("형식 조회가 실패하면 안내도 거부도 없다(throw 하지 않는다)", async () => {
  const boom = async (): Promise<never> => { throw new Error("db down"); };
  assert.deepEqual(await checkWriting("knowledge", BAD, {}, boom), { info: {}, rejects: [], guide: "" });
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
// 회귀 대상 ⑤: 고친 글에 옛 위반이 남아도 응답이 «다음부터 맞추라»로만 끝나 같은 글을 고치지 않는 것.
type Split = { style?: { introduced: string[]; legacy: string[]; note: string } };
await ta("수정 저장에 옛 위반만 남으면 legacy 로 짚고 같은 지식을 edit 로 다시 저장하라고 안내한다(거부는 없다)", async () => {
  const before = { title: "🔴 옛 제목", body: "옛 본문이다." };
  const r = await checkWriting("knowledge", { title: "🔴 새 제목", body: "새 본문이다." }, { before }, rejEmoji);
  const st = (r.info as Split).style!;
  assert.deepEqual(st.legacy, ["title_leading_emoji"]);
  assert.deepEqual(st.introduced, []);
  assert.match(st.note, /원래 있던 형식 위반 1건\(title_leading_emoji\)/);
  assert.match(st.note, /같은 지식을 mode='edit' 로 한 번 더 저장/);
  assert.match(st.note, /의미는 바꾸지 말고/);
  assert.deepEqual(r.rejects, []);
});
await ta("새 위반과 옛 위반이 섞이면 둘을 나누고, 거부는 새 위반 중 reject 수준에만 건다", async () => {
  const before = { title: "옛 제목", body: "옛 본문이다. /Users/someone/a.md 에 있다." };
  const f = fmt({ rules: { title_leading_emoji: "reject", local_path: "reject", relative_time: "warn" } });
  const r = await checkWriting("knowledge", { title: "🔴 새 제목", body: "새 본문이다. 오늘 고쳤다. /Users/someone/a.md 에 있다." }, { before }, f);
  const st = (r.info as Split).style!;
  assert.deepEqual(st.legacy, ["local_path"]);
  assert.ok(st.introduced.includes("title_leading_emoji") && st.introduced.includes("relative_time"), st.introduced.join(","));
  assert.ok(!st.introduced.includes("local_path"));
  assert.deepEqual(r.rejects.map((x) => x.rule), ["title_leading_emoji"]);
  assert.match(st.note, /원래 있던 형식 위반 1건\(local_path\)/);
});
await ta("before 가 없는 신규 저장은 legacy 가 비고 note 는 종전 문구 그대로다", async () => {
  const r = await checkWriting("knowledge", BAD, {}, rejEmoji);
  const st = (r.info as Split).style!;
  assert.deepEqual(st.legacy, []);
  assert.doesNotMatch(st.note, /원래 있던/);
  assert.equal(st.note, `이 조직의 서술 형식에 어긋난 곳이 ${(r.info as Style).style!.findings.length}건 있습니다(저장은 됐습니다). 본문은 mode='edit' 로 그 부분만, 제목은 knowledge_set_title 로 고치세요 — 전문을 다시 보낼 필요가 없습니다. 의미는 바꾸지 말고 형식만 고치세요.`);
});
await ta("새 위반만 있는 수정 저장도 note 는 종전 문구 그대로다", async () => {
  const r = await checkWriting("knowledge", BAD, { before: { title: "옛 제목", body: "옛 본문이다." } }, on);
  const st = (r.info as Split).style!;
  assert.deepEqual(st.legacy, []);
  assert.doesNotMatch(st.note, /원래 있던/);
});
await ta("사람의 수정 저장은 거부하지 않지만 옛 위반 안내는 그대로 나간다", async () => {
  const before = { title: "🔴 옛 제목", body: "옛 본문이다." };
  const r = await checkWriting("knowledge", { title: "🔴 새 제목", body: "새 본문이다." }, { before, human: true }, rejEmoji);
  assert.deepEqual(r.rejects, []);
  assert.deepEqual((r.info as Split).style!.legacy, ["title_leading_emoji"]);
  assert.match((r.info as Split).style!.note, /원래 있던 형식 위반/);
});
await ta("본문 없는 작업기록 규칙은 명시해야만 켜진다(default_level 을 물려받지 않는다)", async () => {
  assert.deepEqual(await checkWriting("activity", { title: "배포 스크립트 수정", body: null }, {}, fmt({ default_level: "reject" })), { info: {}, rejects: [], guide: "" });
});
await ta("작업기록 표면: 본문 없는 기록을 안내하고, 지식 전용 규칙은 보지 않는다", async () => {
  const { info } = await checkWriting("activity", { title: "배포 스크립트 수정", body: null }, {}, fmt({ rules: { activity_body_missing: "warn" } }));
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
  assert.deepEqual(await checkWriting("project", { title: null, body: "/Users/someone/a.md" }, {}, f), { info: {}, rejects: [], guide: "" });
});
await ta("거부 에러는 422 이고 메시지에 규칙·샘플·가이드를 담는다", async () => {
  const e = writingRejectError([{ rule: "title_date", level: "reject", message: "제목에 날짜를 넣지 마라.", sample: "배포 (2026-09-23)" }], "가이드 본문");
  assert.equal(e.status, 422);
  for (const re of [/저장하지 않았습니다/, /title_date/, /2026-09-23/, /가이드 본문/]) assert.match(e.message, re);
  assert.ok((e.body as { style?: unknown }).style);
});
await ta("사람 판정: 웹 로그인 세션만 사람이고, 앱이 대신 쓰거나 토큰이면 에이전트다", async () => {
  assert.equal(isHumanWriter({ tokenSource: "session" }), true);
  assert.equal(isHumanWriter({ tokenSource: "session", appId: "app-1" }), false);
  assert.equal(isHumanWriter({ tokenSource: "db" }), false);
  assert.equal(isHumanWriter({ tokenSource: "static" }), false);
  assert.equal(isHumanWriter(null), false);
});
const REJ = [{ rule: "title_date" as const, level: "reject" as const, message: "제목에 날짜를 넣지 마라.", sample: "배포 (2026-09-23)" }];
await ta("거부는 감사 로그에 표면·규칙·대상·제목을 남기고, 본문은 남기지 않는다", async () => {
  const calls: unknown[][] = [];
  const rec = (async (...args: unknown[]) => { calls.push(args); }) as unknown as Parameters<typeof rejectWriting>[6];
  const e = await rejectWriting("knowledge", "deploy-note", "배포 (2026-09-23)", REJ, "가이드", { actor: "m1", source: "mcp", tokenHashPrefix: "abc", ip: "10.0.0.1" }, rec);
  assert.equal(e.status, 422);
  assert.equal(calls.length, 1);
  const [entity, key, op, before, after, actor, source, meta] = calls[0] as [string, string, string, unknown, Record<string, unknown>, string, string, Record<string, unknown>];
  assert.deepEqual([entity, key, op, before, actor, source], ["writing_format", "deploy-note", "reject", null, "m1", "mcp"]);
  assert.deepEqual(after, { surface: "knowledge", rules: ["title_date"], title: "배포 (2026-09-23)" });
  assert.deepEqual(meta, { tokenHashPrefix: "abc", ip: "10.0.0.1" });
});
await ta("감사 기록의 제목은 80자에서 자른다", async () => {
  let after: Record<string, unknown> = {};
  const rec = (async (...args: unknown[]) => { after = args[4] as Record<string, unknown>; }) as unknown as Parameters<typeof rejectWriting>[6];
  await rejectWriting("project", null, "가".repeat(120), REJ, "", undefined, rec);
  assert.equal([...String(after.title)].length, 80);
});
await ta("감사 기록이 실패해도 거부 에러는 그대로 돌려준다", async () => {
  const boom = (async () => { throw new Error("db down"); }) as unknown as Parameters<typeof rejectWriting>[6];
  const e = await rejectWriting("activity", null, "t", REJ, "가이드", undefined, boom);
  assert.equal(e.status, 422);
  assert.match(e.message, /title_date/);
});
console.log(`writing-style: ${pass} passed`);
