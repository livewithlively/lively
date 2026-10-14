// 대화창 tui 문법의 글자 규칙 — 회귀 가드 (web/chat-tui.ts, #4707).
//
// 왜 이 테스트가 있나: 상민님 목적함수(2026-10-14) «대화창·터미널창을 왔다갔다해도 거의 똑같다고 느끼게». 이 모듈의 문구는
//  **틀려도 화면이 멀쩡해 보인다** — `Ran 2 shell commands` 가 `Ran 2 shell command` 가 되거나 턴 끝 동사가 터미널과 다른
//  낱말이 돼도 그럴듯해서 아무도 신고하지 않는다(#1822 의 교훈). 그래서 Claude Code 2.1.299 터미널에서 **실측한 글자**를
//  문자열 완전일치로 못박는다. 기대값의 출처: 같은 세션의 tmux 화면(capture-pane 글자+SGR)과 그 세션 대화 파일의 기록,
//  그리고 그 실행 파일에서 옮긴 셈(시간·해시·표 폭). 이 함수들은 순수 포매터라 반환 글자 자체가 관찰 가능한 효과다.
//
// 러너는 web/ 을 수집하지 않으므로 컴파일 산출물(public/app/chat-tui.js)을 import 한다 — DOM·전역 없는 모듈이라 그대로 불린다.
// 엣지 표(22행 — 경계값 · 새 헬퍼의 빈 입력 · 단·복수 · 모르는 꼴)는 각 test 이름 앞의 #n 이 그 행이다.
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 턴 끝 시각(`done 6:43 PM`)은 그 기록의 시각을 **보는 사람의 시간대**로 찍는다 — 실측한 터미널(맥미니)과 같은 서울 시간으로 고정한다.
process.env.TZ = "Asia/Seoul";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = await import(pathToFileURL(path.join(ROOT, "public/app/chat-tui.js")).href);

/** 꾸민 조각 → 글자(굵게·흐림은 버린다 — 글자 계약만 본다). */
const txt = (segs) => segs.map((s) => s.t).join("");
/** 꾸민 조각 중 굵은 것만. */
const bolds = (segs) => segs.filter((s) => s.b).map((s) => s.t);
/** 접힘 셈 여러 개 → 묶음. */
const grp = (...cs) => { const x = T.newGroup(); for (const c of cs) T.addToGroup(x, c); return x; };
const BASH = { kind: "bash", hint: "" };
const MCP = { kind: "mcp", label: "lively", hint: "" };

test("배선 · 모듈이 함수를 내보낸다(관측 장치가 살아 있나)", () => {
  for (const k of ["fmtElapsed", "pastVerbOf", "turnEndSegs", "doneAtLabel", "tuiCollapse", "shellKind", "splitShell", "groupSegs", "editSegs",
    "tuiToolResult", "bashPopsOut", "tuiToolHead", "tuiHighlight", "tuiTableLayout", "dispWidth", "wrapWords", "taskNoticeSegs", "lineNotice", "turnEndOf"]) {
    assert.equal(typeof T[k], "function", k);
  }
});

// ── 시간(행위 1) ─────────────────────────────────────────────────────────────────────────────
test("#1~5 · 시간 — 1분 미만 내림 · 1분부터 반올림과 올림", () => {
  assert.equal(T.fmtElapsed(43955), "43s");          // 실측 `Baked for 43s`
  assert.equal(T.fmtElapsed(48819), "48s");          // 실측 `Crunched for 48s`(반올림이면 49s — 내림이 맞다)
  assert.equal(T.fmtElapsed(230602), "3m 51s");      // 실측 `Churned for 3m 51s`
  assert.equal(T.fmtElapsed(60989), "1m 1s");        // 실측 `Agent … finished · 1m 1s`
  assert.equal(T.fmtElapsed(59999), "59s");          // #1 경계
  assert.equal(T.fmtElapsed(60000), "1m 0s");        // #2 경계
  assert.equal(T.fmtElapsed(119600), "2m 0s");       // #3 59.6초 → 60 → 분으로 올림
  assert.equal(T.fmtElapsed(3599999), "1h 0m 0s");   // #4 연쇄 올림
  assert.equal(T.fmtElapsed(0), "0s");               // #5
});

