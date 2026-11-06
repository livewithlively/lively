// #5332 — codex 모델·추론강도 바꾸기의 갈래(그 자리에서 · 새 설정으로 이어 열기)와 그 주변 판정의 엣지 표.
//  실측 근거: codex-cli 0.157.1 은 `/model <인자>` 를 AI 에게 말로 보낸다 · 0.166.0 은 그 자리에서 바꾼다(2026-11-06).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cliVersionFromRolloutHead, versionAtLeast, codexSwitchPlan, codexSessionCliVersion, CODEX_INLINE_SWITCH_MIN } from "./codex-runtime-switch.js";
import { freshInsteadOfPicker } from "./resume-plan.js";
import { codexChatMode, codexStampForRestorable, CODEX_STAMP_UNREAD } from "./codex-chat-mode.js";
import { codexIo, parseCodex } from "./harness-io/codex.js";
import { trustAcceptDowns } from "./session-first-prompt.js";
import { ensureCodexHooksTrusted, hookTrustRetries, hooksListCmd, HOOK_TRUST_RETRIES } from "./codex-hook-trust-apply.js";

// ── 판 읽기 ─────────────────────────────────────────────────────────────────────
//  실측 머리(앞부분만 — 실제 session_meta 줄은 18~23KB 이고 cli_version 은 첫 600바이트 안).
const HEAD_157 = '{"timestamp":"2026-11-03T07:58:31.120Z","type":"session_meta","payload":{"id":"01a1a06a-b90e-7200-9e08-6dd9184a6fe1","timestamp":"2026-11-03T07:58:31.071Z","cwd":"/work/shared/project/4410","originator":"codex_cli_rs","cli_version":"0.157.1","source":"cli"';
const HEAD_166 = '{"timestamp":"2026-11-06T00:50:08.000Z","type":"session_meta","payload":{"id":"x","cwd":"/tmp/c","originator":"codex_cli_rs","cli_version":"0.166.0","source":"cli"';

test("대화 파일 머리에서 cli_version 을 꺼낸다 — 실측 두 판", () => {
  assert.equal(cliVersionFromRolloutHead(HEAD_157), "0.157.1");
  assert.equal(cliVersionFromRolloutHead(HEAD_166), "0.166.0");
});
test("판 꼬리표(-alpha 등)는 숫자만 남긴다 · 없거나 깨진 머리는 null", () => {
  assert.equal(cliVersionFromRolloutHead('"cli_version":"0.170.0-alpha.3"'), "0.170.0");
  assert.equal(cliVersionFromRolloutHead(""), null);
  assert.equal(cliVersionFromRolloutHead('{"type":"session_meta","payload":{"id":"x"'), null);
  assert.equal(cliVersionFromRolloutHead('"cli_version":"unknown"'), null);
});

test("판 비교 — 숫자 단위(문자열 비교가 아니다)", () => {
  assert.equal(versionAtLeast("0.166.0", "0.166.0"), true);
  assert.equal(versionAtLeast("0.166.1", "0.166.0"), true);
  assert.equal(versionAtLeast("0.170.0", "0.166.0"), true);
  assert.equal(versionAtLeast("1.0.0", "0.166.0"), true);
  assert.equal(versionAtLeast("0.157.1", "0.166.0"), false);
  assert.equal(versionAtLeast("0.99.0", "0.166.0"), false, "문자열 비교면 '0.99' > '0.166' 로 틀린다");
  assert.equal(versionAtLeast("0.166", "0.166.0"), true, "모자란 자리는 0");
});

// ── 갈래 ────────────────────────────────────────────────────────────────────────
test("갈래 — 인자를 아는 판(≥0.166.0)만 그 자리에서, 나머지·모름은 이어 열기", () => {
  assert.equal(CODEX_INLINE_SWITCH_MIN, "0.166.0");
  assert.equal(codexSwitchPlan("0.166.0"), "inline");
  assert.equal(codexSwitchPlan("0.170.2"), "inline");
  assert.equal(codexSwitchPlan("0.157.1"), "relaunch", "테넌트 이미지·중앙 박스의 판 — `/model` 인자를 AI 에게 말로 보낸다");
  assert.equal(codexSwitchPlan("0.149.1"), "relaunch");
  assert.equal(codexSwitchPlan(null), "relaunch", "모르면 모든 판에서 맞는 길로");
  assert.equal(codexSwitchPlan(undefined), "relaunch");
  assert.equal(codexSwitchPlan(""), "relaunch");
});

