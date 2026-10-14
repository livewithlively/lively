// 프로젝트 폴더에서 여는 세션은 그 프로젝트에 묶인다 — 좌표 판정 · 후보 고르기 · 배선 (#4551).
//
//  사양: 홈 입구로 세션을 열 때 좌표(rootKey · subpath)가 공유 루트의 프로젝트 폴더(또는 그 안)이면, 그 폴더의 프로젝트를
//   **여는 사람이 볼 수 있을 때** 그 프로젝트 소속으로 연다. 볼 수 없거나 · 없거나 · 휴지통에 있거나 · 어느 것인지 모르면
//   종전대로 소속 없이 연다. 이미 프로젝트가 정해졌거나 사람의 작업 세션이 아니면 건드리지 않는다.
//
//  엣지 표(입력 → 기대).
//   C1 shared · `project/3516`                      → `project/3516`
//   C2 shared · `project/3516/lively`(하위 폴더)     → `project/3516`
//   C3 shared · `legacy-project/old`(보관된 프로젝트) → `legacy-project/old`
//   C4 앞의 구분자 · 끝 슬래시                       → 같은 폴더(폴더를 여는 쪽도 그렇게 읽는다)
//   C8 ★ 역슬래시 · 앞뒤 공백 · NUL 이 든 좌표        → null(폴더를 여는 쪽은 그걸 **다른 폴더**로 읽는다 — 낯선 폴더에 소속을 붙이지 않는다)
//   C9 이름 가운데 공백                              → 폴더 이름의 일부
//   C5 rootKey 가 shared 가 아님(personal · 빈 값 · null · 대문자) → null
//   C6 프로젝트 폴더가 아님: `project`(이름 없음) · `projects/1` · `team/project/1` · 빈 값 · null → null
//   C7 탈출 조각: `project/../secret` · `project/./x` · `project//x` · `../project/1` → null
//   P1 후보 하나(살아 있음) → 그 id / P2 후보 없음 → null
//   P3 휴지통 것만 → null / P4 살아 있는 것 하나 + 휴지통 하나(같은 폴더의 양형) → 살아 있는 것
//   P5 살아 있는 것이 둘 → null(어느 쪽인지 지어내지 않는다)
//   B1 보이는 프로젝트 → 그 id / B2 ★ 안 보이는 프로젝트 → null / B3 viewer null(전체 열람) → 보임 검사에 null 을 그대로 넘긴다
//   B4 프로젝트 폴더가 아닌 좌표 → 조회조차 안 한다 / B5 후보가 둘 · 휴지통뿐 → null(보임 검사도 안 한다)
//   B6 조회가 던지면 null 이고 알린다 / B7 보임 검사가 던져도 null / B8 folder 는 좌표의 것 그대로 넘긴다(반대 꼴로 안 바꾼다)
//   W1 배선 — 홈 입구가 프로젝트를 만들기(firstPromptProjectPlan) **전에** 좌표로 소속을 정한다
//   W2 배선 — 이미 projectId 가 있으면 · 사람의 작업 세션이 아니면 · 노드에서 여는 세션이면 묻지 않는다
//   W3 배선 — 조회는 보는 사람(viewerOf)으로 하고, 보임 검사(canSeeProjectRow)를 지난다
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickFolderProject, projectFolderOfCoord, projectIdForSessionCoord, type FolderBindDeps } from "./folder-bind.js";

