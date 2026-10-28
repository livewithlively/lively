#!/usr/bin/env node
// 하네스 주입 프롬프트 표시 사양테스트 — 판정 모듈 · 러너 표시 · 시드 훅 침묵을 함께 고정한다.
//  하네스가 밀어 넣은 메시지(작업 끝 알림·하위 에이전트 보고·슬래시 래퍼·리마인더)도 UserPromptSubmit 의 prompt 로 온다.
//  사람 의도에 반응하는 훅이 여기에 반응하면 엉뚱한 위탁·핸드오버·이름짓기 안내가 끼어든다.
//  실행: node scripts/run-tests.mjs prompt-origin (직접 실행하려면 LIVELY_HOST_EFFECTS_TEST_MODE=sandbox 필요 —
//   러너 하네스가 심는 LIVELY_HOST_EFFECTS=deny 가 그 값 없이는 훅 자식 spawn 까지 막는다)
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { INJECTED_PROMPT_RE, isInjectedPrompt } from "./prompt-origin.mjs";
import { SANDBOX, ok, bad, run, dbg, finish } from "../testlib/run-custom-harness.mjs";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

// 사양이 이름으로 정한 접두 — web/lib/ask-text.ts 정본의 일부다. 정본 전체는 §M4 가 덮는다.
const SPEC_PREFIXES = [
  "<command-name", "<local-command-", "<command-message", "<command-args", "<bash-",
  "<task-notification", "<system-reminder", "<agent-message",
  "[Request interrupted", "Caveat:", "This session is being continued",
  "Another Claude session sent a message",
];

// ── §M1 접두로 시작하면 주입이다(앞 공백은 건너뛴다) ──
{
  const rows = SPEC_PREFIXES.flatMap((p) => [`${p}>본문`, ` \n\t ${p}>본문`]);
  const wrong = rows.filter((s) => isInjectedPrompt(s) !== true);
  wrong.length === 0
    ? ok(`M1 사양 접두 ${SPEC_PREFIXES.length}종 × (맨앞·앞공백) ${rows.length}행이 주입으로 판정된다`)
    : bad("M1 접두 시작 = 주입", `false 로 나온 입력: ${JSON.stringify(wrong)}`);
}

// ── §M2 사람 말 — 접두가 본문 중간에만 있거나 비어 있으면 false ──
{
  const rows = [
    ...SPEC_PREFIXES.map((p) => `이 메시지 가운데 ${p} 가 들어 있다`),
    "평범한 사람 지시입니다",
    "", undefined, null,
  ];
  const wrong = rows.filter((s) => isInjectedPrompt(s) !== false);
  wrong.length === 0
    ? ok(`M2 중간에 접두가 있는 말·평문·빈 문자열·undefined·null ${rows.length}행은 사람 말(false)이다`)
    : bad("M2 사람 말 = false", `true 로 나온 입력: ${JSON.stringify(wrong)}`);
}

// ── §M4 서버 판별식(INJECTED_RE) 두 벌의 접두는 전부 이 모듈도 주입으로 본다 ──
//  TS 를 import 할 수 없어 선언 한 줄을 텍스트로 읽는다. 어느 쪽에 접두가 늘면 이 시험이 따라 늘어난다.
for (const rel of [["src", "terminal", "terminal-transcript.ts"], ["web", "lib", "ask-text.ts"]]) {
  const ts = readFileSync(join(REPO, ...rel), "utf8");
  const m = ts.match(/^export const INJECTED_RE = \/\^\\s\*\((.+)\)\/;\s*$/m);
  const at = rel.join("/");
  if (!m) { bad(`M4 ${at} INJECTED_RE 선언`, "`export const INJECTED_RE = /^\\s*(…)/;` 한 줄을 찾지 못했다"); continue; }
  const serverRe = new RegExp(`^\\s*(${m[1]})`);
  // 대안 하나하나는 리터럴 접두다(정규식 이스케이프만 걷어낸다).
  const alts = m[1].split("|").map((x) => x.replace(/\\(.)/g, "$1"));
  const samples = alts.map((x) => `${x} 서버 접두 표본`);
  const notServer = samples.filter((x) => !serverRe.test(x)); // 표본 생성이 틀렸으면 시험 자체가 무의미하다
  const missed = samples.filter((x) => !isInjectedPrompt(x));
  alts.length > 0 && notServer.length === 0 && missed.length === 0 && INJECTED_PROMPT_RE instanceof RegExp
    ? ok(`M4 ${at} 접두 ${alts.length}종을 이 모듈도 전부 주입으로 본다`)
    : bad(`M4 ${at} 접두 포함`, `alts=${JSON.stringify(alts)} 표본불일치=${JSON.stringify(notServer)} 놓침=${JSON.stringify(missed)}`);
}

