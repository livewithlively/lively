import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { HARNESSES, harnessSettingsArgv, harnessThemeArgv, harnessThemeEnvArgs, paneLaunchArgv, installTenantSlugResolver, roots, sharedRoot, codexAppServerPaneArgv, chatRuntimePaneArgv } from "./catalog.js";

test("Codex 현행 5.6 모델과 모델별 추론강도 차이를 카탈로그가 보존한다", () => {
  const c = HARNESSES.find((h) => h.key === "codex")!;
  const models = c.flags.find((f) => f.name === "--model")?.choices ?? [];
  assert.ok(models.includes("gpt-5.6-sol") && models.includes("gpt-5.6-terra") && models.includes("gpt-5.6-luna"));
  assert.ok(c.effortsByModel?.["gpt-5.6-sol"]?.includes("ultra"));
  assert.ok(!c.effortsByModel?.["gpt-5.6-luna"]?.includes("ultra"));
  assert.ok(c.effortsByModel?.["gpt-5.4-mini"]?.includes("xhigh"));
});

test("설치된 각 하네스의 현행 모델 목록을 반영한다", () => {
  const models = (key: string): string[] => HARNESSES.find((h) => h.key === key)!
    .flags.find((f) => f.name === "--model")!.choices!.filter(Boolean);
  assert.ok(models("claude").includes("fable"));
  assert.deepEqual(models("grok"), ["grok-4.6"]);
  assert.ok(HARNESSES.find((h) => h.key === "grok")!.flags.find((f) => f.name === "--effort")?.choices?.includes("xhigh"));
  //  antigravity 는 `agy models` 실측 목록을 그대로 싣는다 — 새 계열을 넣고, **없어진 계열은 뺀다**
  //   (그록 4.5 에서 배운 것과 같은 규칙: 목록에 없는 모델은 고르는 즉시 실패한다).
  //   2026-09-16 재실측: 3.8 계열이 생기고 3.5 계열이 빠졌다.
  assert.ok(models("antigravity").includes("gemini-3.8-flash-high"));
  assert.ok(models("antigravity").includes("gemini-3.7-flash-high"));
  assert.ok(models("antigravity").includes("gemini-3.6-flash-medium"));
  assert.ok(!models("antigravity").some((m) => m.startsWith("gemini-3.5-")));
  assert.ok(models("opencode").includes("opencode/nemotron-3.5-lightning-free"));
});

test("모든 AI 하네스는 상단 전환에 쓸 제공자와 모델 선택지를 가진다", () => {
  for (const h of HARNESSES.filter((x) => x.key !== "shell")) {
    assert.ok(h.provider?.label, `${h.key}: 제공자 이름 없음`);
    assert.ok(h.flags.some((f) => f.name === "--model"), `${h.key}: 모델 선택지 없음`);
  }
});

// ── ★★ 루트는 상수가 아니라 호출 시점 값이다 ────────────────────────────────
// 종전엔 `export const ROOTS` 라 모듈 로드 때 env 한 번 읽고 끝이었다 — 즉 "프로세스 하나 =
//  워크스페이스 하나" 가정이 상수에 굳어 있었다. 게이트웨이 하나가 여러 워크스페이스를 서비스하면
//  파일 탐색기·세션 생성·디스크 가드가 전부 **첫 로드 시점 테넌트**의 경로를 본다 = 남의 파일이 보인다.

test("★ 템플릿이 없으면 종전과 완전히 같다(OSS 무회귀)", () => {
  const saved = { t: process.env.LIVELY_TENANT_ROOT_TEMPLATE, s: process.env.TERMINAL_ROOT_SHARED };
  delete process.env.LIVELY_TENANT_ROOT_TEMPLATE;
  process.env.TERMINAL_ROOT_SHARED = "/srv/ws";
  installTenantSlugResolver(() => "acme");     // 슬러그가 있어도 템플릿이 없으면 무시한다
  try {
    assert.equal(sharedRoot().base, "/srv/ws");
  } finally {
    installTenantSlugResolver(() => null);
    if (saved.t === undefined) delete process.env.LIVELY_TENANT_ROOT_TEMPLATE; else process.env.LIVELY_TENANT_ROOT_TEMPLATE = saved.t;
    if (saved.s === undefined) delete process.env.TERMINAL_ROOT_SHARED; else process.env.TERMINAL_ROOT_SHARED = saved.s;
  }
});

