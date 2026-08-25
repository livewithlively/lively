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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "test.yml"), "utf8");
const windowsStep = workflow.indexOf("kit·desktop 테스트 (윈도우)");
const windowsLoop = workflow.indexOf("foreach ($f in $files)");
const windowsDeny = workflow.indexOf("LIVELY_HOST_EFFECTS: deny", windowsStep);
const windowsSandbox = workflow.indexOf("LIVELY_HOST_EFFECTS_TEST_MODE: sandbox", windowsStep);
const windowsNoBrowser = workflow.indexOf("LIVELY_NO_BROWSER: '1'", windowsStep);
const disposableStep = workflow.indexOf("Windows User PATH 호스트 효과 왕복 (disposable runner)");
const disposableAllow = workflow.indexOf("LIVELY_HOST_EFFECTS: allow", disposableStep);
const windowsEnvBeforeLoop = [windowsDeny, windowsSandbox, windowsNoBrowser]
  .every((position) => position > windowsStep && position < windowsLoop);
if (windowsStep < 0 || windowsLoop < 0 || !windowsEnvBeforeLoop || disposableStep < 0 || disposableAllow < disposableStep) {
  console.error("FAIL E12 Windows 직접 실행 CI가 deny+sandbox로 닫히지 않았거나 disposable 단계가 allow로 열리지 않음");
  process.exit(1);
}
console.log("ok  E12 Windows 직접 실행 CI는 deny+sandbox, disposable 호스트 효과만 allow");
