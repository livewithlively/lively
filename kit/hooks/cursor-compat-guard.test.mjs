#!/usr/bin/env node
// cursor compat 이중발화 가드 사양테스트(#4927) — isForeignCursorInvocation 단위 + **러너 5종 실스폰** 통합.
//  왜: Cursor 는 ~/.claude/settings.json 의 우리 훅을 기본으로 돌린다(CLI 는 끌 수 없다 — 번들 실측). 가드가 없으면
//  그 사본이 Cursor 페이로드를 claude 형으로 오독해 «반쯤 되는» 상태가 되고 네이티브 배선(cursor-adapter)과 두 번 돈다.
//  가드가 **너무 넓으면** 반대로 Cursor 안에서 띄운 claude 세션의 우리 훅이 전멸한다(B3·B4 가 그 경계다).
//  실행: node scripts/run-tests.mjs cursor-compat-guard
//  엣지 표: 스크래치패드 spec.md §B — 케이스 이름의 [B#] 가 그 행 번호다.
//  단언은 문구가 아니라 **부작용**으로: exit0 + stdout 빈 + 파일 지문(플래그 생성 유무).
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isForeignCursorInvocation } from "./harness-registry.mjs";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// Cursor 훅 프로세스 env(번들 실측: 훅 프로세스에만 주는 두 값).
const HOOK_ENV = { CURSOR_VERSION: "2026.10.19-6bbf2c4", CURSOR_PROJECT_DIR: "/ws" };

// ── 단위 (B1~B6) — 순수 함수라 env 를 인자로 주입한다 ───────────────────────
eq("B1 Cursor 훅 env + 하네스 미지정 → true(compat 사본)", isForeignCursorInvocation([], { ...HOOK_ENV }), true);
eq("B2 + LIVELY_HARNESS=cursor → false(어댑터 경로)", isForeignCursorInvocation([], { ...HOOK_ENV, LIVELY_HARNESS: "cursor" }), false);
eq("B2b + argv --harness cursor → false", isForeignCursorInvocation(["--harness", "cursor"], { ...HOOK_ENV }), false);
// [B3] (경계) Claude Code 세션 안 — Cursor 내장 터미널 env 가 미실측이라 CURSOR_* 가 새어 들어와도 claude 훅은 살아야 한다.
eq("B3 + CLAUDECODE=1(Claude 세션) → false", isForeignCursorInvocation([], { ...HOOK_ENV, CLAUDECODE: "1" }), false);
// [B4] (경계) Cursor 에이전트의 셸 툴이 띄운 claude — 그 env 엔 CURSOR_AGENT 만 있다(번들 실측).
eq("B4 CURSOR_AGENT=1 만 → false", isForeignCursorInvocation([], { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "c" }), false);
eq("B5 CURSOR_VERSION 만(PROJECT_DIR 없음) → false", isForeignCursorInvocation([], { CURSOR_VERSION: "x" }), false);
eq("B6 Cursor env 없음 → false", isForeignCursorInvocation([], {}), false);
// 다른 하네스 명시(기형 경로)도 사본 취급 — 정본은 cursor 경로뿐(grok 가드 GG2b 와 같은 규칙).
eq("B1b + LIVELY_HARNESS=codex → true", isForeignCursorInvocation([], { ...HOOK_ENV, LIVELY_HARNESS: "codex" }), true);

// ── 통합 (B7) — 러너를 **실제로 스폰**해 가드의 부작용 차단을 지문으로 본다 ──
const SB = mkdtempSync(join(tmpdir(), "cursor-guard-test-"));
const HOME = join(SB, "home");
const TMP = join(SB, "tmp");                       // os.tmpdir() 리다이렉트(FLAG_DIR 격리)
const FLAGS = join(TMP, "lively-hooks");
mkdirSync(join(HOME, ".lively"), { recursive: true });
mkdirSync(TMP, { recursive: true });
writeFileSync(join(HOME, ".lively", "gateway-url"), "http://127.0.0.1:9\n");   // 토큰 없음 = 네트워크 fail-soft