// ── 턴 끝 줄(행위 2) ─────────────────────────────────────────────────────────────────────────
test("턴 끝 · 동사·시각이 터미널과 같다(같은 세션 대화 파일의 기록 ↔ 터미널 화면)", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const cases = [
    ["3846be7f-007a-460e-8417-84ed1cb0d2ad", 43955, "2026-10-14T09:34:36.914Z", "Baked for 43s · done 6:34 PM"],
    ["a01168dc-e7eb-4140-9244-910cde9994eb", 48819, "2026-10-14T09:40:20.496Z", "Crunched for 48s · done 6:40 PM"],
    ["5e04e7d1-9a7f-4c19-911c-10b8a46e4e92", 230602, "2026-10-14T09:43:22.279Z", "Churned for 3m 51s · done 6:43 PM"],
  ];
  for (const [uuid, ms, ts, want] of cases) assert.equal(txt(T.turnEndSegs({ pendingBg: 0, durationMs: ms, uuid, ts, now })), want);
});

test("#6 · uuid 를 모르면 빈 글자의 해시(=Baked) — 터미널과 같다", () => {
  assert.equal(T.pastVerbOf(undefined), "Baked");
  assert.equal(T.pastVerbOf(""), "Baked");
});

test("#7 · 시각을 모르거나 깨졌으면 `· done` 없이 시간만", () => {
  assert.equal(txt(T.turnEndSegs({ pendingBg: 0, durationMs: 5000, uuid: "", ts: "" })), "Baked for 5s");
  assert.equal(txt(T.turnEndSegs({ pendingBg: 0, durationMs: 5000, uuid: "", ts: "nope" })), "Baked for 5s");
});

test("턴 끝 · 시각 꼴 — 오늘/일주일 안/그 전", () => {
  const now = new Date("2026-10-14T12:00:00Z");   // 서울 21:00
  assert.equal(T.doneAtLabel("2026-10-14T09:43:22Z", now), "6:43 PM");
  assert.equal(T.doneAtLabel("2026-10-12T09:43:22Z", now), "Monday 6:43 PM");
  assert.equal(T.doneAtLabel("2026-09-30T09:43:22Z", now), "Wednesday, Sep 30, 6:43 PM");
});

test("#8 · 백그라운드 에이전트가 돌면 Waiting 줄 — 단수/복수, 숫자만 굵게", () => {
  const one = T.turnEndSegs({ pendingBg: 1, durationMs: 1000, uuid: "x" });
  assert.equal(txt(one), "Waiting for 1 background agent to finish");
  assert.deepEqual(bolds(one), ["1"]);
  assert.equal(txt(T.turnEndSegs({ pendingBg: 2, durationMs: 1000 })), "Waiting for 2 background agents to finish");
});

// ── 접힘 판정(행위 3) ───────────────────────────────────────────────────────────────────────
test("접힘 · 들여다보는 도구는 접히고, 바꾸거나 밖으로 나가는 도구는 따로 선다", () => {
  const cwd = "/Users/x/proj";
  assert.deepEqual(T.tuiCollapse("Read", { file_path: "/Users/x/proj/a.ts" }, cwd), { kind: "read", path: "/Users/x/proj/a.ts", hint: "a.ts" });
  assert.equal(T.tuiCollapse("Grep", { pattern: "foo" }, cwd).kind, "search");
  assert.equal(T.tuiCollapse("Glob", { pattern: "*.ts" }, cwd).kind, "search");
  assert.equal(T.tuiCollapse("Bash", { command: "npm test" }, cwd).kind, "bash");
  assert.equal(T.tuiCollapse("Bash", { command: "ls -la web" }, cwd).kind, "list");
  assert.equal(T.tuiCollapse("Bash", { command: "cat a.txt" }, cwd).kind, "read");
  assert.deepEqual(T.tuiCollapse("mcp__lively__knowledge_get", { name: "a" }, cwd), { kind: "mcp", label: "lively", hint: "" });
  assert.equal(T.tuiCollapse("TodoWrite", { todos: [] }, cwd).kind, "absorb");
  assert.equal(T.tuiCollapse("ToolSearch", { query: "x" }, cwd).kind, "absorb");
  assert.equal(T.tuiCollapse("Write", { file_path: "/Users/x/.claude/projects/-p/memory/a.md", content: "x" }, cwd).kind, "mem");
  assert.deepEqual(T.tuiCollapse("Edit", { file_path: "/private/tmp/claude-501/-p/sess/scratchpad/n.md", old_string: "a", new_string: "b\nc" }, cwd),
    { kind: "scratch", add: 2, del: 1, hint: "/private/tmp/claude-501/-p/sess/scratchpad/n.md" });
  assert.equal(T.tuiCollapse("Edit", { file_path: "/Users/x/proj/a.ts", old_string: "a", new_string: "b" }, cwd), null);
  assert.equal(T.tuiCollapse("Write", { file_path: "/Users/x/proj/a.ts", content: "a" }, cwd), null);
  assert.equal(T.tuiCollapse("Agent", { subagent_type: "fork", description: "x" }, cwd), null);
  assert.equal(T.tuiCollapse("WebFetch", { url: "https://x" }, cwd), null);
});

