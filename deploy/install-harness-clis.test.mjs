// 셀프호스트 제미나이·그록 설치(#4970, deploy/install-harness-clis.sh) — 가짜 curl 로 실제 셸을 돌려 부작용으로 단언한다(네트워크·root 없음).
//  설계: 지식 onboarding-single-flow-connect-in-own-ai-4970 §16. 엣지 표 = 아래 H 행.
//  위험한 자리는 grok 이다 — 설치기가 /usr/local/bin 에 자기 홈을 가리키는 심링크(grok·agent)를 건다(lvly-cloud Dockerfile 실측).
//   임시 HOME 을 지우기 전에 그 링크를 걷어야 하고, **남이 둔 agent** 는 건드리면 안 된다.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, lstatSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "install-harness-clis.sh");
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

/** 가짜 curl — URL 에 따라 «설치기» 셸을 내놓고, 불린 URL 을 로그에 남긴다(배선 단언의 근거). */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "ihc-"));
  const bin = join(root, "bin"); const fake = join(root, "fake"); const log = join(root, "curl.log");
  mkdirSync(bin); mkdirSync(fake);
  writeFileSync(join(fake, "curl"), `#!/bin/sh
url=""; for a in "$@"; do case "$a" in http*) url="$a";; esac; done
echo "$url" >> "${log}"
case "$url" in
  *antigravity*) cat <<'EOS'
mkdir -p "$HOME/.local/share/agy" "$HOME/.local/bin"
printf '#!/bin/sh\\necho "agy 1.1.99"\\n' > "$HOME/.local/share/agy/agy-real"; chmod +x "$HOME/.local/share/agy/agy-real"
ln -sf "$HOME/.local/share/agy/agy-real" "$HOME/.local/bin/agy"
EOS
  ;;
  *x.ai*) cat <<'EOS'
mkdir -p "$HOME/.grok/bin"
printf '#!/bin/sh\\necho "grok 1.0.99"\\n' > "$HOME/.grok/bin/grok"; chmod +x "$HOME/.grok/bin/grok"
ln -sf "$HOME/.grok/bin/grok" "$LVLY_HARNESS_BIN_DIR/grok"; ln -sf "$HOME/.grok/bin/grok" "$LVLY_HARNESS_BIN_DIR/agent"
EOS
  ;;
  *) echo "exit 1";;
esac
`);
  chmodSync(join(fake, "curl"), 0o755);
  const run = (args = [], env = {}) => spawnSync("bash", [SCRIPT, ...args], {
    env: { PATH: `${fake}:/usr/bin:/bin`, LVLY_HARNESS_BIN_DIR: bin, ...env }, encoding: "utf8",
  });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  return { root, bin, run, calls, done: () => rmSync(root, { recursive: true, force: true }) };
}

