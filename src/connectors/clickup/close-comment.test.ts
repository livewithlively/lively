// clickup close-comment 순수 함수 테스트 — 사양 기반(구현 블라인드).
//   실행: npx tsc -p . && node dist/connectors/clickup/close-comment.test.js
//   대상:
//     (1) CLOSED_CATEGORIES — 닫힘 카테고리 집합 {"done","canceled"}
//     (2) closeNoteOf — open→closed 전이에서만 노트 생성, reason trim/절단, actor/source/at 반영
//     (3) closeCommentText — 카테고리별 1행 + 근거행(우선순위) + 처리자행(mcp 접미) + 딥링크행
//     (4) sessionCloseReason(../../v6/session-task.js) — reason 우선, 없으면 sessionId 포함 폴백
//   라이브 DB 불요 — 입력→출력만 검증. session-task.js 는 import 자체가 로드시 실패할 수 있어 try/catch 격리.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  CLOSED_CATEGORIES,
  closeNoteOf,
  closeCommentText,
  type CloseNote,
} from "./close-comment.js";

// ────────────────────────────────────────────────────────────────────────
// 1) CLOSED_CATEGORIES — 정확히 {"done","canceled"}
// ────────────────────────────────────────────────────────────────────────
assert.strictEqual(CLOSED_CATEGORIES.size, 2, "닫힘 카테고리는 정확히 2개");
assert.ok(CLOSED_CATEGORIES.has("done"), "done 은 닫힘 카테고리");
assert.ok(CLOSED_CATEGORIES.has("canceled"), "canceled 은 닫힘 카테고리");
assert.ok(!CLOSED_CATEGORIES.has("backlog"), "backlog 은 닫힘 카테고리 아님");
assert.ok(!CLOSED_CATEGORIES.has("cancelled"), "영국식 철자는 포함되지 않음(정확한 철자만)");
assert.ok(!CLOSED_CATEGORIES.has("started"), "started 는 닫힘 카테고리 아님");

// ────────────────────────────────────────────────────────────────────────
// 2) closeNoteOf(before, after, ctx?, at?) → CloseNote | null
// ────────────────────────────────────────────────────────────────────────

const AT = new Date("2026-01-01T00:00:00.000Z");

// ── open → closed: 노트 생성 (여러 open 카테고리 이름으로) ──
{
  const n = closeNoteOf("backlog", "done", {}, AT);
  assert.ok(n, "open(backlog)→done 은 노트 생성");
  assert.strictEqual(n!.category, "done");
  assert.strictEqual(n!.at, "2026-01-01T00:00:00.000Z");
  assert.strictEqual(n!.reason, null, "ctx 없으면 reason null");
  assert.strictEqual(n!.actor, null, "ctx 없으면 actor null");
  assert.strictEqual(n!.source, null, "ctx 없으면 source null");
}
{
  const n = closeNoteOf("unstarted", "canceled", {}, AT);
  assert.ok(n, "open(unstarted)→canceled 은 노트 생성");
  assert.strictEqual(n!.category, "canceled");
}
{
  const n = closeNoteOf("started", "done", {}, AT);
  assert.ok(n, "open(started)→done 은 노트 생성");
}

// ── before 가 null/undefined 도 open 취급 ──
assert.ok(closeNoteOf(null, "done", {}, AT), "before=null → open 취급 → 노트 생성");
assert.ok(closeNoteOf(undefined, "canceled", {}, AT), "before=undefined → open 취급 → 노트 생성");

// ── before 가 이미 닫힘 → null (done/canceled 전 조합) ──
assert.strictEqual(closeNoteOf("done", "done", {}, AT), null, "done→done 은 null");
assert.strictEqual(closeNoteOf("done", "canceled", {}, AT), null, "done→canceled 은 null");
assert.strictEqual(closeNoteOf("canceled", "done", {}, AT), null, "canceled→done 은 null");
assert.strictEqual(closeNoteOf("canceled", "canceled", {}, AT), null, "canceled→canceled 은 null");

// ── after 가 닫힘이 아니면(open 이거나 null/undefined) 항상 null ──
assert.strictEqual(closeNoteOf("backlog", "started", {}, AT), null, "open→open 은 null");
assert.strictEqual(closeNoteOf("backlog", null, {}, AT), null, "after=null 은 null");
assert.strictEqual(closeNoteOf("backlog", undefined, {}, AT), null, "after=undefined 은 null");
assert.strictEqual(closeNoteOf("done", "backlog", {}, AT), null, "closed→open 도 after 기준으로 null");
assert.strictEqual(closeNoteOf("done", null, {}, AT), null, "closed→null 도 null");

