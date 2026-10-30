// 자료 사이드바 3판: 들어온 길로 나눈다(#4233, 원준 2026-09-26). 엣지 표 E · G · S · O · P · F · W(scratchpad/spec-4233-sources-origin.md).
//  원준: "1. 올린 자료 2. 수집한 자료 3. 라이블리에서 만들어진 자료 이렇게 나누면 MECE한가?"
//  규칙은 세 벌의 순수 모듈이다: 서버 갈래 판정(v6/source-group.ts) · 올릴 때의 들어온 길(ingest/upload-entry.ts) ·
//   화면 계획(web/v2/sources-plan.ts). 화면 모듈과 라우트는 DOM · express 바운드라 배선만 소스에서 못박는다.
//  SQL 의 실제 결과(나무 group · 목록 group 거르개)는 source-tree.pg-test.mjs 가 실 DB 로 잡는다.
//  ⚠ web 은 dist 로 굽히지 않는다: 순수 모듈의 소스를 TypeScript 로 옮긴 뒤 불러온다(category-groups-sidebar.test.ts 와 같은 방법).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { SOURCE_GROUPS, SOURCE_GROUP_CASE, sourceGroupOf, sourceGroupWhere } from "./source-group.js";
import { uploadEntryOf, keepEntry, entryFields, PERSON_UPLOAD } from "../ingest/upload-entry.js";

