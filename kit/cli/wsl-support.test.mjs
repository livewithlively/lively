#!/usr/bin/env node
// WSL 에서 Cursor 가 라이블리에 붙게 (#5041) — 사양 표의 행마다 시나리오 하나.
//  배경(실측 2026-10-27): 고객 PC 는 윈도우 안 WSL 배포판에서 Cursor 를 돌렸다. 윈도우에 깐 라이블리는 거기서 안 보였다 —
//   WSL 의 Cursor 는 리눅스 홈의 ~/.cursor 를 읽고, 윈도우 Cursor 로 WSL 폴더를 열어도 WSL 쪽 설정을 읽는다.
//   그래서 ① 윈도우 설치 끝·status 가 WSL 배포판을 보면 리눅스 설치 한 줄을 알려 주고 ② WSL 안 로그인은 윈도우 브라우저로 열고
//   ③ Cursor 가 까는 원격 서버(~/.cursor-server)만 있어도 Cursor 를 배선 대상으로 본다.
//  S1 isWsl · S2 browserCommand · S3 parseWslDistros · S4 wslHint · S5 Cursor 감지(실제 CLI 프로세스 — 홈 샌드박스).
//  부트스트랩의 WSL 전용 런타임(S6)은 bootstrap-node-gate.test.mjs W1~W7, 자동 업데이트 쪽 감지는 self-update.test ⑯c′·⑧c.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closedPath, nodeOnlyDir, noBrowserEnv, sandboxEnv, WIN } from "../testlib/os-sandbox.mjs";
import { isWsl, browserCommand, parseWslDistros, wslHint, wslDistros } from "./lively.mjs";

