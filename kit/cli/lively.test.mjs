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
import { fileURLToPath } from "node:url";

const pExecFile = promisify(execFile);

const HERE = join(fileURLToPath(import.meta.url), "..");          // kit/cli
const KIT = join(HERE, "..");                                     // kit
const REPO = join(KIT, "..");                                     // 레포 루트
const CLI = join(HERE, "lively.mjs");
const { buildKitBundle } = await import(join(KIT, "generator", "build-context.mjs"));
const { CLI_SHIM, CLI_SHIM_CMD } = await import(join(KIT, "setup", "user-install.mjs"));
const { winArg } = await import(CLI);   // 순수함수 — POSIX CI 에선 실행 경로에 없으니 직접 검증한다

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

const BOX = mkdtempSync(join(tmpdir(), "lively-cli-test-"));
const cleanup = () => { try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ } };

const TOKEN = "lvk_test_0123456789abcdef";
const BAD_TOKEN = "lvk_wrong";

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
let serving = { version: "v-aaa", body: null, installHits: 0, selfUpdate: true };
const server = createServer((req, res) => {
  const path = (req.url || "").split("?")[0];
  const auth = String(req.headers.authorization || "");
  // /cli* 는 무인증(부트스트랩 — 토큰을 얻기 전에 실행되는 유일한 지점). 나머지는 bearer 필수.
  if (!path.startsWith("/cli")) {
    if (auth !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
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
  writeFileSync(join(bin, "claude"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    // `claude mcp list` 는 등록된 걸 되돌려준다(status/doctor 가 이걸 읽는다).
    'if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then',
    `  grep -q "mcp add .*lively " ${JSON.stringify(log)} 2>/dev/null && echo "lively: ${GW}/mcp (HTTP)"`,
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n"));
  chmodSync(join(bin, "claude"), 0o755);
  return { home, bin, log, argv: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []) };
}

// CLI 실행 — 샌드박스 HOME + 스텁 PATH. 절대 실기기·실게이트웨이에 닿지 않는다.
//  ⚠ HOME 과 LIVELY_HOME 을 **둘 다** 준다: 설치기는 LIVELY_HOME 을, 셸 rc 탐색은 HOME 을 본다(#858 함정③).
//  ⚠ 셸의 LIVELY_TOKEN/LIVELY_GATEWAY_URL 은 파일보다 우선하므로 명시적으로 비운다(그렇지 않으면 테스트가 무의미해진다).
async function lively(h, args, { env = {}, expectFail = false } = {}) {
  try {
    const r = await pExecFile(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: h.home,
        LIVELY_HOME: h.home,
        CLAUDE_CONFIG_DIR: join(h.home, ".claude"),
        PATH: `${h.bin}:${process.env.PATH}`,
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

  // ② 로그인 성공 — 토큰 0600 + gateway-url 은 /mcp 없이 저장(setup-mac.sh 와 같은 계약).
  const H = newHome("h-main");
  {
    const r = await lively(H, ["login", "--gateway", `${GW}/mcp`, "--token", TOKEN]);
    const tp = join(H.home, ".lively", "token");
    const mode = (statSync(tp).mode & 0o777).toString(8);
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
    const shim = existsSync(join(lv, "bin", "lively"));
    check("③ 설치 — 훅 · CLI · 심 · 버전 스탬프",
      stamped === "v-aaa" && hooks && cli && shim,
      `stamp=${stamped} hooks=${hooks} cli=${cli} shim=${shim}\n${r.err.slice(-400)}`);
  }

  // ④ **MCP 등록 인자** — register-clients.sh 와 동일해야 한다. 이 CLI 의 존재 이유이므로 argv 를 그대로 못박는다.
  {
    const adds = H.argv().filter((l) => l.startsWith("mcp add"));
    const want = `mcp add --transport http --scope user lively ${GW}/mcp --header Authorization: Bearer ${TOKEN}`;
    check("④ claude MCP 등록 argv 가 register-clients.sh 와 동일",
      adds.some((l) => l === want), `got=${JSON.stringify(adds)}\nwant=${JSON.stringify(want)}`);
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
    const admin = readFileSync(join(REPO, "web", "admin.ts"), "utf8");
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
  {
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
      env: { ...process.env, HOME: h.home, LIVELY_HOME: h.home, PATH: `${h.bin}:${process.env.PATH}` },
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
  {
    const r = await lively(H, ["run", "not-a-number"], { expectFail: true });
    check("⑮ run — 프로젝트 번호가 아니면 usage(exit 2)", r.code === 2, `code=${r.code}`);
  }
} finally {
  server.close();
  cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
