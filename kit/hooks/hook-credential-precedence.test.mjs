#!/usr/bin/env node
// 훅의 자격·주소 우선순위 사양테스트 (#959 — #916·#2617 의 훅 판).
//
//  규칙(정본 주석: hooks/session-preload.mjs 의 «훅의 자격·주소 우선순위»):
//   · 사람이 연 셸(LIVELY_SESSION_ID 없음) — **파일이 env 를 이긴다.** env 는 설치기가 rc 에 심은
//     `export LIVELY_TOKEN="$(cat ~/.lively/token)"` 의 스냅샷이라 재로그인·주소 변경 뒤엔 옛 값이다.
//   · 라이블리가 띄운 pane(LIVELY_SESSION_ID 있음) — **env 가 파일을 이긴다.** 거기 env 는 띄운 쪽이 그 세션 몫으로
//     실은 값이다: 공유 홈 박스의 세션 훅 토큰(#1719, terminal/sessions.ts) · 위탁 판의 게이트웨이 주소(#4012 T5,
//     node/tasks.ts). 파일은 그 머신의 로컬 로그인이라, 파일이 이기면 훅이 키트를 깐 사람 신원·남의 워크스페이스로 나간다.
//   · self-update 는 예외 — 세션이 아니라 이 머신의 **키트 설치**를 다루므로 어디서든 파일(= `lively` CLI 와 같은 출처)이다.
//   · 고른 칸이 비면 다른 칸으로 폴백한다(플러그인·프로비저닝·CI). 주소와 토큰은 **칸마다 따로** 고른다.
//
//  왜 **실행** 시험인가: 규칙이 «한 줄 안의 || 순서» 가 아니라 «그 pane 을 누가 띄웠나» 로 갈린다. 줄 모양만 보는 정적
//   검사는 두 갈래 중 한쪽만 고정할 수밖에 없고, 실제로 이 PR 의 첫 판(정적 검사)은 «어디서든 파일» 을 고정해
//   #1719·#4012 의 의도적 주입을 조용히 무력화하는 판을 초록으로 통과시켰다. 그래서 훅을 실제 프로세스로 띄우고,
//   스텁 게이트웨이(env 주소 · 파일 주소 · 플러그인 주소) 중 **어느 쪽이 · 어떤 토큰으로** 불렸는지를 본다.
//  ⓪ 은 자격 파일을 읽는 훅이 새로 생기면 이 표에 올리라고 빨간불을 켠다(목록을 손으로 맞출 일을 기계가 지킨다).
//
//  실행: node kit/hooks/hook-credential-precedence.test.mjs   (exit 0=통과, 1=실패). 루프백 스텁만 쓴다.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv, WIN } from "../testlib/os-sandbox.mjs";

const HOOKS = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why = "") => (cond ? ok(n) : bad(n, why));

// 훅마다 «어떻게 부르면 게이트웨이를 한 번 치는가». rule: pane = 누가 띄웠나로 갈림 · file = 어디서든 파일.
//  boxOnly = box pane(라이블리가 띄운 세션)에서만 보고한다 — 사람이 연 셸에선 요청이 **없어야** 한다.
const SID = "3f1b2c4d-0000-4000-8000-000000000001";
const HOOK_CASES = [
  { hook: "session-preload.mjs", args: [], stdin: { session_id: SID, hook_event_name: "SessionStart", source: "startup" },
    path: "/api/ui/org/preview", rule: "pane" },
  { hook: "run-custom.mjs", args: ["UserPromptSubmit"], stdin: { session_id: SID, prompt: "자격 우선순위 시험 입력입니다" },
    path: "/api/ui/org/runner/hooks", rule: "pane" },
  { hook: "sync-harness-assets.mjs", args: [], stdin: {}, path: "/api/ui/org/runner/assets", rule: "pane" },
  { hook: "usage-report.mjs", args: [], stdin: { session_id: SID, rate_limits: { five_hour: { used_percentage: 12, resets_at: 1 } } },
    path: "/api/ui/terminal/usage", rule: "pane" },
  { hook: "work-flag.mjs", args: [], stdin: { session_id: SID, hook_event_name: "SessionStart" },
    path: "/claude-uuid", rule: "pane", boxOnly: true },
  // work-flag 의 정상종료 보고는 SessionStart 와 **다른 분기**다(자격을 따로 고른다) — 첫 판이 여기서도 파일을 우선했다.
  { hook: "work-flag.mjs", args: [], stdin: { session_id: SID, hook_event_name: "SessionEnd", reason: "prompt_input_exit" },
    path: "/exited", rule: "pane", boxOnly: true },
  { hook: "self-update.mjs", args: [], stdin: null, path: "/api/ui/org/runtime-config", rule: "file" },
];

