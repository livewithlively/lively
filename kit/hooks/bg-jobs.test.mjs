#!/usr/bin/env node
// 열린 백그라운드 작업 수(#4588, bg-jobs.mjs) — 오프라인·fs-only(샌드박스 TMPDIR).
//  실행: node kit/hooks/bg-jobs.test.mjs  (npm test 체인에 포함)
//  줄 모양은 **실측 원문**이다(Claude Code 2.1.289 · 2.1.291 대화 기록에서 옮겼다 — 경로·본문만 줄였다).
//  행 이름이 엣지 표다 — L 띄움 · C 끝남 · N 세지 않는 것 · F 파일(증분·덩어리 경계·못 읽음) · W work-flag 배선.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { jobEventsOf, feedLines, countOpenJobs } from "./bg-jobs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
//  띄움·끝남 두 칸만 본다(띄우라고 부른 호출의 짝 맞추기는 U1 이 따로 본다).
const lc = (o) => { const e = jobEventsOf(o); return { launched: e.launched, closed: e.closed }; };
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

const result = (text, extra = {}) => ({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_x", type: "tool_result", content: text, is_error: false }] }, ...extra });
const notice = (id, status, summary = "Background command \"x\" completed (exit code 0)") =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<output-file>/private/tmp/x/tasks/${id}.output</output-file>\n${status ? `<status>${status}</status>\n` : ""}<summary>${summary}</summary>\n</task-notification>`;
const BASH = "Command running in background with ID: bdkb93vju. Output is being written to: /private/tmp/x/tasks/bdkb93vju.output. You will be notified when it completes. To check interim output, use Read on that file path.";
const MOVED = "Command did not complete within its 598s timeout and was moved to the background (ID: bvpluxnie). Output is being written to: /private/tmp/x/tasks/bvpluxnie.output. You will be notified when it completes.";
const AGENT = "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a43e481f202df93e9 (internal ID - do not mention to user. Use SendMessage with to: 'a43e481f202df93e9', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background.";
const MONITOR = "Monitor started (task bhf2b1dhn, timeout 3000000ms). You will be notified on each event. Keep working — do not poll or sleep.";
const STOP = "{\"message\":\"Successfully stopped task: br7luzsxv (lively delegate --help 2>&1 | head -30)\",\"task_id\":\"br7luzsxv\",\"task_type\":\"local_bash\"}";

t("L1 띄움 네 갈래 — Bash 백그라운드 · 시간 초과로 넘어간 Bash · 백그라운드 에이전트 · Monitor", () => {
  assert.deepEqual(jobEventsOf(result(BASH)).launched, ["bdkb93vju"]);
  assert.deepEqual(lc(result(MOVED)).launched, ["bvpluxnie"]);
  assert.deepEqual(lc(result("Command did not complete within its 120s timeout and was moved to the background (ID: br7luzsxv). Output …")).launched, ["br7luzsxv"]);
  assert.deepEqual(lc(result(AGENT)).launched, ["a43e481f202df93e9"]);
  assert.deepEqual(lc(result(MONITOR)).launched, ["bhf2b1dhn"]);
  //  결과가 텍스트 블록 배열로 와도 같다(에이전트 결과의 실제 모양).
  assert.deepEqual(lc({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: AGENT }] }] } }).launched, ["a43e481f202df93e9"]);
});

t("C1 끝남 — 완료 알림(<status> 가 running 이 아닌 것)은 대기열·첨부·사용자 줄 어디에 적혀도 같다", () => {
  for (const st of ["completed", "failed", "killed"]) {
    assert.deepEqual(lc({ type: "queue-operation", operation: "enqueue", content: notice("bdkb93vju", st) }).closed, ["bdkb93vju"], `대기열 ${st}`);
  }
  assert.deepEqual(lc({ type: "attachment", attachment: { type: "queued_command", prompt: notice("bk630dfwg", "completed") } }).closed, ["bk630dfwg"], "턴 중에 온 알림");
  assert.deepEqual(lc({ type: "user", message: { role: "user", content: notice("bd11z5753", "completed") } }).closed, ["bd11z5753"], "턴을 연 알림");
  assert.deepEqual(lc({ type: "user", message: { role: "user", content: [{ type: "text", text: notice("a73397d05fcc14ce0", "completed", "Agent \"x\" finished") }] } }).closed, ["a73397d05fcc14ce0"]);
});

t("C2 끝남 — TaskStop 결과 · 옛 KillShell 결과", () => {
  assert.deepEqual(lc(result(STOP)).closed, ["br7luzsxv"]);
  assert.deepEqual(lc(result("Successfully killed shell: bash_3 (sleep 100)")).closed, ["bash_3"]);
});

t("N1 Monitor 사건 알림(<status> 없음) · status=running 은 끝남이 아니다", () => {
  assert.deepEqual(lc({ type: "queue-operation", content: "<task-notification>\n<task-id>bhf2b1dhn</task-id>\n<summary>Monitor event: \"PR\"</summary>\n<event>cla: SUCCESS</event>\n</task-notification>" }).closed, []);
  assert.deepEqual(lc({ type: "queue-operation", content: notice("x1", "running") }).closed, []);
});

t("N2 같은 문구가 결과·알림의 머리가 아닌 곳에 적혀 있으면 세지 않는다", () => {
  //  다른 대화를 grep 한 출력(실측 — 이 세션이 신고 세션 기록을 대조하며 찍은 모양)
  assert.deepEqual(lc(result(`RESULT ('2026-10-04', 'Bash') -> "${BASH}"\nNOTIF ${notice("zz", "completed")}`)), { launched: [], closed: [] });
  assert.deepEqual(lc({ type: "assistant", message: { content: [{ type: "text", text: BASH }] } }), { launched: [], closed: [] }, "AI 본문");
  assert.deepEqual(lc({ type: "user", message: { content: `질문: ${notice("q1", "completed")}` } }).closed, [], "사람 말");
  assert.deepEqual(lc(null), { launched: [], closed: [] });
});

t("N3 서브에이전트 줄은 세지 않는다 — 그 작업의 알림은 메인이 아니라 그 에이전트에게 간다", () => {
  assert.deepEqual(lc({ ...result(BASH), isSidechain: true }), { launched: [], closed: [] });
});

t("F1 feedLines — 띄움 − 끝남 · 같은 알림 두 벌 · 끝난 id 의 띄움 줄이 다시 읽혀도 다시 열리지 않는다", () => {
  const L = (o) => JSON.stringify(o);
  let st = feedLines([L(result(BASH)), L(result(AGENT)), L(result(MONITOR)), "not json", ""].join("\n"), { open: [], closed: [] });
  assert.deepEqual(st.open.sort(), ["a43e481f202df93e9", "bdkb93vju", "bhf2b1dhn"]);
  st = feedLines([L({ type: "queue-operation", content: notice("bdkb93vju", "completed") }), L({ type: "attachment", attachment: { prompt: notice("bdkb93vju", "completed") } })].join("\n"), st);
  assert.deepEqual(st.open.sort(), ["a43e481f202df93e9", "bhf2b1dhn"]);
  st = feedLines(L(result(BASH)), st);
  assert.deepEqual(st.open.sort(), ["a43e481f202df93e9", "bhf2b1dhn"]);
});

const dir = mkdtempSync(join(tmpdir(), "bg-jobs-test-"));
try {
  const file = join(dir, "conv.jsonl"), cache = join(dir, "flags", "sid.bg-jobs.json");
  const line = (o) => JSON.stringify(o) + "\n";

  t("F2 신고 세션 모양(셸 3 · 에이전트 1 전부 끝남)은 0 · 덧붙은 줄만 증분으로 읽는다", () => {
    writeFileSync(file, [
      line({ type: "user", message: { content: "사이드바 로직을 좀 변경해보려고 하는데" } }),
      line(result(BASH)), line({ type: "queue-operation", content: notice("bdkb93vju", "completed") }),
      line(result(MOVED.replace("bvpluxnie", "bd11z5753"))), line({ type: "user", message: { content: notice("bd11z5753", "completed") } }),
      line(result(AGENT)), line({ type: "queue-operation", content: notice("a43e481f202df93e9", "completed", "Agent \"Review\" finished") }),
      line(result(MOVED)), line({ type: "attachment", attachment: { prompt: notice("bvpluxnie", "completed") } }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "아니요, 지금은 아무것도 돌고 있지 않습니다." }] } }),
    ].join(""));
    assert.equal(countOpenJobs(file, cache), 0);
    assert.equal(JSON.parse(readFileSync(cache, "utf8")).size, readFileSync(file).length, "읽은 끝 = 파일 끝");
    appendFileSync(file, line(result(MONITOR)));
    assert.equal(countOpenJobs(file, cache), 1, "덧붙은 Monitor");
    appendFileSync(file, line({ type: "queue-operation", content: notice("bhf2b1dhn", "completed", "Monitor \"x\" stream ended") }));
    assert.equal(countOpenJobs(file, cache), 0);
  });

  t("F3 쓰다 만 마지막 줄은 다음 번에 그 머리부터 다시 읽는다", () => {
    writeFileSync(file, line(result(BASH)));
    const half = line({ type: "queue-operation", content: notice("bdkb93vju", "completed") });
    appendFileSync(file, half.slice(0, 40));
    assert.equal(countOpenJobs(file, cache), 1);
    appendFileSync(file, half.slice(40));
    assert.equal(countOpenJobs(file, cache), 0, "잘렸던 알림이 다음 읽기에 온전히 읽힌다");
  });

  t("F4 파일이 줄었거나 다른 파일이면 처음부터 읽는다", () => {
    writeFileSync(file, line(result(AGENT)));
    assert.equal(countOpenJobs(file, cache), 1, "줄어든 파일");
    const other = join(dir, "other.jsonl");
    writeFileSync(other, line(result(BASH)) + line(result(MONITOR)));
    assert.equal(countOpenJobs(other, cache), 2, "다른 파일");
  });

  t("F5 못 읽으면 null(모른다) — 없는 파일 · 빈 경로", () => {
    assert.equal(countOpenJobs(join(dir, "nope.jsonl"), cache), null);
    assert.equal(countOpenJobs("", cache), null);
  });

  t("F6 덩어리(4MB) 경계에 걸친 한글 줄도 깨지지 않는다", () => {
    const pad = "가".repeat(Math.floor((4 * 1024 * 1024 - 200) / 3));   // 3바이트 글자로 덩어리 경계를 넘긴다
    writeFileSync(file, line({ type: "assistant", message: { content: [{ type: "text", text: pad }] } }) + line(result(BASH)) + line({ type: "user", message: { content: [{ type: "text", text: "한".repeat(500) }] } }) + line(result(MONITOR)));
    assert.equal(countOpenJobs(file, join(dir, "fresh.json")), 2);
  });
} finally { rmSync(dir, { recursive: true, force: true }); }

t("U1 띄우라고 부른 호출(Bash run_in_background · Monitor)의 답을 못 알아보면 «모른다»(null) — 0 으로 세지 않는다", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "bg-jobs-u-"));
  try {
    const f = join(dir2, "c.jsonl"), c = (k) => join(dir2, `${k}.json`);
    const call = (id, name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } }) + "\n";
    const res = (id, text, isError) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] } }) + "\n";
    //  Claude Code 가 띄움 문구를 바꾼 날 — 알아보는 문구가 없다
    writeFileSync(f, call("tu1", "Bash", { command: "sleep 9", run_in_background: true }) + res("tu1", "Started shell bxx in the background."));
    assert.equal(countOpenJobs(f, c("a")), null, "Bash 띄움을 못 알아봤다");
    writeFileSync(f, call("tu2", "Monitor", { command: "x" }) + res("tu2", "Watching (id m9)…"));
    assert.equal(countOpenJobs(f, c("b")), null, "Monitor 띄움을 못 알아봤다");
    writeFileSync(f, call("tu9", "Agent", { prompt: "x", run_in_background: true }) + res("tu9", "Agent queued: a77"));
    assert.equal(countOpenJobs(f, c("h")), null, "백그라운드 에이전트 띄움을 못 알아봤다");
    writeFileSync(f, call("tu10", "Agent", { prompt: "x", run_in_background: true }) + res("tu10", AGENT));
    assert.equal(countOpenJobs(f, c("i")), 1);
    writeFileSync(f, call("tu11", "Agent", { prompt: "x" }) + res("tu11", "리뷰 결과: 문제 없음"));
    assert.equal(countOpenJobs(f, c("j")), 0, "포그라운드 에이전트는 기대하지 않는다");
    //  알아본 띄움 · 오류 결과(권한 거부 · 훅 차단)는 답이다
    writeFileSync(f, call("tu3", "Bash", { command: "sleep 9", run_in_background: true }) + res("tu3", BASH)
      + call("tu4", "Bash", { command: "rm -rf /", run_in_background: true }) + res("tu4", "Permission to use Bash has been denied.", true)
      + JSON.stringify({ type: "queue-operation", content: notice("bdkb93vju", "completed") }) + "\n");
    assert.equal(countOpenJobs(f, c("c")), 0);
    //  포그라운드 Bash · 다른 도구는 기대하지 않는다
    writeFileSync(f, call("tu5", "Bash", { command: "ls" }) + res("tu5", "a b c") + call("tu6", "Read", { file_path: "/x" }) + res("tu6", "…"));
    assert.equal(countOpenJobs(f, c("d")), 0);
    //  답이 다음 증분에 와도 이어 본다(호출만 적힌 채 읽힌 경우)
    writeFileSync(f, call("tu7", "Bash", { command: "sleep 9", run_in_background: true }));
    assert.equal(countOpenJobs(f, c("e")), null);
    appendFileSync(f, res("tu7", BASH));
    assert.equal(countOpenJobs(f, c("e")), 1);
    //  호출과 (못 알아볼) 답이 서로 다른 증분에 읽혀도 «모른다» 가 이어진다 — 기대를 캐시에 들고 간다
    writeFileSync(f, call("tu8", "Bash", { command: "sleep 9", run_in_background: true }));
    assert.equal(countOpenJobs(f, c("g")), null);
    appendFileSync(f, res("tu8", "Started shell bzz in the background."));
    assert.equal(countOpenJobs(f, c("g")), null, "앞 증분의 기대를 잊으면 0 으로 센다");
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});

t("W1 work-flag 배선 — idle 보고(Stop · idle_prompt) · claude 에서만 세고, 못 세면 싣지 않으며, 작업 수가 바뀐 idle 은 스로틀에 안 걸린다", () => {
  const src = readFileSync(join(HERE, "work-flag.mjs"), "utf8");
  assert.match(src, /import \{ countOpenJobs \} from "\.\/bg-jobs\.mjs";/);
  assert.match(src, /const bg = phase === "idle" && HARNESS === "claude" && typeof input\?\.transcript_path === "string"\s*\? countOpenJobs\(input\.transcript_path, join\(FLAG_DIR, `\$\{sid\}\.bg-jobs\.json`\)\) : null;/);
  assert.match(src, /const report = bg === null \? \{ state: phase \} : \{ state: phase, bg \};/);
  assert.match(src, /const key = bg === null \? phase : `\$\{phase\} bg=\$\{bg\}`;/);
  assert.match(src, /if \(last !== key \|\| !cooling\(stateFile, 60_000\)\) \{[\s\S]{0,200}writeFileSync\(stateFile, key\);\s*jobs\.push\(post\("\/active", report\)\);/);
  const manifest = readFileSync(join(HERE, "..", "setup", "kit-manifest.mjs"), "utf8");
  assert.match(manifest, /"bg-jobs\.mjs",/, "훅 디렉터리에 평평하게 같이 깔린다(빠지면 work-flag 가 import 로 죽는다)");
});

console.log(`\n${pass} passed`);