test("#12~14 · 셸 갈래 — 다른 명령이 하나라도 섞이면 그냥 셸, 돌려보내기 & 와 따옴표 안 | 는 경계가 아니다", () => {
  assert.equal(T.shellKind("ls"), "list");
  assert.equal(T.shellKind("ls | grep x"), "list");                     // 목록이 검색보다 먼저
  assert.equal(T.shellKind("head -5 a && wc -l a"), "read");
  assert.equal(T.shellKind("echo hi"), null);                           // #12 중립 낱말만
  assert.equal(T.shellKind("ls && npm test"), null);                    // #12
  assert.equal(T.shellKind("FOO=1 grep x"), null);                      // #12 첫 낱말이 목록 밖
  assert.equal(T.shellKind("find . -name '*.ts' 2>&1 | head"), "search");  // #13
  assert.deepEqual(T.splitShell("grep 'a|b' f | wc -l"), ["grep 'a|b' f ", " wc -l"]);   // #14
});

// ── 묶음 문구(행위 4) — 터미널에서 실측한 글자 그대로 ──────────────────────────────────────────
test("묶음 · 실측 문구", () => {
  assert.equal(txt(T.groupSegs(grp(BASH, BASH))), "Ran 2 shell commands");
  assert.equal(txt(T.groupSegs(grp(BASH))), "Ran 1 shell command");
  assert.equal(txt(T.groupSegs(grp(MCP, BASH))), "Called lively, ran 1 shell command");
  assert.equal(txt(T.groupSegs(grp({ kind: "scratch", add: 1, del: 1, hint: "" }, { kind: "scratch", add: 1, del: 1, hint: "" }, BASH))),
    "Made 2 scratchpad edits +2 -2, ran 1 shell command");
  assert.equal(txt(T.groupSegs(grp({ kind: "list", hint: "" }, { kind: "mem", hint: "" }, { kind: "mem", hint: "" }))), "Listed 1 directory, wrote 2 memories");
  assert.equal(txt(T.groupSegs(grp({ kind: "read", path: "/a", hint: "" }, BASH))), "Read 1 file, ran 1 shell command");
  assert.equal(txt(T.groupSegs(grp({ kind: "search", hint: "" }, { kind: "search", hint: "" }, { kind: "read", path: "/a", hint: "" }, BASH, BASH))),
    "Searched for 2 patterns, read 1 file, ran 2 shell commands");
  assert.equal(txt(T.groupSegs(grp({ kind: "mcp", label: "plugin:playwright:playwright", hint: "" }, BASH, BASH), true)),
    "Calling plugin:playwright:playwright, running 2 shell commands");   // 도는 중(실측)
  assert.deepEqual(bolds(T.groupSegs(grp(BASH, BASH))), ["2"]);
});

test("#9 · 같은 파일을 두 번 읽어도 1 file", () => {
  assert.equal(txt(T.groupSegs(grp({ kind: "read", path: "/a", hint: "" }, { kind: "read", path: "/a", hint: "" }))), "Read 1 file");
});