test("판 읽기 — 노드 세션은 노드 머리, 그 밖은 로컬 머리 · 못 읽으면 null(던지지 않는다)", async () => {
  const seen: string[] = [];
  const deps = {
    localHead: async (id: string) => { seen.push(`local:${id}`); return HEAD_157; },
    nodeHead: async (n: string, id: string) => { seen.push(`node:${n}:${id}`); return HEAD_166; },
  };
  assert.equal(await codexSessionCliVersion("box-a", "", deps), "0.157.1");
  assert.equal(await codexSessionCliVersion("box-b", "mac", deps), "0.166.0");
  assert.deepEqual(seen, ["local:box-a", "node:mac:box-b"]);
  assert.equal(await codexSessionCliVersion("box-c", "", { localHead: async () => null }), null);
  assert.equal(await codexSessionCliVersion("box-d", "", { localHead: async () => { throw new Error("relay down"); } }), null);
});

// ── 복원: 피커 대신 새 대화 ─────────────────────────────────────────────────────
test("복원 fresh — 피커 갈래만 새 대화로 접는다 · 대화를 아는 갈래와 fresh 없는 복원은 그대로", () => {
  assert.deepEqual(freshInsteadOfPicker({ resumePick: true }, { fresh: true }), {});
  assert.deepEqual(freshInsteadOfPicker({ resume: "abc" }, { fresh: true }), { resume: "abc" });
  assert.deepEqual(freshInsteadOfPicker({}, { fresh: true }), {});
  assert.deepEqual(freshInsteadOfPicker({ resumePick: true }, {}), { resumePick: true });
  assert.deepEqual(freshInsteadOfPicker({ resumePick: true }, undefined), { resumePick: true });
  assert.deepEqual(freshInsteadOfPicker({ resumePick: true }, { fresh: "true" }), { resumePick: true }, "참(true)만 받는다");
});

// ── 표식: 못 읽음 · 판이 없는 행 ────────────────────────────────────────────────
test("표식 — 못 읽음은 app-server 로 짐작하지 않는다 · 안 적힘(표식 이전 세션)은 종전대로 app-server", () => {
  assert.equal(codexChatMode({ harness: "codex", stamp: CODEX_STAMP_UNREAD }, {}), "tmux");
  assert.equal(codexChatMode({ harness: "codex", stamp: undefined }, {}), "app-server");
  assert.equal(codexChatMode({ harness: "codex", stamp: "app-server" }, {}), "app-server");
  assert.equal(codexChatMode({ harness: "codex", stamp: "terminal" }, {}), "tmux");
});
test("판이 없는(복원 가능) codex 행 — 되살릴 때의 모드(새 세션 규칙)로 읽는다", () => {
  assert.equal(codexStampForRestorable("codex", {}), "terminal");
  assert.equal(codexChatMode({ harness: "codex", stamp: codexStampForRestorable("codex", {}) }, {}), "tmux");
  assert.equal(codexStampForRestorable("codex", { LIVELY_CODEX_CHAT: "app-server" }), "app-server", "배포가 app-server 를 켰으면 그대로");
  assert.equal(codexStampForRestorable("claude", {}), undefined);
});

// ── 화면: 지난 사람 말의 «1.» 은 대화상자가 아니다 ──────────────────────────────
const screen = (rows: string[]): string | null => codexIo.screen!(rows) as string | null;
test("인라인 화면 — 꼬리의 지난 사람 말이 «› 1. …» 이어도 맨 아래 입력칸이 있으면 대화상자가 아니다", () => {
  const tail = [
    "› 1. 로그인 화면 고치고 2. 테스트 돌려 줘",
    "• 고쳤습니다.",
    "  Worked for 6s • 10:13",
    "› Ask Codex to do anything",
    "  GPT-6-Luna low · ~/work",
  ];
  assert.equal(screen(tail), "ready");
});
test("진짜 대화상자 — 맨 아래 커서 줄이 번호다(신뢰 창 0.157.1·0.166.0 · 승인 창)", () => {
  assert.equal(screen(["  Folder access", "  Trust this folder? Codex can read, edit, and run files here", "› 1. Trust and continue", "  2. Quit", "  enter continue · esc quit"]), "dialog");
  assert.equal(screen(["› 이거 실행해", "  Would you like to run the following command?", "  $ rm -rf build", "  1. Yes, proceed (y)", "› 2. Yes, and don't ask again (p)", "  3. No (esc)"]), "dialog");
});
test("작업 중 · 입력칸 — 종전 판정 그대로", () => {
  assert.equal(screen(["› 고쳐 줘", "• Working (2s • esc to interrupt)", "› Ask Codex to do anything"]), "busy");
  assert.equal(screen(["› Ask Codex to do anything"]), "ready");
  assert.equal(screen(["Loading…"]), null);
});

