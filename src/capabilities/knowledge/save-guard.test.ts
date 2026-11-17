// knowledge_save 의 덮어쓰기 안전장치 테스트 — 버전 대조(expected_version)와 형식 정리 저장(style_fix).
//
//  회귀 대상 ①: «형식만 고친다»는 에이전트 저장이 수치·링크를 바꿔도 통과하는 것.
//  회귀 대상 ②: style_fix 가 아닌 정상 내용 수정·사람 편집까지 불변식에 막히는 것.
//  회귀 대상 ③: 다른 사람이 방금 고친 글을 형식 정리가 덮는 것.
//  회귀 대상 ④: 읽은 뒤 바뀐 지식을 expected_version 대조 없이 덮는 것.
import assert from "node:assert/strict";

import { assertExpectedVersion, assertStyleFixSafe, type SaveGuardBefore } from "./save-guard.js";
import { knowledgeSave } from "./authoring.js";
import { RECENT_EDIT_MS } from "../../v6/writing-rewrite-gate.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const thrown = (fn: () => void): { status?: number; message: string; body?: Record<string, any> } | null => {
  try { fn(); return null; } catch (e) { const x = e as any; return { status: x.status, message: String(x.message), body: x.body }; }
};

const NOW = Date.parse("2026-10-05T00:00:00Z");
const OLD = new Date(NOW - RECENT_EDIT_MS - 60_000).toISOString();
const RECENT = new Date(NOW - 60 * 60 * 1000).toISOString();
const before = (over: Partial<SaveGuardBefore> = {}): SaveGuardBefore => ({
  title: "🔴 배포 규칙",
  body_md: "배포는 **3회** 재시도한 뒤 멈춘다.\n\n- 대기 시간은 30초다.\n- 근거는 [[deploy-runbook]] 이다.",
  version: 7, updated_at: OLD, updated_by: "alice", ...over,
});
const FORMAT_ONLY = { title: "배포 규칙", body_md: "배포는 3회 재시도한 뒤 멈춘다.\n\n- 대기 시간은 30초다.\n- 근거는 [[deploy-runbook]] 이다." };
const NUMBER_CHANGED = { title: "배포 규칙", body_md: "배포는 5회 재시도한 뒤 멈춘다.\n\n- 대기 시간은 30초다.\n- 근거는 [[deploy-runbook]] 이다." };
const agent = { human: false, actor: "bob", now: NOW };

// ── style_fix: 의미 보존 불변식 ──
t("style_fix 에이전트 저장이 숫자 하나를 바꾸면 422 이고, 깨진 불변식 이름을 담는다", () => {
  const e = thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: before(), after: NUMBER_CHANGED }));
  assert.equal(e?.status, 422, JSON.stringify(e));
  assert.match(e!.message, /invariant:numbers/);
  assert.equal(e!.body?.style_fix?.rejected, "invariants");
  assert.ok(e!.body?.style_fix?.violations.some((v: { kind: string }) => v.kind === "invariant:numbers"));
});
t("style_fix 에이전트 저장이 링크를 빠뜨려도 422 다", () => {
  const e = thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: before(), after: { ...FORMAT_ONLY, body_md: FORMAT_ONLY.body_md.replace("[[deploy-runbook]]", "런북") } }));
  assert.equal(e?.status, 422);
  assert.match(e!.message, /invariant:wikilinks/);
});
t("형식만 고친 style_fix 저장은 통과한다", () => {
  assert.equal(thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: before(), after: FORMAT_ONLY })), null);
});
t("같은 내용 수정을 style_fix 없이 보내면 통과한다(정상 내용 수정은 막지 않는다)", () => {
  assert.equal(thrown(() => assertStyleFixSafe({ ...agent, styleFix: undefined, before: before(), after: NUMBER_CHANGED })), null);
  assert.equal(thrown(() => assertStyleFixSafe({ ...agent, styleFix: false, before: before({ updated_at: RECENT }), after: NUMBER_CHANGED })), null);
});
t("사람 작성자의 style_fix 에는 불변식·보호 창을 걸지 않는다", () => {
  assert.equal(thrown(() => assertStyleFixSafe({ ...agent, human: true, styleFix: true, before: before({ updated_at: RECENT }), after: NUMBER_CHANGED })), null);
});
t("신규 저장(원문 없음)의 style_fix 는 대조할 게 없어 통과한다", () => {
  assert.equal(thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: null, after: NUMBER_CHANGED })), null);
});

