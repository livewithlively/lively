#!/usr/bin/env node
// 기록 넛지 결정표(#4219) — 오프라인·fs-only(샌드박스 HOME/TMPDIR, 실제 ~/.lively·/tmp 무접촉).
//  실행: node kit/hooks/record-nudge.test.mjs  (npm test 체인에 포함)
//  fail-first: RN_HOOKS_DIR=<수정 전 kit/hooks 사본> node kit/hooks/record-nudge.test.mjs → 새 행위 행이 빨간불이어야 한다.
//
//  왜 이 테스트가 있나: 기록 묶음 스킬(record-batch)과 주입 문구만으로는 모델이 습관대로 한 건씩 인라인으로 기록한다.
//   훅이 결정적 신호로 교정한다 — 단, 스킬이 권하는 동작(1,000자 미만 인라인·fork 안의 기록·헤드리스의 인라인)에는
//   절대 넛지하지 않아야 한다. 틀린 넛지는 모델을 스킬 반대 방향으로 민다.
//  고정하는 불변식(행 번호 = 사양 엣지 표):
//   E  교정 넛지 — 메인·대화형·fork 가 있는 하네스에서, 넘길 대상 툴의 인자 JSON 글자가 **한 턴 합계** 1,000자를 처음 넘을 때 1회.
//      턴 시작에 합계를 지운다 · 턴당 1회 · 세션당 2회 · fork(agent_id)·생성 툴·읽기 툴·헤드리스·기계 세션·fork 없는 하네스는 무발화.
//      병렬 툴콜의 훅이 겹쳐도 합이 유실되지 않고 한 번만 낸다 · 같은 호출이 두 번 보고돼도 두 번 세지 않는다.
//   C  압축 넛지 — 미기록 작업(.lively 세션 · .worked 가 .writeback 보다 나중 · 기록 fork 진행 중 아님)이 있을 때만:
//      claude PreCompact = 평문(압축 요약 지시문) · SessionStart(source=compact) = additionalContext(claude·codex).
//  페이로드 형태: claude 2.1.285 실측(agent_id·tool_use_id, CLAUDE_CODE_ENTRYPOINT=cli/sdk-cli · SESSION_ATTENDED=1/0),
//   codex 0.154.0 코드(hooks/src/schema.rs — turn_id·agent_id·tool_use_id·transcript_path) + 대화 파일 첫 줄 실측(originator·source).
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";   // HOME/TMPDIR 만으론 윈도우 격리가 안 된다(#1510)