// ── 신뢰 창 «2. Quit» ───────────────────────────────────────────────────────────
test("신뢰 창(0.157.1·0.166.0) — «› 1. Trust and continue / 2. Quit» 에서 Enter 한 번(0칸)", () => {
  assert.equal(trustAcceptDowns(["  Trust this folder? Codex can read, edit, and run files here, subject to your permission", "› 1. Trust and continue", "  2. Quit", "  enter continue · esc quit"]), 0);
});
test("본문의 Quit 낱말은 선택지로 안 센다(번호·커서가 없는 줄)", () => {
  assert.equal(trustAcceptDowns(["Quit anytime with ctrl+c", "› 1. Trust and continue", "  2. Quit"]), 0);
});

// ── 기록: turn_context 의 모델·강도 ─────────────────────────────────────────────
test("turn_context 가 그 턴의 모델·추론강도를 준다 — 0.157.1 은 thread_settings_applied 를 시작에 안 적는다", () => {
  const rows = [
    { timestamp: "2026-11-03T07:59:31.833Z", type: "turn_context", payload: { turn_id: "t1", model: "gpt-5.6-sol", effort: "medium" } },
    { timestamp: "2026-11-03T07:59:40.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "네" }] } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n";
  const { lines } = parseCodex(rows, {});
  const a = lines.find((l) => l.type === "assistant") as { message: { model?: string }; effort?: string } | undefined;
  assert.equal(a?.message.model, "gpt-5.6-sol");
  assert.equal(a?.effort, "medium");
});
test("이어 연 뒤 — 뒤의 turn_context 가 앞의 thread_settings_applied 를 이긴다(바꾼 값이 조용히 되돌아간 걸 보인다)", () => {
  const rows = [
    { timestamp: "t0", type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-6-luna", reasoning_effort: "low" } } },
    { timestamp: "t1", type: "turn_context", payload: { model: "gpt-6-sol", effort: "high" } },
    { timestamp: "t2", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n";
  const a = parseCodex(rows, {}).lines.find((l) => l.type === "assistant") as { message: { model?: string }; effort?: string } | undefined;
  assert.equal(a?.message.model, "gpt-6-sol");
  assert.equal(a?.effort, "high");
});

// ── 훅 신뢰 조회: 빈손은 «물어봤다» 가 아니다 ─────────────────────────────────
test("훅 신뢰 조회 — 답을 7초까지 기다린다(0.166.0 은 약 4.3초에 답한다)", () => {
  assert.match(hooksListCmd("/h/.codex"), /sleep 1; .*; sleep 7\) \| CODEX_HOME=/);
});
test("재시도 표시 읽기 — 같은 지문의 «retry n» 만 센다", () => {
  assert.equal(hookTrustRetries("abc retry 2", "abc"), 2);
  assert.equal(hookTrustRetries("abc retry 2\n", "abc"), 2);
  assert.equal(hookTrustRetries("zzz retry 2", "abc"), 0, "다른 묶음의 재시도는 안 센다");
  assert.equal(hookTrustRetries("abc", "abc"), 0);
  assert.equal(hookTrustRetries("", "abc"), 0);
});
test("빈손 조회 — 지문 대신 재시도 표시를 남기고, 정해진 횟수 뒤엔 더 묻지 않는다 · 답이 오면 지문", async () => {
  const cfg = '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "node /k/work-flag.mjs"\n';
  const files = new Map<string, string>([["/h/.codex/config.toml", cfg]]);
  const io = { read: async (f: string) => files.get(f) ?? null, write: async (f: string, t: string) => { files.set(f, t); } };
  const stampOf = (): string => [...files.entries()].find(([k]) => k !== "/h/.codex/config.toml")?.[1] ?? "";
  let calls = 0;
  const empty = async (): Promise<string> => { calls++; return ""; };
  for (let i = 0; i < HOOK_TRUST_RETRIES + 2; i++) {
    await ensureCodexHooksTrusted({ io: io as never, configFile: "/h/.codex/config.toml", codexHome: "/h/.codex", sh: empty });
  }
  assert.equal(calls, HOOK_TRUST_RETRIES, "빈손이면 정해진 횟수까지만 다시 묻는다");
  assert.match(stampOf(), new RegExp(`retry ${HOOK_TRUST_RETRIES}\\s*$`));
  //  묶음이 바뀌면(킷 갱신) 다시 묻고, 답이 오면 지문을 남긴다.
  files.set("/h/.codex/config.toml", cfg.replace("work-flag", "work-flag2"));
  const answer = JSON.stringify({ id: 2, result: { data: [{ cwd: "/", hooks: [{ key: "user:SessionStart:0:0", currentHash: "h1", sourcePath: "/h/.codex/config.toml", command: "node /k/work-flag2.mjs", trustStatus: "trusted" }] }] } });
  await ensureCodexHooksTrusted({ io: io as never, configFile: "/h/.codex/config.toml", codexHome: "/h/.codex", sh: async () => answer + "\n" });
  assert.doesNotMatch(stampOf(), /retry/);
});
