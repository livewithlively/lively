// 서버에서 띄울 AI 넷 — 설치·업데이트·blue-green 배포가 갖춘다 (#4970, deploy/lib/common.sh ensure_server_ais).
//  왜: 처음 설정 «AI 연결» 은 이 서버에서 띄울 수 있는 AI 만 보인다(src/terminal/harness-installed.ts). 종전 설치는 클로드만 깔아 새 셀프호스트
//   박스의 그 장면에 클로드 하나만 떴다 — 제미나이·그록은 손으로 돌리는 스크립트였다(위시스트 실측 2026-10-23). 이제 설치(install.sh 7/7) ·
//   업데이트(update.sh) · blue-green(deploy-release.sh)이 같은 단계를 부른다.
//  실제 셸로 돌려 부작용으로 단언한다 — sudo 는 셸 함수로 갈아 끼워 불린 인자만 남긴다(함수가 PATH 보다 먼저다). 그래도 누가 `command sudo` 로
//   바꾸면 PATH 맨 앞의 가짜 sudo(종료 97)에 걸린다 — 진짜 sudo 에는 닿지 않는다. OS 는 detect_os 를 함수로 갈아 끼워 정한다.
//
//  엣지 표(행마다 단언):
//   A1  리눅스 · 게이트웨이 유저 svc → 클로드 도우미(svc) · 챗GPT 도우미(svc) · 제미나이 · 그록을 차례로 · 저마다 시간 상한(기본 600초) · 0 · 다음 줄로
//   A2  SERVICE_USER 가 비었다 → 지금 유저(id -un). 그 유저가 root 면 A9 모양
//   A3  OFFLINE=1 → 아무것도 안 부른다
//   A4  맥 → 아무것도 안 부른다(도우미들이 runuser 를 쓴다)
//   A5  제미나이 설치가 실패해도 그록은 부른다(하나씩 부른다 — 설치 스크립트는 첫 실패에서 멈춘다) · set -euo pipefail 아래에서 0 · 경고
//   A5b 그록 설치 실패 → 0 · 경고
//   A6  클로드 도우미 실패 → 뒤의 셋을 그대로 부른다 · 0
//   A6b 챗GPT 도우미 실패 → 뒤의 둘을 그대로 부른다 · 0
//   A7  물려받은 OS 환경 변수에 기대지 않는다(OS=mac 이 와도 detect_os 가 리눅스면 깐다) · 갈아 끼우지 않으면 이 기계의 detect_os 를 따른다
//   A8  deploy 폴더를 넘기면 그 폴더의 도우미를 부른다(blue-green — 새 릴리스의 도우미)
//   A9  게이트웨이 유저가 root · codex 없음 → 챗GPT 도우미는 부르지 않는다(root 의 ~/.npmrc prefix 를 바꾸면 `sudo npm i -g` 가 PATH 밖으로 간다) ·
//       나머지 셋 · 손으로 까는 법을 경고로 · 0
//   A9b root · codex 가 이미 있다 → 경고 없이 조용히
//   A10 LIVELY_SERVER_AIS=off → 아무것도 안 부른다(바깥 사이트에서 실행 파일을 받으면 안 되는 박스)
//   A11 LIVELY_SERVER_AIS_TIMEOUT 이 상한을 바꾼다
//   R1  run_as_service 가 그 유저의 사용자 몫 폴더(~/.local/bin · ~/.npm-global/bin)를 PATH 앞에 둔다 — 방금 그 홈에 깐 클로드를 키트가 찾게
//   F1  부르는 도우미가 실제 파일이다(이름이 바뀌면 설치가 조용히 경고만 남긴다)
//   W1  install.sh — 7/7 에서 키트 설치보다 먼저 부른다(키트가 게이트웨이 유저의 claude 에 MCP·훅을 단다)
//   W2  update.sh — 재시작·준비 대기 **뒤**(옛 프로세스 + 새 dist 구간을 늘리지 않게) · 키트(--kit) 앞에 부른다
//   W3  deploy-release.sh(blue-green) — 게이트웨이 유저가 정해진 뒤 · 격리 리프레시 뒤 «완료» 전에 새 릴리스의 deploy 폴더로 부른다
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
// 주석이 아닌 실제 명령 줄만(provision-member-order · member-codex-install 과 같은 규약).
const codeLines = (src) => src.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#"));
const lineOf = (lines, re) => lines.findIndex((l) => re.test(l));

