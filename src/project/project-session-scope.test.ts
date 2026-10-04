// 프로젝트 세션 목록의 «이 프로젝트 것인가» 판정(#4135, 2026-10-04 원준 신고 — 중단된 중앙 세션이 프로젝트 허브에서 사라짐).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { projectSessionBelongs } from "./project-session-scope.js";

const BASE = "/var/lib/lvly/gw/lvly-gw-b-central/workspace/project/4528";

test("P1 중앙 세션 호스트의 중단된 세션 — 폴더가 게이트웨이 경로와 달라도 projectId 가 같으면 이 프로젝트 것(신고 재현)", () => {
  assert.equal(projectSessionBelongs({ dir: "/work/shared/project/4528", projectId: 4528 }, 4528, BASE), true);
});

test("P2 노드 세션 — projectId 로 판정(경로는 노드의 것이라 보지 않는다)", () => {
  assert.equal(projectSessionBelongs({ dir: "/Users/x/workspace/project/4528", projectId: 4528, node: { id: "n" } }, 4528, BASE), true);
  assert.equal(projectSessionBelongs({ dir: "/Users/x/workspace/project/4528", projectId: 7, node: { id: "n" } }, 4528, BASE), false);
  assert.equal(projectSessionBelongs({ dir: BASE, node: { id: "n" } }, 4528, BASE), false, "projectId 없는 노드 행은 경로로 판정하지 않는다");
});

test("P3 다른 프로젝트 id 는 경로가 맞아 보여도 그 프로젝트 것이 아니다", () => {
  assert.equal(projectSessionBelongs({ dir: BASE, projectId: 4529 }, 4528, BASE), false);
});

test("P4 projectId 없는 옛 로컬 행 — 경로 보조(폴더 자체 · 하위 폴더 · 이름만 비슷한 옆 폴더는 아님)", () => {
  assert.equal(projectSessionBelongs({ dir: BASE }, 4528, BASE), true);
  assert.equal(projectSessionBelongs({ dir: BASE + "/lively" }, 4528, BASE), true);
  assert.equal(projectSessionBelongs({ dir: BASE + "0" }, 4528, BASE), false);
  assert.equal(projectSessionBelongs({ dir: "" }, 4528, BASE), false);
  assert.equal(projectSessionBelongs({ projectId: 0, dir: "/work/shared/project/4528" }, 4528, BASE), false, "id 0 은 모르는 것 — 경로로");
});

test("P5 배선 — 라우트가 local · restorable 둘 다 이 판정을 쓴다(경로만 보던 옛 거르기가 남지 않는다)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "project-routes.ts").replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`), "utf8");
  const i = src.indexOf("`${prefix}/:id/sessions`, auth");
  const body = src.slice(i, src.indexOf("res.json({ sessions: rows })", i));
  assert.match(body, /projectSessionBelongs\(/);
  assert.match(body, /const local = all\.filter\(mine\)/);
  assert.match(body, /\.filter\(mine\);/);
  assert.doesNotMatch(body, /underBase/);
});