// ⓪ 자격 파일(token)을 읽는 훅은 전부 표에 있어야 한다.
{
  const readsToken = readdirSync(HOOKS)
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .filter((f) => /\w+\(\s*["']token["']\s*\)/.test(readFileSync(join(HOOKS, f), "utf8")));
  const missing = readsToken.filter((f) => !HOOK_CASES.some((c) => c.hook === f));
  check(`⓪ 자격 파일을 읽는 훅 ${readsToken.length}개가 전부 이 표에 있다`, readsToken.length > 0 && missing.length === 0,
    `표에 없는 훅: ${missing.join(", ") || "(자격 파일을 읽는 훅을 하나도 못 찾았다 — 판정식이 낡았다)"} — 규칙(pane/file)을 정해 HOOK_CASES 에 올려라`);
}

if (WIN) {
  // 훅 진입 판정(usage-report 의 `file://${argv[1]}` 비교 등)이 POSIX 경로를 전제한다. 규칙 자체는 플랫폼 무관이라
  //  리눅스·맥 CI 가 판정을 대신한다(task-spawn-gateway-env 와 같은 선택).
  console.log("skip  윈도우 — 훅 실행 시험은 POSIX 에서 판정한다");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const TOK = { env: "tok-from-env", file: "tok-from-file", plugin: "tok-from-plugin" };

// 엣지 표(사양) — 행마다: 입력 조합과, 규칙별 기대 { gw: 어느 스텁, tok: 어느 토큰 } (null = 요청 없음).
//  box 전용 보고의 기대는 pane 규칙과 같되, 사람이 연 셸에선 null 이다.
const ENVF = { tok: true, gw: true };
const MODES = [
  { key: "M1 셸 · 파일 있음", sid: "", files: true, env: ENVF,
    pane: { gw: "file", tok: "file" }, file: { gw: "file", tok: "file" } },
  { key: "M2 라이블리 pane · 파일 있음", sid: "box-credtest-1", files: true, env: ENVF,
    pane: { gw: "env", tok: "env" }, file: { gw: "file", tok: "file" } },
  { key: "M3 셸 · 파일 없음", sid: "", files: false, env: ENVF,
    pane: { gw: "env", tok: "env" }, file: { gw: "env", tok: "env" } },
  { key: "M4 라이블리 pane · 파일 없음", sid: "box-credtest-1", files: false, env: ENVF,
    pane: { gw: "env", tok: "env" }, file: { gw: "env", tok: "env" } },
  { key: "M5 셸 · LIVELY_SESSION_ID 공백", sid: "   ", files: true, env: ENVF,
    pane: { gw: "file", tok: "file" }, file: { gw: "file", tok: "file" } },
  { key: "M6 라이블리 pane · env 주입 없음", sid: "box-credtest-1", files: true, env: { tok: false, gw: false },
    pane: { gw: "file", tok: "file" }, file: { gw: "file", tok: "file" } },
  { key: "M7 라이블리 pane · env 는 주소만", sid: "box-credtest-1", files: true, env: { tok: false, gw: true },
    pane: { gw: "env", tok: "file" }, file: { gw: "file", tok: "file" } },
  { key: "M8 셸 · 플러그인 옵션", sid: "", files: true, env: ENVF, plugin: true, only: "session-preload.mjs",
    pane: { gw: "plugin", tok: "plugin" } },
  { key: "M9 라이블리 pane · 플러그인 옵션", sid: "box-credtest-1", files: true, env: ENVF, plugin: true, only: "session-preload.mjs",
    pane: { gw: "env", tok: "env" } },
  //  pane 에서도 플러그인은 파일보다 앞이다(env 가 비었을 때) — M9 는 env 가 이겨 이 순서를 못 본다.
  { key: "M10 라이블리 pane · env 없음 · 플러그인 옵션", sid: "box-credtest-1", files: true, env: { tok: false, gw: false }, plugin: true,
    only: "session-preload.mjs", pane: { gw: "plugin", tok: "plugin" } },
];

// 스텁 게이트웨이 — 받은 요청을 적고 404 로 답한다(훅은 전부 fail-open). 러너 훅 목록에만 본문 훅 하나를 준다:
//  그 훅은 자기 env 의 토큰·주소를 찍어, 러너가 고른 값을 **본문 훅도** 물려받는지 보여 준다(사양 C1).
const ECHO_HOOK = 'process.stdout.write("CHILD token=" + (process.env.LIVELY_TOKEN || "") + " gw=" + (process.env.LIVELY_GATEWAY_URL || "") + "\\n");\n';
function stub(label, log) {
  const srv = createServer((req, res) => {
    log.push({ gw: label, path: String(req.url || "").split("?")[0], auth: String(req.headers.authorization || "") });
    if (String(req.url || "").startsWith("/api/ui/org/runner/hooks")) {
      const hook = { id: "echo-cred", event: "UserPromptSubmit", source_code: ECHO_HOOK, timeout_sec: 5,
        content_hash: createHash("sha256").update(ECHO_HOOK).digest("hex") };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hooks: [hook] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}
const urlOf = (srv) => `http://127.0.0.1:${srv.address().port}`;

function runHook(file, args, stdin, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HOOKS, file), ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const kill = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => { clearTimeout(kill); resolve({ code, out, err }); });
    child.stdin.on("error", () => { /* 훅이 stdin 을 안 읽고 끝나도 시험은 이어간다 */ });
    child.stdin.end(stdin == null ? "" : JSON.stringify(stdin));
  });
}

// 한 행 × 한 훅 — 스텁을 따로 세우므로 행끼리 병렬로 돌아도 기록이 섞이지 않는다.
async function runCase(mode, c) {
  const log = [];
  const gws = { env: await stub("env", log), file: await stub("file", log), plugin: await stub("plugin", log) };
  const home = mkdtempSync(join(tmpdir(), "lv-cred-home-"));
  const tmp = mkdtempSync(join(tmpdir(), "lv-cred-tmp-"));
  try {
    mkdirSync(join(home, ".lively"), { recursive: true });
    if (mode.files) {
      writeFileSync(join(home, ".lively", "token"), TOK.file + "\n", { mode: 0o600 });
      writeFileSync(join(home, ".lively", "gateway-url"), urlOf(gws.file) + "\n");
    }
    const env = {
      ...process.env, ...sandboxEnv({ home, tmp }),
      LIVELY_HOME: home,
      LIVELY_HOST_EFFECTS: "deny", LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox",   // 루프백 스텁만 허용
      LIVELY_TOKEN: mode.env.tok ? TOK.env : "",
      LIVELY_GATEWAY_URL: mode.env.gw ? urlOf(gws.env) : "",
      LIVELY_SESSION_ID: mode.sid,
      LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_NO_AUTO_UPDATE: "", LIVELY_HARNESS: "",
      CLAUDE_PLUGIN_OPTION_TOKEN: mode.plugin ? TOK.plugin : "",
      CLAUDE_PLUGIN_OPTION_GATEWAY_URL: mode.plugin ? urlOf(gws.plugin) : "",
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    };
    const r = await runHook(c.hook, c.args, c.stdin, env);
    return { r, log, urls: { env: urlOf(gws.env), file: urlOf(gws.file), plugin: urlOf(gws.plugin) } };
  } finally {
    for (const s of Object.values(gws)) s.close();
    for (const d of [home, tmp]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
}

const jobs = [];
for (const mode of MODES) {
  for (const c of HOOK_CASES) {
    if (mode.only && mode.only !== c.hook) continue;
    const spawned = !!mode.sid.trim();
    const want = c.boxOnly && !spawned ? null : mode[c.rule];
    jobs.push({ mode, c, want });
  }
}

// 동시에 몇 개씩 — 훅 하나가 수백 ms 라 직렬이면 러너 예산(45초)에 붙는다.
const results = new Array(jobs.length);
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < jobs.length) {
    const i = next++;
    results[i] = await runCase(jobs[i].mode, jobs[i].c);
  }
}));

jobs.forEach(({ mode, c, want }, i) => {
  const { r, log, urls } = results[i];
  const hits = log.filter((h) => h.path.endsWith(c.path));
  const name = `${mode.key} · ${c.hook}${c.stdin?.hook_event_name ? `(${c.stdin.hook_event_name})` : ""}`;
  if (!want) {
    check(`${name} → 요청 없음`, hits.length === 0,
      `요청 ${hits.length}건: ${hits.map((h) => `${h.gw} ${h.auth}`).join(" · ")}`);
    return;
  }
  const wrong = hits.filter((h) => h.gw !== want.gw || h.auth !== `Bearer ${TOK[want.tok]}`);
  check(`${name} → ${want.gw} 주소 · ${want.tok} 토큰`, hits.length > 0 && wrong.length === 0,
    hits.length === 0
      ? `${c.path} 요청이 없다(exit=${r.code}) stderr=${r.err.slice(-300)}`
      : `엇나간 요청: ${wrong.map((h) => `${h.gw} ${h.auth}`).join(" · ")}`);
  // 사양 C1 — 러너가 고른 신원·주소를 본문 훅도 물려받는다.
  if (c.hook === "run-custom.mjs") {
    const line = `CHILD token=${TOK[want.tok]} gw=${urls[want.gw]}`;
    check(`${name} → 본문 훅도 같은 신원·주소`, r.out.includes(line),
      `stdout=${JSON.stringify(r.out.slice(0, 300))} (기대 ${line})`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
