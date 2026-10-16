// 앱 폴더 상한 · 사용량(#4785) — 순수 판정: 단계 경계 · 붙든 단계 · 상한 검사 · 알림 글 · 응답 칸.
//  저장 · 권한 · 알림 행 · 앱 지우기는 app-folder-quota.pg-test.mjs(실제 게이트웨이 · Postgres).
import { strict as assert } from "node:assert";
import test from "node:test";
import { APP_FOLDER_LIMIT_MAX_GB, folderFields, folderLevel, folderNotice, fmtBytes, heldLevel, parseFolderLimit } from "./app-folder-quota.js";

const GiB = 1024 ** 3;
const J = (v: unknown) => JSON.stringify(v) ?? String(v);

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

test("F2 상한 검사 — null 만 없앰 · 1 과 최댓값(1000)은 받고 · 빠뜨린 값 · 빈 글 · 0 · 최댓값 + 1 · 소수 · 글자 · 음수는 400", () => {
  assert.equal(parseFolderLimit(null), null);
  assert.equal(parseFolderLimit(1), 1);
  assert.equal(parseFolderLimit("5"), 5);
  assert.equal(APP_FOLDER_LIMIT_MAX_GB, 1000, "1TiB 를 넘기면 JuiceFS 목록의 크기 글이 0.1TiB 단위라 건 값이 되읽히지 않는다");
  assert.equal(parseFolderLimit(APP_FOLDER_LIMIT_MAX_GB), APP_FOLDER_LIMIT_MAX_GB);
  //  빠뜨린 값은 «없애려면 null» 을 말한다(본문을 잘못 보낸 요청이 걸어 둔 상한을 조용히 풀지 않게).
  for (const v of [undefined, ""]) assert.throws(() => parseFolderLimit(v), /null 을 보내세요/, `값 ${J(v)}`);
  for (const bad of [undefined, "", 0, APP_FOLDER_LIMIT_MAX_GB + 1, 1.5, "abc", -1]) {
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
  assert.equal(fmtBytes(1536 * 1024), "1.5MiB");
  assert.equal(fmtBytes(2048), "2KiB");
});

test("F4 응답 칸 — 재지 않았으면 쓰는 양 · 걸린 상한 null · 단계 0 · 잰 것이 있으면 그 값과 단계 · 이 배포가 상한을 거나", () => {
  assert.deepEqual(folderFields({ folder_limit_gb: 5 }, undefined, false, false),
    { limit_gb: 5, used_bytes: null, applied_limit_gb: null, measured_at: null, level: 0, can_set: false, enforced: false });
  assert.deepEqual(folderFields({}, { app_id: "crm", used_bytes: 5 * GiB, limit_gb: 5, measured_at: "t", warned_level: 100 }, true, true),
    { limit_gb: null, used_bytes: 5 * GiB, applied_limit_gb: 5, measured_at: "t", level: 100, can_set: true, enforced: true });
  //  단계는 «지금 걸린 상한» 으로 — 원하는 상한(4)을 낮춘 직후 정비 전엔 걸린 상한(5)에 4.5GiB 는 80 이다(쓸 수 있다).
  assert.equal(folderFields({ folder_limit_gb: 4 }, { app_id: "crm", used_bytes: 4.5 * GiB, limit_gb: 5, measured_at: "t", warned_level: 80 }, true, true).level, 80);
  //  기본값은 배포를 따른다 — 테넌트 헤더 비밀이 없는 이 시험 프로세스는 셀프호스트다.
  assert.equal(folderFields({}, undefined, false).enforced, !!(process.env.LIVELY_TENANT_HEADER_SECRET || "").trim());
});

test("F5 붙든 단계 — 알린 단계는 10%p 아래로 내려가야 놓는다(경계에서 오르내릴 때마다 다시 알리지 않게) · 상한이 없어지면 놓는다", () => {
  assert.equal(heldLevel(80, 7 * GiB, 10), 80, "70% — 80 단계를 붙든다");
  assert.equal(heldLevel(80, 7 * GiB - 1, 10), 0, "70% 바로 아래 — 놓는다");
  assert.equal(heldLevel(100, 9 * GiB, 10), 100, "90% — 100 단계를 붙든다");
  assert.equal(heldLevel(100, 9 * GiB - 1, 10), 80, "90% 바로 아래 — 80 으로 내린다");
  assert.equal(heldLevel(100, 7 * GiB - 1, 10), 0, "70% 아래 — 다 놓는다");
  assert.equal(heldLevel(0, 9.5 * GiB, 10), 0, "알린 적이 없으면 붙든 것도 없다");
  assert.equal(heldLevel(80, 9 * GiB, null), 0, "상한을 없앴다");
  assert.equal(heldLevel(100, 9 * GiB, 20), 0, "상한을 올려 45% 가 됐다");
  //  오르내림 — 81% 에서 알린 뒤 79% · 81% 를 오가도 붙든 단계(80)가 지금 단계 이상이라 다시 알리지 않는다.
  for (const pct of [79, 81, 75, 80]) assert.ok(folderLevel(pct / 100 * 10 * GiB, 10) <= heldLevel(80, pct / 100 * 10 * GiB, 10), `${pct}%`);
});
