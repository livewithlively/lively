import { strict as assert } from "node:assert";
import test from "node:test";
import { HttpError } from "../http-error.js";
import { normalizeInstanceProject, normalizeInstanceState } from "./instance-policy.js";
import { parseAppManifest } from "./manifest.js";

function manifest(project: "global" | "optional" | "required") {
  return parseAppManifest({ id: "test-app", title: "테스트", version: "1.0.0", instances: { project } });
}

// spec.md 「입력 조합 × 기대」 R1~R7: 프로젝트 소속은 nullable instance 맥락이고 manifest 정책을 OS가 집행한다.
test("R1 global + null → 비소속 허용", () => {
  assert.equal(normalizeInstanceProject(manifest("global"), null), null);
});

test("R2 global + project → 거부", () => {
  assert.throws(() => normalizeInstanceProject(manifest("global"), 1780), (e: unknown) => e instanceof HttpError && e.status === 400 && /전체 범위/.test(e.message));
});

test("R3 optional + null → 비소속 허용", () => {
  assert.equal(normalizeInstanceProject(manifest("optional"), null), null);
});

test("R4 optional + project → 소속 허용", () => {
  assert.equal(normalizeInstanceProject(manifest("optional"), 1780), 1780);
});

test("R5 required + null → 거부", () => {
  assert.throws(() => normalizeInstanceProject(manifest("required"), null), (e: unknown) => e instanceof HttpError && e.status === 400 && /소속이 필요/.test(e.message));
});

test("R6 required + project → 소속 허용", () => {
  assert.equal(normalizeInstanceProject(manifest("required"), 1780), 1780);
});

test("R7 project_id 형식 경계 → 양의 정수만 허용", () => {
  for (const invalid of [-1, 1.5, "not-a-number", Number.NaN]) {
    assert.throws(() => normalizeInstanceProject(manifest("optional"), invalid), (e: unknown) => e instanceof HttpError && e.status === 400);
  }
  assert.equal(normalizeInstanceProject(manifest("optional"), "42"), 42);
});

test("R8 state 상한은 UTF-8 실제 바이트로 계산한다", () => {
  assert.deepEqual(normalizeInstanceState({ text: "가".repeat(40_000) }), { text: "가".repeat(40_000) });
  assert.throws(
    () => normalizeInstanceState({ text: "가".repeat(44_000) }),
    (e: unknown) => e instanceof HttpError && e.status === 400 && /128KiB/.test(e.message),
  );
  for (const invalid of [null, [], "text"]) assert.throws(() => normalizeInstanceState(invalid), /객체/);
});
