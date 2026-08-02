// 브로커 exec 코어(#746 T4) 단위 체크 — 소켓·uid 불요(순수 로직). 소켓+uid 격리 E2E 는 scripts/integration/broker-isolation.sh(박스).
// 실행: npm run build && node dist/broker/broker.test.js
//  커버: 도구 화이트리스트(경로/`..`/미허용 거부) · cwd workroot 봉쇄(이탈 거부) · exec(허용실행·미허용거부·이탈거부·타임아웃).
process.env.CONNECTOR_SECRET_KEY ||= "0".repeat(64); // brokerAuthToken HMAC 키 소스(테스트 결정값)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertAllowedTool, resolveCwd, runExec } from "./exec.js";
import { brokerUser, brokerSocketPath, brokerSpawnArgv, brokerAuthToken } from "./route.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const throws = (fn: () => void, re: RegExp): void => { assert.throws(fn, (e: Error) => (assert.match(e.message, re), true)); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "brk-")));
fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
// workroot **바깥의 존재하는** 형제 디렉터리 + 그걸 가리키는 심링크 — 이탈 단언을 TMPDIR 지형에 의존하지 않게 한다(아래 주석).
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "brk-outside-")));
fs.symlinkSync(outside, path.join(tmp, "escape-link"));

// ── 도구 화이트리스트 — 경로 포함·`..`·미허용 거부(임의 바이너리 실행 차단) ──
t("assertAllowedTool: 허용 도구 통과 / 경로·..·미허용 거부", () => {
  assertAllowedTool("git", ["git", "kubectl"]);
  throws(() => assertAllowedTool("/bin/sh", ["git"]), /경로를 포함/);
  throws(() => assertAllowedTool("../../bin/rm", ["git"]), /경로를 포함/);
  throws(() => assertAllowedTool("rm", ["git", "kubectl"]), /허용되지 않은 도구/);
  throws(() => assertAllowedTool("", ["git"]), /tool 이 필요/);
});

// ── cwd 봉쇄 — workroot 하위만(경로 이탈 차단) ──
//  ⚠ 이탈은 **존재하는 바깥 경로**로 단언한다. resolveCwd 의 거부 사유가 둘로 갈리기 때문이다:
//   미존재/댕글링이면 "해석 실패", 존재하지만 바깥이면 "workroot 밖" — 둘 다 거부지만 문구가 다르다.
//   예전엔 `../../etc` 로 후자를 노렸는데 그게 **TMPDIR 지형에 의존**했다:
//    · 리눅스 CI(TMPDIR=/tmp)      → workroot=/tmp/brk-X   → ../../etc = /etc (존재)        → "workroot 밖" ✅
//    · macOS(TMPDIR=/var/folders/…/T) → workroot=…/T/brk-X → ../../etc = …/<hash>/etc (미존재) → "해석 실패" ❌ 깨짐
//   코드 결함이 아니라 단언이 환경 의존이었다. 이제 바깥 경로를 직접 만들어 지형과 무관하게 만든다.
t("resolveCwd: workroot 하위 허용 / 이탈·심링크이탈·미존재 거부", () => {
  assert.equal(resolveCwd(undefined, tmp), tmp);
  assert.equal(resolveCwd("sub", tmp), path.join(tmp, "sub"));
  throws(() => resolveCwd(path.join("..", path.basename(outside)), tmp), /workroot 밖/); // `..` 이탈(존재하는 형제)
  throws(() => resolveCwd(outside, tmp), /workroot 밖/); // 절대경로 이탈
  throws(() => resolveCwd("/etc", tmp), /workroot 밖/); // 어디서나 존재하는 절대경로
  throws(() => resolveCwd("escape-link", tmp), /workroot 밖/); // 심링크로 바깥 — realpath 후 거부(코드의 핵심 의도인데 그동안 미커버)
  throws(() => resolveCwd("nope-does-not-exist", tmp), /해석 실패/); // 미존재는 통과시키지 않는다(옛 폴백은 심볼릭 레이스 우회를 허용했음)
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
  const r = await runExec({ op: "exec", tool: "echo", args: ["x"], cwd: path.join("..", path.basename(outside)) }, { allowedTools: ["echo"], workroot: tmp });
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

// ── per-broker 인증 토큰(리뷰#2 크로스-멤버 차단) — 결정론·slug별 상이·게이트웨이만 계산가능 ──
t("brokerAuthToken: slug별 결정론 + 상이(위조불가 전제) + url-safe", () => {
  assert.equal(brokerAuthToken("a"), brokerAuthToken("a"));       // 결정론(재시작에도 일관)
  assert.notEqual(brokerAuthToken("a"), brokerAuthToken("b"));    // slug별 상이 → broker_a 는 broker_b 토큰 모름
  assert.doesNotMatch(brokerAuthToken("a"), /[+/=]/);             // base64url
});

// ── resolveCwd: realpath 실패(댕글링 심볼릭) → 거부(레이스 우회 차단) ──
t("resolveCwd: 댕글링 심볼릭/미존재 → 거부(unresolved 폴백 없음)", () => {
  fs.symlinkSync("/nonexistent-target-xyz", path.join(tmp, "dangling"));
  throws(() => resolveCwd("dangling", tmp), /해석 실패/);
  throws(() => resolveCwd("does-not-exist", tmp), /해석 실패/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nBROKER UNIT: ${pass} passed`);
