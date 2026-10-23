// 이 배포가 그 AI 를 띄울 수 있나(설치) — 처음 설정 «AI 연결» 이 고를 수 있는 AI 만 보이게(#4970). 사양·엣지 표: spec-ai-step.md §B.
//  실행: npm run build && node dist/terminal/harness-installed.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { harnessInstalled, installedCheckLine, INSTALLED_TTL_MS, type InstalledDeps } from "./harness-installed.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

/** 셸 호출을 세는 가짜 자리 — 배선 단언(불렸나·몇 번)의 근거. */
function deps(o: { relayed: boolean; listed?: readonly string[] | null; run?: boolean | null; now?: () => number }): InstalledDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    relayed: () => o.relayed,
    listed: () => (o.listed === undefined ? null : o.listed),
    run: async (line) => { lines.push(line); return o.run === undefined ? null : o.run; },
    now: o.now ?? (() => 1_000),
    memo: new Map(),
  };
}
const IMAGE = ["claude", "codex", "antigravity", "grok"];

await t("B1 매니지드(세션 이미지 목록) — 목록에 있으면 true, 셸은 안 돈다(프로브 하네스도)", async () => {
  const d = deps({ relayed: true, listed: IMAGE });
  assert.equal(await harnessInstalled("grok", d), true);
  assert.equal(await harnessInstalled("antigravity", d), true);
  assert.equal(d.lines.length, 0, "설치를 묻는 데 자리(세션 컨테이너)를 띄우면 안 된다");
});

await t("B2 매니지드 — 목록에 없으면 false(opencode), 셸 0회", async () => {
  const d = deps({ relayed: true, listed: IMAGE });
  assert.equal(await harnessInstalled("opencode", d), false);
  assert.equal(d.lines.length, 0);
});

await t("B3 매니지드인데 목록이 없으면 모름(null) — 게이트웨이 자리로 접으면 거짓 «미설치» 다", async () => {
  const d = deps({ relayed: true, listed: null, run: false });
  assert.equal(await harnessInstalled("claude", d), null);
  assert.equal(d.lines.length, 0);
});

await t("B4·B5·B6 셀프호스트 — 그 박스의 셸 답을 그대로(true / false / 모름)", async () => {
  assert.equal(await harnessInstalled("claude", deps({ relayed: false, run: true })), true);
  assert.equal(await harnessInstalled("codex", deps({ relayed: false, run: false })), false);
  assert.equal(await harnessInstalled("grok", deps({ relayed: false, run: null })), null);
});

await t("B7 모르는 하네스·실행 파일 없는 하네스(셸)는 모름, 셸 0회", async () => {
  const d = deps({ relayed: false, run: true });
  assert.equal(await harnessInstalled("nope", d), null);
  assert.equal(await harnessInstalled("shell", d), null);
  assert.equal(d.lines.length, 0);
});

await t("B8 같은 답은 잠깐 기억한다 — 상한 안 두 번째는 셸 0회 · 상한 뒤엔 다시 · 모름은 기억 안 함", async () => {
  let now = 1_000;
  const d = deps({ relayed: false, run: true, now: () => now });
  await harnessInstalled("claude", d); await harnessInstalled("claude", d);
  assert.equal(d.lines.length, 1, "상한 안의 두 번째가 또 셸을 돌렸다");
  now += INSTALLED_TTL_MS;
  await harnessInstalled("claude", d);
  assert.equal(d.lines.length, 2, "상한이 지났는데 옛 답을 썼다");
  const u = deps({ relayed: false, run: null });
  await harnessInstalled("claude", u); await harnessInstalled("claude", u);
  assert.equal(u.lines.length, 2, "모름을 기억해 다시 묻지 않는다");
});

await t("B9 셀프호스트 확인 줄 — PATH 에 없어도 홈의 ~/.local/bin 에 있으면 설치로 친다(실제 셸)", async () => {
  if (process.platform === "win32") return;
  const home = mkdtempSync(path.join(os.tmpdir(), "hi-"));
  mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  const bin = path.join(home, ".local", "bin", "lvly-fake-ai");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n"); chmodSync(bin, 0o755);
  const sh = (line: string): boolean => {
    try { execFileSync("sh", ["-c", line], { env: { HOME: home, PATH: "/usr/bin:/bin" }, stdio: "ignore" }); return true; } catch { return false; }
  };
  assert.equal(sh(installedCheckLine("lvly-fake-ai")), true, "홈의 사용자 몫 폴더를 안 본다 — 위시스트의 claude 가 그 자리다");
  assert.equal(sh(installedCheckLine("lvly-none-ai")), false, "없는 것을 있다고 한다");
  assert.equal(sh(installedCheckLine("sh")), true, "PATH 해소를 안 한다");
  rmSync(home, { recursive: true, force: true });
});

console.log(`harness-installed.test: ${pass} ok`);
