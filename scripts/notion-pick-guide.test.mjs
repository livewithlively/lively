// 노션 페이지 고르기 안내 · 모은 페이지 수 계약 (#1968, 2026-09-15 원준 결정).
//
//  노션 동의 화면의 선택기는 최근·즐겨찾기 몇 개와 검색창뿐이고 «전체 선택»이 없다. 원준이 처음 설정에서 목록이 다 뜰 줄 알고
//  들어갔다가 페이지를 하나씩 검색해 골랐다. 이 파일은 세 결정을 잠근다.
//   ① 두 화면(처음 설정·외부 앱 연결)이 **같은 안내 문장**(notion-pick.ts 한 벌)을 쓴다.
//   ② 처음 설정의 목업이 체크박스 목록이 아니라 실제 화면(추가 줄·검색창·Recents)을 그린다.
//   ③ 모은 페이지 수는 켜졌고·첫 수집이 끝났고·수를 아는 워크스페이스만 더한다(끝나기 전의 0 을 «0개»로 말하지 않는다).
//  ①② 는 소스 계약(주석은 계약이 아니라 줄 단위로 걷어내고 본다), ③ 은 빌드된 모듈을 실제로 불러 행위로 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = (rel) => readFileSync(path.join(ROOT, rel), "utf8")
  .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
const PICK = code("web/v2/notion-pick.ts");
const ONB = code("web/v2/onboarding.ts");
const CON = code("web/v2/connect.ts");
const M = await import(pathToFileURL(path.join(ROOT, "public/app/v2/notion-pick.js")).href);

test("배선 · 소스 세 벌과 빌드된 모듈을 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(PICK.length > 200 && ONB.length > 10000 && CON.length > 10000);
  assert.equal(typeof M.notionCollectedPages, "function");
  assert.equal(typeof M.notionCollectedLine, "function");
});

test("① 안내 문장은 한 벌이다 — 두 화면이 notion-pick.ts 의 NOTION_PICK_TIP 을 가져다 쓴다", () => {
  assert.equal(M.NOTION_PICK_TIP, "노션 화면엔 «전체 선택»이 없어요. 사이드바 맨 위 페이지만 검색해서 고르면 그 아래 페이지는 전부 함께 들어옵니다.",
    "승인된 안내 문장이 바뀌었다");
  for (const [name, src] of [["onboarding.ts", ONB], ["connect.ts", CON]]) {
    assert.match(src, /import \{[^}]*\bNOTION_PICK_TIP\b[^}]*\} from '\.\/notion-pick\.js'/, `${name} 가 안내 문장을 가져오지 않는다`);
    assert.ok((src.match(/\bNOTION_PICK_TIP\b/g) || []).length >= 2, `${name} 가 안내 문장을 화면에 쓰지 않는다`);
    assert.ok(!src.includes("사이드바 맨 위 페이지만 검색해서"), `${name} 에 문장이 복제돼 있다 — 한 벌에서 가져와야 두 화면의 말이 갈라지지 않는다`);
  }
});

test("② 처음 설정 목업은 실제 노션 화면이다 — 체크박스 목록을 그리지 않는다", () => {
  assert.ok(!ONB.includes("☑ 회사 위키"), "체크박스 목록 목업이 되살아났다 — 노션 선택 화면엔 체크박스 목록이 없다");
  assert.ok(ONB.includes('class="ob-npick"'), "노션 선택 화면 목업(ob-npick)이 없다");
  for (const s of ["페이지와 데이터베이스 추가", "페이지 및 데이터베이스 검색", "Recents"]) {
    assert.ok(ONB.includes(s), `실제 화면의 «${s}» 가 목업에 없다`);
  }
});

const ws = (enabled, first_sync_done, pages) => ({ enabled, first_sync_done, pages });

test("③ W1 상태가 없거나 워크스페이스가 없으면 수를 말하지 않는다", () => {
  assert.equal(M.notionCollectedPages(null), null);
  assert.equal(M.notionCollectedPages({ workspaces: [] }), null);
});
test("③ W2 켜졌지만 첫 수집 전이면 0 이어도 말하지 않는다", () => {
  assert.equal(M.notionCollectedPages({ workspaces: [ws(true, false, 0)] }), null);
});
test("③ W3 꺼진 워크스페이스는 끝났어도 세지 않는다", () => {
  assert.equal(M.notionCollectedPages({ workspaces: [ws(false, true, 3)] }), null);
});
test("③ W4 끝났지만 셀 수 없었으면(pages=null) 말하지 않는다", () => {
  assert.equal(M.notionCollectedPages({ workspaces: [ws(true, true, null)] }), null);
});
test("③ W5 끝났는데 0 이면 0 을 말한다(경계값)", () => {
  assert.equal(M.notionCollectedPages({ workspaces: [ws(true, true, 0)] }), 0);
});
test("③ W6 끝난 워크스페이스끼리 더한다", () => {
  assert.equal(M.notionCollectedPages({ workspaces: [ws(true, true, 3), ws(true, true, 4)] }), 7);
});
test("③ W7 끝나기 전인 곳은 빼고 더한다", () => {
  assert.equal(M.notionCollectedPages({ workspaces: [ws(true, true, 3), ws(true, false, 0)] }), 3);
});

test("③ 문장 — 1개 이상이면 수를, 0 이면 «아직 하나도 못 모았다»를 말한다(«0개를 모았어요» 금지)", () => {
  assert.equal(M.notionCollectedLine(1234), "노션 페이지 1,234개를 모았어요.");
  assert.ok(!M.notionCollectedLine(0).includes("0개"), "0 을 «0개를 모았어요»로 말한다");
});

test("③ 배선 — 두 화면이 모은 페이지 수와 그 문장을 실제로 쓴다", () => {
  for (const [name, src] of [["onboarding.ts", ONB], ["connect.ts", CON]]) {
    assert.match(src, /notionCollectedPages\(/, `${name} 가 모은 페이지 수를 쓰지 않는다`);
    assert.match(src, /notionCollectedLine\(/, `${name} 가 모은 페이지 수 문장을 쓰지 않는다`);
  }
});
