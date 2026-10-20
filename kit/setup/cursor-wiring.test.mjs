#!/usr/bin/env node
// cursor 배선 사양테스트(#4927) — [[delivery-install-invariants]] 의 **비파괴·멱등·라운드트립**을 cursor(hooks-json 배선 —
//  ~/.cursor/hooks.json·mcp.json 은 **사용자와 공유하는 파일**)에 적용해 고정한다. grok/antigravity 판과 같은 구조:
//  실제 설치기/제거기를 돌려 산출 파일을 본다. 오프라인·fs-only: 샌드박스 HOME(LIVELY_HOME) 안에서만 읽고 쓴다.
//  실행: node scripts/run-tests.mjs cursor-wiring
//  엣지 표: 스크래치패드 spec.md §C·§D(D5~D7) — 케이스 이름의 [C#]/[D#] 가 그 행 번호다.
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "cursor-wiring-test-"));
const BUNDLE = join(SANDBOX, "bundle");
const HOME = join(SANDBOX, "home");
const CURSOR = join(HOME, ".cursor");
const HOOKSFILE = join(CURSOR, "hooks.json");
const MCPFILE = join(CURSOR, "mcp.json");
const CLICFG = join(CURSOR, "cli-config.json");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const digest = (p) => { try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return "(none)"; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const ADAPTER_RE = /[/\\]\.lively[/\\]hooks[/\\]cursor-adapter\.mjs/;
const ours = (arr) => (Array.isArray(arr) ? arr.filter((e) => ADAPTER_RE.test(String(e?.command || ""))) : []);

// ⓪ [C14] 실 홈 무접촉 — 이 머신의 실제 ~/.cursor 파일 지문 + env 가 가리키는 미끼 자리(CURSOR_CONFIG_DIR·XDG).
const REAL = ["hooks.json", "mcp.json", "cli-config.json"].map((f) => join(homedir(), ".cursor", f));
const REAL_BEFORE = REAL.map(digest);
const DECOY_CCD = join(SANDBOX, "decoy-ccd");
const DECOY_XDG = join(SANDBOX, "decoy-xdg");
mkdirSync(DECOY_CCD, { recursive: true }); mkdirSync(join(DECOY_XDG, "cursor"), { recursive: true });
//  미끼에 **우리 규칙**도 넣는다 — LIVELY_HOME 격리를 무시하는 제거기는 원장 규칙을 여기서 걷어 지문이 바뀐다(격리 리뷰 #4:
//   사용자 규칙만 있던 미끼는 격리를 어긴 제거기도 «바꿀 게 없어» 그대로 둬서 아무것도 못 봤다).
writeFileSync(join(DECOY_CCD, "cli-config.json"), JSON.stringify({ permissions: { allow: ["Shell(decoy)", "Mcp(lively:whoami)"], deny: [] } }));
writeFileSync(join(DECOY_XDG, "cursor", "cli-config.json"), JSON.stringify({ permissions: { allow: ["Shell(decoy)", "Mcp(lively:whoami)"], deny: [] } }));
const DECOY_BEFORE = [digest(join(DECOY_CCD, "cli-config.json")), digest(join(DECOY_XDG, "cursor", "cli-config.json"))];

// ── 발행물 번들(publish() 배치 최소 재현 — grok-wiring 과 같은 방식) ──────────────────
const { HOOK_SCRIPTS: HOOKS, CURSOR_HOOK_EVENTS } = await import(pathToFileURL(join(KIT, "setup", "user-install.mjs")).href);
const { SETUP_FILES } = await import(pathToFileURL(join(KIT, "setup", "kit-manifest.mjs")).href);
function makeBundle({ autoApprove = ["mcp__lively__whoami", "mcp__lively__knowledge_get", "mcp__lively-local__lively_local_repo_list"], servers = [] } = {}) {
  rmSync(BUNDLE, { recursive: true, force: true });
  for (const d of [join(BUNDLE, ".claude", "hooks"), join(BUNDLE, ".lively"), join(BUNDLE, "setup"), join(BUNDLE, "cli")]) mkdirSync(d, { recursive: true });
  for (const h of HOOKS) cpSync(join(KIT, "hooks", h), join(BUNDLE, ".claude", "hooks", h));
  for (const f of SETUP_FILES) cpSync(join(KIT, "setup", f), join(BUNDLE, "setup", f));
  for (const f of ["lively.mjs", "lively-mcp-gateway.mjs"]) cpSync(join(KIT, "cli", f), join(BUNDLE, "cli", f));
  writeFileSync(join(BUNDLE, ".lively-org-name"), "테스트조직\n");
  writeFileSync(join(BUNDLE, ".lively", "auto-approve.json"), JSON.stringify({ allow: autoApprove }));
  writeFileSync(join(BUNDLE, ".lively", "mcp-servers.json"), JSON.stringify({ servers }));
}
function freshHome({ hooks = null, mcp = null, cli = null } = {}) {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, ".lively"), { recursive: true });
  writeFileSync(join(HOME, ".lively", "gateway-url"), "http://127.0.0.1:9\n"); // 토큰 없음 = 네트워크 미접촉
  if (hooks !== null || mcp !== null || cli !== null) mkdirSync(CURSOR, { recursive: true });
  if (hooks !== null) writeFileSync(HOOKSFILE, typeof hooks === "string" ? hooks : JSON.stringify(hooks, null, 2));
  if (mcp !== null) writeFileSync(MCPFILE, typeof mcp === "string" ? mcp : JSON.stringify(mcp, null, 2));
  if (cli !== null) writeFileSync(CLICFG, typeof cli === "string" ? cli : JSON.stringify(cli, null, 2));
}
// 설치마다 미끼 env 를 함께 준다 — LIVELY_HOME 격리가 그걸 무시해야 한다([C14]).
const ENV = () => ({ ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME, CURSOR_CONFIG_DIR: DECOY_CCD, XDG_CONFIG_HOME: DECOY_XDG });
function install() {
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "cursor", "--clone-root", BUNDLE], { env: ENV(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`설치기 exit=${r.status}\n${r.stderr || r.stdout}`);
  return `${r.stdout}${r.stderr}`;
}
function uninstall({ member = false } = {}) {
  const args = member ? [join(KIT, "setup", "user-uninstall.mjs"), "--harness", "cursor", "--yes"] : [join(KIT, "adapters", "cursor", "uninstall.mjs")];
  const r = spawnSync(process.execPath, args, { env: ENV(), encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const EVENTS = CURSOR_HOOK_EVENTS.map(([e]) => e);
const USER_ENTRY = { command: "./hooks/format.sh", timeout: 5 };

try {
  // [C1] hooks.json 없음 → version 숫자 + 배선 이벤트마다 우리 엔트리 정확히 1개(timeout 숫자).
  makeBundle(); freshHome(); install();
  {
    const h = readJson(HOOKSFILE);
    eq("C1a[C1] version 숫자", typeof h?.version, "number");
    eq("C1b[C1] 이벤트마다 우리 엔트리 1개", EVENTS.map((e) => ours(h?.hooks?.[e]).length), EVENTS.map(() => 1));
    eq("C1c[C1] timeout 은 양수(초)", EVENTS.every((e) => ours(h?.hooks?.[e]).every((x) => Number.isFinite(x.timeout) && x.timeout > 0)), true);
    // [C7] 우리 엔트리에 `//` 금지 — Cursor 의 순진한 주석 제거가 파일 전체를 죽인다(번들 실측).
    eq("C7[C7] 우리 hooks.json 에 // 없음", readFileSync(HOOKSFILE, "utf8").includes("//"), false);
    eq("C1d[C1] 어댑터 argv = Cursor 이벤트 이름", EVENTS.map((e) => ours(h?.hooks?.[e])[0]?.command.trim().endsWith(` ${e}`)), EVENTS.map(() => true));
  }
  // [C3] 멱등 — 두 번 설치해도 바이트 동일.
  {
    const before = [digest(HOOKSFILE), digest(MCPFILE)];
    install();
    eq("C3[C3] 두 번 설치 → 바이트 동일", [digest(HOOKSFILE), digest(MCPFILE)], before);
  }
  // [C2] 사용자 훅 보존(같은 이벤트·다른 이벤트·다른 최상위 키) · 우리 엔트리는 그 뒤.
  freshHome({ hooks: { version: 1, myKey: "keep", hooks: { sessionStart: [USER_ENTRY], afterFileEdit: [{ command: "./lint.sh" }] } } });
  install();
  {
    const h = readJson(HOOKSFILE);
    eq("C2a[C2] 같은 이벤트의 사용자 엔트리가 맨 앞에 그대로", h?.hooks?.sessionStart?.[0], USER_ENTRY);
    eq("C2b[C2] 우리 엔트리는 그 뒤 1개", [h?.hooks?.sessionStart?.length, ours(h?.hooks?.sessionStart).length], [2, 1]);
    eq("C2c[C2] 다른 이벤트·최상위 키 보존", [h?.hooks?.afterFileEdit, h?.myKey], [[{ command: "./lint.sh" }], "keep"]);
  }
  // [C4] 옛 표기 우리 엔트리(다른 node 경로) → 한 벌로 교체(누적 0).
  freshHome({ hooks: { version: 1, hooks: { stop: [{ command: `node "/old/home/.lively/hooks/cursor-adapter.mjs" stop`, timeout: 9 }] } } });
  install();
  eq("C4[C4] 옛 표기 교체 — stop 의 우리 엔트리 1개", ours(readJson(HOOKSFILE)?.hooks?.stop).length, 1);
  // [C5] JSON 이 아닌 hooks.json → 무수정.
  freshHome({ hooks: "{ not json" });
  { const d = digest(HOOKSFILE); install(); eq("C5[C5] 못 읽는 hooks.json 무수정", digest(HOOKSFILE), d); }
  // [C6] 배열이 아닌 이벤트 값(손상) → 그 이벤트만 건너뛰고 사용자 값 보존.
  freshHome({ hooks: { version: 1, hooks: { stop: "oops" } } });
  install();
  {
    const h = readJson(HOOKSFILE);
    eq("C6[C6] 손상 이벤트 보존 · 나머지는 배선", [h?.hooks?.stop, ours(h?.hooks?.sessionStart).length], ["oops", 1]);
  }
  // [C8] mcp.json — 사용자 서버 보존 · 우리 둘은 stdio 프록시 + LIVELY_HARNESS=cursor · env 값 전부 문자열(한 항목만 틀려도 파일 전체가 죽는다).
  // [C9] 사용자가 손으로 넣은 `lively`(url 형) → 덮고, 제거 때 원값 복원.
  const USER_LIVELY = { url: "https://example.lvly.io/mcp", headers: { Authorization: "Bearer ${env:LIVELY_TOKEN}" } };
  freshHome({ mcp: { mcpServers: { notion: { url: "https://mcp.notion.com/mcp" }, lively: USER_LIVELY } } });
  install();
  {
    const m = readJson(MCPFILE)?.mcpServers || {};
    eq("C8a[C8] 사용자 서버 보존", m.notion, { url: "https://mcp.notion.com/mcp" });
    eq("C8b[C8] lively·lively-local = stdio 프록시", [m.lively?.type, m.lively?.args, m["lively-local"]?.args, m.lively?.env?.LIVELY_HARNESS], ["stdio", ["mcp"], ["mcp-local"], "cursor"]);
    eq("C8c[C8] env 값 전부 문자열", Object.values(m).every((s) => !s.env || Object.values(s.env).every((v) => typeof v === "string")), true);
    eq("C9a[C9] 손으로 넣은 url 형 lively 는 stdio 로 교체", "url" in (m.lively || {}), false);
  }
  // [C10] cli-config.json 없음 → 만들지 않는다(CLI 가 첫 실행에 만든다).
  eq("C10[C10] cli-config.json 미생성", existsSync(CLICFG), false);
  // [C11] cli-config.json 있음 → Mcp(<server>:<tool>) 추가 · 사용자 규칙 보존 · deny 배열 보장.
  freshHome({ cli: { version: 1, editor: { vimMode: false }, permissions: { allow: ["Shell(git)"] } } });
  install();
  {
    const p = readJson(CLICFG)?.permissions || {};
    eq("C11[C11] 승인 규칙 반영 · 사용자 규칙 보존 · deny 배열",
      [p.allow, Array.isArray(p.deny)],
      [["Shell(git)", "Mcp(lively:whoami)", "Mcp(lively:knowledge_get)", "Mcp(lively-local:lively_local_repo_list)"], true]);
  }
  // [C12] 조직이 목록에서 뺀 규칙은 다음 설치에서 회수(사용자 규칙 불가침).
  makeBundle({ autoApprove: ["mcp__lively__whoami"] }); install();
  eq("C12[C12] 뺀 규칙 회수 · 사용자 규칙 유지", readJson(CLICFG)?.permissions?.allow, ["Shell(git)", "Mcp(lively:whoami)"]);
  // [C13] 제거 — **두 제거기**(kit 어댑터 · 멤버용 자립 user-uninstall — 실제 `lively uninstall` 경로)에 같은 표를 돌린다
  //  (격리 리뷰 #4: 멤버 제거기는 «우리 것만 있던 파일 삭제» 하나만 재서, 사용자 훅까지 지우는 변이도 초록이었다).
  //  우리 것만 사라진다 — 사용자 훅·서버·규칙 보존 · 손으로 넣었던 lively 복원 · env 미끼 무접촉.
  for (const member of [false, true]) {
    const who = member ? "멤버 제거기" : "kit 제거기";
    makeBundle();
    freshHome({ hooks: { version: 1, hooks: { sessionStart: [USER_ENTRY] } }, mcp: { mcpServers: { notion: { url: "https://mcp.notion.com/mcp" }, lively: USER_LIVELY } }, cli: { permissions: { allow: ["Shell(git)"], deny: [] } } });
    install();
    const r = uninstall({ member });
    const h = readJson(HOOKSFILE); const m = readJson(MCPFILE)?.mcpServers || {}; const p = readJson(CLICFG)?.permissions || {};
    eq(`C13a[C13] ${who} exit 0`, r.status, 0);
    eq(`C13b[C13] ${who} — 사용자 훅만 남음`, h?.hooks, { sessionStart: [USER_ENTRY] });
    eq(`C13c[C13] ${who} — lively-local 제거 · notion 보존 · 손으로 넣은 lively 복원`, [m["lively-local"], m.notion?.url, m.lively], [undefined, "https://mcp.notion.com/mcp", USER_LIVELY]);
    eq(`C13d[C13] ${who} — 승인 규칙은 사용자 것만`, p.allow, ["Shell(git)"]);
    eq(`C13f[C13] ${who} — CURSOR_CONFIG_DIR·XDG 미끼 무접촉`, [digest(join(DECOY_CCD, "cli-config.json")), digest(join(DECOY_XDG, "cursor", "cli-config.json"))], DECOY_BEFORE);
    // [C13e] 우리 엔트리뿐이던 hooks.json 은 지운다(설치↔제거 대칭).
    freshHome(); install();
    const r2 = uninstall({ member });
    eq(`C13e[C13] ${who} — 우리 것만 있던 hooks.json 삭제`, [r2.status, existsSync(HOOKSFILE)], [0, false]);
    // [C17] 설치 뒤 사용자가 mcpServers 를 깨뜨림 → 무수정({} 로 갈아끼우면 사용자 값이 사라진다).
    freshHome(); install();
    writeFileSync(MCPFILE, JSON.stringify({ mcpServers: "oops" }));
    { const d = digest(MCPFILE); uninstall({ member }); eq(`C17[C17] ${who} — 깨진 mcpServers 무수정`, digest(MCPFILE), d); }
  }

  // [C15] 조직 MCP 서버(번들 mcp-servers.json) — stdio 는 명령을 나눠 싣고 · url 형은 보류 · 이름 규칙 밖·꺼진 것은 건너뛰고 ·
  //  우리 이름(lively)은 못 덮는다. 조직이 뺀 서버는 다음 설치에서 원장으로 회수(사용자 서버 불가침).
  makeBundle({ servers: [
    { name: "gh", transport: "stdio", command: "npx -y @org/gh-mcp --ro" },
    { name: "remote", transport: "http", url: "https://mcp.example.com/mcp" },
    { name: "bad name!", transport: "stdio", command: "x" },
    { name: "off", transport: "stdio", command: "y", enabled: false },
    { name: "lively", transport: "stdio", command: "evil" },
  ] });
  freshHome({ mcp: { mcpServers: { notion: { url: "https://mcp.notion.com/mcp" } } } });
  install();
  {
    const m = readJson(MCPFILE)?.mcpServers || {};
    eq("C15a[C15] stdio 조직 서버 = 명령 분해", m.gh, { type: "stdio", command: "npx", args: ["-y", "@org/gh-mcp", "--ro"] });
    eq("C15b[C15] url 형·이름 위반·꺼짐은 안 실음 · 우리 이름 불가침", [m.remote, m["bad name!"], m.off, m.lively?.args], [undefined, undefined, undefined, ["mcp"]]);
  }
  makeBundle({ servers: [] }); install();
  {
    const m = readJson(MCPFILE)?.mcpServers || {};
    eq("C15c[C15] 조직이 뺀 서버 회수 · 사용자 서버·우리 서버 유지", [m.gh, m.notion?.url, m.lively?.args], [undefined, "https://mcp.notion.com/mcp", ["mcp"]]);
  }
  makeBundle();

  // [C16] 모양이 틀린 사용자 파일 — 설치기는 셋 다 무수정(격리 리뷰 #8: 종전엔 우리 값으로 갈아끼웠다).
  freshHome({ hooks: { version: 1, hooks: "oops" }, mcp: { mcpServers: ["x"] }, cli: { permissions: { allow: "oops" } } });
  {
    const before = [digest(HOOKSFILE), digest(MCPFILE), digest(CLICFG)];
    install();
    eq("C16a[C16] hooks 객체 아님 · mcpServers 배열 · allow 문자열 → 셋 다 무수정", [digest(HOOKSFILE), digest(MCPFILE), digest(CLICFG)], before);
  }
  for (const [tag, cli] of [["C16b", { permissions: "oops" }], ["C16c", { permissions: { allow: [], deny: "x" } }]]) {
    freshHome({ cli });
    const d = digest(CLICFG); install();
    eq(`${tag}[C16] cli-config ${JSON.stringify(cli)} → 무수정`, digest(CLICFG), d);
  }

  // [C19] «우리 엔트리» 판정 다섯 벌(설치기·두 제거기·CLI·자가 업데이트)이 같은 표본에 같은 답을 낸다(격리 리뷰 #9).
  //  자립 규약 때문에 사본이 다섯이다 — 하나라도 다르게 답하면 설치·제거·감지가 서로 다른 것을 «우리 것» 으로 본다.
  {
    const FILES = ["setup/user-install.mjs", "setup/user-uninstall.mjs", "adapters/cursor/uninstall.mjs", "cli/lively.mjs", "hooks/self-update.mjs"];
    const LIT = /\/\[\/\\\\\]\\\.lively\[\/\\\\\]hooks\[\/\\\\\]cursor-adapter\\\.mjs(?:\\b)?\//g;
    const SAMPLES = [
      `"/opt/n/bin/node" "/home/u/.lively/hooks/cursor-adapter.mjs" stop`,
      `node "C:/Users/u/.lively/hooks/cursor-adapter.mjs" preToolUse`,
      `node C:\\Users\\u\\.lively\\hooks\\cursor-adapter.mjs stop`,
      `node /x/.lively/hooks/cursor-adapter.mjsx stop`,
      `node /x/lively/hooks/cursor-adapter.mjs stop`,
      `./hooks/format.sh`,
    ];
    const vectors = FILES.map((f) => {
      const lits = [...readFileSync(join(KIT, f), "utf8").matchAll(LIT)].map((m) => m[0]);
      return [f, lits.length, lits.map((l) => SAMPLES.map((x) => (new RegExp(l.slice(1, -1)).test(x) ? "1" : "0")).join(""))];
    });
    eq("C19a[C19] 다섯 곳 모두 판정 정규식이 있다", vectors.filter(([, n]) => n < 1).map(([f]) => f), []);
    const all = vectors.flatMap(([, , v]) => v);
    eq("C19b[C19] 다섯 곳이 같은 답(표본 6개)", [...new Set(all)].length === 1 ? all[0] : vectors.map(([f, , v]) => `${f}=${v.join("/")}`), "111000");
  }
  // [C14] 실 홈·미끼 무접촉.
  eq("C14a[C14] 실 ~/.cursor 무접촉", REAL.map(digest), REAL_BEFORE);
  eq("C14b[C14] CURSOR_CONFIG_DIR·XDG 미끼 무접촉", [digest(join(DECOY_CCD, "cli-config.json")), digest(join(DECOY_XDG, "cursor", "cli-config.json"))], DECOY_BEFORE);

  // ── D5~D7 매 세션 승인 reconcile(session-preload) — 설치기와 같은 원장·같은 규칙 ──
  const { reconcileCursorAutoApprove } = await import(pathToFileURL(join(KIT, "hooks", "session-preload.mjs")).href);
  const DIR = join(SANDBOX, "rc-lively"); mkdirSync(DIR, { recursive: true });
  const F = join(SANDBOX, "rc-cli-config.json");
  rmSync(F, { force: true });
  eq("D5[D5] 파일 없음 → 만들지 않음", [reconcileCursorAutoApprove(DIR, ["mcp__lively__whoami"], F), existsSync(F)], [false, false]);
  writeFileSync(F, JSON.stringify({ permissions: { allow: "notalist" } }));
  { const d = digest(F); eq("D6[D6] allow 가 배열 아님 → 손대지 않음", [reconcileCursorAutoApprove(DIR, ["mcp__lively__whoami"], F), digest(F)], [false, d]); }
  for (const [tag, cfg] of [["D6b", { permissions: "oops" }], ["D6c", { permissions: { allow: [], deny: "x" } }]]) {
    writeFileSync(F, JSON.stringify(cfg));
    const d = digest(F);
    eq(`${tag}[D6] ${JSON.stringify(cfg)} → 손대지 않음(설치기와 같은 규칙)`, [reconcileCursorAutoApprove(DIR, ["mcp__lively__whoami"], F), digest(F)], [false, d]);
  }
  writeFileSync(F, JSON.stringify({ permissions: { allow: ["Shell(ls)"], deny: [] } }));
  eq("D7a[D7] 정상 → 반영", [reconcileCursorAutoApprove(DIR, ["mcp__lively__whoami", "mcp__notion__x"], F), readJson(F)?.permissions?.allow], [true, ["Shell(ls)", "Mcp(lively:whoami)"]]);
  { const d = digest(F); eq("D7b[D7] 변화 없음 → 무기록", [reconcileCursorAutoApprove(DIR, ["mcp__lively__whoami"], F), digest(F)], [false, d]); }
  eq("D7c[D7] 뺀 것 회수 · 사용자 규칙 유지", [reconcileCursorAutoApprove(DIR, [], F), readJson(F)?.permissions?.allow], [true, ["Shell(ls)"]]);
} finally {
  rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${fail ? "✗" : "✓"} cursor-wiring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
