// 복원 시 프로젝트 귀속 판정(#2549) — 프로젝트가 사라진 세션은 «프로젝트 없이» 되살린다.
//
// 실측(2026-09-02, 매니지드): 중단된 세션(box-wonjoon-jang-680e0400)에 입력 → 복원 → createSession 의 DB current 기록이
//  `execution_session_desired_project_id_fkey` 위반으로 죽어 503 «프로젝트 소속을 기록하지 못해 세션 생성을 취소했습니다».
//  그 세션의 desired-state 가 가리키는 프로젝트가 완전 삭제돼 `project` 행이 없었다. 신규 세션에서 이 기록을 엄격히 하는
//  규율(훅의 중복 프로젝트 생성 방지)은 맞지만, 복원은 «있던 대화를 되살리는 것» 이라 프로젝트가 없어졌다고 대화까지
//  막다른 길이 되면 안 된다.
//
// 사양·엣지: R1 project_id 없음 → 그대로(존재 확인 안 함) / R2 존재 → id 유지 / R3 없음(v6) → id 를 떼고 dropped=true
//           / R4 org 출처 → DB 기록이 없으니 확인 없이 통과 / R5 확인 자체가 실패(DB 일시 장애) → 떼지 않는다(모르면 종전 동작)
import test from "node:test";
import assert from "node:assert/strict";
import { restoreProjectRef } from "./restore-project.js";

test("R1 project_id 가 없으면 존재 확인 없이 그대로", async () => {
  let asked = 0;
  const r = await restoreProjectRef({ project_id: null, project_src: null }, async () => { asked++; return true; });
  assert.equal(r.projectId, undefined);
  assert.equal(r.dropped, false);
  assert.equal(asked, 0, "물을 것이 없다");
});

test("R2 프로젝트가 있으면 id 유지", async () => {
  const r = await restoreProjectRef({ project_id: 42, project_src: "v6" }, async (id) => id === 42);
  assert.equal(r.projectId, 42);
  assert.equal(r.projectSrc, "v6");
  assert.equal(r.dropped, false);
});

test("R3 프로젝트가 없으면 id 를 떼고 dropped 로 알린다 ★ 이 프로젝트의 존재 이유", async () => {
  const r = await restoreProjectRef({ project_id: 42, project_src: "v6" }, async () => false);
  assert.equal(r.projectId, undefined, "🔴 없는 프로젝트 id 를 그대로 넘기면 FK 위반으로 복원이 503 에서 죽는다");
  assert.equal(r.dropped, true, "호출자가 경고를 남길 수 있게 알린다");
});

test("R4 org 출처 프로젝트는 DB 기록이 없으니 확인 없이 통과", async () => {
  let asked = 0;
  const r = await restoreProjectRef({ project_id: 7, project_src: "org" }, async () => { asked++; return false; });
  assert.equal(r.projectId, 7);
  assert.equal(r.projectSrc, "org");
  assert.equal(asked, 0);
});

test("R5 존재 확인이 실패하면(일시 장애) 떼지 않는다 — 모르면 종전 동작", async () => {
  const r = await restoreProjectRef({ project_id: 42, project_src: "v6" }, async () => { throw new Error("db down"); });
  assert.equal(r.projectId, 42, "🔴 DB 가 잠깐 죽었다고 세션의 프로젝트 귀속을 지워 버리면 안 된다");
  assert.equal(r.dropped, false);
});