test("★★ 템플릿 + 컨텍스트가 있으면 테넌트 경로를 준다", () => {
  process.env.LIVELY_TENANT_ROOT_TEMPLATE = "/var/lib/lvly/tenants/{slug}/work";
  installTenantSlugResolver(() => "acme-1a2b");
  try {
    assert.equal(sharedRoot().base, "/var/lib/lvly/tenants/acme-1a2b/work/shared");
    assert.equal(roots().find((r) => r.key === "personal")!.base, "/var/lib/lvly/tenants/acme-1a2b/work/personal");
  } finally {
    installTenantSlugResolver(() => null);
    delete process.env.LIVELY_TENANT_ROOT_TEMPLATE;
  }
});

// ★★★ 같은 프로세스에서 테넌트가 바뀌면 경로도 바뀌어야 한다 — 이게 상수를 없앤 이유 전부다.
test("★★★ 요청마다 다른 테넌트면 다른 경로다(값이 굳지 않는다)", () => {
  process.env.LIVELY_TENANT_ROOT_TEMPLATE = "/t/{slug}";
  let who = "a";
  installTenantSlugResolver(() => who);
  try {
    assert.equal(sharedRoot().base, "/t/a/shared");
    who = "b";
    assert.equal(sharedRoot().base, "/t/b/shared", "값이 굳었다 — 남의 파일을 보게 된다");
  } finally {
    installTenantSlugResolver(() => null);
    delete process.env.LIVELY_TENANT_ROOT_TEMPLATE;
  }
});

// ★ 슬러그는 경로에 들어간다. 형식을 못 믿을 때는 **테넌트 경로를 쓰지 않는다** — 폴백이 아니라
//  무시다. 이상한 슬러그로 경로를 만들면 그게 곧 경로 탈출이다.
test("★ 안전하지 않은 슬러그는 테넌트 경로를 만들지 않는다", () => {
  process.env.LIVELY_TENANT_ROOT_TEMPLATE = "/t/{slug}";
  process.env.TERMINAL_ROOT_SHARED = "/srv/ws";
  try {
    for (const bad of ["../etc", "a/b", "A-UP", "", "a b", ".hidden"]) {
      installTenantSlugResolver(() => bad);
      assert.equal(sharedRoot().base, "/srv/ws", `허용되면 안 됨: ${bad}`);
    }
  } finally {
    installTenantSlugResolver(() => null);
    delete process.env.LIVELY_TENANT_ROOT_TEMPLATE;
    delete process.env.TERMINAL_ROOT_SHARED;
  }
});

// ★ 템플릿에 {slug} 가 없으면 모든 테넌트가 **같은 디렉터리**를 쓴다 — 그건 격리가 0 이다.
test("★ {slug} 없는 템플릿은 무시한다(전 테넌트 공유가 되면 안 된다)", () => {
  process.env.LIVELY_TENANT_ROOT_TEMPLATE = "/var/lib/lvly/work";
  process.env.TERMINAL_ROOT_SHARED = "/srv/ws";
  installTenantSlugResolver(() => "acme");
  try {
    assert.equal(sharedRoot().base, "/srv/ws");
  } finally {
    installTenantSlugResolver(() => null);
    delete process.env.LIVELY_TENANT_ROOT_TEMPLATE;
    delete process.env.TERMINAL_ROOT_SHARED;
  }
});

// ── #2055 codex app-server 모드의 pane ─────────────────────────────────────────
test("★ app-server 모드 pane 은 codex TUI 가 아니라 셸이다(스레드 writer 가 둘이 되면 대화가 갈린다)", () => {
  const argv = codexAppServerPaneArgv("linux");
  assert.equal(argv[0], "sh");
  const joined = argv.join(" ");
  assert.match(joined, /exec "\$\{SHELL:-\/bin\/sh\}" -il/, "끝에 사람이 쓰는 셸로 남아야 한다");
  assert.ok(!/(^|\s)codex(\s|$)/.test(argv[2]), "pane 스크립트가 codex 를 실행하면 안 된다");
});

