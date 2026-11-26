#!/usr/bin/env node
// `lively node --daemon` 상시화(#869) e2e — **픽스처 게이트웨이 + 샌드박스 HOME + launchctl/systemctl 스텁** 으로
//  등록→번들 pull→데몬 등록(plist/systemd unit)→`node stop` 해제를 통째로 돈다.
//  ⚠ 실제 사용자 launchd/systemd 는 절대 건드리지 않는다: 데몬 제어 바이너리(launchctl·systemctl·loginctl·pkill)를 PATH 스텁으로
//    가로채 호출 인자만 로그에 적는다. HOME 도 LIVELY_HOME 으로 샌드박스 → ~/.lively·~/Library 무접촉.
//  실행: node kit/cli/lively-node.test.mjs   (npm test 체인에 포함)
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir, hostname as osHostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";

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
// ⚠ 실제 게이트웨이가 발급하는 형식과 같아야 한다 — mintToken 은 항상 `lvk_` 접두이고
//  서버의 authNodeToken 도 그 접두를 요구한다. 종전 픽스처("lvNode_…")는 라이브에서는
//  절대 통과하지 못하는 값이라, CLI 가 응답 토큰을 검증해도 그 사실을 여기서 못 잡았다.
const NODE_TOKEN = "lvk_test_node_agent_0123";
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
  // bash 도 가로챈다 — systemd 가 없는 리눅스(컨테이너 등)에서 `node --daemon` 은 nohup 폴백을 타
  //  `spawn("bash", …)` 로 데몬을 띄운다. 스텁이 없으면 그 경로가 (ⓐ 진짜 데몬을 백그라운드로 남기거나
  //  ⓑ CLI 샌드박스의 외부 실행 allowlist 에 걸려 exit 1) 이라 ① 이 환경에 따라 깨진다 —
  //  실측 2026-09-08, systemd 없는 CI 컨테이너(node:22)에서 `denied external-cli: bash` 로 ① 실패.
  //  스텁은 샌드박스 HOME 안에 있어 allowlist 를 통과하고, 인자만 로그에 적어 부작용이 없다.
  //  (macOS·systemd 경로는 bash 를 PATH 로 부르지 않으므로 — plist 는 절대경로 /bin/bash,
  //   systemd 는 systemctl — 이 스텁의 영향을 받지 않는다.)
  for (const tool of ["launchctl", "systemctl", "loginctl", "pkill", "bash"]) {
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
        ...sandboxEnv({ home: h.home }), LIVELY_HOME: h.home,
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
  // ⑨⑩ 인자 가드(#4006) — **도움말과 모르는 인자는 아무것도 기동하지 않는다.**
  //  계기(2026-09-16 실측): `lively node --help` 가 도움말이 아니라 인자 없는 `lively node` 와 같아서, 이미
  //   데몬이 도는 컴퓨터에 같은 id 에이전트를 하나 더 띄웠다. 게이트웨이가 둘을 1초 간격으로 번갈아 쫓아내
  //   그 노드의 웹 터미널이 3분간 2초마다 끊겼다(교체 162회).
  //  순수 판정은 node-argv-guard.test.mjs 가 표로 굳힌다. 여기서는 **실제 CLI 를 띄워 부작용이 0 인지**
  //   (등록 POST · node-agent.env)를 본다 — 그게 이 사고의 실제 피해였다.
  {
    const HG = newHome("h-guard");
    const envPath = join(HG.home, ".lively", "node-agent.env");
    const before = posts.length;

    const rh = await lively(HG, ["node", "--help"]);
    check("⑨ node --help → 성공 종료", rh.code === 0, `code=${rh.code}\n${rh.err.slice(-300)}`);
    // ⚠ CLI 의 say() 는 stderr 로 나간다(stdout 은 --json 용으로 비워 둔다) — 둘을 합쳐서 본다.
    check("⑨ node --help → 사용법을 낸다", /사용법: lively node/.test(rh.out + rh.err), (rh.out + rh.err).slice(0, 200) || "(빈 출력)");
    check("⑨ ★ node --help 는 등록도 접속정보 파일도 만들지 않는다(부작용 0)",
      posts.length === before && !existsSync(envPath),
      `등록 POST ${posts.length - before}건 · env존재=${existsSync(envPath)}`);

    const ru = await lively(HG, ["node", "--frobnicate"], { expectFail: true });
    check("⑩ 모르는 인자 → 비-0 종료", ru.code !== 0, `code=${ru.code}`);
    check("⑩ 모르는 인자 → 그 인자를 지목하고 사용법을 낸다",
      /--frobnicate/.test(ru.out + ru.err) && /사용법: lively node/.test(ru.out + ru.err),
      (ru.out + ru.err).slice(-300) || "(빈 출력)");
    check("⑩ ★ 모르는 인자도 부작용 0",
      posts.length === before && !existsSync(envPath),
      `등록 POST ${posts.length - before}건 · env존재=${existsSync(envPath)}`);
  }

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
    // PATH 굽기가 **현재(호출자) PATH 를 잃지 않는다**(#1541) — GUI 가 몰아도 로그인 셸과 합집합이므로,
    //  최소한 이 테스트 프로세스의 PATH 성분은 남아 있어야 한다(스텁 bin 경로가 그 증거).
    const baked = (env.match(/^PATH=(.*)$/m) || [])[1] || "";
    check("③ PATH 합집합 — 호출자 PATH 성분 보존 + ~/.lively/bin 포함(#1541 GUI 재시작 회귀 방지)",
      baked.split(":").includes(H.bin) && baked.split(":").includes(join(H.home, ".lively", "bin")),
      `baked=${baked.slice(0, 200)}`);
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

  // ⑧ 게이트웨이 전환(#2161) — **노드 토큰은 그 게이트웨이(테넌트)에 매인다.**
  //  실측 사고(2026-08-27): dev 로그아웃 → 매니지드 로그인 뒤 노드가 /node/ws 에서 **502 무한 재시도**.
  //   원인은 CLI 가 "파일에 토큰이 있다" 하나만 보고 등록을 통째로 건너뛰어, **옛 테넌트의 토큰을 새
  //   게이트웨이에 제시**한 것이다. 그 게이트웨이에는 그 org_node 행이 아예 없어 조인이 영원히 빈다.
  //   게다가 종전 코드는 LIVELY_GATEWAY_URL 만 새 주소로 덮어써, env 파일이 **'새 게이트웨이 + 옛 토큰'
  //   이라는 스스로 모순된 상태**로 굳었다 — 재실행해도 스스로 낫지 않는다.
  //  ⑦ 이 "stop 은 등록을 남긴다"(재사용은 옳다)를 굳혔다면, ⑧ 은 그 재사용의 **한계**를 굳힌다.
  {
    const TOKEN2 = "lvk_test_second_gateway_9876";
    const NODE_TOKEN2 = "lvk_test_node_agent_second";
    const posts2 = [];
    const srv2 = createServer((req, res) => {
      const p2 = (req.url || "").split("?")[0];
      // 다른 게이트웨이 = 다른 로그인 토큰. 옛 토큰으로 오면 401 이다(현실과 같다).
      if (String(req.headers.authorization || "") !== `Bearer ${TOKEN2}`) { res.writeHead(401).end(); return; }
      if (req.method === "POST" && p2 === "/api/ui/nodes") {
        let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
          posts2.push(JSON.parse(body || "{}"));
          res.writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ node: { id: NODE_ID, name: NODE_ID, kind: "member" }, token: NODE_TOKEN2, install: "…" }));
        });
      } else if (p2 === "/api/ui/node-agent") {
        res.writeHead(200, { "content-type": "application/gzip" }).end(AGENT_TGZ);
      } else { res.writeHead(404).end(); }
    });
    await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
    const GW2 = `http://127.0.0.1:${srv2.address().port}`;
    try {
      const H2 = newHome("h-switch");
      const envPath = join(H2.home, ".lively", "node-agent.env");
      posts = [];
      await lively(H2, ["node", "--daemon", "--id", NODE_ID]);
      // 데몬 등록이 막히는 환경(HostEffects 차단 등)에서는 env 파일 자체가 안 생긴다 —
      //  그때 readFileSync 로 죽으면 **뒤 검사들이 통째로 안 돈다**. 없으면 빈 문자열로 두고 FAIL 로 남긴다.
      const readEnv = () => (existsSync(envPath) ? readFileSync(envPath, "utf8") : "");
      const env1 = readEnv();
      check("⑧ (준비) 첫 게이트웨이 등록 — 그 게이트웨이의 노드 토큰이 굳는다",
        posts.length === 1 && env1.includes(`LIVELY_NODE_TOKEN=${NODE_TOKEN}`) && env1.includes(`LIVELY_GATEWAY_URL=${GW}`),
        `posts=${posts.length}\n${env1}`);

      // 로그아웃 → 다른 게이트웨이로 로그인 = gateway-url·token 교체(로그인 경로가 실제로 하는 일 그대로).
      writeFileSync(join(H2.home, ".lively", "gateway-url"), GW2);
      writeFileSync(join(H2.home, ".lively", "token"), TOKEN2);
      chmodSync(join(H2.home, ".lively", "token"), 0o600);

      const r2 = await lively(H2, ["node", "--daemon", "--id", NODE_ID]);
      const env2 = readEnv();
      // ★ 회귀 방지의 핵심 — 수정 전에는 posts2.length === 0 이고 옛 토큰이 그대로 남았다.
      check("⑧ 게이트웨이가 바뀌면 재등록한다(옛 테넌트 토큰 재사용 금지)",
        posts2.length === 1 && env2.includes(`LIVELY_NODE_TOKEN=${NODE_TOKEN2}`),
        `code=${r2.code} posts2=${posts2.length}\n${env2}\n${r2.err.slice(-300)}`);
      // env 가 스스로 모순되지 않는다 — 새 게이트웨이와 새 토큰이 **짝**이고, 옛 토큰 흔적이 남지 않는다.
      check("⑧ env 가 새 게이트웨이와 짝이 맞는다(옛 토큰 잔존 없음)",
        // env2 가 비어 있으면 `!includes` 가 vacuous 하게 참이 된다 — 파일이 있다는 것부터 조건이다.
        env2.length > 0 && env2.includes(`LIVELY_GATEWAY_URL=${GW2}`) && !env2.includes(NODE_TOKEN),
        env2 || "(node-agent.env 없음)");
    } finally { srv2.close(); }
  }

  // ⑪ 이름 겹침 — **호스트 이름이 같은 다른 사람의 컴퓨터**가 그 이름을 먼저 등록해 둔 경우.
  //  실측(2026-11-16): 회사가 나눠 준 맥 두 대가 모두 `acmeui-MacBookAir`. 두 번째 사람은 등록 409 → 회전 403 으로 막히고
  //   «접속 열쇠가 유효하지 않습니다 — lively login 으로 다시 등록하세요» 만 봤다(다시 로그인해도 낫지 않는다).
  //   데스크톱 앱의 [노드 시작] 은 `lively node --daemon` 고정이라 `--id` 로 비킬 수도 없었다.
  //  사양: 이름을 직접 주지 않았으면 `<호스트 이름>-<구성원 id>` 로 비켜 등록하고, 다음 실행은 그 이름을 그대로 잇는다.
  {
    const TOKEN3 = "lvk_test_collision_gateway_55";
    const NODE_TOKEN3 = "lvk_test_node_agent_collide";
    const SLUG = (osHostname().split(".")[0] || "node").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "node";
    const MINE = `${SLUG.replace(/-+$/, "")}-mina`;   // collisionNodeId 처럼 잘린 호스트 이름 끝의 - 를 뗀다(40자째가 - 인 호스트)
    const reg3 = [], rot3 = [];
    const srv3 = createServer((req, res) => {
      const p3 = (req.url || "").split("?")[0];
      const json = (code, o) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (String(req.headers.authorization || "") !== `Bearer ${TOKEN3}`) { res.writeHead(401).end(); return; }
      if (req.method === "POST" && p3 === "/api/ui/nodes") {
        let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
          const b = JSON.parse(body || "{}"); reg3.push(b.id);
          // 호스트 이름 그대로는 **남의 노드**가 이미 쓰고 있다. 비킨 이름은 비어 있다.
          if (b.id === MINE) json(200, { node: { id: MINE, name: MINE, kind: "member" }, token: NODE_TOKEN3, install: "…" });
          else json(409, { error: `이미 존재하는 노드입니다: ${b.id}` });
        });
      } else if (req.method === "POST" && /^\/api\/ui\/nodes\/[^/]+\/rotate$/.test(p3)) {
        rot3.push(decodeURIComponent(p3.split("/")[4]));
        json(403, { error: "본인 노드가 아닙니다" });
      } else if (req.method === "GET" && p3 === "/api/ui/nodes") {
        json(200, { nodes: [] });   // 관리자가 아니면 목록에는 내 노드만 나온다 — 남의 노드는 보이지 않는다
      } else if (p3 === "/api/ui/me/profile") {
        json(200, { id: "mina", display_name: "미나" });
      } else if (p3 === "/api/ui/node-agent") {
        res.writeHead(200, { "content-type": "application/gzip" }).end(AGENT_TGZ);
      } else { res.writeHead(404).end(); }
    });
    await new Promise((r) => srv3.listen(0, "127.0.0.1", r));
    const GW3 = `http://127.0.0.1:${srv3.address().port}`;
    try {
      const H3 = newHome("h-collide");
      const envPath = join(H3.home, ".lively", "node-agent.env");
      const readEnv = () => (existsSync(envPath) ? readFileSync(envPath, "utf8") : "");
      writeFileSync(join(H3.home, ".lively", "gateway-url"), GW3);
      writeFileSync(join(H3.home, ".lively", "token"), TOKEN3);
      chmodSync(join(H3.home, ".lively", "token"), 0o600);

      // 이름을 주지 않고 실행 = 데스크톱 앱의 [노드 시작] 이 부르는 그대로.
      const r1 = await lively(H3, ["node", "--daemon"]);
      const env1 = readEnv();
      check("⑪ ★ 호스트 이름이 남의 노드와 겹치면 <호스트 이름>-<구성원 id> 로 비켜 등록한다",
        r1.code === 0 && reg3.join(",") === `${SLUG},${MINE}` && rot3.join(",") === SLUG
          && env1.includes(`LIVELY_NODE_ID=${MINE}\n`) && env1.includes(`LIVELY_NODE_TOKEN=${NODE_TOKEN3}`),
        `code=${r1.code} 등록=${reg3} 회전=${rot3}\n${env1}\n${r1.err.slice(-400)}`);
      check("⑪ 왜 다른 이름이 됐는지 사람에게 말한다", new RegExp(`${MINE}' 로 등록합니다`).test(r1.err), r1.err.slice(-400));

      // 다시 실행 — 비킨 이름을 그대로 잇는다. 호스트 이름으로 다시 등록을 시도하면(=매 실행 409 → 회전) 안 된다.
      const before = reg3.length;
      const r2 = await lively(H3, ["node", "--daemon"]);
      check("⑪ ★ 다음 실행은 비킨 이름을 잇는다(다시 등록·회전하지 않는다)",
        r2.code === 0 && reg3.length === before && rot3.length === 1 && readEnv().includes(`LIVELY_NODE_ID=${MINE}\n`),
        `code=${r2.code} 등록 +${reg3.length - before} 회전=${rot3.length}\n${r2.err.slice(-300)}`);

      // 이름을 **직접 준** 경우엔 바꿔 등록하지 않는다 — 그 이름이 남의 것이라고 말하고 멈춘다(로그인 탓으로 돌리지 않는다).
      const H4 = newHome("h-collide-explicit");
      writeFileSync(join(H4.home, ".lively", "gateway-url"), GW3);
      writeFileSync(join(H4.home, ".lively", "token"), TOKEN3);
      chmodSync(join(H4.home, ".lively", "token"), 0o600);
      const r3 = await lively(H4, ["node", "--daemon", "--id", "someone-elses-box"], { expectFail: true });
      check("⑪ --id 로 준 이름이 남의 것이면 멈추고 다른 이름을 고르라고 말한다",
        r3.code !== 0 && /다른 구성원이 이미 쓰는 노드 이름/.test(r3.err) && !/lively login/.test(r3.err)
          && !existsSync(join(H4.home, ".lively", "node-agent.env")),
        `code=${r3.code}\n${r3.err.slice(-300)}`);
    } finally { srv3.close(); }
  }

  // ⑫ 이름 겹침 — **관리자**의 컴퓨터. 서버는 관리자에게 남의 노드 회전도 내준다(requireOwn).
  //  그래서 «등록 409 → 회전» 을 묻지 않고 하면 403 이 나지 않고 **그 사람 노드의 열쇠가 나온다**:
  //   그 사람의 노드는 끊기고(옛 열쇠 무효), 그 사람의 세션이 관리자 컴퓨터에서 열린다. ⑪ 의 판정(409 + 403)으로는 못 잡는다.
  //  사양: 이름을 직접 주지 않았으면 회전하기 **전에** 그 이름의 주인을 본다(관리자에게는 목록에 남의 노드도 나온다).
  //   주인이 다른 구성원이고 worker 가 아니면 회전하지 않고 ⑪ 처럼 비켜 등록한다. 주인이 나거나 알 수 없으면 종전 길이다.
  {
    const TOKEN5 = "lvk_test_collision_admin_77";
    const NODE_TOKEN5 = "lvk_test_node_agent_admin";
    const ROTATED = "lvk_test_node_agent_rotated";   // 회전이 내주는 열쇠 — 남의 노드였다면 «가져온 열쇠» 다
    const SLUG = (osHostname().split(".")[0] || "node").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "node";
    const MINE = `${SLUG.replace(/-+$/, "")}-jisoo`;   // collisionNodeId 처럼 잘린 호스트 이름 끝의 - 를 뗀다
    // 케이스마다 바꾸는 서버 상태: 호스트 이름 그대로의 노드 주인·종류, 목록·프로필이 읽히는가.
    //  altOwner = 비킨 이름의 노드가 이미 있을 때 그 주인(null = 없음) · altFail = 비킨 이름 등록이 409 가 아닌 오류로 실패.
    const WORLD0 = { owner: "mina", kind: "member", listOk: true, profileOk: true, altOwner: null, altFail: false };
    const world = { ...WORLD0 };
    const reg5 = [], rot5 = [], lists5 = [];
    const srv5 = createServer((req, res) => {
      const p5 = (req.url || "").split("?")[0];
      const json = (code, o) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (String(req.headers.authorization || "") !== `Bearer ${TOKEN5}`) { res.writeHead(401).end(); return; }
      if (req.method === "POST" && p5 === "/api/ui/nodes") {
        let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
          const b = JSON.parse(body || "{}"); reg5.push(b.id);
          if (b.id === MINE && world.altFail) json(500, { error: "저장 실패" });
          else if (b.id === MINE && !world.altOwner) json(200, { node: { id: MINE, name: MINE, kind: "member" }, token: NODE_TOKEN5, install: "…" });
          else json(409, { error: `이미 존재하는 노드입니다: ${b.id}` });
        });
      } else if (req.method === "GET" && p5 === "/api/ui/nodes") {
        lists5.push(1);
        if (!world.listOk) { json(500, { error: "목록 실패" }); return; }
        // 관리자에게는 남의 노드도 목록에 나온다(주인과 함께). 무관한 다른 노드도 섞어 둔다 — 이름으로 골라야 한다.
        json(200, { nodes: [
          { id: "unrelated-box", name: "unrelated-box", kind: "member", owner_member: "someone" },
          { id: SLUG, name: SLUG, ...(world.kind ? { kind: world.kind } : {}), owner_member: world.owner, online: true },
          ...(world.altOwner ? [{ id: MINE, name: MINE, kind: "member", owner_member: world.altOwner }] : []),
        ] });
      } else if (req.method === "POST" && /^\/api\/ui\/nodes\/[^/]+\/rotate$/.test(p5)) {
        // ★ 관리자라 회전이 **통과한다** — CLI 가 부르기만 하면 그 노드의 열쇠가 나온다.
        const id = decodeURIComponent(p5.split("/")[4]); rot5.push(id);
        json(200, { node: { id, name: id, kind: "member" }, token: ROTATED, install: "…" });
      } else if (p5 === "/api/ui/me/profile") {
        if (!world.profileOk) { json(500, { error: "프로필 실패" }); return; }
        json(200, { id: "jisoo", display_name: "지수" });
      } else if (p5 === "/api/ui/node-agent") {
        res.writeHead(200, { "content-type": "application/gzip" }).end(AGENT_TGZ);
      } else { res.writeHead(404).end(); }
    });
    await new Promise((r) => srv5.listen(0, "127.0.0.1", r));
    const GW5 = `http://127.0.0.1:${srv5.address().port}`;
    // 한 케이스 = 새 HOME 에서 한 번 실행. 서버 상태를 덮어쓰고 기록을 비운 뒤 돌린다.
    const run5 = async (name, patch, args = ["node", "--daemon"]) => {
      Object.assign(world, WORLD0, patch);
      reg5.length = 0; rot5.length = 0; lists5.length = 0;
      const H = newHome(name);
      writeFileSync(join(H.home, ".lively", "gateway-url"), GW5);
      writeFileSync(join(H.home, ".lively", "token"), TOKEN5);
      chmodSync(join(H.home, ".lively", "token"), 0o600);
      const r = await lively(H, args);
      const p = join(H.home, ".lively", "node-agent.env");
      return { r, env: existsSync(p) ? readFileSync(p, "utf8") : "" };
    };
    const dump = (x) => `code=${x.r.code} 등록=${reg5} 회전=${rot5} 목록조회=${lists5.length}\n${x.env}\n${x.r.err.slice(-400)}`;
    const rotatedInPlace = (x) => x.r.code === 0 && reg5.join(",") === SLUG && rot5.join(",") === SLUG
      && x.env.includes(`LIVELY_NODE_ID=${SLUG}\n`) && x.env.includes(`LIVELY_NODE_TOKEN=${ROTATED}`);
    try {
      // 행 1 — 주인이 다른 구성원(개인 컴퓨터).
      const a = await run5("h-admin-other", {});
      check("⑫ 배선: 회전 전에 주인을 물었다(목록 조회가 실제로 나갔다)", lists5.length >= 1, dump(a));
      check("⑫ ★ 관리자여도 남의 노드를 회전하지 않는다(그 사람 노드의 열쇠를 가져오지 않는다)",
        a.r.code === 0 && rot5.length === 0 && !a.env.includes(ROTATED), dump(a));
      check("⑫ ★ 관리자도 <호스트 이름>-<구성원 id> 로 비켜 등록하고 그 까닭을 말한다",
        reg5.join(",") === `${SLUG},${MINE}` && a.env.includes(`LIVELY_NODE_ID=${MINE}\n`) && a.env.includes(`LIVELY_NODE_TOKEN=${NODE_TOKEN5}`)
          && new RegExp(`${MINE}' 로 등록합니다`).test(a.r.err), dump(a));

      // 행 9 — 목록 행에 kind 칸이 없어도 남의 것이다(없다고 worker 로 보지 않는다).
      const a2 = await run5("h-admin-other-nokind", { kind: null });
      check("⑫ kind 칸이 없는 남의 노드도 회전하지 않는다", a2.r.code === 0 && rot5.length === 0 && a2.env.includes(`LIVELY_NODE_ID=${MINE}\n`), dump(a2));

      // 행 2 — 주인이 **나**: 종전처럼 회전으로 잇는다(로그아웃으로 로컬 기록이 지워진 뒤 다시 로그인한 길).
      const b = await run5("h-admin-own", { owner: "jisoo" });
      check("⑫ ★ 그 이름의 주인이 나면 종전처럼 회전으로 잇는다(비키지 않는다)", rotatedInPlace(b), dump(b));

      // 행 4 — worker 노드는 관리자들이 함께 다시 앉히는 컴퓨터다 → 종전처럼 회전.
      const c = await run5("h-admin-worker", { kind: "worker" });
      check("⑫ 남이 등록한 worker 노드는 종전처럼 회전한다", rotatedInPlace(c), dump(c));

      // 행 5·6 — 주인을 **확인하지 못했으면**(목록 · 프로필 요청 실패) 멈춘다. 모르는 채 회전하면 남의 열쇠를 가져올 수 있다.
      const stopped = (x) => x.r.code !== 0 && rot5.length === 0 && x.env === "";
      const d = await run5("h-admin-nolist", { listOk: false });
      check("⑫ ★ 목록을 못 읽으면 회전하지 않고 멈춘다(다시 실행하라고 말한다)", stopped(d) && /확인하지 못했습니다/.test(d.r.err) && !/lively login/.test(d.r.err), dump(d));
      const e = await run5("h-admin-noprofile", { profileOk: false });
      check("⑫ ★ 내 구성원 id 를 못 읽으면 회전하지 않고 멈춘다", stopped(e) && /확인하지 못했습니다/.test(e.r.err), dump(e));

      // 비킨 이름이 **이미 내 것으로 있다** — 로그아웃(로컬 기록 삭제) 뒤 다시 로그인한 길. 새로 만들지 못하니 회전으로 잇는다.
      const g = await run5("h-admin-alt-mine", { altOwner: "jisoo" });
      check("⑫ ★ 비킨 이름이 이미 내 것이면 그 이름을 회전으로 잇는다(호스트 이름 쪽은 회전하지 않는다)",
        g.r.code === 0 && reg5.join(",") === `${SLUG},${MINE}` && rot5.join(",") === MINE
          && g.env.includes(`LIVELY_NODE_ID=${MINE}\n`) && g.env.includes(`LIVELY_NODE_TOKEN=${ROTATED}`), dump(g));

      // 비킨 이름마저 남의 것 — 그것도 회전하지 않고 멈춘다(이름을 직접 고르라고 말한다).
      const h = await run5("h-admin-alt-others", { altOwner: "someone" });
      check("⑫ ★ 비킨 이름도 남의 것이면 어느 쪽도 회전하지 않고 멈춘다", stopped(h) && /--id/.test(h.r.err), dump(h));

      // 비킨 이름 등록이 «이미 있다»(409)가 아닌 오류로 실패 — 회전으로 넘기지 않는다.
      const i = await run5("h-admin-alt-fail", { altFail: true });
      check("⑫ 비킨 이름 등록이 409 가 아닌 오류면 회전하지 않고 그 오류를 말한다", stopped(i) && reg5.join(",") === `${SLUG},${MINE}` && /노드 등록 실패/.test(i.r.err), dump(i));

      // 행 7 — 이름을 **직접 준** 관리자는 종전 그대로다(그 노드를 지목해 다시 앉히는 길). 주인도 묻지 않는다.
      const f = await run5("h-admin-explicit", {}, ["node", "--daemon", "--id", SLUG]);
      check("⑫ --id 로 지목한 관리자는 종전처럼 회전한다(주인을 묻지 않는다)", rotatedInPlace(f) && lists5.length === 0, dump(f));
    } finally { srv5.close(); }
  }
} finally {
  server.close();
  cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
