#!/usr/bin/env node
// 받은 목록(managed-harness-assets.json) 동시 저장·고아 사본 자기치유 사양테스트(#5019).
//  로컬 스텁 게이트웨이 + 샌드박스 HOME(LIVELY_HOME), 러너를 **실제로 돌려** 목록·디스크를 본다(네트워크·실 홈 미접촉).
//  실행: node scripts/run-tests.mjs sync-harness-assets-manifest
//  엣지 표(#5019 프로젝트 본문): F1 두 하네스 동시 받기 → 두 몫 유지 · F2 남의 몫 보존 · F3 표식 있는 고아 사본 다시 맡기 ·
//   F4 표식 없는 멤버 파일 보존(본문에 표식 문장을 인용만 한 것 포함) · F5 죽은 잠금 치우기 · F6 살아 있는 잠금은 짧게 기다린 뒤
//   그래도 저장 · F7 잠금·임시 파일 안 남김 · F8 rename 이 실패해도 임시 파일을 안 남기고 조용히 끝남.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "sync-harness-assets.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "sync-manifest-test-"));
const HOME = join(SANDBOX, "home");
const LV = join(HOME, ".lively");
const MANIFEST = join(LV, "managed-harness-assets.json");
const LOCK = MANIFEST + ".lock";
const MARK = "라이블리가 materialize 한 사본입니다";

