#!/usr/bin/env node
// 격리 멤버 훅 러너 리프레시 사양테스트 — 2026-08-27 «멤버 훅 전멸» 회귀 가드.
//  실행: node deploy/member-kit-refresh.test.mjs   (deploy/**/*.test.mjs 라 npm test 체인에 자동 포함)
//
// 기존 배포 테스트(bluegreen-logic.test.mjs)는 «리프레시가 호출되는가 · flip 뒤인가 · 새 릴리스 트리를
//  쓰는가» 라는 **배선**을 잠근다. 그건 그대로 두고, 여기서는 **무엇을 심는가**를 잠근다 — 그날 배선은
//  전부 정상이었고 심는 내용만 틀렸다(hooks/ 밖 공유 모듈 미복사 → 설치 멤버 전원의 훅이 전멸).
//
// R1 면제: 이 테스트는 자식 env 에 HOME 을 주지 않는다(멤버 홈은 getent 스텁이 정한다).
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert";

const DEPLOY = dirname(fileURLToPath(import.meta.url));
const REPO = join(DEPLOY, "..");
const SCRIPT = join(DEPLOY, "refresh-member-kits.sh");
const src = readFileSync(SCRIPT, "utf8");
// 설명 주석이 아니라 **실제 명령 라인**만 본다(레포 관례 — provision-member-order.test.mjs 와 동일).
const codeLines = src.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#"));
const inCode = (re) => codeLines.some((l) => re.test(l));

// ── ① 복사 대상을 스스로 판단하지 않는다 ────────────────────────────────────
//  글롭이 곧 사고였다. 목록은 매니페스트에서만 온다.
assert.ok(!inCode(/\*\.mjs/),
  "복사 대상을 *.mjs 글롭으로 정하면 안 된다 — hooks/ 밖 공유 모듈을 못 나르고(.js 어댑터 누락·테스트 파일 유출까지) 2026-08-27 회귀가 그대로 되살아난다");
assert.ok(inCode(/MANIFEST=.*setup\/kit-manifest\.mjs/) && inCode(/node "\$MANIFEST" --install-plan/),
  "설치 목록은 kit/setup/kit-manifest.mjs --install-plan 에서 읽어야 한다(단일 출처)");

// ── ② node 가 없으면 추측해서 복사하지 않는다 ───────────────────────────────
//  글롭 폴백을 남기면 «node 없는 박스에서만» 옛 회귀가 재현되는 최악의 형태가 된다.
assert.ok(inCode(/command -v node/) && inCode(/exit 1/),
  "node 부재 시 글롭으로 폴백하지 말고 중단해야 한다");

// ── ③ 심은 뒤 실행 가능성을 확인한다 ────────────────────────────────────────
assert.ok(inCode(/verify-kit-install\.mjs/),
  "복사 후 verify-kit-install.mjs 로 import 폐포를 확인해야 한다 — 훅은 non-blocking 이라 깨져도 세션이 떠서, 이 확인이 없으면 다음 사고도 사용자 제보로만 발견된다");

// ── ④ 만든 디렉터리는 멤버 소유 ─────────────────────────────────────────────
//  root 소유로 만들면 이후 멤버 권한으로 도는 자동 업데이트(user-install)가 그 안에 못 써서
//  **다음 업데이트가 조용히 실패**한다 — 같은 조용한 실패를 한 겹 아래에 만드는 셈이다.
assert.ok(inCode(/install -d -o "\$u" -g "\$u"/),
  "새로 만드는 대상 디렉터리는 멤버 소유여야 한다");

// ── ⑤ 검증 실패는 배포 로그에 드러난다 ──────────────────────────────────────
//  deploy-release.sh / update.sh 는 이 스크립트를 `|| warn` 으로 부른다 = 종료코드가 유일한 신호다.
assert.ok(/if \[ "\$failed" -gt 0 \]/.test(src) && /exit 1/.test(src.slice(src.indexOf('"$failed" -gt 0'))),
  "검증 실패 멤버가 있으면 종료코드 1로 알려야 한다(무중단 flip 은 되돌리지 않되 배포 로그엔 남는다)");

