import { strict as assert } from "node:assert";
import test from "node:test";
import { describeTableChanges, previewLimits, splitFailures, type GoneTablePlan } from "./publish-preview.js";
import type { AppTableFailure, AppTableReport } from "./store-schema.js";

// ── 공개 미리 보기(#4732) — 순수 부분: 보고서 → 사람이 읽는 줄 · 걸어 보기 실패 → «막힘» / «다 못 봄» · 상한 ─────────────
//  이게 틀리면: 칸을 지우는데 미리 보기가 «할 일 없음» 이라 묻지 않고 공개하거나(값이 사라진다) · 잠금 대기 초과를 «데이터가 어긋남» 으로
//   말해 사람이 멀쩡한 행을 고치러 가거나 · 미리 보기가 공개만큼 오래 표를 잠근다.

//  보고서는 글자 그대로 만든다 — store-schema 를 불러오면 DB 풀까지 딸려 온다(단위 시험은 순수하게).
const rep = (o: Partial<AppTableReport> = {}): AppTableReport => ({
  created: [], added_columns: [], type_mismatches: [], added_indexes: [], dropped_indexes: [],
  renamed_columns: [], converted_columns: [], dropped_columns: [], undeclared_columns: [], constraints: [], deferred: [], ...o,
});

test("E15 빈 보고서 · 정리할 표 없음 → 0줄(묻지 않고 공개)", () => {
  assert.deepEqual(describeTableChanges(rep(), []), []);
  assert.deepEqual(describeTableChanges(null, []), []);
});

test("E15 칸 지우기 — 값이 있으면 행 수와 보관 · 값이 없으면(경계 0행) «값 없음»", () => {
  const lines = describeTableChanges(rep({ dropped_columns: [
    { table: "items", column: "code", rows: 2, archived_as: null },
    { table: "items", column: "memo", rows: 0, archived_as: null },
    { table: "items", column: "one", rows: 1, archived_as: null },
  ] }), []);
  assert.deepEqual(lines, [
    "items 표: code 칸 지우기 — 값이 있는 2행은 따로 보관(앱에서는 더 안 보임)",
    "items 표: memo 칸 지우기(값 없음)",
    "items 표: one 칸 지우기 — 값이 있는 1행은 따로 보관(앱에서는 더 안 보임)",
  ]);
});

test("E15 보고서의 칸 종류마다 한 줄 — 새 표 · 새 칸 · 이름 · 종류 · 못 바꾼 종류 · 남겨 둔 칸", () => {
  const lines = describeTableChanges(rep({
    created: ["tags"],
    added_columns: [{ table: "items", column: "note", type: "text" }],
    renamed_columns: [{ table: "items", from: "title", to: "headline" }],
    converted_columns: [{ table: "items", column: "qty", from: "text", to: "integer" }],
    type_mismatches: [{ table: "items", column: "at", declared: "date", actual: "text", reason: "날짜가 아닌 값 3행" }],
    undeclared_columns: [{ table: "items", column: "old" }],
  }), []);
  assert.deepEqual(lines, [
    "새 표 tags",
    "items 표: 새 칸 note",
    "items 표: title 칸 이름 바꾸기 → headline",
    "items 표: qty 칸 종류 바꾸기 text → integer",
    "items 표: at 칸 종류는 date 로 못 바꿔 그대로(text) — 날짜가 아닌 값 3행",
    "items 표: old 칸은 새 판에 없지만 값을 지키려고 남겨 둠",
  ]);
});

test("E15 규칙(제약) — 꼭 채우기 · 비워도 됨 · 겹침 · 가리키기 · 검사 · 기본값 · 기본 키 · 칸 없는 규칙", () => {
  const lines = describeTableChanges(rep({ constraints: [
    { table: "items", column: "title", kind: "not_null", action: "added" },
    { table: "items", column: "memo", kind: "not_null", action: "removed" },
    { table: "tags", kind: "unique", action: "added" },
    { table: "items", column: "tag_id", kind: "foreign_key", action: "added" },
    { table: "items", kind: "foreign_key", action: "removed" },
    { table: "items", column: "qty", kind: "check", action: "added" },
    { table: "items", kind: "check", action: "removed" },
    { table: "items", column: "state", kind: "default", action: "changed" },
    { table: "items", column: "state2", kind: "default", action: "removed" },
    { table: "items", kind: "primary_key", action: "changed" },
  ] }), []);
  assert.deepEqual(lines, [
    "items 표: title 칸을 꼭 채워야 하게 바꿈",
    "items 표: memo 칸을 비워도 되게 바꿈",
    "tags 표: 겹치는 값 막기",
    "items 표: tag_id 칸이 다른 표의 행을 가리키게 함(가리킬 행이 없는 값은 막힘)",
    "items 표: 다른 표 가리키기 풀기",
    "items 표: qty 칸 값 검사 더하기",
    "items 표: 값 검사 빼기",
    "items 표: state 칸 기본값 바꾸기",
    "items 표: state2 칸 기본값 빼기",
    "items 표: 기본 키 바꾸기",
  ]);
});

