#!/usr/bin/env node
// testguard-real-home 단위테스트 — 러너 전역 가드의 판정·원복 규칙.
//
// ⚠ 이 가드의 어려움은 "바뀌었나"가 아니라 **"누가 바꿨나"** 다. `~/.claude.json` 은 테스트도 오염시키지만
//  **하네스 자신도 세션 중 수시로 갱신한다**(promptQueueUseCount·tipsHistory·projects·캐시…).
//  2026-08-20 실측: 파일 전체를 비교하는 첫 판(100초짜리 전체 테스트)에서 하네스의 정상 갱신이
//  "테스트 오염"으로 잡혔고, 가드가 **그 갱신을 되돌렸다**. 탐지 실패보다 나쁜 결과였다.
//  그래서 JSON 설정은 감시 키만 보고 그 키만 부분 원복한다 — 그 계약을 여기서 못박는다.
//
// 실 홈 무접촉: 모든 케이스가 mkdtemp 샌드박스 home 을 인자로 준다(가드 API 가 home 을 받는다).
// 실행: node scripts/testguard-real-home.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotRealHome, verifyRealHome, watchedTargets } from "./testguard-real-home.mjs";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));

const ENV = {};                       // CLAUDE_CONFIG_DIR·XDG·GROK 상속 없음 — 순수 기본 배치
const box = () => mkdtempSync(join(tmpdir(), "testguard-"));
const claudeJson = (home) => join(home, ".claude.json");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, o) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 2) + "\n"); };

// ── ① 감시 키(mcpServers)만 바뀌면 → 탐지 + 원복 ──────────────────────────────
{
  const home = box(), p = claudeJson(home);
  writeJson(p, { mcpServers: { lively: { type: "stdio", command: "REAL" } }, promptQueueUseCount: 1 });
  const snap = snapshotRealHome(ENV, home);
  writeJson(p, { mcpServers: { lively: { type: "http", url: "http://localhost:8080/mcp" } }, promptQueueUseCount: 1 });
  const ch = verifyRealHome(snap);
  const hit = ch.find((c) => c.path === p);
  hit && hit.restored && readJson(p).mcpServers.lively.command === "REAL"
    ? ok("① 감시 키 오염 — 탐지하고 원복한다")
    : bad("①", `changes=${JSON.stringify(ch)} after=${JSON.stringify(readJson(p).mcpServers)}`);
  rmSync(home, { recursive: true, force: true });
}

// ── ② 비감시 키만 바뀌면 → **탐지하지 않는다**(하네스 자기 갱신) ─────────────
//  이 케이스가 이 파일의 존재 이유다. 여기서 빨간불이 뜨면 무고한 실패 + 유해한 원복이 된다.
{
  const home = box(), p = claudeJson(home);
  writeJson(p, { mcpServers: { lively: { command: "REAL" } }, promptQueueUseCount: 15, tipsHistory: { a: 1 } });
  const snap = snapshotRealHome(ENV, home);
  writeJson(p, { mcpServers: { lively: { command: "REAL" } }, promptQueueUseCount: 18, tipsHistory: { a: 9 }, lastPlanModeUse: 123 });
  eq("② 하네스 자기 갱신(비감시 키) — 탐지하지 않는다", verifyRealHome(snap).filter((c) => c.path === p).length, 0);
  readJson(p).promptQueueUseCount === 18
    ? ok("②-b 비감시 키를 되돌리지 않는다")
    : bad("②-b", `promptQueueUseCount=${readJson(p).promptQueueUseCount} (18 이어야)`);
  rmSync(home, { recursive: true, force: true });
}

// ── ③ 둘 다 바뀌면 → 감시 키만 원복, 비감시 키는 **보존** ────────────────────
{
  const home = box(), p = claudeJson(home);
  writeJson(p, { mcpServers: { lively: { command: "REAL" } }, promptQueueUseCount: 15 });
  const snap = snapshotRealHome(ENV, home);
  writeJson(p, { mcpServers: { lively: { command: "POISON" } }, promptQueueUseCount: 18 });
  verifyRealHome(snap);
  const after = readJson(p);
  after.mcpServers.lively.command === "REAL" && after.promptQueueUseCount === 18
    ? ok("③ 동시 변경 — 감시 키만 원복하고 하네스 갱신은 보존한다")
    : bad("③", `mcpServers=${JSON.stringify(after.mcpServers)} promptQueueUseCount=${after.promptQueueUseCount}`);
  rmSync(home, { recursive: true, force: true });
}