// ── ⑥ 실제로 돌려 본다: lib 공유 모듈이 멤버 홈에 심기는가 ──────────────────
//  ①~⑤ 는 텍스트 검사다. 그날 텍스트는 멀쩡했고 **결과**가 틀렸으므로, 스텁 환경에서 스크립트를
//  진짜로 실행해 산출물을 본다.
// ⑥ 은 bash + POSIX 스텁(getent·install)을 쓴다 — 윈도우에선 ①~⑤(텍스트 검사)까지만 하고 끝낸다.
//  이 스크립트 자체가 게이트웨이(리눅스) 전용이라 윈도우에서 실행 검증할 대상이 애초에 없다.
if (process.platform === "win32") {
  console.log("member-kit-refresh.test OK — 윈도우: 정적 단언만 수행(⑥ 실행 검증은 POSIX 전용)");
  process.exit(0);
}

const SB = mkdtempSync(join(tmpdir(), "lively-refresh-"));
const HOMEDIR = join(SB, "home", "box_stub");

function stubEnv({ withHostEffects = true } = {}) {
  // 최소 kit 트리 — 계획 산출(kit-manifest)과 검증(verify)에 필요한 것만.
  const kit = join(SB, "kit");
  rmSync(kit, { recursive: true, force: true });
  mkdirSync(join(kit, "hooks"), { recursive: true });
  mkdirSync(join(kit, "setup"), { recursive: true });
  cpSync(join(REPO, "kit", "hooks"), join(kit, "hooks"), {
    recursive: true,
    filter: (p) => !p.endsWith(".test.mjs"),
  });
  for (const f of ["kit-manifest.mjs", "verify-kit-install.mjs", "host-effects.mjs"]) {
    if (f === "host-effects.mjs" && !withHostEffects) continue;
    cpSync(join(REPO, "kit", "setup", f), join(kit, "setup", f));
  }
  // deploy/ 는 스크립트 하나만 — install-claude-user.sh 가 없으면 그 백필 단계는 건너뛴다.
  const deploy = join(SB, "deploy");
  mkdirSync(deploy, { recursive: true });
  cpSync(SCRIPT, join(deploy, "refresh-member-kits.sh"));

  // 멤버 홈: hooks/ 가 이미 있어야 «kit 설치 멤버» 로 인식된다(첫 프로비저닝이 만든 상태).
  rmSync(join(SB, "home"), { recursive: true, force: true });
  mkdirSync(join(HOMEDIR, ".lively", "hooks"), { recursive: true });

  // PATH 스텁 — root 판정·멤버 목록·홈 조회·install 을 가짜로 준다(진짜 root 불요).
  const bin = join(SB, "bin");
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true });
  const write = (name, body) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); };
  write("id", '#!/bin/sh\n[ "$1" = "-u" ] && { echo 0; exit 0; }\nexit 0\n');
  write("getent", `#!/bin/sh
case "$1 $2" in
  "group box_members") echo "box_members:x:1002:box_stub" ;;
  "passwd box_stub")   echo "box_stub:x:1001:1001::${HOMEDIR}:/bin/bash" ;;
  *) exit 2 ;;
esac
`);
  // 소유권 변경은 root 전용이라 스텁에서 -o/-g 는 무시하고 복사만 한다.
  write("install", `#!/bin/sh
mkdirmode=0
args=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) mkdirmode=1 ;;
    -o|-g|-m) shift ;;
    *) args="$args $1" ;;
  esac
  shift
done
set -- $args
if [ "$mkdirmode" = 1 ]; then mkdir -p "$@"; exit $?; fi
mkdir -p "$(dirname "$2")" && cp "$1" "$2"
`);
  return { kit, deploy, bin };
}