const CLI = join(fileURLToPath(import.meta.url), "..", "lively.mjs");
const BOX = mkdtempSync(join(tmpdir(), "lively-wsl-test-"));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  // ── S1. WSL 판정 — 강제값 > WSL_DISTRO_NAME > 커널 이름 ─────────────────────────────
  const WSL2 = "5.15.167.4-microsoft-standard-WSL2";
  const WSL1 = "4.4.0-19041-Microsoft";
  const PLAIN = "6.8.0-1015-aws";
  const kernel = (s) => () => s;
  const noProc = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  const S1 = [
    ["1 강제 켬은 플랫폼과 무관", { platform: "darwin", env: { LIVELY_WSL: "1" }, osrelease: noProc }, true],
    ["2 강제 끔이 WSL_DISTRO_NAME·커널보다 앞선다", { platform: "linux", env: { LIVELY_WSL: "0", WSL_DISTRO_NAME: "Ubuntu" }, osrelease: kernel(WSL2) }, false],
    ["3 WSL_DISTRO_NAME", { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, osrelease: kernel(PLAIN) }, true],
    ["4 커널 이름 WSL2", { platform: "linux", env: {}, osrelease: kernel(WSL2), inContainer: () => false }, true],
    ["5 커널 이름 WSL1(대문자 Microsoft)", { platform: "linux", env: {}, osrelease: kernel(WSL1), inContainer: () => false }, true],
    ["6 일반 리눅스", { platform: "linux", env: {}, osrelease: kernel(PLAIN) }, false],
    ["7 커널 이름을 못 읽음", { platform: "linux", env: {}, osrelease: noProc }, false],
    ["8 맥에 떠도는 WSL_DISTRO_NAME", { platform: "darwin", env: { WSL_DISTRO_NAME: "Ubuntu" }, osrelease: kernel(WSL2) }, false],
    ["9 윈도우", { platform: "win32", env: {}, osrelease: noProc }, false],
    ["10 빈 강제값은 자동 판정", { platform: "linux", env: { LIVELY_WSL: "", WSL_DISTRO_NAME: "Ubuntu" }, osrelease: kernel(PLAIN) }, true],
    ["11 모르는 강제값은 자동 판정", { platform: "linux", env: { LIVELY_WSL: "yes" }, osrelease: kernel(PLAIN) }, false],
    ["12 빈 WSL_DISTRO_NAME 은 없는 것", { platform: "linux", env: { WSL_DISTRO_NAME: "" }, osrelease: kernel(PLAIN) }, false],
    // WSL2 커널 위의 컨테이너(도커 데스크톱·dev container)는 커널 이름이 같다 — 커널 갈래만 막는다(격리 리뷰 #5041).
    ["13 컨테이너 안의 WSL2 커널 이름은 WSL 이 아니다", { platform: "linux", env: {}, osrelease: kernel(WSL2), inContainer: () => true }, false],
    ["14 컨테이너여도 WSL_DISTRO_NAME 은 WSL 이다", { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, osrelease: kernel(PLAIN), inContainer: () => true }, true],
    ["15 컨테이너가 아니면 커널 이름으로 WSL", { platform: "linux", env: {}, osrelease: kernel(WSL2), inContainer: () => false }, true],
  ];
  for (const [name, input, want] of S1) {
    const got = isWsl(input);
    check(`S1-${name}`, got === want, `기대 ${want} · 실제 ${got}`);
  }

  // ── S2. 승인 주소 열기 ───────────────────────────────────────────────────────
  //  실제 승인 주소 모양(`…/ui/#/activate?code=…`) + & 를 함께 넣는다 — explorer.exe 가 `=` 든 주소를 폴더로 연 보고가 있는 자리.
  const URL_ = "https://lively.example.com/ui/#/activate?code=WXYZ-8899&x=1";
  // 윈도우 주소 처리기. rundll32 가 없을 때(appendWindowsPath=false·상호운용 끔) WSLg 가 있으면 xdg-open 으로 물러선다.
  const WIN_URL = (gui) => ({ cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", URL_], fallback: gui ? { cmd: "xdg-open", args: [URL_] } : null });
  const S2 = [
    ["1 WSL · DISPLAY 있음 → 윈도우 주소 처리기(못 열면 xdg-open)", { wsl: true, platform: "linux", env: { DISPLAY: ":0" } }, WIN_URL(true)],
    ["2 WSL · WSLg(DISPLAY·WAYLAND)가 있어도 먼저 윈도우 쪽(리눅스 쪽은 물러설 때만)", { wsl: true, platform: "linux", env: { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" } }, WIN_URL(true)],
    ["3 WSL · DISPLAY 없어도 연다(물러설 자리 없음)", { wsl: true, platform: "linux", env: {} }, WIN_URL(false)],
    ["4 리눅스 · DISPLAY", { wsl: false, platform: "linux", env: { DISPLAY: ":0" } }, { cmd: "xdg-open", args: [URL_] }],
    ["5 리눅스 · WAYLAND_DISPLAY 만", { wsl: false, platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }, { cmd: "xdg-open", args: [URL_] }],
    ["6 리눅스 · 헤드리스", { wsl: false, platform: "linux", env: {} }, null],
    ["7 맥", { wsl: false, platform: "darwin", env: {} }, { cmd: "open", args: [URL_] }],
    ["8 윈도우", { wsl: false, platform: "win32", env: {} }, { cmd: "cmd", args: ["/c", "start", "", URL_] }],
  ];
  for (const [name, opts, want] of S2) {
    const got = browserCommand(URL_, opts);
    check(`S2-${name}`, same(got, want), `기대 ${JSON.stringify(want)} · 실제 ${JSON.stringify(got)}`);
  }
  // 9 — 주소는 손대지 않고 마지막 인자 하나로(& ? = # 이 셸·cmd 에 해석될 자리가 없다).
  {
    const got = browserCommand(URL_, { wsl: true, platform: "linux", env: {} });
    check("S2-9 주소(& ? = #)는 그대로 마지막 인자 하나", !!got && got.args[got.args.length - 1] === URL_ && got.args.filter((a) => a.includes(URL_)).length === 1, JSON.stringify(got));
  }
  // 10 — http(s) 가 아닌 주소는 어느 플랫폼에서도 열지 않는다(주소는 게이트웨이 응답에서 온다 — 여는 명령들은 파일·다른 프로토콜도 연다).
  {
    const bad = ["file:///etc/passwd", "javascript:alert(1)", "C:\\Windows\\System32\\calc.exe", "", null];
    const opened = [];
    for (const u of bad) for (const [platform, wsl, env] of [["linux", true, { DISPLAY: ":0" }], ["linux", false, { DISPLAY: ":0" }], ["darwin", false, {}], ["win32", false, {}]]) {
      const got = browserCommand(u, { platform, wsl, env });
      if (got !== null) opened.push(`${platform}${wsl ? "+wsl" : ""} ${JSON.stringify(u)}`);
    }
    check("S2-10 http(s) 가 아닌 주소는 열지 않는다", opened.length === 0, opened.join(" · "));
    check("S2-10 대조 — 대문자 HTTPS 도 연다", browserCommand("HTTPS://x.example.com/a", { platform: "darwin", wsl: false, env: {} })?.cmd === "open");
  }
  // 배선 — WSL 판정을 넘기지 않으면 env·플랫폼으로 isWsl 을 불러 정한다(두 함수가 실제로 이어져 있다).
  {
    const viaEnv = browserCommand(URL_, { platform: "linux", env: { LIVELY_WSL: "1" } });
    const viaOff = browserCommand(URL_, { platform: "linux", env: { LIVELY_WSL: "0", DISPLAY: ":0" } });
    check("S2-배선 판정을 안 넘기면 env 의 WSL 판정을 따른다", viaEnv?.cmd === "rundll32.exe" && viaOff?.cmd === "xdg-open",
      `켬=${JSON.stringify(viaEnv)} 끔=${JSON.stringify(viaOff)}`);
  }

  // ── S3. 레지스트리 출력 → 배포판 이름 ─────────────────────────────────────────
  const KEY = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
  const reg = (rows, tail = "End of search: 2 match(es) found.") =>
    ["", ...rows.flatMap(([guid, name]) => [`${KEY}\\{${guid}}`, `    DistributionName    REG_SZ    ${name}`, ""]), tail, ""].join("\r\n");
  const S3 = [
    ["1 영문 · 둘 · CRLF", reg([["a1", "Ubuntu"], ["b2", "Debian"]]), ["Ubuntu", "Debian"]],
    ["2 한국어 꼬리줄", reg([["a1", "Ubuntu"], ["b2", "Debian"]], "검색 끝: 2 일치하는 항목 발견"), ["Ubuntu", "Debian"]],
    ["3 도구용 배포판은 뺀다", reg([["a1", "docker-desktop"], ["b2", "Ubuntu-24.04"], ["c3", "docker-desktop-data"], ["d4", "rancher-desktop"], ["e5", "podman-machine-default"]]), ["Ubuntu-24.04"]],
    ["4 같은 이름은 한 번", reg([["a1", "Ubuntu"], ["b2", "Ubuntu"]]), ["Ubuntu"]],
    ["5 끝 공백은 뗀다", reg([["a1", "Ubuntu-24.04   "]]), ["Ubuntu-24.04"]],
    ["6a 빈 문자열", "", []],
    ["6b null", null, []],
    ["6c undefined", undefined, []],
    ["7 오류 문구", "ERROR: The system was unable to find the specified registry key or value.\r\n", []],
    ["8 다른 값 줄은 무시", [`${KEY}\\{a1}`, "    BasePath    REG_SZ    C:\\Users\\tester\\AppData\\Local\\Packages\\Ubuntu", "    DistributionName    REG_SZ    Ubuntu", `${KEY}`, "    DefaultDistribution    REG_SZ    {a1}"].join("\r\n"), ["Ubuntu"]],
  ];
  for (const [name, input, want] of S3) {
    const got = parseWslDistros(input);
    check(`S3-${name}`, same(got, want), `기대 ${JSON.stringify(want)} · 실제 ${JSON.stringify(got)}`);
  }

  // ── S4. WSL 안내 ─────────────────────────────────────────────────────────────
  {
    const h = wslHint("https://lively.example.com", ["Ubuntu"]);
    check("S4-1 명령은 그 게이트웨이의 리눅스 설치 한 줄", h?.cmd === "curl -fsSL https://lively.example.com/cli | sh", JSON.stringify(h));
    check("S4-1 안내 문구에 배포판 이름이 보인다", !!h && h.lines.join(" ").includes("Ubuntu"), JSON.stringify(h?.lines));
    const s1 = wslHint("https://lively.example.com/", ["Ubuntu"]), s2 = wslHint("https://lively.example.com//", ["Ubuntu"]);
    check("S4-2 주소 끝 / 는 떼어 //cli 가 없다", s1?.cmd === h?.cmd && s2?.cmd === h?.cmd, `${s1?.cmd} | ${s2?.cmd}`);
    check("S4-3 배포판이 없으면 안내 없음", wslHint("https://lively.example.com", []) === null);
    check("S4-4 주소가 없으면 안내 없음", wslHint("", ["Ubuntu"]) === null && wslHint(null, ["Ubuntu"]) === null);
    check("S4-5 배포판이 배열이 아니면 안내 없음", wslHint("https://lively.example.com", "Ubuntu") === null && wslHint("https://lively.example.com", undefined) === null);
  }
  // S4-6 — 윈도우 실기기(CI)에서 목록 조회가 예외·멈춤 없이 배열을 낸다. 윈도우가 아니면 늘 빈 목록이다.
  {
    const t0 = Date.now();
    let got, err = null;
    try { got = wslDistros(); } catch (e) { err = e; }
    check(`S4-6 목록 조회는 예외 없이 배열(${WIN ? "윈도우 실기기" : "윈도우 아님 → 빈 목록"})`,
      !err && Array.isArray(got) && got.every((n) => typeof n === "string" && n.length > 0) && (WIN || got.length === 0) && Date.now() - t0 < 10_000,
      `err=${err?.message} got=${JSON.stringify(got)} ${Date.now() - t0}ms`);
  }

  // ── S5. Cursor 를 이 홈에서 쓰는가 — 실제 CLI 프로세스(홈 샌드박스 · 닫힌 PATH) ────────────────
  //  detectHarnesses(설치 대상)와 status --json 의 installed 를 같은 홈에서 함께 잰다(두 표면이 갈리면 그게 결함).
  //  sandboxEnv 는 HostEffects 를 deny 로 건다 — 키트 시험 샌드박스 모드를 열어야 has() 의 `command -v` 가 돈다
  //  (cli-help-guard.test 와 같은 관례. 샌드박스 모드의 has() 는 샌드박스 밖 바이너리를 «없음» 으로 본다 = 하네스 없는 기계).
  const probe = (home) => {
    const env = { ...process.env, ...sandboxEnv({ home }), ...noBrowserEnv(), LIVELY_HOME: home, LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox",
      PATH: closedPath(nodeOnlyDir(BOX)), NO_COLOR: "1" };
    const det = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(CLI).href)}); process.stdout.write(JSON.stringify(m.detectHarnesses()));`],
    { env, encoding: "utf8", timeout: 30_000 });
    const st = spawnSync(process.execPath, [CLI, "status", "--json"], { env, encoding: "utf8", timeout: 60_000 });
    let detected = null, installed = null;
    try { detected = JSON.parse(det.stdout); } catch { /* 아래 배선 판정이 잡는다 */ }
    try { installed = JSON.parse(st.stdout)?.harness?.cursor?.installed ?? null; } catch { /* 아래 배선 판정이 잡는다 */ }
    return { detected, installed, err: `${det.stderr}`.slice(-300) + `${st.stderr}`.slice(-300) };
  };
  const mkHome = (name, dirs) => { const h = join(BOX, name); for (const d of dirs) mkdirSync(join(h, d), { recursive: true }); mkdirSync(h, { recursive: true }); return h; };
  const remote = probe(mkHome("remote", [".cursor-server/bin"]));        // 1 원격 서버만
  const none = probe(mkHome("none", []));                                 // 2 둘 다 없음
  const ide = probe(mkHome("ide", [".cursor/extensions"]));               // 3 ~/.cursor 만(종전)
  check("S5-배선 두 표면 모두 실제로 결과를 냈다(프로세스·JSON 이 살아 있다)",
    [remote, none, ide].every((p) => Array.isArray(p.detected) && typeof p.installed === "boolean"),
    JSON.stringify({ remote, none, ide }));
  check("S5-3 ~/.cursor 만 있는 홈은 감지(종전 — 대조군)", ide.detected?.includes("cursor") && ide.installed === true, JSON.stringify(ide));
  check("S5-2 아무것도 없는 홈은 감지 안 함", Array.isArray(none.detected) && !none.detected.includes("cursor") && none.installed === false, JSON.stringify(none));
  check("S5-1 ★ ~/.cursor-server 만 있는 홈(윈도우 Cursor 가 WSL 로 붙는 홈)도 감지 — 설치 대상과 status 가 같은 판정",
    remote.detected?.includes("cursor") && remote.installed === true, JSON.stringify(remote));
} finally {
  try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
