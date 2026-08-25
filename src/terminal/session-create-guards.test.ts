// 세션 생성 가드(#1780 v2 §7-1) — 사양 H1: node + appId 는 400, 그 외는 통과(무회귀).
import { strict as assert } from "node:assert";
import test from "node:test";
import { assertAppSessionPlacement, autoTrustWorkspace } from "./session-create-guards.js";
import { HttpError } from "../http-error.js";

test("node + appId → 400 (relay 전에 거절)", () => {
  assert.throws(
    () => assertAppSessionPlacement({ appId: "browser" }, "node-1"),
    (e: unknown) => e instanceof HttpError && e.status === 400 && /노드/.test(e.message),
  );
});

test("node + appId 미지정/undefined → 통과(무회귀)", () => {
  assert.doesNotThrow(() => assertAppSessionPlacement({}, "node-1"));
  assert.doesNotThrow(() => assertAppSessionPlacement({ appId: undefined }, "node-1"));
});

test("node 없음 + appId → 통과(중앙 앱 세션, 무회귀)", () => {
  assert.doesNotThrow(() => assertAppSessionPlacement({ appId: "browser" }, ""));
});

// ── #1867 회귀: 첫 지시가 신뢰 대화상자에 막히던 자리 ──────────────────────────
//  실측(2026-08-25, dev 라이브): 프로젝트 세션을 노드에서 열면 cwd 가 라이블리가 방금 만든 `project/<id>` 인데도
//  "Is this a project you trust?" 에서 멈춰 첫 지시가 안 들어갔다. 기준은 '세션 폴더인가'가 아니라 '우리가 만든 자리인가'.
test("subpath 없음 = 라이블리 루트 → 자동 수락", () => {
  assert.equal(autoTrustWorkspace({}), true);
  assert.equal(autoTrustWorkspace({ subpath: "" }), true);
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: null }), true);
});

test("프로젝트 세션의 canonical 폴더(+하위 워크트리) → 자동 수락", () => {
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "project/12" }), true);
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "project/12/lively" }), true, "provision 된 레포 워크트리도 그 폴더 안이다");
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "legacy-project/12" }), true, "아카이브된 프로젝트 폴더도 우리 것");
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "/project/12/" }), true, "앞뒤 슬래시 표기차");
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "project\\12" }), true, "윈도우 구분자 표기차");
});

test("사람이 고른 폴더 → 자동 수락하지 않는다(사람이 답한다)", () => {
  assert.equal(autoTrustWorkspace({ subpath: "repos/someones-code" }), false, "프로젝트 세션이 아닌데 폴더를 골랐다");
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "project/99" }), false, "다른 프로젝트 폴더");
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "project/123" }), false, "경계: 접두만 같은 폴더(12 vs 123)");
  assert.equal(autoTrustWorkspace({ projectId: 12, subpath: "elsewhere/project/12" }), false, "첫 세그먼트가 프로젝트 베이스가 아니다");
  assert.equal(autoTrustWorkspace({ projectId: 0, subpath: "project/0" }), false, "프로젝트 id 가 아니면 판정 불가 → 보수적");
});