// ── style_fix: 사람 편집 보호 창 ──
t("다른 사람이 24시간 안에 고친 지식의 style_fix 저장은 409 로 거부하고 사유를 담는다", () => {
  const e = thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: before({ updated_at: RECENT }), after: FORMAT_ONLY }));
  assert.equal(e?.status, 409, JSON.stringify(e));
  assert.match(e!.message, /24시간/);
  assert.equal(e!.body?.style_fix?.rejected, "recently_edited");
});
t("편집이 보호 창보다 오래됐으면 통과한다", () => {
  assert.equal(thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: before({ updated_at: OLD }), after: FORMAT_ONLY })), null);
});
t("편집 시각을 못 읽으면 최근 편집으로 보고 거부한다", () => {
  assert.equal(thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: before({ updated_at: null }), after: FORMAT_ONLY }))?.status, 409);
});
t("마지막 저장이 같은 계정의 에이전트 저장이면 보호 창을 걸지 않는다(방금 쓴 글의 형식 안내를 바로 고치는 흐름)", () => {
  const own = before({ updated_at: RECENT, updated_by: "bob", confidence: "ai" });
  assert.equal(thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: own, after: FORMAT_ONLY })), null);
  // 본인이어도 불변식은 그대로 건다.
  assert.equal(thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: own, after: NUMBER_CHANGED }))?.status, 422);
});
t("같은 계정이라도 마지막 저장이 사람 웹 편집(confidence human)이면 보호 창을 건다", () => {
  for (const confidence of ["human", null, undefined]) {
    const e = thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: before({ updated_at: RECENT, updated_by: "bob", confidence }), after: FORMAT_ONLY }));
    assert.equal(e?.status, 409, String(confidence));
  }
});
t("원문에 제목이 없으면 고친 글에도 제목을 요구하지 않는다", () => {
  const untitled = before({ title: null });
  assert.equal(thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: untitled, after: { title: undefined, body_md: untitled.body_md } })), null);
  // 원문에 제목이 있으면 비운 제목은 여전히 위반이다.
  assert.match(thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: before(), after: { title: "", body_md: FORMAT_ONLY.body_md } }))?.message ?? "", /empty-title/);
});
t("Date 객체로 온 updated_at 도 같은 기준으로 판정한다(pg 드라이버가 timestamptz 를 Date 로 준다)", () => {
  assert.equal(thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: before({ updated_at: new Date(RECENT) }), after: FORMAT_ONLY }))?.status, 409);
  assert.equal(thrown(() => assertStyleFixSafe({ ...agent, styleFix: true, before: before({ updated_at: new Date(OLD) }), after: FORMAT_ONLY })), null);
});

// ── expected_version(CAS) ──
t("expected_version 이 지금 판과 다르면 409 이고 지금 판을 담는다", () => {
  const e = thrown(() => assertExpectedVersion(before(), 6));
  assert.equal(e?.status, 409);
  assert.equal(e!.body?.current_version, 7);
  assert.equal(e!.body?.expected_version, 6);
  assert.match(e!.message, /지금 판 7/);
});
t("expected_version 이 같거나 없으면 통과한다", () => {
  assert.equal(thrown(() => assertExpectedVersion(before(), 7)), null);
  assert.equal(thrown(() => assertExpectedVersion({ version: "7" }, 7)), null, "pg 가 문자열로 준 판도 숫자로 대조한다");
  assert.equal(thrown(() => assertExpectedVersion(before(), undefined)), null);
  assert.equal(thrown(() => assertExpectedVersion(null, undefined)), null);
});
t("없는 지식에 expected_version 을 보내면 409(current_version=null)다", () => {
  const e = thrown(() => assertExpectedVersion(null, 1));
  assert.equal(e?.status, 409);
  assert.equal(e!.body?.current_version, null);
});

// ── 입력 표면 ──
t("MCP 입력 스키마에 style_fix·expected_version 이 있고 설명이 붙어 있다", () => {
  const input = knowledgeSave.input as Record<string, { description?: string; safeParse: (v: unknown) => { success: boolean } }>;
  assert.match(String(input.style_fix?.description), /형식/);
  assert.match(String(input.expected_version?.description), /409/);
  assert.equal(input.expected_version.safeParse(0).success, false);
  assert.equal(input.expected_version.safeParse(3).success, true);
  assert.match(knowledgeSave.description, /style_fix:true 와 읽을 때의 expected_version/);
  assert.match(knowledgeSave.description, /knowledge_set_title 로 먼저 고쳤으면 판이 올랐으니 다시 읽은 version/);
});
const parse = (body: Record<string, unknown>) => {
  const mount = (knowledgeSave.expose as { rest: Array<{ parse: (req: unknown) => Record<string, unknown> }> }).rest[0];
  return mount.parse({ body: { name: "k", body_md: "본문이다.", ...body }, params: {}, query: {}, headers: {} });
};
t("REST 도 style_fix·expected_version 을 핸들러로 넘기고, 정수가 아닌 판은 400 으로 막는다", () => {
  const r = parse({ style_fix: true, expected_version: "3" });
  assert.equal(r.style_fix, true);
  assert.equal(r.expected_version, 3);
  const none = parse({});
  assert.equal(none.style_fix, undefined);
  assert.equal(none.expected_version, undefined);
  for (const bad of ["abc", 1.5, 0]) assert.equal(thrown(() => { parse({ expected_version: bad }); })?.status, 400, String(bad));
});
t("REST 의 style_fix 는 boolean 만 받는다", () => {
  assert.equal(parse({ style_fix: false }).style_fix, false);
  for (const bad of ["true", 1, null, {}]) {
    const e = thrown(() => { parse({ style_fix: bad }); });
    assert.equal(e?.status, 400, String(bad));
    assert.match(e!.message, /style_fix/);
  }
});

{
  // append 는 DB 를 읽기 전에 거른다 — 순서가 퇴행하면 DB 가드·조회 오류가 400 자리에 나와 이 단언이 깨진다.
  const user = { userId: "t-style", email: "t@x", scopes: ["admin"] } as never;
  let err: { status?: number; message?: string } | null = null;
  try { await knowledgeSave.handler({ name: "k", mode: "append", body_md: "덧붙임이다.", style_fix: true } as never, user, { source: "mcp" } as never); }
  catch (e) { err = e as { status?: number; message?: string }; }
  assert.equal(err?.status, 400, JSON.stringify(err?.message));
  assert.match(String(err?.message), /replace·edit/);
  pass++; console.log("ok  append 에 style_fix 를 보내면 DB 조회 전에 400 이다");
}
console.log(`save-guard: ${pass} passed`);