// ⓪ 실 홈 무접촉 — 러너가 쓰는 자리(스킬·에이전트 폴더, 받은 목록·잠금)의 경로·크기·시각 지문.
const REAL = homedir();
const fingerprint = () => {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { const st = statSync(p); out.push(`${p}:${st.size}:${st.mtimeMs}`); } catch { out.push(`${p}:?`); } }
    }
  };
  for (const d of [join(REAL, ".cursor", "skills"), join(REAL, ".codex", "skills"), join(REAL, ".codex", "agents")]) walk(d);
  for (const f of ["managed-harness-assets.json", "managed-harness-assets.json.lock"]) {
    try { const st = statSync(join(REAL, ".lively", f)); out.push(`${f}:${st.size}:${st.mtimeMs}`); } catch { out.push(`${f}:-`); }
  }
  return createHash("sha256").update(out.sort().join("\n")).digest("hex") + `/${out.length}`;
};
const REAL_BEFORE = fingerprint();

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
const skill = (id, body = `# ${id}\n새 본문`) => ({ id, kind: "skill", description: `${id} 설명`, body, content_hash: hash(id + body), frontmatter: {} });
// 하네스별로 내줄 자산. 기본은 하네스마다 스킬 하나(liv-<harness>).
let ASSETS = null;
// F1 의 문 — 자산 응답을 붙잡아 두었다가 두 번째 요청이 오면 둘 다 한꺼번에 푼다(2초가 지나면 혼자라도).
//  문이 없으면 두 러너의 저장이 우연히 안 겹쳐 고치기 전 코드도 통과한다(#5013 변이 실측).
let HOLD = false;
const held = [];
const releaseHeld = () => { for (const f of held.splice(0)) f(); };
const hits = [];
const server = createServer((req, res) => {
  hits.push(req.url);
  if (req.method === "POST") req.resume();
  if (req.url.startsWith("/api/ui/org/runner/assets")) {
    const h = new URL(req.url, "http://x").searchParams.get("harness");
    const send = () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ assets: ASSETS ? ASSETS(h) : [skill(`liv-${h}`)] }));
    if (!HOLD) { send(); return; }
    held.push(send);
    if (held.length >= 2) releaseHeld(); else setTimeout(releaseHeld, 2000);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(req.url.includes("harness-local-pref") ? JSON.stringify({ disabled: [] }) : "{}");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${server.address().port}`;

function freshHome() {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(LV, { recursive: true });
  writeFileSync(join(LV, "token"), "test-token\n");
  writeFileSync(join(LV, "gateway-url"), GW + "\n");
  hits.length = 0;
  ASSETS = null;
  HOLD = false;
}
// ⚠ spawnSync 금지 — 스텁이 이 프로세스 안에서 돌아 동기 대기 중엔 응답을 못 한다.
function sync(harness) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER, "--harness", harness], {
      env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox", LIVELY_HOME: HOME, CLAUDECODE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (status) => resolve({ status, stderr: err }));
  });
}
const manifest = () => { try { return JSON.parse(readFileSync(MANIFEST, "utf8")); } catch { return null; } };
const assetHits = () => hits.filter((u) => u.startsWith("/api/ui/org/runner/assets")).length;
const cursorSkill = (id) => join(HOME, ".cursor", "skills", id, "SKILL.md");

try {
  // F1 — 두 하네스 받기가 같은 순간에 목록을 쓴다. 둘 다 남아야 한다.
  {
    freshHome();
    HOLD = true;
    await Promise.all([sync("cursor"), sync("codex")]);
    eq("F1 배선 — 두 받기가 스텁을 실제로 부름", assetHits(), 2);
    const m = manifest() || {};
    eq("F1 목록에 두 몫", [Object.keys(m.cursor || {}), Object.keys(m.codex || {})], [["liv-cursor"], ["liv-codex"]]);
  }
  // F2 — 이미 있던 남의 몫(codex)은 cursor 받기가 건드리지 않는다.
  {
    freshHome();
    const codexPart = { "keep-me": { kind: "skill", hash: "h-old", file: join(HOME, ".codex", "skills", "keep-me", "SKILL.md") } };
    writeFileSync(MANIFEST, JSON.stringify({ codex: codexPart }, null, 2));
    await sync("cursor");
    const m = manifest() || {};
    eq("F2 남의 몫 그대로 + 내 몫 추가", [m.codex, Object.keys(m.cursor || {})], [codexPart, ["liv-cursor"]]);
  }
  // F3 — 목록에서 빠진 라이블리 사본(표식 있음)은 다시 맡아 새 내용으로 쓴다.
  {
    freshHome();
    mkdirSync(dirname(cursorSkill("liv-cursor")), { recursive: true });
    writeFileSync(cursorSkill("liv-cursor"), `---\nname: "liv-cursor"\n---\n\n<!-- ${MARK}. 편집은 … -->\n\n# 옛 본문\n`);
    const r = await sync("cursor");
    const text = readFileSync(cursorSkill("liv-cursor"), "utf8");
    eq("F3 새 내용으로 다시 씀", [text.includes("새 본문"), text.includes("옛 본문")], [true, false]);
    eq("F3 목록에 오름 · 충돌 경고 없음", [Object.keys((manifest() || {}).cursor || {}), /배포 생략/.test(r.stderr)], [["liv-cursor"], false]);
  }
  // F3b — TOML 사본(codex 서브에이전트, 표식이 `# …` 줄)도 같은 규칙으로 되찾는다.
  {
    freshHome();
    ASSETS = (h) => (h === "codex" ? [{ ...skill("liv-agent", "새 지시"), kind: "subagent" }] : []);
    const toml = join(HOME, ".codex", "agents", "liv-agent.toml");
    mkdirSync(dirname(toml), { recursive: true });
    writeFileSync(toml, `# ${MARK}. 편집은 …\nname = "liv-agent"\ndescription = "옛"\ndeveloper_instructions = "옛 지시"\n`);
    await sync("codex");
    const text = readFileSync(toml, "utf8");
    eq("F3b TOML 사본 되찾음", [text.includes("새 지시"), Object.keys((manifest() || {}).codex || {})], [true, ["liv-agent"]]);
  }
  // F4 — 표식 없는 같은 이름의 파일은 멤버 것이다. 건드리지 않는다.
  {
    freshHome();
    const mine = "---\nname: liv-cursor\n---\n\n# 내가 만든 스킬\n";
    mkdirSync(dirname(cursorSkill("liv-cursor")), { recursive: true });
    writeFileSync(cursorSkill("liv-cursor"), mine);
    const r = await sync("cursor");
    eq("F4 멤버 파일 그대로", readFileSync(cursorSkill("liv-cursor"), "utf8"), mine);
    eq("F4 목록에 없음 · 충돌 경고", [Object.keys((manifest() || {}).cursor || {}), /배포 생략/.test(r.stderr)], [[], true]);
  }
  // F4b — 본문에 표식 문장을 **인용만** 한 멤버 파일(줄 머리 표식 아님)도 멤버 것이다.
  {
    freshHome();
    const quoting = `---\nname: liv-cursor\n---\n\n# 메모\n라이블리 사본엔 «${MARK}.» 라는 주석이 붙는다.\n`;
    mkdirSync(dirname(cursorSkill("liv-cursor")), { recursive: true });
    writeFileSync(cursorSkill("liv-cursor"), quoting);
    await sync("cursor");
    eq("F4b 인용만 한 멤버 파일 그대로", readFileSync(cursorSkill("liv-cursor"), "utf8"), quoting);
  }
  // F5 — 죽은 잠금(60초 전)은 치우고 저장한다. 끝나면 잠금이 없다.
  {
    freshHome();
    mkdirSync(LOCK);
    const old = new Date(Date.now() - 60000);
    utimesSync(LOCK, old, old);
    await sync("cursor");
    eq("F5 저장됨 · 잠금 치워짐", [Object.keys((manifest() || {}).cursor || {}), existsSync(LOCK)], [["liv-cursor"], false]);
  }
  // F6 — 살아 있는 잠금(방금 것, 안 놓음): 짧게 기다린 뒤 그래도 저장한다(세션을 막지 않는다). 남의 잠금은 안 지운다.
  {
    freshHome();
    mkdirSync(LOCK);
    const t0 = Date.now();
    await sync("cursor");
    const ms = Date.now() - t0;
    eq("F6 그래도 저장 · 남의 잠금 그대로", [Object.keys((manifest() || {}).cursor || {}), existsSync(LOCK)], [["liv-cursor"], true]);
    // 상한은 넉넉히 — 병렬 실행·윈도우 CI 의 기동 지연을 흡수한다. 변이(상한 제거)는 10초를 넘겨 여전히 걸린다.
    ms < 6000 ? ok(`F6 상한 안에서 끝남 (${ms}ms)`) : bad("F6 소요", `${ms}ms — 잠금 대기 상한(1.5초)을 크게 넘김`);
  }
  // F7 — 정상 실행 뒤 잠금·임시 파일이 남지 않고 목록은 온전한 JSON 이다.
  {
    freshHome();
    await sync("cursor");
    const leftovers = readdirSync(LV).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"));
    eq("F7 잠금·임시 파일 없음 · 목록 JSON", [leftovers, manifest() !== null], [[], true]);
  }
  // F8 — 목록 자리가 파일이 아니라 비어 있지 않은 디렉터리면 rename·직접 쓰기가 모두 실패한다. 조용히 끝나고 임시 파일을 안 남긴다.
  {
    freshHome();
    mkdirSync(join(MANIFEST, "x"), { recursive: true });
    const r = await sync("cursor");
    const leftovers = readdirSync(LV).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"));
    eq("F8 실패해도 exit 0 · 임시 파일·잠금 없음", [r.status, leftovers], [0, []]);
  }
  REAL_BEFORE === fingerprint() ? ok("⓪ 실 홈(스킬 폴더·받은 목록) 무접촉") : bad("⓪ 실 홈", "러너가 실 홈의 자산 자리를 건드렸다");
} finally {
  server.close();
  rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${fail ? "✗" : "✓"} sync-harness-assets-manifest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