test("#10 · MCP 한 번은 이름만, 두 번부터 N times", () => {
  assert.equal(txt(T.groupSegs(grp(MCP))), "Called lively");
  assert.equal(txt(T.groupSegs(grp(MCP, MCP))), "Called lively 2 times");
});

test("#11 · 할 일 목록 갱신만 든 묶음은 줄이 없다", () => {
  assert.equal(T.groupVisible(grp({ kind: "absorb" })), false);
  assert.equal(T.groupVisible(grp({ kind: "absorb" }, BASH)), true);
});

// ── 결과 머리(행위 5~7) ─────────────────────────────────────────────────────────────────────
test("Update 머리 · 문구와 굵은 숫자", () => {
  assert.equal(txt(T.editSegs(12, 7)), "Added 12 lines, removed 7 lines");   // 실측
  assert.deepEqual(bolds(T.editSegs(12, 7)), ["12", "7"]);
  assert.equal(txt(T.editSegs(1, 0)), "Added 1 line");
  assert.equal(txt(T.editSegs(0, 3)), "Removed 3 lines");
});

test("#15 · 바뀐 줄이 없으면 머리 조각도 없다", () => {
  assert.deepEqual(T.editSegs(0, 0), []);
});

test("Edit · 구조화 패치 → 옛/새 줄 번호 변경분 + 머리", () => {
  const r = T.tuiToolResult("Edit", { file_path: "/p/a.ts", old_string: "x", new_string: "y" }, "ok", false,
    { structuredPatch: [{ oldStart: 10, newStart: 10, lines: [" a", "-b", "+c", "+d"] }] }, "/p");
  assert.equal(txt(r.sumSegs), "Added 2 lines, removed 1 line");
  assert.deepEqual(r.diff.map((d) => [d.kind, d.no, d.text]), [["ctx", 10, "a"], ["del", 11, "b"], ["add", 11, "c"], ["add", 12, "d"]]);
});

test("Write(새 파일) · `Wrote N lines to 경로` + 앞 10줄 + 남은 수", () => {
  const content = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  const r = T.tuiToolResult("Write", { file_path: "/p/b.md", content }, "", false, { type: "create" }, "/p");
  assert.equal(txt(r.sumSegs), "Wrote 12 lines to b.md");
  assert.equal(r.code.length, 10);
  assert.equal(r.more, 2);
});

test("셸이 파일을 바꿨다 · 빼내서 `Updated 경로 (+a -r)` + 변경분", () => {
  const meta = { stdout: "ok", bashEditDiff: { files: [{ filePath: "/p/web/x.ts", hunks: [{ oldStart: 1, newStart: 1, lines: [" a", "+b", "+c", "+d", "+e"] }] }], moreFiles: 0 } };
  assert.equal(T.bashPopsOut(meta), true);
  const r = T.tuiToolResult("Bash", { command: "python3 edit.py" }, "ok", false, meta, "/p");
  assert.equal(r.lines[0], "ok");
  assert.equal(txt(r.edits[0].segs), "Updated web/x.ts (+4 -0)");   // 실측 꼴
  assert.equal(r.edits[0].diff.length, 5);
  const g = T.tuiToolResult("Bash", { command: "git checkout main && python3 e.py" }, "", false, meta, "/p");
  assert.equal(g.edits[0].diff.length, 0);
  assert.match(g.notes.join("\n"), /a git step in this command can move the working tree/);
});

test("#16 · 바뀐 파일 정보가 없거나 건너뛰었거나 모르면 빼내지 않는다", () => {
  assert.equal(T.bashPopsOut({ stdout: "x" }), false);
  assert.equal(T.bashPopsOut({ bashEditDiff: { skipped: true, files: [] } }), false);
  assert.equal(T.bashPopsOut({ bashEditDiff: { unavailable: true, files: [], moreFiles: 0 } }), false);
  assert.equal(T.bashPopsOut({ bashEditDiff: { unavailable: true, files: [], moreFiles: 2 } }), true);
});

