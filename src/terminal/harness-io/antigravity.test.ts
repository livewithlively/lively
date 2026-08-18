// antigravity 파서(antigravity.ts) — 사양 §E 표 전수 (#1746). 픽스처는 실측 transcript_full.jsonl(agy 1.1.13, 2026-08-18) 줄 모양 그대로.
import assert from "node:assert/strict";
import { parseAntigravity, userRequestOf } from "./antigravity.js";
import type { ChatLine } from "./chat-line.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const row = (o: Record<string, unknown>): string => JSON.stringify(o);
const T0 = "2026-08-14T10:27:07Z";
const F = {
  user: row({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: T0, content: "<USER_REQUEST>\n진행하자\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: …\n</ADDITIONAL_METADATA>" }),
  hist: row({ step_index: 1, source: "SYSTEM", type: "CONVERSATION_HISTORY", status: "DONE", created_at: "2026-08-14T10:27:08Z" }),
  plan: row({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-08-14T10:27:08Z", thinking: "**Begin**\n\nplan.", content: "먼저 확인할게요.", tool_calls: [
    { name: "run_command", args: { CommandLine: "git status", Cwd: "/w", toolSummary: "status" } },
    { name: "view_file", args: { AbsolutePath: "/w/a.ts" } }] }),
  view: row({ step_index: 4, source: "MODEL", type: "VIEW_FILE", status: "DONE", created_at: "2026-08-14T10:27:09Z", content: "File Path: `file:///w/a.ts`\n1: hello" }),
  run: row({ step_index: 3, source: "MODEL", type: "RUN_COMMAND", status: "DONE", exit_code: 128, created_at: "2026-08-14T10:27:10Z", content: "The command exited with code 128.\nfatal: not a git repository" }),
  ckpt: row({ step_index: 5, source: "SYSTEM", type: "CHECKPOINT", status: "DONE", created_at: "2026-08-14T10:27:14Z", content: "{{ CHECKPOINT 0 }}\n **The earlier parts… truncated**" }),
  final: row({ step_index: 6, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-08-14T10:27:20Z", content: "끝났어요." }),
  errModel: row({ step_index: 13, source: "MODEL", type: "ERROR_MESSAGE", status: "DONE", created_at: "2026-08-14T10:27:21Z", error: "There was a problem parsing the tool call." }),
  errSys: row({ step_index: 14, source: "SYSTEM", type: "ERROR_MESSAGE", status: "DONE", created_at: "2026-08-14T10:27:22Z", content: "quota exceeded" }),
  planMcp: row({ step_index: 10, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-08-14T10:27:30Z", tool_calls: [{ name: "call_mcp_tool", args: { server: "lively", tool: "team_list" } }] }),
  mcp: row({ step_index: 11, source: "MODEL", type: "MCP_TOOL", status: "DONE", created_at: "2026-08-14T10:27:31Z", content: "Created At: …\n{\n  \"teams\": []\n}" }),
  user2: row({ step_index: 12, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-08-14T10:28:00Z", content: "고마워" }),
  runLate: row({ step_index: 11, source: "MODEL", type: "RUN_COMMAND", status: "DONE", exit_code: 0, created_at: "2026-08-14T10:27:31Z", content: "ok" }),
};
const run = (ls: string[], state = {}) => parseAntigravity(ls.join("\n") + "\n", state);
const blocks = (l: ChatLine): any[] => (l.type === "system" ? [] : (Array.isArray(l.message.content) ? l.message.content : [{ type: "text", text: l.message.content }]));
const kinds = (ls: ChatLine[]): string[] => ls.map((l) => l.type === "system" ? `system:${l.subtype}` : `${l.type}:${blocks(l).map((b) => b.type).join("+")}`);

t("[E1] USER_INPUT — <USER_REQUEST> 안 본문만 · 태그 없으면 전문 · CONVERSATION_HISTORY 는 버림", () => {
  assert.equal(userRequestOf("<USER_REQUEST>\n진행하자\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>"), "진행하자");
  assert.equal(userRequestOf("고마워"), "고마워");
  const { lines } = run([F.user, F.hist]);
  assert.equal(lines.length, 1); assert.deepEqual([lines[0].type, blocks(lines[0])[0].text], ["user", "진행하자"]);
});
t("[E2] PLANNER_RESPONSE(thinking+content+tool_calls) → assistant [thinking, text, tool_use×2] · id=agy-<step>-<i> · 턴은 안 닫힘", () => {
  const { lines } = run([F.user, F.plan]);
  assert.deepEqual(kinds(lines), ["user:text", "assistant:thinking+text+tool_use+tool_use"]);
  const b = blocks(lines[1]);
  assert.deepEqual(b[2], { type: "tool_use", id: "agy-2-0", name: "run_command", input: { CommandLine: "git status", Cwd: "/w", toolSummary: "status" } });
  assert.equal(b[3].id, "agy-2-1"); assert.equal(b[3].name, "view_file");
});
t("[E3] 결과 짝짓기 — 종류가 맞는 대기와(VIEW_FILE 이 먼저 와도 view_file 과) · RUN_COMMAND exit_code≠0 → is_error", () => {
  const { lines } = run([F.user, F.plan, F.view, F.run]);
  const results = lines.filter((l) => l.type === "user" && Array.isArray(l.message.content));
  assert.equal(results.length, 2);
  assert.deepEqual(blocks(results[0])[0], { type: "tool_result", tool_use_id: "agy-2-1", content: "File Path: `file:///w/a.ts`\n1: hello", is_error: false });
  assert.deepEqual(blocks(results[1])[0], { type: "tool_result", tool_use_id: "agy-2-0", content: "The command exited with code 128.\nfatal: not a git repository", is_error: true });
});
t("[E4] 종류 매칭이 없으면 가장 오래된 대기 · 대기가 없으면(창의 첫머리) 결과는 버림", () => {
  const { lines } = run([F.user, F.planMcp, F.runLate]);      // run_command 대기는 없고 mcp 대기만(더 앞 스텝) → RUN_COMMAND 가 그 대기와 짝
  const r = lines.filter((l) => l.type === "user" && Array.isArray(l.message.content));
  assert.equal(r.length, 1); assert.equal(blocks(r[0])[0].tool_use_id, "agy-10-0");
  const cold = run([F.view]);
  assert.equal(cold.lines.length, 0);
});
t("[E5] CHECKPOINT → system compact(text=content) · content 만 있는 PLANNER → assistant text + system turn_duration(USER_INPUT 부터)", () => {
  const { lines } = run([F.user, F.plan, F.ckpt, F.final]);
  const k = kinds(lines);
  assert.equal(k[2], "system:compact"); assert.ok(String((lines[2] as any).text).startsWith("{{ CHECKPOINT 0 }}"));
  assert.deepEqual(k.slice(3), ["assistant:text", "system:turn_duration"]);
  assert.equal((lines[4] as any).durationMs, Date.parse("2026-08-14T10:27:20Z") - Date.parse(T0));
});
t("[E6] ERROR_MESSAGE — MODEL+대기 있음 → 오류 결과(is_error) · MODEL+대기 없음 → assistant ⚠ 글 · SYSTEM → assistant ⚠ 글", () => {
  const withPending = run([F.user, F.planMcp, F.errModel]);
  const r = withPending.lines[withPending.lines.length - 1];
  assert.deepEqual(blocks(r)[0], { type: "tool_result", tool_use_id: "agy-10-0", content: "There was a problem parsing the tool call.", is_error: true });
  const noPending = run([F.errModel, F.errSys]);
  assert.deepEqual(kinds(noPending.lines), ["assistant:text", "assistant:text"]);
  assert.equal(blocks(noPending.lines[0])[0].text, "⚠ There was a problem parsing the tool call.");
  assert.equal(blocks(noPending.lines[1])[0].text, "⚠ quota exceeded");
});
t("[E7] 열린 턴 뒤에 USER_INPUT 이 오면 앞에 turn_duration 을 먼저 닫고 대기열을 비운다", () => {
  const { lines } = run([F.user, F.plan, F.user2, F.run]);     // plan 의 run_command 대기는 user2 에서 비워진다 → run 은 버림
  assert.deepEqual(kinds(lines), ["user:text", "assistant:thinking+text+tool_use+tool_use", "system:turn_duration", "user:text"]);
});
t("[E8] 상태 이어달리기 — 창1 PLANNER(tool_calls) · 창2 RUN_COMMAND → 창1 id 와 짝(state.pending 경유) · 이어주지 않으면 버림", () => {
  const w1 = run([F.user, F.plan]);
  const w2 = run([F.run], w1.state);
  assert.equal(w2.lines.length, 1); assert.equal(blocks(w2.lines[0])[0].tool_use_id, "agy-2-0");
  assert.equal(run([F.run]).lines.length, 0);
});
t("[E9] step_index 가 앞뒤로 논다 — 결과(3)가 PLANNER(2)보다 먼저 파일에 오면 결과는 버려지고 틀린 짝은 만들지 않는다", () => {
  const { lines } = run([F.user, F.run, F.plan]);
  const results = lines.filter((l) => l.type === "user" && Array.isArray(l.message.content));
  assert.equal(results.length, 0);
  assert.equal(kinds(lines)[1], "assistant:thinking+text+tool_use+tool_use");
});
t("[E10] MCP 짝 — call_mcp_tool ↔ MCP_TOOL", () => {
  const { lines } = run([F.user, F.planMcp, F.mcp]);
  const r = lines[lines.length - 1];
  assert.deepEqual([blocks(r)[0].tool_use_id, blocks(r)[0].is_error], ["agy-10-0", false]);
});

console.log(`harness-io/antigravity: ${pass} passed`);
