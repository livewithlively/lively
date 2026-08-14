#!/usr/bin/env node
// `lively node --daemon` 상시화(#869) e2e — **픽스처 게이트웨이 + 샌드박스 HOME + launchctl/systemctl 스텁** 으로
//  등록→번들 pull→데몬 등록(plist/systemd unit)→`node stop` 해제를 통째로 돈다.
//  ⚠ 실제 사용자 launchd/systemd 는 절대 건드리지 않는다: 데몬 제어 바이너리(launchctl·systemctl·pkill)를 PATH 스텁으로
//    가로채 호출 인자만 로그에 적는다. HOME 도 LIVELY_HOME 으로 샌드박스 → ~/.lively·~/Library 무접촉.
//  실행: node kit/cli/lively-node.test.mjs   (npm test 체인에 포함)
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// 이 파일은 **POSIX 상시화 경로의 e2e** 다 — tmux + launchd/systemd + pkill 을 스텁으로 가로채 검증한다.
//  ⚠ 2026-08-05(#1541) 사양 변경: Windows 는 더 이상 비목표가 아니다. psmux(ConPTY 네이티브 tmux 구현) +
//   작업 스케줄러로 **네이티브 지원**한다(WSL2 아님). 다만 그 경로는 여기서 못 돈다 — launchctl/systemctl
//   스텁도, pkill 도 Windows 엔 없다. 그래서 갈라 둔다:
//     · Windows 계약(경로 탐지·작업 스케줄러 XML) → `kit/cli/node-win-contract.test.mjs`(순수함수, 전 플랫폼)
//     · Windows 실기기 등록·기동                  → Windows VM e2e(프로젝트 #1541)
//  가드를 명시해 두는 관례는 유지한다(짝인 bootstrap-node-gate.test.mjs 와 동일) — 안 그러면 매번
//  "이건 원래 안 되는 거였나"를 다시 조사하게 된다(#1510).
if (process.platform === "win32") {
  console.log("skip — 이 파일은 POSIX 상시화 e2e(launchd/systemd/pkill 스텁). Windows 경로는 node-win-contract.test.mjs + 실기기 e2e 가 덮는다.");
  process.exit(0);
}

const pExecFile = promisify(execFile);
const HERE = join(fileURLToPath(import.meta.url), "..");
const CLI = join(HERE, "lively.mjs");
const DARWIN = process.platform === "darwin";
const LINUX = process.platform === "linux";
const SYSTEMD = LINUX && existsSync("/run/systemd/system");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

const BOX = mkdtempSync(join(tmpdir(), "lively-node-test-"));
const cleanup = () => { try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ } };

const TOKEN = "lvk_test_node_0123456789";
const NODE_TOKEN = "lvNode_deadbeef";
const NODE_ID = "test-daemon-node";

