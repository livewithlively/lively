// 셀프호스트 제미나이·그록 설치(#4970, deploy/install-harness-clis.sh) — 가짜 curl·가짜 설치기로 실제 셸을 돌려 부작용으로 단언한다(네트워크·root 없음).
//  설계: 지식 onboarding-single-flow-connect-in-own-ai-4970 §16. 엣지 표 = 아래 H 행.
//  위험한 자리(격리 리뷰 2026-10-23 실측):
//   · 진짜 grok 설치기는 PATH 에 있고 쓸 수 있는 폴더에 grok·agent 를 `ln -sf` 로 **무조건** 건다 → root 로 돌리면 남의 agent 가 덮이고,
//     뒤에서 걷으면 사라진다. 스크립트는 설치기를 권한 없는 계정 · 설치 자리를 뺀 PATH 로 돌리고, 그래도 바뀌면 되돌린다.
//   · 호출부 `||` 가 함수 안 set -e 를 꺼서 실패해도 «✓» 와 0 으로 끝났다 · mktemp 가 실패하면 빈 이름으로 나아가 «/» 밑 링크를 지웠다.
//  root·nobody 갈래(runuser)는 이 시험에서 못 돌린다 — 그 갈래는 H12 가 소스로, 실제 설치기 실행은 격리 리뷰가 Ubuntu 컨테이너에서 확인했다.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, lstatSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "install-harness-clis.sh");
let pass = 0;
//  ONLY=<머리글> — 그 행만 돌린다(빨간불 확인을 행마다 하려고).
const t = (name, fn) => { if (process.env.ONLY && !name.startsWith(process.env.ONLY)) return; fn(); pass++; console.log(`ok  ${name}`); };
const has = (p) => { try { lstatSync(p); return true; } catch { return false; } };   // 끊긴 링크도 «있음»(existsSync 는 따라간다)

/** 설치기 본문들 — 받는 자리(-o)에 이 글을 쓴다. PATH_LOG 에 설치기가 받은 PATH 를 남긴다(H10). */
const AGY = `echo "$PATH" >> "$PATH_LOG"
mkdir -p "$HOME/.local/share/agy" "$HOME/.local/bin"
printf '#!/bin/sh\\necho "agy 1.1.99"\\n' > "$HOME/.local/share/agy/agy-real"; chmod +x "$HOME/.local/share/agy/agy-real"
ln -sf "$HOME/.local/share/agy/agy-real" "$HOME/.local/bin/agy"`;
/** 진짜 grok 설치기처럼 — PATH 에 있고 쓸 수 있는 폴더에만 grok·agent 링크를 건다. */
const GROK_POLITE = `echo "$PATH" >> "$PATH_LOG"
mkdir -p "$HOME/.grok/bin"
printf '#!/bin/sh\\necho "grok 1.0.99"\\n' > "$HOME/.grok/bin/grok"; chmod +x "$HOME/.grok/bin/grok"
IFS=:; for d in $PATH; do if [ -d "$d" ] && [ -w "$d" ]; then ln -sf "$HOME/.grok/bin/grok" "$d/grok"; ln -sf "$HOME/.grok/bin/grok" "$d/agent"; fi; done`;
/** 막무가내 — PATH 와 무관하게 설치 자리의 agent 를 덮는다(안전망 시험). */
const GROK_HOSTILE = `mkdir -p "$HOME/.grok/bin"
printf '#!/bin/sh\\necho "grok 1.0.99"\\n' > "$HOME/.grok/bin/grok"; chmod +x "$HOME/.grok/bin/grok"
ln -sf "$HOME/.grok/bin/grok" "$LVLY_HARNESS_BIN_DIR/agent"`;

function sandbox({ grok = GROK_POLITE, agy = AGY } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ihc-"));
  const bin = join(root, "bin"); const fake = join(root, "fake"); const log = join(root, "curl.log"); const pathLog = join(root, "path.log");
  mkdirSync(bin); mkdirSync(fake);
  writeFileSync(join(fake, "agy.sh"), agy); writeFileSync(join(fake, "grok.sh"), grok);
  //  가짜 curl — `-o <파일> <주소>` 만 받는다. 불린 인자를 그대로 남긴다(배선 · 상한 · 받기-뒤-실행 단언).
  writeFileSync(join(fake, "curl"), `#!/bin/sh
echo "$*" >> "${log}"
out=""; url=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; http*) url="$1";; esac; shift; done
case "$url" in *antigravity*) src="${join(fake, "agy.sh")}";; *x.ai*) src="${join(fake, "grok.sh")}";; *) exit 22;; esac
[ -n "$out" ] && cp "$src" "$out" || cat "$src"
`);
  chmodSync(join(fake, "curl"), 0o755);
  const run = (args = [], env = {}) => spawnSync("bash", [SCRIPT, ...args], {
    env: { PATH: `${fake}:/usr/bin:/bin`, LVLY_HARNESS_BIN_DIR: bin, PATH_LOG: pathLog, ...env }, encoding: "utf8",
  });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const paths = () => (existsSync(pathLog) ? readFileSync(pathLog, "utf8").trim().split("\n").filter(Boolean) : []);
  return { root, bin, fake, run, calls, paths, done: () => rmSync(root, { recursive: true, force: true }) };
}

