// 앱 폴더 자리 보호(#4684) — 웹·API 로 `.lively/apps` 아래에 쓰지 않는다(읽기·지우기는 막지 않는다).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertNotAppFolderMount, touchesAppFolderMount } from "./app-folder-guard.js";

test("G1 `.lively` 다음 `apps` 조각이 어디에 있든 잡는다 — 작업 폴더는 어디든 될 수 있다", () => {
  for (const p of [".lively/apps", ".lively/apps/crm/a.txt", "sub/.lively/apps/x", "project/12/.lively/apps/crm", "/work/shared/p/.lively/apps", "a\\.lively\\apps\\b", ".lively//apps/x",
    ".lively/./apps/x", "a/../.lively/apps/b", "x/y/../../.lively/apps", "./.lively/apps"]) {
    assert.equal(touchesAppFolderMount(p), true, `잡아야 한다: ${p}`);
  }
});

test("G2 비슷하지만 다른 이름은 통과 — `.lively` 자체 · `.lively/trash` · `apps/.lively` · `.lively/appsx` · `.lively-apps`", () => {
  for (const p of [".lively", ".lively/trash/1/x", "apps/.lively", ".lively/appsx", ".lively-apps/x", "lively/apps", "", null, undefined]) {
    assert.equal(touchesAppFolderMount(p), false, `막으면 안 된다: ${String(p)}`);
  }
});

test("G3 여러 경로 중 하나라도 닿으면 403", () => {
  assert.throws(() => assertNotAppFolderMount("docs/a.md", ".lively/apps/crm/b.md"), (e: unknown) => (e as { status?: number }).status === 403);
  assert.doesNotThrow(() => assertNotAppFolderMount("docs/a.md", "docs/b.md"));
});

//  배선 — 쓰기 처리기마다 경로를 풀기(resolve) **전에** 본다. 읽기·지우기 처리기에는 넣지 않는다.
const PROJ = readFileSync(new URL("../../src/project/project-routes.ts", import.meta.url), "utf8");
const FILES = readFileSync(new URL("../../src/terminal/terminal-files.ts", import.meta.url), "utf8");
const handler = (src: string, head: string): string => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `처리기를 못 찾았다: ${head}`);
  return src.slice(i, src.indexOf("\n  }));\n", i));
};

test("G4 프로젝트 자료 쓰기(올리기·새 폴더·이름 바꾸기·옮기기)는 자리 판정을 지난다", () => {
  for (const [head, before] of [
    ["app.put(`${prefix}/:id/file`", "resolveInProject("],
    ["app.post(`${prefix}/:id/folder`", "resolveInProject("],
    ["app.post(`${prefix}/:id/file/rename`", "store.move("],
    ["app.post(`${prefix}/:id/move`", "jailIfMember("],
  ] as const) {
    const h = handler(PROJ, head);
    const g = h.indexOf("assertNotAppFolderMount(");
    assert.ok(g > 0 && g < h.indexOf(before), `${head}: 판정이 없거나 ${before} 뒤에 있다`);
  }
  assert.ok(!handler(PROJ, "app.delete(`${prefix}/:id/file`").includes("assertNotAppFolderMount("), "지우기는 막지 않는다");
});

test("G5 공유·개인 탐색기와 세션 자리 쓰기(새 폴더·이름 바꾸기·올리기)는 자리 판정을 지난다", () => {
  for (const [head, before] of [
    ['app.post("/api/ui/terminal/browse/mkdir"', "resolveBrowse("],
    ['app.post("/api/ui/terminal/browse/rename"', "memberStat("],
    ['app.put("/api/ui/terminal/browse/file"', "resolveBrowse("],
    ['app.post("/api/ui/terminal/sessions/:id/mkdir"', "nodeFor("],
    ['app.put("/api/ui/terminal/sessions/:id/file"', "nodeFor("],
  ] as const) {
    const h = handler(FILES, head);
    const g = h.indexOf("assertNotAppFolderMount(");
    assert.ok(g > 0 && g < h.indexOf(before), `${head}: 판정이 없거나 ${before} 뒤에 있다`);
  }
});