/**
 * common.sh 를 읽어 `call`(기본 ensure_server_ais)을 한 번 부른다. sudo 는 불린 인자를 한 줄씩 남기고, failOn 의 이름이 들어 있으면 1 로 끝난다.
 *  os 를 주면 detect_os 를 그 값으로 갈아 끼운다(안 주면 이 기계의 것). PATH 는 가짜 sudo · (codex 를 주면) 가짜 codex · /usr/bin:/bin 뿐이다.
 */
function run({ os, user, offline = false, failOn = [], arg, envOS, codex = false, extraEnv = {}, call = "ensure_server_ais", pre = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "srv-ais-"));
  const log = join(dir, "sudo.log");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "sudo"), "#!/bin/sh\necho 'real-sudo-path-reached' >&2\nexit 97\n");
  chmodSync(join(bin, "sudo"), 0o755);
  if (codex) { writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "codex"), 0o755); }
  try {
    const script = [
      "set -euo pipefail",
      `source "${COMMON}"`,
      `sudo() { printf '%s\\n' "$*" >> "$SUDO_LOG"; local f; for f in $FAIL_ON; do case "$*" in *"$f"*) return 1;; esac; done; return 0; }`,
      ...(os === undefined ? [] : [`detect_os() { echo '${os}'; }`]),
      ...pre,
      user === undefined ? "unset SERVICE_USER" : `SERVICE_USER='${user}'`,
      arg === undefined ? call : `${call} '${arg}'`,
      "echo AFTER",
    ].join("\n");
    const env = { PATH: `${bin}:/usr/bin:/bin`, SUDO_LOG: log, FAIL_ON: failOn.join(" "), OFFLINE: offline ? "1" : "0", LANG: "C.UTF-8", ...extraEnv };
    if (envOS !== undefined) env.OS = envOS;
    const r = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    return { status: r.status, after: /^AFTER$/m.test(r.stdout || ""), err: r.stderr || "", calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const T = (s = 600) => `timeout ${s} bash`;
const CLAUDE = (u, d = here, s) => `${T(s)} ${join(d, "install-claude-user.sh")} ${u}`;
const CODEX = (u, d = here, s) => `${T(s)} ${join(d, "install-codex-user.sh")} ${u}`;
const CLI = (h, d = here, s) => `${T(s)} ${join(d, "install-harness-clis.sh")} ${h}`;
const ALL = (u, d, s) => [CLAUDE(u, d, s), CODEX(u, d, s), CLI("agy", d, s), CLI("grok", d, s)];
const ROOTISH = (d, s) => [CLAUDE("root", d, s), CLI("agy", d, s), CLI("grok", d, s)];
const noRealSudo = (r) => assert.doesNotMatch(r.err, /real-sudo-path-reached/, "PATH 의 sudo 에 닿았다 — 진짜 sudo 를 부를 수 있는 모양이다");

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

t("A1 리눅스 · 게이트웨이 유저 몫 클로드·챗GPT · 박스 전체 제미나이·그록을 하나씩 · 시간 상한 · 0 으로 다음 줄로 간다", () => {
  const r = run({ os: "linux", user: "svc" });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.after, "다음 줄로 가지 않았다");
  assert.deepEqual(r.calls, ALL("svc"));
  noRealSudo(r);
});

t("A2 SERVICE_USER 가 비었으면 지금 유저로(root 면 챗GPT 도우미 없이)", () => {
  const me = userInfo().username;
  const r = run({ os: "linux", user: "" });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.calls, me === "root" ? ROOTISH() : ALL(me));
});

