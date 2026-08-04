#!/usr/bin/env node
// `lively status` 의 harness(claude) MCP 프로브 계약 (#1431) — 실행: node kit/cli/status-harness-probe.test.mjs
//  실제 ~/.lively·실제 ~/.claude.json 무접촉(LIVELY_HOME·CLAUDE_CONFIG_DIR 샌드박스 + 닫힌 PATH). 네트워크 0.
//
// 왜 이 파일이 있나 — 종전 프로브는 `claude mcp list` 였고 그게 두 가지를 동시에 틀렸다(2026-08-03 실측):
//  ① **남의 서버까지 전부 깨웠다.** 등록 서버 14개(claude.ai 커넥터 8·npx·bun·linear·notion·lively 2) 헬스체크에
//     4.78s — `lively status` 전체 4.8s 의 91%. 게이트웨이 자체는 0.09s 였다.
//  ② **그 결과를 버렸다.** 판정이 이름 매칭이라 죽은 서버도 출력에 이름은 남아(`lively: … - ✘ Failed to connect`)
//     true 였다 → 4.45초 헬스체크를 하고도 **끊김을 감지하지 못했다**.
//  그래서 우리 서버 하나만 묻고(`mcp get lively` 1.55s) 상태 줄을 실제로 읽는다. 사양·엣지표는
//  프로젝트 #1431 산출지식(unit-test-runner-parallel-keep-going-1431) 참조.
//
//  ⚠ 스텁의 목록 조회(`mcp list`)는 **일부러 '정답'을 되돌려준다** — 누군가 그 경로로 되돌려도 값은 맞아서 통과한다.
//   그 회귀를 잡는 건 오직 "목록 조회 호출 0건" 단정(케이스 ⑫)이다. 시간으로 재면 flaky 하므로 **호출 로그**로 본다.
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { closedPath, writeStubBin } from "../testlib/os-sandbox.mjs";   // 스텁은 윈도우에서도 실행 가능해야 한다(#1510)

const pExecFile = promisify(execFile);
const HERE = join(fileURLToPath(import.meta.url), "..");
const CLI = join(HERE, "lively.mjs");
const BOX = realpathSync(mkdtempSync(join(tmpdir(), "lively-probe-")));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

// 스텁 claude — 실물 `claude mcp get` 출력 형식을 흉내내고 호출 argv 를 전부 로그에 남긴다.
//  get 모드: connected · down · noStatus(Scope 만) · weird(✔/✘ 아닌 값) · absent(미등록 rc=1) · old(하위명령 미지원 rc=1)
const SCOPE = "Scope: User config (available in all your projects)";
const GET = {
  connected: { out: [SCOPE, "Status: ✔ Connected"], code: 0 },
  down: { out: [SCOPE, "Status: ✘ Failed to connect"], code: 0 },
  noStatus: { out: [SCOPE, "Type: stdio"], code: 0 },
  weird: { out: [SCOPE, "Status: ⏳ Pending"], code: 0 },
  absent: { err: ['No MCP server named "${a[2]}". Configured servers: notion, linear'], code: 1 },
  old: { err: ["error: unknown command 'get'"], code: 1 },
};

// 케이스 하나 = 샌드박스 홈 + 스텁 bin + 프로필 설정 디렉터리. stub=false 면 claude 를 아예 안 깐다(①행).
function mkCase(name, mode, { stub = true } = {}) {
  const home = join(BOX, name);
  const bin = join(home, "stub-bin");
  const ccd = join(home, "claude-cfg");
  mkdirSync(bin, { recursive: true });
  mkdirSync(ccd, { recursive: true });
  const log = join(home, "claude-argv.log");
  if (stub) {
    // 스텁 본문은 JS 한 벌 — sh 로 쓰면 윈도우에서 실행조차 안 돼 가로채기가 조용히 실패한다(#1510).
    const g = GET[mode];
    writeStubBin(bin, "claude", [
      'import { appendFileSync } from "node:fs";',
      "const a = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");`,
      // 구 경로에 '정답'을 주는 건 의도적이다(위 ⚠ 참조) — 값으로는 회귀가 안 잡히게 해서 로그 단정이 유일한 가드가 되도록.
      'if (a[0] === "mcp" && a[1] === "list") { console.log("lively: /stub/bin/lively mcp - ✔ Connected"); process.exit(0); }',
      'if (a[0] === "mcp" && a[1] === "get") {',
      ...(g.out || []).map((l) => `  console.log(\`${l}\`);`),
      ...(g.err || []).map((l) => `  console.error(\`${l}\`);`),
      `  process.exit(${g.code});`,
      "}",
      "process.exit(0);",
    ].join("\n"));
  }
  return {
    home, bin, ccd, log,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []),
  };
}
// 하네스가 `--scope user` 등록을 기록하는 그 파일(폴백이 읽는 대상). raw 로 파손 JSON 도 심는다.
const writeCfg = (dir, obj) => writeFileSync(join(dir, ".claude.json"), JSON.stringify(obj, null, 2) + "\n");
const writeCfgRaw = (dir, raw) => writeFileSync(join(dir, ".claude.json"), raw);
const LIVELY_ENTRY = { lively: { type: "stdio", command: "/stub/lively", args: ["mcp"] } };

