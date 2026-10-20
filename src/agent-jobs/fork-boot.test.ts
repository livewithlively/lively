// 세션 분기 판 재료 — 순수 엣지 표 B1~B9(#4489 앱 v2-10). 실행: npm run build && node dist/agent-jobs/fork-boot.test.js
//  이게 틀리면: 저장된 좌표의 잡값이 하네스 인자로 들어가거나(플래그 주입), 도구를 줄이는 인자가 끼어 캐시가 깨지거나,
//  키트 훅이 켜진 채 분기가 본 세션의 대화 매핑을 덮거나, 라이블리 쓰기 도구가 열린 채 돈다.
import assert from "node:assert/strict";
import { FORK_GUARD_COMMAND, forkBoot, parseForkSpec, type ForkSpec } from "./fork-boot.js";
import { FORK_GUARD_SOURCE } from "./fork-guard.js";
import { CLAUDE_AI_CONNECTORS_OFF_ENV } from "../terminal/claude-ai-connectors-off.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const CONV = "AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee";
const raw = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  session: "box-a1", conversation: CONV, harness: "claude", model: "opus", effort: "high", block_connectors: false,
  app_folder: ".lively/apps/deck-edit", ...o,
});

// ── B1~B3 저장된 좌표 읽기 ──
{
  assert.deepEqual(parseForkSpec(raw()), {
    session: "box-a1", conversation: CONV.toLowerCase(), harness: "claude", model: "opus", effort: "high", block_connectors: false,
    app_folder: ".lively/apps/deck-edit",
  });
  assert.equal("auto_approve" in parseForkSpec(raw({ auto_approve: true }))!, false, "본 세션의 자동 승인은 좌표에 싣지 않는다(분기는 늘 dontAsk)");
  ok("B1 맞는 좌표 → 그대로(대화 id 는 소문자 · 자동 승인 칸은 버림)");
  const bad: Array<[string, Record<string, unknown> | unknown]> = [
    ["세션 id 꼴 밖", raw({ session: "-rf" })], ["세션 id 빈 값", raw({ session: "" })], ["대화 id 꼴 밖", raw({ conversation: "abc" })],
    ["Codex", raw({ harness: "codex" })], ["플래그 꼴 모델", raw({ model: "--dangerously-skip-permissions" })], ["공백 든 모델", raw({ model: "op us" })],
    ["모르는 강도", raw({ effort: "huge" })], ["객체 아님", "box-a1"], ["배열", [raw()]], ["null", null],
  ];
  for (const [why, v] of bad) assert.equal(parseForkSpec(v), null, `${why} 는 null 이어야 한다`);
  ok("B2 꼴 밖 좌표 → null(그 작업은 돌지 않는다)");
  assert.equal(parseForkSpec(raw({ app_folder: "../../etc" }))?.app_folder, null);
  assert.equal(parseForkSpec(raw({ app_folder: ".lively/apps/Deck" }))?.app_folder, null);
  assert.equal(parseForkSpec(raw({ model: null, effort: "" }))?.model, null);
  ok("B3 앱 폴더는 .lively/apps/<앱> 꼴만 · 빈 모델 · 강도는 null");
}

// ── B4~B9 판 재료 ──
{
  const spec = parseForkSpec(raw()) as ForkSpec;
  const b = forkBoot({ spec, cwd: "/work/p", appId: "deck-edit", livelyAllow: ["knowledge_get", "store_query"] });
  assert.deepEqual(b.argv, [
    "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
    "--resume", CONV.toLowerCase(), "--fork-session", "--no-session-persistence", "--permission-mode", "dontAsk",
    "--model", "opus", "--effort", "high",
    "--settings", "{{LVLY_FILE:settings.json}}",
  ]);
  ok("B4 하네스 인자 — 이어받기 · 분기 · 기록 안 남김 · 늘 dontAsk(판정기가 죽어도 셸이 안 돈다) · 본 세션 모델 · 강도");
  const bare = forkBoot({ spec: { ...spec, model: null, effort: null }, cwd: "/work/p", appId: "deck-edit", livelyAllow: [] });
  for (const f of ["--model", "--effort"]) assert.ok(!bare.argv.includes(f), `${f} 가 남았다`);
  ok("B4b 본 세션이 안 준 설정은 싣지 않는다");
  for (const forbidden of ["--tools", "--allowedTools", "--disallowedTools", "--strict-mcp-config", "--json-schema", "--mcp-config", "--system-prompt", "--append-system-prompt",
    "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"]) {
    assert.ok(!b.argv.includes(forbidden), `캐시를 깨는 인자 ${forbidden} 가 들어갔다`);
  }
  ok("B5 도구 · 시스템 지시를 바꾸는 인자 · 권한을 건너뛰는 인자는 없다");
  assert.deepEqual(b.env, { LIVELY_SESSION_ID: "box-a1", LIVELY_HOOKS_OFF: "1", LIVELY_MODE: "readonly" });
  ok("B6 환경 — 본 세션 id · 키트 훅 끔 · 라이블리 읽기 전용");
  const files = Object.fromEntries(b.files.map((f) => [f.name, f.content]));
  assert.deepEqual(Object.keys(files).sort(), ["guard.cjs", "guard.json", "settings.json"]);
  assert.equal(files["guard.cjs"], FORK_GUARD_SOURCE);
  assert.deepEqual(JSON.parse(files["guard.json"]!), { root: "/work/p", appId: "deck-edit", appFolder: ".lively/apps/deck-edit", livelyServer: "lively", livelyAllow: ["knowledge_get", "store_query"] });
  const settings = JSON.parse(files["settings.json"]!);
  assert.deepEqual(settings, { disableAllHooks: false, hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: FORK_GUARD_COMMAND, timeout: 10 }] }] } });
  ok("B7 판 파일 — 판정기 · 그 설정 · 훅 끄기 막음(작업 폴더 설정이 훅을 못 끈다) · 모든 도구에 거는 PreToolUse 훅(커넥터 안 막은 워크스페이스는 env 없음)");
  const blocked = JSON.parse(forkBoot({ spec: { ...spec, block_connectors: true }, cwd: "/work/p", appId: "deck-edit", livelyAllow: [] }).files.find((f) => f.name === "settings.json")!.content);
  assert.deepEqual(blocked.env, { ...CLAUDE_AI_CONNECTORS_OFF_ENV });
  ok("B7b 커넥터를 막은 워크스페이스 → 본 세션과 같은 env");
  assert.equal(b.input, "stream"); assert.equal(b.turns, 1);
  ok("B8 입력은 줄글 흐름(stream-json) · «형식에 맞게 다시» 한 턴");
  assert.throws(() => forkBoot({ spec: { ...spec, model: "--x" }, cwd: "/w", appId: "a", livelyAllow: [] }), /모델/);
  assert.throws(() => forkBoot({ spec: { ...spec, effort: "huge" }, cwd: "/w", appId: "a", livelyAllow: [] }), /강도/);
  assert.throws(() => forkBoot({ spec: { ...spec, conversation: "x" }, cwd: "/w", appId: "a", livelyAllow: [] }), /대화/);
  ok("B9 읽기를 거치지 않은 좌표도 판 재료에서 다시 막는다");
}

console.log(`agent-jobs fork-boot.test: ${pass} passed`);