test("app-server 모드 pane 안내는 '그냥 codex 를 치라'고 말하지 않는다 — 그건 새 대화다", () => {
  const intro = codexAppServerPaneArgv("linux").at(-1) ?? "";
  assert.match(intro, /대화창/, "대화가 어디서 도는지 알려 준다");
  assert.match(intro, /resume|넘기기/, "이어가는 법(인계)을 알려 준다");
});

test("★ Windows Codex app-server pane 은 실행 가능한 cmd.exe를 명시한다(#3982)", () => {
  assert.deepEqual(codexAppServerPaneArgv("win32"), ["cmd.exe", "/K"],
    "psmux 기본 선택은 실행 정책에 막힌 PowerShell도 존재만 하면 골라 pane이 즉시 죽는다");
});

test("Windows의 다른 대화 런타임도 같은 cmd.exe 경계를 쓴다", () => {
  assert.deepEqual(chatRuntimePaneArgv({ label: "Claude Code", bin: "claude" }, "win32"), ["cmd.exe", "/K"]);
});

test("플랫폼 값은 정확히 win32 일 때만 cmd.exe를 쓴다", () => {
  assert.equal(codexAppServerPaneArgv("darwin")[0], "sh");
  assert.equal(codexAppServerPaneArgv("win32 ")[0], "sh");
  assert.deepEqual(codexAppServerPaneArgv("win32"), ["cmd.exe", "/K"]);
});

test("플랫폼을 생략하면 현재 실행 플랫폼과 같은 argv 를 만든다", () => {
  assert.deepEqual(codexAppServerPaneArgv(), codexAppServerPaneArgv(process.platform));
});

test("★ Windows psmux pane 명령은 -- 뒤에서 직접 실행해 공백·따옴표를 셸 명령으로 재해석하지 않는다(#3982)", () => {
  const launch = ["powershell", "-NoExit", "-Command", "Write-Host '대화 창'"];
  assert.deepEqual(paneLaunchArgv(launch, "win32"), ["--", ...launch]);
  assert.deepEqual(paneLaunchArgv(codexAppServerPaneArgv("win32"), "win32"), ["--", "cmd.exe", "/K"]);
});

test("pane 명령 구분자는 Windows에만 붙고, 빈 명령에는 붙지 않는다", () => {
  assert.deepEqual(paneLaunchArgv(["sh", "-l"], "linux"), ["sh", "-l"]);
  assert.deepEqual(paneLaunchArgv(["zsh", "-l"], "darwin"), ["zsh", "-l"]);
  assert.deepEqual(paneLaunchArgv([], "win32"), []);
});

test("createSession의 실제 new-session 조립도 pane 실행 경계를 한 관문에서 쓴다", () => {
  const src = readFileSync(new URL("../../src/terminal/sessions.ts", import.meta.url), "utf8");
  assert.match(src, /args\.push\(\.\.\.paneLaunchArgv\(launch, process\.platform\)\)/);
});

// harnessSettingsArgv — claude 스폰의 --settings(theme+statusLine) 병합 seam. 이 함수가 회귀하면 statusLine 이
//  사람 세션에 새거나(managed 게이트 붕괴) 같은 플래그 2회로 theme·statusLine 이 서로 덮을 수 있다(미검증 동작).
test("harnessSettingsArgv: claude theme-only 는 기존 theme argv 와 동일(무회귀)", () => {
  assert.deepEqual(harnessSettingsArgv("claude", { theme: "dark" }), harnessThemeArgv("claude", "dark"));
});

test("harnessSettingsArgv: claude managed-only → statusLine 만 든 단일 --settings", () => {
  const argv = harnessSettingsArgv("claude", { managed: true });
  assert.equal(argv[0], "--settings");
  const s = JSON.parse(argv[1]);
  assert.equal(s.statusLine.type, "command");
  assert.equal("theme" in s, false);
});

