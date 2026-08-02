#!/usr/bin/env node
// lively 실행 모드(#1007+) — extractMode(플래그 파싱)·modeEnv(모드→env) 순수 로직 단위테스트.
//  실행: node kit/cli/lively-mode.test.mjs  (npm test 체인에 포함). 파일/네트워크 무접촉.
import assert from "node:assert/strict";
import { MODES, extractMode, modeEnv } from "./lively.mjs";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

t("MODES = normal|readonly|incognito", () => assert.deepEqual(MODES, ["normal", "readonly", "incognito"]));

// 모드 → 세션 env (하네스가 상속 → MCP 헤더 x-lively-mode 가 확장). incognito 는 LIVELY_OFF 로 훅도 끈다.
//  ⚠ 전이기 dual-env(#1007+): 주 신호 LIVELY_MODE + 구 boolean(LIVELY_READONLY/INCOGNITO)을 함께 세팅 — x-lively-mode 헤더 미전파 설치에서도 격리 유지.
t("modeEnv: readonly → LIVELY_MODE=readonly + 전이기 구 LIVELY_READONLY=1", () =>
  assert.deepEqual(modeEnv("readonly"), { LIVELY_MODE: "readonly", LIVELY_READONLY: "1" }));
t("modeEnv: incognito → LIVELY_MODE=incognito + 구 LIVELY_INCOGNITO=1 + LIVELY_OFF=1 (전체차단 + 훅 off)", () =>
  assert.deepEqual(modeEnv("incognito"), { LIVELY_MODE: "incognito", LIVELY_INCOGNITO: "1", LIVELY_OFF: "1" }));
t("modeEnv: normal → 빈 env(플래그 없음)", () => assert.deepEqual(modeEnv("normal"), {}));

// 플래그 파싱 — 모드 플래그만 소비하고 나머지(프로젝트#·하네스 인자)는 그대로 통과.
t("extractMode: --readonly 는 모드로 뽑히고 나머지는 보존", () => {
  const r = extractMode(["--readonly", "foo", "--bar"]);
  assert.equal(r.mode, "readonly"); assert.deepEqual(r.rest, ["foo", "--bar"]);
});
t("extractMode: --incognito", () => assert.equal(extractMode(["--incognito"]).mode, "incognito"));
t("extractMode: --mode <값>", () => {
  const r = extractMode(["--mode", "readonly", "864"]);
  assert.equal(r.mode, "readonly"); assert.deepEqual(r.rest, ["864"]);
});
t("extractMode: 프로젝트번호·하네스 인자는 rest 로 통과(work.mjs/하네스로 원형 전달)", () => {
  const r = extractMode(["--incognito", "864", "--harness", "codex"]);
  assert.equal(r.mode, "incognito"); assert.deepEqual(r.rest, ["864", "--harness", "codex"]);
});
t("extractMode: 여러 모드 플래그면 마지막이 이긴다", () => {
  assert.equal(extractMode(["--readonly", "--incognito"]).mode, "incognito");
  assert.equal(extractMode(["--incognito", "--normal"]).mode, "normal");
});

console.log(`\nlively-mode tests: ${pass} passed`);
