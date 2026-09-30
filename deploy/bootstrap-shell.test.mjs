// 한 줄 설치(deploy/bootstrap.sh)는 bash 로 돈다 (#4501).
//  bootstrap.sh 는 `set -euo pipefail` 을 쓰는데 안내는 `curl … | sh` 였다 — 우분투·데비안의 /bin/sh 는 dash 라
//  2행에서 `set: Illegal option -o pipefail` 로 죽었다(ubuntu:24.04·debian:bookworm 실측). 고친 것:
//   ① 안내를 전부 `| bash` 로 ② 그래도 sh 로 붙이면 알아볼 말로 멈춘다(아무것도 만들기 전에).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "deploy", "bootstrap.sh");
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };
const has = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;

// 실행 — 앱 디렉터리는 임시 경로, 코드 소스는 없는 번들(가드를 지나면 «번들 파일 없음» 에서 멈춘다 = 네트워크 0).
const run = (shell) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-shell-"));
  const app = path.join(dir, "app");
  const r = spawnSync(shell, [SCRIPT], {
    encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: dir, LIVELY_APP_DIR: app, LIVELY_BUNDLE: path.join(dir, "없음.tgz") },
  });
  const out = { status: r.status, text: `${r.stdout ?? ""}${r.stderr ?? ""}`, appCreated: fs.existsSync(app) };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
};

// S1 — dash(우분투·데비안의 sh)로 붙이면: 알아볼 말로 멈추고, 아무것도 만들지 않는다.
if (has("dash")) {
  t("S1 dash 로 실행하면 bash 로 다시 하라는 말로 멈추고 앱 디렉터리를 만들지 않는다", () => {
    const r = run("dash");
    assert.equal(r.status, 1, r.text);
    assert.doesNotMatch(r.text, /Illegal option/, `pipefail 까지 가서 죽었다 — 가드가 set 보다 먼저 와야 한다\n${r.text}`);
    assert.match(r.text, /bash/, `무엇으로 다시 실행할지 말하지 않는다\n${r.text}`);
    assert.equal(r.appCreated, false, "가드 전에 앱 디렉터리를 만들었다");
  });
} else {
  console.log("-   S1 건너뜀 — 이 기계에 dash 가 없다(CI 우분투에서 돈다)");
}

// S2 — bash 로는 가드를 지나 다음 단계로 간다(가드가 정상 경로를 막지 않는다 = 배선 단언).
if (has("bash") && has("curl") && has("tar")) {
  t("S2 bash 로 실행하면 가드를 지나 코드 획득 단계까지 간다", () => {
    const r = run("bash");
    assert.match(r.text, /번들 파일 없음/, `코드 획득 단계에 닿지 않았다\n${r.text}`);
    assert.equal(r.appCreated, true, "가드 뒤의 첫 단계(앱 디렉터리 만들기)를 안 했다");
  });
}

// S3 — 문서·워크플로 어디에도 bootstrap 을 `| sh` 로 붙이라는 안내가 없다.
t("S3 bootstrap.sh 를 sh 로 파이프하라는 안내가 없다", () => {
  const files = [];
  const SKIP = new Set(["node_modules", ".git", "dist"]);
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md") || /\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$/.test(p) || /deploy[\\/][^\\/]+\.sh$/.test(p)) files.push(path.relative(ROOT, p));
    }
  })(ROOT);
  assert.ok(files.length > 10, "검사 대상 파일을 못 찾았다(테스트가 대상을 잃음)");
  const bad = [];
  for (const f of files) {
    fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
      if (/deploy\/bootstrap\.sh|<bootstrap-url>/.test(line) && /\|[^|]*\bsh\s*$/.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], "bootstrap.sh 는 bash 전용이다 — `| bash` 로 안내한다");
});

console.log(`\nbootstrap-shell tests: ${pass} passed`);