t("H0 셸 문법 · root 가 아니고 시험 자리도 없으면 거절한다", () => {
  execFileSync("bash", ["-n", SCRIPT]);
  if (process.getuid && process.getuid() === 0) return;   // root 로 도는 러너면 이 행은 잴 수 없다
  const r = spawnSync("bash", [SCRIPT], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.notEqual(r.status, 0, "root 아닌데 /usr/local/bin 에 쓰려 한다");
});

t("H1 둘 다 새로 — 실체가 설치 자리로 옮겨져 돌고, 설치 자리에 남은 링크가 없다", () => {
  const s = sandbox();
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  for (const [b, v] of [["agy", "agy 1.1.99"], ["grok", "grok 1.0.99"]]) {
    const p = join(s.bin, b);
    assert.ok(!lstatSync(p).isSymbolicLink(), `${b} 가 임시 HOME 을 가리키는 링크로 남았다`);
    assert.equal(execFileSync(p, ["--version"], { encoding: "utf8" }).trim(), v);
  }
  assert.ok(!has(join(s.bin, "agent")), "설치 자리에 agent 링크가 남았다");
  assert.deepEqual(s.calls().map((c) => /antigravity/.test(c) ? "agy" : /x\.ai/.test(c) ? "grok" : c), ["agy", "grok"], "배선 — 두 설치기를 실제로 받았다");
  s.done();
});

t("H10 설치기는 설치 자리를 뺀 PATH 로 돈다 — 진짜 grok 설치기처럼 PATH 의 쓸 수 있는 폴더에 링크를 거는 설치기도 설치 자리를 못 건드린다", () => {
  const s = sandbox();
  //  실제 박스처럼 설치 자리를 바깥 PATH 에 둔다(/usr/local/bin) — 그래야 «좁히지 않으면 설치기가 거기 링크를 건다» 가 재진다.
  const r = s.run([], { PATH: `${s.fake}:${s.bin}:/usr/bin:/bin` });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!has(join(s.bin, "agent")), "★ 설치기가 설치 자리에 agent 링크를 걸었다");
  const seen = s.paths();
  assert.equal(seen.length, 2, "배선 — 설치기가 PATH 를 남기지 않았다(돌지 않았다)");
  for (const p of seen) assert.ok(!p.split(":").includes(s.bin), `★ 설치기 PATH 에 설치 자리가 있다: ${p}`);
  s.done();
});

t("H11 설치기는 다 받은 뒤에 돌린다(파일로 받기) · 받기에 시간 상한이 있다", () => {
  const s = sandbox();
  assert.equal(s.run(["agy"]).status, 0);
  const c = s.calls()[0] || "";
  assert.match(c, /--max-time \d+/, "받기에 상한이 없다 — 매달린 받기가 설치를 영영 붙잡는다");
  assert.match(c, / -o \S+install\.sh /, "파이프로 바로 돌린다 — 끊긴 스크립트가 부분 실행된다");
  s.done();
});