const HERE = join(fileURLToPath(import.meta.url), "..");
const HOOKS = process.env.RN_HOOKS_DIR || HERE;
const WF = join(HOOKS, "work-flag.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "record-nudge-test-"));
const HOME = join(SANDBOX, "home");
const TMP = join(SANDBOX, "tmp");
const FLAG_DIR = join(TMP, "lively-hooks");   // 훅이 플래그를 두는 곳(tmpdir()/lively-hooks — TMPDIR 로 리다이렉트)
mkdirSync(join(HOME, ".lively"), { recursive: true });
mkdirSync(FLAG_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };
const check = (name, cond, why) => (cond ? ok(name) : bad(name, why));

// 하네스가 훅에 물려주는 env 는 케이스가 정한다(이 테스트를 claude 세션 안에서 돌려도 대화형 표지가 새지 않게 비운다).
const env = (extra = {}, tmp = TMP) => ({
  ...process.env, ...sandboxEnv({ home: HOME, tmp }), LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_MODE: "",
  CLAUDE_CODE_ENTRYPOINT: "", CLAUDE_CODE_SESSION_ATTENDED: "", ...extra,
});
function run(payload, { harness = "claude", extra = {}, tmp } = {}) {
  return execFileSync(process.execPath, [WF], { input: JSON.stringify(payload), env: env({ LIVELY_HARNESS: harness, ...extra }, tmp), encoding: "utf8" });
}
function runAsync(payload, { harness = "claude", extra = {} } = {}) {
  return new Promise((resolve) => {
    const cp = execFile(process.execPath, [WF], { env: env({ LIVELY_HARNESS: harness, ...extra }), encoding: "utf8" }, (_e, out) => resolve(out || ""));
    cp.stdin.end(JSON.stringify(payload));
  });
}
// 훅 출력에서 {hookEventName, additionalContext} 를 꺼낸다(JSON 봉투가 아니면 null).
const envelope = (out) => {
  for (const line of String(out).split("\n")) {
    try { const h = JSON.parse(line)?.hookSpecificOutput; if (h?.additionalContext) return h; } catch { /* 평문 */ }
  }
  return null;
};
const contextOf = (out) => envelope(out)?.additionalContext || "";
// 교정 넛지 = PostToolUse 봉투의 additionalContext 가 기록 묶음 스킬(record-batch)을 가리킨다(스킬 이름은 계약이다).
const nudged = (out) => envelope(out)?.hookEventName === "PostToolUse" && contextOf(out).includes("record-batch");

let n = 0;
const newSid = () => `rn${++n}`;
const flag = (sid, f) => join(FLAG_DIR, `${sid}.${f}`);
// 인자 JSON 글자 수가 **정확히** len 인 tool_input — {"t":"xxx…"} = 8 + 본문 길이.
const inputOfLen = (len) => ({ t: "x".repeat(len - 8) });
let tu = 0;
// 라이블리 쓰기 PostToolUse(메인 기본). payload 로 필드를 덮거나 지운다(undefined 는 JSON 에서 빠진다).
const write = (sid, len, { tool = "knowledge_save", harness = "claude", extra = {}, payload = {}, tmp } = {}) => {
  const prefix = harness === "opencode" ? "lively_" : "mcp__lively__";
  return run({
    session_id: sid, hook_event_name: "PostToolUse", tool_name: prefix + tool, tool_use_id: `toolu_${++tu}`,
    tool_input: inputOfLen(len), tool_response: { ok: true }, ...payload,
  }, { harness, extra, tmp });
};
const prompt = (sid, payload = {}, harness = "claude") => run({ session_id: sid, hook_event_name: "UserPromptSubmit", prompt: "다음 일", ...payload }, { harness });
const inlineFiles = (sid) => readdirSync(FLAG_DIR).filter((f) => f.startsWith(`${sid}.inline-write.`)).length;

// ── E. 교정 넛지 ──────────────────────────────────────────────────────────
{
  const out = write(newSid(), 1200);
  check("E1 메인이 한 번에 1,200자 → PostToolUse 봉투로 넛지", nudged(out), `out=${out.slice(0, 200)}`);
}
{
  const sid = newSid();
  const a = write(sid, 600), b = write(sid, 600);
  check("E2 600+600 — 한 턴 합계가 넘는 순간(두 번째)에 넛지", !nudged(a) && nudged(b), `a=${nudged(a)} b=${nudged(b)}`);
}
check("E3 경계 — 정확히 1,000자면 넛지", nudged(write(newSid(), 1000)), "무발화");
check("E4 경계 — 999자면 무발화", !nudged(write(newSid(), 999)), "넛지함");
{
  const sid = newSid();
  const f = write(sid, 2000, { payload: { agent_id: "a1", agent_type: "fork" } });
  const m = write(sid, 500);
  check("E5 fork(agent_id) 의 2,000자는 무발화이고 메인 합계에도 안 들어간다", !nudged(f) && !nudged(m), `fork=${nudged(f)} main=${nudged(m)}`);
}
{
  const sid = newSid();
  const a = write(sid, 800); prompt(sid); const b = write(sid, 800);
  check("E6 턴 시작(UserPromptSubmit)에 합계를 지운다 — 800 / 800 은 무발화", !nudged(a) && !nudged(b) && inlineFiles(sid) === 1, `a=${nudged(a)} b=${nudged(b)} files=${inlineFiles(sid)}`);
}
{
  const sid = newSid();
  const a = write(sid, 1200), b = write(sid, 2000);
  check("E7 한 턴에 한 번만", nudged(a) && !nudged(b), `a=${nudged(a)} b=${nudged(b)}`);
}
{
  const sid = newSid();
  const r = [];
  for (let t = 0; t < 3; t++) { prompt(sid); r.push(nudged(write(sid, 1500))); }
  check("E8 세션당 2회까지(세 번째 턴은 무발화)", r[0] && r[1] && !r[2], JSON.stringify(r));
}
{
  const sid = newSid();
  const outs = [write(sid, 2000, { tool: "task_create_v6" }), write(sid, 2000, { tool: "project_create_v6" }), write(sid, 2000, { tool: "knowledge_get" })];
  check("E9 생성 툴(id 가 곧바로 필요 — 메인 몫)·읽기 툴은 세지 않는다", !outs.some(nudged) && inlineFiles(sid) === 0, `files=${inlineFiles(sid)}`);
}
for (const tool of ["project_update_v6", "task_update_v6", "task_comment_v6", "activity_log"]) {
  check(`E10 넘길 대상 ${tool} 1,200자 → 넛지`, nudged(write(newSid(), 1200, { tool })), "무발화");
}
{
  const a = write(newSid(), 1500, { extra: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_SESSION_ATTENDED: "0" } });
  const b = write(newSid(), 1500, { extra: { CLAUDE_CODE_SESSION_ATTENDED: "0" } });
  const c = write(newSid(), 1500, { extra: { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1" } });
  check("E11 claude 헤드리스(-p: sdk-cli·ATTENDED 0)는 무발화, 대화형(cli·1)은 발화", !nudged(a) && !nudged(b) && nudged(c), `sdk=${nudged(a)} att0=${nudged(b)} cli=${nudged(c)}`);
}
// codex 대화 파일 첫 줄(session_meta) — 0.154.0 실측 모양(첫 줄이 18KB 안팎이라 뒤를 길게 채운다).
const rollout = (originator, source) => {
  const p = join(SANDBOX, `rollout-${originator}-${++n}.jsonl`);
  writeFileSync(p, JSON.stringify({ timestamp: "2026-09-30T00:00:00Z", ordinal: 0, type: "session_meta", payload: { session_id: "x", originator, cli_version: "0.154.0", source, base_instructions: { text: "…".repeat(6000) } } }) + "\n");
  return p;
};
{
  const out = write(newSid(), 1500, { harness: "codex", payload: { turn_id: "t1", transcript_path: rollout("codex-tui", "cli") } });
  check("E12 codex TUI 메인 → 넛지 + 사실 메모 안내", nudged(out) && contextOf(out).includes("사실 메모"), contextOf(out).slice(0, 200));
  const cl = write(newSid(), 1500);
  check("E12b claude 넛지엔 codex 전용 안내가 없다", nudged(cl) && !contextOf(cl).includes("사실 메모"), contextOf(cl).slice(0, 120));
}
{
  const out = write(newSid(), 1500, { harness: "codex", payload: { turn_id: "t1", transcript_path: rollout("codex_exec", "exec") } });
  check("E13 codex exec(헤드리스) → 무발화", !nudged(out), contextOf(out).slice(0, 120));
}
{
  const out = write(newSid(), 1500, { harness: "codex", payload: { turn_id: "t1", agent_id: "019a-child", agent_type: "default", transcript_path: rollout("codex-tui", "cli") } });
  check("E14 codex 자식(agent_id) → 무발화", !nudged(out), "넛지함");
}
{
  const sid = newSid();
  const out = write(sid, 1500, { harness: "opencode" });
  check("E15 fork 없는 하네스(opencode) → 무발화(플래그는 선다 — 배선 확인)", !nudged(out) && existsSync(flag(sid, "writeback")), `nudged=${nudged(out)} writeback=${existsSync(flag(sid, "writeback"))}`);
}
check("E16 라이블리 기계 세션(LIVELY_SESSION_KIND≠human) → 무발화", !nudged(write(newSid(), 1500, { extra: { LIVELY_SESSION_KIND: "delegate" } })), "넛지함");
check("E16b 종류 축 이전 세션 — kind 없고 위탁 작업 폴더(LIVELY_TASK_WS)가 있으면 기계 세션(무발화)", !nudged(write(newSid(), 1500, { extra: { LIVELY_TASK_WS: "/w/task-1" } })), "넛지함");
{
  const sid = newSid();
  const mk = (i) => ({ session_id: sid, hook_event_name: "PostToolUse", tool_name: "mcp__lively__task_comment_v6", tool_use_id: `par_${i}`, tool_input: inputOfLen(600), tool_response: {} });
  const outs = await Promise.all([runAsync(mk(1)), runAsync(mk(2))]);
  const count = outs.filter(nudged).length;
  check("E17 병렬 툴콜 두 개(각 600자)가 겹쳐도 합이 유실되지 않고 정확히 한 번 낸다", count === 1 && inlineFiles(sid) === 2, `nudges=${count} files=${inlineFiles(sid)}`);
}
{
  const sid = newSid();
  const p = { session_id: sid, hook_event_name: "PostToolUse", tool_name: "mcp__lively__knowledge_save", tool_use_id: "dup_1", tool_input: inputOfLen(600), tool_response: {} };
  const a = run(p), b = run(p);
  check("E18 같은 호출이 두 번 보고돼도(유저·프로젝트 settings 두 벌) 두 번 세지 않는다(600 → 무발화)", !nudged(a) && !nudged(b) && inlineFiles(sid) === 1, `a=${nudged(a)} b=${nudged(b)} files=${inlineFiles(sid)}`);
}
{
  const sid = newSid();
  const tp = rollout("codex-tui", "cli");
  const a = write(sid, 700, { harness: "codex", payload: { turn_id: "t1", transcript_path: tp } });
  prompt(sid, { turn_id: "t1", agent_id: "019a-child", agent_type: "default" }, "codex");   // 자식의 턴 시작
  const b = write(sid, 700, { harness: "codex", payload: { turn_id: "t1", transcript_path: tp } });
  check("E19 codex 자식의 UserPromptSubmit 은 부모 턴 합계를 지우지 않는다(700+700 → 넛지)", !nudged(a) && nudged(b), `a=${nudged(a)} b=${nudged(b)}`);
}
{
  const sid = newSid();
  const out = write(sid, 1200, { payload: { tool_use_id: undefined } });
  check("E20 tool_use_id 가 없어도 센다(1,200 → 넛지)", nudged(out) && inlineFiles(sid) === 1, `nudged=${nudged(out)} files=${inlineFiles(sid)}`);
}
{
  const a = write(newSid(), 1500, { harness: "codex", payload: { turn_id: "t1", transcript_path: null } });
  const b = write(newSid(), 1500, { harness: "codex", payload: { turn_id: "t1", transcript_path: join(SANDBOX, "no-such-rollout.jsonl") } });
  check("E21 codex 대화 파일이 없거나(null — exec --ephemeral) 못 읽으면 헤드리스로 본다(무발화 — 틀린 fork 권유는 기록 유실)", !nudged(a) && !nudged(b), `null=${nudged(a)} missing=${nudged(b)}`);
}
{
  const bare = join(SANDBOX, "tmp-fresh");   // 플래그 디렉터리가 아직 없는 임시폴더
  mkdirSync(bare, { recursive: true });
  const out = write(newSid(), 1200, { tmp: bare });
  check("E22 플래그 디렉터리가 없어도 만들고 센다(넛지)", nudged(out) && existsSync(join(bare, "lively-hooks")), `nudged=${nudged(out)}`);
}
{
  const sid = newSid();
  write(sid, 1500);
  check("E23 플래그 기록(.lively·.writeback)은 종전대로 선다", existsSync(flag(sid, "lively")) && existsSync(flag(sid, "writeback")), "플래그 없음");
}
{
  const sid = newSid();
  write(sid, 1200);
  const out = prompt(sid);
  check("E24 턴 시작(UserPromptSubmit)은 아무것도 출력하지 않는다", out.trim() === "", `out=${out.slice(0, 120)}`);
}

// ── C. 압축 넛지 ──────────────────────────────────────────────────────────
// 미기록 작업 세션 = .lively + .worked 가 .writeback 보다 나중(초 단위로 벌린다).
function session({ lively = true, worked = true, writebackAgo = null, workedAgo = 0 } = {}) {
  const sid = newSid();
  const at = (f, secAgo) => { writeFileSync(flag(sid, f), ""); const t = (Date.now() - secAgo * 1000) / 1000; utimesSync(flag(sid, f), t, t); };
  if (lively) at("lively", 600);
  if (worked) at("worked", workedAgo);
  if (writebackAgo !== null) at("writeback", writebackAgo);
  return sid;
}
const precompact = (sid, { harness = "claude", payload = {} } = {}) => run({ session_id: sid, hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null, ...payload }, { harness });
const compactStart = (sid, { harness = "claude", source = "compact", payload = {} } = {}) =>
  run({ session_id: sid, hook_event_name: "SessionStart", source, ...payload }, { harness });
// claude PreCompact 의 stdout 은 **평문**이어야 한다(JSON 이면 압축 요약 지시문이 아니라 봉투로 읽힌다) — 비어 있지 않은 평문인가.
const plainText = (out) => out.trim().length > 0 && envelope(out) === null && !out.trim().startsWith("{");
{
  const out = precompact(session({ writebackAgo: 120, workedAgo: 10 }));
  check("C1 claude PreCompact · 기록 뒤 작업 있음 → 평문 요약 지시문", plainText(out) && out.includes("미기록"), out.slice(0, 120));
}
{
  const a = precompact(session({ writebackAgo: 5, workedAgo: 60 }));
  const b = precompact(session({ worked: false }));
  const c = precompact(session({ lively: false }));
  check("C2 기록이 작업보다 나중·작업 없음·라이블리 세션 아님 → 무출력", !a.trim() && !b.trim() && !c.trim(), `a=${a.slice(0, 60)} b=${b.slice(0, 60)} c=${c.slice(0, 60)}`);
}
{
  const same = session({ writebackAgo: 30, workedAgo: 30 });
  check("C2b 경계 — 기록과 작업이 같은 시각이면 기록한 것으로 본다(무출력)", !precompact(same).trim(), "출력함");
}
{
  const fresh = session();
  writeFileSync(flag(fresh, "writeback-pending.a7"), "");
  const stale = session();
  writeFileSync(flag(stale, "writeback-pending.a8"), "");
  const t = (Date.now() - 21 * 60_000) / 1000; utimesSync(flag(stale, "writeback-pending.a8"), t, t);
  const a = precompact(fresh), b = precompact(stale);
  check("C3 기록 fork 진행 중(20분 안 표시)이면 무출력, 21분 지난 표시는 무시", !a.trim() && plainText(b), `fresh=${a.slice(0, 60)} stale=${b.slice(0, 60)}`);
}
{
  const a = precompact(session(), { payload: { agent_id: "a9" } });
  const b = precompact(session(), { harness: "codex" });
  check("C4 서브에이전트의 압축·codex PreCompact → 무출력(codex PreCompact 는 턴 중단만 된다)", !a.trim() && !b.trim(), `sub=${a.slice(0, 60)} codex=${b.slice(0, 60)}`);
}
{
  const out = compactStart(session());
  const h = envelope(out);
  check("C5 claude 압축 직후 SessionStart(compact) → SessionStart 봉투 additionalContext(record-batch)", h?.hookEventName === "SessionStart" && h.additionalContext.includes("record-batch"), out.slice(0, 200));
}
{
  const out = compactStart(session(), { payload: { agent_id: "a10", agent_type: "fork" } });
  check("C5b 서브에이전트의 압축 직후 SessionStart → 무출력", !out.trim(), out.slice(0, 120));
}
{
  const sid = session();
  const a = precompact(sid), b = precompact(sid);
  const c = compactStart(sid), d = compactStart(sid);
  check("C5c 같은 압축에 훅이 두 벌(유저·프로젝트 settings)이어도 지시문·알림은 한 번씩", plainText(a) && !b.trim() && envelope(c) !== null && !d.trim(), `pre=[${!!a.trim()},${!!b.trim()}] resume=[${!!c.trim()},${!!d.trim()}]`);
}
{
  const a = compactStart(session(), { source: "startup" });
  const b = compactStart(session({ writebackAgo: 1, workedAgo: 30 }));
  check("C6 startup 이거나 미기록 작업이 없으면 무출력(종전 SessionStart 동작 그대로)", !a.trim() && !b.trim(), `startup=${a.slice(0, 60)} recorded=${b.slice(0, 60)}`);
}
{
  const tui = compactStart(session(), { harness: "codex", payload: { transcript_path: rollout("codex-tui", "cli") } });
  const exec = compactStart(session(), { harness: "codex", payload: { transcript_path: rollout("codex_exec", "exec") } });
  check("C7 codex 압축 직후 — TUI 는 record-batch 로, exec 는 fork 없이 바로",
    envelope(tui)?.hookEventName === "SessionStart" && contextOf(tui).includes("record-batch") && envelope(exec) !== null && !contextOf(exec).includes("record-batch"),
    `tui=${contextOf(tui).slice(0, 80)} exec=${contextOf(exec).slice(0, 80)}`);
}

// ── W. 배선 — 이 훅이 실제로 그 이벤트에 불리는가(user-install 의 claude user-level 블록) ──────────────
{
  const { userLevelHooksBlock } = await import("../setup/user-install.mjs");
  const blk = userLevelHooksBlock();
  const wfEntries = (ev) => (blk[ev] || []).filter((e) => (e.hooks || []).some((h) => String(h.command).includes("work-flag.mjs")));
  const matchers = wfEntries("SessionStart").map((e) => e.matcher);
  check("W1 claude SessionStart — 종전 startup|resume|clear 엔트리는 그대로, compact 는 새 엔트리", matchers.includes("startup|resume|clear") && matchers.includes("compact"), JSON.stringify(matchers));
  check("W2 claude PreCompact 에 work-flag 배선", wfEntries("PreCompact").length === 1, JSON.stringify(blk.PreCompact));
  check("W3 교정 넛지는 기존 PostToolUse mcp__lively__.* 엔트리가 낸다(새 matcher 없음)", wfEntries("PostToolUse").some((e) => e.matcher === "mcp__lively__.*"), JSON.stringify(wfEntries("PostToolUse").map((e) => e.matcher)));
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
