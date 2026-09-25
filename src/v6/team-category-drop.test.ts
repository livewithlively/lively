// 분류를 팀에 할당하는 개념 제거(#4233, 원준 2026-09-25 «분류체계를 특정 팀에 할당한다는 개념 자체를 다 없애버리면 좋겠어 · 전부 걷을거임»).
//  사양 엣지 표 D1–D2 · T1–T4 · I1–I3 · W1–W2 에 한 행씩. 순수 함수(substituteBlocks)는 값으로, DB·DOM 경로는 소스·레지스트리로 못박는다.
//  ⚠ 주석 줄은 빼고 본다 — «걷었다» 를 설명하는 주석이 단언을 통과시키면 그 시험은 아무것도 안 잡는다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registry } from "../capabilities/index.js";
import { substituteBlocks, type CategoryMapEntry } from "../org/delivery/knowledge-index.js";

const code = (p: string): string => readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("D1 부팅 스키마가 team_category 를 지운다 — 만들지 않는다", () => {
  const src = code("src/v6/schema/category-team.ts");
  assert.match(src, /DROP TABLE IF EXISTS team_category;/);
  assert.doesNotMatch(src, /CREATE TABLE IF NOT EXISTS team_category/);
  assert.match(src, /CREATE TABLE IF NOT EXISTS team\(/, "팀 표는 남는다");
  assert.match(src, /CREATE TABLE IF NOT EXISTS team_member\(/, "팀원 표는 남는다");
});

test("D2 self-source 허용 목록에 team_category 가 없다 — team · team_member 는 남는다", () => {
  const src = code("src/db/self/self-source.ts");
  assert.doesNotMatch(src, /"team_category"/);
  assert.match(src, /"team", "team_member"/);
});

test("T1 도구 표면에 분류 담당 도구가 없다 — 팀 도구는 남는다", () => {
  assert.equal(registry.get("team_set_category"), undefined);
  assert.equal(registry.get("category_set_owner"), undefined);
  for (const n of ["team_list", "team_get", "team_create", "team_update", "team_delete", "team_set_members"]) assert.ok(registry.get(n), n + " 는 남는다");
  const snap = readFileSync("src/capabilities/surface-snapshot.json", "utf8");
  assert.doesNotMatch(snap, /"team_set_category"|"category_set_owner"/);
});

test("T2 category_list 행에 오너 팀 칸이 없다(스토어에 team_category 조인 없음)", () => {
  const src = code("src/v6/category-store.ts");
  assert.doesNotMatch(src, /team_category|owner_team_/);
});

test("T3 whoami · me 에 팀 카테고리 칸이 없다 — 팀은 남는다", async () => {
  const ghost = { userId: "__no_such_member_4233__", email: "ghost@example.invalid", scopes: ["memory"], projects: ["*"], tokenSource: "db" } as never;
  const w = await registry.get("whoami")!.handler({}, ghost) as Record<string, unknown>;
  assert.equal("categories" in w, false);
  assert.ok(Array.isArray(w.teams));
  const m = await registry.get("me")!.handler({}, ghost) as Record<string, unknown>;
  assert.equal("team_category_ids" in m, false);
  assert.equal("team_owner_category_ids" in m, false);
  assert.ok(Array.isArray(m.teams));
});

test("T4 검토 대기 요약에 «내 도메인» 칸이 없다 — 전체 · 카테고리별은 남는다", () => {
  const cap = code("src/capabilities/knowledge/review.ts");
  assert.doesNotMatch(cap, /mine_category_keys|memberCategories/);
  assert.match(cap, /return \{ \.\.\.counts, by_category \};/);
  const store = code("src/v6/knowledge-revision-store.ts");
  assert.doesNotMatch(store, /mine_new|mine_edit|mine_total|n_new_mine|n_edit_mine/);
  assert.match(store, /return \{ new: nNew, edit: nEdit, total: nNew \+ nEdit \};/);
});

test("I1 주입의 팀 층은 팀 이름 줄만 — 소유/이해관계 카테고리 · ★ 안내가 없다", () => {
  const src = code("src/org/delivery/publish.ts");
  const fn = src.slice(src.indexOf("async function buildTeamBlock("), src.indexOf("\n}\n", src.indexOf("async function buildTeamBlock(")));
  assert.ok(fn.length > 0, "buildTeamBlock 이 있다");
  assert.match(fn, /## 우리 팀/);
  assert.doesNotMatch(fn, /소유 카테고리|이해관계 카테고리|★|memberCategories/);
  const out = substituteBlocks("앞\n\n${team}\n\n뒤", { team: "## 우리 팀\n- **팀:** 근로팀" });
  assert.match(out, /- \*\*팀:\*\* 근로팀/);
});

test("I2 팀 소속이 없으면 ${team} 은 빈 글로 바뀐다 — 문자 ${team} 이 남지 않는다", () => {
  const consumedTeam = { v: false };
  const out = substituteBlocks("앞\n\n${team}\n\n뒤", { team: "", consumedTeam });
  assert.doesNotMatch(out, /\$\{team\}/);
  assert.equal(consumedTeam.v, true, "섹션이 ${team} 자리를 썼다는 신호는 그대로");
  const pub = code("src/org/delivery/publish.ts");
  assert.match(pub, /const team = memberId \? await buildTeamBlock\(memberId\) : "";/);
});

test("I3 카테고리 지도는 들어온 순서 그대로 — ★ · «내 것 먼저» 가 없다", () => {
  const map = [
    { key: "a", name: "가", active_units: 3 },
    { key: "b", name: "나", active_units: 0, mine: true },
  ] as unknown as CategoryMapEntry[];
  const out = substituteBlocks("${categories}", { categoryMap: map });
  assert.doesNotMatch(out, /★/);
  assert.ok(out.indexOf("- a — 가") >= 0 && out.indexOf("- a — 가") < out.indexOf("- b — 나"), "a 가 b 보다 먼저(순서 불변)");
});

test("W1 위키 사이드바에 담당 표식 · 담당 먼저 정렬이 없다", () => {
  const side = code("web/v2/side.ts");
  assert.doesNotMatch(side, /ownerCatIds|myTeamName|v2-kown|team_owner_category_ids/);
  assert.match(side, /const rank = \(a: WikiCat, b: WikiCat\): number => \(Number\(b\.knowledge_count\) \|\| 0\) - \(Number\(a\.knowledge_count\) \|\| 0\);/);
  assert.doesNotMatch(code("public/styles/47-v2-rail.css"), /\.v2-kown/);
});

test("W2 맥락 관리 · 클래식 위키 · 설정 팀 · 검토 · 대시보드에 팀 담당 흔적이 없다", () => {
  const cats = code("web/categories.ts");
  assert.doesNotMatch(cats, /\/owner'|오너 팀|owner_team|api\('\/api\/ui\/teams'\)/);
  const front = code("web/wiki-front.ts");
  assert.doesNotMatch(front, /owner_team_name|소유 팀|mine_category_keys|team_category_ids/);
  const teams = code("web/admin-teams.ts");
  assert.doesNotMatch(teams, /소유 카테고리|이해관계 카테고리|category_count|\.categories/);
  const review = code("web/review.ts");
  assert.doesNotMatch(review, /mine_category_keys|CAT_MINE|내 도메인/);
  for (const p of ["web/dash/widget-notifications.ts", "web/dash/widget-tasks-review-log.ts", "web/dash/prefs.ts"]) {
    assert.doesNotMatch(code(p), /mine_total|mine_category_keys|내 도메인|dashRvwFilterDefault/, p);
  }
});
