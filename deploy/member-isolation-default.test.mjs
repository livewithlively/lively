// 구성원 격리(#524)는 셀프호스팅 새 설치의 기본이다 (#5031, deploy/lib/common.sh ensure_member_isolation).
//  왜: 종전 install.sh 에는 격리 단계가 없어, 손으로 `sudo bash deploy/linux/install-isolation.sh` 를 돌리기 전까지 구성원 세션이 게이트웨이
//   유저 하나로 돌았다 — 서로의 AI 로그인 정보가 보이고 조직 스킬 받은 목록을 같이 써 남의 스킬 파일을 지울 수 있었다(테스트 박스·위시스트
//   모두 설치 뒤 손으로 켰다). 비용(구성원마다 OS 계정 · 그 사람 몫 AI)은 그 사람이 서버에서 AI 를 처음 쓸 때만 든다.
//  실제 셸로 돌려 부작용으로 단언한다 — server-ais.test.mjs 와 같은 틀: sudo 는 셸 함수로 갈아 끼워 불린 인자만 남기고(누가 `command sudo` 로
//   바꾸면 PATH 맨 앞의 가짜 sudo(종료 97)에 걸린다), detect_os 는 함수로 정하고, 준비 대기(wait_healthz·wait_ready)는 불린 순서만 남긴다.
//
//  엣지 표(행마다 단언):
//   I1  리눅스 · 게이트웨이 유저 svc → GATEWAY_USER=svc 로 install-isolation → 게이트웨이 재시작 → 헬스 · 준비 대기 · 0 · 다음 줄로
//   I2  LIVELY_MEMBER_ISOLATION=off → 아무것도 안 부른다 · 0
//   I3  맥 → 아무것도 안 부른다 · 0
//   I4  install-isolation 실패 → 이번에 처음 놓인 box-spawn 을 걷는다(반쪽 격리 방지) · 경고 · 재시작·대기 안 함 · set -e 아래에서도 0
//   I7  OFFLINE=1 · LIVELY_SERVER_AIS=off → 기본으로 안 켠다(구성원 몫 AI 를 바깥에서 받지 못해 첫 사용이 매달린다) · on 이면 켠다
//   I8  기존 설치 위(LIVELY_PRIOR_INSTALL=1) → 모드를 안 바꾼다 · on 이면 켠다
//   I5  SERVICE_USER 가 비었다 → 지금 유저(id -un)
//   I6  deploy 폴더를 넘기면 그 폴더의 install-isolation 을 부른다
//   F1  부르는 install-isolation 이 실제 파일이다
//   W1  install.sh — 5/7 의 준비 대기(wait_ready) 뒤 · 6/7 부트스트랩 앞에서 부른다
//   W2  update.sh · deploy-release.sh 는 부르지 않는다(기존 박스 모드 유지 — 켜면 구성원이 AI 에 다시 로그인해야 한다)
//   W3  install.sh — 기존 설치 신호(LIVELY_PRIOR_INSTALL)를 main 전에 재고 내보낸다
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("skip  윈도우 — 셀프호스트 설치 셸(bash)은 리눅스·맥 전용");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const COMMON = join(here, "lib", "common.sh");
const read = (...p) => readFileSync(join(here, ...p), "utf8");
const codeLines = (src) => src.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#"));
const lineOf = (lines, re) => lines.findIndex((l) => re.test(l));

