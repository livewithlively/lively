// 이름 바꾸기·옮기기 기록 + 자료 좌표 이동(#4688) — 프로젝트 폴더 자리 판정(사양 표 C1~C3) + 배선(W1~W6). DB 불요.
//  끝단 동작(실제 기록·자료 행·옛 링크 풀기·권한 재판정)은 src/v6/file-move.pg-test.mjs 가 실 Postgres 로 잰다. 여기서는 그 동작이
//  «어느 입구에서나 · 옮긴 뒤에 · 판정을 지나서» 붙어 있는지를 소스에서 본다 — 입구 하나를 빼먹으면 그 길로 옮긴 파일만 끊긴다.
//   실행: npm run build && node --test dist/files/file-move-wiring.test.js
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { isProjectContainerPath, isFolderOrAncestorOf } from "../v6/shared-folder-store.js";
import { isSystemDeniedTable } from "../db/firewall.js";

const ROOT = path.resolve(new URL("../../", import.meta.url).pathname.replace("/dist/", "/"));
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** 라우트 머리부터 다음 `app.` 등록 전까지 */
function routeBody(file: string, head: string): string {
  const at = file.indexOf(head);
  assert.ok(at >= 0, `라우트가 없다: ${head}`);
  const next = file.indexOf("app.", at + head.length);
  return file.slice(at, next < 0 ? undefined : next);
}
const before = (body: string, a: string, b: string, why: string): void => {
  const i = body.indexOf(a), j = body.indexOf(b);
  assert.ok(i >= 0, `없다: ${a}`);
  assert.ok(j >= 0, `없다: ${b}`);
  assert.ok(i < j, why);
};

test("C1 프로젝트 폴더를 담는 자리 자체 — project · legacy-project · 그 바로 아래 한 칸은 참(앞뒤 '/' 무관)", () => {
  for (const p of ["project", "legacy-project", "project/12", "legacy-project/12", "/project/12/", "project/이름기반"]) {
    assert.equal(isProjectContainerPath(p), true, p);
  }
});

test("C2 그 안의 파일·폴더나 비슷한 이름은 거짓 — 이름을 바꿀 수 있다", () => {
  for (const p of ["project/12/a.md", "project/12/docs", "projects", "docs/project", "docs/project/12", "", "legacy-projects/12"]) {
    assert.equal(isProjectContainerPath(p), false, p);
  }
});

test("C3 이상한 경로(..)는 거짓 — 판정은 부르는 쪽의 경로 해소가 이미 걸었다", () => {
  assert.equal(isProjectContainerPath("project/../x"), false);
});

test("C4 프로젝트 폴더이거나 그 조상인가(순수) — 자기 · 조상은 참, 형제 · 하위 · 이름이 겹치는 것은 거짓('/' 경계)", () => {
  const folders = ["project/12/nested", "project/team/alpha"];
  for (const p of ["project/12/nested", "project/12", "project/team", "project/team/alpha", "/project/12/nested/"]) assert.equal(isFolderOrAncestorOf(p, folders), true, p);
  for (const p of ["project/12/nested/x.md", "project/12/nest", "project/1", "project/team/alph", "", "project/../x"]) assert.equal(isFolderOrAncestorOf(p, folders), false, p);
  assert.equal(isFolderOrAncestorOf("project/12", []), false, "안쪽 프로젝트 폴더가 없으면 막을 것이 없다");
});

test("W1 프로젝트 자료 이름 바꾸기 — 파일을 옮긴 **뒤에** 그 프로젝트 좌표로 뒷일(자료 좌표 + 기록)을 한다", () => {
  const body = routeBody(read("src/project/project-routes.ts"), "app.post(`${prefix}/:id/file/rename`");
  before(body, "await store.move(fromAbs, toAbs);", "await settleProjectMove(project, base, fromAbs, toAbs, fromStat.dir, req);", "뒷일이 옮기기보다 먼저다");
  before(body, "await settleProjectMove(", "res.json(", "응답 뒤에 뒷일을 하면 화면이 옛 자료를 본다");
});

test("W2 프로젝트 자료 옮기기 — 항목마다 옮긴 바로 뒤(권한 비트 실패가 뒷일을 건너뛰게 하지 않는다)", () => {
  const body = routeBody(read("src/project/project-routes.ts"), "app.post(`${prefix}/:id/move`");
  before(body, "await store.move(fromAbs, toAbs);", "await settleProjectMove(project, base, fromAbs, toAbs, fromStat.dir, req);", "뒷일이 옮기기보다 먼저다");
  before(body, "await settleProjectMove(", "store.grantGroup(", "권한 비트가 실패하면 뒷일이 빠진다");
  before(body, "await projectFoldersUnder(project.folder)", "for (const raw of list)", "안쪽 프로젝트 폴더를 항목마다 읽는다");
  const helper = read("src/project/project-routes.ts");
  const h = helper.slice(helper.indexOf("const settleProjectMove ="), helper.indexOf("// ── ① 공유 폴더"));
  assert.match(h, /scope: SHARED_MOVE_SCOPE/, "프로젝트 폴더의 기록은 공유 루트 자리다(링크 root=shared)");
  assert.match(h, /root: \{ kind: "project", id: project\.id \}/, "자료 좌표는 그 프로젝트 좌표다");
  assert.match(h, /fromPath: path\.join\(project\.folder, fromRel\)/, "기록 경로는 링크 좌표(<folder>/…)여야 옛 링크와 맞는다");
});