// ── C. 좌표 → 프로젝트 폴더 ──
assert.equal(projectFolderOfCoord("shared", "project/3516"), "project/3516", "C1 프로젝트 폴더");
assert.equal(projectFolderOfCoord("shared", "project/3516/lively"), "project/3516", "C2 하위 폴더도 그 프로젝트다");
assert.equal(projectFolderOfCoord("shared", "project/3516/a/b/c"), "project/3516", "C2 깊은 하위 폴더");
assert.equal(projectFolderOfCoord("shared", "legacy-project/old"), "legacy-project/old", "C3 보관된 프로젝트 폴더");
//  앞의 구분자와 끝의 슬래시는 폴더를 여는 쪽(resolveRootPath · path.resolve)도 같은 폴더로 읽는다.
for (const sp of ["/project/3516", "project/3516/", "//project/3516//", "\\project/3516"]) {
  assert.equal(projectFolderOfCoord("shared", sp), "project/3516", `C4 앞 구분자 · 끝 슬래시는 같은 폴더다(${JSON.stringify(sp)})`);
}
//  ★ 폴더를 여는 쪽이 **다른 폴더로** 읽는 꼴은 프로젝트 폴더가 아니다 — 여기서 너그럽게 읽으면 낯선 폴더에 소속이 붙는다.
for (const sp of ["project\\3516", "\\project\\3516\\lively", "  project/3516  ", " project/3516", "project/3516 ", "project/ 3516", "project/3516\\x", "project/35\0 16", "project/3516/a b /c "]) {
  assert.equal(projectFolderOfCoord("shared", sp), null, `C8 ★★ 역슬래시 · 앞뒤 공백 · NUL 이 든 좌표는 읽지 않는다(${JSON.stringify(sp)})`);
}
assert.equal(projectFolderOfCoord("shared", "project/my project/sub dir"), "project/my project", "C9 이름 가운데의 공백은 폴더 이름의 일부다");
assert.equal(projectFolderOfCoord(" shared ", "project/3516"), null, "C5 rootKey 는 다듬지 않는다(루트 조회가 그 값 그대로 한다)");
for (const rk of ["personal", "", null, undefined, "Shared", "team", "sharedx"]) {
  assert.equal(projectFolderOfCoord(rk as string | null | undefined, "project/3516"), null, `C5 공유 루트가 아니면 null(${JSON.stringify(rk)})`);
}
for (const sp of ["project", "project/", "projects/1", "team/project/1", "myproject/1", "", "   ", null, undefined, "legacy-projects/1"]) {
  assert.equal(projectFolderOfCoord("shared", sp as string | null | undefined), null, `C6 프로젝트 폴더가 아니면 null(${JSON.stringify(sp)})`);
}
for (const sp of ["project/../secret", "project/./x", "project//x", "../project/1", "project/1/../2", "project/.."]) {
  assert.equal(projectFolderOfCoord("shared", sp), null, `C7 ★ 탈출 · 빈 조각이 섞인 좌표는 읽지 않는다(${sp})`);
}

// ── P. 후보 고르기 ──
assert.equal(pickFolderProject([{ id: 3516 }]), 3516, "P1 후보 하나");
assert.equal(pickFolderProject([{ id: 3516, trashed_at: null }]), 3516, "P1 trashed_at 이 null 이면 살아 있다");
assert.equal(pickFolderProject([]), null, "P2 후보가 없으면 null");
assert.equal(pickFolderProject([{ id: 1, trashed_at: "2026-10-01T00:00:00Z" }]), null, "P3 ★ 휴지통의 프로젝트에는 묶지 않는다");
assert.equal(pickFolderProject([{ id: 1, trashed_at: new Date() }, { id: 2 }]), 2, "P4 휴지통 것을 빼고 하나 남으면 그것");
assert.equal(pickFolderProject([{ id: 1 }, { id: 2 }]), null, "P5 ★ 살아 있는 후보가 둘이면 묶지 않는다(어느 쪽인지 지어내지 않는다)");