t("A3 OFFLINE=1 이면 아무것도 부르지 않는다", () => {
  const r = run({ os: "linux", user: "svc", offline: true });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.after);
  assert.deepEqual(r.calls, []);
});

t("A4 맥이면 아무것도 부르지 않는다(도우미들이 runuser 를 쓴다)", () => {
  const r = run({ os: "mac", user: "svc" });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.after);
  assert.deepEqual(r.calls, []);
});

t("A5 ★ 제미나이 설치가 실패해도 그록은 부른다 · set -e 아래에서 0 · 다음 줄로 · 경고", () => {
  const r = run({ os: "linux", user: "svc", failOn: ["install-harness-clis.sh agy"] });
  assert.equal(r.status, 0, `설치·업데이트가 멈췄다: ${r.err}`);
  assert.ok(r.after, "다음 줄로 가지 않았다");
  assert.deepEqual(r.calls, ALL("svc"), "제미나이 실패가 그록 설치를 막았다");
  assert.match(r.err, /⚠.*agy/, "어느 것이 실패했는지 알리지 않았다");
});

t("A5b 그록 설치 실패 → 0 · 경고", () => {
  const r = run({ os: "linux", user: "svc", failOn: ["install-harness-clis.sh grok"] });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.after);
  assert.deepEqual(r.calls, ALL("svc"));
  assert.match(r.err, /⚠.*grok/);
});

t("A6 클로드 도우미가 실패해도 뒤의 셋을 부른다", () => {
  const r = run({ os: "linux", user: "svc", failOn: ["install-claude-user.sh"] });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.after);
  assert.deepEqual(r.calls, ALL("svc"));
});

t("A6b 챗GPT 도우미가 실패해도 뒤의 둘을 부른다", () => {
  const r = run({ os: "linux", user: "svc", failOn: ["install-codex-user.sh"] });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.after);
  assert.deepEqual(r.calls, ALL("svc"));
});

t("A7 물려받은 OS 환경 변수에 기대지 않는다 · 갈아 끼우지 않으면 이 기계의 detect_os", () => {
  const r = run({ os: "linux", user: "svc", envOS: "mac" });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.calls, ALL("svc"), "OS=mac 환경 변수 때문에 건너뛰었다");
  const real = run({ user: "svc" });
  assert.equal(real.status, 0, real.err);
  assert.deepEqual(real.calls, process.platform === "linux" ? ALL("svc") : []);
});

t("A8 deploy 폴더를 넘기면 그 폴더의 도우미를 부른다", () => {
  const rel = "/opt/lively/releases/r42/deploy";
  const r = run({ os: "linux", user: "svc", arg: rel });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.calls, ALL("svc", rel));
});

t("A9 ★ root · codex 없음 → 챗GPT 도우미를 부르지 않는다(root 의 npm 전역 자리를 바꾸지 않는다) · 나머지 셋 · 경고", () => {
  const r = run({ os: "linux", user: "root" });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.after);
  assert.deepEqual(r.calls, ROOTISH());
  assert.match(r.err, /⚠.*codex/, "건너뛴 것을 알리지 않았다");
});

t("A9b root · codex 가 이미 있으면 경고 없이", () => {
  const r = run({ os: "linux", user: "root", codex: true });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.calls, ROOTISH());
  assert.doesNotMatch(r.err, /⚠/, "이미 있는데 경고했다");
});

t("A10 LIVELY_SERVER_AIS=off 면 아무것도 부르지 않는다", () => {
  const r = run({ os: "linux", user: "svc", extraEnv: { LIVELY_SERVER_AIS: "off" } });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.after);
  assert.deepEqual(r.calls, []);
});

t("A11 LIVELY_SERVER_AIS_TIMEOUT 이 상한을 바꾼다", () => {
  const r = run({ os: "linux", user: "svc", extraEnv: { LIVELY_SERVER_AIS_TIMEOUT: "30" } });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.calls, ALL("svc", here, 30));
});