test("#17 · 셸 변경분은 파일당 40줄 — 정확히 40이면 숨김 0, 41이면 1", () => {
  const mk = (n) => ({ bashEditDiff: { files: [{ filePath: "/p/a.ts", hunks: [{ oldStart: 1, newStart: 1, lines: Array.from({ length: n }, (_, i) => `+l${i}`) }] }], moreFiles: 0 } });
  assert.equal(T.tuiToolResult("Bash", { command: "x" }, "", false, mk(40), "/p").edits[0].hidden, 0);
  assert.equal(T.tuiToolResult("Bash", { command: "x" }, "", false, mk(41), "/p").edits[0].hidden, 1);
});

test("출력 없는 셸 · (No output) / 백그라운드 안내", () => {
  assert.equal(T.tuiToolResult("Bash", { command: "true" }, "", false, {}, "/p").summary, "(No output)");
  assert.equal(T.tuiToolResult("Bash", { command: "x" }, "", false, { backgroundTaskId: "b1" }, "/p").summary, "Running in the background (↓ to manage)");
});

test("백그라운드 에이전트 · 터미널의 괄호 안내 그대로", () => {
  const r = T.tuiToolResult("Agent", { subagent_type: "fork", description: "기록" }, "Async agent launched successfully. agentId: a1", false, { isAsync: true, status: "async_launched", agentId: "a1" }, "/p");
  assert.equal(txt(r.sumSegs), "Backgrounded agent (↓ to manage · ctrl+o to expand)");
});

// ── 머리(행위 8·9) ─────────────────────────────────────────────────────────────────────────
test("#18 · 셸 머리는 두 줄까지 — 정확히 두 줄이면 `…` 없음, 세 줄이면 있음", () => {
  assert.equal(T.tuiToolHead("Bash", { command: "a\nb" }, "/p").args, "a\n    b");
  assert.equal(T.tuiToolHead("Bash", { command: "python3 - <<'EOF'\np='web/chat-view.ts'\nEOF" }, "/p").args, "python3 - <<'EOF'\n    p='web/chat-view.ts'…");   // 실측
});

test("머리 · Update · 에이전트 종류 · MCP 원래 서버 이름", () => {
  assert.equal(T.tuiToolHead("Edit", { file_path: "/p/kit/hooks/bg-jobs.test.mjs" }, "/p").name, "Update");
  assert.deepEqual(T.tuiToolHead("Agent", { subagent_type: "fork", description: "기록: x" }, "/p"), { name: "fork", args: "기록: x" });
  assert.equal(T.tuiToolHead("mcp__plugin_playwright_playwright__browser_click", { ref: "e1" }, "/p").name, "plugin:playwright:playwright - browser_click (MCP)");
  assert.equal(T.mcpLabel("plugin_playwright_playwright"), "plugin:playwright:playwright");   // 실측 `Calling plugin:playwright:playwright`
  assert.equal(T.mcpLabel("claude_ai_Claude_Docs"), "Claude Docs");
  assert.equal(T.mcpServer("claude_ai_Claude_Docs"), "claude.ai Claude Docs");
});