// ── reason: trim, 빈/공백/부재 → null ──
assert.strictEqual(
  closeNoteOf("backlog", "done", { reason: "  실제 근거  " }, AT)!.reason,
  "실제 근거",
  "reason 은 trim 된다",
);
assert.strictEqual(closeNoteOf("backlog", "done", { reason: "" }, AT)!.reason, null, "빈 reason → null");
assert.strictEqual(closeNoteOf("backlog", "done", { reason: "   " }, AT)!.reason, null, "공백뿐 reason → null");
assert.strictEqual(closeNoteOf("backlog", "done", {}, AT)!.reason, null, "reason 부재 → null");
assert.strictEqual(closeNoteOf("backlog", "done", { reason: null }, AT)!.reason, null, "reason=null 명시도 null");

// ── reason 길이 경계: 1000 은 그대로, 1001 은 첫 1000자로 절단 ──
{
  const r1000 = "a".repeat(1000);
  const r1001 = "a".repeat(1001);
  const n1000 = closeNoteOf("backlog", "done", { reason: r1000 }, AT)!;
  const n1001 = closeNoteOf("backlog", "done", { reason: r1001 }, AT)!;
  assert.strictEqual(n1000.reason!.length, 1000, "1000자는 절단 없음");
  assert.strictEqual(n1000.reason, r1000, "1000자는 그대로");
  assert.strictEqual(n1001.reason!.length, 1000, "1001자는 1000자로 절단");
  assert.strictEqual(n1001.reason, r1000, "1001자 절단 결과는 앞 1000자");
}
// trim 이후 기준으로 절단(앞뒤 공백 포함 1001자 넣어도 trim 후 1000 초과분만 잘림)
{
  const trimmedTooLong = "c".repeat(1001);
  const withPadding = "  " + trimmedTooLong + "  ";
  const n = closeNoteOf("backlog", "done", { reason: withPadding }, AT)!;
  assert.strictEqual(n.reason, "c".repeat(1000), "trim 후 길이로 절단 판단");
}

// ── actor/source 는 ctx 값 반영, 부재/undefined 는 null ──
{
  const n = closeNoteOf("backlog", "done", { actor: "alice", source: "mcp" }, AT)!;
  assert.strictEqual(n.actor, "alice");
  assert.strictEqual(n.source, "mcp");
}
{
  const n = closeNoteOf("backlog", "done", { actor: null, source: undefined as unknown as string }, AT)!;
  assert.strictEqual(n.actor, null);
  assert.strictEqual(n.source, null);
}

// ── at 생략 시 현재시각(now) 사용 ──
{
  const before = Date.now();
  const n = closeNoteOf("backlog", "done", {})!;
  const after = Date.now();
  const parsed = Date.parse(n.at);
  assert.ok(parsed >= before && parsed <= after, "at 생략 시 now 로 채워짐");
}

// ────────────────────────────────────────────────────────────────────────
// 3) closeCommentText(note, opts?) → string
// ────────────────────────────────────────────────────────────────────────

const noteDoneBase: CloseNote = {
  category: "done",
  reason: null,
  actor: null,
  source: null,
  at: "2026-01-01T00:00:00.000Z",
};
const noteCanceledBase: CloseNote = {
  category: "canceled",
  reason: null,
  actor: null,
  source: null,
  at: "2026-01-01T00:00:00.000Z",
};

// ── 1행: 카테고리별 문구 ──
assert.strictEqual(
  closeCommentText(noteDoneBase).split("\n")[0],
  "[라이블리] 이 작업을 완료 처리했습니다.",
);
assert.strictEqual(
  closeCommentText(noteCanceledBase).split("\n")[0],
  "[라이블리] 이 작업을 취소 처리했습니다.",
);

// ── 2행: 근거 우선순위 3분기 ──
assert.strictEqual(
  closeCommentText({ ...noteDoneBase, reason: "실제근거임" }).split("\n")[1],
  "근거: 실제근거임",
  "reason 있으면 그대로",
);
assert.strictEqual(
  closeCommentText(noteDoneBase, { recentActivity: "최근활동내용" }).split("\n")[1],
  "근거: 따로 적히지 않았습니다. 닫기 직전 작업 기록 — 최근활동내용",
  "reason 없고 recentActivity 있으면 폴백1",
);
assert.strictEqual(
  closeCommentText(noteDoneBase).split("\n")[1],
  "근거: 기록되지 않았습니다. 경위는 아래 라이블리 링크에서 확인해 주세요.",
  "reason·recentActivity 둘 다 없으면 폴백2",
);
assert.strictEqual(
  closeCommentText({ ...noteDoneBase, reason: "진짜근거" }, { recentActivity: "무시될활동" }).split("\n")[1],
  "근거: 진짜근거",
  "reason 이 recentActivity 보다 우선",
);