t("R1 run_as_service 가 그 유저의 사용자 몫 폴더를 PATH 앞에 둔다(방금 그 홈에 깐 클로드를 키트가 찾게)", () => {
  //  유저 이름은 이 기계의 유저와 겹치지 않게(겹치면 run_as_service 는 sudo 없이 그대로 돌린다 — 이 맥의 유저가 lively 다).
  assert.notEqual(userInfo().username, "lvsvc4970", "배선 — 시험 유저 이름이 이 기계의 유저와 같다");
  const r = run({
    os: "linux", user: "lvsvc4970", call: "run_as_service bash install-kit.sh",
    pre: [`getent() { [ "$1" = passwd ] && [ "$2" = lvsvc4970 ] && echo 'lvsvc4970:x:990:990::/var/lib/lvsvc4970:/bin/bash'; }`],
  });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.calls.length, 1, `한 번 불려야 한다: ${JSON.stringify(r.calls)}`);
  assert.match(r.calls[0], /^-u lvsvc4970 env HOME=\/var\/lib\/lvsvc4970 PATH=\/var\/lib\/lvsvc4970\/\.local\/bin:\/var\/lib\/lvsvc4970\/\.npm-global\/bin:/, r.calls[0]);
  assert.match(r.calls[0], / bash install-kit\.sh$/);
});

t("F1 부르는 도우미가 실제 파일이다", () => {
  for (const f of ["install-claude-user.sh", "install-codex-user.sh", "install-harness-clis.sh"]) assert.ok(existsSync(join(here, f)), `${f} 가 없다`);
});

t("W1 install.sh — 7/7 에서 키트 설치보다 먼저 부른다", () => {
  const L = codeLines(read("install.sh"));
  const p7 = lineOf(L, /phase "7\/7/), call = lineOf(L, /^\s*ensure_server_ais\s*$/), kit = lineOf(L, /install-kit\.sh/);
  assert.ok(p7 >= 0 && call >= 0 && kit >= 0, `자리를 못 찾았다(7/7=${p7} · 부름=${call} · 키트=${kit})`);
  assert.ok(p7 < call && call < kit, "7/7 안에서 키트보다 먼저 부르지 않는다");
});

t("W2 update.sh — 재시작·준비 대기 뒤 · 키트(--kit) 앞에 부른다", () => {
  const L = codeLines(read("update.sh"));
  const restart = lineOf(L, /systemctl restart lively-gateway/), ready = lineOf(L, /^\s*wait_ready\b/),
    call = lineOf(L, /^\s*ensure_server_ais\s*$/), kit = lineOf(L, /"--kit"/);
  assert.ok(restart >= 0 && ready >= 0 && call >= 0 && kit >= 0, `자리를 못 찾았다(재시작=${restart} · 준비=${ready} · 부름=${call} · 키트=${kit})`);
  assert.ok(restart < call && ready < call, "재시작·준비 대기 전에 부른다(옛 프로세스 + 새 dist 구간이 길어진다)");
  assert.ok(call < kit, "키트 뒤에 부른다");
});

t("W3 deploy-release.sh(blue-green) — 유저를 정한 뒤 · 격리 리프레시 뒤 «완료» 전에 새 릴리스의 deploy 폴더로 부른다", () => {
  const L = codeLines(read("deploy-release.sh"));
  const user = lineOf(L, /export SERVICE_USER/), refresh = lineOf(L, /refresh-member-kits\.sh/),
    call = lineOf(L, /^\s*ensure_server_ais "\$RELEASE_DIR\/deploy"\s*$/), done = lineOf(L, /phase "완료"/);
  assert.ok(user >= 0 && refresh >= 0 && call >= 0 && done >= 0, `자리를 못 찾았다(유저=${user} · 리프레시=${refresh} · 부름=${call} · 완료=${done})`);
  assert.ok(user < call && refresh < call && call < done, "유저·리프레시 뒤 · «완료» 전에 부르지 않는다");
});

console.log(`\n${pass}건 통과`);
