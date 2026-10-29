// box-cgspawn(root 로 도는 cgroup 래퍼) — **래퍼를 실제로 돌려** 인자 사다리 · 거절 · systemd 판 문턱을 본다 (#5082)
//  실행: node deploy/box-cgspawn.test.mjs   (리눅스 CI · 맥. 윈도우 잡은 deploy 시험을 돌리지 않는다)
//
// ── 왜 이렇게 검증하나 ──────────────────────────────────────────────────────
//  이 래퍼는 sudoers 로 root 가 되는 진입점이다. 소스에 문자열이 있는지만 보면(launch-host.test P9) 검사 줄을 지우거나 분기를 죽여도
//  초록이다(격리 리뷰 — 그런 변이 넷이 모두 통과했다). 그래서 래퍼 사본의 PATH 줄만 가짜 도구 폴더로 바꿔 끼우고 진짜 bash 로 돌린다.
//  가짜 systemd-run · setpriv 는 받은 인자를 적고 끝난다(아무것도 띄우지 않는다). 가짜 systemctl 은 판 번호를 env 로 고른다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "linux", "box-cgspawn");
const BOX_SPAWN = "/opt/lively/libexec/box-spawn";

let pass = 0;
const t = (name, fn) => { try { fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; } pass++; console.log(`ok  ${name}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-cgspawn-test-"));
const stubs = path.join(dir, "stubs");
fs.mkdirSync(stubs);
const stub = (name, body) => fs.writeFileSync(path.join(stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
//  구성원 셋 — 정상 · 그룹 밖 · (없는 이름은 id 가 실패).
stub("id", `case "$*" in
  "-u box_alice"|"-g box_alice") echo 1001;;
  "-nG box_alice") echo "box_alice box_members lively-shared";;
  "-u box_nogroup"|"-g box_nogroup") echo 1003;;
  "-nG box_nogroup") echo "box_nogroup";;
  *) exit 1;;
esac`);
stub("stat", `if [ "$1" = "-fc" ] && [ "$2" = "%T" ]; then echo "\${FAKE_CGFS:-cgroup2fs}"; else exec /usr/bin/stat "$@"; fi`);
stub("systemctl", `if [ "$1" = "--version" ]; then
  [ -n "\${SD_MISSING:-}" ] && exit 127
  [ -n "\${SD_FAIL:-}" ] && exit 1
  echo "systemd \${SDVER:-255} (\${SDVER:-255}.4-1ubuntu8)"; echo "+PAM +AUDIT"; exit 0
fi
exit 0`);
stub("systemd-run", `if [ "$1" = "--help" ]; then echo "  --expand-environment=BOOL"; exit 0; fi
printf '%s\\n' systemd-run "$@" > "$OUT"; exit 0`);
stub("setpriv", `printf '%s\\n' setpriv "$@" > "$OUT"; exit 0`);

//  래퍼 사본 — PATH 줄만 가짜 도구 폴더 앞에 둔다(나머지는 한 글자도 바꾸지 않는다).
const src = fs.readFileSync(SRC, "utf8");
const PATH_LINE = /^export PATH="[^"]*"$/m;
assert.match(src, PATH_LINE, "래퍼의 PATH 고정 줄을 찾지 못했다(이 시험의 끼워 넣기 자리)");
const wrapper = path.join(dir, "box-cgspawn");
fs.writeFileSync(wrapper, src.replace(PATH_LINE, `export PATH="${stubs}:/usr/bin:/bin"`), { mode: 0o755 });
assert.equal(src.split("\n").length, fs.readFileSync(wrapper, "utf8").split("\n").length);

/** 래퍼를 돌린다 — 끝 코드 · 오류 글 · 가짜 도구가 받은 인자(systemd-run 이면 --property 목록과 '--' 뒤 명령). */
function run(args, env = {}) {
  const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}`);
  const r = spawnSync("bash", [wrapper, ...args], { env: { HOME: dir, OUT: out, ...env }, encoding: "utf8" });
  const argv = fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\n").filter((l, i, a) => i < a.length - 1) : null;
  if (argv) fs.rmSync(out);
  const sep = argv ? argv.indexOf("--") : -1;
  return {
    code: r.status, err: r.stderr, tool: argv?.[0] ?? null,
    props: argv ? argv.filter((a) => a.startsWith("--property=")).map((a) => a.slice("--property=".length)) : [],
    cmd: argv && sep >= 0 ? argv.slice(sep + 1) : null, argv,
  };
}
const caps = (...c) => ["box_alice", ...c, "--", BOX_SPAWN, "--cwd", "/srv/lively/apps/a", "node", "x.js"];
const DROP = ["setpriv", "--reuid=1001", "--regid=1001", "--init-groups", "--", BOX_SPAWN, "--cwd", "/srv/lively/apps/a", "node", "x.js"];