// ── 픽스처 게이트웨이 — 노드 등록(POST /api/ui/nodes) + 에이전트 번들(GET /api/ui/node-agent). ──
// 번들은 agent.mjs 하나만 담은 tgz(데몬 등록 경로 검증엔 에이전트를 실제로 실행하지 않으므로 내용은 무관 — 스텁이면 충분).
function makeAgentBundle() {
  const stage = mkdtempSync(join(BOX, "agent-stage-"));
  writeFileSync(join(stage, "agent.mjs"), "// stub node agent — 데몬 등록 테스트용(실행 안 함)\nprocess.exit(0);\n");
  const tgz = join(BOX, "node-agent.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", stage, "."], { stdio: "ignore" });
  return readFileSync(tgz);
}
const AGENT_TGZ = makeAgentBundle();
let posts = [];
const server = createServer((req, res) => {
  const path = (req.url || "").split("?")[0];
  if (String(req.headers.authorization || "") !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
  if (req.method === "POST" && path === "/api/ui/nodes") {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      posts.push(JSON.parse(body || "{}"));
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ node: { id: NODE_ID, name: NODE_ID, kind: "member", online: false, sessions: 0 }, token: NODE_TOKEN, install: "…" }));
    });
  } else if (path === "/api/ui/node-agent") {
    res.writeHead(200, { "content-type": "application/gzip" }).end(AGENT_TGZ);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${server.address().port}`;

// ── 샌드박스 HOME + 데몬 제어 스텁(launchctl·systemctl·pkill) ──────────────────
// 스텁은 자기 argv 를 로그에 적고 exit 0 → CLI 가 **정확히 어떤 인자로** 데몬을 등록/해제하는지 검증한다.
function newHome(name) {
  const home = join(BOX, name);
  mkdirSync(join(home, ".lively"), { recursive: true });
  writeFileSync(join(home, ".lively", "gateway-url"), GW);
  writeFileSync(join(home, ".lively", "token"), TOKEN); chmodSync(join(home, ".lively", "token"), 0o600);
  const bin = join(home, "stub-bin");
  mkdirSync(bin, { recursive: true });
  const log = join(home, "daemonctl.log");
  for (const tool of ["launchctl", "systemctl", "pkill"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s %s\\n' "${tool}" "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  return { home, bin, log, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []) };
}

async function lively(h, args, { expectFail = false } = {}) {
  try {
    const r = await pExecFile(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: h.home, LIVELY_HOME: h.home,
        PATH: `${h.bin}:${process.env.PATH}`,
        LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "",
      },
      timeout: 60000,
    });
    if (expectFail) throw new Error("성공했지만 실패를 기대했음");
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    if (!expectFail && typeof e.code === "undefined") throw e;
    return { code: e.code ?? 1, out: e.stdout ?? "", err: e.stderr ?? String(e.message) };
  }
}

try {
  const H = newHome("h-daemon");

  // ① `lively node --daemon` — 등록(POST) → 번들 pull → env 파일 → 데몬 등록. foreground 로 블록되지 않고 종료해야 한다.
  const r = await lively(H, ["node", "--daemon", "--id", NODE_ID]);
  check("① node --daemon 이 블록 없이 종료(상시화 후 반환)", r.code === 0, `code=${r.code}\n${r.err.slice(-400)}`);

  // ② 노드 등록 — 게이트웨이에 POST 로 등록되고, 로컬 토큰이 없었으므로 새로 등록됐다.
  check("② 게이트웨이에 노드 등록(POST /api/ui/nodes)", posts.length === 1 && posts[0].id === NODE_ID, JSON.stringify(posts));

  // ③ env 파일(0600) — GATEWAY_URL·TOKEN·ID. 데몬이 이 파일을 읽어 접속한다.
  {
    const envPath = join(H.home, ".lively", "node-agent.env");
    const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const mode = existsSync(envPath) ? (statSync(envPath).mode & 0o777).toString(8) : "?";
    check("③ node-agent.env 0600 + 접속정보(URL·TOKEN·ID)",
      mode === "600" && env.includes(`LIVELY_GATEWAY_URL=${GW}`) && env.includes(`LIVELY_NODE_TOKEN=${NODE_TOKEN}`) && env.includes(`LIVELY_NODE_ID=${NODE_ID}`),
      `mode=${mode}\n${env}`);
    // TMUX_BIN 절대경로 필수(#869 haru 회귀) — 데몬은 최소 PATH 라 상대경로/미설정이면 세션 생성이 spawn ENOENT 로 깨진다.
    const mtmux = env.match(/^TMUX_BIN=(.+)$/m);
    check("③ env 에 TMUX_BIN 절대경로(데몬 최소 PATH 안전 — 세션생성 tmux 해석)",
      !!mtmux && mtmux[1].startsWith("/") && existsSync(mtmux[1]), `TMUX_BIN=${mtmux?.[1] ?? "(없음)"}`);
    // PATH baked(#869) — 데몬은 최소 PATH 라, 사용자 로그인 PATH 를 넣어야 tmux 서버 pane 이 harness(claude 등)를 찾는다.
    check("③ env 에 PATH baked(데몬 tmux 서버가 pane 명령 해석 — harness not-found 방지)",
      /^PATH=\/.+/m.test(env), `PATH 줄: ${(env.match(/^PATH=.*/m) || ["(없음)"])[0]}`);
  }

  // ④ 번들 해제 — ~/.lively/node-agent/agent.mjs 로 풀렸다(데몬이 이걸 실행한다).
  {
    const agentJs = join(H.home, ".lively", "node-agent", "agent.mjs");
    check("④ 에이전트 번들 해제 → node-agent/agent.mjs", existsSync(agentJs), `없음: ${agentJs}\n${r.err.slice(-300)}`);
  }

  // ⑤ 플랫폼별 데몬 아티팩트 — macOS plist / Linux systemd unit. 둘 다 **번들 agent.mjs 를 가리키고 env 파일을 읽어야** 한다.
  const agentJs = join(H.home, ".lively", "node-agent", "agent.mjs");
  const envFile = join(H.home, ".lively", "node-agent.env");
  if (DARWIN) {
    const plistPath = join(H.home, "Library", "LaunchAgents", "io.lvly.node-agent.plist");
    const plist = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : "";
    check("⑤ LaunchAgent plist 생성 + Label·RunAtLoad·KeepAlive",
      plist.includes("<string>io.lvly.node-agent</string>") && plist.includes("<key>RunAtLoad</key>") && plist.includes("<key>KeepAlive</key>"),
      plist.slice(0, 300));
    check("⑤ plist 가 번들 agent.mjs 실행 + env 파일 source",
      plist.includes(agentJs) && plist.includes(envFile), `agentJs?${plist.includes(agentJs)} envFile?${plist.includes(envFile)}`);
    // 실제 macOS 파서(plutil)로 plist 유효성 검증 — stub launchctl 로는 못 잡는 XML/스키마 오류를 여기서 잡는다(부작용 없음: lint 만).
    { let lint = ""; try { lint = execFileSync("plutil", ["-lint", plistPath], { encoding: "utf8" }); } catch (e) { lint = "FAIL:" + (e.stdout || e.message); }
      check("⑤ plutil -lint 통과(launchd 가 받아들이는 유효한 plist)", /OK\s*$/.test(lint.trim()), lint); }
    // 재등록 안전 — bootout(구 등록 제거) 후 bootstrap(신규 등록) 순서.
    const calls = H.calls();
    const iOut = calls.findIndex((l) => l.startsWith("launchctl") && l.includes("bootout"));
    const iIn = calls.findIndex((l) => l.startsWith("launchctl") && l.includes("bootstrap"));
    check("⑤ launchctl bootout → bootstrap 순서(재등록 안전)", iOut >= 0 && iIn >= 0 && iOut < iIn, JSON.stringify(calls));
  } else if (SYSTEMD) {
    const unitPath = join(H.home, ".config", "systemd", "user", "lively-node-agent.service");
    const unit = existsSync(unitPath) ? readFileSync(unitPath, "utf8") : "";
    check("⑤ systemd unit 생성 + ExecStart(번들) + EnvironmentFile + Restart",
      unit.includes(`ExecStart=${process.execPath} ${agentJs}`) && unit.includes(`EnvironmentFile=${envFile}`) && /Restart=always/.test(unit),
      unit.slice(0, 400));
    const calls = H.calls();
    check("⑤ systemctl --user enable --now 호출", calls.some((l) => l.includes("enable") && l.includes("--now")), JSON.stringify(calls));
  } else {
    // Linux nohup 폴백(systemd 미활성) — 최소한 등록·env·번들은 검증됨(③④). 데몬 프로세스는 detached 라 여기선 소프트 확인.
    ok("⑤ (systemd 미활성 — nohup 폴백: env·번들 등록은 ③④ 로 검증)");
  }

  // ⑥ `lively node stop` — 데몬 해제. macOS 는 bootout + plist 삭제, Linux 는 disable + unit 삭제.
  {
    const before = H.calls().length;
    const rs = await lively(H, ["node", "stop"]);
    check("⑥ node stop 정상 종료", rs.code === 0, `code=${rs.code} ${rs.err.slice(-200)}`);
    const after = H.calls().slice(before);
    if (DARWIN) {
      const plistPath = join(H.home, "Library", "LaunchAgents", "io.lvly.node-agent.plist");
      check("⑥ stop: launchctl bootout + plist 삭제",
        after.some((l) => l.startsWith("launchctl") && l.includes("bootout")) && !existsSync(plistPath),
        `calls=${JSON.stringify(after)} plist존재=${existsSync(plistPath)}`);
    } else if (SYSTEMD) {
      const unitPath = join(H.home, ".config", "systemd", "user", "lively-node-agent.service");
      check("⑥ stop: systemctl disable + unit 삭제",
        after.some((l) => l.includes("disable")) && !existsSync(unitPath), `calls=${JSON.stringify(after)}`);
    } else {
      check("⑥ stop: pkill 로 nohup 프로세스 정리", after.some((l) => l.startsWith("pkill")), JSON.stringify(after));
    }
  }

  // ⑦ 비파괴 — stop 은 노드 등록·번들을 남긴다(재기동 시 재다운로드 불필요, install.sh 무파괴 불변식과 동일).
  {
    check("⑦ stop 후에도 등록(env)·번들(agent.mjs) 보존",
      existsSync(join(H.home, ".lively", "node-agent.env")) && existsSync(join(H.home, ".lively", "node-agent", "agent.mjs")),
      "stop 이 등록/번들을 지웠다");
  }
} finally {
  server.close();
  cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
