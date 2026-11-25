// 지식 상세(knowledge_get) 핸들러의 형식 신호 배선 테스트 — 조회를 갈아 끼워(_setKnowledgeGetDepsForTest) DB 없이 핸들러째 돌린다.
//
//  readStyleHint·knowledgeGetResult 의 단위 시험(read-style.test.ts)은 핸들러가 넘기는 값(staged · 고쳐도 되는가)을 믿고 돈다.
//  그 값을 만드는 배선이 틀어지면 단위 시험은 초록인 채로 신호가 틀린다.
//  회귀 대상 ①: 검토 대기 제안을 조회하지 않거나 staged 를 넘기지 않아, edit 가 409 로 막힌 글에 «고쳐라» 가 실리는 것.
//  회귀 대상 ②: 쓰기 게이트 · 읽기전용 세션 · 앱 도구 범위를 안 보고, 고칠 수 없는 사람에게 «고쳐라» 가 실리는 것.
//  회귀 대상 ③: 다른 사람이 방금 고친 글을 고치게 하는 것 — 보호 창(isRecentlyEdited)과 «내 마지막 저장» 판정
//   (updated_by 가 같고 confidence='ai'). 같은 계정이라도 사람의 웹 편집은 남의 편집으로 본다.
import assert from "node:assert/strict";
import { knowledgeGet, editedByOtherRecently, _setKnowledgeGetDepsForTest } from "./read.js";
import type { ReadStyleHint } from "../writing-style.js";
import { isRecentlyEdited, RECENT_EDIT_MS } from "../../v6/writing-rewrite-gate.js";
import { resolveWritingFormat } from "../../org/policies/writing-format.js";
import type { KnowledgeRow } from "../../v6/knowledge-store.js";
import type { KnowledgeRevisionRow } from "../../v6/knowledge-revision-store.js";
import type { LivelyUser } from "../../context.js";
import type { CapabilityCtx } from "../types.js";

