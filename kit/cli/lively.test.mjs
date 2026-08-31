#!/usr/bin/env node
// lively CLI (#864) e2e — **진짜 번들 + 픽스처 게이트웨이 + 스텁 claude** 로 login→install→status→uninstall 을 통째로 돈다.
//  실제 ~/.lively·~/.claude 는 안 건드린다(LIVELY_HOME/CLAUDE_CONFIG_DIR 샌드박스 — 설치기와 동일 계약).
//  네트워크는 127.0.0.1 픽스처뿐 — 외부 무접촉.
//  실행: node kit/cli/lively.test.mjs   (npm test 체인에 포함)
//
// ⚠ CLI 는 **반드시 비동기(execFile)** 로 띄운다. 픽스처 게이트웨이가 이 프로세스에서 도니까 execFileSync 로 막으면
//  이벤트 루프가 멈춰 자식의 fetch 가 전부 타임아웃한다 → 모든 케이스가 '조용한 무동작'이 되어
//  무동작을 기대하는 테스트가 공허하게 통과한다(#858 이 실제로 당한 함정 — 같은 실수를 반복하지 않는다).
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";  // ⚠ 절대경로 동적 import 는 반드시 file:// URL 로 — 윈도우는 "d:" 를 프로토콜로 읽는다(#1510)
import { pathWith, writeStubBin } from "../testlib/os-sandbox.mjs";   // 스텁은 윈도우에서도 실행 가능해야 한다(#1510)
import { WIN } from "../testlib/os-sandbox.mjs";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";
// CLI 런처 심의 파일명 — 윈도우는 `.cmd` 배치다(user-install.mjs 의 CLI_SHIM_CMD). 이름을 가정하면 윈도우에서 어긋난다(#1510).
const SHIM = WIN ? "lively.cmd" : "lively";

const pExecFile = promisify(execFile);

const HERE = join(fileURLToPath(import.meta.url), "..");          // kit/cli
const KIT = join(HERE, "..");                                     // kit
const REPO = join(KIT, "..");                                     // 레포 루트
const CLI = join(HERE, "lively.mjs");
const { buildKitBundle } = await import(pathToFileURL(join(KIT, "generator", "build-context.mjs")));
const { CLI_SHIM, CLI_SHIM_CMD } = await import(pathToFileURL(join(KIT, "setup", "user-install.mjs")));
// 순수함수 — 실행 경로로는 못 태우는 분기라 직접 검증한다: winArg 는 POSIX CI 에서 안 돌고(WIN=false),
//  loginEscapeToken 은 제어단말(/dev/tty)이 있어야 밟히는 분기를 담는다(#916).
const { winArg, loginEscapeToken, claudeMcpTargets, mcpCoverage, isLegacyLivelyMcp } = await import(pathToFileURL(CLI));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

const BOX = mkdtempSync(join(tmpdir(), "lively-cli-test-"));
const cleanup = () => { try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ } };

const TOKEN = "lvk_test_0123456789abcdef";
const BAD_TOKEN = "lvk_wrong";
// #916 — '스코프를 넓히려는 재로그인' 을 모델링하려면 **유효한 토큰이 둘** 있어야 한다. 옛 토큰은 회수된 게
//  아니라 스코프만 좁다 → 게이트웨이는 둘 다 받는다. (옛 토큰이 401 이면 버그가 시끄럽게 죽어서 안 숨는다 —
//  #916 이 무서운 이유가 바로 옛 토큰이 **유효한 채로** 조용히 쓰이는 것이다.)
const OLD_TOKEN = "lvk_test_old_narrow_scope";
const VALID_TOKENS = new Set([TOKEN, OLD_TOKEN]);

// ── 번들 — 게이트웨이(buildInstallBundle)가 하는 일 그대로: kit 조립 + .lively 런타임자산 + 버전 스탬프. ──
function makeBundle(version, { corrupt = false, mcpServers = [] } = {}) {
  const stage = mkdtempSync(join(BOX, "stage-"));
  buildKitBundle(stage, { orgName: "테스트조직", orgLabel: "test", harness: "claude" });
  const lv = join(stage, ".lively");
  mkdirSync(lv, { recursive: true });
  writeFileSync(join(lv, "hooks-config.json"), JSON.stringify({ hooks: {} }, null, 2));
  writeFileSync(join(lv, "mcp-servers.json"), JSON.stringify({ servers: mcpServers }, null, 2));
  writeFileSync(join(lv, "auto-approve.json"), JSON.stringify({ allow: ["mcp__lively__knowledge_get"] }, null, 2));
  writeFileSync(join(lv, "work-roots"), "# hdr\n");
  writeFileSync(join(lv, "kit-version"), version + "\n");
  if (corrupt) writeFileSync(join(stage, ".claude", "hooks", "session-preload.mjs"), "export const x = (((;\n");
  const tgz = join(BOX, `bundle-${version}.tgz`);
  execFileSync("tar", ["-czf", tgz, "-C", stage, "."], { stdio: "ignore" });
  return readFileSync(tgz);
}