t("C1 세 값(사람 세션 · 옛 코어) — 종전 그대로: MemoryMax 만 · 스왑 · OOMPolicy 없음 · 그 scope 안에서 setpriv 로 내려 box-spawn", () => {
  const r = run(caps("0", "512M"));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.tool, "systemd-run");
  assert.deepEqual(r.props, ["MemoryAccounting=yes", "MemoryMax=512M"]);
  assert.deepEqual(r.cmd, DROP);
  assert.ok(r.argv.includes("--scope") && r.argv.includes("--slice=lively-sessions.slice"), r.argv.join(" "));
  assert.deepEqual(run(caps("3072M", "4096M")).props, ["MemoryAccounting=yes", "MemoryHigh=3072M", "MemoryMax=4096M"]);
  assert.deepEqual(run(caps("0", "0")).props, ["MemoryAccounting=yes"], "0 = 그 축 무제한(생략)");
});

t("C2 네 값 — 스왑 상한: 0 = 스왑 없음(MemorySwapMax=0) · 양수는 그대로 · infinity 는 걸지 않는다(종전)", () => {
  assert.deepEqual(run(caps("0", "512M", "0")).props, ["MemoryAccounting=yes", "MemoryMax=512M", "MemorySwapMax=0"]);
  assert.deepEqual(run(caps("0", "512M", "1024M")).props, ["MemoryAccounting=yes", "MemoryMax=512M", "MemorySwapMax=1024M"]);
  assert.deepEqual(run(caps("0", "512M", "infinity")).props, ["MemoryAccounting=yes", "MemoryMax=512M"]);
  assert.deepEqual(run(caps("0", "512M", "0")).cmd, DROP, "명령은 세 값과 같다");
});

t("C3 다섯 값 — OOMPolicy 는 systemd 253 부터만 건다(252 · 판 번호를 못 읽음 · systemctl 실패 · 없음 = 걸지 않고 그대로 돈다)", () => {
  for (const v of ["255", "253"]) {
    const r = run(caps("0", "512M", "0", "continue"), { SDVER: v });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.props, ["MemoryAccounting=yes", "MemoryMax=512M", "MemorySwapMax=0", "OOMPolicy=continue"], `systemd ${v}`);
    assert.deepEqual(r.cmd, DROP);
  }
  assert.deepEqual(run(caps("0", "512M", "0", "stop"), { SDVER: "255" }).props, ["MemoryAccounting=yes", "MemoryMax=512M", "MemorySwapMax=0", "OOMPolicy=stop"]);
  for (const env of [{ SDVER: "252" }, { SDVER: "v9" }, { SD_FAIL: "1" }, { SD_MISSING: "1" }]) {
    const r = run(caps("0", "512M", "0", "continue"), env);
    assert.equal(r.code, 0, `${JSON.stringify(env)} — ${r.err}`);
    assert.deepEqual(r.props, ["MemoryAccounting=yes", "MemoryMax=512M", "MemorySwapMax=0"], JSON.stringify(env));
    assert.deepEqual(r.cmd, DROP, JSON.stringify(env));
  }
  assert.deepEqual(run(caps("0", "512M", "infinity", "continue")).props, ["MemoryAccounting=yes", "MemoryMax=512M", "OOMPolicy=continue"], "스왑 자리 infinity + OOMPolicy");
});

