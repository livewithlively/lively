// 앱 폴더 상한 · 사용량(#4785) — 순수 판정: 단계 경계 · 상한 검사 · 알림 글 · 응답 칸.
//  저장 · 권한 · 알림 행 · 앱 지우기는 app-folder-quota.pg-test.mjs(실제 게이트웨이 · Postgres).
import { strict as assert } from "node:assert";
import test from "node:test";
import { APP_FOLDER_LIMIT_MAX_GB, folderFields, folderLevel, folderNotice, fmtGiB, parseFolderLimit } from "./app-folder-quota.js";

const GiB = 1024 ** 3;

test("F1 단계 — 상한이 없으면 0 · 80% 와 100% 는 정확히 그 값에서 넘어간다 · 이상한 사용량은 0", () => {
  assert.equal(folderLevel(100 * GiB, null), 0);
  assert.equal(folderLevel(5 * GiB, 0), 0);
  assert.equal(folderLevel(4 * GiB - 1, 5), 0, "80% 바로 아래");
  assert.equal(folderLevel(4 * GiB, 5), 80, "정확히 80%");
  assert.equal(folderLevel(5 * GiB - 1, 5), 80, "100% 바로 아래");
  assert.equal(folderLevel(5 * GiB, 5), 100, "정확히 100%");
  assert.equal(folderLevel(9 * GiB, 5), 100);
  assert.equal(folderLevel(-1, 5), 0);
  assert.equal(folderLevel(Number.NaN, 5), 0);
});

test("F2 상한 검사 — 비우면 없음 · 1 과 최댓값은 받고 · 0 · 최댓값 + 1 · 소수 · 글자 · 음수는 400", () => {
  for (const v of [null, undefined, ""]) assert.equal(parseFolderLimit(v), null);
  assert.equal(parseFolderLimit(1), 1);
  assert.equal(parseFolderLimit("5"), 5);
  assert.equal(parseFolderLimit(APP_FOLDER_LIMIT_MAX_GB), APP_FOLDER_LIMIT_MAX_GB);
  for (const bad of [0, APP_FOLDER_LIMIT_MAX_GB + 1, 1.5, "abc", -1]) {
    assert.throws(() => parseFolderLimit(bad), (e: unknown) => (e as { status?: number })?.status === 400, `값 ${String(bad)}`);
  }
});

test("F3 알림 글 — 80% 는 «넘었다» · 100% 는 «가득 · 더 쓸 수 없다» · 앱 이름과 쓰는 양 / 상한을 싣는다", () => {
  const a = folderNotice("회의록", 4.1 * GiB, 5, 80);
  assert.match(a.title, /「회의록」 .*80%/);
  assert.match(a.body, /4\.1GiB \/ 5GiB/);
  const b = folderNotice("회의록", 5 * GiB, 5, 100);
  assert.match(b.title, /가득/);
  assert.match(b.body, /더 쓸 수 없습니다/);
  assert.equal(fmtGiB(1536 * 1024), "1.5MiB");
  assert.equal(fmtGiB(2048), "2KiB");
});

test("F4 응답 칸 — 재지 않았으면 쓰는 양 · 걸린 상한 null · 단계 0 · 잰 것이 있으면 그 값과 단계", () => {
  assert.deepEqual(folderFields({ folder_limit_gb: 5 }, undefined, false),
    { limit_gb: 5, used_bytes: null, applied_limit_gb: null, measured_at: null, level: 0, can_set: false });
  assert.deepEqual(folderFields({}, { app_id: "crm", used_bytes: 5 * GiB, limit_gb: 5, measured_at: "t", warned_level: 100 }, true),
    { limit_gb: null, used_bytes: 5 * GiB, applied_limit_gb: 5, measured_at: "t", level: 100, can_set: true });
});