test("E15 색인 — 겹침을 막는 색인만 싣고 찾기 색인은 싣지 않는다(쓰는 사람에게 안 보이는 일)", () => {
  const lines = describeTableChanges(rep({
    added_indexes: [{ table: "items", columns: ["code"], unique: true }, { table: "items", columns: ["title"], unique: false }],
    dropped_indexes: [{ table: "items", index: "lv_ix_items_x" }],
  }), []);
  assert.deepEqual(lines, ["items 표: 겹치는 값 막기(code)"]);
});

test("E7 새 판에 없는 표 — 비었으면 지움 · 행이 있으면 보관(행 수) · 보고서 뒤에 붙는다", () => {
  const gone: GoneTablePlan[] = [{ table: "logs", rows: 3, action: "archive" }, { table: "tmp", rows: 0, action: "drop" }];
  assert.deepEqual(describeTableChanges(rep({ created: ["x"] }), gone), [
    "새 표 x",
    "logs 표 따로 보관 — 새 판에 없음 · 3행(앱에서는 더 안 보임)",
    "tmp 표 지우기 — 새 판에 없고 비어 있음",
  ]);
});

const f = (o: Partial<AppTableFailure> & { table: string }): AppTableFailure => ({ status: null, code: null, error: "e", ...o });

test("E4 데이터가 새 규칙에 어긋남(4xx) → 막힘 · 문구 그대로 · 다 못 봄 아님", () => {
  const r = splitFailures([f({ table: "items", status: 409, error: "'items.title' 에 값이 없는(NULL) 행이 1개 있어 not_null 을 걸 수 없습니다" })]);
  assert.deepEqual(r.blocked, ["'items.title' 에 값이 없는(NULL) 행이 1개 있어 not_null 을 걸 수 없습니다"]);
  assert.equal(r.incomplete, null);
});

test("E9 잠금 대기 초과(55P03) · 시간 초과(57014) → 다 못 봄 · 막힘 아님(데이터 탓이라 말하지 않는다)", () => {
  for (const code of ["55P03", "57014"]) {
    const r = splitFailures([f({ table: "items", code, error: "canceling statement due to lock timeout" })]);
    assert.deepEqual(r.blocked, [], code);
    assert.match(r.incomplete ?? "", /다른 사람이 쓰고 있거나 표가 커서 다 보지 못했습니다/, code);
  }
});

test("가리키는 표가 먼저 막혀 함께 못 한 표 — 그 표를 따른다(막힘이면 막힘 · 잠금이면 다 못 봄에 묻힌다)", () => {
  const byData = splitFailures([f({ table: "tags", status: 409, error: "겹침 2개" }), f({ table: "items", after: ["tags"], error: "외래키가 가리키는 표(tags)를 만들지 못했습니다" })]);
  assert.deepEqual(byData.blocked, ["겹침 2개", "items 표도 멈춤 — 가리키는 표(tags)가 먼저 막혔음"]);
  assert.equal(byData.incomplete, null);
  const byLock = splitFailures([f({ table: "tags", code: "55P03" }), f({ table: "items", after: ["tags"] })]);
  assert.deepEqual(byLock.blocked, []);
  assert.match(byLock.incomplete ?? "", /다 보지 못했습니다/);
  assert.doesNotMatch(byLock.incomplete ?? "", /items/);
});

test("뜻밖의 오류(상태 · 코드 없음) → 다 못 봄에 그대로 · 막힘 아님", () => {
  const r = splitFailures([f({ table: "items", error: "connection terminated" })]);
  assert.deepEqual(r.blocked, []);
  assert.equal(r.incomplete, "미리 보기 중 문제가 생겼습니다: items: connection terminated");
});

test("실패 없음(새로 넣은 모으기가 비었음) → 막힘 0 · 다 못 봄 없음", () => {
  assert.deepEqual(splitFailures([]), { blocked: [], incomplete: null });
});

test("상한 — 기본 잠금 1.5초 · 문장 5초(공개의 10초 · 5분보다 짧다) · 환경으로 바꿈 · 이상한 값(100ms 미만 · 글자)은 기본값", () => {
  assert.deepEqual(previewLimits({}), { lockMs: 1500, statementMs: 5000 });
  assert.deepEqual(previewLimits({ LIVELY_APP_PREVIEW_LOCK_MS: "300", LIVELY_APP_PREVIEW_STATEMENT_MS: "2000" }), { lockMs: 300, statementMs: 2000 });
  assert.deepEqual(previewLimits({ LIVELY_APP_PREVIEW_LOCK_MS: "99", LIVELY_APP_PREVIEW_STATEMENT_MS: "abc" }), { lockMs: 1500, statementMs: 5000 });
  assert.deepEqual(previewLimits({ LIVELY_APP_PREVIEW_LOCK_MS: "100" }), { lockMs: 100, statementMs: 5000 });   // 경계 — 100 은 받는다
});
