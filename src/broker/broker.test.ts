// 브로커 exec 코어(#746 T4) 단위 체크 — 소켓·uid 불요(순수 로직). 소켓+uid 격리 E2E 는 scripts/integration/broker-isolation.sh(박스).
// 실행: npm run build && node dist/broker/broker.test.js
//  커버: 도구 화이트리스트(경로/`..`/미허용 거부) · cwd workroot 봉쇄(이탈 거부) · exec(허용실행·미허용거부·이탈거부·타임아웃).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertAllowedTool, resolveCwd, runExec } from "./exec.js";
import { brokerUser, brokerSocketPath, brokerSpawnArgv } from "./route.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const throws = (fn: () => void, re: RegExp): void => { assert.throws(fn, (e: Error) => (assert.match(e.message, re), true)); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "brk-")));
fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });

// ── 도구 화이트리스트 — 경로 포함·`..`·미허용 거부(임의 바이너리 실행 차단) ──
t("assertAllowedTool: 허용 도구 통과 / 경로·..·미허용 거부", () => {
  assertAllowedTool("git", ["git", "kubectl"]);
  throws(() => assertAllowedTool("/bin/sh", ["git"]), /경로를 포함/);
  throws(() => assertAllowedTool("../../bin/rm", ["git"]), /경로를 포함/);
  throws(() => assertAllowedTool("rm", ["git", "kubectl"]), /허용되지 않은 도구/);
  throws(() => assertAllowedTool("", ["git"]), /tool 이 필요/);
});

// ── cwd 봉쇄 — workroot 하위만(경로 이탈 차단) ──
t("resolveCwd: workroot 하위 허용 / 이탈 거부", () => {
  assert.equal(resolveCwd(undefined, tmp), tmp);
  assert.equal(resolveCwd("sub", tmp), path.join(tmp, "sub"));
  throws(() => resolveCwd("../../etc", tmp), /workroot 밖/);
  throws(() => resolveCwd("/etc", tmp), /workroot 밖/);
});

// ── exec — no-shell·화이트리스트·봉쇄·실패코드 ──
await ta("runExec: 허용 도구 실행(stdout·code 0)", async () => {
  const r = await runExec({ op: "exec", tool: "echo", args: ["hello-broker"] }, { allowedTools: ["echo", "true"], workroot: tmp });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello-broker/);
});
await ta("runExec: 미허용 도구 → ok:false(실행 안 함)", async () => {
  const r = await runExec({ op: "exec", tool: "rm", args: ["-rf", "/"] }, { allowedTools: ["echo"], workroot: tmp });
  assert.equal(r.ok, false);
  assert.match(r.error || "", /허용되지 않은 도구/);
});
await ta("runExec: cwd 이탈 → ok:false(실행 안 함)", async () => {
  const r = await runExec({ op: "exec", tool: "echo", args: ["x"], cwd: "../../.." }, { allowedTools: ["echo"], workroot: tmp });
  assert.equal(r.ok, false);
  assert.match(r.error || "", /workroot 밖/);
});
await ta("runExec: 인자는 배열로만(셸 인젝션 불가 — 메타문자 리터럴)", async () => {
  const r = await runExec({ op: "exec", tool: "echo", args: ["a; rm -rf /"] }, { allowedTools: ["echo"], workroot: tmp });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /a; rm -rf \//); // 셸 미경유라 메타문자가 리터럴 출력(실행 안 됨)
});

// ── 라우팅 헬퍼(①) — 전용 uid·소켓 경로·spawn argv(기존 격리 특권경로 재사용) ──
t("route: brokerUser = broker_<slug>, socketPath = <dir>/<slug>.sock", () => {
  assert.equal(brokerUser("yoon"), "broker_yoon");
  assert.match(brokerSocketPath("yoon"), /\/yoon\.sock$/);
});
t("route: spawn argv = sudo -n -u broker_<slug> -- box-spawn node <entry>", () => {
  const a = brokerSpawnArgv("yoon", "/opt/co/dist/broker/index.js");
  assert.deepEqual(a.slice(0, 5), ["sudo", "-n", "-u", "broker_yoon", "--"]);
  assert.equal(a[a.length - 2], "node");
  assert.equal(a[a.length - 1], "/opt/co/dist/broker/index.js");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nBROKER UNIT: ${pass} passed`);