const NOW = Date.parse("2026-11-20T00:00:00Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
let pass = 0;
const failed: string[] = [];
// 실패해도 다음 시험을 계속 돌려 한 번에 다 보인다 — 끝에서 실패가 있으면 종료 코드 1.
const ta = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try {
    await fn();
    pass++;
    console.log(`ok  ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`FAIL  ${name}\n      ${String((e as Error)?.message ?? e).split("\n").slice(0, 4).join("\n      ")}`);
  }
};

// ── 보호 창(isRecentlyEdited) — 자동 정리 배치 · 형식 정리 저장 · 읽기 신호가 같은 판정을 쓴다 ──
await ta("보호 창: 24시간 안이면 최근이고, 넘었으면 아니다(정확히 24시간 전은 창 밖)", () => {
  assert.equal(isRecentlyEdited(iso(NOW - HOUR), NOW), true);
  assert.equal(isRecentlyEdited(iso(NOW - 25 * HOUR), NOW), false);
  assert.equal(isRecentlyEdited(iso(NOW - RECENT_EDIT_MS + 1), NOW), true);
  assert.equal(isRecentlyEdited(iso(NOW - RECENT_EDIT_MS), NOW), false);
});
await ta("보호 창: 시각을 못 읽거나 없으면 최근으로 본다(보수적으로 막는다)", () => {
  for (const bad of ["not a date", "", null, undefined]) assert.equal(isRecentlyEdited(bad, NOW), true, JSON.stringify(bad));
  assert.equal(isRecentlyEdited(new Date(NaN), NOW), true, "Invalid Date");
});
await ta("보호 창: Date 로 온 시각과 Date 로 준 now 도 같은 판정이다", () => {
  assert.equal(isRecentlyEdited(new Date(NOW - HOUR), NOW), true);
  assert.equal(isRecentlyEdited(new Date(NOW - 48 * HOUR), new Date(NOW)), false);
  assert.equal(isRecentlyEdited(iso(NOW - HOUR), new Date(NOW)), true);
});

// ── «내 마지막 저장» — 같은 계정의 에이전트(MCP) 저장만 내 것이다 ──
await ta("내 마지막 저장: 같은 계정의 에이전트 저장(confidence='ai')이면 방금 고쳤어도 남의 편집이 아니다", () => {
  assert.equal(editedByOtherRecently({ updated_at: iso(NOW - HOUR), updated_by: "u1", confidence: "ai" }, "u1", NOW), false);
});
await ta("내 마지막 저장: 같은 계정이라도 사람의 웹 편집(confidence='human')이면 남의 편집이다", () => {
  assert.equal(editedByOtherRecently({ updated_at: iso(NOW - HOUR), updated_by: "u1", confidence: "human" }, "u1", NOW), true);
});
await ta("내 마지막 저장: 다른 계정 · 신원 없는 호출 · 시각 불명은 남의 편집이고, 창 밖이면 누구 것이든 아니다", () => {
  assert.equal(editedByOtherRecently({ updated_at: iso(NOW - HOUR), updated_by: "kim", confidence: "ai" }, "u1", NOW), true);
  assert.equal(editedByOtherRecently({ updated_at: iso(NOW - HOUR), updated_by: null, confidence: "ai" }, null, NOW), true);
  assert.equal(editedByOtherRecently({ updated_at: undefined, updated_by: "kim", confidence: "human" }, "u1", NOW), true);
  assert.equal(editedByOtherRecently({ updated_at: iso(NOW - 30 * HOUR), updated_by: "kim", confidence: "human" }, "u1", NOW), false);
  assert.equal(editedByOtherRecently({ updated_at: new Date(NOW - 30 * HOUR), updated_by: "kim", confidence: "human" }, "u1", NOW), false);
});

// ── 핸들러 배선 ──
const on = async () => resolveWritingFormat({ enabled: true });
type Doc = KnowledgeRow & { categories: unknown[] };
const doc = (over: Partial<KnowledgeRow> = {}): Doc => ({
  name: "deploy-note", title: "🔴 배포 규칙 (2026-09-23)", body_md: "## 배경\n\n오늘 배포했다.",
  injection: "recalled", provenance: "authored", lifecycle: "active", confidence: "human", source: "manual",
  summary: null, sort: 0, is_wiki: false, searchable: true, is_folder: false, version: 3,
  updated_at: iso(NOW - 30 * 24 * HOUR), updated_by: "kim", categories: [], ...over,
});
const rev = (mode: KnowledgeRevisionRow["mode"]): KnowledgeRevisionRow => ({
  id: 7, name: "deploy-note", mode, status: "pending", base_version: 3, base_title: null, base_body_md: null, base_confidence: null,
  new_title: null, new_body_md: "", new_summary: null, new_type: null, proposed_by: "kim", actor_kind: "human", agent: null,
  rule_id: null, note: null, created_at: iso(NOW - HOUR), updated_at: iso(NOW - HOUR), reviewed_by: null, reviewed_at: null, edits: 1,
});
const USER: LivelyUser = { userId: "u1", email: "u1@example.com", scopes: ["memory"], projects: ["*"] };
// 세션 밖 REST 호출 — 찾기 기록(logKnowledgeSearch)을 타지 않는다.
const CTX: CapabilityCtx = { source: "web", actor: "u1", viewer: "u1" };
let current: Doc = doc();
let pending: KnowledgeRevisionRow | undefined;
let writable = true;
const pendingAsked: string[] = [];
const writableAsked: string[] = [];
const reset = (over: Partial<KnowledgeRow> = {}): void => {
  current = doc(over); pending = undefined; writable = true; pendingAsked.length = 0; writableAsked.length = 0;
};
const restore = _setKnowledgeGetDepsForTest({
  assertInAppContext: async () => {},
  canSee: async () => true,
  get: async (name: string) => (name === current.name ? current : undefined),
  pendingRevision: async (name: string) => { pendingAsked.push(name); return pending; },
  writable: async (name: unknown) => { writableAsked.push(String(name)); return writable; },
  loadFormat: on,
  now: () => NOW,
});
type Resp = { style?: ReadStyleHint; pending_revision?: { mode?: string }; body_range?: { returned: number }; knowledge?: KnowledgeRow };
const get = async (input: { offset?: number; limit?: number } = {}, user: LivelyUser = USER, ctx: CapabilityCtx = CTX): Promise<Resp> =>
  (await knowledgeGet.handler({ name: "deploy-note", ...input }, user, ctx)) as Resp;
const FIX_NOW = /지금 [^.]*고친다/;

await ta("검토 대기 제안이 staged 면 핸들러가 그 조회로 형식 신호를 뺀다(배너는 싣는다)", async () => {
  reset();
  pending = rev("staged");
  const r = await get();
  assert.deepEqual(pendingAsked, ["deploy-note"], "핸들러가 이 지식의 검토 대기 제안을 조회해야 한다");
  assert.equal(r.pending_revision?.mode, "staged", "검토 대기 배너가 실려야 한다");
  assert.ok(!("style" in r), `staged 면 edit 가 409 라 형식 신호를 싣지 않는다: ${JSON.stringify(r.style)}`);
});
await ta("검토 대기가 applied 면 형식 신호를 싣는다(대조군 — staged 판정은 mode 를 본다)", async () => {
  reset();
  pending = rev("applied");
  const r = await get();
  assert.equal(r.pending_revision?.mode, "applied");
  assert.ok(r.style && r.style.count > 0, JSON.stringify(r));
});
await ta("고칠 수 있는 사람이면 고치라고 하고, 쓰기 게이트는 이 지식 이름으로 묻는다", async () => {
  reset();
  const r = await get();
  assert.ok(r.style, JSON.stringify(r));
  assert.equal(r.style.edit_blocked, undefined);
  assert.match(r.style.note, FIX_NOW);
  assert.deepEqual(writableAsked, ["deploy-note"]);
});
await ta("위반이 없으면 쓰기 게이트를 묻지 않는다(깨끗한 글의 읽기에 조회를 더하지 않는다)", async () => {
  reset({ title: "배포 노트 범위", body_md: "노트는 직전 배포 이후 커밋을 싣는다." });
  const r = await get();
  assert.ok(!("style" in r));
  assert.deepEqual(writableAsked, []);
});
await ta("쓰기 게이트를 못 넘는 사람에게는 고치라고 하지 않는다", async () => {
  reset();
  writable = false;
  const r = await get();
  assert.equal(r.style?.edit_blocked, "no_write", JSON.stringify(r.style));
  assert.match(r.style!.note, /지금 고치지 않는다/);
  assert.doesNotMatch(r.style!.note, /mode='edit'/);
});
await ta("읽기전용 세션이면 고치라고 하지 않는다(knowledge_save 가 등록조차 안 된다)", async () => {
  reset();
  const r = await get({}, USER, { ...CTX, readOnly: true });
  assert.equal(r.style?.edit_blocked, "no_write", JSON.stringify(r.style));
});
await ta("도구 상한에 knowledge_save 가 없는 호출이면 고치라고 하지 않는다", async () => {
  reset();
  const r = await get({}, { ...USER, toolCeiling: ["knowledge_get"] });
  assert.equal(r.style?.edit_blocked, "no_write", JSON.stringify(r.style));
});
await ta("다른 사람이 24시간 안에 고친 글이면 고치라고 하지 않는다", async () => {
  reset({ updated_at: iso(NOW - HOUR), updated_by: "kim", confidence: "ai" });
  const r = await get();
  assert.equal(r.style?.edit_blocked, "recently_edited", JSON.stringify(r.style));
  assert.match(r.style!.note, /다른 사람이 최근 24시간 안에 고친 글/);
  assert.doesNotMatch(r.style!.note, FIX_NOW);
});
await ta("같은 계정의 에이전트가 방금 저장한 글이면 막지 않는다 — 저장 직후 형식 안내를 받고 고치는 기본 흐름", async () => {
  reset({ updated_at: iso(NOW - HOUR), updated_by: "u1", confidence: "ai" });
  const r = await get();
  assert.ok(r.style, JSON.stringify(r));
  assert.equal(r.style.edit_blocked, undefined);
  assert.match(r.style.note, FIX_NOW);
});
await ta("같은 계정이라도 사람이 웹에서 방금 고친 글이면 막는다", async () => {
  reset({ updated_at: iso(NOW - HOUR), updated_by: "u1", confidence: "human" });
  const r = await get();
  assert.equal(r.style?.edit_blocked, "recently_edited", JSON.stringify(r.style));
});
await ta("세션 주입 문구는 관리자가 읽어도 고치라고 하지 않는다", async () => {
  reset({ injection: "always" });
  const r = await get({}, { ...USER, scopes: ["memory", "admin"] });
  assert.equal(r.style?.edit_blocked, "injected", JSON.stringify(r.style));
  assert.doesNotMatch(r.style!.note, FIX_NOW);
});
await ta("부분읽기도 전문으로 판정하고, 고치기 전에 전문을 읽으라고 한다", async () => {
  reset();
  const r = await get({ offset: 1, limit: 1 });
  assert.equal(r.body_range?.returned, 1);
  assert.ok(r.style, JSON.stringify(r));
  assert.match(r.style.note, /offset·limit 없이 전문을 읽는다/);
});
restore();
console.log(`read-get-handler: ${pass} passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) process.exit(1);