// ── 러너: 훅이 받은 stdin 을 그대로 되돌려 보는 훅 ──
//  base64 로 감싸 러너가 출력을 어떻게 포장해도 원문을 복원한다. 프로세스 경로·스레드(seed) 경로 둘 다 심는다 —
//  표시를 읽어야 하는 라우터들이 실제로는 시드 훅(스레드)으로 돈다.
const echoSrc = (tag) => 'let d = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; });\n'
  + `process.stdin.on("end", () => { process.stdout.write(${JSON.stringify(`<<${tag}:`)} + Buffer.from(d, "utf8").toString("base64") + ">> "); });\n`;
// 도구 이벤트는 하네스 계약상 JSON 출력만 받는다 — 같은 되돌림을 hookSpecificOutput.additionalContext 에 싣는다.
const echoJsonSrc = (tag, event) => 'let d = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; });\n'
  + `process.stdin.on("end", () => { const ctx = ${JSON.stringify(`<<${tag}:`)} + Buffer.from(d, "utf8").toString("base64") + ">>"; `
  + `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ${JSON.stringify(event)}, additionalContext: ctx } })); });\n`;
const ECHO_HOOKS = [{ id: "echo-proc", src: echoSrc("PROC") }, { id: "echo-seed", seed: true, src: echoSrc("SEED") }];
function received(r, tag) {
  const m = r.stdout.match(new RegExp(`<<${tag}:([A-Za-z0-9+/=]*)>>`));
  if (!m) return undefined;
  try { return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); } catch { return undefined; }
}

// ── §R1 주입 프롬프트면 각 훅 stdin 에 lively_prompt_injected:true 가 더해지고 나머지는 그대로다(훅은 건너뛰지 않는다) ──
{
  const payload = { session_id: "s1", prompt: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>', cwd: "/x", extra: { k: [1, 2] } };
  const r = run("UserPromptSubmit", ECHO_HOOKS, { payload });
  const fails = ["PROC", "SEED"].flatMap((tag) => {
    const got = received(r, tag);
    if (!got) return [`${tag}: 훅이 실행되지 않았거나 stdin 을 복원 못 함`];
    const { lively_prompt_injected: flag, ...rest } = got;
    const out = [];
    if (flag !== true) out.push(`${tag}: lively_prompt_injected=${JSON.stringify(flag)}`);
    for (const [k, v] of Object.entries(payload)) if (!isDeepStrictEqual(rest[k], v)) out.push(`${tag}: ${k} 가 바뀌었다 ${JSON.stringify(rest[k])}`);
    return out;
  });
  r.status === 0 && fails.length === 0
    ? ok("R1 주입 프롬프트 — 프로세스·스레드 훅 모두 실행되고 stdin 에 lively_prompt_injected:true, 나머지 필드는 원래 값")
    : bad("R1 주입 표시", `${fails.join(" / ")} | ${dbg(r)}`);
}

// ── §R2 사람 말이면 훅 stdin 에 표시 키가 없다 ──
{
  const payload = { session_id: "s1", prompt: "이 함수 리팩터링해 줘 <system-reminder> 라는 말이 중간에 있어도", cwd: "/x" };
  const r = run("UserPromptSubmit", ECHO_HOOKS, { payload });
  const fails = ["PROC", "SEED"].flatMap((tag) => {
    const got = received(r, tag);
    if (!got) return [`${tag}: stdin 복원 못 함`];
    const out = [];
    if ("lively_prompt_injected" in got) out.push(`${tag}: 표시 키가 있다(${JSON.stringify(got.lively_prompt_injected)})`);
    for (const [k, v] of Object.entries(payload)) if (!isDeepStrictEqual(got[k], v)) out.push(`${tag}: ${k} 가 바뀌었다`);
    return out;
  });
  r.status === 0 && fails.length === 0
    ? ok("R2 사람 말 — 훅 stdin 에 lively_prompt_injected 키가 없고 입력 그대로다")
    : bad("R2 사람 말 무표시", `${fails.join(" / ")} | ${dbg(r)}`);
}

// ── §R3 다른 이벤트엔 prompt 가 주입처럼 생겨도 표시를 싣지 않는다 ──
{
  const rows = [
    ["PreToolUse", { session_id: "s1", tool_name: "Write", tool_input: { file_path: "/x/a.ts", content: "x" }, prompt: "<system-reminder>x" }],
    ["PostToolUse", { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "" }, prompt: "<task-notification>x" }],
  ];
  const fails = rows.flatMap(([event, payload]) => {
    const r = run(event, [{ id: "echo-proc", src: echoJsonSrc("PROC", event) }], { payload });
    const got = received(r, "PROC");
    if (!got) return [`${event}: stdin 복원 못 함 | ${dbg(r)}`];
    return "lively_prompt_injected" in got ? [`${event}: 표시 키가 실렸다`] : [];
  });
  fails.length === 0
    ? ok(`R3 ${rows.map((x) => x[0]).join("·")} 엔 주입처럼 생긴 prompt 가 있어도 표시를 싣지 않는다`)
    : bad("R3 다른 이벤트 무표시", fails.join(" / "));
}