// ── 픽스처 게이트웨이 ─────────────────────────────────────────────────────────
let serving = { version: "v-aaa", body: null, installHits: 0, selfUpdate: true, localMode: null, localModeStatus: 200, localModeQueries: [] };
const server = createServer((req, res) => {
  const path = (req.url || "").split("?")[0];
  const auth = String(req.headers.authorization || "");
  // /cli* 는 무인증(부트스트랩 — 토큰을 얻기 전에 실행되는 유일한 지점). 나머지는 bearer 필수.
  if (!path.startsWith("/cli")) {
    if (!VALID_TOKENS.has(auth.replace(/^Bearer /, ""))) { res.writeHead(401).end(); return; }
  }
  if (path === "/install") {
    serving.installHits++;
    res.writeHead(200, { "content-type": "application/gzip" }).end(serving.body);
  } else if (path === "/api/ui/org/runtime-config") {
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ hooks: { self_update: serving.selfUpdate }, auto_approve: [], kit_version: serving.version }));
  } else if (path === "/api/ui/me/profile") {
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ id: "tester", display_name: "테스터", email: "t@example.com" }));
  } else if (path === "/api/ui/org/preview") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ context: "# 테스트 컨텍스트\n" }));
  } else if (path === "/api/ui/me/local-mode") {
    serving.localModeQueries.push(req.url || "");
    if (serving.localModeStatus !== 200) { res.writeHead(serving.localModeStatus).end(); return; }
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* 잘못된 body 는 아래 null */ }
        serving.localMode = { mode: body.mode, updated_at: new Date().toISOString() };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ preference: serving.localMode }));
      });
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ preference: serving.localMode }));
    }
  } else if (path === "/cli/lively.mjs") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(readFileSync(CLI, "utf8"));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${server.address().port}`;

// ── 샌드박스 HOME + 스텁 claude ───────────────────────────────────────────────
// 스텁 claude 는 자기 argv 를 로그에 적는다 → CLI 가 **정확히 어떤 인자로** MCP 를 등록하는지 검증한다.
//  (이 CLI 의 존재 이유가 MCP 재등록이므로, 여기서 인자가 틀리면 프로젝트 전체가 무의미하다.)
function newHome(name) {
  const home = join(BOX, name);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const bin = join(home, "stub-bin");
  mkdirSync(bin, { recursive: true });
  const log = join(home, "claude-argv.log");
  // 스텁 본문은 JS 한 벌 — sh 로 쓰면 윈도우에서 실행조차 안 돼 가로채기가 조용히 실패한다(#1510).
  writeStubBin(bin, "claude", [
    'import { appendFileSync, readFileSync } from "node:fs";',
    `const LOG = ${JSON.stringify(log)};`,
    "const a = process.argv.slice(2);",
    'appendFileSync(LOG, a.join(" ") + "\\n");',
    // #1593 — 받은 HOME 을 따로 남긴다. **등록 대상 파일을 고르는 건 argv 가 아니라 이 값**이라,
    //  샌드박스가 라이브 홈을 건드리는지는 오직 이걸로만 판별된다(⑰-c 가 이 로그를 본다).
    'appendFileSync(LOG + ".home", (process.env.HOME || process.env.USERPROFILE || "") + "\\n");',
    // #1541 — **어느 config dir 을 겨냥했나**. 등록 위치는 argv 가 아니라 이 env 가 정한다(claude --scope user 규약).
    //  '기본 위치' 겨냥은 이 변수가 **없어야** 한다 — 빈 문자열이면 claude 가 '설정됨' 으로 읽는다.
    'appendFileSync(LOG + ".ccd", (Object.prototype.hasOwnProperty.call(process.env, "CLAUDE_CONFIG_DIR") ? "[" + process.env.CLAUDE_CONFIG_DIR + "]" : "(unset)") + "\\n");',
    'const logged = (re) => { try { return re.test(readFileSync(LOG, "utf8")); } catch { return false; } };',
    // `claude mcp list` 는 등록된 걸 되돌려준다(구 status 판정 경로 — 남겨둔다).
    'if (a[0] === "mcp" && a[1] === "list") {',
    `  if (logged(/mcp add .*lively /)) console.log(${JSON.stringify(`lively: ${GW}/mcp (HTTP)`)});`,
    "  process.exit(0);",
    "}",
    // `claude mcp get <name>` — #1431 부터 status/doctor 가 **이걸** 쓴다(우리 서버 하나만 헬스체크).
    //  실물 형식을 그대로 흉내낸다: 등록됐으면 Scope:/Status: 두 줄, 아니면 rc=1 + "No MCP server named".
    'if (a[0] === "mcp" && a[1] === "get") {',
    '  if (logged(new RegExp("mcp add .*" + a[2] + " "))) {',
    '    console.log("Scope: User config (available in all your projects)");',
    '    console.log("Status: ✔ Connected");',
    "    process.exit(0);",
    "  }",
    '  console.error(`No MCP server named "${a[2]}".`);',
    "  process.exit(1);",
    "}",
    "process.exit(0);",
  ].join("\n"));
  return {
    home, bin, log,
    argv: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []),
    homes: () => (existsSync(log + ".home") ? readFileSync(log + ".home", "utf8").trim().split("\n").filter(Boolean) : []),
    ccds: () => (existsSync(log + ".ccd") ? readFileSync(log + ".ccd", "utf8").trim().split("\n").filter(Boolean) : []),
  };
}

// CLI 실행 — 샌드박스 HOME + 스텁 PATH. 절대 실기기·실게이트웨이에 닿지 않는다.
//  ⚠ HOME 과 LIVELY_HOME 을 **둘 다** 준다: 설치기는 LIVELY_HOME 을, 셸 rc 탐색은 HOME 을 본다(#858 함정③).
//  ⚠ 셸의 LIVELY_TOKEN/LIVELY_GATEWAY_URL 은 파일보다 우선하므로 명시적으로 비운다(그렇지 않으면 테스트가 무의미해진다).
async function lively(h, args, { env = {}, expectFail = false } = {}) {
  try {
    const r = await pExecFile(process.execPath, [CLI, ...args], {
      env: {
        ...process.env, ...offlineLivelyEnv(),
        HOME: h.home,
        LIVELY_HOME: h.home,
        CLAUDE_CONFIG_DIR: join(h.home, ".claude"),
        PATH: pathWith(h.bin),
        LIVELY_TOKEN: "",
        LIVELY_GATEWAY_URL: "",
        ...env,
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
  serving.body = makeBundle("v-aaa");

  // ① 로그인 — 틀린 토큰은 거부한다(아무 문자열이나 받아 두고 나중에 401 로 터지게 하지 않는다).
  {
    const h = newHome("h-badlogin");
    const r = await lively(h, ["login", "--gateway", GW, "--token", BAD_TOKEN], { expectFail: true });
    const saved = existsSync(join(h.home, ".lively", "token"));
    check("① 잘못된 토큰 거부 + 저장 안 함", r.code !== 0 && !saved, `code=${r.code} saved=${saved}`);
  }

  // ② 로그인 성공 — 토큰 0600 + gateway-url 은 /mcp 없이 저장(user-install.mjs 와 같은 계약).
  const H = newHome("h-main");
  {
    const r = await lively(H, ["login", "--gateway", `${GW}/mcp`, "--token", TOKEN]);
    const tp = join(H.home, ".lively", "token");
    // 윈도우엔 POSIX mode 비트가 없다(NTFS ACL) — node 는 0666 만 보고한다. 그 계약은 여기서 성립하지 않는다.
    const mode = WIN ? "600" : (statSync(tp).mode & 0o777).toString(8);
    const gw = readFileSync(join(H.home, ".lively", "gateway-url"), "utf8").trim();
    check("② 로그인 성공 · 토큰 0600 · gateway-url 정규화(/mcp 제거)",
      readFileSync(tp, "utf8") === TOKEN && mode === "600" && gw === GW,
      `mode=${mode} gw=${gw}`);
    check("② 로그인 출력에 신원 표시", r.err.includes("테스터"), r.err.slice(0, 200));
  }

  // ③ 설치 — 다운로드 → 검증 → user-install → MCP 등록 → 키트 버전 스탬프.
  {
    const r = await lively(H, ["install"]);
    const lv = join(H.home, ".lively");
    const stamped = readFileSync(join(lv, "kit-version"), "utf8").trim();
    const hooks = existsSync(join(lv, "hooks", "session-preload.mjs"));
    const cli = existsSync(join(lv, "lib", "lively.mjs"));
    const shim = existsSync(join(lv, "bin", SHIM));
    check("③ 설치 — 훅 · CLI · 심 · 버전 스탬프",
      stamped === "v-aaa" && hooks && cli && shim,
      `stamp=${stamped} hooks=${hooks} cli=${cli} shim=${shim}\n${r.err.slice(-400)}`);
  }

  // ④ **MCP 등록 인자** — 이 CLI(registerClaudeMcp)와 register-clients.sh(scripts/ 소스 + kit/setup/ 트윈)는
  //  **동일한 헤더 세트**여야 한다. register-clients.sh 는 죽은 코드가 아니라 fresh 설치·멤버 온보딩의 주 경로다
  //  (deploy/install-kit.sh·provision-member.sh 가 직접 호출) — 어느 한쪽만 헤더를 더하면 그 경로로 깐 세션은
  //  헤더가 빠져 기능이 조용히 죽는다(#1007 리뷰). 그래서 아래 두 축으로 못박는다: (a) 이 CLI argv 를 리터럴로,
  //  (b) register-clients.sh 파일이 실제로 같은 3헤더를 등록하는지(드리프트 가드 — 안전망이 CLI 만 보지 않게).
  {
    const adds = H.argv().filter((l) => l.startsWith("mcp add"));
    // (a) #1079 — lively 는 **stdio 프록시**로 등록한다(http 직결은 VPN 미접속 세션에서 그 세션 내내 죽는다).
    //  종전 3헤더(토큰·세션귀속#852·실행모드#1007+)는 사라진 게 아니라 **프록시가 상류 호출에 붙인다** —
    //  그 계약은 lively-mcp-gateway.test.mjs(E11 파일토큰 우선 · E15 하네스 stamp)가 못박는다.
    const shimPath = join(H.home, ".lively", "bin", SHIM);
    const want = `mcp add --transport stdio --scope user lively ${shimPath} mcp`;
    check("④ claude MCP 등록 argv 못박기(#1079 — lively = stdio 프록시)",
      adds.some((l) => l === want), `got=${JSON.stringify(adds)}\nwant=${JSON.stringify(want)}`);
    check("④ 설정에 평문 토큰이 실리지 않는다(#1079 — 신원은 런타임 토큰파일)",
      !adds.some((l) => l.includes("Bearer")), `got=${JSON.stringify(adds)}`);
    // (b) register-clients.sh parity — fresh 설치·멤버 온보딩의 주 경로다(deploy/install-kit.sh·provision-member.sh 가
    //  직접 호출). 여기가 CLI 와 다른 transport 로 등록하면 **그 경로로 깐 첫 세션은 여전히 http** 라 #1079 가 그대로 남는다.
    //  두 트윈(scripts/ 소스 · kit/setup/) 모두 본다 — 한쪽만 고치는 드리프트가 실제로 있었다.
    for (const rel of [["scripts", "register-clients.sh"], ["kit", "setup", "register-clients.sh"]]) {
      const p = join(REPO, ...rel);
      const sh = readFileSync(p, "utf8");
      check(`④ ${rel.join("/")} 가 CLI 와 같은 transport 로 lively 등록(parity)`,
        /--transport +stdio +--scope +user +"?\$\{?MCP_LABEL/.test(sh) || /lively["']? +mcp\b/.test(sh),
        `${rel.join("/")} 가 아직 http 직결로 lively 를 등록한다 — 이 경로로 깐 첫 세션은 #1079 를 그대로 겪는다(CLI·self-update 와 drift)`);
    }
    // (c) self-update.mjs — 기존 멤버를 재설치 없이 옮기는 4번째 동기화 지점. stdio 마이그레이션과,
    //  롤백 시 살아나는 종전 헤더 계약을 **둘 다** 알고 있어야 한다.
    const selfUp = readFileSync(join(REPO, "kit", "hooks", "self-update.mjs"), "utf8");
    check("④ self-update.mjs 가 stdio 마이그레이션 + 롤백용 헤더 계약을 모두 안다(parity)",
      /args:\s*\["mcp"\]/.test(selfUp)
        && selfUp.includes('"x-lively-session": "${LIVELY_SESSION_ID:-}"')
        && selfUp.includes('"x-lively-mode": "${LIVELY_MODE:-}"'),
      "self-update.mjs 가 stdio 마이그레이션 또는 헤더 계약 중 하나를 모른다(drift)");
    check("④ remove → add 순서(재실행 안전)",
      H.argv().indexOf("mcp remove lively") < H.argv().findIndex((l) => l.startsWith("mcp add")),
      JSON.stringify(H.argv()));
  }

  // ⑤ status — 최신이면 최신이라고, 구버전이면 업데이트 있다고 말한다(--json 계약).
  {
    const r = await lively(H, ["status", "--json"]);
    const st = JSON.parse(r.out);
    check("⑤ status: 인증 · 최신 · MCP 등록 감지",
      st.account.authenticated && st.kit.current && st.kit.local === "v-aaa" && st.harness.claude.mcp,
      JSON.stringify(st, null, 2).slice(0, 500));
    // #1431 — 등록과 별개로 **연결 상태**도 값으로 담는다(스텁이 `mcp get` 에 Status: ✔ 를 준다).
    check("⑤ status: MCP 연결 상태도 값으로 담는다(mcp get 의 Status 반영)",
      st.harness.claude.mcpConnected === true, JSON.stringify(st.harness, null, 2));
    check("⑤ status --json 은 stdout, 사람 출력은 stderr(파이프 안전)",
      r.out.trim().startsWith("{"), r.out.slice(0, 80));
  }

  // ⑥ update --check — 서버가 새 버전을 알리면 '업데이트 있음'. 설치는 하지 않는다.
  {
    serving.version = "v-bbb";
    const before = serving.installHits;
    const r = await lively(H, ["update", "--check"]);
    check("⑥ update --check: 새 버전 감지 + 다운로드 안 함",
      r.err.includes("v-bbb") && serving.installHits === before, `hits=${serving.installHits - before} err=${r.err.slice(0, 200)}`);
  }

  // ⑦ **손상 번들 거부** — 깨진 번들로 ~/.lively/hooks 를 덮으면 그 멤버의 모든 세션에서 훅이 죽는다.
  //     여기가 마지막 방어선이므로: 설치 실패 + **기존 설치 보존**을 둘 다 확인한다.
  {
    serving.body = makeBundle("v-bad", { corrupt: true });
    serving.version = "v-bad";
    const goodBefore = readFileSync(join(H.home, ".lively", "hooks", "session-preload.mjs"), "utf8");
    const r = await lively(H, ["update"], { expectFail: true });
    const goodAfter = readFileSync(join(H.home, ".lively", "hooks", "session-preload.mjs"), "utf8");
    const stamp = readFileSync(join(H.home, ".lively", "kit-version"), "utf8").trim();
    check("⑦ 손상 번들 거부 — 설치 실패 + 기존 훅·스탬프 보존",
      r.code !== 0 && goodAfter === goodBefore && stamp === "v-aaa",
      `code=${r.code} preserved=${goodAfter === goodBefore} stamp=${stamp}`);
    check("⑦ 손상 사유를 사람에게 말한다", /번들 손상/.test(r.err), r.err.slice(-200));
  }

  // ⑧ 조직 추가 MCP 서버 — mcp-servers.json 을 순회 등록(register-clients.sh 와 동일 동작).
  {
    serving.body = makeBundle("v-ccc", { mcpServers: [{ name: "notion", transport: "http", url: "https://n.example/mcp", enabled: true }] });
    serving.version = "v-ccc";
    const h = newHome("h-mcp");
    await lively(h, ["login", "--gateway", GW, "--token", TOKEN]);
    await lively(h, ["install"]);
    const adds = h.argv().filter((l) => l.startsWith("mcp add"));
    check("⑧ 조직 추가 MCP 서버도 등록 — 자동 업데이트가 못 하는 바로 그 일",
      adds.some((l) => l === "mcp add --transport http --scope user notion https://n.example/mcp"),
      JSON.stringify(adds));
  }

  // ⑨ **토큰 비유출** — 어떤 출력에도 토큰이 찍히면 안 된다(화면공유·CI 로그에 그대로 남는다).
  {
    const r1 = await lively(H, ["status"]);
    const r2 = await lively(H, ["doctor"], { expectFail: true }); // 손상 상태라 exit 1 일 수 있음 — 출력만 본다
    const leaked = [r1.out, r1.err, r2.out, r2.err].some((s) => s.includes(TOKEN));
    check("⑨ 토큰이 status·doctor 출력 어디에도 안 찍힌다", !leaked, "토큰 유출!");
  }

  // ⑩ uninstall --dry-run — 미리보기는 아무것도 지우지 않는다.
  {
    const h = newHome("h-dry");
    await lively(h, ["login", "--gateway", GW, "--token", TOKEN]);
    await lively(h, ["install"]);
    const before = existsSync(join(h.home, ".lively", "hooks", "session-preload.mjs"));
    await lively(h, ["uninstall", "--dry-run", "--yes"]);
    const after = existsSync(join(h.home, ".lively", "hooks", "session-preload.mjs"));
    check("⑩ uninstall --dry-run 은 아무것도 안 지운다", before && after, `before=${before} after=${after}`);
  }

  // ⑪ **심(shim) 동일성** — bootstrap.sh 가 만드는 심과 user-install.mjs 가 만드는 심이 바이트 동일해야 한다.
  //     (둘이 갈라지면 "부트스트랩으로 깔았을 때"와 "자동 업데이트로 깔렸을 때"의 lively 가 달라진다.)
  {
    const boot = readFileSync(join(HERE, "bootstrap.sh"), "utf8");
    const m = boot.match(/cat > "\$LIVELY_DIR\/bin\/lively" <<'SHIM'\n([\s\S]*?)\nSHIM\n/);
    check("⑪ 심 동일성 — bootstrap.sh == user-install.mjs (드리프트 방지)",
      !!m && m[1] + "\n" === CLI_SHIM, m ? "내용 불일치" : "bootstrap.sh 에서 심을 못 찾음");
  }

  // ⑪-win **Windows 심 동일성** — bootstrap.ps1 이 쓰는 .cmd 와 user-install.mjs 의 CLI_SHIM_CMD 가 바이트 동일해야 한다.
  //     POSIX CI 에선 PowerShell 을 못 돌리므로 **정적 비교**로 고정한다(스크립트가 하는 변환을 그대로 재현).
  //     줄바꿈까지 본다 — cmd.exe 의 여러 줄 `for /f … do ( … )` 는 LF-only 파일에서 동작이 들쭉날쭉하다.
  {
    const ps1 = readFileSync(join(HERE, "bootstrap.ps1"), "utf8");
    const m = ps1.match(/\$shim = @'\r?\n([\s\S]*?)\r?\n'@\r?\n/);
    // bootstrap.ps1 의 변환: LF 정규화 → CRLF → 말미 CRLF 추가.
    const asWritten = m ? m[1].replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") + "\r\n" : null;
    check("⑪ 심 동일성(Windows) — bootstrap.ps1 == user-install.mjs (CRLF 포함)",
      asWritten === CLI_SHIM_CMD,
      m ? `bytes ps1=${asWritten?.length} installer=${CLI_SHIM_CMD.length}` : "bootstrap.ps1 에서 심을 못 찾음");
    check("⑪ Windows 심은 CRLF", CLI_SHIM_CMD.includes("\r\n") && !/[^\r]\n/.test(CLI_SHIM_CMD), "LF 가 섞였다");
  }

  // ⑪-arg **winArg** — Node 는 shell:true 에서 인자를 자동 quote 하지 않는다. 이 함수가 틀리면
  //     `--header "Authorization: Bearer <tok>"` 가 cmd.exe 에서 공백에서 두 토막 나 MCP 등록이 조용히 깨진다.
  //     POSIX CI 에선 이 코드가 한 번도 실행되지 않으므로(WIN=false) 순수함수로 직접 못박는다.
  {
    const cases = [
      ["lively", "lively"],                                        // 평범한 토큰은 그대로
      ["--transport", "--transport"],
      ["http://h:8080/mcp", "http://h:8080/mcp"],                   // : / 는 quote 불요
      ["Authorization: Bearer lvk_abc", '"Authorization: Bearer lvk_abc"'], // ← 공백: 이게 핵심(안 하면 두 토막)
      ["a&b", '"a&b"'], ["a|b", '"a|b"'], ["a>b", '"a>b"'], ["a%b", '"a%b"'],
      ['say "hi"', '"say \\"hi\\""'],                               // 내부 " 이스케이프
      // 말미 백슬래시: **인용할 때만** 배증한다. CommandLineToArgvW 는 백슬래시를 `"` 앞에서만 특별 취급하므로
      //  인용이 불필요한 `C:\path\` 는 그대로 두는 게 맞다 — 괜히 인용하면 `"C:\path\"` 가 되어 닫는 따옴표가 먹힌다.
      ["C:\\path\\", "C:\\path\\"],                                 // quote 불요 → 원형 보존(과잉 인용 금지)
      ["C:\\my path\\", '"C:\\my path\\\\"'],                       // 공백 → 인용 → 말미 백슬래시 배증
      ['x\\"y', '"x\\\\\\"y"'],                                     // " 앞 백슬래시 배증 + 이스케이프
    ];
    const bad = cases.filter(([inp, want]) => winArg(inp) !== want)
      .map(([inp, want]) => `${JSON.stringify(inp)} → ${JSON.stringify(winArg(inp))} (want ${JSON.stringify(want)})`);
    check("⑪ winArg — Windows 인자 quoting(공백·메타문자·백슬래시)", bad.length === 0, bad.join("\n      "));
  }

  // ⑫ **웹 설치 명령에 토큰이 없다** — 이번 프로젝트의 보안 핵심. 누가 다시 토큰을 구우면 여기서 막는다.
  {
    // installCmd 는 #1313 R37 에서 web/admin.ts → web/admin-install.ts 로 옮겼다(코드는 verbatim, 위치만 이동).
    const admin = readFileSync(join(REPO, "web", "admin-install.ts"), "utf8");
    const m = admin.match(/function installCmd\(([^)]*)\)\s*\{([\s\S]*?)\n\}/);
    const params = m ? m[1] : "";
    const body = m ? m[2] : "";
    check("⑫ installCmd 시그니처에 token 파라미터 없음", !!m && !/token/i.test(params), `params=(${params})`);
    check("⑫ installCmd 본문에 Bearer·토큰 보간 없음",
      !!m && !/Bearer|token/i.test(body), body.slice(0, 200));
    check("⑫ 설치 명령은 토큰리스 부트스트랩", /\/cli/.test(body) && /curl|irm/.test(body), body.slice(0, 200));
  }

  // ⑬ **번들 결정성** — CLI 를 번들에 넣어도 kit_version 지문이 흔들리면 안 된다.
  //     (흔들리면 전 멤버가 매 세션 재설치를 돈다 — #858 함정①.)
  {
    const a = mkdtempSync(join(BOX, "det-a-")), b = mkdtempSync(join(BOX, "det-b-"));
    buildKitBundle(a, { orgName: "테스트조직", orgLabel: "test", harness: "claude" });
    buildKitBundle(b, { orgName: "테스트조직", orgLabel: "test", harness: "claude" });
    const ca = readFileSync(join(a, "cli", "lively.mjs"), "utf8");
    const cb = readFileSync(join(b, "cli", "lively.mjs"), "utf8");
    check("⑬ 번들 결정성 — cli/lively.mjs 가 매번 같은 바이트", ca === cb, "다름(경로·시각이 구워졌나?)");
    check("⑬ 번들에 cli/lively.mjs 동봉 — 자동 업데이트가 CLI 를 배달한다", ca.length > 1000, `len=${ca.length}`);
  }

  // ⑭ PATH rc 블록 멱등 — 재설치해도 늘지 않는다(구표기 누적으로 훅이 두 벌 되던 사고의 rc 판).
  //  ⚠ 윈도우엔 셸 rc 개념이 없다 — wireCliPath 는 사용자 PATH 환경변수를 직접 손댄다(레지스트리/setx).
  //   그건 샌드박스 홈으로 격리할 수 없으므로(실기기 오염) 여기서 검증하지 않는다(#1510).
  if (WIN) console.log("skip ⑭ PATH rc 블록 — 윈도우는 셸 rc 가 아니라 사용자 PATH 환경변수를 쓴다");
  else {
    const h = newHome("h-rc");
    writeFileSync(join(h.home, ".zshrc"), "# 내 설정\nalias ll='ls -la'\n");
    await lively(h, ["login", "--gateway", GW, "--token", TOKEN]);
    await lively(h, ["install"]);
    await lively(h, ["install"]);
    const rc = readFileSync(join(h.home, ".zshrc"), "utf8");
    const n = (rc.match(/lively-managed \(PATH: cli\) >>>/g) || []).length;
    check("⑭ PATH rc 블록 멱등 — 재설치해도 1개", n === 1 && rc.includes("alias ll"), `blocks=${n}`);
  }

  // ⑯ **부트스트랩 e2e** — 웹이 건네는 그 한 줄(`curl … | sh`)을 진짜로 돌린다.
  //     이걸 안 돌리면 부트스트랩 스크립트는 아무도 실행하지 않는 코드가 된다. 실제로 그래서 버그가 하나 샜다:
  //     CLI 를 `lively.mjs.new` 로 받았더니 `node --check` 가 **확장자로 모듈 종류를 판정**해 CommonJS 로 파싱했고,
  //     최상위 import 가 SyntaxError → 멀쩡한 CLI 를 '손상'으로 거부했다. 그 회귀를 여기서 못박는다.
  {
    const h = newHome("h-boot");
    const boot = join(BOX, "bootstrap.sh");
    // 게이트웨이가 서빙하듯 주소를 굽는다(src/web.ts 의 serveBootstrap 과 동일 치환).
    writeFileSync(boot, readFileSync(join(HERE, "bootstrap.sh"), "utf8").replaceAll("__LIVELY_GATEWAY__", GW));
    const r = await pExecFile("sh", [boot], {
      env: { ...process.env, ...offlineLivelyEnv(), HOME: h.home, LIVELY_HOME: h.home, PATH: pathWith(h.bin) },
      timeout: 60000,
    }).catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message), failed: true }));

    const cli = join(h.home, ".lively", "lib", "lively.mjs");
    const shim = join(h.home, ".lively", "bin", "lively");
    const gwFile = existsSync(join(h.home, ".lively", "gateway-url"))
      ? readFileSync(join(h.home, ".lively", "gateway-url"), "utf8").trim() : "";
    check("⑯ 부트스트랩 — CLI · 심 · 게이트웨이 기록",
      !r.failed && existsSync(cli) && existsSync(shim) && gwFile === GW,
      `failed=${!!r.failed} cli=${existsSync(cli)} shim=${existsSync(shim)} gw=${gwFile}\n${r.stderr.slice(-300)}`);
    // 받은 CLI 가 정말 실행 가능한 ESM 인가(위 버그의 핵심 — 파일이 있어도 깨졌으면 소용없다).
    check("⑯ 내려받은 CLI 가 실행 가능(ESM 구문 온전)",
      existsSync(cli) && execFileSync(process.execPath, ["--check", cli], { stdio: "pipe" }) !== null, "구문 오류");
    // 부트스트랩은 **토큰을 만들지 않는다** — 이번 프로젝트의 보안 핵심(설치 한 줄에 비밀 없음).
    check("⑯ 부트스트랩은 토큰을 만들지 않는다", !existsSync(join(h.home, ".lively", "token")), "토큰 파일이 생겼다");
    // 비대화형이면 다음 할 일을 알려준다(CI·원격 스크립트 — TTY 가 없으면 setup 인계 대신 안내).
    check("⑯ 비대화형 — 다음 단계 안내", /lively login/.test(r.stderr), r.stderr.slice(-200));
  }

  // ⑮ run — 인자를 work.mjs 로 **원형** 전달(--harness 등이 CLI 옵션과 겹쳐도 삼키지 않는다).
  {
    const work = join(H.home, ".lively", "work.mjs");
    writeFileSync(work, "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n");
    chmodSync(work, 0o755);
    const r = await lively(H, ["run", "864", "--harness", "codex", "--auto-approve", "--repos", "eyJhIjoxfQ=="]);
    check("⑮ run — 인자 원형 전달(--harness 를 CLI 가 가로채지 않는다)",
      r.out.trim() === JSON.stringify(["864", "--harness", "codex", "--auto-approve", "--repos", "eyJhIjoxfQ=="]),
      r.out.trim());
  }
  // ⑮ run — 프로젝트# **없으면 하네스 바로 실행**(#1007+, 사용자 요청) + 모드 플래그가 세션 env 주입. --harness 로 하네스 지정.
  {
    // 하네스는 **PATH 에서 이름으로** 찾게 한다 — 윈도우의 has() 는 `where <이름>` 이라 절대경로를 못 받고,
    //  스폰도 .cmd 셰임을 PATHEXT 로 해석해야 한다(#1510). 그래서 스텁 bin 에 심고 이름만 넘긴다.
    const fakeH = "fake-harness";
    writeStubBin(H.bin, "fake-harness",
      "process.stdout.write('HARNESS['+process.argv.slice(2).join(',')+'] MODE='+(process.env.LIVELY_MODE||'')+' RO='+(process.env.LIVELY_READONLY||'')+' INC='+(process.env.LIVELY_INCOGNITO||'')+' OFF='+(process.env.LIVELY_OFF||''));");
    const r = await lively(H, ["run", "--readonly", "--harness", fakeH, "hello"]);
    check("⑮ run — 프로젝트# 없으면 하네스 직접 실행 + 모드 플래그는 인자에서 소비(하네스엔 hello 만)",
      r.out.includes("HARNESS[hello]") && r.out.includes("MODE=readonly") && r.out.includes("RO=1"), r.out.trim());
    const r2 = await lively(H, ["run", "--incognito", "--harness", fakeH]);
    check("⑮ run --incognito → LIVELY_MODE=incognito + 전이기 INC=1 + LIVELY_OFF=1 세션 env 주입",
      r2.out.includes("MODE=incognito") && r2.out.includes("INC=1") && r2.out.includes("OFF=1"), r2.out.trim());
  }
  // ⑮-b 웹의 컴퓨터별 기본 연결 상태 → 다음 lively run preflight 에서 반영(#1869).
  //  각 행은 /private/tmp/lively-1869-spec.md 의 입력 조합 한 행과 대응한다. 하네스 스텁의 env 가 부작용 관측점.
  {
    const modeRun = async (name, { local = "normal", remote = null, flag = null, status = 200, machine = true } = {}) => {
      const h = newHome("mode-" + name);
      const lv = join(h.home, ".lively"); mkdirSync(lv, { recursive: true });
      writeFileSync(join(lv, "gateway-url"), GW + "\n"); writeFileSync(join(lv, "token"), TOKEN + "\n");
      writeFileSync(join(lv, "mode"), local + "\n");
      if (machine) writeFileSync(join(lv, "machine-id"), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n");
      writeStubBin(h.bin, "fake-mode-harness",
        "process.stdout.write('MODE='+(process.env.LIVELY_MODE||'normal')+' OFF='+(process.env.LIVELY_OFF||''));");
      serving.localMode = remote == null ? null : { mode: remote, updated_at: new Date().toISOString() };
      serving.localModeStatus = status; serving.localModeQueries = [];
      const args = ["run", ...(flag ? [flag] : []), "--harness", "fake-mode-harness"];
      const result = await lively(h, args);
      return { h, out: result.out, saved: readFileSync(join(lv, "mode"), "utf8").trim(), queries: [...serving.localModeQueries] };
    };
    const r1 = await modeRun("remote-readonly", { remote: "readonly" });
    check("⑮-b1 웹 기본값 readonly → readonly 실행", r1.out.includes("MODE=readonly"), r1.out);
    const r2 = await modeRun("reactivate", { local: "incognito", remote: "normal" });
    check("⑮-b2 로컬 incognito 여도 웹에서 normal 로 다시 켬", r2.out.includes("MODE=normal") && !r2.out.includes("OFF=1") && r2.saved === "normal", r2.out);
    const r3 = await modeRun("explicit", { remote: "incognito", flag: "--normal" });
    check("⑮-b3 이번 실행 --normal 은 웹 incognito 보다 우선", r3.out.includes("MODE=normal") && !r3.out.includes("OFF=1"), r3.out);
    const r4 = await modeRun("absent", { local: "readonly", remote: null });
    check("⑮-b4 웹 명시값 부재 → 로컬 readonly 유지", r4.out.includes("MODE=readonly") && r4.saved === "readonly", r4.out);
    const r5 = await modeRun("offline", { local: "incognito", remote: "normal", status: 500 });
    check("⑮-b5 서버 미도달 → 로컬 incognito 유지", r5.out.includes("MODE=incognito") && r5.out.includes("OFF=1") && r5.saved === "incognito", r5.out);
    const r6 = await modeRun("invalid", { local: "normal", remote: "mystery" });
    check("⑮-b6 웹 잡값 → 로컬 normal 유지", r6.out.includes("MODE=normal") && r6.saved === "normal", r6.out);
    const r7 = await modeRun("new-machine", { remote: "readonly", machine: false });
    check("⑮-b7 machine-id 최초 부재 → 생성 후 웹 기본값 적용", r7.out.includes("MODE=readonly")
      && existsSync(join(r7.h.home, ".lively", "machine-id")) && r7.queries.some((q) => q.includes("machine_id=")), r7.out);
    const r8 = await modeRun("normal-boundary", { local: "readonly", remote: "normal" });
    check("⑮-b8 웹 normal 경계값도 유효", r8.out.includes("MODE=normal") && r8.saved === "normal", r8.out);
    const r9 = await modeRun("explicit-incognito", { remote: "readonly", flag: "--incognito" });
    check("⑮-b9 이번 실행 --incognito 는 서버 기본값 조회도 하지 않음", r9.out.includes("MODE=incognito")
      && r9.out.includes("OFF=1") && r9.queries.length === 0, `queries=${JSON.stringify(r9.queries)} ${r9.out}`);
    serving.localMode = null; serving.localModeStatus = 200; serving.localModeQueries = [];
  }
  {
    const r = await lively(H, ["run", "--harness", "definitely-not-real-xyz-123"], { expectFail: true });
    check("⑮ run — 없는 하네스면 usage(exit 2)", r.code === 2, `code=${r.code}`);
  }

  // ⑰ backupUserMcp — 비파괴 라운드트립의 설치측 절반: 유저가 라이블리 전부터 쓰던 org-겹침 MCP 를
  //   덮어쓰기 전 스냅샷(유저 원본) + **최초 1회**(재설치가 이미 덮어쓴 라이블리 값으로 백업 오염 안 함).
  //   서브프로세스 — LIVELY_HOME 샌드박스를 import 전에 걸어야 lively.mjs 의 HOME 상수가 박스로 굳는다(실기기 무접촉). claude 불요.
  {
    const box = mkdtempSync(join(tmpdir(), "lively-bak-"));
    mkdirSync(join(box, ".lively"), { recursive: true });
    writeFileSync(join(box, ".claude.json"), JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://user.example/mcp" } } }));
    const probe = join(box, "probe.mjs");
    writeFileSync(probe, [
      `import { backupUserMcp } from ${JSON.stringify(pathToFileURL(CLI).href)};`,   // 절대경로 그대로면 윈도우에서 죽는다(#1510)
      `import { writeFileSync as w } from "node:fs";`,
      `backupUserMcp("linear"); backupUserMcp("notion");`,                                    // linear=유저것, notion=부재(null)
      `w(${JSON.stringify(join(box, ".claude.json"))}, JSON.stringify({mcpServers:{linear:{type:"http",url:"https://org.example/mcp"}}}));`, // 라이블리가 덮어쓴 상태 모사
      `backupUserMcp("linear");`,                                                             // 재호출 — 최초1회면 유저 원본 유지
    ].join("\n"));
    // ⚠ CLAUDE_CONFIG_DIR 를 명시적으로 비운다 — 안 그러면 개발자 셸의 값이 새어들어 엉뚱한 파일을 보게 된다.
    execFileSync(process.execPath, [probe], { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: box, CLAUDE_CONFIG_DIR: "" }, stdio: "ignore" });
    let bak = {}; try { bak = JSON.parse(readFileSync(join(box, ".lively", "mcp-user-backup.json"), "utf8")); } catch { /* */ }
    check("⑰ backupUserMcp — 유저 원본 스냅샷 + 부재는 null + 최초1회(재설치 오염 방지)",
      !!(bak.linear && bak.linear.url === "https://user.example/mcp") && bak.notion === null, JSON.stringify(bak));
    rmSync(box, { recursive: true, force: true });
  }

  // ⑰-b **프로필 격리(#346)에서 백업이 올바른 .claude.json 을 본다** — claude 는 `--scope user` 를
  //   CLAUDE_CONFIG_DIR 밑에 쓴다(deploy/provision-profile.sh:37). $HOME 고정으로 읽으면 유저 원본을 못 보고
  //   null 로 굳어 uninstall 이 유저의 linear 를 **자격증명째 지운다**(#744 갭 재발). 함정: $HOME 쪽에도 파일이
  //   있는데 **다른 내용**이면 어느 쪽을 읽는지가 드러난다 → 두 파일을 다르게 둬서 못박는다.
  {
    const box = mkdtempSync(join(tmpdir(), "lively-bak-profile-"));
    const prof = join(box, "profile-claude");
    mkdirSync(join(box, ".lively"), { recursive: true });
    mkdirSync(prof, { recursive: true });
    // $HOME 쪽 — claude 가 **안 읽는** 파일(프로필 격리 시). 여기엔 linear 가 없다.
    writeFileSync(join(box, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    // CLAUDE_CONFIG_DIR 쪽 — claude 가 **실제로 읽고 쓰는** 파일. 유저의 linear 가 여기 있다.
    writeFileSync(join(prof, ".claude.json"), JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://user-profile.example/mcp" } } }));
    const probe = join(box, "probe.mjs");
    writeFileSync(probe, [
      `import { backupUserMcp } from ${JSON.stringify(pathToFileURL(CLI).href)};`,   // 절대경로 그대로면 윈도우에서 죽는다(#1510)
      `backupUserMcp("linear");`,
    ].join("\n"));
    execFileSync(process.execPath, [probe], { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: box, CLAUDE_CONFIG_DIR: prof }, stdio: "ignore" });
    let bak = {}; try { bak = JSON.parse(readFileSync(join(box, ".lively", "mcp-user-backup.json"), "utf8")); } catch { /* */ }
    check("⑰-b backupUserMcp — 프로필 격리(#346)에서 CLAUDE_CONFIG_DIR 의 .claude.json 을 본다",
      !!(bak.linear && bak.linear.url === "https://user-profile.example/mcp"), JSON.stringify(bak));
    rmSync(box, { recursive: true, force: true });
  }

  // ⑰-d ★ **#1541 — 프로필 dir 까지 등록한다.** 웹터미널 세션은 CLAUDE_CONFIG_DIR=<프로필> 로 뜨는데
  //   키트가 기본 위치에만 등록해서, 노드 웹세션엔 lively MCP 가 **영원히 안 보였다**(실기기 확인).
  //   판정은 argv 가 아니라 **스텁 claude 가 받은 CLAUDE_CONFIG_DIR** 로 한다 — 등록 파일을 고르는 게 그 값이다.
  //   ⚠ '기본 위치' 겨냥은 그 변수가 **없어야** 한다(빈 문자열이면 claude 가 '설정됨' 으로 읽는다).
  {
    const h = newHome("mcp-profile-fanout");
    const prof = join(h.home, ".lively", "profiles", "yoon", "claude");
    mkdirSync(prof, { recursive: true });
    mkdirSync(join(h.home, ".lively", "profiles", "ghost"), { recursive: true });   // claude dir 없음 → 대상 제외
    writeFileSync(join(h.home, ".lively", "mcp-servers.json"), JSON.stringify({ servers: [] }));
    const probe = join(h.home, "probe-1541.mjs");
    writeFileSync(probe, [
      `import { registerClaudeMcp } from ${JSON.stringify(pathToFileURL(CLI).href)};`,
      "registerClaudeMcp();",
    ].join("\n"));
    execFileSync(process.execPath, [probe], {
      env: {
        ...process.env, ...offlineLivelyEnv(), HOME: h.home, USERPROFILE: h.home, LIVELY_HOME: h.home,
        PATH: pathWith(h.bin), LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "",
        CLAUDE_CONFIG_DIR: "",   // 지목 없음 — 빈 문자열을 '지목' 으로 읽으면 프로필이 통째로 빠진다
      },
      stdio: "ignore",
    });
    const ccds = new Set(h.ccds());
    check("⑰-d ★ #1541 기본 위치를 겨냥할 때 CLAUDE_CONFIG_DIR 를 **지운다**(빈 문자열로 두지 않는다)",
      ccds.has("(unset)"), `본 값=${JSON.stringify([...ccds])}`);
    check("⑰-d ★ #1541 프로필 dir 에도 등록한다(웹터미널 세션이 읽는 곳)",
      ccds.has(`[${prof}]`), `본 값=${JSON.stringify([...ccds])} · 기대 포함=[${prof}]`);
    check("⑰-d claude dir 없는 슬러그는 겨냥하지 않는다",
      ![...ccds].some((x) => x.includes("ghost")), `본 값=${JSON.stringify([...ccds])}`);
  }

  // ⑰-c **#1593 — 샌드박스(LIVELY_HOME)가 라이브 ~/.claude.json 을 오염시키면 안 된다.**
  //   실측 사고: `LIVELY_HOME=<임시> lively login` 이 **실사용자** ~/.claude.json 에 그 임시 경로를 구웠고,
  //   임시 디렉터리가 지워지자 lively MCP 가 ENOENT 로 **통째로 안 떴다** — 이후 모든 세션이 조직 맥락을 잃는다.
  //   등록되는 command 값은 LIVELY_HOME 기반인데 기록되는 파일만 실 HOME 이라 둘이 어긋난 것이다.
  //  ⚠ 이 케이스는 HOME 과 LIVELY_HOME 을 **일부러 다르게** 준다. 위 lively() 처럼 둘을 같은 값으로 주면
  //   자식 HOME 주입이 빠져 있어도 결과가 같아 **결함이 드러나지 않는다** — 그게 이 버그가 오래 숨은 이유다.
  //  ⚠ 판정은 argv 가 아니라 **스텁 claude 가 받은 HOME** 으로 한다(등록 파일을 고르는 게 그 값이므로).
  {
    const h = newHome("mcp-home-isolation");
    const live = join(BOX, "pretend-live-home");   // '실사용자 홈' 대역 — 여기로 새면 실패다
    mkdirSync(join(live, ".claude"), { recursive: true });
    mkdirSync(join(h.home, ".lively"), { recursive: true });
    writeFileSync(join(h.home, ".lively", "mcp-servers.json"), JSON.stringify({ servers: [] }));
    const probe = join(h.home, "probe-1593.mjs");
    writeFileSync(probe, [
      `import { registerClaudeMcp } from ${JSON.stringify(pathToFileURL(CLI).href)};`,   // 절대경로 그대로면 윈도우에서 죽는다(#1510)
      "registerClaudeMcp();",
    ].join("\n"));
    execFileSync(process.execPath, [probe], {
      // HOME=가짜 실홈 · LIVELY_HOME=샌드박스 — 어긋난 상태를 그대로 재현한다.
      env: {
        ...process.env, ...offlineLivelyEnv(),
        HOME: live, USERPROFILE: live,          // 윈도우는 os.homedir() 가 USERPROFILE 을 본다(#1510)
        LIVELY_HOME: h.home, CLAUDE_CONFIG_DIR: "",
        PATH: pathWith(h.bin), LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "",
      },
      stdio: "ignore",
    });
    const seen = h.homes();
    check("⑰-c ★ #1593 MCP 등록이 부르는 claude 는 샌드박스 HOME 을 받는다(실사용자 홈 무접촉)",
      seen.length > 0 && seen.every((x) => x === h.home),
      `claude 가 받은 HOME=${JSON.stringify(seen)} · 기대=${h.home} · 실홈대역=${live}`);
  }

  // ⑱ **#916 — 스테일 LIVELY_TOKEN 이 파일 토큰을 이기면 안 된다.**
  //   설치기가 codex 용으로 rc 에 `export LIVELY_TOKEN="$(cat ~/.lively/token)"` 를 심으므로, 로그인 **후**
  //   같은 셸의 env 는 옛 토큰이다. 그 상태로 `lively install` 을 돌리면 옛 코드는 옛 토큰을 .claude.json 에
  //   구웠다(둘 다 유효하니 401 도 안 나고 전 단계가 ✓ 로 보인다 = 조용한 파손).
  //   여기서 검증하는 건 "어느 신원이 .claude.json 에 구워졌나" — 그게 이 버그의 실제 피해다.
  {
    serving.body = makeBundle("v-ddd");
    serving.version = "v-ddd";
    const h = newHome("h-916-stale");
    await lively(h, ["login", "--gateway", GW, "--token", TOKEN]);          // 파일 = 새 토큰
    await lively(h, ["install"], { env: { LIVELY_TOKEN: OLD_TOKEN } });     // 셸 env = 스테일 옛 토큰
    const adds = h.argv().filter((l) => l.startsWith("mcp add"));
    // #1079 로 이 버그의 표면이 바뀌었다 — lively 는 **stdio 프록시**라 설정에 토큰이 아예 안 들어간다.
    //  그래서 "어느 토큰이 구워졌나"가 아니라 "**어떤 토큰도 안 구워진다**"가 종결 조건이다(신원 선택은
    //  런타임으로 이동했고, 거기서도 파일이 env 를 이긴다 — lively-mcp-gateway.test.mjs E11 이 못박는다).
    const livelyAdd = adds.filter((l) => /\slively\s/.test(l));
    const leaked = adds.filter((l) => l.includes(TOKEN) || l.includes(OLD_TOKEN));
    check("⑱ #916/#1079 — install 이 .claude.json 에 토큰을 굽지 않는다(lively=stdio 프록시)",
      livelyAdd.length > 0 && livelyAdd.every((l) => l.includes("--transport stdio")) && leaked.length === 0,
      `lively=${JSON.stringify(livelyAdd)} leaked=${JSON.stringify(leaked)}`);
  }

  // ⑲ **#916 — 로그인 탈출구 분기표**(loginEscapeToken). 이 분기는 **제어단말(/dev/tty)이 있어야** 밟히는데
  //   execFile 하네스엔 없다 → winArg 와 같은 이유로 순수함수를 직접 못박는다(lively.mjs:93-102 참조).
  //   핵심: '파일 있음 + 대화형' = 키트 사용자의 재로그인 → env 무시 → 브라우저 흐름. 이게 #916 의 조건.
  {
    const T = "lvk_env", F = "lvk_file", G = "lvk_flag";
    const cases = [
      // [설명,                              입력,                                                          기대]
      ["--token 은 언제나 이긴다(대화형)",    { flagToken: G, envToken: T, fileToken: F, isInteractive: true },  G],
      ["--token 은 언제나 이긴다(비대화형)",  { flagToken: G, envToken: T, fileToken: F, isInteractive: false }, G],
      ["#916: 파일+대화형 → env 무시",        { envToken: T, fileToken: F, isInteractive: true },                ""],
      ["CI(비대화형) → env 탈출구 유지",      { envToken: T, fileToken: F, isInteractive: false },               T],
      ["프로비저닝(파일 없음) → env 탈출구",  { envToken: T, fileToken: "", isInteractive: true },               T],  // docker run -t 등 pty 붙은 컨테이너
      ["파일만 있고 env 없음 → 브라우저",     { envToken: "", fileToken: F, isInteractive: true },               ""],
    ];
    const bads = cases.filter(([, input, want]) => loginEscapeToken(input) !== want)
      .map(([why, input, want]) => `${why}: got=${JSON.stringify(loginEscapeToken(input))} want=${JSON.stringify(want)}`);
    check("⑲ #916 — 로그인 탈출구 분기표(--token > 파일없음 > 비대화형 > 브라우저)", bads.length === 0, bads.join(" | "));
  }

  // ⑳ onboarding — `lively onboarding` 은 claude 를 초기 프롬프트로 소환한다(설치 제안·수동 재실행 공용 진입).
  //   --print 는 실제로 안 띄우고 실행할 명령만 낸다 → gateway·token·claude 없이 순수 검증(winArg 계열과 동류).
  {
    // say() 는 stderr 로 간다(stdout 은 --json 등 기계출력 전용) — resume --print 와 동일 관례.
    const r = await pExecFile(process.execPath, [CLI, "onboarding", "--print"]);
    check('⑳ onboarding --print — claude "온보딩 도와줘" 로 소환', r.stderr.includes('claude "온보딩 도와줘"'), JSON.stringify(r.stderr));
    const r2 = await pExecFile(process.execPath, [CLI, "onboarding", "메모리만", "정리", "--print"]);
    check("⑳ onboarding — 초기 프롬프트 override", r2.stderr.includes('claude "메모리만 정리"'), JSON.stringify(r2.stderr));
  }
} finally {
  server.close();
  cleanup();
}

// ── MCP 등록 대상·커버리지·잔재 판정 (#1541 실기기) ──────────────────────────
// 실측: 웹터미널 세션은 CLAUDE_CONFIG_DIR=<프로필> 로 뜨는데 키트는 기본 위치에만 등록했다.
//  → 노드 웹세션엔 lively MCP 가 영원히 안 보였고, status 는 '어딘가 있음' 을 ✓ 로 표시해 오진을 도왔다.
{
  const J = (...p) => p.join("/");
  const T = (o) => claudeMcpTargets({ join: J, ...o });

  // ① 지목이 있으면 그것만 — 게이트웨이가 멤버 한 명의 프로필을 프로비저닝할 때 남의 프로필을 건드리면 안 된다(#1014).
  check("MCP대상 지목되면 그 한 곳만",
    JSON.stringify(T({ env: { CLAUDE_CONFIG_DIR: "/p/yoon/claude" }, profilesRoot: "/r", exists: () => true, listDirs: () => ["a", "b"] }))
      === JSON.stringify([{ configDir: "/p/yoon/claude", label: "지정된 프로필" }]),
    "지목을 무시하고 퍼뜨렸다");

  // ② 지목이 없으면 기본 + 이 PC 의 프로필 전부. 기본이 **첫** 대상이어야 한다(종전 동작 보존).
  const t2 = T({ env: {}, profilesRoot: "/r", exists: () => true, listDirs: () => ["yoon", "amorite"] });
  check("MCP대상 기본이 첫 항목", t2[0].configDir === null, `첫 항목=${JSON.stringify(t2[0])}`);
  check("MCP대상 프로필까지 포함(정렬)",
    JSON.stringify(t2.map((x) => x.configDir)) === JSON.stringify([null, "/r/amorite/claude", "/r/yoon/claude"]),
    JSON.stringify(t2.map((x) => x.configDir)));

  // ③ 프로필 폴더가 없거나 못 읽어도 기본 하나는 나온다(등록이 통째로 죽지 않게).
  check("MCP대상 프로필 없음 → 기본만",
    JSON.stringify(T({ env: {}, profilesRoot: "/r", exists: () => true, listDirs: () => [] })) === JSON.stringify([{ configDir: null, label: "기본" }]),
    "프로필 0개인데 기본이 사라졌다");
  check("MCP대상 listDirs throw → 기본만",
    T({ env: {}, profilesRoot: "/r", exists: () => true, listDirs: () => { throw new Error("EACCES"); } }).length === 1,
    "권한 오류에 등록 전체가 죽는다");
  // claude dir 이 아직 없는 슬러그는 제외 — 세션이 만들기 전 자리에 미리 쓰지 않는다.
  check("MCP대상 claude dir 없는 슬러그 제외",
    T({ env: {}, profilesRoot: "/r", exists: (p) => p === "/r/yoon/claude", listDirs: () => ["yoon", "ghost"] }).length === 2,
    "존재하지 않는 프로필 dir 을 대상에 넣었다");
  check("MCP대상 빈 CLAUDE_CONFIG_DIR 는 지목이 아니다",
    T({ env: { CLAUDE_CONFIG_DIR: "   " }, profilesRoot: "/r", exists: () => true, listDirs: () => [] })[0].configDir === null,
    "공백 문자열을 지목으로 읽었다");

  // ④ 커버리지 — '어딘가 있음' 이 아니라 '어디가 빠졌나' 를 낸다.
  const tg = [{ configDir: null, label: "기본" }, { configDir: "/r/yoon/claude", label: "프로필 yoon" }];
  const cov = mcpCoverage("lively", tg, (cd) => (cd === null ? { command: "x" } : null));
  check("커버리지 any/all 분리", cov.any === true && cov.all === false, JSON.stringify(cov));
  check("커버리지 빠진 곳을 이름으로", JSON.stringify(cov.missing) === JSON.stringify(["프로필 yoon"]), JSON.stringify(cov.missing));
  const cov2 = mcpCoverage("lively", tg, () => ({ command: "x" }));
  check("커버리지 전부 있으면 missing 비어 있음", cov2.all === true && cov2.missing.length === 0, JSON.stringify(cov2));

  // ⑤ 잔재 판정 — 이름만으로 지우지 않는다(사람이 같은 이름을 쓸 수 있다).
  const GW = "https://dev.lvly.io";
  check("잔재: 우리 게이트웨이의 /mcp 면 제거 대상",
    isLegacyLivelyMcp("lively-store", { url: "http://dev.lvly.io:8080/mcp" }, GW) === true, "실측된 잔재를 못 잡았다");
  check("잔재: 남의 호스트면 건드리지 않는다",
    isLegacyLivelyMcp("lively-store", { url: "https://someone.else/mcp" }, GW) === false, "남의 서버를 지우려 했다");
  check("잔재: 경로가 /mcp 가 아니면 아니다",
    isLegacyLivelyMcp("lively-store", { url: "https://dev.lvly.io/other" }, GW) === false, "무관한 경로를 잔재로 봤다");
  check("잔재: 목록에 없는 이름은 아니다",
    isLegacyLivelyMcp("lively", { url: "https://dev.lvly.io/mcp" }, GW) === false, "현역 이름을 잔재로 봤다");
  for (const bad2 of [null, {}, { url: "" }, { url: "not a url" }])
    check(`잔재: 망가진 항목(${JSON.stringify(bad2)})에 throw 없음`, isLegacyLivelyMcp("lively-store", bad2, GW) === false, "throw 또는 오판");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