// ── B. 묶을지 정하기(조회는 가짜) ──
{
  const calls: string[] = [];
  const deps = (o: Partial<FolderBindDeps> & { rows?: Array<{ id: number; trashed_at?: string | null }>; see?: boolean } = {}): FolderBindDeps => ({
    rowsByFolder: o.rowsByFolder ?? (async (folder) => { calls.push("rows:" + folder); return o.rows ?? [{ id: 3516 }]; }),
    canSee: o.canSee ?? (async (id, viewer) => { calls.push(`see:${id}:${viewer === null ? "null" : viewer}`); return o.see ?? true; }),
    warn: o.warn ?? ((_e, folder) => { calls.push("warn:" + folder); }),
  });
  const reset = (): void => { calls.length = 0; };

  reset(); assert.equal(await projectIdForSessionCoord("shared", "project/3516/lively", "wonjoon-jang", deps()), 3516, "B1 보이는 프로젝트의 폴더에서 열면 그 프로젝트");
  assert.deepEqual(calls, ["rows:project/3516", "see:3516:wonjoon-jang"], "B8 조회는 좌표의 폴더 그대로 · 보임 검사는 여는 사람으로");
  reset(); assert.equal(await projectIdForSessionCoord("shared", "project/3516", "sangmin-yoon", deps({ see: false })), null, "B2 ★★ 볼 수 없는 프로젝트에는 묶지 않는다");
  reset(); assert.equal(await projectIdForSessionCoord("shared", "project/3516", null, deps()), 3516, "B3 전체 열람 권한이면 묶는다");
  assert.deepEqual(calls, ["rows:project/3516", "see:3516:null"], "B3 viewer null 을 그대로 넘긴다(보임 검사가 긴급 열람 규칙으로 판정한다)");
  reset(); assert.equal(await projectIdForSessionCoord("personal", "project/3516", "wonjoon-jang", deps()), null, "B4 프로젝트 폴더가 아닌 좌표");
  assert.deepEqual(calls, [], "B4 그때는 조회조차 안 한다");
  reset(); assert.equal(await projectIdForSessionCoord("shared", "project\\3516", "wonjoon-jang", deps()), null, "B4 ★ 역슬래시 좌표도 조회조차 안 한다");
  assert.deepEqual(calls, [], "B4 (조회 0)");
  reset(); assert.equal(await projectIdForSessionCoord("shared", "project/3516", "wonjoon-jang", deps({ rows: [{ id: 1 }, { id: 2 }] })), null, "B5 후보가 둘이면 묶지 않는다");
  assert.deepEqual(calls, ["rows:project/3516"], "B5 어느 쪽인지 모르면 보임 검사도 안 한다");
  reset(); assert.equal(await projectIdForSessionCoord("shared", "project/3516", "wonjoon-jang", deps({ rows: [{ id: 9, trashed_at: "2026-10-01" }] })), null, "B5 휴지통의 프로젝트뿐이면 묶지 않는다");
  reset(); assert.equal(await projectIdForSessionCoord("shared", "project/3516", "wonjoon-jang", deps({ rowsByFolder: async () => { throw new Error("db down"); } })), null, "B6 조회가 던지면 묶지 않는다(세션 생성을 막지 않는다)");
  assert.deepEqual(calls, ["warn:project/3516"], "B6 ★ 그 실패를 알린다 — 조용히 삼키면 «소속 없는 세션» 이 흔적 없이 되돌아온다");
  reset(); assert.equal(await projectIdForSessionCoord("shared", "project/3516", "wonjoon-jang", deps({ canSee: async () => { throw new Error("boom"); } })), null, "B7 보임 검사가 던져도 묶지 않는다");
  assert.deepEqual(calls, ["rows:project/3516", "warn:project/3516"], "B7 그 실패도 알린다");
  reset(); assert.equal(await projectIdForSessionCoord("shared", "legacy-project/old", "wonjoon-jang", deps()), 3516, "B8 보관 폴더 좌표");
  assert.deepEqual(calls[0], "rows:legacy-project/old", "B8 ★ folder 를 반대 꼴(project/old)로 바꿔 찾지 않는다");
}

// ── W. 배선 ──
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string): string => {
  //  dist 에서 돌므로 원본은 src 쪽에서 읽는다. 주석 줄은 걷는다 — 설명에 적힌 낱말이 단언을 통과시키지 않게.
  const raw = readFileSync(path.resolve(here, "../../src", rel), "utf8");
  return raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
};
const ROUTES = src("terminal/routes.ts");
const at = ROUTES.indexOf("projectIdForSessionCoord(input.rootKey, input.subpath, viewerOf(userOf(req)))");
const plan = ROUTES.indexOf("const shellSpec = firstPromptProjectPlan(input);");
assert.ok(at > 0 && plan > 0 && at < plan, "W1 ★ 홈 입구는 프로젝트를 새로 만들기 전에 좌표로 소속을 정한다(순서가 바뀌면 프로젝트 폴더에 새 껍데기가 생긴다)");
assert.match(ROUTES, /if \(!input\.projectId && isWorkSession\(input\.kind\) && !String\(b\.node \?\? ""\)\.trim\(\)\) \{\s*const pid = await projectIdForSessionCoord\(/, "W2 이미 소속이 있거나 · 사람의 작업 세션이 아니거나 · 노드에서 여는 세션이면 묻지 않는다");
assert.match(ROUTES, /if \(pid\) \{ input\.projectId = pid; input\.projectSrc = "v6"; \}/, "W2 찾았을 때만 소속을 적는다");
const BIND = src("project/folder-bind.ts");
assert.match(BIND, /WHERE folder = \$1 AND level='project'/, "W3 실제 조회는 folder 를 정확히 맞춘다");
assert.match(BIND, /const v = await effectiveViewer\(viewer\); return v === null \|\| \(await canSeeProjectRow\(id, v\)\);/, "W3 실제 보임 검사는 프로젝트 입구(projBase)와 같은 문이다");

console.log("folder-bind: ok");