// ── 완료 알림 판정 — 대화 파일 한 줄 → 알림인가(리뷰 지적 반영: 끼워 넣기 꼴 · 인용한 사람 말 · isMeta) ─────────────────
const NOTE = (id = "a1b2", extra = "") => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "기록" finished</summary>\n${extra}</task-notification>`;
test("알림 판정 · 사람 말 꼴과 끼워 넣기(queued_command) 꼴 둘 다 읽는다", () => {
  const u = T.lineNotice({ type: "user", message: { role: "user", content: NOTE("t1", "<usage><duration_ms>188000</duration_ms></usage>") } });
  assert.equal(u.taskId, "t1");
  assert.equal(txt(u.segs), 'Agent "기록" finished · 3m 8s');
  assert.equal(u.inline, false);
  const a = T.lineNotice({ type: "attachment", attachment: { type: "queued_command", prompt: NOTE("t2"), commandMode: "task-notification" } });
  assert.equal(a.taskId, "t2");
  assert.equal(a.inline, true);                        // 도는 중에 끼워 넣은 알림 — 턴을 열지 않는다
  const arr = T.lineNotice({ type: "attachment", attachment: { type: "queued_command", prompt: [{ type: "text", text: NOTE("t3") }] } });
  assert.equal(arr.taskId, "t3");
  assert.equal(T.lineNotice({ type: "user", message: { content: [{ type: "text", text: NOTE("t4") }] } }).taskId, "t4");
  assert.equal(T.lineNotice({ type: "user", message: { content: NOTE("f1").replace("completed", "failed") } }).tone, "err");
});
test("알림 판정 · 알림이 아닌 것 — 꼬리표를 인용한 사람 말 · isMeta · task-id 없음 · 다른 끼워 넣기 · 도구 결과", () => {
  assert.equal(T.lineNotice({ type: "user", message: { content: "이 꼬리표를 보세요: " + NOTE("x") } }), null);
  assert.equal(T.lineNotice({ type: "user", isMeta: true, message: { content: NOTE("x") } }), null);
  assert.equal(T.lineNotice({ type: "user", message: { content: "<task-notification><status>completed</status></task-notification>" } }), null);
  assert.equal(T.lineNotice({ type: "attachment", attachment: { type: "queued_command", prompt: '<agent-message from="a">hi</agent-message>' } }), null);
  assert.equal(T.lineNotice({ type: "attachment", attachment: { type: "nested_memory", content: NOTE("x") } }), null);
  assert.equal(T.lineNotice({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u", content: NOTE("x") }] } }), null);
  assert.equal(T.lineNotice({ type: "assistant", message: { content: [{ type: "text", text: NOTE("x") }] } }), null);
  assert.equal(T.lineNotice(null), null);
});

test("턴 끝 재료 · turn_duration 만 줄을 싣고, Stop 훅 요약은 마감만", () => {
  assert.deepEqual(T.turnEndOf({ type: "system", subtype: "turn_duration", durationMs: 48819, uuid: "u1", timestamp: "2026-10-14T09:40:20.496Z", pendingBackgroundAgentCount: 1 }),
    { durationMs: 48819, turnEnd: { uuid: "u1", ts: "2026-10-14T09:40:20.496Z", pendingBg: 1 } });
  assert.deepEqual(T.turnEndOf({ type: "system", subtype: "stop_hook_summary" }), {});
  assert.deepEqual(T.turnEndOf({ type: "system", subtype: "turn_duration" }), { durationMs: 0, turnEnd: { uuid: undefined, ts: undefined, pendingBg: 0 } });
});

test("상태 줄 모드 · 실측 글자와 색 갈래", () => {
  assert.deepEqual(T.tuiMode("auto"), { glyph: "⏵⏵", text: "auto mode on", tone: "warn" });
  assert.equal(T.tuiMode("plan").text, "plan mode on");
  assert.equal(T.tuiMode("acceptEdits").text, "accept edits on");
  assert.equal(T.tuiMode("default"), null);
  assert.equal(T.tuiMode(null), null);
});

test("모델 이름 · Claude Code 가 적는 꼴", () => {
  assert.equal(T.ccModelName("claude-opus-5-5"), "Opus 5.5");
  assert.equal(T.ccModelName("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(T.ccModelName("claude-opus-5-5[1m]"), "Opus 5.5 (1M context)");
  assert.equal(T.ccModelName("gpt-x"), "gpt-x");
});

test("비동기 에이전트 판정 · 하네스 값이 먼저, 없으면 본문 머리", () => {
  assert.equal(T.isAsyncAgent({ status: "async_launched" }, ""), true);
  assert.equal(T.isAsyncAgent({}, "Async agent launched successfully. agentId: a9"), true);
  assert.equal(T.isAsyncAgent({ status: "completed" }, "done"), false);
  assert.equal(T.asyncAgentId({}, "Async agent launched successfully. agentId: a9 (x)"), "a9");
  assert.equal(T.asyncAgentId({ agentId: "b1" }, "agentId: zz"), "b1");
});

test("알림 · 완료 알림의 걸린 시간은 흐린 조각(실측 inactive 색)", () => {
  const segs = T.taskNoticeSegs({ taskId: "a", status: "completed", summary: 'Agent "기록" finished', durationMs: 188000 });
  assert.equal(txt(segs), 'Agent "기록" finished · 3m 8s');
  assert.equal(segs[1].d, true);
  assert.equal(txt(T.taskNoticeSegs({ taskId: "b", status: "completed", summary: "Background command \"x\" completed (exit code 0)", durationMs: null })),
    'Background command "x" completed (exit code 0)');
});

// ── 문법 색(행위 10) — 실측한 갈래(키워드 125 · 함수 97 · 글자 24 · 속성 31 · 클래스 16 · 주석 246) ──────────
test("문법 색 · 터미널이 칠한 갈래와 같다", () => {
  const kinds = (line, lang = "ts") => T.tuiHighlight(line, lang).filter((t) => t.k).map((t) => [t.t, t.k]);
  assert.deepEqual(kinds(`const root = mkdtempSync(join(tmpdir(), "bg-proc-"));`),
    [["const", "store"], ["mkdtempSync", "fn"], ["join", "fn"], ["tmpdir", "fn"], [`"bg-proc-"`, "str"]]);
  assert.deepEqual(kinds(`if (process.platform !== "win32") {`), [["if", "kw"], ["platform", "prop"], [`"win32"`, "str"]]);
  assert.deepEqual(kinds(`let tableRo: ResizeObserver | null = null;`), [["let", "store"], ["ResizeObserver", "cls"], ["null", "lit"], ["null", "lit"]]);
  assert.deepEqual(kinds(`if (INTERRUPT_RE.test(ut)) x();`), [["if", "kw"], ["INTERRUPT_RE", "prop"], ["test", "fn"], ["x", "fn"]]);
  assert.deepEqual(kinds(`view.event(rec.t, { type: 'user' })`), [["event", "fn"], ["t", "prop"], ["type", "attr"], ["'user'", "str"]]);
  assert.deepEqual(kinds(`// 주석`), [["// 주석", "com"]]);
});