/** common.sh 를 읽어 ensure_member_isolation 을 한 번 부른다. 불린 sudo 인자와 준비 대기 순서를 한 줄씩 남긴다. */
function run({ os, user, failOn = [], arg, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "member-iso-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "sudo"), "#!/bin/sh\necho 'real-sudo-path-reached' >&2\nexit 97\n");
  chmodSync(join(bin, "sudo"), 0o755);
  try {
    const script = [
      "set -euo pipefail",
      `source "${COMMON}"`,
      `sudo() { printf 'sudo %s\\n' "$*" >> "$CALL_LOG"; local f; for f in $FAIL_ON; do case "$*" in *"$f"*) return 1;; esac; done; return 0; }`,
      `wait_healthz() { echo 'wait_healthz' >> "$CALL_LOG"; }`,
      `wait_ready() { echo 'wait_ready' >> "$CALL_LOG"; }`,
      ...(os === undefined ? [] : [`detect_os() { echo '${os}'; }`]),
      user === undefined ? "unset SERVICE_USER" : `SERVICE_USER='${user}'`,
      arg === undefined ? "ensure_member_isolation" : `ensure_member_isolation '${arg}'`,
      "echo AFTER",
    ].join("\n");
    const env = { PATH: `${bin}:/usr/bin:/bin`, CALL_LOG: log, FAIL_ON: failOn.join(" "), LANG: "C.UTF-8", ...extraEnv };
    const r = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    return { status: r.status, after: /^AFTER$/m.test(r.stdout || ""), err: r.stderr || "", calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ISO = (u, d = here) => `sudo GATEWAY_USER=${u} bash ${join(d, "linux", "install-isolation.sh")}`;
const ON = (u, d) => [ISO(u, d), "sudo systemctl restart lively-gateway", "wait_healthz", "wait_ready"];
const noRealSudo = (r) => assert.doesNotMatch(r.err, /real-sudo-path-reached/, "PATH 의 sudo 에 닿았다 — 진짜 sudo 를 부를 수 있는 모양이다");

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

t("I1 리눅스 · svc → GATEWAY_USER=svc 로 install-isolation → 게이트웨이 재시작 → 헬스·준비 대기 · 0 · 다음 줄로", () => {
  const r = run({ os: "linux", user: "svc" });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.after, "다음 줄로 가지 않았다");
  assert.deepEqual(r.calls, ON("svc"), "★ 새 설치가 격리를 켜지 않는다(또는 켠 뒤 게이트웨이를 다시 안 띄워 그룹이 안 붙는다)");
  noRealSudo(r);
});

t("I2 LIVELY_MEMBER_ISOLATION=off → 아무것도 안 부른다 · 0", () => {
  const r = run({ os: "linux", user: "svc", extraEnv: { LIVELY_MEMBER_ISOLATION: "off" } });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.after);
  assert.deepEqual(r.calls, [], "끄랬는데 격리를 깔았다");
});

t("I3 맥 → 아무것도 안 부른다(격리는 리눅스 OS 계정 경계) · 0", () => {
  const r = run({ os: "mac", user: "svc" });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.after);
  assert.deepEqual(r.calls, []);
});

t("I4 install-isolation 실패 → 처음 놓인 box-spawn 을 걷는다 · 경고 · 재시작·대기 안 함 · set -e 아래에서도 0 · 다음 줄로", () => {
  if (existsSync("/opt/lively/libexec/box-spawn")) { console.log("skip  I4 — 이 기계에 이미 box-spawn 이 있다(걷지 않는 갈래)"); pass++; return; }
  const r = run({ os: "linux", user: "svc", failOn: ["install-isolation.sh"] });
  assert.equal(r.status, 0, `설치가 죽었다: ${r.err}`);
  assert.ok(r.after, "실패 뒤 설치가 이어지지 않는다");
  assert.deepEqual(r.calls, [ISO("svc"), "sudo rm -f /opt/lively/libexec/box-spawn"],
    "★ 실패했는데 반쪽 격리를 남겼다(box-spawn 만 있으면 «격리 장치 있음» 으로 보여 구성원 [연결]이 503) — 또는 게이트웨이를 다시 띄웠다");
  assert.match(r.err, /구성원 격리 설치 실패/, "경고가 없다 — 격리 없이 돈다는 걸 모른다");
});

t("I5 SERVICE_USER 가 비었으면 지금 유저로", () => {
  const me = userInfo().username;
  const r = run({ os: "linux", user: "" });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.calls, ON(me));
});

