// 구성원 몫 AI(claude · codex)를 동시에 깐다 (#4970, deploy/provision-member.sh 의 «구성원 몫 AI 설치» 구간).
//  왜: 처음 설정은 이 둘이 다 깔릴 때까지 «개인 계정을 준비하고 있어요» 를 보인다. 차례로 깔면 claude 약 12초 + codex 약 13초였다
//   (테스트 박스 실측 2026-10-24 · 계정 준비 전체 약 27초 · 인사·이름을 빨리 넘긴 사람은 AI 장면에서 약 20초를 기다렸다).
//  provision-member.sh 는 root·useradd 가 있어야 통째로 돈다 — 그래서 그 구간(>>> … <<< 표지 사이)만 떼어 임시 폴더에 두고,
//   같은 폴더의 가짜 도우미(install-claude-user.sh · install-codex-user.sh)로 실제 셸에서 돌린다. 가짜 도우미는 시작·끝을 기록하고 잠깐 잔다.
//
//  엣지 표(행마다 단언):
//   P1 둘 다 있으면 둘 다 그 구성원으로 부르고 **겹쳐서** 돈다(둘 다 시작한 뒤에야 하나가 끝난다) · 구간은 둘이 다 끝난 뒤에 끝난다
//   P2 claude 도우미가 실패해도 set -euo pipefail 아래에서 구간이 0 으로 끝나고 다음 줄로 간다 · codex 는 끝까지 돈다
//   P3 codex 도우미가 실패해도 0 · claude 는 끝까지 돌고 구간은 그것을 기다린다
//   P4 claude 도우미가 없으면(libexec 에도) 경고 한 줄 · codex 는 그대로 돈다 · 0
//   S1 표지는 한 번씩 · 두 도우미 호출은 모두 그 안에 있다 · «프로비저닝 완료» 줄은 표지 뒤에 있다(둘이 다 끝난 뒤에 알린다)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("skip  윈도우 — 셀프호스트 구성원 계정 셸(bash)은 리눅스 전용");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "provision-member.sh"), "utf8");
const BEGIN = "# >>> 구성원 몫 AI(claude · codex) 설치";
const END = "# <<< 구성원 몫 AI 설치";
const lines = SRC.split(/\r?\n/);
const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));
const count = (prefix) => lines.filter((l) => l.startsWith(prefix)).length;
const block = lines.slice(at(BEGIN), at(END) + 1).join("\n");

/** 가짜 도우미 — 시작을 남기고, 잠깐 자고, 끝을 남긴다. exit 로 끝 코드를 정한다. */
const helper = (name, exit = 0) => `#!/usr/bin/env bash
echo "${name}-start $1" >> "$AI_LOG"
sleep 1
echo "${name}-end" >> "$AI_LOG"
exit ${exit}
`;

function run({ claude = 0, codex = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "member-ai-"));
  const log = join(dir, "ai.log");
  try {
    if (claude !== null) { writeFileSync(join(dir, "install-claude-user.sh"), helper("claude", claude)); chmodSync(join(dir, "install-claude-user.sh"), 0o755); }
    if (codex !== null) { writeFileSync(join(dir, "install-codex-user.sh"), helper("codex", codex)); chmodSync(join(dir, "install-codex-user.sh"), 0o755); }
    writeFileSync(join(dir, "block.sh"), `set -euo pipefail\nOSUSER=box_test-4970\n${block}\necho "AFTER" >> "$AI_LOG"\n`);
    const r = spawnSync("bash", [join(dir, "block.sh")], { env: { PATH: "/usr/bin:/bin", AI_LOG: log, LANG: "C.UTF-8" }, encoding: "utf8", timeout: 20000 });
    const ev = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), ev };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const idx = (ev, word) => ev.findIndex((e) => e.startsWith(word));

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

t("S1 표지는 한 번씩 · 두 도우미 호출은 그 안 · «프로비저닝 완료» 는 표지 뒤", () => {
  assert.equal(count(BEGIN), 1, "시작 표지가 한 번이 아니다");
  assert.equal(count(END), 1, "끝 표지가 한 번이 아니다");
  const b = at(BEGIN), e = at(END);
  assert.ok(b >= 0 && e > b, "표지 순서가 틀렸다");
  for (const re of [/bash "\$CLAUDE_HELPER" "\$OSUSER"/, /bash "\$CODEX_HELPER" "\$OSUSER"/]) {
    const hits = lines.map((l, i) => (!l.trimStart().startsWith("#") && re.test(l) ? i : -1)).filter((i) => i >= 0);
    assert.ok(hits.length === 1 && hits[0] > b && hits[0] < e, `${re} 가 구간 안에 한 번만 있어야 한다(${hits})`);
  }
  const done = lines.findIndex((l) => !l.trimStart().startsWith("#") && /프로비저닝 완료/.test(l));
  assert.ok(done > e, "«프로비저닝 완료» 를 둘이 다 끝나기 전에 알린다");
});

t("P1 ★ 둘을 그 구성원으로 부르고 겹쳐서 돈다 · 구간은 둘이 다 끝난 뒤에 끝난다", () => {
  const r = run();
  assert.equal(r.status, 0, r.out);
  assert.ok(r.ev.includes("claude-start box_test-4970") && r.ev.includes("codex-start box_test-4970"), `배선 — 둘 다 불리지 않았다: ${r.ev}`);
  const firstEnd = Math.min(idx(r.ev, "claude-end"), idx(r.ev, "codex-end"));
  assert.ok(idx(r.ev, "claude-start") < firstEnd && idx(r.ev, "codex-start") < firstEnd, `차례로 돌았다(겹치지 않았다): ${r.ev.join(" → ")}`);
  assert.ok(idx(r.ev, "claude-end") < idx(r.ev, "AFTER") && idx(r.ev, "codex-end") < idx(r.ev, "AFTER"), `둘이 다 끝나기 전에 구간을 지났다: ${r.ev.join(" → ")}`);
});

t("P2 claude 도우미가 실패해도 0 · 다음 줄로 · codex 는 끝까지", () => {
  const r = run({ claude: 1 });
  assert.equal(r.status, 0, r.out);
  assert.ok(idx(r.ev, "codex-end") >= 0 && idx(r.ev, "AFTER") >= 0, r.ev.join(" → "));
});

t("P3 codex 도우미가 실패해도 0 · claude 는 끝까지 돌고 구간은 그것을 기다린다", () => {
  const r = run({ codex: 1 });
  assert.equal(r.status, 0, r.out);
  assert.ok(idx(r.ev, "claude-end") >= 0 && idx(r.ev, "claude-end") < idx(r.ev, "AFTER"), r.ev.join(" → "));
});

t("P4 claude 도우미가 없으면 경고 한 줄 · codex 는 그대로 · 0", () => {
  if (existsSync("/opt/lively/libexec/install-claude-user")) { console.log("    (이 기계에 libexec 도우미가 있어 건너뜀)"); return; }
  const r = run({ claude: null });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /⚠ install-claude-user 헬퍼 없음/);
  assert.ok(idx(r.ev, "codex-end") >= 0 && idx(r.ev, "AFTER") >= 0, r.ev.join(" → "));
});

console.log(`\n${pass}건 통과`);