test("#21 · 모르는 확장자는 칠하지 않는다", () => {
  assert.deepEqual(T.tuiHighlight("# 제목 `x`", "md"), [{ t: "# 제목 `x`" }]);
  assert.deepEqual(T.tuiHighlight("const x = 1", ""), [{ t: "const x = 1" }]);
});

// ── 표(행위 11) ─────────────────────────────────────────────────────────────────────────────
test("표 · 들어가면 상자(칸 폭 = 가장 긴 칸, 최소 3)", () => {
  const box = T.tuiTableLayout(["PR", "내용"], [["#1225", "self-update 시험"]], 90);
  assert.equal(box.kind, "box");
  assert.deepEqual(box.widths, [5, 16]);
});

test("#19 · 한 칸이 정확히 4줄이면 상자, 5줄이면 세로꼴(행 사이 ─ 40칸)", () => {
  //  18칸 화면: 방 = 18 − (1 + 2×3) − 4 = 7 = 낱말 폭 합(3 + 4) → 두 번째 칸이 4칸으로 눌려 `abcd` 하나씩 한 줄 — 낱말 수 = 줄 수.
  const mk = (n) => Array.from({ length: n }, () => "abcd").join(" ");
  const four = T.tuiTableLayout(["a", "b"], [["x", mk(4)]], 18);
  assert.equal(four.kind, "box");
  assert.deepEqual(four.widths, [3, 4]);
  const five = T.tuiTableLayout(["a", "b"], [["x", mk(5)]], 18);
  assert.equal(five.kind, "vertical");
  const long = "아주 긴 설명 ".repeat(40);
  const v = T.tuiTableLayout(["문제", "원인"], [["윈도 시험", long], ["시크릿", "짧음"]], 90);
  assert.equal(v.kind, "vertical");
  assert.equal(v.lines[0].head, "문제");
  assert.ok(v.lines.some((l) => l.sep === "─".repeat(40)));
});

test("#20 · 칸 폭 — 한글·한자는 두 칸, 라틴은 한 칸", () => {
  assert.equal(T.dispWidth("가a"), 3);
  assert.equal(T.dispWidth("PR #1331"), 8);
  assert.deepEqual(T.wrapWords("가나 다라 마바", 5, false), ["가나", "다라", "마바"]);
  assert.deepEqual(T.wrapWords("가나 다라 마바", 9, false), ["가나 다라", "마바"]);   // 경계: 정확히 9칸
});