t("C4 거절 — 틀린 스왑 · OOMPolicy 값 · 값을 넘치게 · '--' 자리가 어긋남 · 명령이 box-spawn 이 아님(아무것도 띄우지 않는다 · 끝 코드 2)", () => {
  const bad = [
    [caps("0", "512M", "bogus"), /invalid memSwapMax: bogus/],
    [caps("0", "512M", "-1"), /invalid memSwapMax/],
    [caps("0", "512M", "0\n--property=CPUQuota=1%"), /invalid memSwapMax/],
    [caps("0", "512M", "0", "kill"), /invalid oomPolicy: kill/],
    [caps("0", "512M", "0", "continue x"), /invalid oomPolicy/],
    [caps("0", "512M", "0", "continue", "extra"), /expected '--' after <osUser> <memHigh> <memMax> \[<memSwapMax> \[<oomPolicy>\]\]/],
    [["box_alice", "0", "512M", "0", "continue", BOX_SPAWN, "node"], /expected '--'/],
    [["box_alice", "0", "512M", "--", "continue", "--", BOX_SPAWN, "node"], /command must be/],
    [["box_alice", "0", "512M", "0", "--", "/bin/sh", "-c", "id"], /command must be/],
    [["box_alice", "0", "512M", "0", "continue", "--"], /no command after '--'/],
  ];
  for (const [args, re] of bad) {
    const r = run(args);
    assert.equal(r.code, 2, `${JSON.stringify(args)} → ${r.code} ${r.err}`);
    assert.match(r.err, re, JSON.stringify(args));
    assert.equal(r.tool, null, `${JSON.stringify(args)} — 아무것도 띄우지 않는다`);
  }
});

t("C5 사람 검사는 값 개수와 무관하다 — root · 없는 계정 · 그룹 밖 계정은 다섯 값이어도 거절", () => {
  for (const [user, re] of [["root", /invalid osUser/], ["box_ghost", /unknown user/], ["box_nogroup", /not in box_members/]]) {
    const r = run([user, "0", "512M", "0", "continue", "--", BOX_SPAWN, "node"]);
    assert.equal(r.code, 2, `${user} → ${r.err}`);
    assert.match(r.err, re, user);
    assert.equal(r.tool, null);
  }
});

t("C6 cgroup v2 가 없는 박스 — 종전 폴백(scope 없이 setpriv 로만 내린다) · 스왑 · OOMPolicy 값은 걸 자리가 없다", () => {
  const r = run(caps("0", "512M", "0", "continue"), { FAKE_CGFS: "tmpfs" });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.tool, "setpriv");
  assert.match(r.err, /NO memory cgroup/);
  assert.deepEqual(r.argv, DROP);
});

t("C7 청/녹 배포는 래퍼를 flip 앞에 새 판으로 놓는다 — «새 코어 + 옛 래퍼» 틈이 생기지 않게(그 틈에선 메모리 상한을 둔 작업이 기다린다)", () => {
  const sh = fs.readFileSync(path.join(here, "deploy-release.sh"), "utf8");
  const early = sh.indexOf(`sudo install -m 0755 -o root -g root "$RELEASE_DIR/deploy/linux/box-cgspawn" /opt/lively/libexec/box-cgspawn`);
  const boot = sh.indexOf(`sudo systemctl restart "lively-gateway@$idle"`);
  const flip = sh.indexOf(`phase "3/4`);
  assert.ok(early > 0, "선반영 줄이 없다");
  assert.ok(boot > 0 && flip > 0, "자리 표지(새 색 기동 · flip)를 못 찾았다");
  assert.ok(early < boot && early < flip, "새 색이 뜨기 전(작업 감시가 돌기 전)에 놓아야 한다");
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`box-cgspawn.test: ${pass} passed`);