t("H0 셸 문법 · root 가 아니고 시험 자리도 없으면 거절한다", () => {
  execFileSync("bash", ["-n", SCRIPT]);
  if (process.getuid && process.getuid() === 0) return;   // root 로 도는 러너면 이 행은 잴 수 없다
  const r = spawnSync("bash", [SCRIPT], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.notEqual(r.status, 0, "root 아닌데 /usr/local/bin 에 쓰려 한다");
});

t("H1 둘 다 새로 — 실체가 설치 자리로 옮겨져 돌고, 임시 HOME 을 가리키는 링크는 남지 않는다", () => {
  const s = sandbox();
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  for (const [b, v] of [["agy", "agy 1.1.99"], ["grok", "grok 1.0.99"]]) {
    const p = join(s.bin, b);
    assert.ok(!lstatSync(p).isSymbolicLink(), `${b} 가 임시 HOME 을 가리키는 링크로 남았다`);
    assert.equal(execFileSync(p, ["--version"], { encoding: "utf8" }).trim(), v);
  }
  //  ⚠ existsSync 는 링크를 따라간다 — 끊긴 링크는 «없음» 으로 보여 이 단언이 헛돈다. 링크 자체를 본다(lstat).
  const linkLeft = (() => { try { lstatSync(join(s.bin, "agent")); return true; } catch { return false; } })();
  assert.ok(!linkLeft, "★ grok 설치기의 agent 링크를 안 걷었다 — 임시 HOME 을 지운 뒤 끊긴 링크가 PATH 에 남는다");
  assert.deepEqual(s.calls().map((u) => /antigravity/.test(u) ? "agy" : /x\.ai/.test(u) ? "grok" : u), ["agy", "grok"], "배선 — 두 설치기를 실제로 받았다");
  s.done();
});

t("H2 남이 둔 agent 는 건드리지 않는다 — 설치기가 그 링크를 안 걸었으면 그대로 둔다(임시 HOME 을 가리키는 링크만 걷는다)", () => {
  const s = sandbox();
  //  이 판의 grok 설치기는 grok 링크만 건다(agent 는 안 건다) — 그러면 미리 있던 남의 agent 링크가 살아남아야 한다.
  writeFileSync(join(s.root, "fake", "curl"), `#!/bin/sh
echo "$*" >> "${join(s.root, "curl.log")}"
cat <<'EOS'
mkdir -p "$HOME/.grok/bin"
printf '#!/bin/sh\\necho "grok 1.0.99"\\n' > "$HOME/.grok/bin/grok"; chmod +x "$HOME/.grok/bin/grok"
ln -sf "$HOME/.grok/bin/grok" "$LVLY_HARNESS_BIN_DIR/grok"
EOS
`);
  chmodSync(join(s.root, "fake", "curl"), 0o755);
  const other = join(s.root, "someone-else-agent"); writeFileSync(other, "#!/bin/sh\n"); chmodSync(other, 0o755);
  symlinkSync(other, join(s.bin, "agent"));
  const r = s.run(["grok"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readlinkSync(join(s.bin, "agent")), other, "★ 남의 agent 링크를 지웠다");
  assert.ok(!lstatSync(join(s.bin, "grok")).isSymbolicLink(), "grok 실체를 안 옮겼다");
  s.done();
});

t("H3 이미 돌면 다시 받지 않는다(멱등) · FORCE=1 이면 다시 받는다", () => {
  const s = sandbox();
  assert.equal(s.run().status, 0);
  const n = s.calls().length;
  assert.equal(s.run().status, 0);
  assert.equal(s.calls().length, n, "이미 있는데 설치기를 또 받았다");
  assert.equal(s.run([], { FORCE: "1" }).status, 0);
  assert.equal(s.calls().length, n + 2, "FORCE=1 인데 다시 안 받았다");
  s.done();
});

t("H4 OFFLINE=1 이면 아무것도 안 한다", () => {
  const s = sandbox();
  const r = s.run([], { OFFLINE: "1" });
  assert.equal(r.status, 0);
  assert.equal(s.calls().length, 0, "오프라인인데 받으러 나갔다");
  assert.ok(!existsSync(join(s.bin, "agy")) && !existsSync(join(s.bin, "grok")));
  s.done();
});

t("H5 하나만 고를 수 있다 · 모르는 이름은 실패로 알린다", () => {
  const s = sandbox();
  assert.equal(s.run(["agy"]).status, 0);
  assert.ok(existsSync(join(s.bin, "agy")) && !existsSync(join(s.bin, "grok")), "agy 만 골랐는데 grok 까지 깔았다");
  assert.notEqual(s.run(["nope"]).status, 0, "모르는 이름을 조용히 넘겼다");
  s.done();
});

t("H6 설치기가 실행 파일을 안 남기면 실패로 끝난다(성공한 척하지 않는다)", () => {
  const s = sandbox();
  //  가짜 curl 을 «아무것도 안 하는 설치기» 로 바꾼다.
  writeFileSync(join(s.root, "fake", "curl"), "#!/bin/sh\necho 'true'\n"); chmodSync(join(s.root, "fake", "curl"), 0o755);
  const r = s.run(["agy"]);
  assert.notEqual(r.status, 0, "실행 파일이 없는데 성공으로 끝났다");
  assert.ok(!existsSync(join(s.bin, "agy")));
  s.done();
});

t("H7 구성원 키트는 넷 다 배선한다 — 제미나이·그록으로 연 세션에도 라이블리 도구·스킬이 있게(provision-member)", () => {
  const prov = readFileSync(join(here, "provision-member.sh"), "utf8");
  const code = prov.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.match(code, /KIT_HARNESSES="\$\{KIT_HARNESSES:-claude,codex,antigravity,grok\}"/, "★ 기본 배선이 넷이 아니다");
  assert.match(code, /user-install\.mjs" --allow-host-effects --harness "\$KIT_HARNESSES"/, "설치기가 그 목록을 안 쓴다");
  assert.doesNotMatch(code, /--harness claude,codex(?!,)/, "옛 두 개짜리 목록이 남아 있다");
});

console.log(`install-harness-clis.test: ${pass} ok`);
