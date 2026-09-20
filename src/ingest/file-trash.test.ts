// #3778 파일 휴지통 — 보관 자리 계산(순수). DB/FS 불요.
//   실행: npm run build && node dist/ingest/file-trash.test.js
//  지키는 약속: ① 지운 것 하나 = 묶음 하나(`.lively/trash/<batch>/<이름>`) ② 폴더를 지웠으면 그 안 파일마다 제 보관 경로가 계산된다
//   ③ 도장과 어긋나는 경로는 **던진다** — 엉뚱한 파일을 되살리거나 지우지 않는다 ④ 숨김 자리(.lively)라 목록·동기화에 안 잡힌다.
import assert from "node:assert/strict";
import { heldPathOf, newFileTrashStamp, fileTrashBatchCleanup, FILE_TRASH_DIR } from "./local-file-core.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const NOW = new Date("2026-09-20T08:00:00.000Z");

t("F1 파일 하나 — 보관 자리는 .lively/trash/<batch>/<파일 이름>, 도장에 원래 경로·프로젝트·지운 사람이 남는다", () => {
  const s = newFileTrashStamp(3778, "docs/회의록.docx", "wonjoon-jang", NOW, 0.5);
  assert.equal(s.project_id, 3778);
  assert.equal(s.by, "wonjoon-jang");
  assert.equal(s.at, NOW.toISOString());
  assert.equal(s.base_rel, "docs/회의록.docx");
  assert.equal(s.held_rel, `${FILE_TRASH_DIR}/${s.batch}/회의록.docx`);
  assert.equal(heldPathOf(s, "docs/회의록.docx"), s.held_rel);
});

t("F2 ★숨김 자리 — 첫 마디가 점으로 시작한다(목록·검색·매니페스트가 건너뛰는 조건)", () => {
  assert.ok(FILE_TRASH_DIR.split("/")[0].startsWith("."));
  assert.ok(newFileTrashStamp(1, "a.txt", null, NOW, 0.1).held_rel.startsWith(".lively/trash/"));
});

t("F3 폴더를 지웠으면 그 안 파일마다 제 보관 경로 — 하위 구조가 그대로 따라간다", () => {
  const s = newFileTrashStamp(7, "자료/9월", "a", NOW, 0.25);
  assert.equal(heldPathOf(s, "자료/9월/가격표.xlsx"), `${s.held_rel}/가격표.xlsx`);
  assert.equal(heldPathOf(s, "자료/9월/하위/로고.png"), `${s.held_rel}/하위/로고.png`);
});

t("F4 ★도장과 어긋나는 경로는 던진다 — 이름이 같은 접두어일 뿐인 옆 폴더·상위·무관한 경로", () => {
  const s = newFileTrashStamp(7, "자료/9월", "a", NOW, 0.25);
  assert.throws(() => heldPathOf(s, "자료/9월분/x.txt"), /어긋납니다/);   // '자료/9월' 로 시작하지만 다른 폴더
  assert.throws(() => heldPathOf(s, "자료/x.txt"), /어긋납니다/);
  assert.throws(() => heldPathOf(s, "딴곳/9월/x.txt"), /어긋납니다/);
});

t("F5 경로 정규화 — 앞뒤 슬래시를 떼고, 같은 이름을 두 번 지워도 묶음이 안 겹친다", () => {
  const a = newFileTrashStamp(1, "/docs/a.txt/", null, NOW, 0.1);
  assert.equal(a.base_rel, "docs/a.txt");
  const b = newFileTrashStamp(1, "docs/a.txt", null, NOW, 0.9);
  assert.notEqual(a.batch, b.batch);
  assert.notEqual(a.held_rel, b.held_rel);
  const later = newFileTrashStamp(1, "docs/a.txt", null, new Date(NOW.getTime() + 1), 0.1);
  assert.notEqual(a.batch, later.batch);
});

t("F6 끝 슬래시가 붙어 와도 같은 자리 — 폴더 경로 표기 차이로 되살리기가 어긋나지 않는다", () => {
  const s = newFileTrashStamp(7, "자료/9월", "a", NOW, 0.25);
  assert.equal(heldPathOf({ base_rel: "자료/9월/", held_rel: s.held_rel }, "자료/9월/가격표.xlsx"), `${s.held_rel}/가격표.xlsx`);
  assert.equal(heldPathOf(s, "자료/9월/"), s.held_rel);
});

// ── 묶음 치우기 판정 — 폴더째 지우면 자료가 아닌 동행 파일(zip·영상·점 파일)이 묶음에 함께 들어 있다. 그것들은 도장도 없고 화면에도 안 선다. ──
t("F7 ★되살리기는 아무것도 없애지 않는다 — 폴더 묶음은 남은 도장이 0 이어도 치우지 않는다(동행 파일이 그 안에 있다)", () => {
  assert.equal(fileTrashBatchCleanup("restore", { base_rel: "자료/9월" }, "자료/9월/보고서.docx", 0), "keep");
  assert.equal(fileTrashBatchCleanup("restore", { base_rel: "자료/9월/" }, "자료/9월/하위/a.pdf", 0), "keep");
});

t("F8 되살리기 — 파일 하나만 지웠던 묶음은 그 파일이 전부라 치운다(빈 폴더를 쌓지 않는다)", () => {
  assert.equal(fileTrashBatchCleanup("restore", { base_rel: "docs/a.txt" }, "docs/a.txt", 0), "remove");
  assert.equal(fileTrashBatchCleanup("restore", { base_rel: "docs/a.txt/" }, "docs/a.txt", 0), "remove");
});

t("F9 완전 삭제 — 마지막 자료까지 지웠으면 묶음째 치운다(폴더 묶음 포함: 사람이 지우기로 한 폴더의 나머지)", () => {
  assert.equal(fileTrashBatchCleanup("purge", { base_rel: "자료/9월" }, "자료/9월/보고서.docx", 0), "remove");
  assert.equal(fileTrashBatchCleanup("purge", { base_rel: "docs/a.txt" }, "docs/a.txt", 0), "remove");
});

t("F10 ★도장이 하나라도 남았으면 어느 쪽이든 손대지 않는다 — 남은 자료의 바이트가 그 안에 있다(경계: 1)", () => {
  for (const op of ["restore", "purge"] as const) {
    assert.equal(fileTrashBatchCleanup(op, { base_rel: "docs/a.txt" }, "docs/a.txt", 1), "keep");
    assert.equal(fileTrashBatchCleanup(op, { base_rel: "자료/9월" }, "자료/9월/b.docx", 7), "keep");
  }
});

t("F11 남은 수를 못 셌으면(NaN) 치우지 않는다 — 모르면 남긴다", () => {
  assert.equal(fileTrashBatchCleanup("purge", { base_rel: "docs/a.txt" }, "docs/a.txt", Number.NaN), "keep");
  assert.equal(fileTrashBatchCleanup("restore", { base_rel: "docs/a.txt" }, "docs/a.txt", Number.NaN), "keep");
});

console.log(`\n${pass} passed`);