const treeList = (d) => {
  if (!existsSync(d)) return [];
  const out = [];
  const walk = (p) => { for (const f of readdirSync(p, { withFileTypes: true })) { const q = join(p, f.name); f.isDirectory() ? walk(q) : out.push(q.slice(SB.length)); } };
  walk(d);
  return out.sort();
};
// ⚠ CLAUDECODE 를 명시로 비운다 — 이 테스트를 Claude Code 세션 안에서 돌리면 CLAUDECODE=1 이 상속돼 가드가 (정당하게)
//  비켜서지 않고, 그러면 B7 이 «사본인데 돌았다» 로 거짓 빨간불이 된다(CI 엔 원래 없는 값).
//  LIVELY_SESSION_ID·LIVELY_TOKEN 도 비운다(grok 가드 테스트와 같은 이유 — 박스 안 실행이 실 게이트웨이에 보고하지 않게).
const runRunner = (script, extraEnv, payload, args = []) => spawnSync(process.execPath, [join(HOOKS_DIR, script), ...args], {
  input: JSON.stringify(payload), encoding: "utf8", timeout: 20000, killSignal: "SIGKILL",
  env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox", LIVELY_HOME: HOME, HOME, USERPROFILE: HOME, TMPDIR: TMP, TEMP: TMP, TMP: TMP,
    ...HOOK_ENV, CLAUDECODE: "", GROK_HOOK_EVENT: "", LIVELY_HARNESS: "", LIVELY_SESSION_ID: "", LIVELY_TOKEN: "", ...extraEnv },
});