// status --json 실행 — 게이트웨이 미설정(빈 문자열)이라 네트워크를 안 탄다(프로브는 게이트웨이 검사보다 앞).
//  ⚠ LIVELY_GATEWAY_URL·LIVELY_TOKEN·CLAUDE_CONFIG_DIR 을 **명시적으로** 덮는다 — 셸에 있으면 실제 설정을 읽는다.
async function statusOf(c) {
  const env = {
    ...process.env,
    PATH: closedPath(c.bin),                          // 닫힌 PATH — 실제 claude 가 절대 안 잡히게
    LIVELY_HOME: c.home,                              // CLI 의 HOME(= 유저 설정파일 후보의 뿌리)도 이걸 따른다
    CLAUDE_CONFIG_DIR: c.ccd,
    LIVELY_GATEWAY_URL: "",
    LIVELY_TOKEN: "",
    NO_COLOR: "1",
  };
  const r = await pExecFile(process.execPath, [CLI, "status", "--json"], { cwd: c.home, env, timeout: 30_000 })
    .catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message) }));
  try { return JSON.parse(r.stdout).harness.claude; }
  catch { throw new Error(`status --json 파싱 실패: stdout=${String(r.stdout).slice(0, 200)} / stderr=${String(r.stderr).slice(-300)}`); }
}
const listCalls = (c) => c.calls().filter((l) => /^mcp list\b/.test(l));
const getCalls = (c) => c.calls().filter((l) => /^mcp get\b/.test(l));
const shape = (h) => JSON.stringify(h);
const ALL = [];   // ⑫ 공통 단정용 — 모든 케이스를 모아 한 번에 본다

async function run(name, mode, opts = {}) {
  const c = mkCase(name, mode, opts);
  opts.seed?.(c);
  const h = await statusOf(c);
  ALL.push({ name, c });
  return { c, h };
}

