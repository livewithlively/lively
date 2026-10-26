#!/usr/bin/env node
// run-custom 러너 사양테스트를 «스레드로» 한 번 더 돌린다(#5034).
//  run-custom.test.mjs 의 훅은 전부 직접 만든 훅이라 기본으로는 프로세스 경로만 본다(스레드 기본은 제품 시드 훅만).
//  같은 시험을 스레드로 돌려(RUN_CUSTOM_TEST_HOOK_RUNTIME=worker → 하네스가 LIVELY_HOOK_RUNTIME=worker 로 싣는다), 시드 훅이
//  기본으로 타는 스레드 경로도 같은 계약(결정 병합·크래시 격리·상한·exit 0 …)을 지키는지 본다. 스레드로 같게 못 도는 훅
//  (child_process 등)은 그래도 프로세스로 간다 — W6b·W6c 가 그 경계다. 안쪽 묶음의 P0 이 «정말 스레드를 탔나» 를 먼저 단언한다.
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const SPEC = join(dirname(fileURLToPath(import.meta.url)), "run-custom.test.mjs");
const r = spawnSync(process.execPath, [SPEC], {
  env: { ...process.env, ...offlineLivelyEnv(), RUN_CUSTOM_TEST_HOOK_RUNTIME: "worker" },
  encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
});
const out = `${r.stdout || ""}${r.stderr || ""}`;
const summary = (out.match(/run-custom tests: [^\n]*/) || ["(요약 줄 없음)"])[0];
// 배선 단언 — 안쪽 시험이 실제로 돌았나(요약 줄이 없으면 아무것도 안 본 것이다).
if (r.status === 0 && /run-custom tests: \d+ passed$/.test(summary)) {
  console.log(`ok  스레드로 돌린 run-custom 사양테스트 — ${summary}`);
  process.exit(0);
}
const fails = out.split("\n").filter((l) => l.startsWith("FAIL"));
console.error(fails.length ? fails.join("\n") : out.slice(-2000));
console.error(`FAIL 스레드로 돌린 run-custom 사양테스트 — status=${r.status} signal=${r.signal} ${summary}`);
process.exit(1);