{
  const { deploy, bin } = stubEnv();
  const r = spawnSync("bash", [join(deploy, "refresh-member-kits.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OFFLINE: "1" },
  });
  const libLanded = existsSync(join(HOMEDIR, ".lively", "lib", "host-effects.mjs"));
  const hookLanded = existsSync(join(HOMEDIR, ".lively", "hooks", "run-custom.mjs"));
  const jsAdapter = existsSync(join(HOMEDIR, ".lively", "hooks", "opencode-plugin.js"));
  const testLeaked = existsSync(join(HOMEDIR, ".lively", "hooks", "run-custom.test.mjs"));
  assert.strictEqual(r.status, 0, `정상 트리에서 리프레시는 성공해야 한다 — status=${r.status}\n${r.stdout}${r.stderr}`);
  assert.ok(libLanded, `hooks/ 밖 공유 모듈이 멤버 홈에 심겨야 한다(lib/host-effects.mjs) — 이게 없어서 2026-08-27 에 훅이 전멸했다\n${r.stdout}`);
  assert.ok(hookLanded, "훅 러너가 심겨야 한다");
  assert.ok(jsAdapter, "확장자가 .js 인 어댑터(opencode-plugin.js)도 심겨야 한다 — 옛 *.mjs 글롭이 놓치던 자리");
  assert.ok(!testLeaked, "테스트 파일은 멤버 홈에 심으면 안 된다 — 옛 글롭은 .test.mjs 25개를 뿌리고 있었다");
  assert.ok(/설치 검증 통과/.test(r.stdout), `검증 통과가 로그에 남아야 한다\n${r.stdout}`);
}

{
  // ⑦ 번들에서 공유 모듈이 빠진 경우 = 그날의 상태. 조용히 넘어가지 않고 **시끄럽게** 실패해야 하고,
  //   ★ 무엇보다 **멤버의 살아 있는 트리를 건드리면 안 된다**.
  //   왜 이게 종료코드보다 중요한가 — 훅이 깨지면 self-update 를 띄우는 유일한 주체(session-preload)가
  //   함께 죽는다. 즉 나쁜 kit 이 한 번 닿으면 멤버는 스스로 복구하지 못하고 관리자가 홈마다 손대야 한다
  //   (2026-08-27 실측). 그래서 «덮어쓰고 검증» 이 아니라 «스테이지에서 검증하고 통과분만 적용» 이어야 한다.
  const { deploy, bin } = stubEnv({ withHostEffects: false });
  // 기존 트리에 표식을 남겨 둔다 — 실패 경로가 이걸 덮으면 «이미 깨뜨린 뒤 알려주는» 종전 동작이다.
  const live = join(HOMEDIR, ".lively", "hooks", "run-custom.mjs");
  writeFileSync(live, "// 돌고 있던 기존 러너(표식)\n");
  const r = spawnSync("bash", [join(deploy, "refresh-member-kits.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OFFLINE: "1" },
  });
  // ★ 가장 중요한 단언을 **먼저** — 로그 문구 단언이 앞서면 문구만 바뀌어도 이게 가려진다(실측).
  assert.strictEqual(readFileSync(live, "utf8"), "// 돌고 있던 기존 러너(표식)\n",
    `검증 실패 시 멤버의 살아 있는 트리는 **한 바이트도** 바뀌면 안 된다 — 덮어쓴 뒤 알려주면 그 멤버는 self-update 를 띄울 주체(session-preload)까지 잃어 스스로 복구할 수 없다\n${r.stdout}`);
  assert.ok(!existsSync(join(HOMEDIR, ".lively", ".refresh-stage")),
    `스테이지는 실패 경로에서도 정리돼야 한다\n${r.stdout}`);
  assert.strictEqual(r.status, 1, `공유 모듈 누락은 종료코드 1이어야 한다 — status=${r.status}\n${r.stdout}${r.stderr}`);
  assert.ok(/검증/.test(r.stdout) && /실패/.test(r.stdout), `검증 실패가 로그에 남아야 한다\n${r.stdout}`);
  assert.ok(/host-effects/.test(r.stdout), `무엇이 없는지 찍어야 한다\n${r.stdout}`);
}

rmSync(SB, { recursive: true, force: true });
console.log("member-kit-refresh.test OK — 매니페스트 단일 출처 · lib 공유모듈 배달 · 검증 실패 시 종료코드 1(2026-08-27 회귀 가드)");