try {
  // ── ① claude 미설치 — 프로브 자체를 하지 않는다. 연결은 false 가 아니라 **null**(안 물어봤으니 모른다) ──
  {
    const { c, h } = await run("no-claude", "connected", { stub: false });
    check("① claude 미설치 → installed=false, mcp=false, mcpConnected=null(거짓 단정 금지)",
      h.installed === false && h.mcp === false && h.mcpConnected === null, shape(h));
    check("① 미설치면 하네스를 아예 안 부른다(호출 0)", c.calls().length === 0, JSON.stringify(c.calls()));
  }

  // ── ② 등록 + 연결 ✔ ──
  {
    const { c, h } = await run("connected", "connected");
    check("② 등록·연결 → mcp=true, mcpConnected=true", h.mcp === true && h.mcpConnected === true, shape(h));
    check("② 우리 서버 하나만 물어본다(get 1회 · 대상이 lively)",
      getCalls(c).length === 1 && /\blively\b/.test(getCalls(c)[0]), JSON.stringify(c.calls()));
  }

  // ── ③ 🔴 등록됐지만 지금 끊김 — 종전엔 감지 못 했다(이름만 봤으니 true). VPN 끊김·게이트웨이 다운이 여기로 뜬다 ──
  {
    const { h } = await run("down", "down");
    check("🔴 ③ 등록·연결실패 → mcp=true, mcpConnected=false (끊김을 실제로 감지)",
      h.mcp === true && h.mcpConnected === false, shape(h));
  }

  // ── ④ 상태 줄이 없는 출력 — 등록은 사실, 연결은 **모른다**(null). 없는 줄을 false 로 읽으면 거짓 경보다 ──
  {
    const { h } = await run("no-status-line", "noStatus");
    check("④ 등록됐지만 상태 줄 없음 → mcp=true, mcpConnected=null", h.mcp === true && h.mcpConnected === null, shape(h));
  }

  // ── ⑤ 상태가 ✔/✘ 도 아닌 값 — 연결됐다고 볼 근거가 없으므로 false(보수적) ──
  {
    const { h } = await run("weird-status", "weird");
    check("⑤ 상태가 ✔ 아님(예: Pending) → mcpConnected=false(보수적 판정)",
      h.mcp === true && h.mcpConnected === false, shape(h));
  }

  // ── ⑥ 미등록 + 설정파일 없음 ──
  {
    const { c, h } = await run("absent", "absent");
    check("⑥ 미등록 + 설정파일 없음 → mcp=false, mcpConnected=null", h.mcp === false && h.mcpConnected === null, shape(h));
    check("⑥ 미등록이어도 목록 전체 조회로 되돌아가지 않는다", listCalls(c).length === 0, JSON.stringify(c.calls()));
  }

  // ── ⑦ 구버전 하네스(하위명령 미지원) + HOME 설정파일에 lively → 폴백으로 등록은 맞힌다, 연결은 null ──
  {
    const { h } = await run("old-home-cfg", "old", { seed: (c) => writeCfg(c.home, { mcpServers: LIVELY_ENTRY }) });
    check("⑦ 구버전(하위명령 미지원) + HOME 설정파일 등록 → mcp=true(폴백), mcpConnected=null",
      h.mcp === true && h.mcpConnected === null, shape(h));
  }

  // ── ⑧ 프로필 설정파일(CLAUDE_CONFIG_DIR)에만 있어도 찾는다 — 후보를 하나만 보면 "등록했는데 미등록"이 된다 ──
  {
    const { h } = await run("old-profile-cfg", "old", { seed: (c) => writeCfg(c.ccd, { mcpServers: LIVELY_ENTRY }) });
    check("⑧ 프로필 설정파일에만 등록돼 있어도 찾는다(존재하는 후보 전부 확인)", h.mcp === true, shape(h));
  }

  // ── ⑨ 설정파일이 파손 JSON — status 는 죽지 않고 값으로 담는다 ──
  {
    const { h } = await run("broken-cfg", "old", { seed: (c) => writeCfgRaw(c.home, "{not json") });
    check("⑨ 파손 설정파일 → 죽지 않고 mcp=false (status 는 진단 도구다)",
      h.mcp === false && h.mcpConnected === null, shape(h));
  }

  // ── ⑩ mcpServers 자체가 없는 설정파일 ──
  {
    const { h } = await run("no-servers-key", "old", { seed: (c) => writeCfg(c.home, { someOtherKey: 1 }) });
    check("⑩ mcpServers 키 자체가 없음 → mcp=false", h.mcp === false, shape(h));
  }

  // ── ⑪ 경계: 키는 있으나 값이 null — **키 존재 ≠ 등록** ──
  {
    const { h } = await run("null-entry", "old", { seed: (c) => writeCfg(c.home, { mcpServers: { lively: null } }) });
    check("⑪ 경계 — mcpServers.lively 키만 있고 값이 null → mcp=false(키 존재 ≠ 등록)", h.mcp === false, shape(h));
  }

  // ── ⑫ 🔴 전 케이스 공통 — 목록 전체 조회(남의 MCP 서버까지 깨우는 그 호출)는 **단 한 번도** 없었다 ──
  {
    const offenders = ALL.filter(({ c }) => listCalls(c).length > 0).map(({ name }) => name);
    check("🔴 ⑫ 모든 케이스에서 전체 목록 조회 호출 0건(남의 커넥터를 깨우지 않는다 — 이 변경의 목적)",
      offenders.length === 0, `목록 조회를 부른 케이스: ${JSON.stringify(offenders)}`);
    // 배선 단언 — 관측 장치가 죽어 있으면 위 단정들이 통째로 공허하다.
    const probed = ALL.filter(({ name }) => name !== "no-claude");
    check("⑫ 배선 — 미설치 케이스를 뺀 전부에서 스텁이 실제로 불렸다(관측 장치 생존)",
      probed.length > 0 && probed.every(({ c }) => getCalls(c).length === 1), JSON.stringify(probed.map(({ name, c }) => [name, c.calls()])));
    check("⑫ 배선 — 스텁이 받은 호출은 전부 mcp 하위명령뿐(실기기 자원 무접촉)",
      probed.every(({ c }) => c.calls().every((l) => /^mcp (get|list)\b/.test(l))), JSON.stringify(probed.map(({ name, c }) => [name, c.calls()])));
  }

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
} finally {
  rmSync(BOX, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