// ── ④ 스냅샷 때 없던 감시 키를 테스트가 만들면 → 그 키를 지운다 ──────────────
{
  const home = box(), p = claudeJson(home);
  writeJson(p, { promptQueueUseCount: 1 });                       // mcpServers 없음
  const snap = snapshotRealHome(ENV, home);
  writeJson(p, { promptQueueUseCount: 1, mcpServers: { evil: {} } });
  verifyRealHome(snap);
  const after = readJson(p);
  !("mcpServers" in after) && after.promptQueueUseCount === 1
    ? ok("④ 없던 감시 키 생성 — 그 키만 제거한다")
    : bad("④", JSON.stringify(after));
  rmSync(home, { recursive: true, force: true });
}

// ── ⑤ 파일 자체가 없다가 생기면 → 탐지하되 **삭제하지 않는다** ────────────────
//  사람이 그 사이 만들었을 수도 있다. 가드가 사람 파일을 지우는 일은 하지 않는다.
{
  const home = box(), p = claudeJson(home);
  mkdirSync(home, { recursive: true });
  const snap = snapshotRealHome(ENV, home);                        // 파일 없음 상태로 스냅샷
  writeJson(p, { mcpServers: { evil: {} } });
  const hit = verifyRealHome(snap).find((c) => c.path === p);
  hit && hit.change === "생성됨" && !hit.restored && existsSync(p)
    ? ok("⑤ 신규 생성 — 탐지하고 알리되 삭제하지 않는다")
    : bad("⑤", JSON.stringify(hit));
  rmSync(home, { recursive: true, force: true });
}

// ── ⑥ 감시 파일이 삭제되면 → 탐지 + 원복 ────────────────────────────────────
{
  const home = box(), p = join(home, ".lively", "token");
  mkdirSync(join(home, ".lively"), { recursive: true });
  writeFileSync(p, "real-token\n");
  const snap = snapshotRealHome(ENV, home);
  rmSync(p);
  const hit = verifyRealHome(snap).find((c) => c.path === p);
  hit && hit.change === "삭제됨" && hit.restored && readFileSync(p, "utf8") === "real-token\n"
    ? ok("⑥ 감시 파일 삭제 — 탐지하고 원복한다")
    : bad("⑥", JSON.stringify(hit));
  rmSync(home, { recursive: true, force: true });
}

// ── ⑦ keys 없는 파일(전체 비교)은 어떤 변경이든 잡는다 ───────────────────────
{
  const home = box(), p = join(home, ".codex", "config.toml");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(p, "[mcp_servers.lively]\ncommand = \"REAL\"\n");
  const snap = snapshotRealHome(ENV, home);
  writeFileSync(p, "[mcp_servers.lively]\ncommand = \"POISON\"\n");
  const hit = verifyRealHome(snap).find((c) => c.path === p);
  hit && hit.restored && readFileSync(p, "utf8").includes("REAL")
    ? ok("⑦ 비-JSON 설정 — 전체 비교로 잡고 원복한다")
    : bad("⑦", JSON.stringify(hit));
  rmSync(home, { recursive: true, force: true });
}

// ── ⑧ JSON 이 깨져 있으면 전체 비교로 폴백한다(가드가 죽지 않는다) ───────────
{
  const home = box(), p = claudeJson(home);
  mkdirSync(home, { recursive: true });
  writeFileSync(p, "{ this is not json");
  const snap = snapshotRealHome(ENV, home);
  writeFileSync(p, "{ this is not json, changed");
  verifyRealHome(snap).some((c) => c.path === p)
    ? ok("⑧ JSON 파싱 실패 — 전체 비교로 폴백해 계속 감시한다")
    : bad("⑧", "깨진 JSON 의 변경을 놓쳤다");
  rmSync(home, { recursive: true, force: true });
}

// ── ⑨ 무접촉이면 아무것도 보고하지 않는다(오탐 0) ────────────────────────────
{
  const home = box(), p = claudeJson(home);
  writeJson(p, { mcpServers: { lively: { command: "REAL" } } });
  const snap = snapshotRealHome(ENV, home);
  eq("⑨ 무접촉 — 보고 0건", verifyRealHome(snap).length, 0);
  rmSync(home, { recursive: true, force: true });
}

// ── ⑩ 배선 — CLAUDE_CONFIG_DIR 가 있으면 그 경로도 감시 대상에 든다(#1786 축) ──
{
  const home = box(), ccd = join(home, "profiles", "yoon", "claude");
  const paths = watchedTargets({ CLAUDE_CONFIG_DIR: ccd }, home).map((t) => t.path);
  paths.includes(join(ccd, ".claude.json")) && paths.includes(join(ccd, "settings.json"))
    ? ok("⑩ CLAUDE_CONFIG_DIR 프로필도 감시한다(#346 격리 배치)")
    : bad("⑩", `감시 목록에 프로필 경로 없음: ${JSON.stringify(paths)}`);
}

console.log(`testguard-real-home tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
