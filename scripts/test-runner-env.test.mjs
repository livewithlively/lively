#!/usr/bin/env node
import { testChildEnv } from "./test-runner-env.mjs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const got = testChildEnv({ LIVELY_HOST_EFFECTS: "allow", LIVELY_NO_BROWSER: "", KEEP: "yes" });
const ok = got.LIVELY_HOST_EFFECTS === "deny"
  && got.LIVELY_HOST_EFFECTS_TEST_MODE === "sandbox"
  && got.LIVELY_NO_BROWSER === "1"
  && got.KEEP === "yes";
if (!ok) {
  console.error(`FAIL E10 러너 자식 env가 capability를 닫지 못함: ${JSON.stringify(got)}`);
  process.exit(1);
}
console.log("ok  E10 직렬·병렬 공통 자식 env가 호스트 효과 deny로 수렴");

const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run-tests.mjs"), "utf8");
const preflight = runner.indexOf("const isolationPreflight");
const firstSpawn = runner.indexOf("const jobs =");
if (preflight < 0 || firstSpawn < 0 || preflight > firstSpawn) {
  console.error("FAIL E11 격리 린트가 테스트 spawn보다 먼저 실행되지 않음");
  process.exit(1);
}
console.log("ok  E11 격리 린트 preflight가 어떤 테스트 spawn보다 먼저 실행됨");