// ── 처리자행: 표시 이름(actorName)만 쓴다 — 내부 member id(note.actor)는 외부로 안 나간다. mcp 접미, 부재시 생략 ──
{
  const text = closeCommentText({ ...noteDoneBase, actor: "noteActor" }, { actorName: "optName" });
  assert.ok(text.includes("처리: optName"), "actorName 이 note.actor 보다 우선");
  assert.ok(!text.includes("noteActor"), "note.actor 는 actorName 있으면 쓰이지 않음");
}
{
  const text = closeCommentText({ ...noteDoneBase, actor: "noteActor2" });
  assert.ok(!text.includes("noteActor2") && !text.includes("처리:"), "표시 이름이 없으면 member id 를 내보내지 않고 처리행을 뺀다");
}
{
  const text = closeCommentText({ ...noteDoneBase, actor: "a", source: "mcp" }, { actorName: "a" });
  const line = text.split("\n").find((l) => l.startsWith("처리:"));
  assert.strictEqual(line, "처리: a (AI 에이전트)", "source=mcp 면 접미사 추가");
}
{
  const text = closeCommentText({ ...noteDoneBase, actor: "noteA", source: "mcp" }, { actorName: "optA" });
  const line = text.split("\n").find((l) => l.startsWith("처리:"));
  assert.strictEqual(line, "처리: optA (AI 에이전트)", "접미사는 note.source 기준, 이름은 actorName 기준");
}
{
  const text = closeCommentText({ ...noteDoneBase, actor: "a", source: "web" }, { actorName: "a" });
  const line = text.split("\n").find((l) => l.startsWith("처리:"));
  assert.strictEqual(line, "처리: a", "source!==mcp 면 접미사 없음");
}
{
  const text = closeCommentText(noteDoneBase);
  assert.ok(!text.includes("처리:"), "actorName·note.actor 둘 다 없으면 처리행 생략");
}
{
  const text = closeCommentText({ ...noteDoneBase, actor: "" }, { actorName: "" });
  assert.ok(!text.includes("처리:"), "둘 다 빈 문자열이면 처리행 생략(빈 문자열은 non-empty 아님)");
}

// ── 라이블리 링크행: deepLink 있으면 추가, 없으면 생략 ──
{
  const text = closeCommentText(noteDoneBase, { deepLink: "http://example/x" });
  assert.ok(text.split("\n").includes("라이블리: http://example/x"), "deepLink 있으면 링크행 추가");
}
{
  const text = closeCommentText(noteDoneBase);
  assert.ok(!text.includes("라이블리:"), "deepLink 없으면 링크행 생략");
}

// ── 전체 문자열 완전일치: done 1건 + canceled 1건 (필드 조합 다르게) ──
{
  const note: CloseNote = {
    category: "done",
    reason: "정산 완료 확인함",
    actor: "member-id-1",
    source: "mcp",
    at: "2026-01-01T00:00:00.000Z",
  };
  const text = closeCommentText(note, { actorName: "찰스", deepLink: "http://host/#/k/foo" });
  const expected = [
    "[라이블리] 이 작업을 완료 처리했습니다.",
    "근거: 정산 완료 확인함",
    "처리: 찰스 (AI 에이전트)",
    "라이블리: http://host/#/k/foo",
  ].join("\n");
  assert.strictEqual(text, expected, "done 전체 문자열 완전일치");
}
{
  const note: CloseNote = {
    category: "canceled",
    reason: null,
    actor: "noteActor",
    source: "web",
    at: "2026-01-02T00:00:00.000Z",
  };
  const text = closeCommentText(note, { actorName: "지정이름", recentActivity: "최근 댓글 남김" });
  const expected = [
    "[라이블리] 이 작업을 취소 처리했습니다.",
    "근거: 따로 적히지 않았습니다. 닫기 직전 작업 기록 — 최근 댓글 남김",
    "처리: 지정이름",
  ].join("\n");
  assert.strictEqual(text, expected, "canceled 전체 문자열 완전일치(deepLink 없음 → 링크행 생략)");
}

