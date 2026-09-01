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
// E12 — 윈도우 잡의 capability 경계. 2026-08-31(#2457)에 **계약이 한 단계 강해졌다**:
//  종전엔 PowerShell foreach 로 테스트를 직접 순회했기에 그 스텝이 deny+sandbox env 를 손으로 심어야 했다.
//  그런데 러너를 우회한다는 건 env 뿐 아니라 **러너가 심는 가드 전부**(실 홈 오염 런타임 가드·격리
//  preflight·산출물 누락 검사)를 건너뛴다는 뜻이었다 — 윈도우는 '초록인데 아무도 안 보는 면'이었다.
//  이제 윈도우도 공통 러너(`run-tests.mjs --scope=…`)를 쓰므로 env 는 러너가 수렴시킨다(이 파일 위쪽 단언).
//  그래서 검사는 둘 중 하나를 요구한다: **러너를 쓰거나, 직접 순회한다면 deny+sandbox 를 손으로 심거나.**
const windowsJob = workflow.indexOf("test-windows:");
const windowsStep = workflow.indexOf("kit·desktop 테스트 (윈도우", windowsJob);
const windowsLoop = workflow.indexOf("foreach ($f in $files)", windowsJob);
const disposableStep = workflow.indexOf("Windows User PATH 호스트 효과 왕복 (disposable runner)");
const disposableAllow = workflow.indexOf("LIVELY_HOST_EFFECTS: allow", disposableStep);
// 러너 경로 — 스텝이 run-tests.mjs 를 부르고, 직접 순회 루프가 남아 있지 않다.
const usesRunner = windowsStep > 0
  && workflow.indexOf("run-tests.mjs", windowsStep) > windowsStep
  && workflow.indexOf("run-tests.mjs", windowsStep) < (windowsLoop < 0 ? Infinity : windowsLoop)
  && windowsLoop < 0;
// 직접 순회 경로(종전) — 그렇다면 루프 **앞에** 세 env 가 있어야 한다.
const loopIsClosed = windowsLoop > 0
  && ["LIVELY_HOST_EFFECTS: deny", "LIVELY_HOST_EFFECTS_TEST_MODE: sandbox", "LIVELY_NO_BROWSER: '1'"]
      .every((k) => { const at = workflow.indexOf(k, windowsStep); return at > windowsStep && at < windowsLoop; });
if (windowsJob < 0 || windowsStep < 0 || !(usesRunner || loopIsClosed) || disposableStep < 0 || disposableAllow < disposableStep) {
  console.error("FAIL E12 Windows 잡이 공통 러너를 쓰지도, 직접 순회를 deny+sandbox 로 닫지도 않았다(또는 disposable 단계가 allow 로 열리지 않음)");
  process.exit(1);
}
console.log(`ok  E12 Windows 잡 capability 경계 — ${usesRunner ? "공통 러너 경유" : "직접 순회 + deny/sandbox 명시"}, disposable 만 allow`);
