// 멤버 홈 키트 시딩(member-kit-seed.ts) — 가짜 중계(argv 로그+실행)로 사양 엣지 표 K1~K7 전수 (#1437 §21-3).
//  MEMBER_HOME_BASE 는 로드 시점 상수라 env 를 먼저 놓고 **동적 import** 한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kit-"));
process.env.LIVELY_MEMBER_HOME_BASE = path.join(tmp, "homes");
fs.mkdirSync(process.env.LIVELY_MEMBER_HOME_BASE, { recursive: true });

const relayLog = path.join(tmp, "relay.log");
const relay = path.join(tmp, "fake-relay.mjs");
fs.writeFileSync(relay, [
  "import { spawn } from 'node:child_process'; import fs from 'node:fs';",
  "const [osUser, dash, ...argv] = process.argv.slice(2);",
  `fs.appendFileSync(${JSON.stringify(relayLog)}, JSON.stringify({ osUser, dash, argv }) + '\\n');`,
  "const c = spawn(argv[0], argv.slice(1), { stdio: ['inherit','inherit','inherit'] });",
  "c.on('exit', (code) => process.exit(code ?? 1));",
].join("\n"));
const calls = (): Array<{ osUser: string; argv: string[] }> =>
  fs.existsSync(relayLog) ? fs.readFileSync(relayLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const resetLog = (): void => { fs.rmSync(relayLog, { force: true }); };

process.env.LIVELY_MEMBER_EXEC = `${process.execPath} ${relay}`;
const { installTenantSlugResolver } = await import("./catalog.js");
installTenantSlugResolver(() => "acme");
const { ensureMemberKitSeeded, installScript } = await import("./member-kit-seed.js");
type Deps = import("./member-kit-seed.js").KitSeedDeps;

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

// 가짜 번들 — user-install/register-clients 가 센티널 파일을 남긴다(실 키트의 부작용 자리만 흉내).
function fakeBundle(): Buffer {
  const stage = fs.mkdtempSync(path.join(tmp, "bundle-"));
  fs.mkdirSync(path.join(stage, "setup"), { recursive: true });
  fs.writeFileSync(path.join(stage, "setup", "user-install.mjs"),
    "import fs from 'node:fs'; import path from 'node:path';\n" +
    "const h = process.env.HOME; fs.mkdirSync(path.join(h, '.claude'), { recursive: true });\n" +
    "fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify({ hooks: 'sentinel', token: process.env.LIVELY_TOKEN }));\n");
  fs.writeFileSync(path.join(stage, "setup", "register-clients.sh"),
    "#!/bin/sh\nprintf %s \"$STORE_URL\" > \"$HOME/.mcp-registered\"\n");
  const tar = execFileSync("tar", ["-czf", "-", "-C", stage, "setup"], { maxBuffer: 16 * 1024 * 1024 });
  return zlib.gunzipSync(tar).length >= 0 ? tar : tar;   // (검증 겸 — gzip 이어야 한다)
}

const okDeps = (memberOk = true): { deps: Deps; minted: string[] } => {
  const minted: string[] = [];
  return {
    minted,
    deps: {
      getMember: async () => (memberOk ? { scopes: ["knowledge"] } : null),
      mintToken: async (m, _s, slug) => { const tk = `tok-${m}-${slug}-SECRET`; minted.push(tk); return tk; },
      buildBundle: async () => fakeBundle(),
    },
  };
};
const user = (id: string): { userId: string } => ({ userId: id });

await t("[K1] 중계 미설정 — exec 0회(no-op)", async () => {
  const saved = process.env.LIVELY_MEMBER_EXEC;
  delete process.env.LIVELY_MEMBER_EXEC;
  resetLog();
  const { deps } = okDeps();
  await ensureMemberKitSeeded(user("u-k1") as never, "box_u-k1", deps);
  assert.equal(calls().length, 0);
  process.env.LIVELY_MEMBER_EXEC = saved;
});

await t("[K3] 첫 시딩 — 토큰은 stdin 으로만(argv 무노출)·gateway-url·설치 부작용·마커", async () => {
  resetLog();
  const { deps, minted } = okDeps();
  await ensureMemberKitSeeded(user("u-k3") as never, "box_u-k3", deps);
  const home = path.join(process.env.LIVELY_MEMBER_HOME_BASE!, "box_u-k3");
  assert.equal(fs.readFileSync(path.join(home, ".lively", "token"), "utf8"), minted[0], "토큰 파일");
  assert.equal(fs.readFileSync(path.join(home, ".lively", "gateway-url"), "utf8"), "http://localhost:8080");
  const st = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(st.hooks, "sentinel", "user-install 이 돌았다");
  assert.equal(st.token, minted[0], "설치가 토큰을 env 로 받았다(.lively/token 경유)");
  assert.equal(fs.readFileSync(path.join(home, ".mcp-registered"), "utf8"), "http://localhost:8080/mcp", "register-clients 가 돌았다");
  assert.ok(fs.existsSync(path.join(home, ".lively", ".kit-seeded")), "마커");
  assert.ok(!fs.existsSync(path.join(home, ".lively", "kit-bundle.tgz")), "번들 임시파일 정리");
  for (const c of calls()) assert.ok(!c.argv.join(" ").includes("SECRET"), "토큰이 argv 에 노출되면 안 된다");
});

await t("[K2] 마커 존재(새 프로세스 상태 가정 = 다른 osUser 로 흉내) — stat 1회, 민팅·설치 0회", async () => {
  const home = path.join(process.env.LIVELY_MEMBER_HOME_BASE!, "box_u-k2");
  fs.mkdirSync(path.join(home, ".lively"), { recursive: true });
  fs.writeFileSync(path.join(home, ".lively", ".kit-seeded"), "ok");
  resetLog();
  const { deps, minted } = okDeps();
  await ensureMemberKitSeeded(user("u-k2") as never, "box_u-k2", deps);
  assert.equal(minted.length, 0, "민팅 없음");
  assert.equal(calls().length, 1, "stat 1회뿐");
  assert.ok(calls()[0]!.argv.join(" ").includes("node"), "stat 은 node one-liner");
});

await t("[K4] 동시 2회 — 시딩 1회 공유(민팅 1회·마커 1개)", async () => {
  resetLog();
  const { deps, minted } = okDeps();
  await Promise.all([
    ensureMemberKitSeeded(user("u-k4") as never, "box_u-k4", deps),
    ensureMemberKitSeeded(user("u-k4") as never, "box_u-k4", deps),
  ]);
  assert.equal(minted.length, 1);
});

await t("[K5] 설치 실패(가짜 번들에 user-install 없음) — 던지고 마커 없음(다음 생성이 재시도)", async () => {
  resetLog();
  const empty = fs.mkdtempSync(path.join(tmp, "empty-"));
  fs.mkdirSync(path.join(empty, "setup"));
  const badTar = execFileSync("tar", ["-czf", "-", "-C", empty, "setup"], { maxBuffer: 1024 * 1024 });
  const { deps } = okDeps();
  deps.buildBundle = async () => badTar;
  await assert.rejects(() => ensureMemberKitSeeded(user("u-k5") as never, "box_u-k5", deps));
  const home = path.join(process.env.LIVELY_MEMBER_HOME_BASE!, "box_u-k5");
  assert.ok(!fs.existsSync(path.join(home, ".lively", ".kit-seeded")), "실패엔 마커 없음");
});

await t("[K6] 비멤버(getMember null) — 민팅·설치 없음(stat 만)", async () => {
  resetLog();
  const { deps, minted } = okDeps(false);
  await ensureMemberKitSeeded(user("u-k6") as never, "box_u-k6", deps);
  assert.equal(minted.length, 0);
  assert.equal(calls().length, 1, "마커 stat 1회뿐");
});

await t("[K7] installScript(순수) — set -e · 번들 검사 · user-install --harness claude · register-clients · 마커 순서", () => {
  const s = installScript("/home/box_x");
  const idx = (needle: string): number => { const i = s.indexOf(needle); assert.ok(i >= 0, `누락: ${needle}`); return i; };
  assert.ok(s.startsWith("set -e"));
  const a = idx("user-install.mjs\" --harness claude");
  const b = idx("register-clients.sh");
  const c = idx(".kit-seeded");
  assert.ok(a < b && b < c, "설치 → MCP 등록 → 마커 순서");
});

installTenantSlugResolver(() => null);
delete process.env.LIVELY_MEMBER_EXEC;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`member-kit-seed: ${pass} passed`);