test("harnessSettingsArgv: claude theme+managed → 한 --settings 에 두 키(플래그 1회)", () => {
  const argv = harnessSettingsArgv("claude", { theme: "dark", managed: true });
  assert.equal(argv.filter((a) => a === "--settings").length, 1);
  const s = JSON.parse(argv[1]);
  assert.equal(s.theme, "dark");
  assert.equal(s.statusLine.type, "command");
});

test("harnessSettingsArgv: claude 둘 다 없으면 빈 argv", () => {
  assert.deepEqual(harnessSettingsArgv("claude", {}), []);
});

test("harnessSettingsArgv: 사람 세션(managed 아님)엔 statusLine 안 새어나간다", () => {
  const s = JSON.parse(harnessSettingsArgv("claude", { theme: "dark", managed: false })[1]);
  assert.equal("statusLine" in s, false);
});

test("harnessSettingsArgv: 비claude(codex)는 statusLine 무시하고 theme argv 로 위임(무회귀)", () => {
  assert.deepEqual(harnessSettingsArgv("codex", { theme: "dark", managed: true }), harnessThemeArgv("codex", "dark"));
});

// ── #3982 — `--` 직접 실행 경계가 pane의 JSON/공백 인자를 보존한다. Windows도 테마 인자를 잃지 않는다. ──
test("harnessSettingsArgv: win32도 pane argv 테마를 싣되 POSIX statusLine은 제외한다(#3982)", () => {
  assert.deepEqual(harnessSettingsArgv("claude", { theme: "dark", platform: "win32" }), harnessThemeArgv("claude", "dark"));
  const managed = JSON.parse(harnessSettingsArgv("claude", { theme: "dark", managed: true, platform: "win32" })[1]);
  assert.equal(managed.theme, "dark");
  assert.equal("statusLine" in managed, false);
  assert.deepEqual(harnessSettingsArgv("codex", { theme: "dark", platform: "win32" }), harnessThemeArgv("codex", "dark"));
});

test("harnessSettingsArgv: win32 가 아니면 종전 그대로(무회귀)", () => {
  assert.deepEqual(harnessSettingsArgv("claude", { theme: "dark", platform: "darwin" }), harnessThemeArgv("claude", "dark"));
  assert.deepEqual(harnessSettingsArgv("claude", { theme: "dark", platform: "linux" }), harnessThemeArgv("claude", "dark"));
});

test("harnessThemeEnvArgs: win32 에서는 JSON env(opencode) 도 얹지 않는다 — psmux 가 따옴표를 벗긴다", () => {
  assert.ok(harnessThemeEnvArgs("opencode", "dark").length > 0, "다른 표면에선 종전대로 나간다");
  assert.deepEqual(harnessThemeEnvArgs("opencode", "dark", "win32"), []);
});

// ── 대화 런타임 세션의 pane (#2439, 2026-09-01) ────────────────────────────────────
//  ⚠ 이 계약이 없어서 사고가 났다: 기본을 chat 으로 뒤집었는데 pane 은 그대로 TUI 를 띄워
//   **한 대화에 하네스가 둘** 붙었다(실측 box-yoon-a7da7c38). 사람 눈엔 «선택지가 대화창에
//   안 뜨고 시간만 올라가는» 화면이 된다.
test("[#2439] 대화 런타임 세션의 pane 은 셸이고, 안내가 하네스마다 맞다", () => {
  const argv = chatRuntimePaneArgv({ label: "Claude Code", bin: "claude" }, "linux");
  assert.equal(argv[0], "sh", "셸을 띄운다(하네스 TUI 가 아니라)");
  const intro = argv.at(-1) ?? "";
  assert.match(intro, /대화창/, "무엇이 어디에 있는지 첫 화면에 적는다");
  assert.match(intro, /claude/, "그 하네스 명령을 여기서 치면 다른 대화가 열린다고 알린다");
  assert.ok(!/Codex/.test(intro), "★ codex 문구가 다른 하네스에 새지 않는다");
  //  codex 는 종전 문구를 그대로 유지한다(도는 것을 흔들지 않는다).
  const cx = codexAppServerPaneArgv("linux").at(-1) ?? "";
  assert.match(cx, /Codex/);
  assert.match(cx, /App Server/);
});