test("W3 홈 탐색기 이름 바꾸기 — 프로젝트 폴더 자리 막기와 좌표 풀기는 옮기기 **전**, 뒷일은 **뒤**", () => {
  const body = routeBody(read("src/terminal/terminal-files.ts"), 'app.post("/api/ui/terminal/browse/rename"');
  for (const mv of ["memberMv(", "fsp.rename("]) {
    before(body, "isProjectContainerPath(", mv, `프로젝트 폴더 자리(모양)를 옮긴 뒤에 막는다(${mv})`);
    before(body, "await isProjectFolderOrAncestor(", mv, `DB 에 적힌 프로젝트 폴더를 옮긴 뒤에 막는다(${mv})`);
    before(body, "localRootForBrowse(", mv, `좌표를 옮긴 뒤에 풀면 옛 자리를 못 푼다(${mv})`);
    before(body, mv, "await settleFileMove(", `뒷일이 옮기기보다 먼저다(${mv})`);
  }
  assert.match(body, /renameSharedFolderAclPrefix\(/, "공개범위 경로 동기화가 사라졌다");
  assert.match(body, /personalMoveScope\(loc\.root\.member\)/, "개인 폴더 기록은 주인별이어야 한다");
});

test("W7 프로젝트 자료 이름 바꾸기·옮기기 — 다른 프로젝트의 폴더 자리 막기는 옮기기 **전**", () => {
  for (const head of ["app.post(`${prefix}/:id/file/rename`", "app.post(`${prefix}/:id/move`"]) {
    const body = routeBody(read("src/project/project-routes.ts"), head);
    before(body, "assertNotProjectFolder(project, ", "await store.move(fromAbs, toAbs);", `${head}: 옮긴 뒤에 막는다`);
  }
});

test("W4 옛 링크 풀기 — 옛 경로 판정 → 실제 파일 먼저 → 기록을 따라 닿은 자리를 다시 판정", () => {
  const body = routeBody(read("src/terminal/terminal-files.ts"), 'app.get("/api/ui/terminal/browse/moved"');
  before(body, 'rootKey !== "personal"', "resolveBrowse(", "공유·개인 밖(앱 폴더 등)은 판정 전에 404");
  before(body, "await resolveBrowse(req, true)", "followMoves(", "옛 경로를 판정하기 전에 기록을 본다(존재 오라클)");
  before(body, "await fsExists(osUser, abs)", "followMoves(", "옛 자리에 실제 파일이 있어도 따라간다");
  assert.match(body, /visible: \(p\) => !gate \|\| gate\.ok\(p\)/, "닿은 자리를 이 사람 기준으로 다시 판정하지 않는다");
  assert.match(body, /await assertJailed\(base, at, osUser\)/, "따라가 닿은 자리가 링크로 바깥을 가리켜도 연다");
});

test("W5 링크 착지 화면 — 못 찾으면 옛 링크 풀기를 물어 새 자리로 넘긴다(한 번만, 주소는 replace)", () => {
  const fp = read("web/filepage.ts");
  const nf = fp.slice(fp.indexOf("if (!entry) {"), fp.indexOf("if (entry.type === 'dir')"));
  assert.match(nf, /const to = arrived \? null : await movedTo\(root, rel\);/, "넘어온 자리에서 또 따라가면 고리가 생긴다");
  assert.match(nf, /location\.replace\(fileLinkHash\(root, to\)\)/, "새 자리로 넘기지 않는다(또는 뒤로가기에 옛 주소를 남긴다)");
  before(nf, "await movedTo(", "이 링크의 대상을 찾을 수 없어요", "못 찾음 안내를 먼저 그리고 넘긴다");
  assert.match(fp, /api\('\/api\/ui\/terminal\/browse\/moved\?' \+ browseQs\(root, rel\)\)/);
});

test("W6 새 표 — 스키마 체인에 등록(소스 표 뒤) · db_query 로는 못 읽는다(잠긴 폴더 안 이름이 남는다)", () => {
  const schema = read("src/v6/schema.ts");
  const fn = schema.slice(schema.indexOf("export async function initV6Schema"));
  const chain = [...fn.matchAll(/await (initV6\w+)\(pool\)/g)].map((m) => m[1]);
  assert.ok(chain.includes("initV6FileMove"), "스키마 체인에 없다 — 새 표가 안 생긴다");
  assert.ok(chain.indexOf("initV6FileMove") > chain.indexOf("initV6GraphSource"), "신규 조각은 기존 조각 뒤(순서 규약)");
  assert.equal(isSystemDeniedTable("file_move"), true);
});