t("H2a 남의 agent(일반 파일)를 설치기가 덮어도 원래대로 되돌린다", () => {
  const s = sandbox({ grok: GROK_HOSTILE });
  writeFileSync(join(s.bin, "agent"), "#!/bin/sh\necho OTHER-TOOLS-AGENT\n"); chmodSync(join(s.bin, "agent"), 0o755);
  const r = s.run(["grok"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!lstatSync(join(s.bin, "agent")).isSymbolicLink(), "★ 남의 agent 가 설치기 링크로 바뀐 채다");
  assert.equal(readFileSync(join(s.bin, "agent"), "utf8"), "#!/bin/sh\necho OTHER-TOOLS-AGENT\n", "★ 남의 agent 내용이 바뀌었다(또는 사라졌다)");
  s.done();
});

t("H2b 남의 agent(다른 곳을 가리키는 링크)도 되돌린다", () => {
  const s = sandbox({ grok: GROK_HOSTILE });
  const other = join(s.root, "someone-else-agent"); writeFileSync(other, "#!/bin/sh\n"); chmodSync(other, 0o755);
  symlinkSync(other, join(s.bin, "agent"));
  const r = s.run(["grok"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readlinkSync(join(s.bin, "agent")), other, "★ 남의 agent 링크가 바뀌었다");
  s.done();
});

t("H2c 없던 agent 를 설치기가 걸었으면 걷는다(임시 HOME 을 지운 뒤 끊긴 링크가 남지 않게)", () => {
  const s = sandbox({ grok: GROK_HOSTILE });
  const r = s.run(["grok"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!has(join(s.bin, "agent")), "설치기가 건 agent 링크가 남았다");
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
  assert.ok(!has(join(s.bin, "agy")) && !has(join(s.bin, "grok")));
  s.done();
});

t("H5 하나만 고를 수 있다 · 모르는 이름은 실패로 알린다", () => {
  const s = sandbox();
  assert.equal(s.run(["agy"]).status, 0);
  assert.ok(has(join(s.bin, "agy")) && !has(join(s.bin, "grok")), "agy 만 골랐는데 grok 까지 깔았다");
  assert.notEqual(s.run(["nope"]).status, 0, "모르는 이름을 조용히 넘겼다");
  s.done();
});

t("H6 설치기가 실행 파일을 안 남기면 실패로 끝난다(성공한 척하지 않는다)", () => {
  const s = sandbox({ agy: "true" });
  const r = s.run(["agy"]);
  assert.notEqual(r.status, 0, "실행 파일이 없는데 성공으로 끝났다");
  assert.ok(!has(join(s.bin, "agy")));
  assert.doesNotMatch(r.stdout, /✓ agy/, "실패했는데 ✓ 를 찍었다");
  s.done();
});

t("H8 설치 자리가 없으면 0 이 아니고 «✓» 를 찍지 않는다(종전엔 install 이 실패해도 ✓ 와 0)", () => {
  const s = sandbox();
  const r = s.run([], { LVLY_HARNESS_BIN_DIR: join(s.root, "nonexistent") });
  assert.notEqual(r.status, 0, "★ 설치 자리가 없는데 성공으로 끝났다");
  assert.doesNotMatch(r.stdout, /✓/, "★ 실패했는데 ✓ 를 찍었다");
  s.done();
});

t("H9 임시 폴더를 못 만들면 멈춘다 — 빈 이름으로 나아가 남의 링크를 지우지 않는다(mktemp 실패 · 빈 이름 두 갈래)", () => {
  //  ⚠ 맥 mktemp 는 없는 TMPDIR 을 무시하고 제자리로 돌아간다 — 그래서 실패를 가짜 mktemp 로 만든다.
  for (const [label, body] of [["실패(1)", "exit 1"], ["빈 이름(0)", "exit 0"]]) {
    const s = sandbox({ grok: GROK_HOSTILE });
    writeFileSync(join(s.fake, "mktemp"), `#!/bin/sh\n${body}\n`); chmodSync(join(s.fake, "mktemp"), 0o755);
    const other = join(s.root, "someone-else-agent"); writeFileSync(other, "#!/bin/sh\n"); chmodSync(other, 0o755);
    symlinkSync(other, join(s.bin, "agent"));
    const r = s.run(["grok"]);
    assert.notEqual(r.status, 0, `★ ${label}: 임시 폴더 없이 성공으로 끝났다`);
    assert.equal(readlinkSync(join(s.bin, "agent")), other, `★ ${label}: 남의 agent 링크를 지웠다`);
    assert.equal(s.calls().length, 0, `${label}: 임시 폴더도 없이 설치기를 받으러 나갔다`);
    assert.doesNotMatch(r.stdout, /✓/, `${label}: 실패했는데 ✓ 를 찍었다`);
    s.done();
  }
});

t("H12 root 로 돌 때 설치기와 «이미 있나» 확인은 권한 없는 계정(nobody)으로 — 소스", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const code = src.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.match(code, /if \[ "\$IS_ROOT" = 1 \]; then runuser -u nobody -- "\$@"; else "\$@"; fi/, "권한 없는 계정으로 안 돌린다");
  assert.match(code, /as_plain env HOME="\$H" PATH=\/usr\/bin:\/bin TMPDIR="\$H" bash "\$H\/install\.sh"/, "설치기를 권한 없는 계정 · 좁힌 PATH 로 안 돌린다");
  assert.match(code, /present\(\) \{[^\n]*as_plain "\$BIN_DIR\/\$1" --version/, "«이미 있나» 를 root 로 잰다(root 만 닿는 링크를 있음으로 친다)");
  assert.doesNotMatch(code, /install_one [^\n]*\|\|/, "호출부에 || 가 있다 — 함수 안 set -e 가 꺼진다");
  assert.match(code, /trap cleanup EXIT INT TERM/, "중단돼도 임시 자리를 안 치운다");
});

t("H7 구성원 키트는 넷 다 배선한다 — 제미나이·그록으로 연 세션에도 라이블리 도구·스킬이 있게(provision-member)", () => {
  const prov = readFileSync(join(here, "provision-member.sh"), "utf8");
  const code = prov.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.match(code, /MEMBER_KIT_HARNESSES="\$\{MEMBER_KIT_HARNESSES:-claude,codex,antigravity,grok\}"/, "★ 기본 배선이 넷이 아니다");
  assert.match(code, /user-install\.mjs" --allow-host-effects --harness "\$MEMBER_KIT_HARNESSES"/, "설치기가 그 목록을 안 쓴다");
  assert.doesNotMatch(code, /--harness claude,codex(?!,)/, "옛 두 개짜리 목록이 남아 있다");
});

console.log(`install-harness-clis.test: ${pass} ok`);
