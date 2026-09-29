// 자료 상세 「휴지통으로」 문 판정(web/v2/sources-plan.ts trashDoorOf) — 되살릴 수 있는 갈래에만 문을 세운다(#3778).
//  ⚠ web 은 dist 로 굽히지 않는다: 순수 모듈의 소스를 TypeScript 로 옮긴 뒤 불러온다(source-origin.test.ts 와 같은 방법).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let plan: any = null;
async function loadPlan() {
  if (plan) return plan;
  const js = ts.transpileModule(readFileSync("web/v2/sources-plan.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  plan = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  return plan;
}
const me = { userId: "u1", email: "u1@x.io" };

test("좌표 없는 local_file(에이전트가 source_save 로 올린 자료)도 자료 삭제 문을 세운다", async () => {
  const { trashDoorOf } = await loadPlan();
  assert.equal(trashDoorOf({ kind: "local_file", external_system: null, external_id: null }, null, me), "source");
});

test("글로 적은 자료는 자료 삭제, 남의 시스템에서 온 자료는 문이 없다", async () => {
  const { trashDoorOf } = await loadPlan();
  assert.equal(trashDoorOf({ kind: "note", external_system: null }, null, me), "source");
  assert.equal(trashDoorOf({ kind: "slack", external_system: "slack", external_id: "C1/1.2" }, null, me), null);
  assert.equal(trashDoorOf({ kind: "local_file", external_system: "gdrive", external_id: "abc" }, null, me), null);
});

test("프로젝트 폴더 파일은 그 파일을 지운다", async () => {
  const { trashDoorOf } = await loadPlan();
  assert.equal(trashDoorOf({ kind: "local_file", external_system: "local", external_id: "project:12/a/b.md" }, null, me), "project");
});

test("공유 폴더·내 폴더 파일은 브라우즈로, 남의 개인 폴더 파일은 문이 없다", async () => {
  const { trashDoorOf } = await loadPlan();
  assert.equal(trashDoorOf({ kind: "local_file", external_system: "local", external_id: "shared/a.md" }, { root: "shared", path: "a.md" }, me), "browse");
  assert.equal(trashDoorOf({ kind: "local_file", external_system: "local", external_id: "personal:u1/a.md" }, { root: "personal", path: "a.md" }, me), "browse");
  assert.equal(trashDoorOf({ kind: "local_file", external_system: "local", external_id: "personal:u1@x.io/a.md" }, { root: "personal", path: "a.md" }, me), "browse");
  assert.equal(trashDoorOf({ kind: "local_file", external_system: "local", external_id: "personal:u2/a.md" }, { root: "personal", path: "a.md" }, me), null);
  assert.equal(trashDoorOf({ kind: "local_file", external_system: "local", external_id: "personal:u2/a.md" }, { root: "personal", path: "a.md" }, {}), null);
});

test("좌표도 폴더 주소도 못 푸는 업로드 파일은 문을 세우지 않는다(지울 자리를 모른다)", async () => {
  const { trashDoorOf } = await loadPlan();
  assert.equal(trashDoorOf({ kind: "local_file", external_system: "local", external_id: "personal:u1/a.md" }, null, me), null);
  assert.equal(trashDoorOf({ kind: "local_file", external_system: null, external_id: "x/y" }, null, me), null);
});