const read = (p: string): string => readFileSync(p, "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let plan: any = null;
async function loadPlan() {
  if (plan) return plan;
  const js = ts.transpileModule(read("web/v2/sources-plan.ts"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  plan = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  return plan;
}
const person = (name: string) => name.split("@")[0];

// ── E: 올릴 때의 들어온 길 ─────────────────────────────────────────────────────
test("E1~E5 세션 헤더가 형식에 맞을 때만 AI 가 만든 파일이다", () => {
  assert.deepEqual(uploadEntryOf({}), { kind: "upload" }, "E1 헤더 없음(브라우저)");
  assert.deepEqual(uploadEntryOf(undefined), { kind: "upload" });
  assert.deepEqual(uploadEntryOf({ "x-lively-session": "box-sangmin-1a2b3c4d" }), { kind: "generated", session: "box-sangmin-1a2b3c4d" }, "E2 관리형 세션");
  assert.deepEqual(uploadEntryOf({ "x-lively-session": "claude-abc123" }), { kind: "generated", session: "claude-abc123" }, "E3 외부 하네스");
  for (const bad of ["../x", "a b", "", "${LIVELY_SESSION_ID}", "box-sangmin"])
    assert.deepEqual(uploadEntryOf({ "x-lively-session": bad }), { kind: "upload" }, `E4 형식 틀림 ${JSON.stringify(bad)}`);
  assert.deepEqual(uploadEntryOf({ "x-lively-session": ["codex-t1", "../x"] }), { kind: "generated", session: "codex-t1" }, "E5 배열이면 첫 값");
  assert.deepEqual(PERSON_UPLOAD, { kind: "upload" }, "E6 세션 입력칸 첨부는 사람이 올린 것");
});

test("E7~E9 처음 적힌 길을 지킨다 · 값 없는 옛 행만 이번 값을 받는다", () => {
  const ai = { kind: "generated" as const, session: "box-a-1a2b3c4d" };
  assert.deepEqual(keepEntry({ entry: "upload" }, ai), { kind: "upload" }, "E7 사람이 올린 파일을 AI 가 다시 올려도 올린 자료");
  assert.deepEqual(keepEntry({ entry: "generated", entry_session: "box-b-00000000" }, { kind: "upload" }), { kind: "generated", session: "box-b-00000000" }, "E8");
  assert.deepEqual(keepEntry({ entry: null }, ai), ai, "E9 옛 행");
  assert.deepEqual(keepEntry(undefined, ai), ai, "새 행");
  assert.deepEqual(keepEntry({ entry: "weird" }, { kind: "upload" }), { kind: "upload" }, "모르는 값은 없는 것과 같다");
  assert.deepEqual(entryFields(ai), { entry: "generated", entry_session: "box-a-1a2b3c4d" });
  assert.deepEqual(entryFields({ kind: "upload", session: "box-a-1a2b3c4d" }), { entry: "upload" }, "올린 파일엔 세션을 적지 않는다");
});

// ── G: 갈래 판정(서버) ─────────────────────────────────────────────────────────
test("G1~G5 자료 한 건은 갈래 하나: 파일은 entry='generated' 일 때만 AI 가 만든 것", () => {
  assert.equal(sourceGroupOf({ external_system: "local", fields: {} }), "uploaded", "G1 옛 행");
  assert.equal(sourceGroupOf({ external_system: "local", fields: null }), "uploaded");
  assert.equal(sourceGroupOf({ external_system: "local", fields: { entry: "weird" } }), "uploaded", "G2");
  assert.equal(sourceGroupOf({ external_system: "local", fields: { entry: "upload" } }), "uploaded");
  assert.equal(sourceGroupOf({ external_system: "local", fields: { entry: "generated" } }), "made_ai", "G3");
  assert.equal(sourceGroupOf({ external_system: null, fields: { entry: "generated" } }), "made_note", "G4");
  for (const sys of ["slack", "domain-wiki", "github", "discord"]) assert.equal(sourceGroupOf({ external_system: sys }), "collected", `G5 ${sys}`);
});

test("G6~G8 SQL 술어: 네 갈래 + made, 행 안의 비교뿐(나무 집계에 서브쿼리를 넣지 않는다)", () => {
  for (const g of [...SOURCE_GROUPS, "made"]) {
    const w = sourceGroupWhere(g);
    assert.ok(w, g);
    assert.doesNotMatch(w!, /SELECT|EXISTS|\bIN\s*\(/i, `${g} 술어에 서브쿼리`);
  }
  assert.equal(sourceGroupWhere("nope"), null, "G8 모르는 값은 거르지 않는다(입력 스키마가 먼저 막는다)");
  assert.equal(sourceGroupWhere(undefined), null);
  assert.match(sourceGroupWhere("made")!, /IS NULL OR/, "G7 made = 직접 적은 글 + AI 파일");
  assert.match(sourceGroupWhere("uploaded")!, /IS DISTINCT FROM 'generated'/, "옛 행(값 없음)도 올린 자료");
  //  CASE 는 위에서부터 한 번만 맞는다: 직접 적은 글 → AI 파일 → 올린 파일 → 나머지 순서여야 한다.
  const at = (k: string) => SOURCE_GROUP_CASE.indexOf(k);
  assert.ok(at("'made_note'") < at("'made_ai'") && at("'made_ai'") < at("'uploaded'") && at("'uploaded'") < at("'collected'"), SOURCE_GROUP_CASE);
  assert.doesNotMatch(SOURCE_GROUP_CASE, /SELECT/i);
});

// ── S: 사이드바 계획 ───────────────────────────────────────────────────────────
const NODES = [
  { system: "local", container: "uploads", group: "uploaded", n: 90 },
  { system: "local", container: "assets", group: "uploaded", n: 10 },
  { system: "local", container: "assets", group: "made_ai", n: 7 },
  { system: "authored", container: "transcript", group: "made_note", n: 13 },
  { system: "authored", container: "minutes", group: "made_note", n: 4 },
  { system: "github", container: "lively", group: "collected", n: 30 },
  { system: "discord", container: "general", group: "collected", n: 51 },
  { system: "slack", container: "ui-수정", group: "collected", n: 9 },
  { system: "slack", container: "dev", group: "collected", n: 20 },
  { system: "slack", container: null, group: "collected", n: 3 },
  { system: "zeta", container: "x", group: "collected", n: 1 },
];
const UPS = [{ name: "a@x.io", id: "a", n: 20 }, { name: "b@x.io", id: "b", n: 79 }, { name: null, id: null, n: 1 }];

test("G6 · S1~S3 카드 셋의 합이 모든 자료다 · 앱 차례 · 자리 없는 가지 · 사람 차례", async () => {
  const { planSourcesSide } = await loadPlan();
  const p = planSourcesSide(NODES, UPS);
  assert.equal(p.total, 238);
  assert.equal(p.uploaded.n + p.collected.n + p.made.n, p.total, "G6 MECE");
  assert.equal(p.uploaded.n, 100);
  assert.deepEqual([p.made.ai, p.made.note, p.made.n], [7, 17, 24]);
  assert.deepEqual(p.collected.apps.map((a: { system: string }) => a.system), ["slack", "discord", "github", "zeta"], "S3 대화 → 기록계 → 모르는 앱");
  const slack = p.collected.apps[0];
  assert.equal(slack.n, 32, "자리 없는 가지도 앱 수에 든다");
  assert.deepEqual(slack.containers, [{ name: "dev", n: 20 }, { name: "ui-수정", n: 9 }], "자리 없는 가지는 줄을 만들지 않는다");
  assert.deepEqual(p.uploaded.people.map((u: { id: string }) => u.id), ["b", "a"], "S2 많은 순");
  assert.equal(p.uploaded.unnamed, 1, "S2 이름 없는 것은 따로 센다");
  const empty = planSourcesSide([], null);
  assert.deepEqual([empty.total, empty.uploaded.n, empty.collected.apps.length, empty.made.n], [0, 0, 0, 0], "S1 빈 나무");
});

test("S 옛 서버(가지에 group 없음)면 출처로 짐작한다: 파일은 전부 올린 자료", async () => {
  const { planSourcesSide } = await loadPlan();
  const p = planSourcesSide(NODES.map(({ group: _g, ...n }) => n), []);
  assert.deepEqual([p.uploaded.n, p.made.ai, p.made.note, p.collected.n], [107, 0, 17, 114]);
});

test("S4 · S5 옛 주소를 새 자리로 · 사이드바에서 켜질 줄", async () => {
  const { normalizeSel, sideSel, showsUploaderFilter } = await loadPlan();
  assert.deepEqual(normalizeSel({ system: "local", author: "a@x.io" }), { group: "uploaded", author: "a@x.io" }, "S4 내가 올린 것");
  assert.deepEqual(normalizeSel({ system: "local", root: "project" }), { group: "uploaded" }, "S4 프로젝트에 올린 것");
  assert.deepEqual(normalizeSel({ system: "local" }), { group: "uploaded" }, "S4 팀 전체");
  assert.deepEqual(normalizeSel({ linked: true }), { linked: true }, "지식이 된 것");
  assert.deepEqual(normalizeSel({ system: "authored", container: "transcript" }), { group: "made_note" }, "S5");
  assert.deepEqual(normalizeSel({ system: "slack", group: "uploaded", container: "dev" }), { system: "slack", container: "dev" }, "앱을 고르면 갈래는 저절로");
  assert.deepEqual(normalizeSel({ group: "nope" }), {}, "모르는 갈래는 버린다");
  assert.deepEqual(sideSel({ group: "uploaded", author: "a", linked: true, q: "x" }), { group: "uploaded", author: "a" });
  assert.deepEqual(sideSel({ author: "a" }), {}, "모든 자료에서 사람으로 걸러도 켜진 줄은 모든 자료");
  assert.deepEqual(sideSel({ system: "slack", container: "dev", linked: true }), { system: "slack", container: "dev" });
  assert.equal(showsUploaderFilter({}), true, "F1 모든 자료");
  assert.equal(showsUploaderFilter({ group: "uploaded" }), true, "F1 올린 자료");
  for (const s of [{ group: "collected" }, { system: "slack" }, { group: "made" }, { group: "made_ai" }, { group: "made_note" }])
    assert.equal(showsUploaderFilter(s), false, `F1 ${JSON.stringify(s)}`);
});

// ── O · P: 원천 칸 · 올린 곳 한 줄 ────────────────────────────────────────────
test("O1~O4 원천 칸", async () => {
  const { originOf } = await loadPlan();
  const who = (n: string, id: string) => (id === "sangmin-yoon" ? "윤상민" : person(n));
  assert.deepEqual(originOf({ external_system: "local", fields: { author_name: "sangmin.yoon@lvly.io", author_external_id: "sangmin-yoon" } }, who),
    { kind: "person", text: "윤상민", id: "sangmin-yoon" }, "O1");
  assert.deepEqual(originOf({ external_system: "local", fields: {} }, who), { kind: "person", text: "올린 사람 기록 없음" }, "O1 없음");
  const ai = (f: Record<string, unknown>) => originOf({ external_system: "local", external_id: "project:4104/a.html", fields: { entry: "generated", ...f } }, who).text;
  assert.equal(ai({ root: "project", project_name: "모바일 대응", container_ref: "project:4104" }), "AI 세션 · 모바일 대응", "O2");
  assert.equal(ai({ root: "project" }), "AI 세션 · 프로젝트 #4104", "O2 이름 없음(옛 행)");
  assert.equal(ai({ root: "personal" }), "AI 세션 · 개인 폴더", "O2 개인 폴더");
  assert.equal(originOf({ external_system: "slack", fields: { container_name: "ui-수정" } }, who).text, "슬랙 · #ui-수정", "O3");
  assert.equal(originOf({ external_system: "github", fields: { container_name: "lively" } }, who).text, "깃허브 · lively");
  assert.equal(originOf({ external_system: "slack", fields: {} }, who).text, "슬랙");
  assert.equal(originOf({ external_system: null, kind: "transcript", fields: {} }, who).text, "직접 적은 글 · 전사록", "O4");
});

test("P1~P5 올린 곳 · 만든 곳 · 가져온 곳 한 줄", async () => {
  const { placeLine } = await loadPlan();
  const up = (f: Record<string, unknown>) => placeLine({ external_system: "local", fields: f });
  const P = { root: "project", project_name: "모바일 대응", container_ref: "project:4104" };
  assert.equal(up({ ...P, path: "a.pdf" }), "올린 곳: 프로젝트 「모바일 대응」 폴더", "P1");
  assert.equal(up({ ...P, path: "assets/a.png" }), "올린 곳: 프로젝트 「모바일 대응」 폴더 assets/");
  assert.equal(up({ ...P, path: "_attachments/task-12/a.pdf" }), "올린 곳: 프로젝트 「모바일 대응」 태스크 첨부");
  assert.equal(up({ ...P, path: "_attachments/project-4104/a.pdf" }), "올린 곳: 프로젝트 「모바일 대응」 본문 첨부");
  assert.equal(up({ root: "project", container_ref: "project:77", path: "a.pdf" }), "올린 곳: 프로젝트 #77 폴더");
  assert.equal(up({ root: "personal", path: "uploads/a.pdf" }), "올린 곳: 개인 폴더 uploads/", "P2");
  assert.equal(up({ root: "shared", path: "a.pdf" }), "올린 곳: 공유 폴더");
  assert.equal(up({ ...P, entry: "generated", path: "review.html" }), "만든 곳: AI 세션 · 프로젝트 「모바일 대응」 폴더", "P3");
  assert.equal(placeLine({ external_system: null, kind: "minutes", fields: {} }), "만든 곳: 라이블리에 직접 적은 글(회의록)", "P4");
  assert.equal(placeLine({ external_system: "discord", fields: { container_name: "general" } }), "가져온 곳: 디스코드 · #general", "P5");
});

test("목록 머리 경로", async () => {
  const { crumbOf } = await loadPlan();
  assert.deepEqual(crumbOf({}, person), { dim: [], last: "모든 자료" });
  assert.deepEqual(crumbOf({ author: "a@x.io" }, person), { dim: ["모든 자료"], last: "a" });
  assert.deepEqual(crumbOf({ group: "uploaded", author: "a@x.io" }, person), { dim: ["올린 자료"], last: "a" });
  assert.deepEqual(crumbOf({ system: "slack", container: "dev" }, person), { dim: ["수집한 자료", "슬랙"], last: "#dev" });
  assert.deepEqual(crumbOf({ system: "github" }, person), { dim: ["수집한 자료"], last: "깃허브" });
  assert.deepEqual(crumbOf({ group: "made_ai" }, person), { dim: ["라이블리에서 만든 자료"], last: "AI가 만든 파일" });
  assert.deepEqual(crumbOf({ q: "보고서", group: "uploaded" }, person), { dim: ["찾기"], last: "보고서" });
});

// ── W: 배선 ────────────────────────────────────────────────────────────────────
test("W1 옛 네 줄이 사라지고 세 카드가 선다", () => {
  const SRC = read("web/v2/sources.ts"), SIDE = read("web/v2/side.ts");
  //  줄 문구(문자열 값)만 본다: 머리말 주석은 옛 줄을 이름으로 부른다.
  for (const old of ["'내가 올린 것'", "'프로젝트에 올린 것'", "'팀 전체'", "label: '지식이 된 것'", "'내 자료'", "'수집함'"])
    assert.ok(!SRC.includes(old) && !SIDE.includes(old), `옛 줄 «${old}» 이 남았다`);
  for (const card of ["'올린 자료'", "'수집한 자료'", "'라이블리에서 만든 자료'", "'AI가 만든 파일'", "'직접 적은 글'", "'모든 자료'"])
    assert.ok(SIDE.includes(card), `사이드바에 ${card} 가 없다`);
  assert.match(SIDE, /function renderSourcesSection[\s\S]*?fitWikiList\(/, "자료 사이드바가 위키와 같은 줄 나누기를 안 쓴다");
  assert.match(SRC, /originOf\(/, "목록 줄에 원천 칸이 없다");
  assert.match(SRC, /placeLine\(/, "원문에 올린 곳 한 줄이 없다");
  assert.match(SRC, /showsUploaderFilter\(/, "올린 사람 거르개가 없다");
});

test("W2 업로드 입구가 모두 들어온 길을 넘긴다", () => {
  const TF = read("src/terminal/terminal-files.ts");
  assert.equal(TF.match(/entry: uploadEntryOf\(req\.headers\)/g)?.length, 3, "브라우즈 · 노드 세션 · 세션 업로드");
  assert.match(read("src/project/project-routes.ts"), /entry: uploadEntryOf\(req\.headers\)/, "프로젝트 업로드(up-sync 훅)");
  assert.match(read("src/project/attach-relocate.ts"), /entry: PERSON_UPLOAD/, "세션 입력칸 첨부");
  assert.match(read("src/ingest/upload-finish.ts"), /entry: o\.entry/);
  const ING = read("src/ingest/local-file.ts");
  assert.ok(ING.indexOf("keepEntry(") > 0 && ING.indexOf("keepEntry(") < ING.indexOf("await mirrorSourceV6("), "처음 적힌 길을 mirror 전에 읽어야 한다");
});