// ⚠ 관측 장치 — «가드가 없었다면 반드시 흔적이 남는» 입력을 깐다. 이게 없으면 B7 은 가드를 꺼도 초록이다
//  (실측: Cursor 의 `MCP:<툴>` 페이로드만 주면 가드 없이도 러너들이 조용히 아무것도 안 해서 mutation 이 안 잡혔다 —
//   그 «조용히 아무것도 안 함» 이 바로 반쯤 되는 상태다). 러너마다 하나씩:
//  · session-preload — 로컬 정적 맥락(context.md)이 있으면 토큰 없이도 그걸 stdout 으로 낸다.
//  · work-flag — Cursor 의 Write 는 claude 편집 툴 이름과 같아 .worked 플래그를 세운다.
//  · stop-writeback-gate — 그 세션에 .lively·.worked 가 있으면 block 을 내고 .blocked 를 만든다.
//  · run-custom — 토큰이 없으면 캐시의 조직 훅을 돌린다 → 그 훅이 표식 파일을 쓴다.
//  · sync-harness-assets — 토큰·게이트웨이 없이는 관측 가능한 부작용이 없다 → 아래 B7s 의 정적 배선 단언으로 대신한다.
writeFileSync(join(HOME, ".lively", "context.md"), "CTX-STATIC-should-not-leak\n");
mkdirSync(FLAGS, { recursive: true });
writeFileSync(join(FLAGS, "cg-gate.lively"), ""); writeFileSync(join(FLAGS, "cg-gate.worked"), "");
const MARK = join(SB, "org-hook-ran");
const HOOK_SRC = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(MARK)}, "ran");\n`;
writeFileSync(join(HOME, ".lively", "custom-hooks-PostToolUse.json"), JSON.stringify({ at: Date.now(), relay: ["deny"], hooks: [
  { id: "probe", event: "PostToolUse", matcher: null, timeout_sec: 5, source_code: HOOK_SRC, content_hash: createHash("sha256").update(HOOK_SRC).digest("hex") },
] }));
// Cursor 가 compat 로 넘기는 페이로드 모양(번들 실측: camelCase 이벤트 이름·Cursor 툴 이름·session_id=conversation_id).
const CURSOR_PAYLOAD = (sid) => ({ hook_event_name: "postToolUse", conversation_id: sid, session_id: sid, tool_name: "Write", tool_input: { file_path: "/x", content: "y" }, cursor_version: "x", workspace_roots: [SB] });

// [B7] 가드 발동 — 관측 가능한 러너 4종: exit0 + stdout 빈 + 샌드박스( .lively + tmp ) 무변화 + 조직 훅 미실행.
{
  const cases = [
    ["session-preload.mjs", [], "cg-pre"],
    ["work-flag.mjs", [], "cg-wf"],
    ["stop-writeback-gate.mjs", [], "cg-gate"],
    ["run-custom.mjs", ["PostToolUse"], "cg-rc"],
  ];
  for (const [script, args, sid] of cases) {
    const before = JSON.stringify([treeList(join(HOME, ".lively")), treeList(TMP)]);
    const r = runRunner(script, {}, CURSOR_PAYLOAD(sid), args);
    const after = JSON.stringify([treeList(join(HOME, ".lively")), treeList(TMP)]);
    const silent = String(r.stdout || "").trim() === "";
    (r.status === 0 && silent && before === after && !existsSync(MARK))
      ? ok(`B7 ${script} — compat 사본 가드(exit0·무출력·부작용 0)`)
      : bad(`B7 ${script}`, `exit=${r.status} silent=${silent} 무변화=${before === after} 훅실행=${existsSync(MARK)}`);
  }
}
// [B7s] 정적 배선 — 러너 5종 모두 **모듈 최상단**에서 가드로 빠져나간다(sync-harness-assets 는 위 관측이 불가해 이게 유일한 단언).
{
  const missing = ["session-preload.mjs", "work-flag.mjs", "stop-writeback-gate.mjs", "run-custom.mjs", "sync-harness-assets.mjs"]
    .filter((f) => !/^if \(isForeignGrokInvocation\(\) \|\| isForeignCursorInvocation\(\)\) process\.exit\(0\);$/m.test(readFileSync(join(HOOKS_DIR, f), "utf8")));
  eq("B7s 러너 5종 최상단 가드 배선", missing, []);
}

// [B7d] 관측 장치가 살아 있다(vacuous 방지) — 같은 입력을 **Claude 세션**(CLAUDECODE=1 → 가드 비켜섬)으로 주면 흔적이 실제로 남는다.
{
  const r1 = runRunner("session-preload.mjs", { CLAUDECODE: "1" }, CURSOR_PAYLOAD("cg-pre2"));
  const r2 = runRunner("run-custom.mjs", { CLAUDECODE: "1" }, CURSOR_PAYLOAD("cg-rc2"), ["PostToolUse"]);
  eq("B7d 관측 장치 동작(정적 맥락 출력 · 조직 훅 실행)", [String(r1.stdout || "").includes("CTX-STATIC"), r2.status, existsSync(MARK)], [true, 0, true]);
  rmSync(MARK, { force: true });
}

// [B7b] 정본 경로(LIVELY_HARNESS=cursor — 어댑터가 claude 형으로 번역해 넘긴 페이로드) — 가드를 통과해 **실제 부작용**이 생긴다.
//  vacuous 방지의 배선 단언: 위 B7 의 '부작용 0' 이 관측 장치 고장이 아니라 가드 덕임을 증명한다.
{
  const r = runRunner("work-flag.mjs", { LIVELY_HARNESS: "cursor" },
    { hook_event_name: "PostToolUse", session_id: "cg-open", tool_name: "mcp__lively__knowledge_save", tool_input: {}, cwd: SB });
  const flags = treeList(FLAGS).filter((f) => f.includes("cg-open"));
  (r.status === 0 && flags.some((f) => f.endsWith("cg-open.lively")) && flags.some((f) => f.endsWith("cg-open.writeback")))
    ? ok(`B7b work-flag 정본 경로 — 가드 통과·플래그 생성(${flags.length}개)`)
    : bad("B7b 정본 경로", `exit=${r.status} flags=${JSON.stringify(flags)} dir=${JSON.stringify(treeList(FLAGS))}`);
}

// [B7c] Claude 세션 안(CLAUDECODE=1) — Cursor env 가 새어 있어도 claude 형 우리 훅은 산다(B3 의 실스폰판).
{
  const r = runRunner("work-flag.mjs", { CLAUDECODE: "1" },
    { hook_event_name: "PostToolUse", session_id: "cg-claude", tool_name: "mcp__lively__knowledge_save", tool_input: {}, cwd: SB });
  const flags = treeList(FLAGS).filter((f) => f.includes("cg-claude"));
  (r.status === 0 && flags.some((f) => f.endsWith("cg-claude.lively")))
    ? ok("B7c Claude 세션(CLAUDECODE) — 가드가 비켜서지 않음(플래그 생성)")
    : bad("B7c Claude 세션", `exit=${r.status} flags=${JSON.stringify(flags)}`);
}

rmSync(SB, { recursive: true, force: true });
console.log(`\n${fail ? "✗" : "✓"} cursor-compat-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