// ────────────────────────────────────────────────────────────────────────
// 4) sessionCloseReason(reason, sessionId) — ../../v6/session-task.js
//    import 자체가 로드시(DB 등) 실패할 수 있어 격리한다.
// ────────────────────────────────────────────────────────────────────────
try {
  const mod = await import("../../v6/session-task.js");
  const sessionCloseReason = mod.sessionCloseReason as (
    reason: string | null | undefined,
    sessionId: string,
  ) => string;

  assert.strictEqual(
    sessionCloseReason("  실제이유  ", "sess-123"),
    "실제이유",
    "reason 있으면 trim 해서 사용",
  );
  {
    const fb = sessionCloseReason(null, "sess-abc");
    assert.ok(fb.length > 0, "reason=null 폴백은 비지 않음");
    assert.ok(fb.includes("sess-abc"), "폴백에 sessionId 포함");
  }
  {
    const fb = sessionCloseReason(undefined, "sess-abc");
    assert.ok(fb.length > 0, "reason=undefined 폴백은 비지 않음");
    assert.ok(fb.includes("sess-abc"), "폴백에 sessionId 포함");
  }
  {
    const fb = sessionCloseReason("", "sess-abc");
    assert.ok(fb.length > 0, "reason='' 폴백은 비지 않음");
    assert.ok(fb.includes("sess-abc"), "폴백에 sessionId 포함");
  }
  {
    const fb = sessionCloseReason("   ", "sess-abc");
    assert.ok(fb.length > 0, "reason=공백뿐 폴백은 비지 않음");
    assert.ok(fb.includes("sess-abc"), "폴백에 sessionId 포함");
  }
  console.log("close-comment.test: sessionCloseReason 포함 OK");
} catch (e) {
  console.log(
    "close-comment.test: session-task.js import 가 로드시 실패해 sessionCloseReason 은 건너뜀 —",
    (e as Error)?.message ?? e,
  );
}

// (5) 배선 — DB 를 타는 적재·드레인은 이 파일에서 못 돌린다. 끊기면 코멘트가 **조용히** 사라지므로(에러 없음)
//  근거 노트가 쓰는 자리 → 아웃박스 → 드레인 코멘트로 이어지는지 소스로 잠근다.
{
  const src = (rel: string) => readFileSync(new URL(`../../../src/${rel}`, import.meta.url), "utf8");
  const store = src("v6/project-store.ts");
  const noteCalls = store.match(/enqueueExternalPush\(id, "upsert", ctx, null, closeNoteOf\(before\.status_category, after\.status_category, ctx\)\)/g) || [];
  assert.equal(noteCalls.length, 3, `상태를 바꾸는 세 자리(updateProjectStatus·updateTaskStatus·updateTask)가 닫힘 노트를 실어야 한다 — 지금 ${noteCalls.length}`);
  const outbox = src("v6/external-outbox.ts");
  assert.match(outbox, /close_note=COALESCE\(EXCLUDED\.close_note, external_outbox\.close_note\)/, "합쳐지는 후속 편집이 닫힘 노트를 지우면 안 된다");
  const push = src("connectors/clickup-push.ts");
  assert.match(push, /SELECT [^`]*\bclose_note\b[^`]*FROM external_outbox/, "드레인이 close_note 를 읽지 않는다");
  // 상태가 ClickUp 에 실제로 실렸을 때만(statusApplied) — 상태 없이 PUT 이 성공한 경우 «닫았다» 코멘트는 거짓이 된다.
  assert.match(push, /if \(ob\.close_note && statusApplied\) await postCloseComment\(p, p\.external_id, ob\.close_note\)/, "update 경로 코멘트가 상태 반영 여부를 안 본다");
  assert.match(push, /if \(ob\.close_note && statusApplied\) await postCloseComment\(p, ct\.id, ob\.close_note\)/, "create 경로 코멘트가 상태 반영 여부를 안 본다");
  assert.equal((push.match(/statusApplied: false/g) || []).length, 2, "status 를 빼고 재시도한 경로(create·update)는 statusApplied=false 여야 한다");
  assert.equal((push.match(/statusApplied: body\.status != null/g) || []).length, 2, "status 를 안 실은 PUT(상태셋 미해소)은 statusApplied=false 여야 한다");
  assert.match(push, /if \(!p\.status_category \|\| !CLOSED_CATEGORIES\.has\(p\.status_category\)\) return;/, "드레인 전에 다시 연 항목에 코멘트하면 안 된다");
}

console.log("close-comment.test: OK");