// ── 시드 훅을 실제 프로세스로 띄운다 ──
const HOOK_TMP = join(SANDBOX, "seed-tmp");
mkdirSync(HOOK_TMP, { recursive: true });
const SEED_ENV = {
  ...process.env, ...offlineLivelyEnv(),
  LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "",
  // 억제 env 를 비운다 — 상속되면 훅이 통째로 침묵해 '표시 때문에 침묵' 단언이 공짜로 통과한다(대조군이 잡는다).
  LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_MODE: "", LIVELY_TASK_WS: "", LIVELY_SESSION_LABEL_SOURCE: "",
  LIVELY_HARNESS: "claude", CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CLAUDE_SESSION_ID: "",
  TMPDIR: HOOK_TMP, TEMP: HOOK_TMP, TMP: HOOK_TMP,
};
function runSeed(id, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, "examples", `${id}.org-hook.mjs`)], { env: { ...SEED_ENV, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const t = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify(input));
  });
}
let seq = 0;
const ups = (prompt, extra = {}) => ({ session_id: `prompt-origin-${process.pid}-${seq++}`, hook_event_name: "UserPromptSubmit", cwd: SANDBOX, prompt, ...extra });

// ── §S1 라우터 3종: 표시가 있으면 무출력, 없으면 트리거 말에 additionalContext ──
{
  const rows = [
    ["delegate-router", "이 풀빌드 워커에 위탁해서 돌려줘"],
    ["blind-diff-router", "이 MR 코드 변경만으로 기능 유추해봐 blind 로"],
    ["next-session-handover-router", "다음 세션으로 핸드오버 준비해줘"],
  ];
  const fails = [];
  for (const [id, prompt] of rows) {
    const plain = await runSeed(id, ups(prompt));
    const flagged = await runSeed(id, ups(prompt, { lively_prompt_injected: true }));
    if (plain.code !== 0 || !plain.stdout.includes("additionalContext")) fails.push(`${id} 대조군(표시 없음)에 additionalContext 가 없다: code=${plain.code} out=${JSON.stringify(plain.stdout.slice(0, 200))} err=${JSON.stringify(plain.stderr.slice(0, 200))}`);
    if (flagged.code !== 0 || flagged.stdout.trim() !== "") fails.push(`${id} 표시가 있는데 출력했다: code=${flagged.code} out=${JSON.stringify(flagged.stdout.slice(0, 200))}`);
  }
  fails.length === 0
    ? ok(`S1 라우터 ${rows.length}종 — 트리거 말에 표시 없으면 안내, lively_prompt_injected:true 면 무출력`)
    : bad("S1 라우터 침묵", fails.join(" / "));
}

// ── §S2 session-name-ask: 표시가 있으면 이름짓기 안내를 내지 않는다 ──
{
  const prompt = "앱 16 에서 한글이 다 분해돼서 보입니다";
  const guided = (out) => /session_rename/.test(out);
  const pIn = ups(prompt), fIn = ups(prompt, { lively_prompt_injected: true });
  const plain = await runSeed("session-name-ask", pIn, { LIVELY_SESSION_ID: pIn.session_id });
  const flagged = await runSeed("session-name-ask", fIn, { LIVELY_SESSION_ID: fIn.session_id });
  plain.code === 0 && guided(plain.stdout) && flagged.code === 0 && !guided(flagged.stdout)
    ? ok("S2 session-name-ask — 같은 말이라도 lively_prompt_injected:true 면 이름짓기 안내가 없다(대조군은 안내)")
    : bad("S2 session-name-ask 침묵", `plain code=${plain.code} out=${JSON.stringify(plain.stdout.slice(0, 200))} | flagged code=${flagged.code} out=${JSON.stringify(flagged.stdout.slice(0, 200))}`);
}

// ── §S3 knowledge-recall: 표시가 있으면 게이트웨이를 부르지 않고 무출력 ──
//  토큰 없는 환경에선 원래도 안 부르니 관측이 안 된다 → 127.0.0.1 가짜 게이트웨이를 세워 호출 여부를 센다.
//  대조군(표시 없음)이 실제로 호출해야 이 시험이 의미가 있다.
{
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { LIVELY_TOKEN: "test-token", LIVELY_GATEWAY_URL: `http://127.0.0.1:${server.address().port}` };
  const prompt = "대출 심사에서 연체 이력은 어떻게 반영돼? 관련 지식 찾아줘";
  const plain = await runSeed("knowledge-recall", ups(prompt), env);
  const plainHits = hits;
  const flagged = await runSeed("knowledge-recall", ups(prompt, { lively_prompt_injected: true }), env);
  const flaggedHits = hits - plainHits;
  await new Promise((r) => server.close(r));
  plainHits > 0 && flaggedHits === 0 && flagged.code === 0 && flagged.stdout.trim() === ""
    ? ok(`S3 knowledge-recall — lively_prompt_injected:true 면 게이트웨이 호출 0회·무출력(대조군 호출 ${plainHits}회)`)
    : bad("S3 knowledge-recall 침묵", `대조군 호출=${plainHits}(code=${plain.code} err=${JSON.stringify(plain.stderr.slice(0, 200))}) 표시 호출=${flaggedHits} flagged code=${flagged.code} out=${JSON.stringify(flagged.stdout.slice(0, 200))}`);
}

finish("prompt-origin");