t("I6 deploy 폴더를 넘기면 그 폴더의 install-isolation 을 부른다", () => {
  const r = run({ os: "linux", user: "svc", arg: "/opt/lively/releases/x/deploy" });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.calls, ON("svc", "/opt/lively/releases/x/deploy"));
});

t("I7 OFFLINE=1 · LIVELY_SERVER_AIS=off → 기본으로 안 켠다 · on 이면 켠다", () => {
  for (const env of [{ OFFLINE: "1" }, { LIVELY_SERVER_AIS: "off" }]) {
    const r = run({ os: "linux", user: "svc", extraEnv: env });
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.calls, [], `${JSON.stringify(env)}: 바깥에서 AI 를 못 받는 박스에 격리를 켰다 — 구성원 첫 사용이 매달린다`);
    const on = run({ os: "linux", user: "svc", extraEnv: { ...env, LIVELY_MEMBER_ISOLATION: "on" } });
    assert.deepEqual(on.calls, ON("svc"), `${JSON.stringify(env)}: on 을 명시했는데 안 켰다`);
  }
});

t("I8 기존 설치 위 → 모드를 안 바꾼다 · on 이면 켠다", () => {
  const r = run({ os: "linux", user: "svc", extraEnv: { LIVELY_PRIOR_INSTALL: "1" } });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.calls, [], "★ 기존 박스(FORCE=1 재설치)의 모드를 바꿨다 — 구성원이 다들 AI 에 다시 로그인해야 한다");
  const on = run({ os: "linux", user: "svc", extraEnv: { LIVELY_PRIOR_INSTALL: "1", LIVELY_MEMBER_ISOLATION: "on" } });
  assert.deepEqual(on.calls, ON("svc"), "on 을 명시했는데 안 켰다");
});

t("F1 부르는 install-isolation 이 실제 파일이다", () => {
  assert.ok(existsSync(join(here, "linux", "install-isolation.sh")), "deploy/linux/install-isolation.sh 가 없다");
});

t("W1 install.sh — 5/7 준비 대기 뒤 · 6/7 부트스트랩 앞에서 부른다", () => {
  const L = codeLines(read("install.sh"));
  const ready = lineOf(L, /^\s*wait_ready\b/);
  const iso = lineOf(L, /^\s*ensure_member_isolation\b/);
  const boot = lineOf(L, /phase "6\/7/);
  assert.ok(ready >= 0 && boot >= 0, "배선 — install.sh 의 기준 줄을 못 찾았다");
  assert.ok(iso >= 0, "★ install.sh 가 ensure_member_isolation 을 부르지 않는다 — 새 설치가 격리 없이 돈다");
  assert.ok(ready < iso && iso < boot, `순서가 틀렸다(wait_ready ${ready} · 격리 ${iso} · 6/7 ${boot})`);
});

t("W2 update.sh · deploy-release.sh 는 부르지 않는다(기존 박스 모드 유지)", () => {
  for (const f of ["update.sh", "deploy-release.sh"]) {
    assert.equal(lineOf(codeLines(read(f)), /\bensure_member_isolation\b/), -1, `${f}: 업데이트가 격리를 켠다 — 기존 구성원이 다들 AI 에 다시 로그인해야 한다`);
  }
});

t("W3 install.sh — 기존 설치 신호를 main 전에 재고 내보낸다", () => {
  const L = codeLines(read("install.sh"));
  const prior = lineOf(L, /^\s*LIVELY_PRIOR_INSTALL=1/);
  const exp = lineOf(L, /^\s*export LIVELY_PRIOR_INSTALL\b/);
  const main = lineOf(L, /^main\(\) \{/);
  assert.ok(prior >= 0 && exp >= 0, "★ install.sh 가 기존 설치를 재지 않는다 — FORCE=1 재설치가 모드를 바꾼다");
  assert.ok(prior < main && exp < main, "main 뒤에서 잰다");
});

console.log(`member-isolation-default.test: ${pass} ok`);
